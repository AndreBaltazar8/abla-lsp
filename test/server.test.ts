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
  readonly appliedEdits: unknown[] = [];
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
      if (message.id !== undefined && message.method === "workspace/applyEdit") {
        this.appliedEdits.push(message.params);
        this.#send({ jsonrpc: "2.0", id: message.id, result: { applied: true } });
      } else if (message.id !== undefined) {
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

interface ProtocolWorkspaceEdit {
  readonly changes?: Record<string, Array<{ readonly newText: string }>>;
  readonly documentChanges?: Array<
    | { readonly kind: "create"; readonly uri: string }
    | {
        readonly textDocument: { readonly uri: string };
        readonly edits: Array<{ readonly newText: string }>;
      }
  >;
}

function editText(edit: ProtocolWorkspaceEdit): string {
  const changes = Object.values(edit.changes ?? {}).flatMap((edits) =>
    edits.map((candidate) => candidate.newText));
  const documentChanges = (edit.documentChanges ?? []).flatMap((change) =>
    "textDocument" in change ? change.edits.map((candidate) => candidate.newText) : []);
  return [...changes, ...documentChanges].join("\n");
}

function sourcePosition(text: string, needle: string, from = 0): { line: number; character: number } {
  const offset = text.indexOf(needle, from);
  assert.notEqual(offset, -1, `missing source text: ${needle}`);
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function sourceRange(text: string, needle: string, from = 0) {
  const start = sourcePosition(text, needle, from);
  return {
    start,
    end: { line: start.line, character: start.character + needle.length },
  };
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

test("compiler snapshots drive type definitions", async (context) => {
  const client = new LspClient();
  context.after(async () => client.stop().catch(() => undefined));
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
        "fun show(widget: Widget): int = widget.",
        'fun typo: int = buidl("x", 2)',
        "",
      ].join("\n"),
    },
  });
  const published = await compilerDiagnostics as {
    diagnostics: Array<{
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      code: string;
      message: string;
      source: string;
      severity: number;
    }>;
  };
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
      end: { line: 5, character: 0 },
    },
  });
  assert.deepEqual(
    (inlayHints.result as Array<{ label: string }>).map((hint) => hint.label),
    ["name:", "count:"],
  );

  const memberCompletion = await client.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 4, character: 39 },
  });
  assert.deepEqual(
    (memberCompletion.result as Array<{ label: string }>).map((item) => item.label),
    ["render"],
  );

  const quickFixes = await client.request("textDocument/codeAction", {
    textDocument: { uri },
    range: published.diagnostics[0]?.range,
    context: { diagnostics: published.diagnostics, only: ["quickfix"] },
  });
  const fixes = quickFixes.result as Array<{
    edit: { changes: Record<string, Array<{ newText: string }>> };
  }>;
  assert.equal(fixes[0]?.edit.changes[uri]?.[0]?.newText, "build");
});

