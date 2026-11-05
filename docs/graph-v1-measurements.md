# Background refresh measurements

Compiler: the lead's frozen stage-2 of ablac `6c69d56c`, copied from
`~/perfbase/ablac-fl-keep.bin` (SHA-256
`39b1790354dd0525c2402f7f71029b73e2ccaef58cd0b38448f45ef52f26ac4d`).
The matching sysroot is the source tree of
`53b0c6b4`, merged unchanged as `6c69d56c`. Client source is this commit,
based on abla-lsp `df790cc`.

Input: frozen read-only abla-one copy at
`worktrees/ablac-lsp-design/build/lsp-lab/abla-one`, entry `src/one.ab`.
Both arms use the same compiler, graph scope and source. The full arm omits
`fields`; projected requests `fields: ["diagnostics", "symbols"]`.
This isolates the background-view change rather than comparing legacy analysis
with a different, graph-aware semantic scope.

Three alternating pairs: full/projected, projected/full, full/projected.
Each arm starts a fresh Node/compiler process pinned to CPU 6. Initialization
is outside timing; each measured request includes compiler work, transport,
JSON decoding and the actual client's UTF-8/UTF-16 normalization. Cold is the
first analyze, noop repeats it, edit adds an in-memory trailing comment before
analyze. No disk sources are changed. The compact JSON result size is counted
after timing, excluding the response envelope; raw values are retained in
[graph-v1-measurements.json](graph-v1-measurements.json).

| Refresh | Full median (range), seconds | Projected median (range), seconds |
| --- | --- | --- |
| Cold | 1.936 (1.792–2.648) | 1.738 (1.264–2.283) |
| Warm unchanged | 0.344 (0.261–0.366) | 0.138 (0.132–0.212) |
| Comment edit | 1.548 (1.537–1.898) | 1.837 (1.678–2.478) |

The warm median improves 59.9%. Cold/edit ranges overlap substantially;
the edited median regresses 18.6% in this small loaded-host sample. There is
no claim of improved edit/sema throughput. Load after the batch was 18.94
(1-minute), 18.19 (5-minute), 21.94 (15-minute); it was not an exclusive window.
The compiler continues to build and cache full semantic indexes in both arms.

Unchanged compact result: 9,174,783 -> 3,779,196 bytes, **58.8% smaller**.
Both arms return 26 documents, 6,301 symbols, no real diagnostics, and exactly
three explicit pending CT sites (`complete: false`). Full returns 32,944
occurrences. Projected marks occurrences unavailable for all 26 documents,
not an empty semantic reference set. Features that request the full view pay
that transfer once for the revision; positional queries keep the lighter view.
These timings exclude rendering and are not an editor responsiveness benchmark.

Reproduce after `npm run build`, in the matching compiler's Nix shell:

```sh
ABLA_COMPILER_GRAPH=/absolute/path/to/current/ablac \
ABLA_SYSROOT=/matching/compiler/source \
taskset -c 6 node tools/measure-graph-refresh.mjs \
  /path/to/frozen/abla-one src/one.ab
```

The helper requires an existing read-only project and uses only an overlay.
