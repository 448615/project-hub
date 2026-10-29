#!/usr/bin/env bash
# 星枢（starshu）启动入口（macOS / Linux）
# 用法：./start.sh [--no-install]
set -e

# 1) 稳健定位脚本所在目录（兼容从任意位置调用、被 source 的场景）
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# 2) Node 可用性检查
if ! command -v node >/dev/null 2>&1; then
  echo "[start.sh] ❌ 未找到 node，请先安装 Node.js >= 18（推荐 20 LTS）" >&2
  echo "            https://nodejs.org/" >&2
  exit 1
fi

# 3) 启动脚本存在性检查
if [ ! -f "scripts/start.js" ]; then
  echo "[start.sh] ❌ 未找到 scripts/start.js，请在星枢（starshu）项目根目录运行" >&2
  exit 1
fi

# 4) exec 替换当前进程：信号（Ctrl+C）直接到达 node，无中间层
exec node scripts/start.js "$@"