// Icon generator: the app's mark, rasterised by hand.
//
// No image library, no design file — a 5x7 'a' bitmap scaled onto a rounded
// dark square. Writes the PNGs Tauri wants plus a PNG-compressed .ico, so a
// rebuild never depends on an asset that lives on somebody's disk.
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 5x7 lowercase 'a', 1 = ink. Two blank rows at the top so the letter sits on
// the baseline when it is scaled up hard.
const GLYPH = [
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 1],
  [0, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [0, 1, 1, 1, 1],
];

const BG = [0x0e, 0x11, 0x16, 0xff];
const INK = [0x7c, 0xc4, 0xff, 0xff];
const DIM = [0x3a, 0x6d, 0x99, 0xff];

/** RGBA raster of `size`×`size`. */
function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  // Rounded square background.
  const radius = Math.round(size * 0.18);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inX = x < radius || x >= size - radius;
      const inY = y < radius || y >= size - radius;
      if (inX && inY) {
        const cx = x < radius ? radius : size - radius - 1;
        const cy = y < radius ? radius : size - radius - 1;
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      }
      set(x, y, BG);
    }
  }

  // The glyph, scaled to fill most of the square, centred.
  const cell = Math.max(1, Math.floor((size * 0.56) / 5));
  const gw = cell * 5;
  const gh = cell * 7;
  const ox = Math.floor((size - gw) / 2);
  const oy = Math.floor((size - gh) / 2) + Math.round(size * 0.02);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (!GLYPH[row][col]) continue;
      const ink = row >= 4 ? INK : DIM; // the lower half carries the accent
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          set(ox + col * cell + dx, oy + row * cell + dy, ink);
        }
      }
    }
  }
  return px;
}

/* ------------------------------------------------------------- PNG writing */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const px = raster(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Windows icon: a directory of PNG-compressed images (Vista and later). */
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const size = sizes[i];
    dir[i * 16] = size >= 256 ? 0 : size; // 0 means 256
    dir[i * 16 + 1] = size >= 256 ? 0 : size;
    dir[i * 16 + 2] = 0;  // palette count
    dir[i * 16 + 3] = 0;  // reserved
    dir.writeUInt16LE(1, i * 16 + 4);   // colour planes
    dir.writeUInt16LE(32, i * 16 + 6);  // bits per pixel
    dir.writeUInt32LE(img.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += img.length;
  });
  return Buffer.concat([header, dir, ...images]);
}

const writes = [
  ['32x32.png', png(32)],
  ['128x128.png', png(128)],
  ['128x128@2x.png', png(256)],
  ['icon.png', png(512)],
  ['icon.ico', ico([16, 24, 32, 48, 64, 128, 256])],
];
for (const [name, bytes] of writes) {
  fs.writeFileSync(path.join(HERE, name), bytes);
  process.stdout.write(`${name.padEnd(16)} ${bytes.length} bytes\n`);
}
