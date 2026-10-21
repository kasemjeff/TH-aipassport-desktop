// Icon generator: the app's mark, rasterised by hand.
//
// No image library, no design file — the mark is the one the window already
// draws in `desktop/ui/index.html`: a terracotta rounded square with the
// white four-point star. The shapes are sampled 8x per pixel (4x at the big
// sizes) and averaged, so the edges are smooth at every size instead of
// stair-stepped. Writes the PNGs Tauri wants plus a PNG-compressed .ico, so
// a rebuild never depends on an asset that lives on somebody's disk.
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- the shapes */

// The window draws the mark in a 24-unit box (viewBox="0 0 24 24"). Every
// coordinate below is in that box, so the icon and the window's logo are
// the same geometry rather than two drawings that drift apart.
const BOX = 24;

// The rounded square: 1..23, radius 7 — the window's `<rect x="1" y="1"
// width="22" height="22" rx="7">`.
const SQUARE = { x: 1, y: 1, w: 22, h: 22, r: 7 };

/**
 * The four-point star: tips `tip` from the centre, hollows `hollow` out.
 *
 * The window's `<path d="M12 5.6l1.9 4.5 4.5 1.9-4.5 1.9L12 18.4l-1.9-4.5
 * L5.6 12l4.5-1.9z">` is the same shape: tips at 6.4, hollows at 1.9 on
 * each axis.
 */
function star(tip, hollow) {
  const h = hollow / Math.SQRT2; // the hollow's offset on each axis
  return [
    [12, 12 - tip], [12 + h, 12 - h], [12 + tip, 12], [12 + h, 12 + h],
    [12, 12 + tip], [12 - h, 12 + h], [12 - tip, 12], [12 - h, 12 - h],
  ];
}

// The window's star, exactly.
const STAR = star(6.4, 1.9 * Math.SQRT2);

// The same star with thicker arms, for the small sizes. At 16px — the task
// bar at 100% scaling — the window's arms are thinner than a pixel and the
// hollows close up, so the mark would be a white blob. The correction is
// under a pixel at 24px and nobody sees two marks at once.
const STAR_BOLD = star(6.4, 2.45 * Math.SQRT2);

// The square's fill: the window's diagonal gradient, #e2a184 to #c96442.
const GRAD_FROM = [0xe2, 0xa1, 0x84];
const GRAD_TO = [0xc9, 0x64, 0x42];

// The star is white on the gradient, and white alone in the tray template.
const INK = [0xff, 0xff, 0xff];

/** Is (x, y) inside the rounded square? */
function inSquare(x, y) {
  const { x: sx, y: sy, w, h, r } = SQUARE;
  const x0 = sx, y0 = sy, x1 = sx + w, y1 = sy + h;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  // The straight band between the corner arcs.
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Is (x, y) inside `poly`? Even-odd, so the star's hollows count. */
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The square's fill at (x, y): the diagonal gradient of the window's logo. */
function gradientAt(x, y) {
  const { x: sx, y: sy, w, h } = SQUARE;
  const t = ((x - sx) / w + (y - sy) / h) / 2;
  return [
    Math.round(GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t),
    Math.round(GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t),
    Math.round(GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t),
  ];
}

/** `poly` scaled about the centre of the box by `k`. */
function scaled(poly, k) {
  return poly.map(([x, y]) => [12 + (x - 12) * k, 12 + (y - 12) * k]);
}

/**
 * The RGBA of the mark at `size`×`size`.
 *
 * `kind` is 'app' — the rounded square with the star in it — or 'template',
 * the star alone, opaque, on a transparent ground. The macOS menu bar draws
 * a template image as a mask, so only its alpha matters: the square would
 * be a solid blob there, with the star invisible inside it.
 */
function raster(size, kind) {
  const ss = size <= 64 ? 8 : 4; // samples per pixel, per axis
  const step = BOX / (size * ss);
  // The template's star is drawn larger: the menu bar is 22pt tall and the
  // square's star, at window size, would be a speck in it.
  const star = kind === 'template'
    ? scaled(STAR_BOLD, 1.55)
    : size <= 24 ? STAR_BOLD : STAR;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x * ss + sx + 0.5) * step;
          const uy = (y * ss + sy + 0.5) * step;
          let colour = null;
          if (kind === 'template') {
            if (inPolygon(ux, uy, star)) colour = INK;
          } else if (inSquare(ux, uy)) {
            colour = inPolygon(ux, uy, star) ? INK : gradientAt(ux, uy);
          }
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round(a / n);
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

/** PNG encoding of an RGBA buffer of `size`×`size` pixels. */
function pngFrom(px) {
  const size = Math.sqrt(px.length / 4);
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

/** The app's mark at `size`×`size`, as a PNG. */
function png(size) {
  return pngFrom(raster(size, 'app'));
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

/** The template's edge, in pixels — 44 is 22pt at the retina scale the menu
 * bar uses. The Rust side embeds the same number (TEMPLATE_EDGE). */
const TEMPLATE_SIZE = 44;
const templateRgba = raster(TEMPLATE_SIZE, 'template');

const writes = [
  ['32x32.png', png(32)],
  ['128x128.png', png(128)],
  ['128x128@2x.png', png(256)],
  ['icon.png', png(512)],
  ['icon.ico', ico([16, 24, 32, 48, 64, 128, 256])],
  ['template.png', pngFrom(templateRgba)],
  ['template.rgba', templateRgba],
];
for (const [name, bytes] of writes) {
  fs.writeFileSync(path.join(HERE, name), bytes);
  process.stdout.write(`${name.padEnd(16)} ${bytes.length} bytes\n`);
}
