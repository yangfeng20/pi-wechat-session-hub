import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import type { IlinkReplyContext } from "../src/gateway/channel-types.ts";
import { GatewayAuthorizationError } from "../src/gateway/command-router.ts";
import { IlinkApiClient, IlinkApiError } from "../src/gateway/wechat-ilink/api-client.ts";
import { IlinkChannelAdapter } from "../src/gateway/wechat-ilink/channel-adapter.ts";
import { IlinkTypingIndicator, type IlinkTypingApi } from "../src/gateway/wechat-ilink/typing-indicator.ts";
import { IlinkCursorStore } from "../src/gateway/wechat-ilink/cursor-store.ts";

/**
 * 创建隔离的 iLink 测试目录。
 *
 * @returns 临时目录及其 Gateway lease。
 */
async function createIlinkFixture(): Promise<{ directory: string; lease: GatewayLease }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-ilink-"));
  return { directory, lease: await GatewayLease.acquire(directory) };
}

test("iLink client 使用协议头、context_token 和单次请求多 text item", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new IlinkApiClient({
    credentials: { token: "test-bot-token", baseUrl: "https://ilinkai.weixin.qq.com" },
    fetcher,
  });
  const contextToken = "context-token-only-for-test";

  await client.sendText("wx-user-1", `${"A".repeat(2000)}${"B".repeat(501)}`, contextToken, "stable-client-id");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-bot-token");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(headers.get("iLink-App-Id"), "bot");
  assert.equal(headers.get("iLink-App-ClientVersion"), "1");
  assert.ok(headers.get("X-WECHAT-UIN"));
  const body = JSON.parse(String(requests[0].init.body)) as {
    msg: {
      from_user_id: string;
      to_user_id: string;
      client_id: string;
      message_type: number;
      message_state: number;
      context_token: string;
      item_list: Array<{ text_item: { text: string } }>;
    };
  };
  assert.equal(body.msg.from_user_id, "");
  assert.equal(body.msg.to_user_id, "wx-user-1");
  assert.equal(body.msg.client_id, "stable-client-id");
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.message_state, 2);
  assert.equal(body.msg.context_token, contextToken);
  assert.deepEqual(body.msg.item_list.map((item) => item.text_item.text.length), [2000, 501]);
});

test("iLink getconfig/sendtyping 获取 ticket 并发出 begin/end 状态", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    return new Response(JSON.stringify(
      url.endsWith("/getconfig") ? { ret: 0, typing_ticket: "fake-typing-ticket" } : { ret: 0 },
    ), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const api = new IlinkApiClient({
    credentials: { token: "fake-token", baseUrl: "https://ilinkai.weixin.qq.com" },
    fetcher,
  });
  const typingConfig = await api.getTypingConfig("wx-user-1", "fake-context-token");
  assert.equal(typingConfig.typingTicket, "fake-typing-ticket");
  await api.sendTyping("wx-user-1", typingConfig.typingTicket!, 1);
  await api.sendTyping("wx-user-1", typingConfig.typingTicket!, 2);
  assert.match(requests[0].url, /\/getconfig$/);
  assert.equal(requests[0].body.ilink_user_id, "wx-user-1");
  assert.equal(requests[0].body.context_token, "fake-context-token");
  assert.deepEqual(requests.slice(1).map((request) => request.body.status), [1, 2]);
});

test("queue 处理期间发送 typing, 并在结束后取消且不阻塞最终处理", async () => {
  const statuses: number[] = [];
  let resolveTypingStarted!: () => void;
  let resolveTypingStopped!: () => void;
  const typingStarted = new Promise<void>((resolveStarted) => {
    resolveTypingStarted = resolveStarted;
  });
  const typingStopped = new Promise<void>((resolveStopped) => {
    resolveTypingStopped = resolveStopped;
  });
  const api: IlinkTypingApi = {
    getTypingConfig: async (recipientId, contextToken) => {
      assert.equal(recipientId, "wx-user-1");
      assert.equal(contextToken, "fake-context-token");
      return { typingTicket: "fake-typing-ticket" };
    },
    sendTyping: async (_recipientId, _typingTicket, status) => {
      statuses.push(status);
      if (status === 1) resolveTypingStarted();
      if (status === 2) resolveTypingStopped();
    },
  };
  const indicator = new IlinkTypingIndicator(api, { keepaliveIntervalMs: 10000 });
  indicator.start("message-1", {
    recipientId: "wx-user-1",
    contextToken: "fake-context-token",
  });
  await typingStarted;
  indicator.stop("message-1");
  await typingStopped;
  assert.deepEqual(statuses, [1, 2]);
});

