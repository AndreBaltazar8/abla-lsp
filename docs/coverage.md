# Coverage gate

No feature is considered complete merely because an LSP method responds.

| Area | Required evidence |
| --- | --- |
| Documents | UTF-8/UTF-16 position tests, incremental changes, unsaved overlays, close/reopen, cancellation |
| Diagnostics | Parser, generated/subparser, semantic, ownership, effect, IR-boundary, related spans, stable codes |
| Navigation | Definitions, declarations, types, implementations, references, workspace/document symbols |
| Assistance | Completion and resolve, hover, signatures, semantic tokens, inlay hints, folding, selection ranges |
| Source actions | Formatting, import organization, quick fixes, fix-all, source actions |
| Rename | Prepare checks, locals/members/types/import aliases, workspace edits, collisions, generated syntax |
| Move | One or many declarations, attached comments, imports, visibility, dependencies, cycles, preview/undo |
| Hierarchies | Incoming/outgoing calls and type supertypes/subtypes |
| Operations | Incremental performance, memory bounds, crash recovery, logs, configuration, packaging |
| Editors | VS Code first, protocol-level tests for any compliant editor, TextMate fallback |

Every semantic feature is tested against the same checked-in Abla corpus used
by the compiler plus focused multi-file and generated-syntax fixtures.
