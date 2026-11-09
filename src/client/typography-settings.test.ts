import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeTypography,
  parseTypography,
  terminalFontFamily,
  typographyDefaults,
  typographyVariables,
} from "./typography-settings";

test("typography defaults cover terminal, documents and menus independently", () => {
  const settings = parseTypography(null);
  assert.equal(settings.terminalSize, 15);
  assert.equal(settings.terminalLineHeight, 1.45);
  assert.equal(settings.documentSize, 16);
  assert.equal(settings.documentLineHeight, 1.7);
  assert.equal(settings.uiSize, 14);
  settings.terminalSize = 18;
  assert.equal(typographyDefaults.terminalSize, 15);
  assert.equal(settings.documentSize, 16);
  assert.equal(settings.uiSize, 14);
});

test("corrupt, unsupported and malicious typography values do not reach CSS", () => {
  for (const text of [
    "not JSON",
    "null",
    "[]",
    '"18"',
    '{"version":2,"terminalSize":26}',
  ])
    assert.deepEqual(parseTypography(text), typographyDefaults);
  const settings = normalizeTypography({
    terminalFont: "url(https://example.test/font)",
    terminalSize: "25",
    uiSize: NaN,
    documentLineHeight: Infinity,
  });
  assert.deepEqual(settings, typographyDefaults);
  assert.ok(!terminalFontFamily(settings.terminalFont).includes("url("));
});

test("sizes and line heights clamp and round to supported increments", () => {
  assert.deepEqual(
    normalizeTypography({
      terminalSize: 99,
      terminalLineHeight: 1.431,
      documentSize: -9,
      documentLineHeight: 4,
      uiSize: 15.6,
    }),
    {
      ...typographyDefaults,
      terminalSize: 28,
      terminalLineHeight: 1.45,
      documentSize: 12,
      documentLineHeight: 2.2,
      uiSize: 16,
    },
  );
  assert.equal(
    normalizeTypography({ terminalLineHeight: -5 }).terminalLineHeight,
    1,
  );
});

test("versionless legacy preferences migrate without resetting individual choices", () => {
  const migrated = normalizeTypography({
    terminalFont: "consolas",
    terminalFontSize: 17,
    lineHeight: 1.5,
    documentFontSize: 20,
    uiFontSize: 16,
  });
  assert.deepEqual(migrated, {
    ...typographyDefaults,
    terminalFont: "consolas",
    terminalSize: 17,
    terminalLineHeight: 1.5,
    documentSize: 20,
    uiSize: 16,
  });
  assert.deepEqual(parseTypography(JSON.stringify(migrated)), migrated);
  assert.equal(typographyVariables(migrated)["--document-font-size"], "20px");
  assert.ok(
    typographyVariables(migrated)["--font-mono"].startsWith("Consolas,"),
  );
});

function fontAdvance(font: Buffer, codepoint: number) {
  const tables = new Map<string, number>();
  for (let index = 0; index < font.readUInt16BE(4); index++) {
    const offset = 12 + index * 16;
    tables.set(
      font.toString("ascii", offset, offset + 4),
      font.readUInt32BE(offset + 8),
    );
  }
  const cmap = tables.get("cmap")!;
  let glyph = 0;
  for (let index = 0; index < font.readUInt16BE(cmap + 2); index++) {
    const subtable = cmap + font.readUInt32BE(cmap + 8 + index * 8);
    if (font.readUInt16BE(subtable) !== 4) continue;
    const count = font.readUInt16BE(subtable + 6) / 2;
    const ends = subtable + 14,
      starts = ends + count * 2 + 2;
    const deltas = starts + count * 2,
      ranges = deltas + count * 2;
    for (let segment = 0; segment < count; segment++) {
      if (
        codepoint < font.readUInt16BE(starts + segment * 2) ||
        codepoint > font.readUInt16BE(ends + segment * 2)
      )
        continue;
      const delta = font.readInt16BE(deltas + segment * 2);
      const range = font.readUInt16BE(ranges + segment * 2);
      if (!range) glyph = (codepoint + delta) & 0xffff;
      else {
        const address =
          ranges +
          segment * 2 +
          range +
          2 * (codepoint - font.readUInt16BE(starts + segment * 2));
        const mapped = font.readUInt16BE(address);
        glyph = mapped ? (mapped + delta) & 0xffff : 0;
      }
      break;
    }
    if (glyph) break;
  }
  assert.ok(glyph > 0, `Bundled font is missing U+${codepoint.toString(16)}`);
  const count = font.readUInt16BE(tables.get("hhea")! + 34);
  return font.readUInt16BE(
    tables.get("hmtx")! + Math.min(glyph, count - 1) * 4,
  );
}

test("unmodified bundled fonts match pinned upstream files and terminal Korean grid metrics", () => {
  const files = [
    [
      "d2coding/D2Coding-Regular.ttf",
      "d5f2b6bf5b1826cfbf3734c70582f0cd42ea2e1d6c2636ae681b612bc9c5682f",
    ],
    [
      "d2coding/D2Coding-Bold.ttf",
      "14a0cfa4d96fbd976bc4b1a6ef81e51df353a1689d5273ebcd908c857a4f2752",
    ],
    [
      "pretendard/PretendardVariable.woff2",
      "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4",
    ],
  ];
  for (const [path, digest] of files) {
    const data = readFileSync(
      new URL(`../../public/fonts/${path}`, import.meta.url),
    );
    assert.equal(createHash("sha256").update(data).digest("hex"), digest);
    if (!path.endsWith(".ttf")) {
      assert.equal(data.toString("ascii", 0, 4), "wOF2");
      continue;
    }
    assert.equal(data.readUInt32BE(0), 0x00010000);
    const latin = fontAdvance(data, 65);
    for (const character of "0iMW│─")
      assert.equal(fontAdvance(data, character.codePointAt(0)!), latin);
    for (const character of "가글한힣")
      assert.equal(fontAdvance(data, character.codePointAt(0)!), latin * 2);
  }
  for (const file of ["d2coding/OFL.txt", "pretendard/LICENSE"])
    assert.match(
      readFileSync(
        new URL(`../../public/fonts/${file}`, import.meta.url),
        "utf8",
      ),
      /SIL OPEN FONT LICENSE Version 1\.1/,
    );
});
