import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DapClient } from "./dap-client.js";
import { ablaGdbArguments, ablaLldbCommands, isRuntimeFrame } from "../src/debugger-commands.js";

// Drives lldb-dap through a short session on a program built with -g: break at an Abla line, read values, step.
// Needs ABLA_COMPILER (an ablac) and ABLA_LLDB_DAP (the lldb-dap executable: `nix-shell -p llvmPackages.lldb`).
const compiler = process.env.ABLA_COMPILER;
const adapter = process.env.ABLA_LLDB_DAP;

interface Variable { name: string; type?: string; value: string; variablesReference: number }

test("lldb-dap: breakpoint by Abla file:line, readable string/array/class values, stepping stays in Abla", {
  skip: compiler === undefined || adapter === undefined ? "set ABLA_COMPILER and ABLA_LLDB_DAP to run the debugger session" : false,
  timeout: 180_000,
}, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-dap-"));
  context.after(() => process.env.KEEP_DAP_DIR ? undefined : fs.rm(dir, { recursive: true, force: true }));
  if (process.env.KEEP_DAP_DIR) console.log("DIR", dir);
  await fs.copyFile(path.resolve("test/fixtures/debug-app.ab"), path.join(dir, "app.ab"));
  const built = spawnSync(compiler as string, ["build", "app.ab", "-o", "app", "-g", "--fast"], { cwd: dir, encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const client = new DapClient(adapter as string);
  context.after(() => client.stop());
  const initialized = await client.request("initialize", { adapterID: "lldb-dap", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  assert.equal(initialized.success, true, JSON.stringify(initialized.body));
  const launched = client.request("launch", { program: path.join(dir, "app"), cwd: dir, initCommands: ablaLldbCommands });
  await client.event("initialized");
  const source = { path: path.join(dir, "app.ab") };
  const breakpoints = await client.request("setBreakpoints", { source, breakpoints: [{ line: 13 }] });
  assert.equal(breakpoints.body.breakpoints[0].verified, true, JSON.stringify(breakpoints.body));
  await client.request("configurationDone");
  assert.equal((await launched).success, true);
  const stopped = await client.event("stopped");
  assert.equal(stopped.body.reason, "breakpoint");
  const threadId = stopped.body.threadId as number;

  const top = async (): Promise<{ id: number; name: string; line: number; path: string | undefined }> => {
    const stack = await client.request("stackTrace", { threadId });
    const frame = stack.body.stackFrames[0];
    return { id: frame.id, name: frame.name, line: frame.line, path: frame.source?.path };
  };
  const locals = async (frameId: number): Promise<Map<string, Variable>> => {
    const scopes = await client.request("scopes", { frameId });
    const scope = scopes.body.scopes.find((candidate: { name: string }) => candidate.name === "Locals");
    const reply = await client.request("variables", { variablesReference: scope.variablesReference });
    return new Map((reply.body.variables as Variable[]).map((variable) => [variable.name, variable]));
  };

  const frame = await top();
  // The object keeps the source by the path the build named it (relative to the project root).
  assert.deepEqual([frame.name, frame.line, path.basename(frame.path ?? "")], ["app.main", 13, "app.ab"]);
  const values = await locals(frame.id);
  assert.match(values.get("name")?.value ?? "", /hello/u, "a string shows its text");
  assert.match(values.get("items")?.value ?? "", /length 3/u, "an array shows its length");
  assert.equal(values.get("maybe")?.value, "5");
  const point = values.get("p");
  const fields = (await client.request("variables", { variablesReference: point?.variablesReference })).body.variables as Variable[];
  assert.deepEqual(fields.map((field) => [field.name, field.value]), [["x", "3"], ["y", "4"]], "a class instance shows its fields");

  // Step in: into the method, in Abla source (not a runtime frame); step out; step over to the next Abla line.
  const stepIn = async (): Promise<void> => {
    await client.request("stepIn", { threadId });
    await client.event("stopped");
    // lldb-dap's stepIn may land in the runtime: the extension steps out of it and steps in again, as here.
    for (let guard = 0; isRuntimeFrame((await top()).name) && guard < 50; guard += 1) {
      await client.request("stepOut", { threadId });
      await client.event("stopped");
      await client.request("stepIn", { threadId });
      await client.event("stopped");
    }
  };
  await stepIn();
  const inside = await top();
  assert.deepEqual([inside.name, inside.line, path.basename(inside.path ?? "")], ["app.Point.norm1", 3, "app.ab"]);
  await client.request("stepOut", { threadId });
  await client.event("stopped");
  assert.equal((await top()).name, "app.main");
  await client.request("next", { threadId });
  await client.event("stopped");
  const next = await top();
  assert.deepEqual([next.name, next.line], ["app.main", 14]);
  // Step in at the line that builds a string: the runtime's concatenation is stepped out of, so the stop is in Abla
  // code (the standard library's println), never in a runtime function.
  await stepIn();
  const landed = await top();
  assert.equal(isRuntimeFrame(landed.name), false, landed.name);
  assert.equal(landed.path !== undefined && landed.path.endsWith("entry.ab"), true, `${landed.name} ${landed.path}`);
});

// The same session through gdb's DAP mode (`gdb -i dap`), the fallback where lldb-dap is missing. gdb has no Abla
// value formatters (they would need its Python), so this checks the break, the frames and the stepping only.
const gdbDap = process.env.ABLA_GDB_DAP;

test("gdb -i dap: breakpoint by Abla file:line, frames in Abla source, step in skips the runtime", {
  skip: compiler === undefined || gdbDap === undefined ? "set ABLA_COMPILER and ABLA_GDB_DAP (a gdb with DAP) to run the gdb session" : false,
  timeout: 180_000,
}, async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-gdb-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(path.resolve("test/fixtures/debug-app.ab"), path.join(dir, "app.ab"));
  const built = spawnSync(compiler as string, ["build", "app.ab", "-o", "app", "-g", "--fast"], { cwd: dir, encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const client = new DapClient(gdbDap as string, ablaGdbArguments);
  context.after(() => client.stop());
  assert.equal((await client.request("initialize", { adapterID: "gdb", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" })).success, true);
  const launched = client.request("launch", { program: path.join(dir, "app"), cwd: dir });
  await client.event("initialized");
  await client.request("setBreakpoints", { source: { path: path.join(dir, "app.ab") }, breakpoints: [{ line: 13 }] });
  await client.request("configurationDone");
  assert.equal((await launched).success, true);
  const stopped = await client.event("stopped");
  const threadId = stopped.body.threadId as number;
  const top = async (): Promise<{ name: string; line: number; path: string | undefined }> => {
    const frame = (await client.request("stackTrace", { threadId })).body.stackFrames[0];
    return { name: frame.name, line: frame.line, path: frame.source?.path };
  };
  const first = await top();
  assert.deepEqual([first.name, first.line, path.basename(first.path ?? "")], ["app.main", 13, "app.ab"]);
  await client.request("stepIn", { threadId });
  await client.event("stopped");
  const inside = await top();
  assert.deepEqual([inside.name, inside.line, path.basename(inside.path ?? "")], ["app.Point.norm1", 3, "app.ab"]);
  await client.request("stepOut", { threadId });
  await client.event("stopped");
  await client.request("next", { threadId });
  await client.event("stopped");
  assert.deepEqual([(await top()).name, (await top()).line], ["app.main", 14]);
  // Step in at the line that builds a string: gdb's skip passes over the runtime's concatenation.
  await client.request("stepIn", { threadId });
  await client.event("stopped");
  const landed = await top();
  assert.equal(isRuntimeFrame(landed.name), false, landed.name);
});
