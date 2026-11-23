// What every Abla debug session starts with (no Python: lldb summary strings and settings, gdb's skip command). This
// file imports nothing from VS Code, so the headless DAP tests can use it too.

// Functions of the runtime itself: stepping in skips them in both debuggers.
export const runtimeFramePattern = "__abla|^abla_";

/** Whether a frame name belongs to the runtime itself (not to Abla code the user wrote or imported). */
export function isRuntimeFrame(name: string): boolean {
  return new RegExp(runtimeFramePattern, "u").test(name);
}

export const ablaLldbCommands = [
  // A string shows its text, an array its length.
  'type summary add --summary-string "${var.data%s}" string',
  'type summary add --summary-string "length ${var.length}" -x "^array<"',
];

// Stepping stays in Abla source. gdb skips the runtime's functions itself (the `skip` below). lldb-dap's stepIn ignores
// lldb's `step-avoid-regexp` (the CLI honours it, the DAP request does not), so the VS Code extension steps out of a
// runtime frame a step landed in (isRuntimeFrame); the headless test does the same.

// gdb's DAP mode (`gdb -i dap`), where lldb-dap is missing: the same step-over of runtime functions.
export const ablaGdbArguments = ["-iex", `skip -rfu ${runtimeFramePattern}`, "-i", "dap"];
