import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

let inputBuffer = "";
const arguments_ = process.argv.slice(2);
const sessionDirectory = valueAfter("--session-dir");
const requestedSessionFile = valueAfter("--session");
let sessionFile = requestedSessionFile
  ? resolve(requestedSessionFile)
  : join(
      resolve(sessionDirectory ?? process.cwd()),
      `fake-${process.pid}.jsonl`,
    );
let sessionId = `fake-${process.pid}`;
let sessionName = valueAfter("--name");

if (requestedSessionFile) {
  try {
    const firstLine = (await readFile(sessionFile, "utf8")).split(/\r?\n/, 1)[0];
    const header = JSON.parse(firstLine);
    if (typeof header.id !== "string") {
      process.stderr.write("测试 session header 缺少 ID。\n");
      process.exit(2);
    }
    sessionId = header.id;
    sessionName = typeof header.name === "string" ? header.name : sessionName;
  } catch {
    process.stderr.write("测试 session 文件不存在或格式无效。\n");
    process.exit(2);
  }
}

function valueAfter(option) {
  const index = arguments_.indexOf(option);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

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
        sessionId,
        sessionFile,
        ...(sessionName ? { sessionName } : {}),
        isStreaming: false,
      },
    });
    return;
  }

  if (command.type === "set_session_name") {
    sessionName = command.name;
    send({ type: "response", id: command.id, command: command.type, success: true });
    return;
  }

  if (command.type === "prompt") {
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd(), ...(sessionName ? { name: sessionName } : {}) })}\n`,
      "utf8",
    );
    send({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: { disposition: "started" },
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `测试回复: ${command.message}` }],
      },
    });
    send({ type: "agent_settled" });
    return;
  }

  if (command.type === "abort") {
    send({ type: "response", id: command.id, command: command.type, success: true });
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
  inputBuffer += chunk;
  let newlineIndex = inputBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (line) {
      void handle(JSON.parse(line));
    }
    newlineIndex = inputBuffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
