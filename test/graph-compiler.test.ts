import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CompilerClient } from "../src/compiler-client.js";
import { CompilerWorkspace } from "../src/compiler-workspace.js";
import type { CompilerHover, CompilerLocation } from "../src/compiler-protocol.js";
import type { AblaSymbol } from "../src/model.js";

const executable = process.env.ABLA_COMPILER_GRAPH;
test("real graph compiler: projections, positional UTF-8 queries, overlays and disk revisions", {
  skip: executable === undefined ? "set ABLA_COMPILER_GRAPH to a current graph/fields compiler" : false,
  timeout: 60_000,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-graph-%-"));
  const main = path.join(root, "main.ab"); const dep = path.join(root, "dep.ab");
  const text = '// café 😀\nimport "dep.ab"\nfun main: int = answer()\n';
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "graph-test"\nentry = "main.ab"\n');
  await fs.writeFile(main, text); await fs.writeFile(dep, "fun answer: int = 42\n");
  const uri = pathToFileURL(main).href; const depUri = pathToFileURL(dep).href;
  const client = new CompilerClient({ executable: executable ?? "ablac" });
  context.after(async () => { await client.stop().catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); });
  const initialized = await client.start({ workspaceRoots: [root], clientName: "real-graph-test", clientVersion: "0", analysisMode: "graph-v1" });
  assert.ok(initialized.capabilities.includes("analysis-fields-v1"));
  let accepted = 0;
  const workspace = new CompilerWorkspace(client, { roots: [root], capabilities: initialized.capabilities, accept: () => { accepted += 1; } });
  context.after(() => workspace.dispose());
  const projected = await workspace.ensure(uri);
  assert.deepEqual(projected.fields, ["diagnostics", "symbols"]);
  assert.equal(projected.complete, true);
  assert.equal(projected.documents.find((d) => d.uri === uri)?.occurrencesAvailable, false);
  const offset = text.indexOf("answer");
  const definition = await workspace.position("query/definition", uri, offset);
  assert.equal((definition.value as AblaSymbol).uri, depUri);
  assert.deepEqual((definition.value as AblaSymbol).selectionRange, { start: 4, end: 10 });
  const hover = await workspace.position("query/hover", uri, offset);
  assert.equal((hover.value as CompilerHover).type, "i64");
  const references = await workspace.position("query/references", uri, offset);
  assert.deepEqual(new Set((references.value as readonly CompilerLocation[]).map((v) => v.uri)), new Set([uri, depUri]));
  assert.equal((references.value as readonly CompilerLocation[]).find((v) => v.uri === uri)?.range.start, offset);
  const full = await workspace.ensure(uri, true);
  assert.equal(full.fields, undefined);
  assert.notEqual(full.documents.find((d) => d.uri === uri)?.occurrencesAvailable, false);
  assert.equal((await workspace.ensure(uri)).revision, full.revision);
  await workspace.update("open", { uri: depUri, version: 1, text: 'fun answer: string = "overlay"\n' });
  assert.equal(((await workspace.position("query/hover", uri, offset)).value as CompilerHover).type, "string");
  await workspace.close(depUri);
  assert.equal(((await workspace.position("query/hover", uri, offset)).value as CompilerHover).type, "i64");
  // No invalidation notification: the compiler's revision check must catch disk changes.
  await fs.writeFile(dep, 'fun answer: string = "disk"\n');
  assert.equal(((await workspace.position("query/hover", uri, offset)).value as CompilerHover).type, "string");
  await workspace.update("open", { uri, version: 1, text: '// café 😀\nval pending = #42\nfun main: int = pending\n' });
  const pending = await workspace.ensure(uri);
  assert.equal(pending.complete, false); assert.ok((pending.pending?.length ?? 0) > 0);
  assert.equal(pending.pending?.find((v) => v.uri === uri)?.range.start, '// café 😀\nval pending = '.length);
  assert.ok(accepted >= 5);
});
