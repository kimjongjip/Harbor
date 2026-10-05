import assert from "node:assert/strict";
import test from "node:test";
import { parseDelimited } from "./preview-delimited.js";

test("CSV preserves quoted commas, escaped quotes, Unicode and multiline cells", () => {
  assert.deepEqual(
    parseDelimited(
      '\uFEFFname,note,empty\r\n한글,"one, two",\r\n"a""b","line1\r\nline2",done\r\n',
      ",",
    ),
    {
      rows: [
        ["name", "note", "empty"],
        ["한글", "one, two", ""],
        ['a"b', "line1\r\nline2", "done"],
      ],
      malformed: false,
      rowCount: 3,
      columnCount: 3,
      limited: false,
    },
  );
});
test("TSV handles tabs inside quotes, empty fields and internal blank records", () => {
  assert.deepEqual(parseDelimited('a\tb\n\n"one\ttwo"\t\n', "\t"), {
    rows: [["a", "b"], [""], ["one\ttwo", ""]],
    malformed: false,
    rowCount: 3,
    columnCount: 2,
    limited: false,
  });
  assert.deepEqual(parseDelimited("", ",").rows, []);
  assert.deepEqual(parseDelimited(",,", ",").rows, [["", "", ""]]);
  assert.deepEqual(parseDelimited('""', ",").rows, [[""]]);
});
test("Incomplete quoted data and invalid quote placement retain content with a warning", () => {
  assert.deepEqual(parseDelimited('a,"unfinished\nnext', ","), {
    rows: [["a", "unfinished\nnext"]],
    malformed: true,
    rowCount: 1,
    columnCount: 2,
    limited: false,
  });
  assert.deepEqual(parseDelimited('a"b,"c"x', ","), {
    rows: [['a"b', "cx"]],
    malformed: true,
    rowCount: 1,
    columnCount: 2,
    limited: false,
  });
});
test("Formula-like content stays literal and pathological files have bounded stored cells", () => {
  assert.equal(
    parseDelimited('"=SUM(A1:A2)","<script>alert(1)</script>"', ",").rows[0][0],
    "=SUM(A1:A2)",
  );
  const wide = parseDelimited(",".repeat(200000), ",");
  assert.equal(wide.columnCount, 200001);
  assert.equal(wide.rows[0].length, 100);
  assert.equal(wide.limited, true);
  const tall = parseDelimited("a,b\n".repeat(5000), ",");
  assert.equal(tall.rowCount, 5000);
  assert.equal(tall.rows.length, 2000);
  assert.equal(tall.limited, true);
});
