import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { IlinkQrLoginComponent } from "../src/commands/ilink-qr-login-component.ts";
import {
  createIlinkCredentialFile,
  IlinkCredentialStoreError,
} from "../src/gateway/credential-store.ts";
import {
  IlinkQrLoginError,
  IlinkQrLoginService,
} from "../src/gateway/wechat-ilink/qr-login.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";

const FAKE_USER_ID = "wx-qr-test-user";
const FAKE_BOT_ID = "fake-bot-id@im.bot";
const FAKE_TOKEN = "fake-qr-login-token";

interface QrLoginFixture {
  root: string;
  managerDirectory: string;
  credentialFile: string;
  configStore: ConfigurationStore;
}

/**
 * 创建隔离的 Hub QR 登录测试目录。
 *
 * @returns 临时 agent 和 manager 路径。
 */
async function createFixture(): Promise<QrLoginFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-wechat-qr-login-"));
  const agentDirectory = join(root, "agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const credentialFile = join(managerDirectory, "credentials.json");
  return {
    root,
    managerDirectory,
    credentialFile,
    configStore: new ConfigurationStore(
      join(agentDirectory, "wechat-session-manager.json"),
      credentialFile,
    ),
  };
}

/**
 * 创建用于跳过 ACL 系统调用的 Windows 测试配置。
 *
 * @returns 注入式 ACL verifier options。
 */
function fakeWindowsAclOptions(): {
  platform: NodeJS.Platform;
  verifyWindowsAcl: () => Promise<void>;
} {
  return { platform: "win32", verifyWindowsAcl: async () => undefined };
}

