#!/usr/bin/env node
'use strict';

// 把 assets/salary-cat.png 烘成 macOS app bundle 图标 assets/salary-cat.icns。
//
// 为什么要预先烘、而不是让 electron-builder 直接吃那张 PNG：
//   1) electron-builder 遇到非 .icns 的 mac.icon 会去 GitHub 下载 icons 工具链
//      （app-builder-lib/out/util/toolsets/icons）。打包这件事应该离线可重复，
//      不该每台新机器第一次打包都依赖一次外网；
//   2) 自己烘才能控制留白。macOS 的 Dock/Finder 不会替你缩，Info.plist 指到的
//      位图是多大就按多大画 —— 源图墨迹占满 90% 画布，直接转出来的图标在 Dock
//      里会明显比系统自带 app 大一圈、显得「突出来」。
//
// 两个后处理：
//   · 裁掉透明边：先用 alpha bbox 找出真实墨迹范围，避免把源图自带的空白
//     也算进图形尺寸（否则下面那个 82% 就名不副实）。
//   · 按 INK_RATIO 缩进再补透明边：Apple 自家图标的墨迹大约占画布 82%
//     （squircle 外接方形留白），照这个比例排才和 Dock 里的邻居一样大。
//
// 诚实的局限：源图只有 512×512，而 icns 需要 1024（icon_512x512@2x）。那一档
// 只能从 512 放大，Retina Dock 最大尺寸下会比真 1024 源偏软。这里的做法是把
// 那次放大变成显式的、单次 Lanczos3，而不是交给下游随便插值。真要解决需要一张
// ≥1024 的源图。assets/pingu-tray.svg 是菜单栏企鹅、不是 app 主标，没有矢量路线。
//
// 改图或改尺寸都跑这个脚本，不要手改 icns：
//   npm run icns:build
//
// 产物随仓库入库（和 assets/pingu-tray.png 一样），所以 package:mac 不链它 ——
// 只有换图标源时才需要手动跑一次。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'assets', 'salary-cat.png');
const OUT = path.join(root, 'assets', 'salary-cat.icns');

// 墨迹占画布的比例。0.82 ≈ Apple 自家图标的观感；调大图标在 Dock 里会显得比
// 邻居突出，调小则显得缩水。
const INK_RATIO = 0.82;

// 判定「有墨」的 alpha 阈值。太低会把 PNG 边缘的抗锯齿羽化也算成墨迹，
// 裁出来的框就会比真实图形大一圈。和 build-tray-icon.js 保持一致。
const ALPHA_MIN = 16;

// icns 需要的像素档位。iconutil 认的是 .iconset 里的文件名而不是内容，
// 所以 32/64/256/512 这些共享尺寸要按两个名字各写一份（见 ICONSET_NAMES）。
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

// 每个像素尺寸对应的 .iconset 文件名（可能多个）。这张表就是 Apple 的格式要求，
// 少一个名字 iconutil 不报错、但那一档在系统里就是缺的。
const ICONSET_NAMES = {
  16: ['icon_16x16'],
  32: ['icon_16x16@2x', 'icon_32x32'],
  64: ['icon_32x32@2x'],
  128: ['icon_128x128'],
  256: ['icon_128x128@2x', 'icon_256x256'],
  512: ['icon_256x256@2x', 'icon_512x512'],
  1024: ['icon_512x512@2x'],
};

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
  if (x1 < x0) throw new Error('salary-cat.png is fully transparent — nothing to bake');
  return { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('build-icns.js 只能在 macOS 上跑：生成 .icns 依赖系统自带的 /usr/bin/iconutil，'
      + '没有跨平台替代。已入库的 assets/salary-cat.icns 可直接使用，只有换图标源时才需要重烘。');
  }
  if (!fs.existsSync(SRC)) throw new Error(`missing icon source: ${SRC}`);

  const src = fs.readFileSync(SRC);
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = bbox(data, info.width, info.height, info.channels);

  // 注意：extract / resize / extend 不能串在同一条 sharp 管线里 —— sharp 会把
  // extend 排到 resize 之后执行，于是补边会加在已经缩好的输出上，得到的是
  // (inner + 2*pad) 而不是 size。每一档都必须各自 toBuffer。
  // （build-tray-icon.js:119-121 踩过同一个坑。）
  const tight = await sharp(src)
    .extract({ left: box.x0, top: box.y0, width: box.width, height: box.height })
    .png()
    .toBuffer();

  const iconsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-icns-')) + path.sep + 'salary-cat.iconset';
  fs.mkdirSync(iconsetDir, { recursive: true });

  for (const size of SIZES) {
    const inner = Math.round(size * INK_RATIO);
    const scaled = await sharp(tight)
      .resize(inner, inner, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: 'lanczos3',
      })
      .png()
      .toBuffer();

    // 奇偶差 1px 时把多的那一格放在右/下，图形仍然视觉居中。
    const padLeft = Math.floor((size - inner) / 2);
    const padTop = padLeft;
    const framed = await sharp(scaled)
      .extend({
        top: padTop,
        bottom: size - inner - padTop,
        left: padLeft,
        right: size - inner - padLeft,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    for (const name of ICONSET_NAMES[size]) {
      fs.writeFileSync(path.join(iconsetDir, `${name}.png`), framed);
    }
  }

  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', OUT]);
  fs.rmSync(path.dirname(iconsetDir), { recursive: true, force: true });

  // 按边长比报，才和 INK_RATIO 是同一个量纲（面积比会让两个数字看起来自相矛盾）。
  const srcRatio = (Math.max(box.width, box.height) / Math.max(info.width, info.height)) * 100;
  console.log(`source   ${path.relative(root, SRC)}  ${info.width}x${info.height}px  (ink ${box.width}x${box.height} = ${srcRatio.toFixed(1)}% of canvas edge)`);
  console.log(`baked    ${path.relative(root, OUT)}  ${fs.statSync(OUT).size} bytes`);
  console.log(`sizes    ${SIZES.join(' / ')}px  ink ${(INK_RATIO * 100).toFixed(0)}% of each frame`);
  console.log(`note     1024 档由 ${info.width}px 源图单次 Lanczos3 放大而来 —— Retina Dock 最大档会偏软，需要 >=1024 源图才能真正解决。`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
