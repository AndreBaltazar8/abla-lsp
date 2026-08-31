# Coverage gate

No feature is considered complete merely because an LSP method responds.

| Area | Current status | Required evidence |
| --- | --- | --- |
| Documents | Partial | UTF-8/UTF-16 positions, incremental LSP changes, overlays, close/reopen, and client cancellation are tested; compiler-side preemption remains |
| Diagnostics | Partial | Parser and semantic spans/codes are tested; generated/subparser provenance, related spans, ownership/effect, and IR-boundary diagnostics remain |
| Navigation | Partial | Definitions, declarations, type definitions, references, document/workspace symbols, and highlights are live; implementation relationships remain |
| Assistance | Partial | Scope/import/member completion, hover, signatures, semantic tokens, parameter hints, folding, and selection ranges are live; package/generated completion and completion resolve remain |
| Source actions | Partial | Safe whitespace formatting, import organization, and compiler-validated spelling fixes are live; full formatting and fix-all remain |
| Rename | Advanced | Canonical locals/members/types, atomic bulk swaps, component scoping, collisions, and compiler validation are tested; generated declarations and import aliases need corpus gates |
| Signature/extract/inline | Advanced | Parameter reorder/add/remove, calls, extraction captures, effect-safe inline, promotion, and function/method conversion are transactionally planned and compiler validated |
| Move | Advanced | One/many declarations and types, split/merge aliases, attached line comments, header-safe import repair, dependencies, cycles, preview/apply, and compiler validation are tested; creating a previously nonexistent target and generated declarations remain |
| Migration | Advanced | Interface/declaration generation, ownership repairs, compile-time migration, dead-code proof, and atomic JSON recipes are implemented; dependent recipe stages intentionally require a fresh snapshot |
| Hierarchies | Partial | Incoming/outgoing calls are live; language-level implementation/type relationships need compiler protocol support |
| Operations | Partial | Crash recovery, bounded restart, logs, configuration, npm/VSIX packaging, and multi-OS CI are live; corpus performance and memory budgets remain |
| Editors | Implemented | VS Code bundles the server, uses the TextMate extension as fallback, and exposes multi-cursor rename/move; protocol tests cover editor-independent behavior |

Every semantic feature is tested against the same checked-in Abla corpus used
by the compiler plus focused multi-file and generated-syntax fixtures.

A release is cut only after `npm run validate`, the live compiler refactor
gate on Linux, Intel macOS, and Apple Silicon, the compiler analysis protocol
suite, the compiler's 76-case self-hosted suite, and byte-identical pure
self-rebuild all pass from the release commits.
