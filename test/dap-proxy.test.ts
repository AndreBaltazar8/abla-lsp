import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProxyClient } from "./dap-client.js";
import { DapProxy } from "../src/dap-proxy.js";
import { ablaLldbCommands } from "../src/debugger-commands.js";

// The proxy reads the layout the compiler documents (docs/debugging.md, "Variables"): this test fails when the array
// header or the universal value's tag drift, instead of the editor showing wrong values.
const compiler = process.env.ABLA_COMPILER;
const adapter = process.env.ABLA_LLDB_DAP;

interface Variable { name: string; type?: string; value: string; variablesReference: number }

test("DAP proxy: an array shows its length and elements, a null optional shows null (layout drift guard)", {
  skip: compiler === undefined || adapter === undefined ? "set ABLA_COMPILER and ABLA_LLDB_DAP to run the debugger session" : false,
  timeout: 180_000,
}, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-proxy-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(path.resolve("test/fixtures/debug-app.ab"), path.join(dir, "app.ab"));
  const built = spawnSync(compiler as string, ["build", "app.ab", "-o", "app", "-g", "--fast"], { cwd: dir, encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const client = new ProxyClient(new DapProxy(adapter as string));
  context.after(() => client.stop());
  assert.equal((await client.request("initialize", { adapterID: "lldb-dap", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" })).success, true);
  const launched = client.request("launch", { program: path.join(dir, "app"), cwd: dir, initCommands: ablaLldbCommands });
  await client.event("initialized");
  await client.request("setBreakpoints", { source: { path: path.join(dir, "app.ab") }, breakpoints: [{ line: 14 }] });
  await client.request("configurationDone");
  assert.equal((await launched).success, true);
  const stopped = await client.event("stopped");
  const stack = await client.request("stackTrace", { threadId: stopped.body.threadId });
  const scopes = await client.request("scopes", { frameId: stack.body.stackFrames[0].id });
  const locals = scopes.body.scopes.find((scope: { name: string }) => scope.name === "Locals");
  const variables = (await client.request("variables", { variablesReference: locals.variablesReference })).body.variables as Variable[];
  const byName = new Map(variables.map((variable) => [variable.name, variable]));
  assert.equal(byName.get("name")?.value, '"hello"');
  const items = byName.get("items");
  assert.equal(items?.value, "length 3");
  const elements = (await client.request("variables", { variablesReference: items?.variablesReference })).body.variables as Variable[];
  assert.deepEqual(elements.map((element) => [element.name, element.value]), [["[0]", "1"], ["[1]", "2"], ["[2]", "3"]]);
  assert.equal(byName.get("none")?.value, "null", "a null optional is not shown as {}");
  assert.equal(byName.get("maybe")?.value, "5");
});
