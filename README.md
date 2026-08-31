# Abla Language Server

`abla-lsp` is the editor-independent language server and transactional
refactoring engine for Abla. It is a separate project because editor protocol,
packaging, and UX evolve independently; semantic truth remains in `ablac`
through the versioned `ablac analyze --stdio` protocol.

The current server provides compiler diagnostics for saved files and unsaved
overlays, canonical definitions/declarations/type definitions/references,
document and workspace symbols, hover and signatures, scope/import-aware and
typed-member completion, semantic tokens, compiler-resolved parameter inlay
hints, document highlights, call hierarchy, folding and selection ranges,
safe whitespace formatting, import organization, and import links. If the
compiler is unavailable it restarts with bounded backoff and keeps a clearly
labelled, conservative syntax mode available.

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

## Development

Node.js 20 or newer and an `ablac` with analysis protocol version 1 are
required for semantic features.

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
