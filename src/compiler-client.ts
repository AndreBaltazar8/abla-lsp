import type { AblaSymbol } from "./model.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  compilerProtocolVersion,
  isCompilerResponse,
  type CompilerAnalyzeParams,
  type CompilerCloseDocumentParams,
  type CompilerDocumentParams,
  type CompilerInitializeParams,
  type CompilerInitializeResult,
  type CompilerMethod,
  type CompilerRequest,
  type CompilerResponse,
  type CompilerValidateEditParams,
  type CompilerValidateEditResult,
  type CompilerWorkspaceSnapshot,
  type CompilerWireSnapshot,
  type CompilerPositionParams,
  type CompilerQueryResult,
  type CompilerLocation,
  type CompilerHover,
} from "./compiler-protocol.js";
import { normalizeCompilerSnapshot, Utf8OffsetMap, compilerUriKey, normalizePending } from "./encoding.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly cleanup: () => void;
}

export interface CompilerClientOptions {
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly log?: (message: string) => void;
  readonly onExit?: (error: Error) => void;
}

export class CompilerProtocolError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "CompilerProtocolError";
    this.code = code;
    this.data = data;
  }
}
export class CompilerClient {
  readonly #options: CompilerClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #stopping = false;
  #sourceRevision: string | undefined;
  readonly #sources = new Map<string, { readonly uri: string; readonly map: Utf8OffsetMap }>();

  constructor(options: CompilerClientOptions) {
    this.#options = options;
  }

  async start(params: CompilerInitializeParams): Promise<CompilerInitializeResult> {
    if (this.#process !== undefined) throw new Error("compiler client is already started");
    this.#stopping = false;
    this.#sourceRevision = undefined;
    this.#sources.clear();
    const child = spawn(
      this.#options.executable,
      [...(this.#options.arguments ?? ["analyze", "--stdio"])],
      {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.environment },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.#options.log?.(line);
    });
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      this.#process = undefined;
      if (!this.#stopping) {
        const error = new Error(
          `compiler analysis service exited (${code ?? signal ?? "unknown"})`,
        );
        this.#failAll(error);
        this.#options.onExit?.(error);
      }
    });
    return this.request<CompilerInitializeResult>("initialize", params);
  }

  open(params: CompilerDocumentParams, signal?: AbortSignal): Promise<void> {
    return this.request<void>("document/open", params, signal);
  }

  change(params: CompilerDocumentParams, signal?: AbortSignal): Promise<void> {
    return this.request<void>("document/change", params, signal);
  }

  close(params: CompilerCloseDocumentParams, signal?: AbortSignal): Promise<void> {
    return this.request<void>("document/close", params, signal);
  }

  async analyze(
    params: CompilerAnalyzeParams = {},
    signal?: AbortSignal,
  ): Promise<CompilerWorkspaceSnapshot> {
    const snapshot = await this.request<CompilerWireSnapshot>(
      "analyze",
      params,
      signal,
    );
    this.#sourceRevision = snapshot.revision;
    this.#sources.clear();
    for (const document of snapshot.documents) {
      this.#sources.set(compilerUriKey(document.uri), { uri: document.uri, map: new Utf8OffsetMap(document.text) });
    }
    return normalizeCompilerSnapshot(snapshot, new Map([...this.#sources].map(([uri, source]) => [uri, source.map])));
  }

  async definition(params: CompilerPositionParams, signal?: AbortSignal): Promise<CompilerQueryResult<AblaSymbol | null>> {
    const result = await this.request<CompilerQueryResult<AblaSymbol | null>>("query/definition", params, signal);
    this.#checkQueryRevision(params, result.revision);
    return this.#queryResult(params, result, result.value === null ? null : this.#symbol(result.value));
  }

  async hover(params: CompilerPositionParams, signal?: AbortSignal): Promise<CompilerQueryResult<CompilerHover | null>> {
    const result = await this.request<CompilerQueryResult<CompilerHover | null>>("query/hover", params, signal);
    this.#checkQueryRevision(params, result.revision);
    const value = result.value === null ? null : {
      ...result.value, range: this.#source(params.uri).map.range(result.value.range),
      symbol: result.value.symbol === null ? null : this.#symbol(result.value.symbol),
    };
    return this.#queryResult(params, result, value);
  }

  async references(params: CompilerPositionParams, signal?: AbortSignal): Promise<CompilerQueryResult<readonly CompilerLocation[]>> {
    const result = await this.request<CompilerQueryResult<readonly CompilerLocation[]>>("query/references", params, signal);
    this.#checkQueryRevision(params, result.revision);
    return this.#queryResult(params, result, result.value.map((location) => {
      const source = this.#source(location.uri);
      return { uri: source.uri, range: source.map.range(location.range) };
    }));
  }

