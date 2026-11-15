import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import test from "node:test";
import { CompilerClient } from "../src/compiler-client.js";
import { CompilerWorkspace } from "../src/compiler-workspace.js";
import type { CompilerWorkspaceSnapshot } from "../src/compiler-protocol.js";

// A compiler with graph-v2 (the fake graph compiler in 'graph2' mode): stable ids, and analyze with `since`.
async function session(context: { after: (hook: () => Promise<void>) => void }, mode = "graph2") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "abla-lsp-since-"));
  const log = path.join(root, "trace");
  const client = new CompilerClient({
    executable: process.execPath,
    arguments: [path.resolve("test/fixtures/fake-graph-ablac.mjs"), mode, log],
  });
  context.after(async () => { await client.stop().catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); });
  const analyzes = async () => (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .filter((message) => message.method === "analyze");
  return { client, analyzes };
}
const uri = (name: string) => `file:///workspace/${name}`;
const open = (client: CompilerClient, name: string, text: string, version = 1) => client.open({ uri: uri(name), version, text });
const summary = (snapshot: CompilerWorkspaceSnapshot) => snapshot.documents.map((d) => `${d.uri.slice(uri("").length)}@${d.version}:${d.text}`);

test("graph-v2: the second analysis asks for what changed since the first and is merged into it", async (context) => {
  const { client, analyzes } = await session(context);
  const initialized = await client.start({ workspaceRoots: [], clientName: "t", clientVersion: "0", analysisMode: "graph-v2" });
  assert.ok(initialized.capabilities.includes("analysis-since-v1"));
  await open(client, "a.ab", "fun target(): int = 1\n");
  await open(client, "b.ab", "fun other(): int = 2\n");
  const first = await client.analyze();
  assert.equal(first.analysisMode, "graph-v2");
  assert.deepEqual(summary(first), ["a.ab@1:fun target(): int = 1\n", "b.ab@1:fun other(): int = 2\n"]);
  // Nothing changed: the same answer, sent as nothing.
  const same = await client.analyze();
  assert.deepEqual(same, first);
  // One document changes: the answer has the new one in its place and the other as it was (the same object, held).
  await client.change({ uri: uri("a.ab"), version: 2, text: "fun target(): int = 11\n" });
  const second = await client.analyze();
  assert.deepEqual(summary(second), ["a.ab@2:fun target(): int = 11\n", "b.ab@1:fun other(): int = 2\n"]);
  assert.equal(second.documents[1], same.documents[1], "an unchanged document is not rebuilt");
  assert.equal(second.revision, "3");
  // A document added and one removed.
  await open(client, "c.ab", "fun third(): int = 3\n");
  await client.close({ uri: uri("b.ab") });
  const third = await client.analyze();
  assert.deepEqual(summary(third), ["a.ab@2:fun target(): int = 11\n", "c.ab@1:fun third(): int = 3\n"]);
  // The requests: the first without since, each later with the revision of the answer before it.
  const sent = await analyzes();
  assert.deepEqual(sent.map((message) => message.params.since), [undefined, "2", "2", "3"]);
  await client.stop();
});

test("graph-v2: the held answer is the same as a fresh whole one after every edit", async (context) => {
  const { client } = await session(context);
  const fresh = await session(context);
  await client.start({ workspaceRoots: [], clientName: "t", clientVersion: "0", analysisMode: "graph-v2" });
  const edits = [
    () => open(client, "a.ab", "fun target(): int = 1\n"),
    () => open(client, "b.ab", "fun other(): int = target()\n"),
    () => client.change({ uri: uri("b.ab"), version: 2, text: "fun other(): int = target() + target()\n" }),
    () => client.close({ uri: uri("a.ab") }),
    () => open(client, "a.ab", "fun target(): int = 5\n", 3),
  ];
  for (const edit of edits) {
    await edit();
    const incremental = await client.analyze();
    // A compiler that has not seen the project before, given the documents the first has now: its whole answer.
    const wholeClient = new CompilerClient({ executable: process.execPath, arguments: [path.resolve("test/fixtures/fake-graph-ablac.mjs"), "graph2"] });
    await wholeClient.start({ workspaceRoots: [], clientName: "t", clientVersion: "0", analysisMode: "graph-v2" });
    for (const document of incremental.documents) await wholeClient.open({ uri: document.uri, version: document.version, text: document.text });
    const whole = await wholeClient.analyze();
    await wholeClient.stop();
    assert.deepEqual(summary(incremental).sort(), summary(whole).sort());
    for (const document of incremental.documents) {
      const other = whole.documents.find((d) => d.uri === document.uri);
      assert.deepEqual(document.occurrences, other?.occurrences);
      assert.deepEqual(document.symbols, other?.symbols);
    }
  }
  assert.ok(fresh.client);
});

test("graph-v2: a different set of fields is a whole analysis, and a graph-v1 compiler is asked nothing it does not know", async (context) => {
  const { client, analyzes } = await session(context);
  await client.start({ workspaceRoots: [], clientName: "t", clientVersion: "0", analysisMode: "graph-v2" });
  await open(client, "a.ab", "fun target(): int = 1\n");
  await client.analyze({ fields: ["diagnostics", "symbols"] });
  const all = await client.analyze();
  assert.ok(all.documents[0]?.occurrences.length === 1, "the occurrences the projection left out are there");
  await client.analyze();
  const sent = await analyzes();
  assert.deepEqual(sent.map((message) => message.params.since), [undefined, undefined, "1"]);
  await client.stop();
  const old = await session(context, "graph");
  const rejected = await old.client.start({ workspaceRoots: [], clientName: "t", clientVersion: "0", analysisMode: "graph-v1" });
  assert.ok(!rejected.capabilities.includes("analysis-since-v1"));
  await open(old.client, "a.ab", "fun target(): int = 1\n");
  await old.client.analyze(); await old.client.analyze();
  assert.ok((await old.analyzes()).every((message) => message.params.since === undefined));
});

test("graph-v2: the workspace works on the merged snapshot", async (context) => {
  const { client } = await session(context);
  const initialized = await client.start({ workspaceRoots: [], clientName: "t", clientVersion: "0", analysisMode: "graph-v2" });
  const accepted: CompilerWorkspaceSnapshot[] = [];
  const workspace = new CompilerWorkspace(client, { roots: ["/workspace"], capabilities: initialized.capabilities, accept: (snapshot) => accepted.push(snapshot) });
  assert.equal(workspace.stableIds, true);
  await workspace.update("open", { uri: uri("a.ab"), version: 1, text: "fun target(): int = 1\n" });
  const first = await workspace.ensure(uri("a.ab"), true, true);
  await workspace.update("change", { uri: uri("a.ab"), version: 2, text: "fun target(): int = 12\n" });
  const second = await workspace.ensure(uri("a.ab"), true, true);
  assert.equal(first.documents[0]?.version, 1);
  assert.equal(second.documents[0]?.version, 2);
  assert.equal(second.analysisMode, "graph-v2");
  workspace.dispose();
});
