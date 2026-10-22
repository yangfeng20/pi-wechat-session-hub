let buffer = "";
let pendingUiRequestId;
let pendingCommandId;

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function handle(command) {
  if (command.type === "get_state") {
    send({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: {
        sessionId: "fake-session-id",
        sessionFile: "C:/fake/session.jsonl",
      },
    });
    return;
  }

  if (command.type === "prompt") {
    send({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: { disposition: "started" },
    });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一段\u2028第二段" }] } });
    send({ type: "agent_settled" });
    return;
  }

  if (command.type === "test_ui") {
    pendingUiRequestId = "fake-ui-request";
    pendingCommandId = command.id;
    send({
      type: "extension_ui_request",
      id: pendingUiRequestId,
      method: "confirm",
      title: "测试确认",
      message: "后台应拒绝该请求",
    });
    return;
  }

  if (command.type === "extension_ui_response" && command.id === pendingUiRequestId) {
    send({ type: "ui_response_received", confirmed: command.confirmed });
    send({
      type: "response",
      id: pendingCommandId,
      command: "test_ui",
      success: true,
    });
    pendingUiRequestId = undefined;
    pendingCommandId = undefined;
    return;
  }

  send({
    type: "response",
    id: command.id,
    command: command.type,
    success: false,
    error: "未知测试命令",
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      void handle(JSON.parse(line));
    }
    newlineIndex = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
