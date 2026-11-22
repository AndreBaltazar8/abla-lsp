import * as vscode from "vscode";

// Debugging an Abla program: the `abla` debug type builds it as a development build (`ablac build -g --fast`, whose
// DWARF has every function's parameters and locals with their Abla types) and hands the executable to lldb-dap
// (the "LLDB DAP" extension, llvm-vs-code-extensions.lldb-dap), which speaks the Debug Adapter Protocol.

const lldbDapExtension = "llvm-vs-code-extensions.lldb-dap";

// lldb summary strings (no Python): a string shows its text, an array its length.
export const ablaLldbCommands = [
  'type summary add --summary-string "${var.data%s}" string',
  'type summary add --summary-string "length ${var.length}" -x "^array<"',
];

// The directory and the name without `.ab` of a path (either separator).
function directoryOf(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return slash > 0 ? file.slice(0, slash) : ".";
}

function stemOf(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  return name.endsWith(".ab") ? name.slice(0, -3) : name;
}

// Runs the build as a task (its output in a terminal) and gives its exit code.
async function build(compiler: string, args: string[], cwd: string): Promise<number> {
  const task = new vscode.Task(
    { type: "abla-debug-build" },
    vscode.TaskScope.Workspace,
    "build for debugging",
    "Abla",
    new vscode.ProcessExecution(compiler, args, { cwd }),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
  const ended = new Promise<number>((resolve) => {
    const listener = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task === task || event.execution.task.name === task.name) {
        listener.dispose();
        resolve(event.exitCode ?? 1);
      }
    });
  });
  await vscode.tasks.executeTask(task);
  return ended;
}

/**
 * Attach to a running Abla program (by `pid`, or `waitFor` its name). `program` is the executable built with
 * `ablac build -g`, so lldb has the Abla types; it is not built here.
 */
export function attachConfiguration(configuration: vscode.DebugConfiguration): vscode.DebugConfiguration | undefined {
  const pid = configuration.pid;
  const waitFor = configuration.waitFor === true;
  if (pid === undefined && !waitFor) {
    void vscode.window.showErrorMessage("Abla debugging (attach): set `pid`, or `waitFor` with `program` (the executable to wait for).");
    return undefined;
  }
  return {
    type: "lldb-dap",
    request: "attach",
    name: configuration.name,
    ...(typeof configuration.program === "string" && configuration.program !== "" ? { program: configuration.program } : {}),
    ...(pid === undefined ? {} : { pid }),
    ...(waitFor ? { waitFor: true } : {}),
    initCommands: [...ablaLldbCommands, ...(Array.isArray(configuration.initCommands) ? configuration.initCommands : [])],
  };
}

export class AblaDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      { type: "abla", request: "launch", name: "Debug Abla program", program: "${file}" },
      { type: "abla", request: "attach", name: "Attach to Abla program", program: "${workspaceFolder}/build/debug/main", waitFor: true },
    ];
  }

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // F5 without a launch.json: the active Abla file.
    if (!configuration.type && !configuration.request && !configuration.name) {
      const document = vscode.window.activeTextEditor?.document;
      if (document?.languageId !== "abla") return undefined;
      configuration = { type: "abla", request: "launch", name: "Debug Abla program", program: document.fileName };
    }
    const attaching = configuration.request === "attach";
    const program = typeof configuration.program === "string" ? configuration.program : "";
    if (program === "" && !attaching) {
      void vscode.window.showErrorMessage("Abla debugging: set `program` to a .ab file or a project directory.");
      return undefined;
    }
    if (vscode.extensions.getExtension(lldbDapExtension) === undefined) {
      void vscode.window.showErrorMessage(
        `Abla debugging runs the program under lldb-dap: install the "LLDB DAP" extension (${lldbDapExtension}).`);
      return undefined;
    }
    if (attaching) return attachConfiguration(configuration);
    const compiler = vscode.workspace.getConfiguration("abla").get<string>("compiler.path", "ablac");
    const cwd = typeof configuration.cwd === "string" ? configuration.cwd
      : folder?.uri.fsPath ?? directoryOf(program);
    const executable = typeof configuration.output === "string" ? configuration.output
      : `${cwd}/build/debug/${stemOf(program)}`;
    const target = program.endsWith(".ab") ? [program] : ["--project", program];
    const status = await build(compiler, ["build", ...target, "-o", executable, "-g", "--fast"], cwd);
    if (status !== 0) {
      void vscode.window.showErrorMessage("Abla debugging: the build failed (see its terminal).");
      return undefined;
    }
    // A configuration of another type is resolved again by that type's provider: lldb-dap's.
    return {
      type: "lldb-dap",
      request: "launch",
      name: configuration.name,
      program: executable,
      args: Array.isArray(configuration.args) ? configuration.args : [],
      cwd,
      env: configuration.env,
      stopOnEntry: configuration.stopOnEntry === true,
      initCommands: [...ablaLldbCommands, ...(Array.isArray(configuration.initCommands) ? configuration.initCommands : [])],
    };
  }
}

export function registerDebugging(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("abla", new AblaDebugConfigurationProvider()),
  );
}
