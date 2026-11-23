# Abla Language Server

`abla-lsp` is the editor-independent language server and transactional
refactoring engine for Abla. It is a separate project because editor protocol,
packaging, and UX evolve independently; semantic truth remains in `ablac`
through the versioned `ablac analyze --stdio` protocol.

The current server provides compiler diagnostics for saved files and unsaved
overlays, canonical definitions/declarations/type definitions/references,
document and workspace symbols, hover and signatures, scope/import-aware and
typed-member completion, semantic tokens, compiler-resolved parameter and inferred-type inlay
hints (`abla.inlayHints.types`), document highlights, call hierarchy, folding and selection ranges,
safe whitespace formatting, import organization, and import links. If the
compiler is unavailable it restarts with bounded backoff and keeps a clearly
labelled, conservative syntax mode available.

With a compiler that exports documentation metadata, hover shows the exact
source signature and doc comment, including imported standard-library symbols.
Completion items include doc comments, and signature help uses the compiler's
resolved call with individual parameter labels and documentation. Document a
parameter with an adjacent `/** ... */` comment or `//` comment lines before
its declaration. Older graph compilers retain signature help without parameter
documentation.

The transactional refactoring layer includes:

- normal and multi-cursor bulk rename use canonical compiler identities and
  validate the complete prospective overlay before returning an edit;
- one or many top-level declarations can move to an existing or newly created file in one edit,
  preserving attached comments, repairing imports in both directions, and
  rejecting collisions, cycles, or new compiler diagnostics;
- change signature, extract function/method, inline, function-to-method and
  method-to-function conversions, local/constant introduction, binding-kind
  conversion, local promotion, and interface extraction;
- declaration generation, compiler-checked ownership repairs, compile-time
  migration, proven dead-code removal, type/module split and merge aliases;
- JSON refactor recipes combine independent operations, while staged recipes
  validate dependent operations against fresh prospective compiler identities;
  both return one previewable, compiler-validated transaction.

See [docs/refactors.md](docs/refactors.md) for request schemas and precise
safety boundaries.

See [graph-aware analysis](docs/compiler-graph.md) for capability negotiation,
no-evaluation editor policy, positional queries and incomplete-refactor limits.

Refactorings also appear as code actions: `refactor.extract.function` and `refactor.extract.variable` on a selection,
`refactor.inline` and `refactor.rewrite.binding` (val/var) at a local or top-level function. The action carries only its
command; the compiler-validated edit is computed when it is chosen (`codeAction/resolve`).

`source.fixAll` (VS Code: `editor.codeActionsOnSave` `source.fixAll`) applies, in one compiler-validated edit, every
diagnostic whose single compiler fix adds a missing import or removes an unused one. Did-you-mean replacements and
unused-local fixes stay explicit quick fixes.

## Headless refactoring: abla-refactor

`abla-refactor` drives the transactional engine from the command line (agents, scripts, CI): it starts the
server, asks for the same compiler-validated edit an editor gets, and prints a unified diff; `--apply` writes
every file atomically (temporary siblings first, then renames). Exit status: 0 done, 1 refused by the refactoring
or the compiler validation, 2 usage, 3 server or compiler unavailable.

```sh
abla-refactor rename src/parser.ab#bootstrapCanonicalDeclarationSourceName bootstrapCanonicalDeclarationBaseName --entry src/orc_main.ab
abla-refactor rename src/parser.ab:3910:5 newName --entry src/orc_main.ab --apply
abla-refactor inline file.ab:12:9
abla-refactor extract file.ab:20:5-24:6 helper
abla-refactor move a.ab#f a.ab#g --to b.ab --create
abla-refactor recipe recipe.json [--staged]
abla-refactor command abla.changeSignature args.json
```

A target is `file:line:column` (1-based) or `file#name` / `file#Container.name`. The workspace root is the nearest
`abla.toml` above the file (`--root`); a package whose `abla.toml` names no entry needs `--entry <file>`
(ablac's own `src/` does). The compiler is `--compiler`, then `ABLA_COMPILER`, then `ablac`. A rename does not
touch comments or strings that mention the name. A whole-compiler rename takes about 30 s.

## Unused code

The compiler's warnings arrive greyed out (the `unnecessary` tag) with quick fixes. Unused imports are on
(`compiler.unusedImports`); `compiler.unusedLocals`, `compiler.unusedParameters` and
`compiler.unusedDeclarations` are off until set (they need an `ablac` that has the flags).
`compiler.jsonConstruction` is also off by default. With a compiler supporting
`--warn-json-construction`, it suggests `$json` or `$jsonw` for hand-built JSON
and offers a rewrite when the compiler can preserve the result and output bytes.
The VS Code setting is `abla.compiler.jsonConstruction`; changing it restarts the server.
`compiler.regexConstruction` (VS Code `abla.compiler.regexConstruction`, off by default) does the same for
`regexCompile("literal")`: `W_REGEX_CONSTRUCTION` suggests `$regex`, with an edit for the exact `.regex` form.
It needs a compiler with `--warn-regex-construction`.

| Warning | Quick fixes |
| --- | --- |
| `W_UNUSED_IMPORT` | Remove unused import |
| `W_UNUSED_LOCAL` | Rename `x` to `_x`; Remove unused `x` (a call in its initializer stays: "keep its initializer") |
| `W_UNUSED_PARAMETER` | Rename `x` to `_x`; Remove unused parameter `x` and its arguments (the signature refactoring, over every call) |
| `W_UNUSED_DECLARATION` | Delete unused `name` (function or method, with the comment above it); a constructor field has no fix |

The removals are compiler-validated like the other refactorings, and a client that supports change annotations
shows each one for review before it applies (`needsConfirmation`).

## Development

Node.js 20 or newer and Abla 0.2.46 or newer with analysis protocol version 1
are required for the complete semantic and new-file refactor feature set.

```sh
npm ci
npm run validate
ABLA_COMPILER=/path/to/ablac node dist/src/main.js --stdio
```

`npm run validate` builds and tests the protocol server, creates a dry-run npm
package, builds the bundled VS Code client, and produces a VSIX under
`editors/vscode/`. The VSIX contains the server; only `ablac` is external.

## Editor commands

The VS Code extension adds:

- **Abla: Rename Symbols at All Cursors**
- **Abla: Move Selected Declarations to File**
- signature change, extraction, inline, function/method conversion, promotion,
  introduce local/constant, binding conversion, interface/declaration
  generation, ownership repair, compile-time migration, dead-code removal,
  type split/merge, and same-snapshot/staged recipe commands.

Any LSP client can call `workspace/executeCommand` directly:

```json
{
  "command": "abla.renameSymbols",
  "arguments": [{
    "renames": [{
      "uri": "file:///project/src/main.ab",
      "position": { "line": 4, "character": 8 },
      "newName": "updatedName"
    }]
  }]
}
```

```json
{
  "command": "abla.moveDeclarations",
  "arguments": [{
    "selections": [{
      "uri": "file:///project/src/main.ab",
      "position": { "line": 4, "character": 8 }
    }],
    "targetUri": "file:///project/src/helpers.ab",
    "createTarget": true
  }]
}
```

Set `apply: true` when the server should submit the validated workspace edit to
the client; otherwise the edit is returned for preview.

## Coverage status

The remaining production gates are compiler provenance for all generated and
subparser diagnostics, implementation and type hierarchies, complete package
and generated-symbol completion visibility, quick-fix/fix-all actions, and
corpus-level performance/memory validation. They are intentionally not claimed
as complete yet. See [docs/coverage.md](docs/coverage.md) and
[docs/architecture.md](docs/architecture.md).
