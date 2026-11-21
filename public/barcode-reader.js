"use strict";

// Reads Code 39 barcodes (the AMD "*EMBLAB30890*" labels) from photos, scanned images and PDFs.
// Everything runs in the browser, so nothing extra has to be installed on the server.
(function (root) {
  // Bar, space, bar, ... for each character: 1 = wide element, 0 = narrow element.
  const PATTERNS = {
    0: "000110100", 1: "100100001", 2: "001100001", 3: "101100000", 4: "000110001", 5: "100110000",
    6: "001110000", 7: "000100101", 8: "100100100", 9: "001100100", A: "100001001", B: "001001001",
    C: "101001000", D: "000011001", E: "100011000", F: "001011000", G: "000001101", H: "100001100",
    I: "001001100", J: "000011100", K: "100000011", L: "001000011", M: "101000010", N: "000010011",
    O: "100010010", P: "001010010", Q: "000000111", R: "100000110", S: "001000110", T: "000010110",
    U: "110000001", V: "011000001", W: "111000000", X: "010010001", Y: "110010000", Z: "011010000",
    "-": "010000101", ".": "110000100", " ": "011000100", "*": "010010100", $: "010101000",
    "/": "010100010", "+": "010001010", "%": "000101010"
  };
  const BY_PATTERN = new Map(Object.entries(PATTERNS).map(([ch, bits]) => [bits, ch]));
  const MIN_CONTRAST = 40;
  const MAX_LENGTH = 40;

  // Splits one line of brightness values into alternating dark / light run widths.
  // level: where between the local darkest and lightest value a pixel counts as dark. Blurred
  // photos make thin bars light grey, so a second, higher level still catches them.
  function runsOf(values, level = 0.5, extremes = localExtremes(values)) {
    const n = values.length;
    const dark = new Uint8Array(n);
    const { lows, highs } = extremes;
    for (let i = 0; i < n; i += 1) {
      const low = lows[i];
      const high = highs[i];
      dark[i] = high - low >= MIN_CONTRAST && values[i] < low + (high - low) * level ? 1 : 0;
    }
    const widths = [];
    const colors = [];
    let start = 0;
    for (let i = 1; i <= n; i += 1) {
      if (i === n || dark[i] !== dark[start]) {
        widths.push(i - start);
        colors.push(dark[start]);
        start = i;
      }
    }
    return { widths, colors };
  }

  function localExtremes(values) {
    const radius = Math.max(8, Math.round(values.length / 60));
    return {
      lows: slidingExtreme(values, radius, (a, b) => a <= b),
      highs: slidingExtreme(values, radius, (a, b) => a >= b)
    };
  }

  // Minimum or maximum of values[i - radius .. i + radius] for every i, in one pass.
  function slidingExtreme(values, radius, keep) {
    const n = values.length;
    const out = new Float32Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let i = 0; i < n; i += 1) {
      const right = Math.min(n - 1, i + radius);
      while (next <= right) {
        while (tail > head && keep(values[next], values[queue[tail - 1]])) tail -= 1;
        queue[tail] = next;
        tail += 1;
        next += 1;
      }
      while (queue[head] < i - radius) head += 1;
      out[i] = values[queue[head]];
    }
    return out;
  }

  // The character made by the 9 runs starting at index i, or "" if they do not form one.
  function charAt(widths, i) {
    const nine = widths.slice(i, i + 9);
    if (nine.length < 9) return "";
    const sorted = [...nine].sort((a, b) => b - a);
    const wideMin = sorted[2];
    const narrowMax = sorted[3];
    if (wideMin < narrowMax * 1.3 || sorted[0] > sorted[8] * 6) return "";
    const cut = (wideMin + narrowMax) / 2;
    return BY_PATTERN.get(nine.map((w) => (w > cut ? "1" : "0")).join("")) || "";
  }

  function sum(widths, from, count) {
    let total = 0;
    for (let i = from; i < from + count; i += 1) total += widths[i];
    return total;
  }

  // Every *TEXT* found in one direction of one line.
  function decodeRuns(widths, colors, found) {
    for (let i = 0; i + 9 <= widths.length; i += 1) {
      if (!colors[i] || charAt(widths, i) !== "*") continue;
      const charWidth = sum(widths, i, 9);
      const narrow = charWidth / 15;
      if (i > 0 && widths[i - 1] < narrow * 4) continue;
      let text = "";
      let j = i + 10;
      while (j + 9 <= widths.length && text.length <= MAX_LENGTH) {
        if (widths[j - 1] > narrow * 4) break;
        const width = sum(widths, j, 9);
        if (width < charWidth * 0.75 || width > charWidth * 1.3) break;
        const ch = charAt(widths, j);
        if (!ch) break;
        if (ch === "*") {
          const after = j + 9 < widths.length ? widths[j + 9] : Infinity;
          if (text && after >= narrow * 4) found.push(text);
          break;
        }
        text += ch;
        j += 10;
      }
    }
  }

  function decodeLine(values) {
    const extremes = localExtremes(values);
    const found = [];
    for (const level of [0.5, 0.68]) {
      const { widths, colors } = runsOf(values, level, extremes);
      const before = found.length;
      decodeRuns(widths, colors, found);
      decodeRuns([...widths].reverse(), [...colors].reverse(), found);
      if (found.length > before) break;
    }
    return found;
  }

  // gray: brightness 0-255 for each pixel, row by row. Reads rows and columns, so labels can be
  // the right way up, upside down or turned sideways. A code must be read on at least two lines.
  function scanGray(gray, width, height) {
    const seen = new Map();
    const note = (texts, position) => {
      for (const text of texts) {
        const entry = seen.get(text) || { count: 0, position };
        entry.count += 1;
        seen.set(text, entry);
      }
    };
    const rowStep = Math.max(1, Math.round(height / 300));
    const row = new Float32Array(width);
    for (let y = 0; y < height; y += rowStep) {
      for (let x = 0; x < width; x += 1) row[x] = gray[y * width + x];
      note(decodeLine(row), y * width);
    }
    const colStep = Math.max(1, Math.round(width / 300));
    const col = new Float32Array(height);
    for (let x = 0; x < width; x += colStep) {
      for (let y = 0; y < height; y += 1) col[y] = gray[y * width + x];
      note(decodeLine(col), x);
    }
    return [...seen.entries()].filter(([, e]) => e.count >= 2)
      .sort((a, b) => a[1].position - b[1].position).map(([text]) => text);
  }

  function grayFromRgba(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    }
    return gray;
  }

  // Barcode-like words in plain text, for PDFs that carry the label text itself.
  function codesInText(text) {
    const codes = [];
    for (const match of String(text).toUpperCase().matchAll(/\*?\b(EMBLAB\s?\d{3,})\b\*?/g)) {
      codes.push(match[1].replace(/\s+/g, ""));
    }
    return codes;
  }

  // ---------- browser only ----------

  const MAX_SIDE = 3200;

  async function scanBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return scanGray(grayFromRgba(context.getImageData(0, 0, width, height).data, width, height), width, height);
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Undoes the PNG row filters some PDF writers use on images (/Predictor 10 and above).
  function unpredict(data, rowBytes, pixelBytes) {
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r += 1) {
      const type = data[r * (rowBytes + 1)];
      for (let i = 0; i < rowBytes; i += 1) {
        const raw = data[r * (rowBytes + 1) + 1 + i];
        const left = i >= pixelBytes ? out[r * rowBytes + i - pixelBytes] : 0;
        const up = r ? out[(r - 1) * rowBytes + i] : 0;
        const upLeft = r && i >= pixelBytes ? out[(r - 1) * rowBytes + i - pixelBytes] : 0;
        let value = raw;
        if (type === 1) value = raw + left;
        else if (type === 2) value = raw + up;
        else if (type === 3) value = raw + ((left + up) >> 1);
        else if (type === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
        }
        out[r * rowBytes + i] = value & 255;
      }
    }
    return out;
  }

  // Scanned PDFs hold each page as a picture. This finds those pictures and any text in the file.
  async function scanPdf(buffer) {
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder("latin1").decode(bytes);
    const codes = [];
    const streamRe = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream\r?\n/g;
    let match;
    while ((match = streamRe.exec(text))) {
      const dict = match[1];
      const start = match.index + match[0].length;
      const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let end = lengthMatch ? start + Number(lengthMatch[1]) : text.indexOf("endstream", start);
      if (end < start || end > bytes.length) end = text.indexOf("endstream", start);
      if (end < 0) break;
      const data = bytes.subarray(start, end);
      streamRe.lastIndex = end;
      const isImage = /\/Subtype\s*\/Image/.test(dict);
      try {
        if (isImage && /\/DCTDecode/.test(dict)) {
          codes.push(...await scanBlob(new Blob([data], { type: "image/jpeg" })));
        } else if (isImage && /\/FlateDecode/.test(dict) && /\/BitsPerComponent\s+8/.test(dict)) {
          const width = Number((/\/Width\s+(\d+)/.exec(dict) || [])[1]);
          const height = Number((/\/Height\s+(\d+)/.exec(dict) || [])[1]);
          const channels = /\/DeviceRGB/.test(dict) ? 3 : /\/DeviceGray/.test(dict) ? 1 : 0;
          if (!width || !height || !channels) continue;
          let pixels = await inflate(data);
          if (Number((/\/Predictor\s+(\d+)/.exec(dict) || [])[1]) >= 10) pixels = unpredict(pixels, width * channels, channels);
          const gray = new Uint8Array(width * height);
          for (let i = 0; i < gray.length; i += 1) {
            gray[i] = channels === 1 ? pixels[i]
              : (pixels[i * 3] * 299 + pixels[i * 3 + 1] * 587 + pixels[i * 3 + 2] * 114) / 1000;
          }
          codes.push(...scanGray(gray, width, height));
        } else if (!isImage) {
          const content = /\/FlateDecode/.test(dict) ? new TextDecoder("latin1").decode(await inflate(data)) : text.slice(start, end);
          codes.push(...codesInText(content));
        }
      } catch {
        // A picture or stream this reader does not understand is skipped.
      }
    }
    return codes;
  }

  // Returns the codes found in a PDF, JPG or PNG file, each once, in the order they appear.
  async function readFile(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    const codes = isPdf ? await scanPdf(await file.arrayBuffer()) : await scanBlob(file);
    return [...new Set(codes)];
  }

  const api = { scanGray, decodeLine, runsOf, grayFromRgba, codesInText, readFile, PATTERNS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BarcodeReader = api;
})(typeof window === "undefined" ? globalThis : window);
