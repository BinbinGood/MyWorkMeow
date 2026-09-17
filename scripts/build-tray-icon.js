#!/usr/bin/env node
'use strict';

// 把 assets/pingu-tray.svg 烘成菜单栏托盘用的位图 assets/pingu-tray.png。
//
// 为什么要烘、而不是运行时直接读 SVG：
//   1) Electron 的 nativeImage 读不了 SVG，Tray 只吃位图；
//   2) 这个图形里有「眼白」「红喙」这种小特征 —— 眼白在 1024 空间里 rx≈53，
//      落到 36px 只剩 1.9px 宽。让 nativeImage 去缩 1024→36（1:0.035）会把它
//      糊掉甚至抹平，所以必须在矢量阶段用 Lanczos 一次性降到目标像素。
//
// 三个后处理（任意一个不做，拿到菜单栏里都会露馅）：
//   · 裁掉透明边：原图墨迹只占 x[0.5,1023.5] y[167.8,1023.5]，
//     上方 16% 全是空的，直接居中会让企鹅在菜单栏里往下坠 1.5pt。
//   · 补成正方形：裁剪后是 1023×856 的扁矩形，补成正方形才能让墨迹在
//     18pt 的框里上下居中。
//   · 加白色光晕（halo）：企鹅的身体是纯黑 #000，而 macOS 菜单栏是半透明的
//     —— 深色壁纸透出来时，黑身体和背景连成一片，只剩红喙黄腹浮着。沿整个
//     剪影向外扩一圈白，暗底上就有了轮廓；浅色菜单栏下白边自然隐去、本体
//     本来就清楚，所以一套图通吃深浅两种外观，不用做主题自适应。
//     用「形态学膨胀」而不是 SVG stroke：stroke 画在路径边界上、一半在形状
//     内侧（会啃掉企鹅本体），而且 SVG 画布只有 1024、向外那一半会被裁掉。
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

// 光晕厚度（pt）。光晕算在 TRAY_ICON_PT 之内，所以企鹅本体会相应缩小到
// (TRAY_ICON_PT - 2*光晕) —— 18pt 的框里本体约 15pt、总墨迹约 15.5pt 高，
// 和加光晕之前（16pt）的视觉体量基本一致。
// 1.2 ≈ 看得出轮廓但很轻；1.5 默认；2.0 已经偏重。
const HALO_PT = 1.5;
// 光晕颜色。纯白在深色菜单栏上最醒目；浅色菜单栏下与背景同色、不会显形。
const HALO_RGB = [255, 255, 255];

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

// 可分离的形态学膨胀（max filter）：先横向再纵向各扫一遍半径 r。
// 复杂度 O(w*h*r)，1024² / r=43 大约十几毫秒 —— 不值得为它引入依赖。
function dilate(mask, width, height, r) {
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const from = Math.max(0, x - r);
      const to = Math.min(width - 1, x + r);
      let hit = 0;
      for (let i = from; i <= to; i += 1) {
        if (mask[row + i]) { hit = 1; break; }
      }
      tmp[row + x] = hit;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const from = Math.max(0, y - r);
      const to = Math.min(height - 1, y + r);
      let hit = 0;
      for (let i = from; i <= to; i += 1) {
        if (tmp[(i * width) + x]) { hit = 1; break; }
      }
      out[(y * width) + x] = hit;
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`missing vector source: ${SRC}`);

  // 光晕在 1024 空间里占多少像素（= 它落到成品上是多少像素）
  const pad = Math.max(1, Math.round((HI / PX) * HALO_PT));
  const content = HI - (pad * 2);

  const hi = await sharp(SRC, { density: 72 })
    .resize(HI, HI, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const { data, info } = await sharp(hi).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = bbox(data, info.width, info.height, info.channels);

  // 注意：extend 和 resize 不能串在同一条 sharp 管线里 —— sharp 会把 extend 排到
  // resize 之后执行，于是 pad 会被当成「输出像素」加在 36px 高的成品上，
  // 烘出来是 36×203 而不是 36×36。必须每一步都拆开 toBuffer。
  const tight = await sharp(hi)
    .extract({ left: box.x0, top: box.y0, width: box.width, height: box.height })
    .png()
    .toBuffer();

  // 本体缩进 content 正方形（这一步同时完成了「裁边」和「补方居中」）
  const scaled = await sharp(tight)
    .resize(content, content, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();

  // 四周留出 pad，等下用光晕填满
  const staged = await sharp(scaled)
    .extend({
      top: pad, bottom: pad, left: pad, right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // 取 alpha → 膨胀 pad 像素 → 填成白底，再把本体叠上去
  const stage = await sharp(staged).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = stage.info.width;
  const height = stage.info.height;
  const mask = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < stage.data.length; i += 4, j += 1) {
    if (stage.data[i + 3] > ALPHA_MIN) mask[j] = 1;
  }
  const grown = dilate(mask, width, height, pad);
  const under = Buffer.alloc(width * height * 4);
  for (let j = 0; j < width * height; j += 1) {
    if (!grown[j]) continue;
    under[j * 4] = HALO_RGB[0];
    under[j * 4 + 1] = HALO_RGB[1];
    under[j * 4 + 2] = HALO_RGB[2];
    under[j * 4 + 3] = 255;
  }
  const haloLayer = await sharp(under, { raw: { width, height, channels: 4 } }).png().toBuffer();

  const merged = await sharp(haloLayer).composite([{ input: staged }]).png().toBuffer();
  const baked = await sharp(merged).resize(PX, PX, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();

  fs.writeFileSync(OUT, baked);

  const out = await sharp(baked).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const outBox = bbox(out.data, out.info.width, out.info.height, out.info.channels);
  const inkW = outBox.width;
  const inkH = outBox.height;
  const cx = outBox.x0 + ((inkW - 1) / 2);
  const cy = outBox.y0 + ((inkH - 1) / 2);

  console.log(`source   ${path.relative(root, SRC)}  (ink ${box.width}x${box.height} in ${HI}x${HI})`);
  console.log(`baked    ${path.relative(root, OUT)}  ${out.info.width}x${out.info.height}px = ${TRAY_ICON_PT}pt @${TRAY_ICON_SCALE}x  halo ${HALO_PT}pt`);
  console.log(`ink      ${inkW}x${inkH}px  = ${(inkW / TRAY_ICON_SCALE).toFixed(1)}x${(inkH / TRAY_ICON_SCALE).toFixed(1)}pt (含光晕)`);
  console.log(`centered dx=${(cx - ((out.info.width - 1) / 2)).toFixed(2)} dy=${(cy - ((out.info.height - 1) / 2)).toFixed(2)} (should be ~0)`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
