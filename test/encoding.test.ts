import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompilerSnapshot, Utf8OffsetMap } from "../src/encoding.js";

test("maps UTF-8 compiler offsets to UTF-16 offsets", () => {
  const offsets = new Utf8OffsetMap("é😀x");
  assert.deepEqual(offsets.range({ start: 0, end: 2 }), { start: 0, end: 1 });
  assert.deepEqual(offsets.range({ start: 2, end: 6 }), { start: 1, end: 3 });
  assert.deepEqual(offsets.range({ start: 6, end: 7 }), { start: 3, end: 4 });
});

test("normalizes every compiler source range", () => {
  const text = "// café\nfun greet: int = 1\n";
  const snapshot = normalizeCompilerSnapshot({
    revision: "1",
    documents: [
      {
        uri: "file:///unicode.ab",
        version: 1,
        text,
        symbols: [
          {
            id: "greet",
            name: "greet",
            kind: "function",
            uri: "file:///unicode.ab",
            range: { start: 9, end: 27 },
            selectionRange: { start: 13, end: 18 },
            detail: "fun int",
            topLevel: true,
          },
        ],
        occurrences: [{ name: "greet", range: { start: 13, end: 18 } }],
        diagnostics: [{ code: "E_TEST", message: "test", range: { start: 9, end: 10 } }],
      },
    ],
  });
  const document = snapshot.documents[0];
  assert.deepEqual(document?.symbols[0]?.selectionRange, { start: 12, end: 17 });
  assert.deepEqual(document?.occurrences[0]?.range, { start: 12, end: 17 });
  assert.deepEqual(document?.diagnostics[0]?.range, { start: 8, end: 9 });
});

test("reverse offsets preserve scalar boundaries including surrogate interiors", () => {
  const offsets = new Utf8OffsetMap("é😀x");
  assert.deepEqual([0,1,2,3,4].map((value) => offsets.byteOffset(value)), [0,2,2,6,7]);
  for (const byte of [0,2,6,7]) assert.equal(offsets.byteOffset(offsets.offset(byte)), byte);
});

test("projections retain graph metadata and explicitly mark missing occurrences", () => {
  const result = normalizeCompilerSnapshot({
    revision: "r", analysisMode: "graph-v1", complete: false, entry: "/unicode.ab",
    fields: ["diagnostics", "symbols"],
    pending: [{ code: "E_ANALYSIS_CT_REQUIRED", uri: "file:///unicode.ab", range: { start: 2, end: 6 }, message: "pending" }],
    documents: [{ uri: "file:///unicode.ab", version: 1, text: "é😀x", symbols: [], diagnostics: [] }],
  });
  assert.equal(result.complete, false);
  assert.equal(result.analysisMode, "graph-v1");
  assert.deepEqual(result.fields, ["diagnostics", "symbols"]);
  assert.deepEqual(result.pending?.[0]?.range, { start: 1, end: 3 });
  assert.equal(result.documents[0]?.occurrencesAvailable, false);
  assert.deepEqual(result.documents[0]?.occurrences, []);
});
