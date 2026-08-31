# Architecture

## Repository boundary

The language server lives here rather than inside `ablac`.

- `ablac` owns parsing, generated/subparser syntax, name resolution, types,
  ownership, effects, canonical identities, diagnostics, and source spans.
- `abla-lsp` owns LSP/JSON-RPC, document overlays, workspace scheduling,
  capability negotiation, edit construction, refactoring previews, editor
  commands, telemetry-free performance accounting, and packaging.
- `abla-tmlanguage` remains the syntax-highlighting fallback for clients which
  do not support semantic tokens.

The boundary is a persistent `ablac analyze --stdio` service using JSON lines.
Every message carries a schema version and request id. The server sends
workspace roots, document open/change/close overlays, analysis requests,
cancellation notifications, and refactoring validation requests. Protocol 1
currently returns immutable snapshots containing diagnostics, declarations,
canonical symbol ids, references, resolved occurrence types, and exact UTF-8
source spans. Call/type relationships, import metadata, effects, and complete
generated-source provenance will be added only as versioned protocol fields;
the LSP does not infer them as semantic fact.

The compiler protocol is not LSP-shaped. That keeps editor policy out of the
compiler and lets other tools consume the same semantic snapshots.

## Refactoring safety

Edits are constructed from canonical compiler symbol ids, never from textual
name matching. A refactor has three phases:

1. Resolve the requested symbols and build a prospective workspace edit.
2. Ask `ablac` to analyze the complete overlay with that edit applied.
3. Return or apply the edit only when identities, imports, visibility,
   ownership, effects, generated syntax, and diagnostics satisfy the command's
   invariants.

Moving declarations uses compiler-provided canonical declaration ranges and
resolved occurrences. Multiple declarations are moved as one transaction. The
engine preserves the requested order and attached line comments, repairs
relative imports in both directions, rejects cycles locally, and asks the
compiler to reject new diagnostics or changes to symbols in untouched files.

## Degraded mode

The built-in scanner exists only to keep protocol lifecycle, basic symbols,
and conservative navigation available before or without `ablac`. Snapshots are
marked `syntax`; semantic refactors are enabled only where the scanner can
prove a unique top-level binding. Clients can always see the active authority.
