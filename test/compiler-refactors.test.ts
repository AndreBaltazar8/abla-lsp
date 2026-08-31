import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CompilerClient } from "../src/compiler-client.js";
import type { CompilerTextEdit } from "../src/compiler-protocol.js";
import { WorkspaceIndex } from "../src/index.js";
import { PositionMap } from "../src/positions.js";
import { AdvancedRefactors } from "../src/refactors.js";
import { SyntaxAnalyzer } from "../src/source.js";

const compiler = process.env.ABLA_COMPILER;

test("advanced refactors pass the real compiler prospective validator", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
}, async (context) => {
  assert.notEqual(compiler, undefined);
  const root = path.resolve("test/fixtures");
  const uri = pathToFileURL(path.join(root, "refactor.ab")).href;
  const client = new CompilerClient({ executable: compiler ?? "ablac" });
  context.after(async () => client.stop().catch(() => undefined));
  await client.start({ workspaceRoots: [root], clientName: "abla-lsp-tests", clientVersion: "0.2.0" });
  const snapshot = await client.analyze();
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  for (const document of snapshot.documents) {
    index.upsertAnalysis({ ...document, authority: "compiler" });
  }
  const length = index.symbols().find((symbol) => symbol.uri === uri && symbol.name === "length");
  assert.notEqual(length, undefined);
  const planned = new AdvancedRefactors(index).functionToMethod({
    symbolId: length?.id ?? "",
    receiver: "point",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const edits: CompilerTextEdit[] = Object.entries(planned.edit.changes ?? {}).flatMap(([editUri, values]) => {
    const analysis = index.document(editUri);
    assert.notEqual(analysis, undefined);
    const positions = new PositionMap(analysis?.text ?? "");
    return values.map((edit) => {
      const start = positions.offset(edit.range.start);
      const end = positions.offset(edit.range.end);
      return {
        uri: editUri,
        start: Buffer.byteLength((analysis?.text ?? "").slice(0, start), "utf8"),
        end: Buffer.byteLength((analysis?.text ?? "").slice(0, end), "utf8"),
        newText: edit.newText,
      };
    });
  });
  const validated = await client.validate({
    baseRevision: snapshot.revision,
    edits,
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  assert.deepEqual(validated.valid, true, validated.reason ?? "compiler rejected the refactor");
});
