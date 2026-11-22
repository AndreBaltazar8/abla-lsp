#!/usr/bin/env node
/**
 * abla-refactor: the headless driver of abla-lsp's transactional refactors.
 *
 * It starts the language server as a child, speaks LSP to it, and asks for the same compiler-validated edit an
 * editor gets. Without --apply the edit is printed as a unified diff; with --apply every file is written
 * atomically (all temporary files first, then renames). Exit status: 0 done, 1 refused by the refactoring or
 * the compiler validation, 2 usage, 3 the server or compiler could not run.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
interface TextEdit { range: Range; newText: string }
interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<
    | { textDocument: { uri: string }; edits: TextEdit[] }
    | { kind: "create"; uri: string }
    | { kind: "rename"; oldUri: string; newUri: string }
    | { kind: "delete"; uri: string }
  >;
}
interface DocumentSymbol { name: string; selectionRange: Range; children?: DocumentSymbol[] }

class Usage extends Error {}
class Refused extends Error {}
class Environment extends Error {}

const usage = `usage: abla-refactor <command> [options]

commands (a <target> is file:line:column, 1-based, or file#name / file#Container.name):
  rename <target> <newName>              rename a symbol everywhere (the compiler's canonical identity)
  inline <target>                        inline a local, a constant or a function
  extract <file:L:C-L:C> <name>          extract the range into a function (--target <file> to place it elsewhere)
  move <target>... --to <file> [--create] move top-level declarations to another file
  recipe <recipe.json> [--staged]        run a refactor recipe: {"operations":[{"kind":"rename","request":{...}}]}
  command <abla.command> <args.json|->   any server command; the JSON is its first argument (selections by line:col in LSP 0-based positions)

options:
  --apply            write the result (default: print a unified diff and change nothing)
  --root <dir>       workspace root (default: the nearest directory with an abla.toml above the first file)
  --entry <file>     project entry when the abla.toml names none (ablac's own src/: --entry src/orc_main.ab)
  --compiler <path>  the ablac to ask (default: ABLA_COMPILER, then ablac)
  --json             print the workspace edit as JSON instead of a diff
  --timeout <s>      give up after this many seconds (default 600)
`;

interface Options {
  apply: boolean;
  json: boolean;
  staged: boolean;
  create: boolean;
  root?: string;
  compiler?: string;
  entry?: string;
  target?: string;
  to?: string;
  timeout: number;
  positional: string[];
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { apply: false, json: false, staged: false, create: false, timeout: 600, positional: [] };
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined) throw new Usage(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--apply") options.apply = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--staged") options.staged = true;
    else if (argument === "--create") options.create = true;
    else if (argument === "--root") { options.root = path.resolve(value(index, argument)); index += 1; }
    else if (argument === "--compiler") { options.compiler = value(index, argument); index += 1; }
    else if (argument === "--entry") { options.entry = path.resolve(value(index, argument)); index += 1; }
    else if (argument === "--target") { options.target = value(index, argument); index += 1; }
    else if (argument === "--to") { options.to = value(index, argument); index += 1; }
    else if (argument === "--timeout") { options.timeout = Number(value(index, argument)); index += 1; }
    else if (argument.startsWith("--")) throw new Usage(`unknown option ${argument}`);
    else options.positional.push(argument);
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Usage("--timeout must be a positive number");
  return options;
}

/** A minimal LSP client over the child's stdio. */
class Server {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private id = 0;
  private stderr = "";
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(compiler: string | undefined) {
    const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
    this.child = spawn(process.execPath, [main, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: compiler === undefined ? process.env : { ...process.env, ABLA_COMPILER: compiler },
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += String(chunk);
      if (process.env.ABLA_REFACTOR_VERBOSE !== undefined) process.stderr.write(chunk);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.child.on("exit", () => {
      for (const waiting of this.pending.values()) waiting.reject(new Environment(`the language server exited\n${this.stderr.slice(-2000)}`));
      this.pending.clear();
    });
  }

  private drain(): void {
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/iu.exec(this.buffer.subarray(0, end).toString())?.[1] ?? "0");
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as {
        id?: number | string; method?: string; result?: unknown; error?: { message: string; code: number };
      };
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method === "window/logMessage" && process.env.ABLA_REFACTOR_VERBOSE !== undefined) {
        process.stderr.write(`server: ${(message as { params?: { message?: string } }).params?.message ?? ""}\n`);
      }
      if (message.method !== undefined) {
        // A request from the server (configuration, capability registration, progress): answer it so it never waits.
        if (message.id !== undefined) this.send({ id: message.id, result: message.method === "workspace/configuration" ? [] : null });
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (waiting === undefined) continue;
      if (message.error !== undefined) waiting.reject(new Refused(message.error.message));
      else waiting.resolve(message.result);
    }
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.send({ method, params }); }

