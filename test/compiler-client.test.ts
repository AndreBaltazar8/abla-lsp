import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CompilerClient } from "../src/compiler-client.js";

function client(): CompilerClient {
  return new CompilerClient({
    executable: process.execPath,
    arguments: [path.resolve("test/fixtures/fake-ablac.mjs")],
  });
}

test("compiler client negotiates and exchanges snapshots", async () => {
  const compiler = client();
  const initialized = await compiler.start({
    workspaceRoots: ["file:///workspace"],
    clientName: "abla-lsp-test",
    clientVersion: "0",
  });
  assert.equal(initialized.protocolVersion, 1);
  assert.deepEqual(initialized.capabilities, ["overlays", "refactor-validation"]);
  const snapshot = await compiler.analyze();
  assert.deepEqual(snapshot, { revision: "test-1", documents: [] });
  const validation = await compiler.validate({
    baseRevision: snapshot.revision,
    edits: [],
    invariants: ["no-new-errors"],
  });
  assert.deepEqual(validation, { valid: true });
  await compiler.stop();
});

test("compiler client propagates cancellation", async () => {
  const compiler = client();
  await compiler.start({
    workspaceRoots: [],
    clientName: "abla-lsp-test",
    clientVersion: "0",
  });
  const controller = new AbortController();
  const pending = compiler.request("analyze", { wait: true }, controller.signal);
  controller.abort(new Error("superseded analysis"));
  await assert.rejects(pending, /superseded analysis/);
  await compiler.stop();
});

test("compiler client reports an unexpected child exit", async () => {
  let reportExit: (error: Error) => void = () => undefined;
  const exited = new Promise<Error>((resolve) => {
    reportExit = resolve;
  });
  const compiler = new CompilerClient({
    executable: process.execPath,
    arguments: [path.resolve("test/fixtures/fake-ablac.mjs")],
    onExit: (error) => reportExit(error),
  });
  await compiler.start({
    workspaceRoots: [],
    clientName: "abla-lsp-test",
    clientVersion: "0",
  });
  await assert.rejects(compiler.request("crash" as never, {}), /exited \(23\)/);
  assert.match((await exited).message, /exited \(23\)/);
});
