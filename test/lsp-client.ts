import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const compiler = process.env.ABLA_COMPILER;

export interface Reply { id?: number; method?: string; result?: unknown; error?: { message: string } }

export type Context = { after(callback: () => unknown): void };
export async function connect(context: Context, root: string, uri: string, text: string): Promise<{ request: (method: string, params: unknown) => Promise<Reply> }> {
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
  return { request };
}

