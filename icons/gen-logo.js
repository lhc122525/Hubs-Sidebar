'use strict';
/**
 * 扩展 Logo 生成器 —— 「展开 / 收起」隐喻：
 *   一块大的圆角面板（展开的分屏内容）+ 右缘一条细竖条（收起的悬浮条 / 拉手），
 *   中间留空隙，抽象「右缘悬浮条 → 拉开为面板」的核心交互。
 * 品牌渐变 #6fd6ff → #4a7dff（对角），面板全不透明，拉手条 0.62 透明度，
 * 背景透明（浅色 / 深色工具栏均清晰）。
 * 几何（24 单位网格）：面板 x3.5 y4.5 w13 h15 rx2.6；条 x18.5 y8.75 w2.5 h6.5 rx1.3。
 * 纯 node 光栅化（SDF 抗锯齿 + 3x3 超采样）+ 手写 PNG 编码（zlib IDAT），
 * 不依赖任何第三方库。用法：node icons/gen-logo.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- CRC32 / PNG 编码 ---------------- */

function crc32(buf) {
  let t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let r = 0xffffffff;
  for (const b of buf) r = t[(r ^ b) & 0xff] ^ (r >>> 8);
  return (r ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 光栅化 ---------------- */

const C0 = [0x6f, 0xd6, 0xff]; // #6fd6ff
const C1 = [0x4a, 0x7d, 0xff]; // #4a7dff

// 面板（展开态，主体）+ 悬浮条（收起态拉手，次级）
const SHAPES = [
  { x: 3.5, y: 4.5, w: 13, h: 15, r: 2.6, a: 1 },
  { x: 18.5, y: 8.75, w: 2.5, h: 6.5, r: 1.3, a: 0.62 },
];
const SS = 3; // 每像素 3x3 超采样

/** 圆角矩形 SDF（负值在内部） */
function rrSDF(px, py, x0, y0, w, h, r) {
  const cx = Math.max(x0 + r, Math.min(px, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(py, y0 + h - r));
  return Math.hypot(px - cx, py - cy) - r;
}

function render(size) {
  const u = size / 24;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let aAcc = 0, rAcc = 0, gAcc = 0, bAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          for (const s of SHAPES) {
            const d = rrSDF(px, py, s.x * u, s.y * u, s.w * u, s.h * u, s.r * u);
            const cov = Math.min(1, Math.max(0, 0.5 - d)); // SDF 反走样覆盖度
            if (cov <= 0) continue;
            const t = (px + py) / (2 * size); // 对角渐变（canvas 语义）
            const w = cov * s.a;
            aAcc += w;
            rAcc += (C0[0] + (C1[0] - C0[0]) * t) * w;
            gAcc += (C0[1] + (C1[1] - C0[1]) * t) * w;
            bAcc += (C0[2] + (C1[2] - C0[2]) * t) * w;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (aAcc > 0) {
        rgba[i] = Math.round(rAcc / aAcc);
        rgba[i + 1] = Math.round(gAcc / aAcc);
        rgba[i + 2] = Math.round(bAcc / aAcc);
        rgba[i + 3] = Math.round((aAcc / (SS * SS)) * 255);
      }
    }
  }
  return rgba;
}

/* ---------------- 生成 + 自校验 ---------------- */

const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const rgba = render(size);
  const png = encodePNG(size, rgba);
  const file = path.join(__dirname, `icon-${size}.png`);
  fs.writeFileSync(file, png);

  // 校验 1：PNG 结构（签名 / IHDR 尺寸）
  const sigOk = png.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  const dimsOk = png.readUInt32BE(16) === size && png.readUInt32BE(20) === size;

  // 校验 2：像素语义（面板中心蓝且实、拉手条半透明、间隙透明）
  const px = (x, y) => Array.from(rgba.slice((y * size + x) * 4, (y * size + x) * 4 + 4));
  const m = size / 24;
  const c = px(Math.round(10 * m), Math.round(12 * m)); // 面板中心
  const bar = px(Math.round(19.75 * m), Math.round(12 * m)); // 拉手条中心
  const gap = px(Math.round(17 * m), Math.round(12 * m)); // 面板与条之间
  const blueOk = c[2] > 200 && c[2] >= c[0]; // 蓝色占优
  // 16px 等小尺寸下，间隙采样点的子采样会擦到相邻块边缘（AA），允许少量泄漏
  const alphaOk = c[3] >= 250 && Math.abs(bar[3] - Math.round(0.62 * 255)) <= 14 && gap[3] <= 70;
  console.log(
    `icon-${size}.png  ${png.length}B  sig:${sigOk} dims:${dimsOk} blue:${blueOk} alpha:${alphaOk}`
  );
}
console.log('done');
