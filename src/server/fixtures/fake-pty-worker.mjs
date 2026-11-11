process.on("message", (message) => {
  if (message.type === "start") {
    if (message.file === "fail-start") process.exit(71);
    process.send({ type: "ready" });
    process.send({ type: "data", data: "initial" });
  } else if (message.type === "write") {
    if (message.data === "crash") process.exit(73);
    process.send({ type: "data", data: message.data });
  } else if (message.type === "resize") {
    process.send({ type: "data", data: `${message.cols}x${message.rows}` });
  } else if (message.type === "close") {
    process.send({ type: "exit", code: 0 }, () => process.exit(0));
  }
});
process.on("disconnect", () => process.exit(0));
