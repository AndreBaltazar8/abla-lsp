import * as vscode from "vscode";
import { resolveExecutable } from "../../../src/executable-path";

// The absolute path of a tool the extension runs (a setting's value or a bare name such as `ablac`), found the way
// src/executable-path.ts says: never from the workspace's folders nor the current directory. Undefined when there is none.
export function toolPath(command: string): string | undefined {
  return resolveExecutable(command, { workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath) });
}
