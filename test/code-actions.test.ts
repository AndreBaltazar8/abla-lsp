import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { CodeAction } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import { connect } from "./lsp-client.js";
import { CompilerClient } from "../src/compiler-client.js";

const compiler = process.env.ABLA_COMPILER;

test("quick fix fills a missing named argument from the same-name binding", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
  timeout: 120_000,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-named-argument-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = [
    "fun send(name: string): int = name.size",
    "fun main: int {",
    '    val name = "Abla"',
    "    send(name =)",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "named-argument"\nentry = "main.ab"\n');
  await fs.writeFile(path.join(root, "main.ab"), text);
  const uri = pathToFileURL(path.join(root, "main.ab")).href;
  const { request } = await connect(context, root, uri, text);
  const position = { line: 3, character: 15 };
  let actions: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const reply = await request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: position, end: position },
      context: { diagnostics: [], only: ["quickfix"] },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    actions = reply.result;
    if (Array.isArray(actions) && actions.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(actions, [{
    title: "Fill named argument with 'name'",
    kind: "quickfix",
    edit: { changes: { [uri]: [{ range: { start: position, end: position }, newText: " name" }] } },
  }]);
  const elsewhere = { line: 2, character: 8 };
  const unrelated = await request("textDocument/codeAction", {
    textDocument: { uri },
    range: { start: elsewhere, end: elsewhere },
    context: { diagnostics: [], only: ["quickfix"] },
  });
  assert.deepEqual(unrelated.result, []);
  await request("shutdown", null);
});

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

for (const scope of ["stdlib", "sibling"] as const) test(`add all missing imports matches fix-imports and is available on save (${scope})`, {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
  timeout: 120_000,
}, async (context) => {
  assert.ok(compiler);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-imports-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const probe = new CompilerClient({ executable: compiler });
  const init = await probe.start({ workspaceRoots: [root], analysisMode: "graph-v2", clientName: "test", clientVersion: "1" });
  await probe.stop();
  if (!init.capabilities.includes("analysis-missing-imports-v1")) {
    context.skip("compiler lacks the missing-imports planner");
    return;
  }

  const siblings = ["first", "second", "third"];
  const text = scope === "stdlib"
    ? await fs.readFile("test/fixtures/missing-imports.ab", "utf8")
    : 'import "./support.ab"\nfun main: int = support() + first() + second() + third()\n';
  if (scope === "sibling") {
    for (const name of siblings) await fs.writeFile(path.join(root, `${name}.ab`), `fun ${name}: int = 1\n`);
    const imports = siblings.map((name) => `import "./${name}.ab"\n`).join("");
    await fs.writeFile(path.join(root, "support.ab"), imports + "fun support: int = first() + second() + third()\n");
  }
  const file = path.join(root, "main.ab");
  const cli = path.join(root, "cli.ab");
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "missing-imports"\nentry = "main.ab"\nvisibility = "imports"\n');
  await fs.writeFile(file, text);
  await fs.writeFile(cli, text);
  const result = execFileSync(compiler, ["fix-imports", cli], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.match(result, /added 3 import\(s\) in 1 file\(s\); 0 name\(s\) left unresolved/u);
  const expected = await fs.readFile(cli, "utf8");
  const modules = scope === "stdlib" ? ["abla/io", "abla/json", "abla/regex"] : siblings.map((name) => `./${name}.ab`);
  for (const module of modules) assert.ok(expected.includes(`import "${module}"\n`));

  const uri = pathToFileURL(file).href;
  const { request } = await connect(context, root, uri, text);
  const position = { line: 0, character: 3 };
  const actions = async (only: string): Promise<CodeAction[]> => {
    const reply = await request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: position, end: position },
      context: { diagnostics: [], only: [only] },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return (reply.result as CodeAction[]).filter((action) => action.title === "Add all missing imports");
  };
  let quickFix: CodeAction[] = [];
  for (let attempt = 0; attempt < 40 && quickFix.length === 0; attempt += 1) {
    quickFix = await actions("quickfix");
    if (quickFix.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const saveKind = "source.fixAll.abla.missingImports";
  for (const [answer, kind] of [[quickFix, "quickfix"], [await actions("source.fixAll"), saveKind], [await actions(saveKind), saveKind]] as const) {
    assert.equal(answer.length, 1);
    assert.equal(answer[0]?.kind, kind);
    const changes = answer[0]?.edit?.documentChanges;
    assert.equal(changes?.length, 1);
    const change = changes?.[0];
    assert.ok(change !== undefined && "textDocument" in change);
    assert.deepEqual(change.textDocument, { uri, version: 1 });
    assert.equal(change.edits.length, 1);
    const edit = change.edits[0];
    assert.ok(edit !== undefined && "newText" in edit);
    const actual = TextDocument.applyEdits(TextDocument.create(uri, "abla", 1, text), [edit]);
    assert.equal(actual, expected);
  }
  assert.equal(await fs.readFile(file, "utf8"), text, "requesting an edit must not change the file on disk");
  await request("shutdown", null);
});
