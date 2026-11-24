import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The VS Code extension spawns the executables its settings name (the compiler, an external language server, lldb-dap). A workspace's own
// .vscode/settings.json must not be able to choose them: every such setting is machine-scoped, and the extension declares what it does in
// an untrusted workspace (#1139 programme, untrusted project in an editor).
const manifest = JSON.parse(readFileSync(new URL("../../editors/vscode/package.json", import.meta.url), "utf8")) as {
  capabilities?: { untrustedWorkspaces?: { supported?: unknown; restrictedConfigurations?: string[] } };
  contributes: { configuration: { properties: Record<string, { type: string; scope?: string; description?: string }> } };
};

test("every setting that names an executable is machine-scoped", () => {
  const properties = manifest.contributes.configuration.properties;
  const executables = Object.entries(properties).filter(([name, property]) =>
    /(^|\.)(path|lldbDapPath)$/.test(name) && property.type === "string");
  assert.deepEqual(executables.map(([name]) => name).sort(), ["abla.compiler.path", "abla.debug.lldbDapPath", "abla.server.path"]);
  for (const [name, property] of executables) assert.equal(property.scope, "machine", `${name} can be set by a workspace`);
});

test("the untrusted-workspace declaration is limited and restricts the executable settings", () => {
  const declaration = manifest.capabilities?.untrustedWorkspaces;
  assert.equal(declaration?.supported, "limited");
  assert.deepEqual([...(declaration?.restrictedConfigurations ?? [])].sort(), ["abla.compiler.path", "abla.debug.lldbDapPath", "abla.server.path"]);
});

test("building and testing from the extension check workspace trust", () => {
  const extension = readFileSync(new URL("../../editors/vscode/src/extension.ts", import.meta.url), "utf8");
  const debug = readFileSync(new URL("../../editors/vscode/src/debug.ts", import.meta.url), "utf8");
  assert.ok(extension.includes("vscode.workspace.isTrusted"));
  assert.ok(debug.includes("vscode.workspace.isTrusted"));
});
