import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

// Where the editor's tools (ablac, the server, lldb-dap, gdb) come from. A bare name is looked up here rather than left to the
// operating system: Windows (libuv's search_path, CreateProcess) tries the current directory before PATH, and an editor's
// server runs with the workspace as its current directory, so a project could ship its own `ablac.exe` and have it run when
// the folder is opened. Only absolute PATH entries count (an empty or relative one names the current directory too), and a
// match inside a workspace folder is passed over. A path the user configured is used as it is when absolute; a relative one,
// which would also be read against the current directory, is refused.

export interface ExecutableSearch {
  /** The platform whose rules apply (process.platform by default). */
  readonly platform?: NodeJS.Platform;
  /** The environment whose PATH is searched (process.env by default). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Workspace folders: a PATH search never returns a file in one of them. */
  readonly workspaceRoots?: readonly string[];
}

/** The absolute path `command` runs, or undefined when there is none that may be run (see above). */
export function resolveExecutable(command: string, search: ExecutableSearch = {}): string | undefined {
  const platform = search.platform ?? process.platform;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const name = command.trim();
  if (name === "") return undefined;
  if (paths.isAbsolute(name)) return candidates(name, windows).find((file) => runnable(file, windows));
  if (name.includes("/") || (windows && name.includes("\\"))) return undefined;
  const roots = (search.workspaceRoots ?? []).map((root) => canonical(root, paths));
  for (const entry of pathEntries(search.environment ?? process.env, windows)) {
    if (!paths.isAbsolute(entry)) continue;
    for (const file of candidates(joined(entry, name, windows), windows)) {
      if (!runnable(file, windows)) continue;
      const real = canonical(file, paths);
      if (roots.some((root) => inside(root, real, paths))) continue;
      return file;
    }
  }
  return undefined;
}

// The PATH entries in order: on Windows the variable's name has any case (the last of several, as an override spread after
// process.env's `Path` is) and an entry may be quoted.
function pathEntries(environment: Readonly<Record<string, string | undefined>>, windows: boolean): string[] {
  const key = windows ? Object.keys(environment).filter((k) => k.toUpperCase() === "PATH").pop() : "PATH";
  const value = key === undefined ? undefined : environment[key];
  if (value === undefined) return [];
  return value.split(windows ? ";" : ":").map((entry) => windows ? entry.trim().replace(/^"(.*)"$/u, "$1") : entry);
}

// `name` in the directory `entry`, with the separator the entry already uses (Windows takes either).
function joined(entry: string, name: string, windows: boolean): string {
  const separator = windows && entry.includes("\\") ? "\\" : "/";
  return entry.replace(windows ? /[\\/]+$/u : /\/+$/u, "") + separator + name;
}

// The files a name stands for: on Windows the name itself when it has an extension, then with .com and .exe appended (what
// CreateProcess can start; a .bat or .cmd would need a shell).
function candidates(file: string, windows: boolean): string[] {
  if (!windows) return [file];
  const extension = path.win32.extname(path.win32.basename(file));
  return [...(extension === "" ? [] : [file]), `${file}.com`, `${file}.exe`];
}

function runnable(file: string, windows: boolean): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (!windows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The path with symbolic links resolved where it exists (a PATH entry that links into a workspace is inside it).
function canonical(file: string, paths: typeof path.posix): string {
  let resolved = file;
  try { resolved = realpathSync.native(file); } catch { /* compared as written */ }
  return paths.resolve(resolved);
}

// Whether `file` is `root` or under it (path.win32.relative compares without case, as Windows does).
function inside(root: string, file: string, paths: typeof path.posix): boolean {
  const relative = paths.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
}
