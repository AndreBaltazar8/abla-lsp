import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { toolPath } from "./executables";
import { ablaGdbArguments, ablaLldbCommands, isRuntimeFrame } from "../../../src/debugger-commands";
import { DapProxy } from "../../../src/dap-proxy";

// Debugging an Abla program: the `abla` debug type builds it as a development build (`ablac build -g --fast`, whose
// DWARF has every function's parameters and locals with their Abla types) and hands the executable to lldb-dap
// (the "LLDB DAP" extension, llvm-vs-code-extensions.lldb-dap), which speaks the Debug Adapter Protocol.

const lldbDapExtension = "llvm-vs-code-extensions.lldb-dap";

export { ablaLldbCommands };

// The lldb-dap executable: the `abla.debug.lldbDapPath` setting, else `lldb-dap` on the PATH, else none.
function lldbDapExecutable(): string | undefined {
  const configured = vscode.workspace.getConfiguration("abla").get<string>("debug.lldbDapPath", "");
  const candidate = toolPath(configured === "" ? "lldb-dap" : configured);
  if (candidate === undefined) return undefined;
  const result = spawnSync(candidate, ["--help"], { encoding: "utf8", cwd: tmpdir() });
  return result.error === undefined && result.status === 0 ? candidate : undefined;
}

// Whether `gdb` exists and has the DAP mode (gdb 14 or newer).
function gdbHasDap(): boolean {
  const gdb = toolPath("gdb");
  if (gdb === undefined) return false;
  const result = spawnSync(gdb, ["--version"], { encoding: "utf8", cwd: tmpdir() });
  return result.status === 0 && /GNU gdb.* (1[4-9]|[2-9][0-9])\./u.test(result.stdout);
}

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
  if (!vscode.workspace.isTrusted) return 1; // building runs the project's compile-time code: only in a trusted workspace
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
    // The debugger: lldb-dap (the "LLDB DAP" extension) with Abla value formatters, else gdb's DAP mode.
    const setting = vscode.workspace.getConfiguration("abla").get<string>("debug.engine", "auto");
    // With an lldb-dap executable the Abla adapter (src/dap-proxy.ts) wraps it and shows arrays and null optionals;
    // with only the LLDB DAP extension its adapter runs as it is.
    const executable_ = lldbDapExecutable();
    const haveLldb = executable_ !== undefined || vscode.extensions.getExtension(lldbDapExtension) !== undefined;
    const engine = setting === "lldb" || (setting === "auto" && haveLldb) ? "lldb" : setting === "gdb" || gdbHasDap() ? "gdb" : "lldb";
    if (engine === "lldb" && !haveLldb) {
      void vscode.window.showErrorMessage(
        `Abla debugging runs the program under lldb-dap: install the "LLDB DAP" extension (${lldbDapExtension}), or use gdb 14 or newer.`);
      return undefined;
    }
    if (attaching) return attachConfiguration(configuration);
    const compilerSetting = vscode.workspace.getConfiguration("abla").get<string>("compiler.path", "ablac");
    const compiler = toolPath(compilerSetting);
    if (compiler === undefined) {
      void vscode.window.showErrorMessage(`Abla debugging: ${compilerSetting} not found (a name is looked up on PATH outside the workspace; set abla.compiler.path to an absolute path).`);
      return undefined;
    }
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
    if (engine === "gdb") {
      // gdb has no Abla value formatters (they would need its Python): frames, breakpoints and stepping.
      return {
        type: "abla-gdb",
        request: "launch",
        name: configuration.name,
        program: executable,
        args: Array.isArray(configuration.args) ? configuration.args : [],
        cwd,
        ...(configuration.env === undefined ? {} : { env: configuration.env }),
      };
    }
    // Our own adapter wraps the lldb-dap executable; else the configuration is resolved again by the LLDB DAP
    // extension's provider (its adapter shows arrays as a pointer).
    return {
      ablaSkipRuntime: true,
      ablaLldbDap: executable_,
      type: executable_ === undefined ? "lldb-dap" : "abla-lldb",
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

/**
 * lldb-dap's stepIn ignores lldb's step-avoid-regexp, so a step that lands in a runtime function (a string
 * concatenation, say) steps out and steps in again until it reaches Abla code, as gdb's `skip` does by itself.
 */
class RuntimeSkipTracker implements vscode.DebugAdapterTracker {
  private phase: "idle" | "out" | "in" = "idle";
  private guard = 0;

  constructor(private readonly session: vscode.DebugSession) {}

  onDidSendMessage(message: { type?: string; event?: string; body?: { reason?: string; threadId?: number } }): void {
    if (message.type !== "event" || message.event !== "stopped") return;
    const threadId = message.body?.threadId;
    if (threadId === undefined) return;
    if (this.phase === "out") {
      this.phase = "in";
      void this.session.customRequest("stepIn", { threadId });
      return;
    }
    if (this.phase === "idle" && message.body?.reason !== "step") return;
    this.phase = "idle";
    void this.session.customRequest("stackTrace", { threadId, levels: 1 }).then((reply: { stackFrames?: Array<{ name?: string }> }) => {
      const name = reply.stackFrames?.[0]?.name ?? "";
      if (isRuntimeFrame(name) && this.guard < 50) {
        this.guard += 1;
        this.phase = "out";
        void this.session.customRequest("stepOut", { threadId });
      } else this.guard = 0;
    });
  }
}

/** The Abla adapter: lldb-dap behind the DAP proxy, as an editor debug adapter. */
class ProxyAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly proxy: DapProxy;

  constructor(executable: string) {
    this.proxy = new DapProxy(executable);
    this.proxy.onMessage((message) => this.emitter.fire(message as unknown as vscode.DebugProtocolMessage));
  }

  handleMessage(message: vscode.DebugProtocolMessage): void { this.proxy.send(message as never); }

  dispose(): void {
    this.proxy.dispose();
    this.emitter.dispose();
  }
}

export function registerDebugging(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("abla", new AblaDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory("abla-gdb", {
      createDebugAdapterDescriptor: () => {
        const gdb = toolPath("gdb");
        return gdb === undefined ? undefined : new vscode.DebugAdapterExecutable(gdb, [...ablaGdbArguments]);
      },
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory("abla-lldb", {
      createDebugAdapterDescriptor: (session) => new vscode.DebugAdapterInlineImplementation(new ProxyAdapter(String(session.configuration.ablaLldbDap))),
    }),
    ...["lldb-dap", "abla-lldb"].map((type) => vscode.debug.registerDebugAdapterTrackerFactory(type, {
      createDebugAdapterTracker: (session) => session.configuration.ablaSkipRuntime === true ? new RuntimeSkipTracker(session) : undefined,
    })),
  );
}
