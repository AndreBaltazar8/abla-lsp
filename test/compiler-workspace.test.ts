import assert from "node:assert/strict";
import test from "node:test";
import { CompilerClient, CompilerProtocolError } from "../src/compiler-client.js";
import { CompilerWorkspace, SupersededAnalysis } from "../src/compiler-workspace.js";
import type { CompilerAnalyzeParams, CompilerDocumentParams, CompilerPositionParams, CompilerWorkspaceSnapshot } from "../src/compiler-protocol.js";
import { WorkspaceIndex } from "../src/index.js";
import { AdvancedRefactors } from "../src/refactors.js";
import { SyntaxAnalyzer } from "../src/source.js";
const uri = "file:///workspace/main.ab";
const capabilities = ["module-graph-analysis-v1", "no-eval-ct", "analysis-queries-v1", "analysis-fields-v1"];
function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
class FakeTransport {
  revision = 0;
  text = "fun main: int = 0\n";
  analyses: CompilerAnalyzeParams[] = [];
  beforeAnalyze: (() => Promise<void>) | undefined;
  beforeHover: (() => Promise<void>) | undefined;
  async analyze(params: CompilerAnalyzeParams): Promise<CompilerWorkspaceSnapshot> {
    this.analyses.push(params); await this.beforeAnalyze?.();
    const partial = params.fields !== undefined;
    return { revision: `${this.revision}`, analysisMode: "graph-v1", complete: true, pending: [],
      ...(partial ? { fields: params.fields } : {}),
      documents: [{ uri, version: this.revision, text: this.text, symbols: [], diagnostics: [], occurrences: [], ...(partial ? { occurrencesAvailable: false } : {}) }] };
  }
  async open(doc: CompilerDocumentParams): Promise<void> { this.revision = doc.version; this.text = doc.text; }
  async change(doc: CompilerDocumentParams): Promise<void> { return this.open(doc); }
  async close(): Promise<void> { this.revision += 1; }
  async hover(params: CompilerPositionParams) {
    await this.beforeHover?.();
    if (params.revision !== `${this.revision}`) throw new CompilerProtocolError("stale_revision", "changed");
    return { revision: `${this.revision}`, complete: true, pending: [], value: null };
  }
  async definition(params: CompilerPositionParams) { return this.hover(params); }
  async references(params: CompilerPositionParams) { return { ...(await this.hover(params)), value: [] }; }
}
test("worker coalesces edits behind one analysis and never accepts the obsolete view", async () => {
  const fake = new FakeTransport(); const started = deferred(); const release = deferred();
  fake.beforeAnalyze = async () => { if (fake.analyses.length === 1) { started.resolve(); await release.promise; } };
  const accepted: string[] = [];
  const workspace = new CompilerWorkspace(fake, { roots: [], capabilities, accept: (snapshot) => accepted.push(snapshot.revision) });
  try {
    workspace.schedule(0); await started.promise;
    const updates = Array.from({ length: 20 }, (_, i) => workspace.update("change", { uri, version: i + 1, text: `fun main: int = ${i}\n` }));
    release.resolve(); await Promise.all(updates); await workspace.ensure();
    assert.equal(fake.analyses.length, 2);
    assert.deepEqual(accepted, ["20"]);
    await workspace.ensure(undefined, true);
    assert.equal(fake.analyses.length, 3);
    assert.equal(fake.analyses[2]?.fields, undefined);
    await workspace.ensure(); assert.equal(fake.analyses.length, 3);
  } finally { workspace.dispose(); }
});
test("worker refreshes once on a stale disk revision", async () => {
  const fake = new FakeTransport();
  const workspace = new CompilerWorkspace(fake, { roots: [], capabilities, accept: () => undefined });
  try {
    await workspace.ensure(uri); fake.revision += 1;
    assert.equal((await workspace.position("query/hover", uri, 0)).revision, "1");
    assert.equal(fake.analyses.length, 2);
  } finally { workspace.dispose(); }
});
test("a positional reply is discarded if its source was edited while it ran", async () => {
  const fake = new FakeTransport(); const started = deferred(); const release = deferred();
  const workspace = new CompilerWorkspace(fake, { roots: [], capabilities, accept: () => undefined });
  try {
    await workspace.update("open", { uri, version: 1, text: fake.text }); await workspace.ensure(uri);
    fake.beforeHover = async () => { started.resolve(); await release.promise; };
    const query = workspace.position("query/hover", uri, 0); await started.promise;
    const update = workspace.update("change", { uri, version: 2, text: "fun changed: int = 1\n" });
    release.resolve(); await assert.rejects(query, SupersededAnalysis); await update;
  } finally { workspace.dispose(); }
});
test("legacy transport never receives graph roots or projections", async () => {
  const fake = new FakeTransport();
  const workspace = new CompilerWorkspace(fake, { roots: ["/workspace"], capabilities: [], accept: () => undefined });
  try { await workspace.ensure(uri); assert.deepEqual(fake.analyses, [{}]); assert.equal(workspace.queries, false); }
  finally { workspace.dispose(); }
});
test("partial facts cannot prove a rename, reference set or dead declaration", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const syntax = index.upsert(uri, 1, "fun _unused: int = 0\n");
  index.upsertAnalysis({ ...syntax, authority: "compiler", occurrences: [], occurrencesAvailable: false, analysisComplete: true });
  assert.equal(index.rename({ uri, position: { line: 0, character: 5 }, newName: "next" }).ok, false);
  assert.equal(new AdvancedRefactors(index).removeDeadCode({ aggressive: true }).ok, false);
  const symbol = index.symbols()[0]; assert.ok(symbol);
  assert.throws(() => index.references({ symbol, analysis: index.document(uri) ?? syntax }), /not been loaded/);
  index.upsertAnalysis({ ...syntax, authority: "compiler", analysisComplete: false });
  assert.equal(new AdvancedRefactors(index).removeDeadCode({ aggressive: true }).ok, false);
});

test("disposing the worker prevents an in-flight view from being accepted", async () => {
  const fake = new FakeTransport(); const started = deferred(); const release = deferred();
  fake.beforeAnalyze = async () => { started.resolve(); await release.promise; };
  const accepted: string[] = [];
  const workspace = new CompilerWorkspace(fake, { roots: [], capabilities, accept: (snapshot) => accepted.push(snapshot.revision) });
  const pending = workspace.ensure(); await started.promise; workspace.dispose(); release.resolve();
  await assert.rejects(pending, /closed/); assert.deepEqual(accepted, []);
});

test("a pending full-fact consumer upgrades the refresh instead of fetching both views", async () => {
  const fake = new FakeTransport();
  const workspace = new CompilerWorkspace(fake, { roots: [], capabilities, accept: () => undefined });
  try {
    const summary = workspace.ensure(); const full = workspace.ensure(undefined, true);
    await Promise.all([summary, full]);
    assert.equal(fake.analyses.length, 1); assert.equal(fake.analyses[0]?.fields, undefined);
  } finally { workspace.dispose(); }
});
