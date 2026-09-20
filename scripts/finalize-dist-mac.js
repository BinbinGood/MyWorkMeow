'use strict';

// macOS 版的 dist 收尾。为什么不复用 scripts/finalize-dist.js：
// 那个脚本第 10 行硬编码 `WorkMeow-<version>-Windows-x64` 前缀，然后把 keep-set
// 之外的每一个 dist 条目 rmSync 掉 —— 拿来跑 mac 会把 .dmg 和 mac-arm64/ 一起删了。
// Windows 那份保持逐字节不变（它守着 latest.yml 的活契约），这里另写一份。
//
// 顺序和 Windows 侧一致、且是刻意的：先确认新产物齐全，再删旧的。新产物不齐就
// 一个字节都不动，保证打包失败时上一版仍然在手里。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const prefix = `WorkMeow-${pkg.version}-macOS-arm64`;
// mac 侧没有更新元数据：build.dmg.writeUpdateInfo 为 false，因为
// backend/updater.js:10-12 对任何非 win32 平台直接返回 'unsupported'。
// 也不写 SHA256SUMS.txt：产物集就是一个 DMG，没有 latest-mac.yml / blockmap。
// 校验和是刻意去掉的 —— 它和 DMG 在同一次运行里由同一份字节生成，本地只能
// 抓住这几秒内的磁盘损坏；真正的用处在接收者一侧，而那需要对方愿意跑一条
// shasum 命令。Windows 侧仍然写（latest.yml 的活契约依赖它），mac 侧不写。
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

// 上一版留下的 SHA256SUMS.txt 不在 keep-set 里，所以上面那个循环会顺手删掉它。
console.log(`Finalized ${requiredArtifacts.length} artifact(s) in ${dist}`);
