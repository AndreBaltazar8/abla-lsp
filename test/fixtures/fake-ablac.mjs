import { createInterface } from "node:readline";

const cancelled = new Set();
const documents = new Map();
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
        respond(message.id, {
          revision: "test-1",
          documents: [...documents.values()].map((document) => {
            const widget = document.text.indexOf("Widget");
            const make = document.text.indexOf("make");
            const widgetCall = document.text.lastIndexOf("Widget");
            const symbols = [];
            const occurrences = [];
            if (widget >= 0) {
              symbols.push({
                id: `${document.uri}#Widget`, name: "Widget", kind: "class",
                uri: document.uri, range: { start: 0, end: 15 },
                selectionRange: { start: widget, end: widget + 6 },
                detail: "class Widget", topLevel: true,
              });
              occurrences.push({
                name: "Widget", range: { start: widget, end: widget + 6 },
                declarationId: `${document.uri}#Widget`, type: "Widget",
              });
              if (widgetCall > widget) occurrences.push({
                name: "Widget", range: { start: widgetCall, end: widgetCall + 6 },
                declarationId: `${document.uri}#Widget`, type: "Widget",
              });
            }
            if (make >= 0) {
              symbols.push({
                id: `${document.uri}#make`, name: "make", kind: "function",
                uri: document.uri, range: { start: 16, end: document.text.length },
                selectionRange: { start: make, end: make + 4 },
                detail: "fun Widget", topLevel: true,
              });
              occurrences.push({
                name: "make", range: { start: make, end: make + 4 },
                declarationId: `${document.uri}#make`, type: "Widget",
              });
            }
            return {
              ...document,
              symbols,
              occurrences,
              diagnostics: [{
                code: "I_TEST", message: "semantic snapshot",
                range: { start: 0, end: 0 },
              }],
            };
          }),
        });
      }
    };
    if (message.params?.wait === true) setTimeout(finish, 250);
    else finish();
    return;
  }
  if (message.method === "document/open" || message.method === "document/change") {
    documents.set(message.params.uri, message.params);
    respond(message.id, null);
    return;
  }
  if (message.method === "document/close") {
    documents.delete(message.params.uri);
    respond(message.id, null);
    return;
  }
  if (message.method === "refactor/validate") {
    respond(message.id, { valid: true });
    return;
  }
  if (message.method === "crash") {
    process.exit(23);
  }
  respond(message.id, null);
  if (message.method === "shutdown") setTimeout(() => process.exit(0), 5);
});
