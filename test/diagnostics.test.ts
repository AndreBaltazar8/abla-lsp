import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticMessage } from "../src/diagnostics.js";

test("help lines follow the message, one per line", () => {
  const range = { start: 0, end: 1 };
  assert.equal(diagnosticMessage({ code: "E", message: "unknown name `x`", range }), "unknown name `x`");
  assert.equal(diagnosticMessage({ code: "E", message: "unknown name `x`", range, help: [] }), "unknown name `x`");
  assert.equal(diagnosticMessage({ code: "E", message: "m", range, help: ["import abla/io", "did you mean `y`?"] }), "m\nhelp: import abla/io\nhelp: did you mean `y`?");
});
