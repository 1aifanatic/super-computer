/**
 * Generates the PWA icon set as real PNGs, with no image dependencies.
 *
 * There is no canvas or sharp here, so the icon is computed per pixel and
 * encoded by hand: rounded-square in the clay accent, white eight-ray burst on
 * top, 3x3 supersampled so the curves are not jagged. Deterministic output, so
 * re-running it produces byte-identical files.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "public");
mkdirSync(OUT, { recursive: true });

const CLAY = [0xc9, 0x64, 0x42];
const INK = [0x1f, 0x1e, 0x1d];
const WHITE = [0xff, 0xff, 0xff];

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10..12 = compression, filter, interlace = 0

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- The mark --------------------------------------------------------------

/** Signed coverage of a rounded square, in normalised -0.5..0.5 space. */
function insideRoundedSquare(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  if (dx <= 0 || dy <= 0) return Math.abs(x) <= half && Math.abs(y) <= half;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Eight-ray burst. `r(theta)` sweeps between an inner and outer radius so the
 * rays taper rather than ending in points, which reads better at 32px.
 */
const RAYS = 8;
/** Higher exponent = narrower rays. Below ~2 the mark reads as a flower. */
const TAPER = 3.2;

function insideBurst(x, y, rInner, rOuter) {
  const dist = Math.hypot(x, y);
  if (dist > rOuter) return false;
  if (dist <= rInner) return true;
  const theta = Math.atan2(y, x);
  const f = Math.abs(Math.cos((RAYS / 2) * theta));
  return dist <= rInner + (rOuter - rInner) * Math.pow(f, TAPER);
}

/**
 * @param size    pixel dimension
 * @param padding fraction of the canvas left empty around the tile. Maskable
 *                icons get a wide margin because launchers crop aggressively.
 * @param bg      background colour, or null for a transparent tile
 */
function render(size, { padding = 0, bg = CLAY, fg = WHITE } = {}) {
  const px = new Uint8Array(size * size * 4);
  const SS = 3; // supersampling factor per axis
  const half = 0.5 - padding;
  const radius = half * 0.44;
  const rOuter = half * 0.68;
  const rInner = half * 0.115;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size - 0.5;
          const ny = (y + (sy + 0.5) / SS) / size - 0.5;
          if (bg && insideRoundedSquare(nx, ny, half, radius)) bgHits++;
          if (insideBurst(nx, ny, rInner, rOuter)) fgHits++;
        }
      }
      const total = SS * SS;
      const bgA = bg ? bgHits / total : 0;
      const fgA = fgHits / total;

      // Composite foreground over background, then over transparency.
      const alpha = Math.max(bgA, fgA);
      let r, g, b;
      if (alpha === 0) {
        r = g = b = 0;
      } else {
        const t = fgA / Math.max(alpha, 1e-6);
        const base = bg ?? INK;
        r = base[0] * (1 - t) + fg[0] * t;
        g = base[1] * (1 - t) + fg[1] * t;
        b = base[2] * (1 - t) + fg[2] * t;
      }

      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  // Maskable icons are cropped to a circle by some launchers; the safe zone is
  // the middle 80%, so the tile is inset to survive it.
  ["icon-maskable-512.png", 512, { padding: 0.1 }],
  ["apple-touch-icon.png", 180, {}],
  ["favicon-32.png", 32, {}],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), encodePng(size, render(size, opts)));
  console.log(`  ${name.padEnd(24)} ${size}x${size}`);
}

// A vector copy for anywhere that prefers it (browser tabs on hi-dpi, docs).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#c96442"/>
  <path fill="#ffffff" d="${burstPath(50, 50, 34, 5.75, RAYS)}"/>
</svg>
`;
writeFileSync(join(OUT, "icon.svg"), svg);
console.log("  icon.svg");

function burstPath(cx, cy, rOuter, rInner, rays) {
  const pts = [];
  const steps = rays * 24;
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    const f = Math.abs(Math.cos((rays / 2) * th));
    const r = rInner + (rOuter - rInner) * Math.pow(f, TAPER);
    pts.push(`${(cx + r * Math.cos(th)).toFixed(2)},${(cy + r * Math.sin(th)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}
