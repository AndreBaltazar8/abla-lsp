import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

interface RpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
}

class LspClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (message: RpcMessage) => void>();
  #buffer = Buffer.alloc(0);
  #nextId = 1;

  constructor() {
    this.#child = spawn(process.execPath, ["dist/src/main.js", "--stdio"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
  }

  request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => this.#pending.set(id, resolve));
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    await this.request("shutdown", null);
    this.notify("exit", null);
    await new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
  }

  #send(message: RpcMessage): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.#child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#child.stdin.write(body);
  }

  #drain(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      assert.notEqual(match, null);
      const length = Number(match?.[1]);
      const bodyBegin = headerEnd + 4;
      if (this.#buffer.length < bodyBegin + length) return;
      const message = JSON.parse(
        this.#buffer.subarray(bodyBegin, bodyBegin + length).toString("utf8"),
      ) as RpcMessage;
      this.#buffer = this.#buffer.subarray(bodyBegin + length);
      if (message.id !== undefined) {
        const resolve = this.#pending.get(message.id);
        if (resolve !== undefined) {
          this.#pending.delete(message.id);
          resolve(message);
        }
      }
    }
  }
}

test("stdio server initializes and serves symbols and rename", async () => {
  const client = new LspClient();
  const initialize = await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: { compiler: { enabled: false } },
  });
  const initialization = initialize.result as {
    capabilities: { renameProvider: unknown; documentSymbolProvider: unknown };
    serverInfo: { name: string };
  };
  assert.equal(initialization.serverInfo.name, "abla-lsp");
  assert.equal(initialization.capabilities.documentSymbolProvider, true);
  assert.deepEqual(initialization.capabilities.renameProvider, { prepareProvider: true });
  client.notify("initialized", {});

  const uri = "file:///workspace/main.ab";
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "abla",
      version: 1,
      text: "fun answer(): int = 42\nfun main: int = answer()\n",
    },
  });
  const symbols = await client.request("textDocument/documentSymbol", {
    textDocument: { uri },
  });
  assert.deepEqual(
    (symbols.result as Array<{ name: string }>).map((symbol) => symbol.name),
    ["answer", "main"],
  );

  const rename = await client.request("textDocument/rename", {
    textDocument: { uri },
    position: { line: 1, character: 17 },
    newName: "result",
  });
  const edit = rename.result as {
    changes: Record<string, Array<{ newText: string }>>;
  };
  assert.equal(edit.changes[uri]?.length, 2);
  assert.ok(edit.changes[uri]?.every((change) => change.newText === "result"));
  await client.stop();
});
