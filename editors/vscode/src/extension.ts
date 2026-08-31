import * as vscode from "vscode";
import {
  ExecuteCommandRequest,
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function activeSelections(): Array<{
  readonly uri: string;
  readonly position: { readonly line: number; readonly character: number };
}> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.languageId !== "abla") return [];
  return editor.selections.map((selection) => ({
    uri: editor.document.uri.toString(),
    position: { line: selection.active.line, character: selection.active.character },
  }));
}

async function moveDeclarations(): Promise<void> {
  const active = client;
  const selections = activeSelections();
  if (active === undefined || selections.length === 0) return;
  const files = await vscode.workspace.findFiles("**/*.ab", "**/{.git,build,dist,node_modules}/**");
  const target = await vscode.window.showQuickPick(
    [
      { label: "$(new-file) Create a new Abla file…", create: true as const },
      ...files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        create: false as const,
        uri,
      })),
    ],
    { placeHolder: "Move the selected declarations to…" },
  );
  if (target === undefined) return;
  let targetUri: vscode.Uri;
  if (target.create) {
    const relativePath = await vscode.window.showInputBox({
      title: "Create Abla Move Target",
      prompt: "Path relative to the workspace root",
      placeHolder: "src/new-module.ab",
      validateInput: (value) => {
        if (!value.endsWith(".ab")) return "The target must end in .ab";
        if (value.startsWith("/") || value.split(/[\\/]/u).includes("..")) {
          return "Enter a path inside the workspace";
        }
        return undefined;
      },
    });
    if (relativePath === undefined) return;
    const root = vscode.workspace.getWorkspaceFolder(
      vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.file("/"),
    ) ?? vscode.workspace.workspaceFolders?.[0];
    if (root === undefined) {
      void vscode.window.showErrorMessage("Open an Abla workspace before creating a move target.");
      return;
    }
    targetUri = vscode.Uri.joinPath(root.uri, ...relativePath.split(/[\\/]/u));
  } else targetUri = target.uri;
  await active.sendRequest(ExecuteCommandRequest.type, {
    command: "abla.moveDeclarations",
    arguments: [{
      selections,
      targetUri: targetUri.toString(),
      createTarget: target.create,
      apply: true,
    }],
  });
}

async function bulkRename(): Promise<void> {
  const active = client;
  const editor = vscode.window.activeTextEditor;
  const selections = activeSelections();
  if (active === undefined || editor === undefined || selections.length === 0) return;
  const renames = [];
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    if (selection === undefined) continue;
    const position = editor.selections[index]?.active;
    const word = position === undefined
      ? undefined
      : editor.document.getText(editor.document.getWordRangeAtPosition(position));
    const newName = await vscode.window.showInputBox({
      title: `Rename ${word === undefined || word === "" ? `symbol ${index + 1}` : word}`,
      prompt: "New Abla identifier",
      validateInput: (value) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a valid Abla identifier",
    });
    if (newName === undefined) return;
    renames.push({ ...selection, newName });
  }
  await active.sendRequest(ExecuteCommandRequest.type, {
    command: "abla.renameSymbols",
    arguments: [{ renames, apply: true }],
  });
}

function activeSelection(): {
  readonly uri: string;
  readonly position: { readonly line: number; readonly character: number };
} | undefined {
  return activeSelections()[0];
}

async function executeRefactor(command: string, argument: Record<string, unknown>): Promise<void> {
  await client?.sendRequest(ExecuteCommandRequest.type, {
    command,
    arguments: [{ ...argument, apply: true }],
  });
}

async function changeSignature(): Promise<void> {
  const selection = activeSelection();
  if (selection === undefined) return;
  const raw = await vscode.window.showInputBox({
    title: "Change Abla Function Signature",
    prompt: 'JSON parameters, for example [{"name":"right","source":"right"},{"name":"scale","declaration":"scale: int = 1"}]',
    placeHolder: '[{"name":"value","source":"value"}]',
    validateInput: (value) => {
      try {
        return Array.isArray(JSON.parse(value)) ? undefined : "Enter a JSON array";
      } catch {
        return "Enter a valid JSON array";
      }
    },
  });
  if (raw === undefined) return;
  await executeRefactor("abla.changeSignature", {
    selection,
    parameters: JSON.parse(raw) as unknown[],
  });
}

async function extractFunction(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.languageId !== "abla" || editor.selection.isEmpty) return;
  const name = await vscode.window.showInputBox({
    title: "Extract Abla Function",
    prompt: "Name for the extracted function",
    validateInput: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a valid Abla identifier",
  });
  if (name === undefined) return;
  await executeRefactor("abla.extractFunction", {
    uri: editor.document.uri.toString(),
    range: {
      start: { line: editor.selection.start.line, character: editor.selection.start.character },
      end: { line: editor.selection.end.line, character: editor.selection.end.character },
    },
    name,
  });
}

async function functionToMethod(): Promise<void> {
  const selection = activeSelection();
  if (selection === undefined) return;
  const receiver = await vscode.window.showInputBox({
    title: "Convert Function to Method",
    prompt: "Name of the parameter that should become the receiver",
    validateInput: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a parameter name",
  });
  if (receiver === undefined) return;
  await executeRefactor("abla.functionToMethod", { selection, receiver });
}

async function methodToFunction(): Promise<void> {
  const selection = activeSelection();
  if (selection === undefined) return;
  const receiverName = await vscode.window.showInputBox({
    title: "Convert Method to Function",
    prompt: "Name for the explicit receiver parameter",
    value: "receiver",
    validateInput: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a parameter name",
  });
  if (receiverName === undefined) return;
  await executeRefactor("abla.methodToFunction", { selection, receiverName });
}

