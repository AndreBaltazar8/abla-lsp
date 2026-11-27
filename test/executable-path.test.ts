import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompilerClient } from "../src/compiler-client.js";
import { resolveExecutable } from "../src/executable-path.js";

// A project must not choose the tools the editor runs (#1139 programme, untrusted project in an editor): the server runs with the
// workspace as its current directory, and Windows looks there first for a bare name. src/executable-path.ts finds `ablac` (and the
// other tools) itself: absolute PATH entries only, never a file in a workspace folder. These tests plant tools in a workspace and in
// the current directory and check they are never chosen. Windows' rules are checked here with win32 paths over this file system;
// nothing in them runs on Windows.

// The POSIX rules over this file system: a Windows runner (CI) checks the Windows rules below on real Windows paths instead.
const posixOnly = { skip: process.platform === "win32" ? "POSIX rules on a POSIX file system" : false };

function scratch(): string { return mkdtempSync(path.join(os.tmpdir(), "abla-exec-")); }

function tool(directory: string, name: string, body = "#!/bin/sh\nexit 0\n"): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function inDirectory<T>(directory: string, body: () => T): T {
  const previous = process.cwd();
  process.chdir(directory);
  try { return body(); } finally { process.chdir(previous); }
}

test("a bare name is found only in absolute PATH entries, never the current directory", posixOnly, () => {
  const root = scratch();
  try {
    const here = path.join(root, "here");
    tool(here, "ablac");
    tool(path.join(here, "rel"), "ablac");
    const installed = tool(path.join(root, "bin"), "ablac");
    const found = inDirectory(here, () => resolveExecutable("ablac", { platform: "linux", environment: { PATH: `:.:rel:${path.join(root, "bin")}` } }));
    assert.equal(found, installed);
    assert.equal(inDirectory(here, () => resolveExecutable("ablac", { platform: "linux", environment: { PATH: ":.:rel" } })), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a PATH entry inside a workspace folder is passed over, also through a symbolic link", posixOnly, () => {
  const root = scratch();
  try {
    const workspace = path.join(root, "workspace");
    tool(path.join(workspace, "bin"), "ablac");
    const installed = tool(path.join(root, "bin"), "ablac");
    const link = path.join(root, "link");
    symlinkSync(path.join(workspace, "bin"), link);
    const search = (PATH: string) => resolveExecutable("ablac", { platform: "linux", environment: { PATH }, workspaceRoots: [workspace] });
    assert.equal(search(`${path.join(workspace, "bin")}:${path.join(root, "bin")}`), installed);
    assert.equal(search(`${link}:${path.join(root, "bin")}`), installed);
    assert.equal(search(path.join(workspace, "bin")), undefined);
    assert.equal(search(link), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows rules: .com then .exe, only from absolute entries outside the workspace, never the current directory", () => {
  const root = scratch();
  try {
    const workspace = path.join(root, "Workspace");
    for (const name of ["ablac", "ablac.com", "ablac.exe"]) tool(workspace, name);
    tool(path.join(workspace, "tools"), "ablac.exe");
    const installed = path.join(root, "bin");
    tool(installed, "ablac.exe");
    tool(installed, "ablac");
    const search = (Path: string, roots = [workspace]) => inDirectory(workspace, () =>
      resolveExecutable("ablac", { platform: "win32", environment: { Path }, workspaceRoots: roots }));
    assert.equal(search(`;.;tools;${workspace};"${installed}"`), path.join(installed, "ablac.exe"));
    assert.equal(search(`;.;tools;${workspace}`), undefined);
    tool(installed, "ablac.com");
    assert.equal(search(`"${installed}"`), path.join(installed, "ablac.com"));
    assert.equal(inDirectory(workspace, () => resolveExecutable("ablac.exe", { platform: "win32", environment: { Path: `.;${installed}` }, workspaceRoots: [workspace] })),
      path.join(installed, "ablac.exe"));
    // An override's PATH wins over the inherited Path.
    assert.equal(inDirectory(workspace, () => resolveExecutable("ablac", { platform: "win32", environment: { Path: workspace, PATH: `"${installed}"` }, workspaceRoots: [] })),
      path.join(installed, "ablac.com"));
    // A workspace folder named in another case is the same folder on Windows.
    assert.equal(search(workspace, [workspace.toUpperCase()]), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a configured path is used when absolute and refused when relative", posixOnly, () => {
  const root = scratch();
  try {
    const workspace = path.join(root, "workspace");
    const chosen = tool(workspace, "ablac");
    const search = { platform: "linux" as const, environment: { PATH: "" }, workspaceRoots: [workspace] };
    // The user's own setting (machine-scoped: a workspace cannot set it) may name any absolute file.
    assert.equal(resolveExecutable(chosen, search), chosen);
    assert.equal(inDirectory(workspace, () => resolveExecutable("./ablac", search)), undefined);
    assert.equal(inDirectory(root, () => resolveExecutable("workspace/ablac", search)), undefined);
    assert.equal(resolveExecutable(path.join(workspace, "missing"), search), undefined);
    // Not looked up on PATH either: a relative path is the current directory's.
    assert.equal(resolveExecutable("workspace/ablac", { platform: "linux", environment: { PATH: root } }), undefined);
    assert.equal(resolveExecutable("  ", search), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the analysis client does not run an ablac the workspace holds", async () => {
  const root = scratch();
  try {
    const workspace = path.join(root, "workspace");
    const canary = path.join(root, "canary");
    tool(workspace, "ablac", `#!/bin/sh\ntouch ${canary}\nexit 1\n`);
    const client = new CompilerClient({ executable: "ablac", environment: { PATH: `${workspace}:.` }, workspaceRoots: [workspace] });
    await assert.rejects(inDirectory(workspace, () => client.start({ workspaceRoots: [workspace], clientName: "test", clientVersion: "1" })), /not found/u);
    await client.stop().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(canary), false, "the workspace's ablac ran");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no spawn in the server, the CLI or the extension names its program as a literal", () => {
  const sources = [
    ...readdirSync(new URL("../../src/", import.meta.url)).map((name) => new URL(`../../src/${name}`, import.meta.url)),
    ...readdirSync(new URL("../../editors/vscode/src/", import.meta.url)).map((name) => new URL(`../../editors/vscode/src/${name}`, import.meta.url)),
  ].filter((url) => url.pathname.endsWith(".ts"));
  assert.ok(sources.length > 10);
  for (const url of sources) {
    const text = readFileSync(url, "utf8");
    const literal = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|DebugAdapterExecutable|ProcessExecution|ShellExecution)\(\s*["'`]/u.exec(text);
    assert.equal(literal, null, `${url.pathname}: ${literal?.[0]} (resolve it with src/executable-path.ts)`);
  }
});
