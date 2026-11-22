import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const compiler = process.env.ABLA_COMPILER;

interface Reply { id?: number; method?: string; result?: unknown; error?: { message: string } }

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
  const child = spawn(process.execPath, ["dist/src/main.js", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ABLA_COMPILER: compiler as string } });
  context.after(() => child.kill());
  let buffer = Buffer.alloc(0);
  let counter = 0;
  const waiting = new Map<number, (reply: Reply) => void>();
  const send = (message: object): void => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/iu.exec(buffer.subarray(0, end).toString())?.[1]);
      if (buffer.length < end + 4 + length) return;
      const reply = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as Reply;
      buffer = buffer.subarray(end + 4 + length);
      if (reply.method !== undefined && (reply as { id?: number }).id !== undefined) send({ id: reply.id, result: null });
      else if (reply.id !== undefined) { waiting.get(reply.id)?.(reply); waiting.delete(reply.id); }
    }
  });
  const request = (method: string, params: unknown): Promise<Reply> => new Promise((resolve) => {
    counter += 1;
    waiting.set(counter, resolve);
    send({ id: counter, method, params });
  });
  await request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} });
  send({ method: "initialized", params: {} });
  send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "abla", version: 1, text } } });
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
