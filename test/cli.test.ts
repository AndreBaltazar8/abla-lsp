import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-refactor-cli-"));
  const file = path.join(root, "main.ab");
  const text = "// café 😀\nfun target(): int = 42\nfun main: int = target()\n";
  await fs.writeFile(path.join(root, "abla.toml"), 'name = "cli-test"\nentry = "main.ab"\n');
  await fs.writeFile(file, text);
  const compiler = path.join(root, "fake-ablac.sh");
  await fs.writeFile(compiler, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("test/fixtures/fake-graph-ablac.mjs"))} graph\n`, { mode: 0o755 });
  return { root, file, text, compiler };
}

function cli(root: string, compiler: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), ...args, "--compiler", compiler, "--timeout", "60"], { cwd: root, encoding: "utf8" });
}

test("abla-refactor rename prints a unified diff and changes nothing without --apply", async (context) => {
  const f = await fixture();
  context.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = cli(f.root, f.compiler, "rename", "main.ab#target", "renamed");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^--- a\/main\.ab$/mu);
  assert.match(result.stdout, /^\+fun renamed\(\): int = 42$/mu);
  assert.match(result.stdout, /^\+fun main: int = renamed\(\)$/mu);
  assert.equal(await fs.readFile(f.file, "utf8"), f.text);
});

test("abla-refactor rename --apply writes the result; a line:column target works", async (context) => {
  const f = await fixture();
  context.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = cli(f.root, f.compiler, "rename", "main.ab:2:5", "renamed", "--apply");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(f.file, "utf8"), "// café 😀\nfun renamed(): int = 42\nfun main: int = renamed()\n");
  assert.deepEqual((await fs.readdir(f.root)).filter((name) => name.includes(".abla-refactor-")), []);
});

test("abla-refactor reports usage errors with status 2 and refusals with status 1", async (context) => {
  const f = await fixture();
  context.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const unknown = cli(f.root, f.compiler, "rename", "main.ab#missing", "x");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no symbol "missing"/u);
  const bad = cli(f.root, f.compiler, "frobnicate");
  assert.equal(bad.status, 2);
  const refused = cli(f.root, f.compiler, "rename", "main.ab#target", "not a name");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refused/u);
  assert.equal(await fs.readFile(f.file, "utf8"), f.text);
});
