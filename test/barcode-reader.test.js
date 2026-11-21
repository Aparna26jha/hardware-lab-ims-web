"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const reader = require("../public/barcode-reader");

// Draws Code 39 labels on a grey page, the way a phone photo of a label sheet looks.
function page(codes, { width = 900, rowHeight = 120, narrow = 3, wide = 8, blur = false } = {}) {
  const height = rowHeight * codes.length + 40;
  const gray = new Uint8Array(width * height).fill(225);
  codes.forEach((code, row) => {
    const bars = [];
    for (const ch of "*" + code + "*") {
      [...reader.PATTERNS[ch]].forEach((bit, i) => bars.push({ dark: i % 2 === 0, size: bit === "1" ? wide : narrow }));
      bars.push({ dark: false, size: narrow });
    }
    let x = 60;
    const top = 30 + row * rowHeight;
    for (const bar of bars) {
      if (bar.dark) {
        for (let y = top; y < top + rowHeight - 50; y += 1) gray.fill(25, y * width + x, y * width + x + bar.size);
      }
      x += bar.size;
    }
  });
  if (blur) {
    const copy = Uint8Array.from(gray);
    for (let i = 1; i < gray.length - 1; i += 1) gray[i] = (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4;
  }
  return { gray, width, height };
}

test("reads every label on a sheet, top to bottom", () => {
  const { gray, width, height } = page(["EMBLAB30890", "EMBLAB30891", "EMBLAB30892"]);
  assert.deepEqual(reader.scanGray(gray, width, height), ["EMBLAB30890", "EMBLAB30891", "EMBLAB30892"]);
});

test("reads slightly blurred labels and lab codes with dashes", () => {
  const { gray, width, height } = page(["MB-SP5-044"], { blur: true });
  assert.deepEqual(reader.scanGray(gray, width, height), ["MB-SP5-044"]);
});

test("an empty page gives nothing", () => {
  assert.deepEqual(reader.scanGray(new Uint8Array(400 * 300).fill(200), 400, 300), []);
});

test("finds EMBLAB numbers typed in a document", () => {
  assert.deepEqual(reader.codesInText("Items: *EMBLAB30890*, emblab 30891; INV-1"), ["EMBLAB30890", "EMBLAB30891"]);
});
