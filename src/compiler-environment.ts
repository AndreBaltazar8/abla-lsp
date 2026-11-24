import { spawnSync } from "node:child_process";

/** The version in the output of `ablac --version` ("ablac 0.2.68"), as [major, minor, patch], or undefined when there is none. */
export function parseCompilerVersion(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = version[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * The environment `ablac analyze --stdio` is started with, besides the editor's own. The analysis service freezes what it has analyzed so the next
 * edit reuses it (ABLA_ANALYSIS_FREEZE); on macOS, ablac 0.2.62 to 0.2.68 had no mprotect translation and faulted (SIGBUS) at the first freeze, so for a
 * compiler older than 0.2.69, or one whose version cannot be read, the freeze is switched off (the analysis is a little slower, nothing else changes).
 * A value the user set is kept.
 */
export function analysisEnvironment(
  platform: string,
  versionText: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (platform !== "darwin" || environment.ABLA_ANALYSIS_FREEZE !== undefined) return {};
  const version = versionText === undefined ? undefined : parseCompilerVersion(versionText);
  if (version !== undefined && atLeast(version, [0, 2, 69])) return {};
  return { ABLA_ANALYSIS_FREEZE: "0" };
}

/** The output of `executable --version`, or undefined when it cannot be run. Only a compiler on macOS needs it. */
export function compilerVersionText(executable: string): string | undefined {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 });
  return result.error === undefined && result.status === 0 ? result.stdout : undefined;
}
