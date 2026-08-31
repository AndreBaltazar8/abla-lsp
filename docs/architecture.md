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
workspace roots, manifest state, document open/change/close overlays, analysis
requests, cancellation, and refactoring validation requests. The compiler
returns immutable snapshots containing diagnostics, declarations, canonical
symbol ids, references, types, call edges, effects, imports, generated-source
provenance, and exact UTF-8 source spans.

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

Moving declarations uses compiler-provided full declaration ranges and
dependency edges. Multiple declarations are moved as one transaction. The
engine preserves source order and attached comments, rejects partial generated
declarations, repairs imports in both directions, and refuses a result with a
new collision, import cycle, or inaccessible dependency.

## Degraded mode

The built-in scanner exists only to keep protocol lifecycle, basic symbols,
and conservative navigation available before or without `ablac`. Snapshots are
marked `syntax`; semantic refactors are enabled only where the scanner can
prove a unique top-level binding. Clients can always see the active authority.
