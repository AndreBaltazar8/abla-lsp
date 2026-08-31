# Compiler analysis protocol

Protocol version 1 is JSON Lines over a private child process. It is not LSP
and is never exposed to editors directly. Each line is one UTF-8 JSON object.

Requests carry `schema`, numeric `id`, `method`, and `params`. Responses carry
the same `schema` and `id`, plus exactly one of `result` or `error`. A `cancel`
notification names the request id to stop. Unknown fields are forward
compatible; an unsupported schema or method is an explicit error.

The initial methods are:

- `initialize`: negotiate compiler/protocol versions, workspace roots, and
  capabilities;
- `document/open`, `document/change`, and `document/close`: maintain complete
  unsaved source overlays with monotonically increasing document versions;
- `analyze`: return an immutable workspace revision with diagnostics, symbols,
  references, types, imports, calls, and source provenance;
- `refactor/validate`: apply proposed offset edits to an isolated overlay,
  reanalyze, and verify named invariants without mutating disk;
- `shutdown`: release compiler state and terminate cleanly.

Offsets in this private protocol are UTF-8 byte offsets because they point into
compiler-owned source. `abla-lsp` performs the UTF-8/UTF-16 conversion required
by LSP clients. Snapshot symbol ids are canonical and stable while declaration
identity is unchanged; request-local handles are never sent across this
boundary.

The server treats compiler crashes, malformed responses, stale revisions, and
resource-limit failures as recoverable. It keeps syntax-mode navigation alive,
restarts the child with bounded backoff, and republishes semantic diagnostics
only after a complete new snapshot arrives.
