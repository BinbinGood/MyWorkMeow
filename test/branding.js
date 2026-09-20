'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BRAND = require('../shared/brand');
const i18n = require('../shared/i18n');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const main = read('main.js');
const readme = read('README.md');
const readmeEn = read('README_EN.md');
const credits = read('assets/cat/CREDITS.md');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

assert.strictEqual(pkg.name, 'workmeow');
assert.strictEqual(pkg.build.productName, BRAND.displayName);
assert.strictEqual(pkg.build.executableName, 'WorkMeow');
assert.strictEqual(pkg.build.appId, BRAND.appId);
assert.strictEqual(pkg.author, 'vista-zhang');
assert.strictEqual(pkg.repository.url, 'git+https://github.com/vista-zhangg/WorkMeow.git');
assert(pkg.build.files.includes('LICENSE'), 'packaged app must retain the upstream MIT license');
assert.strictEqual(pkg.build.win.artifactName, 'WorkMeow-${version}-Windows-${arch}.${ext}');
assert(/--publish never(?:\s|$)/.test(pkg.scripts['package:win']), 'Windows packaging must use the unified release job');
assert.strictEqual(pkg.build.mac.identity, '-',
  '没有 Apple 证书，mac bundle 必须显式 ad-hoc 签名 —— 完全无签名的 arm64 bundle 起不来');
// build.mac.icon 指向的东西必须是个真的存在的 .icns。指向不存在的路径、或者
// 指着一张 PNG，electron-builder 都不会报错：前者静默产出一个顶着 Electron
// 默认图标的 .app，后者会临时去 GitHub 下载 icons 工具链（打包就多一次外网依赖）。
// 两种情况 dist 目录看起来都完全正常，所以只能在这里拦。
assert.strictEqual(path.extname(pkg.build.mac.icon), '.icns',
  'mac 打包图标必须是预烘好的 .icns（见 scripts/build-icns.js）');
assert(fs.existsSync(path.join(root, pkg.build.mac.icon)),
  `package.json 指向的 macOS 图标不存在：${pkg.build.mac.icon} —— 跑 npm run icns:build`);
assert(/--mac(?:\s|$)/.test(pkg.scripts['package:mac'])
  && /finalize-dist-mac/.test(pkg.scripts['package:mac'])
  && /verify-dist-mac/.test(pkg.scripts['package:mac']),
  'mac 打包必须自带收尾与校验，否则每个新版本都要人工核对产物');
// scripts/finalize-dist.js 的前缀硬编码为 Windows-x64，会把 keep-set 之外的 dist
// 条目全删掉 —— 包括 .dmg。注意 finalize-dist-mac.js 不含 `finalize-dist.js` 子串，
// 所以这条只会在真的链错脚本时报。
assert(!/finalize-dist\.js|verify-dist\.js/.test(pkg.scripts['package:mac']),
  'Windows 专用的 dist 收尾脚本会删掉 DMG —— package:mac 不能链它们');
// mac 发版流水线的几个不变量。都是「改错了不会立刻看出来，但会静默发出坏包」的那类。
// 剥掉注释行再断言：文件里有一整段注释在解释「为什么刻意不加 --generate-notes」，
// 直接扫全文会被自己的解释文字命中。
const macWorkflow = read('.github/workflows/release-mac.yml')
  .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
assert(/^\s*tags:\s*\n\s*-\s*'v\*'/m.test(macWorkflow),
  'mac 发版必须只由 v* 标签触发 —— 挂到 branches 上会让每次提交都打一个 115MB 的包');
assert(!/^\s*branches:/m.test(macWorkflow),
  'release-mac.yml 不能有 branches 触发器（当初删掉全部 CI 就是因为每次推送都发失败邮件）');
assert(/runs-on:\s*macos-latest/.test(macWorkflow),
  'runs-on 必须是 macos-latest（Apple Silicon）—— Intel runner 会静默产出本项目不支持的 x64 包');
assert(/npm run package:mac/.test(macWorkflow),
  '流水线必须走 package:mac 三段链，绕过它就绕过了 verify-dist-mac.js 的坏包拦截');
assert(/--notes-file \.github\/release-notes-mac\.md/.test(macWorkflow)
  && !/--generate-notes/.test(macWorkflow),
  '放行说明必须进 Release body；--generate-notes 会让 GitHub 服务端生成 body 从而覆盖 --notes-file');
assert(/Apple Silicon/.test(read('.github/release-notes-mac.md'))
  && /隐私与安全性/.test(read('.github/release-notes-mac.md')),
  'Release 说明必须写清 arm64 限制与 Gatekeeper 放行路径 —— 缺了它接收者拿到的是个打不开的文件');