  async stop(): Promise<void> {
    if (this.child.exitCode === null) {
      await Promise.race([
        this.request("shutdown", null).then(() => this.notify("exit", null)).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (this.child.exitCode === null) this.child.kill();
    }
  }
}

function findRoot(file: string): string {
  let directory = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(directory, "abla.toml"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(file);
    directory = parent;
  }
}

interface Target { file: string; uri: string; position: Position }

async function documentSymbols(server: Server, uri: string): Promise<DocumentSymbol[]> {
  return (await server.request("textDocument/documentSymbol", { textDocument: { uri } })) as DocumentSymbol[];
}

/** file:line:column (1-based) or file#name or file#Container.name. */
async function resolveTarget(server: Server, text: string): Promise<Target> {
  const located = /^(.*?):(\d+):(\d+)$/u.exec(text);
  if (located !== null) {
    const file = path.resolve(located[1] as string);
    return { file, uri: pathToFileURL(file).href, position: { line: Number(located[2]) - 1, character: Number(located[3]) - 1 } };
  }
  const hash = text.lastIndexOf("#");
  if (hash < 0) throw new Usage(`${text}: a target is file:line:column or file#name`);
  const file = path.resolve(text.slice(0, hash));
  const uri = pathToFileURL(file).href;
  await openFile(server, file);
  const wanted = text.slice(hash + 1).split(".");
  let level = await documentSymbols(server, uri);
  let found: DocumentSymbol | undefined;
  for (const name of wanted) {
    found = level.find((symbol) => symbol.name === name || symbol.name.startsWith(`${name}(`));
    if (found === undefined) throw new Usage(`${text}: no symbol "${name}" in ${path.relative(process.cwd(), file)}`);
    level = found.children ?? [];
  }
  if (found === undefined) throw new Usage(`${text}: empty symbol path`);
  return { file, uri, position: found.selectionRange.start };
}

const opened = new Set<string>();
async function openFile(server: Server, file: string): Promise<void> {
  if (opened.has(file)) return;
  opened.add(file);
  server.notify("textDocument/didOpen", {
    textDocument: { uri: pathToFileURL(file).href, languageId: "abla", version: 1, text: await fs.readFile(file, "utf8") },
  });
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1);
  return starts;
}

function applyTextEdits(text: string, edits: readonly TextEdit[], label: string): string {
  const starts = lineStarts(text);
  const offset = (position: Position): number => Math.min((starts[position.line] ?? text.length) + position.character, text.length);
  const ordered = edits
    .map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), newText: edit.newText }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if ((ordered[index] as { start: number }).start < (ordered[index - 1] as { end: number }).end) {
      throw new Refused(`${label}: the refactoring returned overlapping edits`);
    }
  }
  let result = "";
  let cursor = 0;
  for (const edit of ordered) {
    result += text.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

interface FileChange { file: string; before: string | undefined; after: string | undefined }

/** The files an edit would write: undefined `before` is a new file, undefined `after` a deleted one. */
async function planEdit(edit: WorkspaceEdit): Promise<FileChange[]> {
  const contents = new Map<string, string | undefined>();
  const originals = new Map<string, string | undefined>();
  const read = async (file: string): Promise<string | undefined> => {
    if (contents.has(file)) return contents.get(file);
    const text = existsSync(file) ? await fs.readFile(file, "utf8") : undefined;
    originals.set(file, text);
    contents.set(file, text);
    return text;
  };
  const edits = async (uri: string, list: readonly TextEdit[]): Promise<void> => {
    const file = fileURLToPath(uri);
    const text = (await read(file)) ?? "";
    contents.set(file, applyTextEdits(text, list, path.relative(process.cwd(), file)));
  };
  for (const [uri, list] of Object.entries(edit.changes ?? {})) await edits(uri, list);
  for (const change of edit.documentChanges ?? []) {
    if ("edits" in change) await edits(change.textDocument.uri, change.edits);
    else if (change.kind === "create") { const file = fileURLToPath(change.uri); await read(file); if (contents.get(file) === undefined) contents.set(file, ""); }
    else if (change.kind === "delete") { const file = fileURLToPath(change.uri); await read(file); contents.set(file, undefined); }
    else {
      const from = fileURLToPath(change.oldUri);
      const to = fileURLToPath(change.newUri);
      const text = await read(from);
      await read(to);
      contents.set(to, text);
      contents.set(from, undefined);
    }
  }
  const changes: FileChange[] = [];
  for (const [file, after] of contents) {
    const before = originals.get(file);
    if (before !== after) changes.push({ file, before, after });
  }
  return changes.sort((left, right) => left.file.localeCompare(right.file));
}

async function renderDiff(changes: readonly FileChange[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abla-refactor-diff-"));
  try {
    let output = "";
    for (const [index, change] of changes.entries()) {
      const relative = path.relative(process.cwd(), change.file) || change.file;
      const old = path.join(directory, `${index}.old`);
      const next = path.join(directory, `${index}.new`);
      await fs.writeFile(old, change.before ?? "");
      await fs.writeFile(next, change.after ?? "");
      const diff = spawnSync("diff", ["-u", "--label", change.before === undefined ? "/dev/null" : `a/${relative}`, "--label", change.after === undefined ? "/dev/null" : `b/${relative}`, old, next], { encoding: "utf8", maxBuffer: 1 << 28 });
      if (diff.error !== undefined) throw new Environment(`diff is needed to print the changes: ${diff.error.message}`);
      output += diff.stdout;
    }
    return output;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Every file gets its temporary sibling first; only then are they renamed into place, so a failure writes nothing. */
async function writeAtomically(changes: readonly FileChange[]): Promise<void> {
  const staged: Array<{ file: string; temporary?: string }> = [];
  try {
    for (const change of changes) {
      if (change.after === undefined) { staged.push({ file: change.file }); continue; }
      await fs.mkdir(path.dirname(change.file), { recursive: true });
      const temporary = `${change.file}.abla-refactor-${process.pid}`;
      await fs.writeFile(temporary, change.after);
      staged.push({ file: change.file, temporary });
    }
  } catch (error) {
    for (const entry of staged) if (entry.temporary !== undefined) await fs.rm(entry.temporary, { force: true });
    throw error;
  }
  for (const entry of staged) {
    if (entry.temporary === undefined) await fs.rm(entry.file, { force: true });
    else await fs.rename(entry.temporary, entry.file);
  }
}

function range(text: string): { file: string; range: Range } {
  const match = /^(.*?):(\d+):(\d+)-(\d+):(\d+)$/u.exec(text);
  if (match === null) throw new Usage(`${text}: a range is file:line:column-line:column`);
  return {
    file: path.resolve(match[1] as string),
    range: {
      start: { line: Number(match[2]) - 1, character: Number(match[3]) - 1 },
      end: { line: Number(match[4]) - 1, character: Number(match[5]) - 1 },
    },
  };
}

async function readJson(source: string): Promise<unknown> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  return JSON.parse(await fs.readFile(source, "utf8"));
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(usage);
    return command === undefined ? 2 : 0;
  }
  const options = parseOptions(rest);
  const positional = options.positional;
  const need = (count: number, form: string): void => {
    if (positional.length < count) throw new Usage(`usage: abla-refactor ${form}`);
  };
  const first = positional[0];
  const firstFile = (): string => {
    if (first === undefined) throw new Usage(usage);
    const located = /^(.*?)(?::\d+:\d+(?:-\d+:\d+)?|#.*)$/u.exec(first);
    return path.resolve(located === null ? first : (located[1] as string));
  };
  if (!["rename", "inline", "extract", "move", "recipe", "command"].includes(command)) throw new Usage(`unknown command ${command}\n${usage}`);
  need(1, `${command} ...`);
  const operationFile = command === "recipe" || command === "command" ? undefined : firstFile();
  const root = options.root ?? findRoot(operationFile ?? (options.root ?? process.cwd()) + "/x");
  const server = new Server(options.compiler);
  const timer = setTimeout(() => {
    process.stderr.write(`abla-refactor: no answer within ${options.timeout} s\n`);
    void server.stop().finally(() => process.exit(3));
  }, options.timeout * 1000);
  try {
    await server.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
      capabilities: { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] } } },
      initializationOptions: { compiler: { ...(options.compiler === undefined ? {} : { path: options.compiler }), ...(options.entry === undefined ? {} : { entryPoints: [options.entry] }) } },
    });
    server.notify("initialized", {});
    let edit: WorkspaceEdit | null;
    if (command === "rename") {
      need(2, "rename <target> <newName>");
      const target = await resolveTarget(server, first as string);
      await openFile(server, target.file);
      edit = (await server.request("textDocument/rename", { textDocument: { uri: target.uri }, position: target.position, newName: positional[1] })) as WorkspaceEdit | null;
    } else if (command === "inline") {
      const target = await resolveTarget(server, first as string);
      await openFile(server, target.file);
      edit = (await server.request("workspace/executeCommand", { command: "abla.inlineSymbol", arguments: [{ selection: { uri: target.uri, position: target.position } }] })) as WorkspaceEdit | null;
    } else if (command === "extract") {
      need(2, "extract <file:L:C-L:C> <name>");
      const selected = range(first as string);
      await openFile(server, selected.file);
      const uri = pathToFileURL(selected.file).href;
      edit = (await server.request("workspace/executeCommand", { command: "abla.extractFunction", arguments: [{ uri, range: selected.range, name: positional[1], ...(options.target === undefined ? {} : { targetUri: pathToFileURL(path.resolve(options.target)).href }) }] })) as WorkspaceEdit | null;
    } else if (command === "move") {
      if (options.to === undefined) throw new Usage("move needs --to <file>");
      const selections = [];
      for (const text of positional) {
        const target = await resolveTarget(server, text);
        await openFile(server, target.file);
        selections.push({ uri: target.uri, position: target.position });
      }
      edit = (await server.request("workspace/executeCommand", { command: "abla.moveDeclarations", arguments: [{ selections, targetUri: pathToFileURL(path.resolve(options.to)).href, createTarget: options.create }] })) as WorkspaceEdit | null;
    } else if (command === "recipe") {
      const recipe = (await readJson(first as string)) as { operations?: unknown };
      edit = (await server.request("workspace/executeCommand", { command: options.staged ? "abla.applyStagedRefactorRecipe" : "abla.applyRefactorRecipe", arguments: [{ operations: recipe.operations ?? [] }] })) as WorkspaceEdit | null;
    } else {
      need(2, "command <abla.command> <args.json|->");
      const args = (await readJson(positional[1] as string)) as Record<string, unknown>;
      edit = (await server.request("workspace/executeCommand", { command: first, arguments: [args] })) as WorkspaceEdit | null;
    }
    if (edit === null || edit === undefined) throw new Refused("the server returned no edit");
    if (options.json) {
      process.stdout.write(`${JSON.stringify(edit, null, 2)}\n`);
      return 0;
    }
    const changes = await planEdit(edit);
    if (changes.length === 0) {
      process.stderr.write("abla-refactor: nothing to change\n");
      return 0;
    }
    if (options.apply) {
      await writeAtomically(changes);
      process.stderr.write(`abla-refactor: applied to ${changes.length} file${changes.length === 1 ? "" : "s"}\n`);
      for (const change of changes) process.stderr.write(`  ${change.before === undefined ? "A" : change.after === undefined ? "D" : "M"} ${path.relative(process.cwd(), change.file) || change.file}\n`);
    } else {
      process.stdout.write(await renderDiff(changes));
      process.stderr.write(`abla-refactor: ${changes.length} file${changes.length === 1 ? "" : "s"} would change (--apply writes them)\n`);
    }
    return 0;
  } finally {
    clearTimeout(timer);
    await server.stop();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Usage) { process.stderr.write(`${message}\n`); process.exit(2); }
    if (error instanceof Refused) { process.stderr.write(`abla-refactor: refused: ${message}\n`); process.exit(1); }
    process.stderr.write(`abla-refactor: ${message}\n`);
    process.exit(3);
  },
);
