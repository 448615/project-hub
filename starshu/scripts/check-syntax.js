// 全量语法门禁：对仓库内所有 .js/.mjs/.cjs 跑 node --check。
// 排除 node_modules（第三方）与 workbench/www（Vite 构建产物）。
// CI 与本地提交前均可执行：npm run check
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'www', 'dist', 'build', 'out', '.next', 'backups']);
const EXTS = new Set(['.js', '.mjs', '.cjs']);

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    } else if (EXTS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
})(ROOT);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`[check] 语法错误: ${path.relative(ROOT, f)}`);
    console.error(String(e.stderr || e.message).split('\n').slice(0, 5).join('\n'));
  }
}
console.log(`[check] ${files.length - failed}/${files.length} 个文件语法正确`);
if (failed > 0) process.exit(1);
