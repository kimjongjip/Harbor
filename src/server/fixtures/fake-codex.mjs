import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    process.stdout.write("startup banner\n");
    const output =
      JSON.stringify({ id: m.id, result: { userAgent: "fixture" } }) + "\n";
    process.stdout.write(output.slice(0, 11));
    setTimeout(() => process.stdout.write(output.slice(11)), 5);
  } else if (m.method === "echo")
    setTimeout(
      () => send({ id: m.id, result: m.params.text }),
      m.params.delay || 0,
    );
  else if (m.method === "events") {
    send({ method: "item/agentMessage/delta", params: { delta: "한글" } });
    send({
      id: "approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "test" },
    });
    send({ id: m.id, result: true });
  } else if (m.method === "fail")
    send({ id: m.id, error: { code: -1, message: "expected failure" } });
  else if (m.method === "exit") setTimeout(() => process.exit(3), 10);
});
