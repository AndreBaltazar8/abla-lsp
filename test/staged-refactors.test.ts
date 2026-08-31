import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompilerValidateEditParams,
  CompilerWorkspaceSnapshot,
} from "../src/compiler-protocol.js";
import { applyStagedRecipe } from "../src/staged-refactors.js";
import { SyntaxAnalyzer } from "../src/source.js";

function snapshot(
  revision: string,
  documents: ReadonlyMap<string, string>,
): CompilerWorkspaceSnapshot {
  const analyzer = new SyntaxAnalyzer();
  const analyses = [...documents].map(([uri, text]) => analyzer.analyze(uri, 1, text));
  const identities = new Map<string, string>();
  for (const analysis of analyses) {
    for (const [index, symbol] of analysis.symbols.entries()) {
      identities.set(symbol.id, `${revision}:${analysis.uri}:${index}`);
    }
  }
  const topLevel = new Map<string, string[]>();
  for (const analysis of analyses) {
    for (const symbol of analysis.symbols.filter((candidate) => candidate.topLevel)) {
      const values = topLevel.get(symbol.name) ?? [];
      values.push(identities.get(symbol.id) ?? symbol.id);
      topLevel.set(symbol.name, values);
    }
  }
  return {
    revision,
    documents: analyses.map((analysis) => ({
      uri: analysis.uri,
      version: analysis.version,
      text: analysis.text,
      symbols: analysis.symbols.map((symbol) => ({
        ...symbol,
        id: identities.get(symbol.id) ?? symbol.id,
        ...(symbol.containerId === undefined
          ? {}
          : { containerId: identities.get(symbol.containerId) ?? symbol.containerId }),
      })),
      occurrences: analysis.occurrences.map((occurrence) => {
        const local = analysis.symbols.find((symbol) => symbol.name === occurrence.name);
        const global = topLevel.get(occurrence.name);
        const declarationId = local === undefined
          ? (global?.length === 1 ? global[0] : undefined)
          : identities.get(local.id);
        return {
          ...occurrence,
          ...(declarationId === undefined ? {} : { declarationId }),
        };
      }),
      diagnostics: analysis.diagnostics,
    })),
  };
}

class ProspectiveValidator {
  readonly #baseline: CompilerWorkspaceSnapshot;
  #revision = 0;

  constructor(baseline: CompilerWorkspaceSnapshot) {
    this.#baseline = baseline;
  }

  async validate(params: CompilerValidateEditParams) {
    assert.equal(params.baseRevision, this.#baseline.revision);
    const texts = new Map(this.#baseline.documents.map((document) => [document.uri, document.text]));
    for (const created of params.createdDocuments ?? []) texts.set(created.uri, created.text);
    for (const edit of [...params.edits].sort((left, right) => right.start - left.start)) {
      const text = texts.get(edit.uri);
      assert.notEqual(text, undefined);
      texts.set(edit.uri, `${text?.slice(0, edit.start)}${edit.newText}${text?.slice(edit.end)}`);
    }
    this.#revision += 1;
    return { valid: true, snapshot: snapshot(`prospective-${this.#revision}`, texts) };
  }
}

test("staged recipes resolve fresh compiler identities after creating a file", async () => {
  const sourceUri = "file:///workspace/main.ab";
  const targetUri = "file:///workspace/answers.ab";
  const baseline = snapshot("baseline", new Map([
    [sourceUri, "fun answer: int = 42\nfun main: int = answer()\n"],
  ]));
  const result = await applyStagedRecipe(baseline, [
    {
      kind: "move",
      request: {
        symbols: [{ uri: sourceUri, name: "answer" }],
        targetUri,
        createTarget: true,
      },
    },
    {
      kind: "rename",
      request: {
        symbol: { uri: targetUri, name: "answer" },
        newName: "meaning",
      },
    },
  ], new ProspectiveValidator(baseline));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.edit.documentChanges?.[0], { kind: "create", uri: targetUri });
  const textChanges = result.edit.documentChanges?.filter(
    (change) => "textDocument" in change,
  ) ?? [];
  const source = textChanges.find((change) => change.textDocument.uri === sourceUri)?.edits[0];
  const target = textChanges.find((change) => change.textDocument.uri === targetUri)?.edits[0];
  assert.match(source !== undefined && "newText" in source ? source.newText : "", /meaning\(\)/u);
  assert.match(target !== undefined && "newText" in target ? target.newText : "", /fun meaning: int = 42/u);
});
