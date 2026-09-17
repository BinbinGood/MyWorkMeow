'use strict';

// 托盘（macOS 菜单栏 / Windows 通知区域）图标尺寸的回归防线。
//
// 背景：这里曾经写死 `resize({ width: 32, height: 32 })`。32pt 的框配上当时的资源
// （墨迹占画布 92%），等效墨迹 29.5pt —— 比菜单栏本身还高（实测刘海机型 33pt、
// 非刘海 24pt），于是在菜单栏里顶满上下、还拖出一块底色方块。这类回归没法靠
// 「看一眼代码」发现：`32` 是个完全合理的数字，只有把它和资源文件的实际留白、
// 以及菜单栏的真实高度放在一起算，才能看出它越界。
//
// 所以这里不查字面量，而是按真实资源算出等效墨迹尺寸再卡区间。
//
// 现在的资源是企鹅（assets/pingu-tray.png，由 scripts/build-tray-icon.js 从
// assets/pingu-tray.svg 烘出）。烘焙那步做了两件事，缺一个都会在菜单栏里露馅：
//   · 裁掉透明边 —— 矢量原件墨迹只占 y[168,1023]，上方 16% 是空的，不裁就会下坠；
//   · 补成正方形 —— 裁完是 1024×857 的扁矩形，不补就无法在方框里上下居中。
// 所以除了「墨迹多大」，这里还要守住「墨迹是否居中」。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// 非刘海机型的菜单栏高度，作为「不能顶满」的硬上限参照。刘海机型实测 33pt 更宽松，
// 所以按 24 卡是更严格的那一侧。
const MENU_BAR_PT = 24;
const TRAY_PNG = path.join(root, 'assets', 'pingu-tray.png');
const TRAY_SVG = path.join(root, 'assets', 'pingu-tray.svg');
const BAKE_SCRIPT = path.join(root, 'scripts', 'build-tray-icon.js');

async function main_() {
  const ptMatch = main.match(/const TRAY_ICON_PT = (\d+);/);
  assert(ptMatch, 'main.js must declare TRAY_ICON_PT so the tray size stays greppable');
  const TRAY_ICON_PT = Number(ptMatch[1]);

  const scaleMatch = main.match(/const TRAY_ICON_SCALE = (\d+);/);
  assert(scaleMatch, 'main.js must declare TRAY_ICON_SCALE');
  const TRAY_ICON_SCALE = Number(scaleMatch[1]);

  assert(TRAY_ICON_SCALE >= 2, 'the tray bitmap must be at least 2x, otherwise Retina renders it blurry');
  assert(
    /nativeImage\.createFromBuffer\(sized\.toPNG\(\), \{ scaleFactor: TRAY_ICON_SCALE \}\)/.test(main),
    'the tray icon must hand Tray a bitmap whose scaleFactor makes its logical size TRAY_ICON_PT',
  );
  assert(
    /const px = TRAY_ICON_PT \* TRAY_ICON_SCALE;/.test(main),
    'the tray bitmap must be derived from TRAY_ICON_PT, not a hardcoded pixel size',
  );
  assert(
    !/resize\(\{ width: 32, height: 32 \}\)/.test(main),
    'the oversized 32pt tray icon must not come back',
  );
  // 尺寸已经 1:1 时不能再过一遍 resize —— 眼白在 36px 下只有 1.9px 宽，二次采样会抹掉。
  assert(
    /size\.width === px && size\.height === px/.test(main),
    'the tray icon must skip the resize when the baked bitmap already matches TRAY_ICON_PT',
  );

  // 位图的来源要可复跑：矢量原件 + 烘焙脚本都得在仓库里。
  assert(fs.existsSync(TRAY_SVG), 'the tray vector source must ship so the bitmap can be re-baked');
  assert(fs.existsSync(BAKE_SCRIPT), 'scripts/build-tray-icon.js must ship so the bitmap can be re-baked');
  assert(fs.existsSync(TRAY_PNG), 'the baked Pingu tray bitmap must ship with the app');

  const { data, info } = await sharp(TRAY_PNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const target = TRAY_ICON_PT * TRAY_ICON_SCALE;

  // 位图必须就是目标像素 —— 否则 main.js 会走 resize 分支做二次采样，眼白会糊。
  assert(
    width === target && height === target,
    `assets/pingu-tray.png is ${width}x${height}px but the tray needs ${target}x${target}px `
    + `(TRAY_ICON_PT ${TRAY_ICON_PT} x TRAY_ICON_SCALE ${TRAY_ICON_SCALE}) — re-run: node scripts/build-tray-icon.js`,
  );

  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[((y * width + x) * channels) + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  assert(y1 >= y0 && x1 >= x0, 'the tray avatar must not be fully transparent');

  const inkW = x1 - x0 + 1;
  const inkH = y1 - y0 + 1;
  const inkPt = TRAY_ICON_PT * (inkH / height);

  // 现在的 18pt 框 ⇒ 约 16.0pt 墨迹。留出富余：上限卡到 20pt，
  // 也就是仍然比 24pt 的菜单栏矮一截、上下有可见留白。
  assert(inkPt <= 20, `the tray icon would be ${inkPt.toFixed(1)}pt tall — too tall for a ${MENU_BAR_PT}pt menu bar`);
  assert(inkPt >= 10, `the tray icon would be only ${inkPt.toFixed(1)}pt tall — too small to read`);
  assert(target >= 32, 'the tray bitmap must be at least 32px so Retina has real pixels to use');

  // 墨迹必须居中。矢量原件上方有 16% 透明边，谁把烘焙脚本的 trim/extend 去掉，
  // 企鹅就会在菜单栏里往下坠 —— 而「尺寸对不对」是查不出这件事的。
  const offX = Math.abs((x0 + x1) / 2 - (width - 1) / 2);
  const offY = Math.abs((y0 + y1) / 2 - (height - 1) / 2);
  assert(offX <= 1, `the tray ink is off-centre horizontally by ${offX.toFixed(1)}px — re-run scripts/build-tray-icon.js`);
  assert(offY <= 1, `the tray ink is off-centre vertically by ${offY.toFixed(1)}px — re-run scripts/build-tray-icon.js`);

  console.log(`tray icon checks passed (host ${TRAY_ICON_PT}pt -> ink ${inkW}x${inkH}px = ${(inkW / TRAY_ICON_SCALE).toFixed(1)}x${inkPt.toFixed(1)}pt, bitmap ${target}px, centred)`);
}

main_().catch((error) => {
  console.error(error);
  process.exit(1);
});
