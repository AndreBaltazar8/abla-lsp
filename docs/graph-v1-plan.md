# Graph-v1 client integration

Base: abla-lsp `df790cc`; compiler contract `a476110c` plus projections merged in `6c69d56c`.
The standalone server stays in this repository. No editor protocol or Node
runtime moves into ablac, and this work does not reformat either repository.

## Negotiation and compatibility

Keep schema/protocol version 1. The server first initializes with
`analysisMode: "graph-v1"`. Old compilers that ignore this extra field return
legacy capabilities; keep their existing snapshot/navigation path. If a compiler
explicitly rejects the mode, restart a clean child and initialize without it.
Do not downgrade on arbitrary errors or crashes. No version-string heuristic.

The low-level `CompilerClient.start` remains an explicit protocol call, so
existing legacy tests/consumers can continue to initialize without a mode. The
server's connection negotiation opts in. Graph sessions require the graph and
no-evaluation capabilities; positional requests additionally require
`analysis-queries-v1`. A graph compiler without queries uses graph snapshots.

## Source audit and required changes

- `normalizeCompilerSnapshot` currently drops every top-level field except
  revision/documents. Preserve `analysisMode`, `entry`, `complete`, `pending`
  and `issues`, including correct byte-to-UTF-16 conversion of pending spans.
- `main.ts` navigation handlers synchronously search the occurrence dump.
  Add asynchronous definition/hover/references calls with UTF-8 offsets and
  revision checks. Normalize returned ranges against source from that same
  revision; never convert with stale target text. Hover retains signatures,
  type and compiler provenance. References honor `includeDeclaration`.
- Compiler follow-up `53b0c6b4` adds `analysis-fields-v1`: background refresh
  requests `fields: ["diagnostics", "symbols"]`. Identity/text and complete/pending
  metadata remain; omitted occurrences mean unavailable, never an empty set of
  references. Full internal compiler indexes stay warm. Older graph compilers
  without this capability continue to send full snapshots.
- Positional definition/hover/references (and same-file highlights where suitable)
  use queries. Fetch full occurrences on demand for rename/refactoring, semantic
  tokens, call hierarchy or any other feature that needs them. Cache that view
  only for its exact revision. Never plan an edit or infer dead code from a
  projected/absent occurrence list.
- Abort currently drops a reply while the compiler still computes it. Keep
  one analysis request in flight and coalesce pending edits to one latest
  follow-up, rather than queueing an analyze for every debounce expiration.
  Preserve overlay ordering, cancellation and generation checks.

## Project and revision handling

The compiler supports one active native-hosted entry graph per child. Select
one project for the active document: walk lexical parent directories for the
nearest `abla.toml` and pass its directory as analyze roots (the compiler reads
its entry), or use the file as entry if no manifest exists. Do not parse TOML
or resolve imports in a second frontend. Preserve lexical paths through symlinks.
For a workspace with one manifest, initialize that project normally. Switching
projects is serialized with queries and snapshot refresh; unrelated programs
are never merged into one semantic namespace.

Overlay acknowledgments and local document generations precede requests.
Use the cached snapshot revision in queries. On `stale_revision`, refresh the
selected graph once, then retry if the requesting document version is still
current; otherwise discard the result. Never turn an explicit null compiler
answer into a spelling-based guess. Legacy/syntax fallback remains clearly
labelled and applies when semantic capability is unavailable.

Remove/downgrade compiler facts for documents that leave the selected graph;
background syntax indexing must not overwrite newer compiler facts. Imported
stdlib/dependency facts must not expand the writable refactor scope: reject
semantic edits outside owned workspace sources or into materialized dependency
copies. Source access for position conversion is tied to the snapshot revision.

## No-evaluation and refactor safety

Read-only queries can use pre-CT facts but must retain `complete:false` and the
pending-site provenance. Show incomplete/pre-CT status in hover/logs and pending
information at affected open-document spans. Do not execute CT providers, grant
new capabilities, hide real diagnostics, or present an incomplete graph as a
successful build.

Compiler validation remains mandatory for semantic transactions. Graph-mode
refactors require a complete baseline and prospective graph; propagate the
compiler's incomplete-analysis refusal. A stale/out-of-graph file must refresh
or fail safely, not silently bypass validation using its old syntax authority.
Formatting/explicitly syntax-only operations keep their existing boundary.

## Validation

Keep the entire existing `npm test` suite, including VS Code client tests.
Extend fake-compiler sessions for mode acceptance, ignored flags, explicit mode
rejection/restart, graph-without-query capability, legacy fallback, stale/cancelled
queries and incomplete CT. Preserve legacy real-compiler tests as such.

Add real-master compiler sessions against isolated fixture projects, using an
explicit `ABLA_COMPILER` path (preserve the launcher name) and sysroot. Test
manifest entry selection, cross-file definition/type/references, private aliases,
strict imports, UTF-8/emoji and URI encoding, overlay changes/close, stale disk
edits, multi-project switching and incomplete refactor refusal. Include end-to-end
LSP requests, not only transport unit tests. Record compiler hash/provenance.
No edits or builds in NovaKind/abla-one are needed; any latency check uses the
existing frozen abla-one copy.

All preparation/tests use at most four CPUs. No push or release without lead
review. Repository reformat waits for the lead's separate schedule after #468.
