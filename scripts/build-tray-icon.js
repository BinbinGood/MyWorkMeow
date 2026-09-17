#!/usr/bin/env node
'use strict';

// 把 assets/pingu-tray.svg 烘成菜单栏托盘用的位图 assets/pingu-tray.png。
//
// 为什么要烘、而不是运行时直接读 SVG：
//   1) Electron 的 nativeImage 读不了 SVG，Tray 只吃位图；
//   2) 这个图形里有「眼白」这种小特征 —— 在 1024 空间里 rx≈53，落到 36px 只剩
//      1.9px 宽。让 nativeImage 去缩 1024→36（1:0.035）会把它糊掉甚至抹平，
//      所以必须在矢量阶段用 Lanczos 一次性降到目标像素。
//
// 两个后处理（原图直接进托盘会出问题）：
//   · 裁掉透明边：原图墨迹只占 x[0.5,1023.5] y[167.8,1023.5]，
//     上方 16% 全是空的，直接居中会让企鹅在菜单栏里往下坠 1.5pt。
//   · 补成正方形：裁剪后是 1023×856 的扁矩形，补成正方形才能让墨迹在
//     18pt 的框里上下居中。
//
// 改图或改尺寸都跑这个脚本，不要手改 png：
//   node scripts/build-tray-icon.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'assets', 'pingu-tray.svg');
const OUT = path.join(root, 'assets', 'pingu-tray.png');

// 必须和 main.js 的 TRAY_ICON_PT / TRAY_ICON_SCALE 一致 —— 烘出来的像素尺寸正好等于
// Tray 要的位图尺寸，这样 main.js 那步 resize 是 1:1 的空操作，没有二次采样损失。
const TRAY_ICON_PT = 18;
const TRAY_ICON_SCALE = 2;
const PX = TRAY_ICON_PT * TRAY_ICON_SCALE; // 36px

// 先从矢量出这个大图，再降到 PX —— 给 Lanczos 足够的采样密度。
const HI = 1024;
// 判定「有墨」的 alpha 阈值。太低会把矢量的抗锯齿边缘也算成墨迹。
const ALPHA_MIN = 16;

function bbox(data, width, height, channels) {
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[((y * width + x) * channels) + 3] > ALPHA_MIN) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) throw new Error('pingu-tray.svg rendered fully transparent — nothing to bake');
  return { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`missing vector source: ${SRC}`);

  const hi = await sharp(SRC, { density: 72 })
    .resize(HI, HI, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const { data, info } = await sharp(hi).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = bbox(data, info.width, info.height, info.channels);

  const side = Math.max(box.width, box.height);
  const padX = side - box.width;
  const padY = side - box.height;

  // 注意：extend 和 resize 不能串在同一条 sharp 管线里 —— sharp 会把 extend 排到
  // resize 之后执行，于是 83/84 会被当成「输出像素」加在 36px 高的成品上，
  // 烘出来是 36×203 而不是 36×36。必须拆成两次 toBuffer。
  const tight = await sharp(hi)
    .extract({ left: box.x0, top: box.y0, width: box.width, height: box.height })
    .png()
    .toBuffer();

  const padded = await sharp(tight)
    .extend({
      top: Math.floor(padY / 2),
      bottom: Math.ceil(padY / 2),
      left: Math.floor(padX / 2),
      right: Math.ceil(padX / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const baked = await sharp(padded).resize(PX, PX, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();

  fs.writeFileSync(OUT, baked);

  const out = await sharp(baked).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const outBox = bbox(out.data, out.info.width, out.info.height, out.info.channels);
  const inkW = outBox.width;
  const inkH = outBox.height;
  const cx = outBox.x0 + (inkW - 1) / 2;
  const cy = outBox.y0 + (inkH - 1) / 2;

  console.log(`source   ${path.relative(root, SRC)}  (ink ${box.width}x${box.height} in ${HI}x${HI})`);
  console.log(`baked    ${path.relative(root, OUT)}  ${out.info.width}x${out.info.height}px = ${TRAY_ICON_PT}pt @${TRAY_ICON_SCALE}x`);
  console.log(`ink      ${inkW}x${inkH}px  = ${(inkW / TRAY_ICON_SCALE).toFixed(1)}x${(inkH / TRAY_ICON_SCALE).toFixed(1)}pt`);
  console.log(`centered dx=${(cx - (out.info.width - 1) / 2).toFixed(2)} dy=${(cy - (out.info.height - 1) / 2).toFixed(2)} (should be ~0)`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
