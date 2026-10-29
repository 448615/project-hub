#!/usr/bin/env node
/**
 * 一键启动脚本：环境体检 → 依赖安装（含镜像兜底）→ 端口检查 → 启动服务
 *
 * 用法：
 *   node scripts/start.js               # 标准启动
 *   node scripts/start.js --no-install  # 跳过依赖检查/安装（依赖已就绪时更快）
 *
 * 可选环境变量：
 *   PORT         服务端口（默认 3000）
 *   HOST         监听地址（默认 0.0.0.0 = 所有网卡；改 127.0.0.1 则仅本机）
 *   DB_FILE      数据库路径（默认 data/starshu.db）
 *   NPM_REGISTRY 自定义 npm 镜像地址
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NO_INSTALL = process.argv.includes('--no-install');
const IS_WIN = process.platform === 'win32';

// ---------- 0. 基础体检 ----------
function fail(msg, hint) {
  console.error(`\n[start] ❌ ${msg}`);
  if (hint) console.error(hint);
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'server.js'))) {
  fail('未找到 server.js，请确认在星枢（starshu）项目根目录运行');
}

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  fail(`需要 Node.js >= 18（当前 ${process.version}）`, '建议安装 Node.js 20 LTS：https://nodejs.org/');
}
if (nodeMajor >= 22) {
  console.warn(`[start] ⚠ 当前 Node ${nodeMajor}，better-sqlite3 预编译包可能未覆盖，若安装失败请改用 Node 20 LTS`);
}

// ---------- 1. 依赖安装 ----------
const requiredDeps = ['express', 'better-sqlite3', 'jsonwebtoken', 'multer'];
function missingDeps() {
  const modulesDir = path.join(ROOT, 'node_modules');
  return requiredDeps.filter((d) => !fs.existsSync(path.join(modulesDir, d)));
}

function runInstall(registry) {
  const args = ['install', '--no-audit', '--no-fund'];
  if (registry) args.push(`--registry=${registry}`);
  console.log(`[start] 执行：npm ${args.join(' ')}`);

  // better-sqlite3 预编译包镜像：以环境变量注入，等价于 .npmrc 的
  // better_sqlite3_binary_host_mirror。该键并非 npm 官方配置，放在 .npmrc 中
  // 会触发 "Unknown project config" 警告且未来主版本将失效；环境变量是
  // npm 官方推荐的迁移方式（prebuild-install 读取 npm_config_* 注入的变量）。
  // 仅在用户未显式设置时兜底，不覆盖自定义镜像。
  const installEnv = { ...process.env };
  if (!installEnv.npm_config_better_sqlite3_binary_host_mirror) {
    installEnv.npm_config_better_sqlite3_binary_host_mirror =
      'https://registry.npmmirror.com/-/binary/better-sqlite3';
  }

  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN, // Windows 下 .cmd 需要 shell 才能正确执行
    env: installEnv,
  });
  return r.status === 0;
}

function printInstallDiagnostics() {
  console.error('');
  console.error('  ┌─ 依赖安装失败 · 排查清单 ─────────────────────────');
  console.error('  │ 1) 网络/镜像：执行 npm config set registry https://registry.npmmirror.com');
  console.error('  │ 2) better-sqlite3 编译失败：需安装 VS Build Tools（勾选 C++ 桌面开发）');
  console.error('  │    https://visualstudio.microsoft.com/visual-cpp-build-tools/');
  console.error('  │ 3) Node 版本过高：建议切到 Node 20 LTS（nvm use 20）');
  console.error('  │ 4) 路径含空格/括号：建议移到 C:\\starshu 这类干净路径');
  console.error('  │ 5) 缓存损坏：npm cache clean --force && 删除 node_modules 后重试');
  console.error('  └──────────────────────────────────────────────────');
}

if (!NO_INSTALL) {
  const missing = missingDeps();
  if (missing.length) {
    console.log(`[start] 缺少依赖：${missing.join(', ')}`);
    const customRegistry = process.env.NPM_REGISTRY || '';
    let ok = runInstall(customRegistry);

    // 首次失败 → 自动用国内镜像重试一次
    if (!ok && !customRegistry) {
      console.warn('\n[start] 首次安装失败，改用 npmmirror 镜像重试...');
      ok = runInstall('https://registry.npmmirror.com');
    }

    if (!ok) {
      printInstallDiagnostics();
      fail('依赖安装失败，请按上方清单处理后重试');
    }
    console.log('[start] ✅ 依赖安装完成');
  } else {
    console.log('[start] ✅ 依赖已就绪');
  }
}

// ---------- 2. 端口检查 ----------
function getPortOwner(port) {
  if (!IS_WIN) return '';
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', shell: true }).stdout || '';
    const line = out.split(/\r?\n/).find((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
    if (!line) return '';
    const pid = line.trim().split(/\s+/).pop();
    return pid ? `（占用进程 PID=${pid}，可用 taskkill /PID ${pid} /F 结束）` : '';
  } catch (_) { return ''; }
}

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// ---------- 2.5 局域网地址探测 ----------
// 过滤常见虚拟网卡（VMware / VirtualBox / Hyper-V / WSL / Docker / VPN），
// 但不丢弃——只是排序靠后并加标注，避免用户真的走虚拟网卡时看不到。
const VIRTUAL_IFACE_RE = /(vmware|vmnet|virtualbox|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier|npcap|tap|tun|radmin|hamachi)/i;

function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) {
        out.push({ name, address: it.address, virtual: VIRTUAL_IFACE_RE.test(name) });
      }
    }
  }
  // 物理网卡在前，虚拟网卡在后；同组内按地址排序保证输出稳定
  out.sort((a, b) => (a.virtual - b.virtual) || a.address.localeCompare(b.address));
  return out;
}

(async () => {
  if (!(await isPortFree(PORT, HOST))) {
    const owner = getPortOwner(PORT);
    fail(`端口 ${PORT} 已被占用${owner}`, `[start] 换端口：PORT=3100 node scripts/start.js`);
  }

  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ---------- 3. 启动 ----------
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║      星枢内容运营中枢 · 启动中...        ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log(`  Node     : ${process.version}`);
  console.log(`  平台     : ${os.platform()} ${os.arch()}`);
  console.log(`  监听     : ${HOST}:${PORT}`);
  console.log(`  数据库   : ${process.env.DB_FILE || 'data/starshu.db'}`);
  console.log(`  本机访问 : http://localhost:${PORT}`);

  // 局域网地址：HOST=127.0.0.1 时不展示（本来就不可达）
  if (HOST === '0.0.0.0' || HOST === '::') {
    const ips = lanIPs();
    if (ips.length) {
      const fmt = (ip) =>
        `http://${ip.address}:${PORT}    (${ip.virtual ? '虚拟网卡' : ip.name})`;
      // 第一个地址直接跟在「局域网 :」后面，其余缩进对齐
      console.log(`  局域网   : ${fmt(ips[0])}`);
      for (let i = 1; i < ips.length; i++) {
        console.log(`             ${fmt(ips[i])}`);
      }
    } else {
      console.log('  局域网   : 未检测到（当前未联网？）');
    }
  } else {
    console.log(`  局域网   : 已禁用（HOST=${HOST}，仅本机可访问）`);
  }

  console.log('');
  console.log('  默认管理员: admin@cms.local / Admin@123456');
  console.log(`  ⚠ 局域网设备打不开时，请放行 Windows 防火墙入站端口 ${PORT}：`);
  console.log(`    New-NetFirewallRule -DisplayName "Starshu ${PORT}" -Direction Inbound -Protocol TCP -LocalPort ${PORT} -Action Allow`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT), HOST },
  });

  child.on('exit', (code) => process.exit(code == null ? 0 : code));

  // 优雅转发中断信号（Windows 下 SIGINT 传递有限，close 兜底）
  const stop = () => { try { child.kill(); } catch (_) { /* ignore */ } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();