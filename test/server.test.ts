import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
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
  readonly #notificationWaiters = new Map<
    string,
    Array<{ readonly matches: (params: unknown) => boolean; readonly resolve: (params: unknown) => void }>
  >();

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

  waitForNotification(
    method: string,
    matches: (params: unknown) => boolean,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve };
      const existing = this.#notificationWaiters.get(method) ?? [];
      existing.push(waiter);
      this.#notificationWaiters.set(method, existing);
      setTimeout(() => {
        const pending = this.#notificationWaiters.get(method) ?? [];
        const index = pending.indexOf(waiter);
        if (index >= 0) {
          pending.splice(index, 1);
          reject(new Error(`timed out waiting for ${method}`));
        }
      }, 2_000).unref();
    });
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
      } else if (message.method !== undefined) {
        const waiters = this.#notificationWaiters.get(message.method) ?? [];
        const matched = waiters.find((waiter) => waiter.matches(message.params));
        if (matched !== undefined) {
          waiters.splice(waiters.indexOf(matched), 1);
          matched.resolve(message.params);
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
    capabilities: {
      renameProvider: unknown;
      documentSymbolProvider: unknown;
      completionProvider: unknown;
      semanticTokensProvider: unknown;
      callHierarchyProvider: unknown;
      declarationProvider: unknown;
      typeDefinitionProvider: unknown;
      documentHighlightProvider: unknown;
    };
    serverInfo: { name: string };
  };
  assert.equal(initialization.serverInfo.name, "abla-lsp");
  assert.equal(initialization.capabilities.documentSymbolProvider, true);
  assert.deepEqual(initialization.capabilities.renameProvider, { prepareProvider: true });
  assert.notEqual(initialization.capabilities.completionProvider, undefined);
  assert.notEqual(initialization.capabilities.semanticTokensProvider, undefined);
  assert.equal(initialization.capabilities.callHierarchyProvider, true);
  assert.equal(initialization.capabilities.declarationProvider, true);
  assert.equal(initialization.capabilities.typeDefinitionProvider, true);
  assert.equal(initialization.capabilities.documentHighlightProvider, true);
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

  const completion = await client.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 1, character: 4 },
  });
  assert.ok(
    (completion.result as Array<{ label: string }>).some((item) => item.label === "answer"),
  );

  const signature = await client.request("textDocument/signatureHelp", {
    textDocument: { uri },
    position: { line: 1, character: 23 },
  });
  assert.match(
    (signature.result as { signatures: Array<{ label: string }> }).signatures[0]?.label ?? "",
    /answer/,
  );

  const semanticTokens = await client.request("textDocument/semanticTokens/full", {
    textDocument: { uri },
  });
  assert.ok((semanticTokens.result as { data: number[] }).data.length >= 10);

  const declaration = await client.request("textDocument/declaration", {
    textDocument: { uri },
    position: { line: 1, character: 18 },
  });
  assert.deepEqual(
    (declaration.result as Array<{ range: { start: { line: number } } }>)[0]?.range.start.line,
    0,
  );

  const references = await client.request("textDocument/references", {
    textDocument: { uri },
    position: { line: 1, character: 18 },
    context: { includeDeclaration: false },
  });
  assert.equal((references.result as unknown[]).length, 1);

  const highlights = await client.request("textDocument/documentHighlight", {
    textDocument: { uri },
    position: { line: 1, character: 18 },
  });
  assert.equal((highlights.result as unknown[]).length, 2);

  const formatted = await client.request("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 4, insertSpaces: true },
  });
  assert.deepEqual(formatted.result, []);

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

test("compiler snapshots drive type definitions", async () => {
  const client = new LspClient();
  await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: {
      compiler: {
        enabled: true,
        path: process.execPath,
        arguments: [path.resolve("test/fixtures/fake-ablac.mjs")],
      },
    },
  });
  client.notify("initialized", {});
  const uri = "file:///workspace/types.ab";
  const compilerDiagnostics = client.waitForNotification(
    "textDocument/publishDiagnostics",
    (params) =>
      (params as { diagnostics?: Array<{ source?: string }> }).diagnostics?.[0]?.source === "ablac",
  );
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "abla",
      version: 3,
      text: [
        "class Widget {}",
        "fun make(): Widget = Widget()",
        "fun build(name: string, count: int): int = count",
        'fun main: int = build("x", 2)',
        "",
      ].join("\n"),
    },
  });
  await compilerDiagnostics;
  const typeDefinition = await client.request("textDocument/typeDefinition", {
    textDocument: { uri },
    position: { line: 1, character: 5 },
  });
  const locations = typeDefinition.result as Array<{
    range: { start: { line: number; character: number } };
  }>;
  assert.deepEqual(locations[0]?.range.start, { line: 0, character: 6 });

  const inlayHints = await client.request("textDocument/inlayHint", {
    textDocument: { uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: 4, character: 0 },
    },
  });
  assert.deepEqual(
    (inlayHints.result as Array<{ label: string }>).map((hint) => hint.label),
    ["name:", "count:"],
  );
  await client.stop();
});
