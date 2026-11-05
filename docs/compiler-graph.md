# Graph-aware compiler analysis

The server negotiates capabilities rather than checking a compiler version. It
requests `analysisMode: "graph-v1"` on schema/protocol 1. A compiler that ignores
that field keeps the legacy path. An explicit `unsupported_analysis_mode`
response causes a fresh child to initialize without the field. Other failures
are logged and retried with bounded backoff, not silently treated as old compilers.

Graph mode requires `module-graph-analysis-v1` and `no-eval-ct`. It uses the
compiler's real module graph, standard library, packages, strict imports and
contracts. The server does not implement import resolution or type inference.
One serial compiler worker analyzes one active project at a time. The nearest
lexical parent `abla.toml` selects the project; the compiler reads its entry.
Without a manifest the requested file is the entry. Changing projects replaces
the active graph; unrelated programs are not merged. Browsing a dependency
already in that graph keeps its importing project's context. Symlinks remain
lexical for source loading and identity.

## Refreshes and positional queries

With `analysis-fields-v1`, background refreshes request only diagnostics and
symbols. The compiler still returns document identity, source text, revision,
completeness and pending sites, and retains its full internal indexes. Missing
occurrences are explicitly unavailable: an empty reference list is not inferred
from an omitted field. Older graph compilers return full snapshots as before.

With `analysis-queries-v1`, definition, hover, references and document highlights
use positional queries against that revision. References exclude the declaration
when the client requests it. A null compiler answer is authoritative and never
becomes a spelling-based guess. Features that need the complete occurrence set
(rename, semantic tokens, call hierarchy and refactoring) fetch the full view
lazily, then reuse it only for the same revision. Compilers without positional
queries use their complete graph snapshots.

Compiler offsets are UTF-8 bytes; LSP offsets are UTF-16. Both directions use
maps from the matching source generation, including emoji and encoded file URIs.
A stale revision triggers one refresh/retry. Edits or scope changes supersede
older replies, so their ranges cannot be published against newer text.

Only one refresh runs at a time. Rapid edits coalesce into a latest follow-up;
client cancellation does not claim to interrupt compiler CPU work. Overlays,
closes, scope changes and queries share the serial worker. The VS Code client
watches Abla sources, `abla.toml` and `abla.lock` for disk invalidation.

## Compile-time code and edit safety

Graph analysis does **not execute compile-time code**, including providers or
grant-bearing actions. It may return useful pre-CT types with `complete: false`.
Pending sites are retained, displayed as informational diagnostics, and labelled
in hover and symbols. Real compiler diagnostics remain errors. This is analysis,
not proof that the program builds.

Semantic refactors require complete baseline and prospective compiler analysis.
They are refused on incomplete graphs, projected facts, stale generations or
sources outside the selected program. Full facts are fetched before planning;
prospective compiler validation remains mandatory. Imported standard library,
materialized dependencies and sources outside owned workspace roots are
read-only. A physical ownership check also rejects edits through a workspace
symlink that escapes the workspace. This check does not change import semantics.
Syntax-only formatting and import organization retain their existing boundaries.

Legacy compilers retain legacy analysis. If no compiler is available the server
keeps clearly labelled conservative syntax assistance; it does not present that
fallback as graph-aware semantic truth. The LSP remains in this repository, and
no Node dependency is added to ablac.

## Reproducing validation

Run `npm ci` in this repository and `editors/vscode`, then:

```sh
ABLA_COMPILER=/absolute/path/to/ablac \
ABLA_COMPILER_GRAPH=/absolute/path/to/current/ablac \
ABLA_SYSROOT=/matching/compiler/source npm test
```

`ABLA_COMPILER` enables the existing live compiler refactor gate.
`ABLA_COMPILER_GRAPH` additionally enables current graph/fields compiler sessions,
including full framed LSP sessions. Without those variables the explicit real
compiler tests are skipped; fake transport and deterministic unit tests still run.
Preserve the compiler launcher path: do not resolve its symlink, because the
launcher locates its payload beside its invocation name.

Validation for this change uses the lead's frozen stage-2 compiler of ablac
`6c69d56c`, copied from `~/perfbase/ablac-fl-keep.bin`, with matching source.
It covers negotiation and failures, coalescing, shutdown, stale/cancelled queries,
UTF-8 positions, overlays and disk revisions, private identities, strict imports,
contract opacity, project switching, lazy full facts, incomplete CT refusals,
and external/symlink edit rejection. It does not claim a VS Code UI test,
macOS execution, or a published extension.

[Refresh measurements](graph-v1-measurements.md) use a frozen abla-one copy;
no source repository is edited by that measurement.
