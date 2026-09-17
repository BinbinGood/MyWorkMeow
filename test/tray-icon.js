'use strict';

// 托盘（macOS 菜单栏 / Windows 通知区域）图标尺寸的回归防线。
//
// 背景：这里曾经写死 `resize({ width: 32, height: 32 })`。32pt 的框配上
// assets/salary-cat-tray.png（猫本体占画布 92%），等效墨迹 29.5pt —— 比菜单栏本身
// 还高（实测刘海机型 33pt、非刘海 24pt），于是在菜单栏里顶满上下、还拖出一块底色
// 方块。这类回归没法靠「看一眼代码」发现：`32` 是个完全合理的数字，只有把它和
// 资源文件的实际留白、以及菜单栏的真实高度放在一起算，才能看出它越界。
//
// 所以这里不查字面量，而是按真实资源算出等效墨迹尺寸再卡区间。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// 非刘海机型的菜单栏高度，作为「不能顶满」的硬上限参照。刘海机型实测 33pt 更宽松，
// 所以按 24 卡是更严格的那一侧。
const MENU_BAR_PT = 24;
const TRAY_PNG = path.join(root, 'assets', 'salary-cat-tray.png');

async function main_() {
  const ptMatch = main.match(/const TRAY_ICON_PT = (\d+);/);
  assert(ptMatch, 'main.js must declare TRAY_ICON_PT so the tray size stays greppable');
  const TRAY_ICON_PT = Number(ptMatch[1]);

  const scaleMatch = main.match(/const TRAY_ICON_SCALE = (\d+);/);
  assert(scaleMatch, 'main.js must declare TRAY_ICON_SCALE');
  const TRAY_ICON_SCALE = Number(scaleMatch[1]);

  assert(TRAY_ICON_SCALE >= 2, 'the tray bitmap must be at least 2x, otherwise Retina renders it blurry');
  assert(
    /nativeImage\.createFromBuffer\(scaled\.toPNG\(\), \{ scaleFactor: TRAY_ICON_SCALE \}\)/.test(main),
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

  // 按真实资源量出猫本体的占比，再把 TRAY_ICON_PT 折算成实际可见的墨迹高度。
  assert(fs.existsSync(TRAY_PNG), 'the generated 月薪喵 tray avatar must ship with the app');
  const { data, info } = await sharp(TRAY_PNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[((y * width + x) * channels) + 3] > 16) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  assert(y1 >= y0, 'the tray avatar must not be fully transparent');
  const inkRatio = (y1 - y0 + 1) / height;
  const inkPt = TRAY_ICON_PT * inkRatio;

  // 现在的 18pt 框 ⇒ 约 16.6pt 墨迹。留出富余：上限卡到 20pt，
  // 也就是仍然比 24pt 的菜单栏矮一截、上下有可见留白。
  assert(inkPt <= 20, `the tray cat would be ${inkPt.toFixed(1)}pt tall — too tall for a ${MENU_BAR_PT}pt menu bar`);
  assert(inkPt >= 10, `the tray cat would be only ${inkPt.toFixed(1)}pt tall — too small to read`);
  assert(TRAY_ICON_PT * TRAY_ICON_SCALE >= 32, 'the tray bitmap must be at least 32px so Retina has real pixels to use');

  console.log(`tray icon checks passed (host ${TRAY_ICON_PT}pt -> cat ~${inkPt.toFixed(1)}pt, bitmap ${TRAY_ICON_PT * TRAY_ICON_SCALE}px)`);
}

main_().catch((error) => {
  console.error(error);
  process.exit(1);
});
