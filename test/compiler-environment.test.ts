import assert from "node:assert/strict";
import test from "node:test";
import { analysisEnvironment, parseCompilerVersion } from "../src/compiler-environment.js";

// ablac 0.2.62 to 0.2.68 fault (SIGBUS) on macOS at the first freeze of `analyze --stdio`: the compiler is started with ABLA_ANALYSIS_FREEZE=0 there, unless the
// user chose a value, and never on another system or with 0.2.69 and later.
test("a compiler before 0.2.69 on macOS is started with the freeze off", () => {
  for (const version of ["ablac 0.2.62\n", "ablac 0.2.68\n", "ablac 0.1.9", "ablac 0.2.68-rc1"]) {
    assert.deepEqual(analysisEnvironment("darwin", version, {}), { ABLA_ANALYSIS_FREEZE: "0" }, version);
  }
});

test("0.2.69 and later, and every other system, keep the freeze", () => {
  for (const version of ["ablac 0.2.69\n", "ablac 0.2.70", "ablac 0.3.0", "ablac 1.0.0"]) {
    assert.deepEqual(analysisEnvironment("darwin", version, {}), {}, version);
  }
  for (const platform of ["linux", "win32"]) assert.deepEqual(analysisEnvironment(platform, "ablac 0.2.68", {}), {}, platform);
});

test("a version that cannot be read is treated as an old compiler on macOS", () => {
  assert.deepEqual(analysisEnvironment("darwin", undefined, {}), { ABLA_ANALYSIS_FREEZE: "0" });
  assert.deepEqual(analysisEnvironment("darwin", "not a version", {}), { ABLA_ANALYSIS_FREEZE: "0" });
});

test("a value the user set is kept", () => {
  assert.deepEqual(analysisEnvironment("darwin", "ablac 0.2.68", { ABLA_ANALYSIS_FREEZE: "1" }), {});
  assert.deepEqual(analysisEnvironment("darwin", "ablac 0.2.68", { ABLA_ANALYSIS_FREEZE: "0" }), {});
});

test("the version is read from the first three numbers", () => {
  assert.deepEqual(parseCompilerVersion("ablac 0.2.68\n"), [0, 2, 68]);
  assert.equal(parseCompilerVersion("ablac"), undefined);
});

// The environment is applied where the compiler is spawned (CompilerClient), so every user of the client gets it, the refactor tests included.
test("the client applies the environment where it spawns", async () => {
  const { readFileSync } = await import("node:fs");
  const client = readFileSync(new URL("../../src/compiler-client.ts", import.meta.url), "utf8");
  assert.ok(client.includes("analysisEnvironment(process.platform, compilerVersionText(executable)"));
  assert.ok(client.includes("...platformEnvironment, ...this.#options.environment"));
});
