import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompilerClient, CompilerProtocolError } from "./compiler-client.js";
import type {
  CompilerDocumentParams, CompilerWorkspaceSnapshot, CompilerQueryMethod,
  CompilerQueryResult, CompilerHover, CompilerLocation,
} from "./compiler-protocol.js";
import type { AblaSymbol } from "./model.js";
import { compilerUriKey, Utf8OffsetMap } from "./encoding.js";

type Transport = Pick<CompilerClient, "analyze" | "open" | "change" | "close" | "definition" | "hover" | "references">;
export type PositionValue = AblaSymbol | CompilerHover | readonly CompilerLocation[] | null;
export class SupersededAnalysis extends Error {
  constructor() { super("analysis was superseded by an edit or project switch"); }
}

export function compilerLocalUri(uri: string): boolean {
  try { const url = new URL(uri); fileURLToPath(url); return uri.startsWith("file:///") && url.search === "" && url.hash === ""; }
  catch { return false; }
}

export function ownedSource(uri: string, roots: readonly string[]): boolean {
  if (!uri.startsWith("file:")) return false;
  let file: string;
  try { file = path.resolve(fileURLToPath(uri)); } catch { return false; }
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), file);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." &&
      !path.isAbsolute(relative) && !relative.split(path.sep).some((part) =>
        [".abla", ".git", "build", "dist", "node_modules", "vendor"].includes(part));
  });
}

