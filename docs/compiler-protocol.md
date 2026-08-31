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
- `refactor/validate`: declare optional `createdDocuments`, apply proposed
  offset edits to an isolated overlay, reanalyze, and verify named invariants
  without creating or mutating files on disk;
- `shutdown`: release compiler state and terminate cleanly.

Offsets in this private protocol are UTF-8 byte offsets because they point into
compiler-owned source. `abla-lsp` performs the UTF-8/UTF-16 conversion required
by LSP clients. Snapshot symbol ids are canonical and stable while declaration
identity is unchanged; request-local handles are never sent across this
boundary.

`createdDocuments` is an additive request field containing `{ uri, text }`
objects. A created URI must not already exist in the analyzed overlay. Edits to
unknown URIs remain invalid unless the URI is declared in this array. This lets
the server validate one atomic LSP `CreateFile` plus `TextDocumentEdit` without
weakening the rule that every edited source belongs to the prospective snapshot.

The server treats compiler crashes, malformed responses, stale revisions, and
resource-limit failures as recoverable. It keeps syntax-mode navigation alive,
restarts the child with bounded backoff, and republishes semantic diagnostics
only after a complete new snapshot arrives.
