import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Connection } from "vscode-languageserver/node";
import { WorkspaceIndex } from "./index.js";

const ignoredDirectories = new Set([
  ".git",
  ".abla-cache",
  "build",
  "dist",
  "node_modules",
]);

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0 && result.length < 20_000) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".ab")) result.push(candidate);
    }
  }
  return result.sort();
}

export async function indexWorkspace(
  connection: Connection,
  index: WorkspaceIndex,
  roots: readonly string[],
): Promise<void> {
  let files = 0;
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      try {
        const text = await fs.readFile(file, "utf8");
        index.upsert(pathToFileURL(file).toString(), 0, text);
        files += 1;
      } catch {
        // A concurrently removed file is simply absent from this snapshot.
      }
    }
  }
  connection.console.info(`indexed ${files} Abla source file(s) in syntax mode`);
}
