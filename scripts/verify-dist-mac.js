'use strict';

// macOS 版的 dist 校验。为什么不复用 scripts/verify-dist.js：
//   · 它第 36 行要求 dist 里只能有文件，而它断言的那套 latest.yml 内部一致性
//     （版本 / url / path / EXE 精确字节数）在 mac 侧没有对应物 ——
//     build.dmg.writeUpdateInfo 为 false，mac 本就没有自动更新通道。
//   · Windows 那份守着一个真实的活契约，改它只会把那个契约削弱。
//   · mac 侧也不发 SHA256SUMS.txt，所以它那套校验和比对在这里无对象可比。
//
// 这个脚本存在的理由：出新版本时不该靠人工逐项核对产物。它会挂载 DMG，检查真正
// 要交付给别人的那个 .app —— 签名、entitlements、版本号、sharp 原生库都在里面，
// dist 目录上看不出来。这几项才是「包能不能用」的判据；自产自校的校验和不是。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

// 一个健全的 Electron DMG（Electron framework + sharp + libvips）远超这个数。
// 这条能抓住「构建半途失败却留下一个小文件」——那种 DMG 是能过 hdiutil verify 的。
const MIN_DMG_BYTES = 50 * 1024 * 1024;

function artifactNames(version) {
  return [`WorkMeow-${version}-macOS-arm64.dmg`];
}

// codesign / hdiutil 把有用的信息写在 stderr，而且校验失败时退出码非 0 —— 两种
// 情况都要能拿到输出，所以用 spawnSync 合并两股流自己判断，而不是让调用方吃异常。
function run(file, args) {
  const proc = spawnSync(file, args, { encoding: 'utf8' });
  if (proc.error) return { ok: false, out: String(proc.error.message || proc.error) };
  return { ok: proc.status === 0, out: `${proc.stdout || ''}${proc.stderr || ''}` };
}

function codesign(args) {
  return run('/usr/bin/codesign', args);
}

function verifyApp(appPath, version) {
  const name = path.basename(appPath);

  // 1) 签名结构完整。--deep --strict 会一路查到嵌套的 Electron framework 和
  //    Helper，那几个才是 ad-hoc 场景下最容易出问题的地方。
  const strict = codesign(['--verify', '--deep', '--strict', appPath]);
  if (!strict.ok) throw new Error(`codesign --verify --deep --strict failed for ${name}:\n${strict.out}`);

  // 2) 这是整套校验里最重要的一条。没有 Apple 证书，build.mac.identity 必须是 "-"；
  //    一旦 electron-builder 或 macOS 升级导致签名被静默跳过，产物在别人机器上
  //    根本起不来，而 dist 目录看起来完全正常 —— 只有这一条能拦住。
  const info = codesign(['-dv', appPath]);
  if (!info.ok) throw new Error(`codesign -dv failed for ${name}:\n${info.out}`);
  if (!/Signature=adhoc/.test(info.out)) {
    throw new Error(`${name} is not ad-hoc signed — an unsigned arm64 bundle will not launch.\n${info.out}`);
  }

  // 3) 硬化运行时下必须有 disable-library-validation，否则 ad-hoc 签名的
  //    Electron framework（TeamIdentifier=not set）会被 library validation 拒掉。
  //    权限来自 app-builder-lib 自带的 entitlements.mac.plist 模板，本仓库没有
  //    build/ 目录去遮蔽它。构建期那条「缺少 disable-library-validation」的告警
  //    不可信（它只看 isHardenedRuntimeEnabledForSigning，从不读解析出的权限文件），
  //    所以这里做运行时确认。
  const ent = codesign(['-d', '--entitlements', '-', appPath]);
  if (!/disable-library-validation/.test(ent.out)) {
    throw new Error(`${name} is missing com.apple.security.cs.disable-library-validation`
      + ` — the ad-hoc signed Electron framework will be rejected under hardened runtime.\n${ent.out}`);
  }

  // 4) 防止把上一次构建当新版本发出去。
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const shortVersion = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  if (!shortVersion.ok) throw new Error(`cannot read CFBundleShortVersionString from ${name}:\n${shortVersion.out}`);
  const bundleVersion = shortVersion.out.trim();
  if (bundleVersion !== version) {
    throw new Error(`${name} reports version ${bundleVersion} but package.json says ${version}`);
  }

  // 5) sharp 的原生库必须成对存在。main.js:25 启动时同步 require 链到
  //    backend/gif-normalizer.js:5 的 require('sharp')，加载失败是硬崩 ——
  //    发生在任何界面画出来之前。.node 靠 LC_RPATH @loader_path/../../
  //    sharp-libvips-darwin-arm64/lib 找 dylib，所以两者必须并列在 @img/ 下。
  const img = path.join(appPath, 'Contents', 'Resources', 'app', 'node_modules', '@img');
  const nodeDir = path.join(img, 'sharp-darwin-arm64', 'lib');
  const vipsDir = path.join(img, 'sharp-libvips-darwin-arm64', 'lib');
  if (!fs.existsSync(nodeDir)) throw new Error(`${name} is missing ${path.relative(appPath, nodeDir)}`);
  if (!fs.existsSync(vipsDir)) throw new Error(`${name} is missing ${path.relative(appPath, vipsDir)}`);
  if (!fs.readdirSync(nodeDir).some((f) => f.endsWith('.node'))) {
    throw new Error(`${name} has no sharp .node binary in ${path.relative(appPath, nodeDir)}`);
  }
  if (!fs.readdirSync(vipsDir).some((f) => /^libvips-cpp.*\.dylib$/.test(f))) {
    throw new Error(`${name} has no libvips-cpp dylib in ${path.relative(appPath, vipsDir)}`
      + ' — sharp will fail to dlopen at startup');
  }

  return bundleVersion;
}