  #source(uri: string): { readonly uri: string; readonly map: Utf8OffsetMap } {
    const source = this.#sources.get(compilerUriKey(uri));
    if (source === undefined) throw new CompilerProtocolError("source_not_analyzed", `query source is unavailable: ${uri}`);
    return source;
  }

  #symbol(symbol: AblaSymbol): AblaSymbol {
    const source = this.#source(symbol.uri);
    return { ...symbol, uri: source.uri, range: source.map.range(symbol.range), selectionRange: source.map.range(symbol.selectionRange) };
  }

  #checkQueryRevision(params: CompilerPositionParams, revision: string): void {
    if (revision !== params.revision || revision !== this.#sourceRevision) {
      throw new CompilerProtocolError("stale_revision", "query source revision is stale");
    }
  }

  #queryResult<Value>(params: CompilerPositionParams, result: CompilerQueryResult<unknown>, value: Value): CompilerQueryResult<Value> {
    this.#checkQueryRevision(params, result.revision);
    const maps = new Map([...this.#sources].map(([uri, source]) => [uri, source.map]));
    return { ...result, value, ...(result.pending === undefined ? {} : { pending: normalizePending(result.pending, maps) }) };
  }

  async validate(
    params: CompilerValidateEditParams,
    signal?: AbortSignal,
  ): Promise<CompilerValidateEditResult> {
    const result = await this.request<CompilerValidateEditResult>(
      "refactor/validate",
      params,
      signal,
    );
    return result.snapshot === undefined
      ? result
      : { ...result, snapshot: normalizeCompilerSnapshot(result.snapshot) };
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (child === undefined) return;
    this.#stopping = true;
    try {
      await this.request<void>("shutdown", {});
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
      this.#process = undefined;
      this.#failAll(new Error("compiler analysis service stopped"));
    }
  }

  request<Result>(
    method: CompilerMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    const child = this.#process;
    if (child === undefined) return Promise.reject(new Error("compiler client is not started"));
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    const id = this.#nextId;
    this.#nextId += 1;
    const request: CompilerRequest = {
      schema: compilerProtocolVersion,
      id,
      method,
      params,
    };
    return new Promise<Result>((resolve, reject) => {
      const onAbort = (): void => {
        this.#write({
          schema: compilerProtocolVersion,
          method: "cancel",
          params: { id },
        });
        this.#pending.delete(id);
        reject(signal?.reason ?? new Error("compiler request cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      this.#write(request);
    });
  }

  #write(message: object): void {
    const child = this.#process;
    if (child === undefined) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#options.log?.(`ignored malformed compiler protocol line: ${line}`);
      return;
    }
    if (!isCompilerResponse(parsed)) {
      this.#options.log?.("ignored compiler response with an incompatible schema");
      return;
    }
    this.#settle(parsed);
  }

  #settle(response: CompilerResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    pending.cleanup();
    if (response.error !== undefined) {
      pending.reject(
        new CompilerProtocolError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      );
    } else pending.resolve(response.result);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
