import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { connect } from "./lsp-client.js";

const compiler = process.env.ABLA_COMPILER;

async function project(): Promise<{ root: string; files: Record<string, string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-cross-"));
  const files = {
    "abla.toml": 'name = "cross"\nentry = "main.ab"\n',
    "lib.ab": "fun answer: int = 42\nclass Box(val value: int) {\n    fun get: int = this.value\n}\n",
    "plain.ab": 'import "lib.ab"\nfun twice: int = answer() * 2\n',
    "main.ab": 'import "lib.ab" as l\nimport "plain.ab"\nfun main: int {\n    val b = l.Box(l.answer())\n    b.get() + twice()\n}\n',
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  return { root, files };
}

function rename(root: string, target: string, newName: string) {
  return spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "rename", target, newName, "--timeout", "90"], { cwd: root, encoding: "utf8", env: { ...process.env, ABLA_COMPILER: compiler as string } });
}

const skip = compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false;

test("rename reaches an unaliased importer, an aliased importer and a member call in other modules", { skip, timeout: 180_000 }, async (context) => {
  const { root } = await project();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const function_ = rename(root, "lib.ab#answer", "reply");
  assert.equal(function_.status, 0, function_.stderr);
  assert.match(function_.stdout, /^\+fun reply: int = 42$/mu);
  assert.match(function_.stdout, /^\+fun twice: int = reply\(\) \* 2$/mu);
  assert.match(function_.stdout, /^\+ {4}val b = l\.Box\(l\.reply\(\)\)$/mu);
  const method = rename(root, "lib.ab#Box.get", "fetch");
  assert.equal(method.status, 0, method.stderr);
  assert.match(method.stdout, /^\+ {4}fun fetch: int = this\.value$/mu);
  assert.match(method.stdout, /^\+ {4}b\.fetch\(\) \+ twice\(\)$/mu);
  const type = rename(root, "lib.ab#Box", "Crate");
  assert.equal(type.status, 0, type.stderr);
  assert.match(type.stdout, /^\+ {4}val b = l\.Crate\(l\.answer\(\)\)$/mu);
});

test("references of a declaration list every module that uses it, whatever the import alias", { skip, timeout: 180_000 }, async (context) => {
  const { root, files } = await project();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "lib.ab")).href;
  const { request } = await connect(context, root, uri, files["lib.ab"] as string);
  let locations: Array<{ uri: string }> = [];
  for (let attempt = 0; attempt < 60 && locations.length < 3; attempt += 1) {
    const reply = await request("textDocument/references", { textDocument: { uri }, position: { line: 0, character: 5 }, context: { includeDeclaration: true } });
    locations = (reply.result ?? []) as typeof locations;
    if (locations.length < 3) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(locations.map((location) => path.basename(new URL(location.uri).pathname)).sort(), ["lib.ab", "main.ab", "plain.ab"]);
});

test("willRenameFiles rewrites the imports of every importer", { skip, timeout: 180_000 }, async (context) => {
  const { root, files } = await project();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.ab")).href;
  const { request } = await connect(context, root, uri, files["main.ab"] as string);
  const lib = pathToFileURL(path.join(root, "lib.ab")).href;
  const moved = pathToFileURL(path.join(root, "core", "lib2.ab")).href;
  let changes: Record<string, Array<{ newText: string }>> = {};
  for (let attempt = 0; attempt < 40 && Object.keys(changes).length < 2; attempt += 1) {
    const reply = await request("workspace/willRenameFiles", { files: [{ oldUri: lib, newUri: moved }] });
    changes = ((reply.result as { changes?: typeof changes } | null)?.changes) ?? {};
    if (Object.keys(changes).length < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const byFile = Object.fromEntries(Object.entries(changes).map(([file, edits]) => [path.basename(new URL(file).pathname), edits.map((edit) => edit.newText)]));
  assert.deepEqual(byFile, { "main.ab": ["core/lib2.ab"], "plain.ab": ["core/lib2.ab"] });
});
