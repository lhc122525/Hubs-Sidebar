'use strict';
/**
 * 扩展 Logo 生成器 —— 「侧栏 + 内容线」隐喻（64 单位 viewBox，与指定 SVG 设计一致）：
 *   左侧竖向胶囊侧栏（rx11，#4F9CF9→#7B61FF 渐变）内含白色标题条与三级透明度圆点，
 *   右侧三行长短递减的渐变内容线（#4F9CF9→#8B5CF6），呼应「分屏面板 + 应用列表」。
 * 渐变按 userSpaceOnUse 端点线性插值（超出端点截断 pad），
 * 纯 node 光栅化（SDF 抗锯齿 + 3x3 超采样，画家算法 back→front 逐层合成）
 * + 手写 PNG 编码（zlib IDAT），不依赖任何第三方库。
 * 用法：node icons/gen-logo.js
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

/* ---------------- 设计稿（64 单位用户坐标系） ---------------- */

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const WHITE = [255, 255, 255];

// 线性渐变（userSpaceOnUse：端点 p0→p1，颜色 c0→c1，越界截断）
const GR_SIDEBAR = { p0: [2, 2], p1: [24, 62], c0: hex('#4F9CF9'), c1: hex('#7B61FF') };
const GR_LINE = { p0: [26, 2], p1: [62, 62], c0: hex('#4F9CF9'), c1: hex('#8B5CF6') };

// 图层按 back → front 排列（画家算法，后画的叠在上面）
const SHAPES = [
  { kind: 'rect', x: 2, y: 2, w: 22, h: 60, r: 11, fill: GR_SIDEBAR, a: 1 }, // 侧栏
  { kind: 'rect', x: 7, y: 8, w: 12, h: 3, r: 1.5, fill: WHITE, a: 0.95 }, // 标题条
  { kind: 'circ', cx: 13, cy: 17, r: 3, fill: WHITE, a: 0.9 }, // 导航点 1
  { kind: 'circ', cx: 13, cy: 32, r: 3, fill: WHITE, a: 0.75 }, // 导航点 2
  { kind: 'circ', cx: 13, cy: 47, r: 3, fill: WHITE, a: 0.6 }, // 导航点 3
  { kind: 'rect', x: 26, y: 14, w: 36, h: 6, r: 3, fill: GR_LINE, a: 1 }, // 内容线 1
  { kind: 'rect', x: 26, y: 29, w: 28, h: 6, r: 3, fill: GR_LINE, a: 1 }, // 内容线 2
  { kind: 'rect', x: 26, y: 44, w: 20, h: 6, r: 3, fill: GR_LINE, a: 1 }, // 内容线 3
];

/* ---------------- 光栅化 ---------------- */

const VB = 64; // viewBox 边长（用户单位）
const SS = 3; // 每像素 3x3 超采样

/** 圆角矩形 SDF（负值在内部，用户单位） */
function rrSDF(px, py, x0, y0, w, h, r) {
  const cx = Math.max(x0 + r, Math.min(px, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(py, y0 + h - r));
  return Math.hypot(px - cx, py - cy) - r;
}

function shapeSDF(s, ux, uy) {
  if (s.kind === 'circ') return Math.hypot(ux - s.cx, uy - s.cy) - s.r;
  return rrSDF(ux, uy, s.x, s.y, s.w, s.h, s.r);
}

/** 取填充色：固定色或按用户坐标求值的线性渐变 */
function fillColor(f, ux, uy) {
  if (Array.isArray(f)) return f;
  const dx = f.p1[0] - f.p0[0];
  const dy = f.p1[1] - f.p0[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((ux - f.p0[0]) * dx + (uy - f.p0[1]) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t)); // pad 截断
  return [
    f.c0[0] + (f.c1[0] - f.c0[0]) * t,
    f.c0[1] + (f.c1[1] - f.c0[1]) * t,
    f.c0[2] + (f.c1[2] - f.c0[2]) * t,
  ];
}

function render(size) {
  const u = size / VB;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let aAcc = 0, rAcc = 0, gAcc = 0, bAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / u;
          const uy = (y + (sy + 0.5) / SS) / u;
          // 画家算法逐层 over 合成（色为非预乘，a 为累计透明度）
          let a = 0, r = 0, g = 0, b = 0;
          for (const s of SHAPES) {
            const d = shapeSDF(s, ux, uy);
            const cov = Math.min(1, Math.max(0, 0.5 - d * u)); // SDF 转设备像素后反走样
            if (cov <= 0) continue;
            const sa = cov * s.a;
            const c = fillColor(s.fill, ux, uy);
            const outA = sa + a * (1 - sa);
            if (outA > 0) {
              const k = a * (1 - sa);
              r = (c[0] * sa + r * k) / outA;
              g = (c[1] * sa + g * k) / outA;
              b = (c[2] * sa + b * k) / outA;
            }
            a = outA;
          }
          aAcc += a;
          if (a > 0) {
            rAcc += r * a;
            gAcc += g * a;
            bAcc += b * a;
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

  // 校验 2：像素语义（取用户坐标所在像素）
  const px = (x, y) => Array.from(rgba.slice((y * size + x) * 4, (y * size + x) * 4 + 4));
  const at = (ux, uy) => px(Math.min(size - 1, Math.floor(ux * (size / VB))), Math.min(size - 1, Math.floor(uy * (size / VB))));
  const c = at(13, 25); // 侧栏中心（圆点之间）：蓝紫渐变、不透明
  const line = at(44, 17); // 内容线 1 中心：蓝紫渐变
  const head = at(13, 9.5); // 标题条：白色叠于侧栏（白 0.95 叠蓝渐变后蓝通道仍偏高，只比红通道）
  const gap = at(25, 20); // 侧栏与内容线之间：透明
  const corner = at(1, 1); // 画布左上角：透明
  // 16px 下内容线仅 1.5 设备像素高，AA 使 alpha 封顶在 ~227，阈值放宽
  const blueOk = c[2] > 200 && c[2] >= c[0] && line[2] > 180 && line[3] >= (size >= 32 ? 250 : 200);
  // 侧栏与内容线间隙仅 2 用户单位，128px 以下会被 AA 封成接缝，小尺寸改查画布角落
  const alphaOk = c[3] >= 250 && (size >= 128 ? gap[3] <= 60 : corner[3] <= 60);
  // 小尺寸下标题条不足 2 像素高，仅 32px 起校验「白」
  const whiteOk = size >= 32 ? head[0] > 200 : true;
  console.log(
    `icon-${size}.png  ${png.length}B  sig:${sigOk} dims:${dimsOk} blue:${blueOk} alpha:${alphaOk} white:${whiteOk}`
  );
}
console.log('done');
