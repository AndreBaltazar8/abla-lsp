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
    files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { placeHolder: "Move the selected declarations to…" },
  );
  if (target === undefined) return;
  await active.sendRequest(ExecuteCommandRequest.type, {
    command: "abla.moveDeclarations",
    arguments: [{ selections, targetUri: target.uri.toString(), apply: true }],
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
    vscode.commands.registerCommand("abla.bulkRename", bulkRename),
  );
  await client.start();
}

export async function deactivate(): Promise<void> {
  const active = client;
  client = undefined;
  await active?.stop();
}
