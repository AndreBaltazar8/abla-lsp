# Transactional refactors

Every refactor produces a previewable `WorkspaceEdit`. Semantic edits are sent
to `ablac refactor/validate` against the exact compiler revision from which the
plan was made. The edit is returned or applied only when the prospective
workspace introduces no compiler diagnostics and preserves symbols outside the
edited documents.

## Operations

| Command | Operation and safety boundary |
| --- | --- |
| `abla.renameSymbols` | Rename one or many canonical symbols, including atomic swaps, after namespace and collision checks. |
| `abla.moveDeclarations` | Move one or many declarations with attached comments, dependency imports, and cycle checks. Types, split-to-file, and merge-to-file use the same transaction through `moveTypes`, `splitDeclarations`, and `mergeDeclarations`. Targets must already be analyzed `.ab` documents. |
| `abla.changeSignature` | Add, remove, rename, or reorder parameters; rewrite every compiler-resolved call and parameter reference; optionally change the return type. A new parameter needs a call argument or declaration default. |
| `abla.extractFunction` | Extract a selected expression or block, infer compiler-resolved captures and types, and optionally make one capture the receiver of an extension method. Invalid output, capture, or effect arrangements are rejected by the compiler. |
| `abla.functionToMethod` | Turn a receiver parameter into `this`, rewrite the declaration as an extension method, and update all calls. |
| `abla.methodToFunction` | Turn an extension or class method receiver into an explicit parameter, lift class methods to top level, qualify class members, and rewrite calls. |
| `abla.inlineSymbol` | Inline expression-bodied functions or initialized bindings. Effectful arguments may not be duplicated. |
| `abla.promoteLocal` | Promote an initialized local to a defaulted function parameter or top-level binding. |
| `abla.extractInterface` | Create an interface from selected methods of one class while preserving their signatures. |
| `abla.generateDeclaration` | Generate a function, class, or value from an unresolved use, including argument slots and a compilable default result. |
| `abla.repairOwnership` | Apply a bounded `move`, `borrow`, `own`, `var`, `Shared`, or `Weak` transformation to the selected source range. Only compiler-valid repairs survive. |
| `abla.toggleCompileTime` | Migrate a function between `fun` and `compile fun` and update resolved calls with or without `#`. |
| `abla.removeDeadCode` | Remove selected top-level symbols only when canonical references prove them unused. Workspace mode is conservative and considers underscore-prefixed declarations only unless explicitly made aggressive. |
| `abla.applyRefactorRecipe` | Combine independent operations into one preview and one compiler validation. Conflicting or overlapping edits are rejected; identical edits are deduplicated. |

## Command shape

All commands accept `apply: false` (the default) to return a preview or
`apply: true` to submit the validated edit to the client.

Changing a signature identifies retained parameters with `source`; new
parameters provide a complete declaration and either an argument or default:

```json
{
  "command": "abla.changeSignature",
  "arguments": [{
    "symbolId": "abla:/project/math.ab:0:add",
    "parameters": [
      { "name": "right", "source": "right" },
      { "name": "left", "source": "left" },
      { "name": "scale", "declaration": "scale: int = 1" }
    ]
  }]
}
```

An extraction uses an ordinary LSP range. Supplying `receiverSymbolId` creates
an extension method instead of a free function:

```json
{
  "command": "abla.extractFunction",
  "arguments": [{
    "uri": "file:///project/src/main.ab",
    "range": {
      "start": { "line": 8, "character": 16 },
      "end": { "line": 8, "character": 28 }
    },
    "name": "calculate"
  }]
}
```

A recipe file is a JSON object whose `operations` array contains the same
typed requests. Every operation is planned against one immutable analysis
snapshot:

```json
{
  "operations": [
    {
      "kind": "toggleCompileTime",
      "request": { "symbolId": "abla:/project/build.ab:0:generate", "compileTime": true }
    },
    {
      "kind": "removeDeadCode",
      "request": { "symbolIds": ["abla:/project/old.ab:0:_legacy"] }
    }
  ]
}
```

The server rejects recipes in which an earlier transformation would be needed
to discover the identity used by a later transformation. Such migrations are
run as two validated recipes so the second starts from a fresh compiler
snapshot.
