import { createInterface } from "node:readline";

const cancelled = new Set();
const input = createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ schema: 1, id, result })}\n`);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "cancel") {
    cancelled.add(message.params.id);
    return;
  }
  if (message.method === "initialize") {
    respond(message.id, {
      compilerVersion: "0.2.11-test",
      protocolVersion: 1,
      capabilities: ["overlays", "refactor-validation"],
    });
    return;
  }
  if (message.method === "analyze") {
    const finish = () => {
      if (!cancelled.has(message.id)) {
        respond(message.id, { revision: "test-1", documents: [] });
      }
    };
    if (message.params?.wait === true) setTimeout(finish, 250);
    else finish();
    return;
  }
  if (message.method === "refactor/validate") {
    respond(message.id, { valid: true });
    return;
  }
  respond(message.id, null);
  if (message.method === "shutdown") setTimeout(() => process.exit(0), 5);
});
