// 纯 Node 生成 PWA 图标（无外部依赖，使用内置 zlib）。
// 绿色圆角底 + 白色冰箱图形 + 隔层/把手，超采样抗锯齿。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = path.join(__dirname, 'fridge-app');

// ---------- CRC32 ----------
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function writePNG(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[p++] = rgba[i]; raw[p++] = rgba[i + 1]; raw[p++] = rgba[i + 2]; raw[p++] = rgba[i + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
}

// ---------- 形状工具 ----------
function lerp(a, b, t) { return a + (b - a) * t; }
function inRound(x0, x1, y0, y1, r, px, py) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  if (px < x0 + r && py < y0 + r) { const dx = px - (x0 + r), dy = py - (y0 + r); if (dx * dx + dy * dy > r * r) return false; }
  if (px > x1 - r && py < y0 + r) { const dx = px - (x1 - r), dy = py - (y0 + r); if (dx * dx + dy * dy > r * r) return false; }
  if (px < x0 + r && py > y1 - r) { const dx = px - (x0 + r), dy = py - (y1 - r); if (dx * dx + dy * dy > r * r) return false; }
  if (px > x1 - r && py > y1 - r) { const dx = px - (x1 - r), dy = py - (y1 - r); if (dx * dx + dy * dy > r * r) return false; }
  return true;
}

// 标准图标：圆角绿底（外有透明），白色冰箱居中
function colorStd(u, v) {
  const m = 0.07, br = 0.19;
  if (!inRound(m, 1 - m, m, 1 - m, br, u, v)) return [0, 0, 0, 0];
  const t = v;
  let r = lerp(52, 28, t), g = lerp(199, 160, t), b = lerp(89, 74, t);
  const fx0 = 0.25, fx1 = 0.75, fy0 = 0.14, fy1 = 0.86, fr = 0.10;
  if (inRound(fx0, fx1, fy0, fy1, fr, u, v)) {
    r = 255; g = 255; b = 255;
    if (u > fx0 + 0.02 && u < fx1 - 0.02 && v > 0.39 && v < 0.415) { r = 210; g = 216; b = 212; }
    if (u > 0.685 && u < 0.715 && ((v > 0.18 && v < 0.32) || (v > 0.46 && v < 0.80))) { r = 210; g = 216; b = 212; }
  }
  return [r, g, b, 255];
}

// 可遮罩图标：全幅绿底（无透明），冰箱缩小居中（安全区 80%）
function colorMask(u, v) {
  const t = v;
  let r = lerp(52, 28, t), g = lerp(199, 160, t), b = lerp(89, 74, t);
  const s = 0.86, cx = 0.5, cy = 0.5;
  const fx0 = cx - 0.25 * s, fx1 = cx + 0.25 * s, fy0 = cy - 0.36 * s, fy1 = cy + 0.36 * s, fr = 0.10 * s;
  if (inRound(fx0, fx1, fy0, fy1, fr, u, v)) {
    r = 255; g = 255; b = 255;
    const dv = fy0 + (fy1 - fy0) * 0.40;
    if (u > fx0 + 0.02 * s && u < fx1 - 0.02 * s && v > dv - 0.012 && v < dv + 0.012) { r = 210; g = 216; b = 212; }
    const hx = cx + 0.18 * s;
    if (u > hx - 0.015 && u < hx + 0.015) {
      const a0 = fy0 + (fy1 - fy0) * 0.10, a1 = fy0 + (fy1 - fy0) * 0.23;
      const b0 = fy0 + (fy1 - fy0) * 0.46, b1 = fy0 + (fy1 - fy0) * 0.80;
      if ((v > a0 && v < a1) || (v > b0 && v < b1)) { r = 210; g = 216; b = 212; }
    }
  }
  return [r, g, b, 255];
}

function render(file, N, fn) {
  const S = 4; // 超采样
  const rgba = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / N;
          const v = (y + (sy + 0.5) / S) / N;
          const c = fn(u, v);
          R += c[0]; G += c[1]; B += c[2]; A += c[3];
        }
      }
      const i = (y * N + x) * 4;
      rgba[i] = Math.round(R / (S * S));
      rgba[i + 1] = Math.round(G / (S * S));
      rgba[i + 2] = Math.round(B / (S * S));
      rgba[i + 3] = Math.round(A / (S * S));
    }
  }
  writePNG(file, N, N, rgba);
  console.log('wrote', file, N + 'x' + N);
}

render(path.join(OUT, 'icon-192.png'), 192, colorStd);
render(path.join(OUT, 'icon-512.png'), 512, colorStd);
render(path.join(OUT, 'icon-maskable-512.png'), 512, colorMask);
console.log('done');