test("iLink session expired 只报告错误, 不自动清除凭证或游标", async () => {
  const fetcher: typeof fetch = async () => new Response(
    JSON.stringify({ ret: -14, errcode: -14, errmsg: "session expired" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const client = new IlinkApiClient({
    credentials: { token: "test-bot-token", baseUrl: "https://ilinkai.weixin.qq.com" },
    fetcher,
  });

  await assert.rejects(
    client.getUpdates("old-cursor"),
    (error: unknown) => error instanceof IlinkApiError && error.code === "session_expired",
  );
});

test("iLink poller stop 会取消当前 long-poll 并等待退出", async () => {
  const { directory, lease } = await createIlinkFixture();
  const cursorStore = new IlinkCursorStore(join(directory, "ilink-sync.json"), lease);
  let signalLongPoll!: (signal: AbortSignal) => void;
  const longPollStarted = new Promise<AbortSignal>((resolveStarted) => {
    signalLongPoll = resolveStarted;
  });
  const fetcher: typeof fetch = async (_input, init) => {
    const signal = init?.signal as AbortSignal;
    signalLongPoll(signal);
    return new Promise<Response>((_resolveResponse, rejectResponse) => {
      if (signal.aborted) {
        rejectResponse(new DOMException("已取消", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => rejectResponse(new DOMException("已取消", "AbortError")),
        { once: true },
      );
    });
  };
  const api = new IlinkApiClient({
    credentials: { token: "test-bot-token", baseUrl: "https://ilinkai.weixin.qq.com" },
    fetcher,
  });
  const adapter = new IlinkChannelAdapter(api, cursorStore, {
    authorizedUserId: "wx-user-1",
  });

  try {
    await adapter.start(async () => undefined);
    const signal = await longPollStarted;
    assert.equal(signal.aborted, false);
    await adapter.stop();
    assert.equal(signal.aborted, true);
  } finally {
    await adapter.stop();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("iLink pollOnce 将文本与 context_token 送入 Gateway, 并在入队后保存游标", async () => {
  const { directory, lease } = await createIlinkFixture();
  const cursorPath = join(directory, "ilink-sync.json");
  const cursorStore = new IlinkCursorStore(cursorPath, lease);
  const requestBodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if ("get_updates_buf" in body) {
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor-next",
        longpolling_timeout_ms: 20000,
        msgs: [
          {
            message_id: 17,
            from_user_id: "wx-user-1",
            context_token: "reply-context-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "查看状态" } }],
          },
          {
            message_id: 18,
            from_user_id: "unauthorized-user",
            context_token: "reply-context-2",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "不要入队" } }],
          },
          {
            message_id: 19,
            from_user_id: "wx-user-1",
            context_token: "reply-context-3",
            message_type: 1,
            item_list: [{ type: 2 }],
          },
          {
            message_id: 20,
            from_user_id: "unauthorized-user",
            context_token: "reply-context-4",
            message_type: 1,
            item_list: [{ type: 2 }],
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new IlinkApiClient({
    credentials: { token: "test-bot-token", baseUrl: "https://ilinkai.weixin.qq.com" },
    fetcher,
  });
  const adapter = new IlinkChannelAdapter(client, cursorStore, {
    authorizedUserId: "wx-user-1",
  });
  const accepted: Array<{ messageId: string; senderId: string; text: string; replyContext?: IlinkReplyContext }> = [];

  try {
    const summary = await adapter.pollOnce(async (message) => {
      if (message.senderId !== "wx-user-1") {
        throw new GatewayAuthorizationError("unauthorized_wechat_user", "来源未授权。");
      }
      accepted.push(message);
    });
    assert.equal(summary.receivedCount, 4);
    assert.equal(summary.acceptedCount, 1);
    assert.equal(summary.ignoredCount, 3);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].messageId, "17");
    assert.equal(accepted[0].replyContext?.contextToken, "reply-context-1");
    assert.equal(await cursorStore.load(), "cursor-next");
    const unsupportedReply = requestBodies.find((body) => "msg" in body) as {
      msg: { context_token: string; item_list: Array<{ text_item: { text: string } }> };
    };
    assert.equal(unsupportedReply.msg.context_token, "reply-context-3");
    assert.equal(requestBodies.length, 2);
    assert.equal(JSON.stringify(requestBodies).includes("reply-context-4"), false);
    assert.match(unsupportedReply.msg.item_list[0].text_item.text, /暂不读取该附件/);
    const cursorFile = await readFile(cursorPath, "utf8");
    assert.equal(cursorFile.includes("reply-context"), false);
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
