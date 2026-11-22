import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { connect } from "./lsp-client.js";

const compiler = process.env.ABLA_COMPILER;

test("refactor code actions are offered at the cursor and resolve to compiler-validated edits", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
  timeout: 120_000,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-actions-"));
  const text = "fun main: int {\n    val n = 3\n    var total = n * 2\n    total\n}\n";
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "actions"\nentry = "main.ab"\n');
  await fs.writeFile(path.join(root, "main.ab"), text);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.ab")).href;
  const { request } = await connect(context, root, uri, text);
  const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });
  const actions = async (r: unknown): Promise<Array<{ title: string; kind: string }>> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const reply = await request("textDocument/codeAction", { textDocument: { uri }, range: r, context: { diagnostics: [] } });
      if (Array.isArray(reply.result) && reply.result.length > 0) return reply.result as Array<{ title: string; kind: string }>;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [];
  };
  const onN = await actions(range(1, 8, 8));
  assert.deepEqual(onN.map((action) => [action.title, action.kind]), [
    ["Inline 'n'", "refactor.inline"],
    ["Convert 'n' to var", "refactor.rewrite.binding"],
  ]);
  const convert = await request("codeAction/resolve", onN[1]);
  assert.deepEqual(Object.values((convert.result as { edit: { changes: Record<string, Array<{ newText: string }>> } }).edit.changes).flat().map((edit) => edit.newText), ["var"]);
  const selected = await actions(range(2, 16, 21));
  // The selection starts on a use of `n`, so the symbol actions are offered as well.
  assert.deepEqual(selected.map((action) => action.kind), ["refactor.extract.function", "refactor.extract.variable", "refactor.inline", "refactor.rewrite.binding"]);
  const variable = await request("codeAction/resolve", selected[1]);
  assert.match(JSON.stringify(variable.result), /val extracted = n \* 2/u);
  await request("shutdown", null);
});

test("source.fixAll adds the missing import and removes the unused one in one compiler-validated edit", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
  timeout: 120_000,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-fixall-"));
  const text = 'import "abla/text"\nfun main: int {\n    val v = jsonString(\"x\")\n    0\n}\n';
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "fixall"\nentry = "main.ab"\n');
  await fs.writeFile(path.join(root, "main.ab"), text);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.ab")).href;
  const { request } = await connect(context, root, uri, text);
  const whole = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } };
  let actions: Array<{ kind: string; edit?: { changes: Record<string, Array<{ newText: string }>> } }> = [];
  for (let attempt = 0; attempt < 40 && actions.length === 0; attempt += 1) {
    const reply = await request("textDocument/codeAction", { textDocument: { uri }, range: whole, context: { diagnostics: [], only: ["source.fixAll"] } });
    actions = (reply.result ?? []) as typeof actions;
    if (actions.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(actions[0]?.kind, "source.fixAll");
  const edits = Object.values(actions[0]?.edit?.changes ?? {}).flat().map((edit) => edit.newText);
  assert.ok(edits.some((value) => value.includes('import "abla/json"')), JSON.stringify(edits));
});
