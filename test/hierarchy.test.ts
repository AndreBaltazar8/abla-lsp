import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { connect } from "./lsp-client.js";

const compiler = process.env.ABLA_COMPILER;

test("go to implementation and the type hierarchy follow class headers", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
  timeout: 120_000,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-hier-"));
  const text = [
    "interface Shape {", "    fun area(): int", "}",
    "class Square(val side: int) : Shape {", "    fun area(): int = this.side * this.side", "}",
    "class Circle(val radius: int) : Shape {", "    fun area(): int = 3 * this.radius * this.radius", "}",
    "fun main: int = Square(2).area() + Circle(1).area()", "",
  ].join("\n");
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "hier"\nentry = "main.ab"\n');
  await fs.writeFile(path.join(root, "main.ab"), text);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.ab")).href;
  const { request } = await connect(context, root, uri, text);
  const at = (line: number, character: number) => ({ textDocument: { uri }, position: { line, character } });
  const lines = (locations: Array<{ range: { start: { line: number } } }>): number[] => locations.map((location) => location.range.start.line).sort();
  let implementations: Array<{ range: { start: { line: number } } }> = [];
  for (let attempt = 0; attempt < 40 && implementations.length < 2; attempt += 1) {
    implementations = ((await request("textDocument/implementation", at(0, 11))).result ?? []) as typeof implementations;
    if (implementations.length < 2) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(lines(implementations), [3, 6], "an interface's implementations are the classes naming it");
  const methods = (await request("textDocument/implementation", at(1, 8))).result as typeof implementations;
  assert.deepEqual(lines(methods), [4, 7], "an interface method's implementations are the same-named methods of those classes");
  const prepared = (await request("textDocument/prepareTypeHierarchy", at(3, 8))).result as Array<{ name: string }>;
  assert.deepEqual(prepared.map((item) => item.name), ["Square"]);
  const supertypes = (await request("typeHierarchy/supertypes", { item: prepared[0] })).result as Array<{ name: string }>;
  assert.deepEqual(supertypes.map((item) => item.name), ["Shape"]);
  const shape = (await request("textDocument/prepareTypeHierarchy", at(0, 11))).result as Array<{ name: string }>;
  const subtypes = (await request("typeHierarchy/subtypes", { item: shape[0] })).result as Array<{ name: string }>;
  assert.deepEqual(subtypes.map((item) => item.name).sort(), ["Circle", "Square"]);
});

test("a test program's main gets run and debug lenses", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
  timeout: 120_000,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-lens-"));
  const text = 'import "abla/test"\n\nfun main: int {\n    expect(1 + 1 == 2, "sum")\n    testsPassed()\n}\n';
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "lens"\nentry = "main.ab"\n');
  await fs.writeFile(path.join(root, "main.ab"), text);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.ab")).href;
  const { request } = await connect(context, root, uri, text);
  let lenses: Array<{ range: { start: { line: number } }; command: { command: string } }> = [];
  for (let attempt = 0; attempt < 40 && lenses.length === 0; attempt += 1) {
    lenses = ((await request("textDocument/codeLens", { textDocument: { uri } })).result ?? []) as typeof lenses;
    if (lenses.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(lenses.map((lens) => [lens.command.command, lens.range.start.line]), [["abla.runTest", 2], ["abla.debugTest", 2]]);
});
