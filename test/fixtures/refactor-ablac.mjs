import { createInterface } from "node:readline";
import { SyntaxAnalyzer } from "../../dist/src/source.js";

const analyzer = new SyntaxAnalyzer();
const documents = new Map();
const snapshots = new Map();
let revision = 0;

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ schema: 1, id, result })}\n`);
}

function analyzeDocuments(sourceDocuments) {
  revision += 1;
  const currentRevision = `refactor-test-${revision}`;
  const analyses = [...sourceDocuments.values()].map((document) =>
    analyzer.analyze(document.uri, document.version, document.text));
  const symbolsByName = new Map();
  for (const analysis of analyses) {
    for (const symbol of analysis.symbols) {
      const symbols = symbolsByName.get(symbol.name) ?? [];
      symbols.push(symbol);
      symbolsByName.set(symbol.name, symbols);
    }
  }
  const snapshot = {
    revision: currentRevision,
    documents: analyses.map((analysis) => ({
      ...analysis,
      occurrences: analysis.occurrences.map((occurrence) => {
        if (occurrence.declarationId !== undefined) return occurrence;
        const declarations = symbolsByName.get(occurrence.name) ?? [];
        return declarations.length === 1
          ? { ...occurrence, declarationId: declarations[0].id }
          : occurrence;
      }),
      diagnostics: [{
        code: "I_REFACTOR_TEST",
        message: "compiler refactor fixture is ready",
        range: { start: 0, end: 0 },
      }],
    })),
  };
  snapshots.set(currentRevision, new Map(
    [...sourceDocuments].map(([uri, document]) => [uri, { ...document }]),
  ));
  return snapshot;
}

function characterOffset(text, byteOffset) {
  return Buffer.from(text, "utf8").subarray(0, byteOffset).toString("utf8").length;
}

function prospectiveSnapshot(params) {
  const baseline = snapshots.get(params.baseRevision) ?? documents;
  const prospective = new Map(
    [...baseline].map(([uri, document]) => [uri, { ...document }]),
  );
  for (const created of params.createdDocuments ?? []) {
    prospective.set(created.uri, { uri: created.uri, version: 1, text: created.text });
  }
  const editsByUri = new Map();
  for (const edit of params.edits ?? []) {
    const edits = editsByUri.get(edit.uri) ?? [];
    edits.push(edit);
    editsByUri.set(edit.uri, edits);
  }
  for (const [uri, edits] of editsByUri) {
    const document = prospective.get(uri);
    if (document === undefined) return { valid: false, reason: "edit targets an unknown document" };
    let text = document.text;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      const start = characterOffset(text, edit.start);
      const end = characterOffset(text, edit.end);
      text = `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
    }
    prospective.set(uri, { ...document, text });
  }
  return { valid: true, snapshot: analyzeDocuments(prospective) };
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "cancel") return;
  if (message.method === "initialize") {
    respond(message.id, {
      compilerVersion: "0.2.13-refactor-test",
      protocolVersion: 1,
      capabilities: ["document-overlays", "refactor-validation", "created-documents"],
    });
  } else if (message.method === "document/open" || message.method === "document/change") {
    documents.set(message.params.uri, { ...message.params });
    respond(message.id, null);
  } else if (message.method === "document/close") {
    documents.delete(message.params.uri);
    respond(message.id, null);
  } else if (message.method === "analyze") {
    respond(message.id, analyzeDocuments(documents));
  } else if (message.method === "refactor/validate") {
    respond(message.id, prospectiveSnapshot(message.params));
  } else {
    respond(message.id, null);
    if (message.method === "shutdown") setTimeout(() => process.exit(0), 5);
  }
});