export async function compilerScope(
  uri: string | undefined, roots: readonly string[],
  snapshot: CompilerWorkspaceSnapshot | undefined, current: string | undefined,
): Promise<string | undefined> {
  if (uri === undefined) return current ?? (roots.length === 1 ? roots[0] : undefined);
  if (!uri.startsWith("file:")) return current;
  // Browsing an imported library keeps the importing project's semantics.
  if (!ownedSource(uri, roots) && snapshot?.documents.some((d) => compilerUriKey(d.uri) === compilerUriKey(uri))) return current;
  const file = path.resolve(fileURLToPath(uri));
  let directory = path.dirname(file);
  while (true) {
    try { await fs.access(path.join(directory, "abla.toml")); return directory; } catch { /* continue lexically */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (snapshot?.documents.some((d) => compilerUriKey(d.uri) === compilerUriKey(uri))) return current;
  return file;
}

/** One serial compiler worker; cancelled editor replies do not cancel compiler CPU work. */
export class CompilerWorkspace {
  readonly graph: boolean;
  readonly queries: boolean;
  readonly projected: boolean;
  readonly #client: Transport;
  readonly #roots: readonly string[];
  readonly #accept: (snapshot: CompilerWorkspaceSnapshot) => void;
  readonly #log: (message: string) => void;
  #snapshot: CompilerWorkspaceSnapshot | undefined;
  #scope: string | undefined;
  #epoch = 0;
  #snapshotEpoch = -1;
  #fullDemandEpoch = -1;
  #latestUri: string | undefined;
  readonly #overlays = new Map<string, CompilerDocumentParams>();
  #tail: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #background: Promise<unknown> | undefined;
  #dirty = false;
  #disposed = false;

  constructor(client: Transport, options: {
    readonly roots: readonly string[]; readonly capabilities: readonly string[];
    readonly accept: (snapshot: CompilerWorkspaceSnapshot) => void;
    readonly log?: (message: string) => void;
  }) {
    this.#client = client; this.#roots = options.roots; this.#accept = options.accept;
    this.#log = options.log ?? (() => undefined);
    this.graph = options.capabilities.includes("module-graph-analysis-v1");
    if (this.graph && !options.capabilities.includes("no-eval-ct")) throw new Error("graph compiler lacks the no-evaluation capability");
    this.queries = this.graph && options.capabilities.includes("analysis-queries-v1");
    this.projected = this.graph && options.capabilities.includes("analysis-fields-v1");
  }

  get snapshot(): CompilerWorkspaceSnapshot | undefined { return this.#snapshot; }
  get generation(): number { return this.#epoch; }
  dispose(): void { this.#disposed = true; this.#epoch += 1; if (this.#timer !== undefined) clearTimeout(this.#timer); }
  #serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    const next = this.#tail.then(() => {
      if (this.#disposed) throw new Error("compiler workspace is closed");
      return operation();
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }

  update(method: "open" | "change", document: CompilerDocumentParams): Promise<void> {
    if (this.graph && !compilerLocalUri(document.uri)) return Promise.resolve();
    this.#epoch += 1; this.#latestUri = document.uri;
    this.#overlays.set(compilerUriKey(document.uri), document);
    return this.#serial(() => this.#client[method](document)).then(() => this.schedule());
  }
  close(uri: string): Promise<void> {
    if (this.graph && !compilerLocalUri(uri)) return Promise.resolve();
    this.#epoch += 1; this.#overlays.delete(compilerUriKey(uri));
    return this.#serial(() => this.#client.close({ uri })).then(() => this.schedule());
  }
  invalidate(): void { this.#epoch += 1; this.schedule(); }

  schedule(delay = 50): void {
    if (this.#disposed) return;
    this.#dirty = true;
    if (this.#background !== undefined) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined; this.#dirty = false;
      this.#background = this.ensure(this.#latestUri, false)
        .catch((error: unknown) => { if (!(error instanceof SupersededAnalysis) && !this.#disposed) this.#log(String(error)); })
        .finally(() => { this.#background = undefined; if (this.#dirty && !this.#disposed) this.schedule(0); });
    }, delay);
  }

  async #refreshNow(uri: string | undefined, occurrences: boolean, force: boolean): Promise<CompilerWorkspaceSnapshot | undefined> {
    const epoch = this.#epoch;
    if (occurrences) this.#fullDemandEpoch = epoch;
    const needOccurrences = occurrences || this.#fullDemandEpoch === epoch;
    const scope = this.graph ? await compilerScope(uri, this.#roots, this.#snapshot, this.#scope) : undefined;
    if (this.#disposed || epoch !== this.#epoch) return undefined;
    const cached = this.#snapshot;
    const full = cached?.documents.every((d) => d.occurrencesAvailable !== false && d.symbolsAvailable !== false && d.diagnosticsAvailable !== false) ?? false;
    if (!force && cached !== undefined && this.#snapshotEpoch === epoch && scope === this.#scope && (!needOccurrences || full)) return cached;
    const result = await this.#client.analyze({
      ...(this.graph && scope !== undefined ? { roots: [scope] } : {}),
      ...(this.projected && !needOccurrences ? { fields: ["diagnostics", "symbols"] } : {}),
    });
    if (this.graph && (result.analysisMode !== "graph-v1" || typeof result.complete !== "boolean")) {
      throw new Error("graph compiler returned a snapshot without graph completeness metadata");
    }
    if (this.#disposed || epoch !== this.#epoch) return undefined;
    this.#scope = scope; this.#snapshotEpoch = epoch; this.#snapshot = result;
    this.#accept(result);
    return result;
  }

  async ensure(uri?: string, occurrences = false, force = false): Promise<CompilerWorkspaceSnapshot> {
    if (occurrences) this.#fullDemandEpoch = this.#epoch;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.#serial(() => this.#refreshNow(uri, occurrences, force));
      if (snapshot !== undefined) return snapshot;
    }
    throw new SupersededAnalysis();
  }

  async position(method: CompilerQueryMethod, uri: string, offset: number, signal?: AbortSignal): Promise<CompilerQueryResult<PositionValue> & { readonly snapshot: CompilerWorkspaceSnapshot }> {
    if (!this.queries) throw new CompilerProtocolError("method_not_found", "positional queries are unavailable");
    let force = false;
    const sourceState = this.#overlays.get(compilerUriKey(uri));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.#serial(async () => {
          if (signal?.aborted) throw signal.reason;
          if (sourceState !== this.#overlays.get(compilerUriKey(uri))) throw new SupersededAnalysis();
          const snapshot = await this.#refreshNow(uri, false, force);
          const epoch = this.#epoch;
          if (snapshot === undefined || this.#snapshotEpoch !== epoch) throw new SupersededAnalysis();
          const source = snapshot.documents.find((d) => compilerUriKey(d.uri) === compilerUriKey(uri));
          if (source === undefined) throw new CompilerProtocolError("document_not_analyzed", "document is outside the selected program graph");
          const params = { uri: source.uri, offset: new Utf8OffsetMap(source.text).byteOffset(offset), revision: snapshot.revision };
          const value = method === "query/definition" ? await this.#client.definition(params, signal)
            : method === "query/hover" ? await this.#client.hover(params, signal)
              : await this.#client.references(params, signal);
          if (this.#disposed || epoch !== this.#epoch || signal?.aborted || sourceState !== this.#overlays.get(compilerUriKey(uri))) throw new SupersededAnalysis();
          return { ...value, snapshot };
        });
        return result;
      } catch (error) {
        if (sourceState !== this.#overlays.get(compilerUriKey(uri))) throw new SupersededAnalysis();
        if (attempt === 0 && (error instanceof SupersededAnalysis ||
            (error instanceof CompilerProtocolError && error.code === "stale_revision"))) { force = true; continue; }
        throw error;
      }
    }
    throw new SupersededAnalysis();
  }
}