/**
 * 创建 JSON 格式 fake iLink HTTP response。
 *
 * @param body fake response payload。
 * @returns JSON content-type 的 HTTP 200 response。
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("Pi QR 登录组件本地显示二维码并支持取消", () => {
  let cancelled = false;
  const component = new IlinkQrLoginComponent(() => {
    cancelled = true;
  });
  component.setQr("██ QR TEST ██");
  component.setStatus("请扫描");
  const lines = component.render(80);
  assert.equal(lines.some((line) => line.includes("Pi Hub 微信授权")), true);
  assert.equal(lines.some((line) => line.includes("██ QR TEST ██")), true);
  component.handleInput("\u001b");
  assert.equal(cancelled, true);
});

test("独立 iLink QR 登录不提交旧 token, 并只创建 Hub 凭证和 authorizedUserId", async () => {
  const fixture = await createFixture();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const statuses = [
    { status: "wait" },
    { status: "scaned" },
    {
      status: "confirmed",
      bot_token: FAKE_TOKEN,
      ilink_bot_id: FAKE_BOT_ID,
      ilink_user_id: FAKE_USER_ID,
      baseurl: "https://ilinkai.weixin.qq.com",
    },
  ];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    if (url.includes("get_bot_qrcode")) {
      return jsonResponse({
        qrcode: "fake-qr-id",
        qrcode_img_content: "https://weixin.qq.com/x/pi-hub-fake-qr",
      });
    }
    return jsonResponse(statuses.shift());
  };
  const qrContents: string[] = [];
  const statusesShown: string[] = [];
  const service = new IlinkQrLoginService({
    managerDirectory: fixture.managerDirectory,
    configStore: fixture.configStore,
    fetcher,
    credentialStoreOptions: fakeWindowsAclOptions(),
  });

  try {
    const result = await service.login({
      signal: new AbortController().signal,
      onQrCode: (content, terminalQr) => qrContents.push(`${content}\n${terminalQr}`),
      onStatus: (status) => statusesShown.push(status),
    });
    assert.equal(result.authorizedUserId, FAKE_USER_ID);
    assert.equal(result.botId, FAKE_BOT_ID);
    assert.equal(requests.length, 4);
    assert.match(requests[0].url, /get_bot_qrcode\?bot_type=3$/);
    assert.equal(requests[0].init.method, "POST");
    const qrHeaders = new Headers(requests[0].init.headers);
    assert.equal(qrHeaders.get("iLink-App-Id"), "bot");
    assert.equal(qrHeaders.get("Authorization"), null);
    const qrBody = JSON.parse(String(requests[0].init.body)) as { local_token_list: string[] };
    assert.deepEqual(qrBody.local_token_list, []);
    assert.equal(qrBody.local_token_list.length, 0);
    assert.equal(qrContents.length, 1);
    assert.match(qrContents[0], /weixin\.qq\.com/);
    assert.equal(statusesShown.includes("Pi Hub 专属 iLink 凭证已安全保存。"), true);

    const credentials = JSON.parse(await readFile(fixture.credentialFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(credentials, {
      schemaVersion: 1,
      authorizedUserId: FAKE_USER_ID,
      token: FAKE_TOKEN,
      baseUrl: "https://ilinkai.weixin.qq.com",
    });
    assert.equal((await fixture.configStore.load()).config.wechat.authorizedUserId, FAKE_USER_ID);

    const nextLease = await GatewayLease.acquire(fixture.managerDirectory);
    await nextLease.release();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("iLink 需要配对码时只通过本地输入提交, 并接受确认凭证", async () => {
  const fixture = await createFixture();
  const requestUrls: string[] = [];
  const responses: unknown[] = [
    { status: "need_verifycode" },
    {
      status: "confirmed",
      bot_token: FAKE_TOKEN,
      ilink_bot_id: FAKE_BOT_ID,
      ilink_user_id: FAKE_USER_ID,
      baseurl: "https://ilinkai.weixin.qq.com",
    },
  ];
  const service = new IlinkQrLoginService({
    managerDirectory: fixture.managerDirectory,
    configStore: fixture.configStore,
    fetcher: async (input) => {
      const url = String(input);
      requestUrls.push(url);
      return url.includes("get_bot_qrcode")
        ? jsonResponse({ qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/x/test" })
        : jsonResponse(responses.shift());
    },
    credentialStoreOptions: fakeWindowsAclOptions(),
  });

  try {
    const result = await service.login({
      signal: new AbortController().signal,
      onQrCode: () => undefined,
      onStatus: () => undefined,
      requestVerificationCode: async () => "4321",
    });
    assert.equal(result.authorizedUserId, FAKE_USER_ID);
    assert.equal(requestUrls.some((url) => url.includes("verify_code=4321")), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("QR redirect 仅接受 ilinkai.weixin.qq.com 子域", async () => {
  const fixture = await createFixture();
  const service = new IlinkQrLoginService({
    managerDirectory: fixture.managerDirectory,
    configStore: fixture.configStore,
    fetcher: async (input) => String(input).includes("get_bot_qrcode")
      ? jsonResponse({ qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/x/test" })
      : jsonResponse({ status: "scaned_but_redirect", redirect_host: "attacker.example" }),
    credentialStoreOptions: fakeWindowsAclOptions(),
  });

  try {
    await assert.rejects(
      service.login({
        signal: new AbortController().signal,
        onQrCode: () => undefined,
        onStatus: () => undefined,
      }),
      (error: unknown) => error instanceof IlinkQrLoginError && error.code === "qr_response_invalid",
    );
    await assert.rejects(readFile(fixture.credentialFile, "utf8"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("已有 Hub credentials.json 时扫码登录 fail-closed 且不覆盖", async () => {
  const fixture = await createFixture();
  const lease = await GatewayLease.acquire(fixture.managerDirectory);
  const originalRecord = {
    schemaVersion: 1 as const,
    authorizedUserId: FAKE_USER_ID,
    token: "existing-hub-token",
    baseUrl: "https://ilinkai.weixin.qq.com",
  };
  let fetchCount = 0;
  try {
    await createIlinkCredentialFile(
      fixture.managerDirectory,
      originalRecord,
      fakeWindowsAclOptions(),
    );
    await lease.release();
    const originalContent = await readFile(fixture.credentialFile, "utf8");
    const service = new IlinkQrLoginService({
      managerDirectory: fixture.managerDirectory,
      configStore: fixture.configStore,
      fetcher: async () => {
        fetchCount += 1;
        return jsonResponse({});
      },
      credentialStoreOptions: fakeWindowsAclOptions(),
    });

    await assert.rejects(
      service.login({
        signal: new AbortController().signal,
        onQrCode: () => undefined,
        onStatus: () => undefined,
      }),
      (error: unknown) => error instanceof IlinkQrLoginError && error.code === "credential_exists",
    );
    assert.equal(fetchCount, 0);
    assert.equal(await readFile(fixture.credentialFile, "utf8"), originalContent);
  } finally {
    await lease.release().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("iLink 已有绑定或 userId 不匹配时不写入凭证", async () => {
  const fixture = await createFixture();
  const statuses = [{ status: "binded_redirect" }];
  const service = new IlinkQrLoginService({
    managerDirectory: fixture.managerDirectory,
    configStore: fixture.configStore,
    fetcher: async (input) => String(input).includes("get_bot_qrcode")
      ? jsonResponse({ qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/x/test" })
      : jsonResponse(statuses.shift()),
    credentialStoreOptions: fakeWindowsAclOptions(),
  });

  try {
    await assert.rejects(
      service.login({
        signal: new AbortController().signal,
        onQrCode: () => undefined,
        onStatus: () => undefined,
      }),
      (error: unknown) => error instanceof IlinkQrLoginError && error.code === "account_already_bound",
    );
    await assert.rejects(readFile(fixture.credentialFile, "utf8"));

    await fixture.configStore.update((config) => ({
      ...config,
      wechat: { ...config.wechat, authorizedUserId: "another-user" },
    }));
    const mismatchService = new IlinkQrLoginService({
      managerDirectory: fixture.managerDirectory,
      configStore: fixture.configStore,
      fetcher: async (input) => String(input).includes("get_bot_qrcode")
        ? jsonResponse({ qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/x/test" })
        : jsonResponse({
          status: "confirmed",
          bot_token: FAKE_TOKEN,
          ilink_bot_id: FAKE_BOT_ID,
          ilink_user_id: FAKE_USER_ID,
        }),
      credentialStoreOptions: fakeWindowsAclOptions(),
    });
    await assert.rejects(
      mismatchService.login({
        signal: new AbortController().signal,
        onQrCode: () => undefined,
        onStatus: () => undefined,
      }),
      (error: unknown) => error instanceof IlinkQrLoginError && error.code === "authorized_user_mismatch",
    );
    await assert.rejects(readFile(fixture.credentialFile, "utf8"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("创建凭证的 ACL 不安全时不会在 manager 目录留下文件", async () => {
  const fixture = await createFixture();
  const lease = await GatewayLease.acquire(fixture.managerDirectory);
  const service = new IlinkQrLoginService({
    managerDirectory: fixture.managerDirectory,
    configStore: fixture.configStore,
    fetcher: async (input) => String(input).includes("get_bot_qrcode")
      ? jsonResponse({ qrcode: "fake-qr", qrcode_img_content: "https://weixin.qq.com/x/test" })
      : jsonResponse({
        status: "confirmed",
        bot_token: FAKE_TOKEN,
        ilink_bot_id: FAKE_BOT_ID,
        ilink_user_id: FAKE_USER_ID,
      }),
    credentialStoreOptions: {
      platform: "win32",
      verifyWindowsAcl: async () => {
        throw new Error("fake ACL violation");
      },
    },
  });

  try {
    await lease.release();
    await assert.rejects(
      service.login({
        signal: new AbortController().signal,
        onQrCode: () => undefined,
        onStatus: () => undefined,
      }),
      IlinkCredentialStoreError,
    );
    await assert.rejects(readFile(fixture.credentialFile, "utf8"));
  } finally {
    await lease.release().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});
