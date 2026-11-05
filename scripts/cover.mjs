// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-teal gradient, a
// door with its handle, and an Akuvox-style door phone beside it (camera,
// screen, keypad) with an open padlock arc. Plain Node (zlib), no dependency
// (from gladys-remootio).
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [12, 22, 40];
const TEAL = [16, 120, 140];
const WHITE = [255, 255, 255];
const AMBER = [255, 196, 70];
const GREY = [60, 72, 90];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  if (y > 450) color = mix(color, DARK, 0.35);
  // The door: a frame, a panel, a handle.
  color = mix(color, WHITE, smooth(4, Math.abs(roundedBox(x, y, 300, 285, 120, 175, 6))));
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 300, 285, 104, 160, 4)) * 0.18);
  color = mix(color, AMBER, smooth(1, roundedBox(x, y, 380, 300, 22, 7, 4)));
  // The door phone: body, camera, screen, keypad.
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 560, 270, 62, 130, 18)) * 0.95);
  color = mix(color, GREY, smooth(1, Math.hypot(x - 560, y - 172) - 13));
  color = mix(color, GREY, smooth(1, roundedBox(x, y, 560, 235, 42, 32, 6)));
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      color = mix(
        color,
        GREY,
        smooth(1, roundedBox(x, y, 532 + col * 28, 300 + row * 28, 9, 9, 3)),
      );
    }
  }
  // The call button, lit.
  color = mix(color, AMBER, smooth(1, Math.hypot(x - 560, y - 375) - 14));
  // An open padlock above the door phone.
  color = mix(color, AMBER, smooth(1, roundedBox(x, y, 680, 120, 30, 24, 6)));
  const shackle = Math.hypot(x - 668, y - 90);
  if (y < 96) color = mix(color, AMBER, smooth(3, Math.abs(shackle - 20)) * 0.95);
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
