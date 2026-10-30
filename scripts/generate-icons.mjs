#!/usr/bin/env node
/**
 * Generates the app/PWA icon PNGs from a single vector-style design using
 * only Node builtins (no image dependencies to install or audit).
 *
 * Outputs:
 *   app/icon.png                     32x32  favicon (rounded, transparent)
 *   app/apple-icon.png              180x180 iOS home-screen icon (full bleed;
 *                                           Apple applies its own mask)
 *   public/icons/icon-192.png        192x192 manifest "any" icon (rounded)
 *   public/icons/icon-512.png        512x512 manifest "any" icon (rounded)
 *   public/icons/icon-maskable-512.png 512x512 manifest "maskable" icon
 *                                           (full bleed, glyph inside the
 *                                           safe-zone circle)
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Brand colors matching the app's light-theme primary (app/theme.ts leaves
// the MUI default light palette untouched).
const BACKGROUND = [0x19, 0x76, 0xd2]; // #1976d2
const FOREGROUND = [0xff, 0xff, 0xff]; // white

// Corner radius (fraction of icon size) for "any"-purpose icons. Maskable and
// Apple icons are full-bleed squares because the OS applies its own mask.
const CORNER_RADIUS = 0.225;

// Glyph: a terminal prompt ">_" drawn as round-capped strokes in design
// space [0,1]x[0,1] (y grows downward). Centered at (0.5, 0.5) and sized to
// stay inside the maskable safe-zone circle (radius 0.4 around the center).
const STROKES = [
  // [x1, y1, x2, y2, halfWidth]
  [0.27, 0.31, 0.43, 0.5, 0.055], // chevron upper arm
  [0.43, 0.5, 0.27, 0.69, 0.055], // chevron lower arm
  [0.53, 0.68, 0.73, 0.68, 0.047], // prompt cursor
];

function distanceToSegmentSquared(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.min(1, Math.max(0, t));
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return ex * ex + ey * ey;
}

function insideGlyph(u, v) {
  return STROKES.some(([x1, y1, x2, y2, halfWidth]) => {
    return distanceToSegmentSquared(u, v, x1, y1, x2, y2) <= halfWidth * halfWidth;
  });
}

function insideRoundedRect(u, v) {
  const r = CORNER_RADIUS;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Renders the icon to RGBA pixels. Anti-aliased with 4x4 supersampling.
 */
function render(size, { fullBleed = false } = {}) {
  const samples = 4;
  const total = samples * samples;
  const data = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let insideRect = 0;
      let insideStroke = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (px + (sx + 0.5) / samples) / size;
          const v = (py + (sy + 0.5) / samples) / size;
          if (!fullBleed && !insideRoundedRect(u, v)) continue;
          insideRect++;
          if (insideGlyph(u, v)) insideStroke++;
        }
      }
      const offset = (py * size + px) * 4;
      if (insideRect === 0) continue; // fully transparent pixel
      const t = insideStroke / insideRect;
      for (let c = 0; c < 3; c++) {
        data[offset + c] = Math.round(BACKGROUND[c] + (FOREGROUND[c] - BACKGROUND[c]) * t);
      }
      data[offset + 3] = Math.round((insideRect / total) * 255);
    }
  }

  return { width: size, height: size, data };
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit, filter 0 scanlines, zlib IDAT).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(image) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeIcon(relativePath, size, options) {
  const png = encodePng(render(size, options));
  const target = join(projectRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  console.log(`Wrote ${relativePath} (${size}x${size}, ${png.length} bytes)`);
}

writeIcon("app/icon.png", 32);
writeIcon("app/apple-icon.png", 180, { fullBleed: true });
writeIcon("public/icons/icon-192.png", 192);
writeIcon("public/icons/icon-512.png", 512);
writeIcon("public/icons/icon-maskable-512.png", 512, { fullBleed: true });
