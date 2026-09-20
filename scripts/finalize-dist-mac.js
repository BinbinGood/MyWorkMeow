'use strict';

// macOS 版的 dist 收尾。为什么不复用 scripts/finalize-dist.js：
// 那个脚本第 10 行硬编码 `WorkMeow-<version>-Windows-x64` 前缀，然后把 keep-set
// 之外的每一个 dist 条目 rmSync 掉 —— 拿来跑 mac 会把 .dmg 和 mac-arm64/ 一起删了。
// Windows 那份保持逐字节不变（它守着 latest.yml 的活契约），这里另写一份。
//
// 顺序和 Windows 侧一致、且是刻意的：先确认新产物齐全，再删旧的。新产物不齐就
// 一个字节都不动，保证打包失败时上一版仍然在手里。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const prefix = `WorkMeow-${pkg.version}-macOS-arm64`;
// mac 侧没有更新元数据：build.dmg.writeUpdateInfo 为 false，因为
// backend/updater.js:10-12 对任何非 win32 平台直接返回 'unsupported'。
// 所以产物集就是「一个 DMG + 一个 SHA256SUMS.txt」，没有 latest-mac.yml / blockmap。
const requiredArtifacts = [`${prefix}.dmg`];

if (!fs.existsSync(dist)) throw new Error(`Missing build directory: ${dist}`);
for (const name of requiredArtifacts) {
  if (!fs.existsSync(path.join(dist, name))) throw new Error(`Missing build artifact: ${name}`);
}

// 删掉 keep-set 之外的一切，包含 mac-arm64/ 目录（它已经被装进 DMG 了，
// 和 Windows 侧删 win-unpacked/ 对称）。这同时清掉上一个版本的陈旧 DMG ——
// 「改版本号就能重打」靠的就是这一步。
const keep = new Set(requiredArtifacts);
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!keep.has(entry.name)) fs.rmSync(path.join(dist, entry.name), { recursive: true, force: true });
}

const checksums = requiredArtifacts.map((name) => {
  const data = fs.readFileSync(path.join(dist, name));
  return `${crypto.createHash('sha256').update(data).digest('hex')}  ${name}`;
});
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');

console.log(`Finalized ${requiredArtifacts.length} artifact(s) in ${dist}`);