async function inlineSymbol(): Promise<void> {
  const selection = activeSelection();
  if (selection !== undefined) await executeRefactor("abla.inlineSymbol", { selection });
}

async function promoteLocal(): Promise<void> {
  const selection = activeSelection();
  if (selection === undefined) return;
  const destination = await vscode.window.showQuickPick([
    { label: "Function parameter", value: "parameter" },
    { label: "Top-level binding", value: "topLevel" },
  ], { placeHolder: "Promote local to…" });
  if (destination !== undefined) await executeRefactor("abla.promoteLocal", { selection, destination: destination.value });
}

async function extractInterface(): Promise<void> {
  const selections = activeSelections();
  if (selections.length === 0) return;
  const name = await vscode.window.showInputBox({
    title: "Extract Interface from Selected Methods",
    prompt: "Interface name",
    validateInput: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a valid Abla identifier",
  });
  if (name !== undefined) await executeRefactor("abla.extractInterface", { selections, name });
}

async function generateDeclaration(): Promise<void> {
  const selection = activeSelection();
  if (selection === undefined) return;
  const kind = await vscode.window.showQuickPick(["function", "class", "value"] as const, {
    placeHolder: "Generate which declaration?",
  });
  if (kind === undefined) return;
  const resultType = kind === "class" ? undefined : await vscode.window.showInputBox({
    title: "Generated Result Type",
    value: "int",
  });
  await executeRefactor("abla.generateDeclaration", {
    uri: selection.uri,
    position: selection.position,
    kind,
    ...(resultType === undefined ? {} : { resultType }),
  });
}

async function repairOwnership(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.languageId !== "abla") return;
  const strategy = await vscode.window.showQuickPick(
    ["move", "borrow", "own", "mutable", "shared", "weak"] as const,
    { placeHolder: "Ownership repair" },
  );
  if (strategy === undefined) return;
  const selected = editor.selection.isEmpty
    ? editor.document.getWordRangeAtPosition(editor.selection.active)
    : editor.selection;
  if (selected === undefined) return;
  await executeRefactor("abla.repairOwnership", {
    uri: editor.document.uri.toString(),
    range: {
      start: { line: selected.start.line, character: selected.start.character },
      end: { line: selected.end.line, character: selected.end.character },
    },
    strategy,
  });
}

async function toggleCompileTime(compileTime: boolean): Promise<void> {
  const selection = activeSelection();
  if (selection !== undefined) await executeRefactor("abla.toggleCompileTime", { selection, compileTime });
}

async function removeDeadCode(): Promise<void> {
  const accepted = await vscode.window.showWarningMessage(
    "Remove compiler-proven unused private-style declarations from this workspace?",
    { modal: true },
    "Preview and Apply",
  );
  if (accepted !== undefined) await executeRefactor("abla.removeDeadCode", {});
}

async function applyRecipe(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Abla refactor recipe": ["json"] },
    openLabel: "Apply Refactor Recipe",
  });
  const uri = selected?.[0];
  if (uri === undefined) return;
  const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as {
    readonly operations?: readonly unknown[];
  };
  await executeRefactor("abla.applyRefactorRecipe", { operations: parsed.operations ?? [] });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("abla");
  const serverPath = configuration.get("server.path", "").trim();
  const compilerPath = configuration.get("compiler.path", "ablac");
  const compilerEnabled = configuration.get("compiler.enabled", true);
  const serverOptions: ServerOptions = serverPath === ""
    ? {
        module: context.asAbsolutePath("dist/server.cjs"),
        transport: TransportKind.ipc,
      }
    : { command: serverPath, args: ["--stdio"] };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "abla" }],
    initializationOptions: {
      compiler: { enabled: compilerEnabled, path: compilerPath },
    },
    synchronize: { configurationSection: "abla" },
  };
  client = new LanguageClient("abla", "Abla Language Server", serverOptions, clientOptions);
  context.subscriptions.push(
    vscode.commands.registerCommand("abla.moveDeclarations", moveDeclarations),
    vscode.commands.registerCommand("abla.moveTypes", moveDeclarations),
    vscode.commands.registerCommand("abla.splitDeclarations", moveDeclarations),
    vscode.commands.registerCommand("abla.mergeDeclarations", moveDeclarations),
    vscode.commands.registerCommand("abla.bulkRename", bulkRename),
    vscode.commands.registerCommand("abla.changeSignature", changeSignature),
    vscode.commands.registerCommand("abla.extractFunction", extractFunction),
    vscode.commands.registerCommand("abla.functionToMethod", functionToMethod),
    vscode.commands.registerCommand("abla.methodToFunction", methodToFunction),
    vscode.commands.registerCommand("abla.inlineSymbol", inlineSymbol),
    vscode.commands.registerCommand("abla.promoteLocal", promoteLocal),
    vscode.commands.registerCommand("abla.extractInterface", extractInterface),
    vscode.commands.registerCommand("abla.generateDeclaration", generateDeclaration),
    vscode.commands.registerCommand("abla.repairOwnership", repairOwnership),
    vscode.commands.registerCommand("abla.makeCompileTime", () => toggleCompileTime(true)),
    vscode.commands.registerCommand("abla.makeRuntime", () => toggleCompileTime(false)),
    vscode.commands.registerCommand("abla.removeDeadCode", removeDeadCode),
    vscode.commands.registerCommand("abla.applyRefactorRecipe", applyRecipe),
  );
  await client.start();
}

export async function deactivate(): Promise<void> {
  const active = client;
  client = undefined;
  await active?.stop();
}