assert.strictEqual(pkg.scripts.test, 'node test/run-all.js');
// 两个 README 顶部的版本徽章必须跟 package.json 一致。npm version 不会改 Markdown，
// 所以没有这条断言它就会静默停在某个旧版本号上。
// shields.io 用 `-` 分隔 label/message/color，所以版本号里的字面连字符要写成 `--`
// （1.7.8-mac.2 → 1.7.8--mac.2）；不转义的话 message 会被截成 1.7.8、颜色变成 mac.2。
const badgeVersion = pkg.version.replace(/-/g, '--');
for (const [name, text] of [['README.md', readme], ['README_EN.md', readmeEn]]) {
  assert(text.includes(`badge/version-${badgeVersion}-F6A04A`),
    `${name} 的版本徽章没跟上 package.json (${pkg.version}) —— 期望 badge/version-${badgeVersion}-F6A04A`);
  assert(text.includes(`alt="Version ${pkg.version}"`),
    `${name} 的徽章 alt 文本没跟上 package.json (${pkg.version})`);
}
// 原本这里还从 .github/workflows/release.yml 里断言产物名 workmeow-windows-x64 和
// Release 标题跟随版本标签。本分支已删掉全部 workflow，这两项现在没有自动化载体：
// 产物名由 pkg.build.win.artifactName（上面已断言）决定，Release 标题手动填。
assert.strictEqual(lock.name, 'workmeow');
assert.strictEqual(lock.packages[''].name, 'workmeow');
assert(/app\.setName\(BRAND\.name\)/.test(main), 'Electron app name must come from the brand registry');
assert(/app\.setAppUserModelId\(BRAND\.appId\)/.test(main), 'Windows app identity must come from the brand registry');
// Windows surfaces (taskbar button, setAppDetails, packaged exe) must all use the
// one packaged .ico. macOS deliberately picks the PNG instead: Chromium there can
// decode .ico, so the isEmpty() fallback never fires and a multi-size Windows
// icon would end up as the Dock/about image.
assert(/const WINDOW_ICON_PATH = process\.platform === 'darwin'\s*\n\s*\? WINDOW_ICON_PNG_PATH\s*\n\s*: path\.join\(__dirname, 'assets', 'salary-cat\.ico'\)/.test(main),
  'every Windows surface must share one packaged 月薪喵 icon, with a PNG only for macOS');
assert.strictEqual(pkg.build.win.icon, 'assets/salary-cat.ico', 'packaged Windows icon must use the cache-busting salary-cat path');
assert.strictEqual((main.match(/icon:\s*WINDOW_ICON/g) || []).length, 3,
  'pet, detail, and settings windows must all receive the 月薪喵 window icon');
assert(/function applyWindowBranding\(win\)/.test(main) && /win\.setIcon\(WINDOW_ICON\)/.test(main)
  && /win\.setAppDetails\(\{/.test(main) && /appIconPath: WINDOW_ICON_PATH/.test(main),
  'Windows taskbar buttons must be explicitly refreshed with the generated icon');
assert(/hook[\\/]workmeow-hook\.js/.test(read('README.md').replace(/`/g, '')), 'Claude hook docs must use the WorkMeow filename');
assert(/基于 \[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\) 二次开发/.test(readme),
  'README must retain explicit upstream attribution');
assert(/Copyright \(c\) 2026 myunwang/.test(read('LICENSE')),
  'the upstream MIT copyright notice must remain intact');
assert(/Windows x64 only/.test(readmeEn), 'English README must state the Windows-only support boundary');
assert(/\[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\)/.test(readmeEn),
  'English README must retain explicit upstream attribution');
assert(/@月薪喵/.test(readme) && /@月薪喵/.test(readmeEn) && /@月薪喵/.test(credits),
  'both READMEs and asset credits must retain the artist source attribution');
for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'docs/PRIVACY.md']) {
  assert(fs.existsSync(path.join(root, file)), `${file} must exist`);
}

assert(/tray\.setToolTip\(t\('tray\.tooltip'\)\)/.test(main), 'tray tooltip must come from i18n');
const tip = i18n.DICT.zh['tray.tooltip'];
assert(/打工喵/.test(tip) && /WorkMeow/.test(tip), 'tray tooltip must use the canonical brand');
assert(/<title>打工喵 · 详情<\/title>/.test(read('renderer/panel.html')), 'detail title must use 打工喵');
assert(/产品名称和所有对外发布物统一使用 \*\*打工喵（WorkMeow）\*\*/.test(readme));

const publicFiles = [
  'README.md', 'README_EN.md', 'docs/介绍.md', 'docs/LOCAL_DEPLOYMENT.md', 'STATES.md',
  'main.js', 'renderer/pet.html', 'renderer/pet.js', 'renderer/panel.html',
  'renderer/panel.js',
];
for (const file of publicFiles) {
  const text = read(file)
    .replace(/\[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\)/g, '')
    .replace(/https?:\/\/\S+/g, '');
  assert(!/\bOctopus\b|\bLLMPET\b/.test(text), `${file} still exposes a retired public brand`);
}

const compatibilityFiles = new Set([
  path.join(root, 'backend', 'env.js'),
  path.join(root, 'backend', 'paths.js'),
  path.join(root, 'backend', 'protocol-compat.js'),
  path.join(root, 'backend', 'hook-compat.js'),
]);
const runtimeFiles = [
  path.join(root, 'main.js'), path.join(root, 'preload.js'),
  ...walk(path.join(root, 'backend')),
  ...walk(path.join(root, 'hook')),
  ...walk(path.join(root, 'renderer')),
  ...walk(path.join(root, 'shared')),
].filter((file) => file.endsWith('.js') && !compatibilityFiles.has(file));
for (const file of runtimeFiles) {
  assert(!/llmpet|octopus/i.test(fs.readFileSync(file, 'utf8')),
    `${path.relative(root, file)} leaks a retired identifier outside the compatibility boundary`);
}

console.log('branding checks passed');
