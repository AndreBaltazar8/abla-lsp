# Abla Language Server for VS Code

This extension bundles `abla-lsp`; install Abla 0.2.46 or newer, or configure
its compiler executable path in the Abla settings. An external language-server executable can also be
selected for development. Syntax highlighting is supplied by the
`andrebaltazar8.abla-tmlanguage` extension.

Use multiple cursors with **Abla: Rename Symbols at All Cursors** for an atomic
bulk rename. Place cursors on one or more top-level declarations and run
**Abla: Move Selected Declarations to File** for a preview-validated move to
an existing file or an atomically created target.

The command palette also provides declaration/type split and merge, change
signature, extraction, block-aware inline, function/method conversion,
local/constant introduction, binding conversion, local promotion,
interface and missing-declaration generation, ownership repair, compile-time
migration, dead-code removal, and same-snapshot or staged JSON refactor recipes.
Semantic edits are applied only after prospective compiler validation.

## Debugging

Breakpoints can be set in `.ab` files, and the `abla` debug type runs a program
under [lldb-dap](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.lldb-dap)
(install the "LLDB DAP" extension and an lldb with `lldb-dap`). With an Abla file
open, F5 builds it as a development build (`ablac build <file> -o build/debug/<name> -g --fast`)
and starts it: breakpoints stop on Abla lines, the call stack names Abla functions
(`app.main`, `app.Point.norm1`), and the variables view shows each parameter and
local with its Abla type: numbers and bools, a string's text, an instance's
fields, an array's length and elements.

```json
{
  "type": "abla",
  "request": "launch",
  "name": "Debug Abla program",
  "program": "${file}",
  "args": []
}
```

`program` may also be a project directory (built with `--project`). See the
compiler's `docs/debugging.md` for what a development build describes.
