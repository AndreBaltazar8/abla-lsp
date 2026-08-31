# Abla Language Server

`abla-lsp` is the editor-independent language server and refactoring engine
for Abla. It is a separate repository because protocol compatibility, editor
packaging, and refactoring UX have a different release lifecycle from the
compiler. Semantic truth remains owned by `ablac` through a versioned analysis
protocol; this project never grows a second Abla type checker.

The first milestone establishes a real LSP transport, document lifecycle,
workspace index, diagnostics, symbols, navigation, references, and conservative
rename support. Until the compiler analysis protocol is connected, the server
labels its built-in source scanner as syntax-only and refuses ambiguous edits.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
node dist/src/main.js --stdio
```

## Product coverage

The completion contract includes:

- compiler diagnostics for open overlays and saved workspace files;
- completion, hover, signatures, definitions, implementations, references,
  document/workspace symbols, call hierarchy, type hierarchy, inlay hints, and
  semantic tokens;
- formatting, quick fixes, source actions, and import organization;
- semantic prepare-rename and workspace-wide bulk rename;
- previewable single or multi-declaration moves across files with dependency,
  import, visibility, collision, and cycle repair;
- incremental analysis, cancellation, bounded resource use, deterministic
  edits, editor integration, compatibility tests, and release artifacts.

See [docs/architecture.md](docs/architecture.md) for the compiler boundary and
[docs/coverage.md](docs/coverage.md) for the feature gate.