test("execute-command refactors are compiler validated and applied as workspace edits", async (context) => {
  const client = new LspClient();
  context.after(async () => client.stop().catch(() => undefined));
  const initialize = await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: { workspace: { applyEdit: true } },
    initializationOptions: {
      compiler: {
        enabled: true,
        path: process.execPath,
        arguments: [path.resolve("test/fixtures/refactor-ablac.mjs")],
      },
    },
  });
  const advertised = (initialize.result as {
    capabilities: { executeCommandProvider: { commands: string[] } };
  }).capabilities.executeCommandProvider.commands;
  assert.deepEqual(advertised, [
    "abla.renameSymbols",
    "abla.moveDeclarations",
    "abla.moveTypes",
    "abla.splitDeclarations",
    "abla.mergeDeclarations",
    "abla.changeSignature",
    "abla.extractFunction",
    "abla.functionToMethod",
    "abla.methodToFunction",
    "abla.inlineSymbol",
    "abla.introduceBinding",
    "abla.changeBindingKind",
    "abla.promoteLocal",
    "abla.extractInterface",
    "abla.generateDeclaration",
    "abla.repairOwnership",
    "abla.toggleCompileTime",
    "abla.removeDeadCode",
    "abla.applyRefactorRecipe",
    "abla.applyStagedRefactorRecipe",
  ]);
  client.notify("initialized", {});

  const uri = "file:///workspace/refactors.ab";
  const targetUri = "file:///workspace/moved.ab";
  const text = [
    "class Point(val x: int)",
    "class Greeter(val prefix: string) {",
    "    fun greet(name: string): string = prefix",
    "}",
    "fun Point.scaled(scale: int): int = this.x * scale",
    "val defaultScale: int = 2",
    "fun length(point: Point, scale: int): int = point.x * scale",
    "fun increment(value: int): int = value + 1",
    "fun _unused: int = 1",
    "fun main(): int {",
    "    val answer: int = increment(length(Point(20), defaultScale))",
    "    val total: int = 20 + 22",
    "    answer + total",
    "}",
    "fun missingUse: int = missing(2)",
    "",
  ].join("\n");
  const compilerReady = client.waitForNotification(
    "textDocument/publishDiagnostics",
    (params) =>
      (params as { uri?: string; diagnostics?: Array<{ source?: string }> }).uri === uri &&
      (params as { diagnostics?: Array<{ source?: string }> }).diagnostics?.[0]?.source === "ablac",
  );
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "abla", version: 1, text },
  });
  await compilerReady;

  const selection = (needle: string, from = 0) => {
    const position = sourcePosition(text, needle, from);
    return { uri, position: { ...position, character: position.character + 1 } };
  };
  const execute = async (
    command: string,
    argument: Record<string, unknown>,
  ): Promise<ProtocolWorkspaceEdit> => {
    const appliedBefore = client.appliedEdits.length;
    const response = await client.request("workspace/executeCommand", {
      command,
      arguments: [{ ...argument, apply: true }],
    });
    assert.equal(response.error, undefined, `${command}: ${JSON.stringify(response.error)}`);
    assert.notEqual(response.result, null, `${command} returned no edit`);
    assert.equal(client.appliedEdits.length, appliedBefore + 1, `${command} was not applied`);
    const applied = client.appliedEdits.at(-1) as { edit?: ProtocolWorkspaceEdit };
    assert.deepEqual(applied.edit, response.result, `${command} applied a different edit`);
    return response.result as ProtocolWorkspaceEdit;
  };

  const renamed = await execute("abla.renameSymbols", {
    renames: [{ ...selection("length"), newName: "distance" }],
  });
  assert.match(editText(renamed), /distance/u);

  const moved = await execute("abla.moveDeclarations", {
    selections: [selection("increment")], targetUri, createTarget: true,
  });
  assert.ok(moved.documentChanges?.some(
    (change) => "kind" in change && change.kind === "create" && change.uri === targetUri,
  ));
  assert.match(editText(moved), /fun increment/u);

  const signature = await execute("abla.changeSignature", {
    selection: selection("length"),
    parameters: [
      { name: "scale", source: "scale" },
      { name: "point", source: "point" },
    ],
  });
  assert.match(editText(signature), /scale: int, point: Point/u);

  const extracted = await execute("abla.extractFunction", {
    uri, range: sourceRange(text, "20 + 22"), name: "computeTotal", returnType: "int",
  });
  assert.match(editText(extracted), /computeTotal/u);

  const method = await execute("abla.functionToMethod", {
    selection: selection("length"), receiver: "point",
  });
  assert.match(editText(method), /Point\.length/u);

  const functionEdit = await execute("abla.methodToFunction", {
    selection: selection("scaled"), receiverName: "point",
  });
  assert.match(editText(functionEdit), /fun scaled\(point: Point/u);

  const inlined = await execute("abla.inlineSymbol", {
    selection: selection("increment"),
  });
  assert.match(editText(inlined), /value \+ 1|\+ 1/u);

  const introduced = await execute("abla.introduceBinding", {
    uri, range: sourceRange(text, "20 + 22"), name: "computed", destination: "local",
  });
  assert.match(editText(introduced), /val computed = 20 \+ 22/u);

  const binding = await execute("abla.changeBindingKind", {
    selection: selection("defaultScale"), kind: "var",
  });
  assert.match(editText(binding), /var/u);

  const promoted = await execute("abla.promoteLocal", {
    selection: selection("answer"), destination: "parameter",
  });
  assert.match(editText(promoted), /answer: int = increment/u);

  const interfaceEdit = await execute("abla.extractInterface", {
    selections: [selection("greet")], name: "Greeting",
  });
  assert.match(editText(interfaceEdit), /interface Greeting/u);

  const declaration = await execute("abla.generateDeclaration", {
    ...selection("missing", text.indexOf("= missing")), resultType: "int",
  });
  assert.match(editText(declaration), /fun missing\(argument1: int\): int/u);

  const ownership = await execute("abla.repairOwnership", {
    uri, range: sourceRange(text, "Point(20)"), strategy: "move",
  });
  assert.match(editText(ownership), /move\(Point\(20\)\)/u);

  const compileTime = await execute("abla.toggleCompileTime", {
    selection: selection("increment"), compileTime: true,
  });
  assert.match(editText(compileTime), /compile |#/u);

  const deadCode = await execute("abla.removeDeadCode", {});
  assert.ok(Object.values(deadCode.changes ?? {}).flat().some((edit) => edit.newText === ""));

  const recipe = await execute("abla.applyRefactorRecipe", {
    operations: [{
      kind: "repairOwnership",
      request: { uri, range: sourceRange(text, "defaultScale"), strategy: "borrow" },
    }],
  });
  assert.match(editText(recipe), /borrow\(defaultScale\)/u);

  const staged = await execute("abla.applyStagedRefactorRecipe", {
    operations: [
      {
        kind: "move",
        request: {
          symbols: [{ uri, name: "increment" }], targetUri, createTarget: true,
        },
      },
      {
        kind: "rename",
        request: { symbol: { uri: targetUri, name: "increment" }, newName: "next" },
      },
    ],
  });
  assert.ok(staged.documentChanges?.some(
    (change) => "kind" in change && change.kind === "create" && change.uri === targetUri,
  ));
  assert.match(editText(staged), /fun next/u);
});