function verifyMacDist(options = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('verify-dist-mac.js 只能在 macOS 上跑：校验依赖 hdiutil / codesign / plutil。');
  }

  const dist = options.dist || path.join(root, 'dist');
  const version = options.version || require(path.join(root, 'package.json')).version;
  const expected = artifactNames(version).sort();
  if (!fs.existsSync(dist)) throw new Error(`Missing build directory: ${dist}`);

  // mac-arm64/ 已被 finalize-dist-mac.js 删掉，所以这里和 Windows 侧一样可以
  // 要求 dist 只含文件 —— 残留目录说明 finalize 没跑或者跑失败了。
  const entries = fs.readdirSync(dist, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error('dist must contain files only');
  const actual = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected dist contents\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`);
  }

  const dmg = path.join(dist, `WorkMeow-${version}-macOS-arm64.dmg`);
  const dmgSize = fs.statSync(dmg).size;
  if (dmgSize < MIN_DMG_BYTES) {
    throw new Error(`DMG is only ${(dmgSize / 1024 / 1024).toFixed(1)} MB`
      + ` — a complete WorkMeow build is far larger than ${MIN_DMG_BYTES / 1024 / 1024} MB`);
  }

  // hdiutil verify 校验镜像内部的 checksum，所以「文件在传输/落盘中被损坏」这件事
  // 仍然有人管 —— 只是管的人从 SHA256SUMS.txt 换成了 DMG 自带的校验结构。
  const imageCheck = run('/usr/bin/hdiutil', ['verify', dmg]);
  if (!imageCheck.ok) throw new Error(`hdiutil verify failed:\n${imageCheck.out}`);

  // 挂载出来检查真正要交付的那个 .app。finally 里必须 detach，否则本脚本抛错
  // 会在系统里留下一个挂载卷（下次打包 attach 同名镜像就会打架）。
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-dmg-'));
  let appVersion;
  try {
    const attach = run('/usr/bin/hdiutil', [
      'attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mountPoint,
    ]);
    if (!attach.ok) throw new Error(`hdiutil attach failed:\n${attach.out}`);

    const apps = fs.readdirSync(mountPoint).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) {
      throw new Error(`expected exactly one .app in the DMG, found: ${apps.join(', ') || '(none)'}`);
    }
    appVersion = verifyApp(path.join(mountPoint, apps[0]), version);
  } finally {
    run('/usr/bin/hdiutil', ['detach', mountPoint, '-force']);
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }

  const result = {
    dist, version, files: actual, dmgSize, appVersion,
  };
  if (options.quiet !== true) {
    console.log(`Verified WorkMeow ${version} macOS dist:`
      + ` ${actual.length} file(s), ${(dmgSize / 1024 / 1024).toFixed(1)} MB DMG, ad-hoc signed app`);
  }
  return result;
}

if (require.main === module) {
  try {
    verifyMacDist();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = { artifactNames, verifyMacDist };
