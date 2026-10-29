#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# tools/ghcurl.sh — 取 GitHub 内容时优先走桌面加速器
#
# 为什么需要它：
#   本机出网环境默认带着 http_proxy=http://127.0.0.1:64407（sandbox-cli 的出口
#   代理），请求 GitHub 要经它多一跳；而桌面的 Steamcommunity_302 已经把
#   github.com / api.github.com / raw.githubusercontent.com 等 42 个域名写进 hosts
#   指到 127.0.0.1:443（本地终结 TLS），绕过代理直连它，TLS 只要 17ms 起。
#
#   实测（2026-10-29，本机）：
#     · github.com 首页  直连加速器 0.42–0.75s，TLS 17–30ms
#     · 小请求 / API / raw 直连更快（省一跳）
#     · codeload 大包    直连只有 86–118 KB/s，走代理反而 267–564 KB/s
#   → 本脚本只用于「查」：页面、API、raw 文件、release 元数据。
#     大文件下载与 git clone 不要用它，保持默认代理更稳。
#
# 用法：
#   bash tools/ghcurl.sh https://api.github.com/repos/git/git
#   bash tools/ghcurl.sh -o out.json https://api.github.com/repos/git/git
#   bash tools/ghcurl.sh -T https://raw.githubusercontent.com/git/git/master/README.md
#   bash tools/ghcurl.sh -X 200 https://github.com/git/git
#
# 选项：
#   -o FILE   写到文件（默认输出到 stdout）
#   -T        额外打印耗时分解（dns/connect/tls/total）到 stderr
#   -X CODE   期望的 HTTP 状态码，不符则退出码 2（便于脚本断言）
#   -h        本帮助
#
# 退出码：0 成功 / 2 状态码不符 / 64 用法或域名不符 / curl 自身的错误码
# ─────────────────────────────────────────────────────────────
set -uo pipefail

PROG="$(basename "$0")"

usage() {
  cat <<'EOF'
用法: bash tools/ghcurl.sh [-o FILE] [-T] [-X CODE] <url>

  -o FILE   写到文件（默认输出到 stdout）
  -T        额外打印耗时分解到 stderr
  -X CODE   期望的 HTTP 状态码，不符则退出码 2
  -h        本帮助

只处理 GitHub 域名（github.com / api / raw / codeload / gist / objects…）。
大文件下载与 git clone 请直接用默认代理的 curl，别用本脚本。
EOF
  exit 0
}

OUT=""
SHOW_TIME=0
EXPECT=""

while getopts ":o:TX:h" opt; do
  case "$opt" in
    o) OUT="$OPTARG" ;;
    T) SHOW_TIME=1 ;;
    X) EXPECT="$OPTARG" ;;
    h) usage ;;
    \?) echo "$PROG: 未知选项 -$OPTARG（用 -h 看用法）" >&2; exit 64 ;;
    :)  echo "$PROG: -$OPTARG 需要一个参数" >&2; exit 64 ;;
  esac
done
shift $((OPTIND - 1))

[ $# -ge 1 ] || { echo "$PROG: 需要一个 URL（用 -h 看用法）" >&2; exit 64; }
URL="$1"

# ── 只放行 GitHub 域名 ──────────────────────────────────────
# 别的一律拒绝：绕过沙箱代理对非 GitHub 站点不一定是好事（部分境外站直接不通），
# 而且这脚本就该只干 GitHub 这一件事。
case "$URL" in
  https://github.com/*|https://github.com|\
  https://www.github.com/*|\
  https://api.github.com/*|https://api.github.com|\
  https://gist.github.com/*|\
  https://raw.githubusercontent.com/*|\
  https://gist.githubusercontent.com/*|\
  https://codeload.github.com/*|\
  https://objects.githubusercontent.com/*|\
  https://release-assets.githubusercontent.com/*|\
  https://github.githubassets.com/*|\
  https://avatars.githubusercontent.com/*)
    ;;
  *)
    echo "$PROG: 只处理 GitHub 域名，拒绝：$URL" >&2
    echo "      （非 GitHub 站点请直接 curl，别绕过沙箱代理）" >&2
    exit 64
    ;;
esac

# 代理变量在本机由沙箱注入，这里只在子 shell 内清掉，不影响调用方
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

ARGS=(-sS -L --max-time 30 -A "ghcurl/1.0")

code=""
if [ -n "$OUT" ]; then
  # 正文进文件；时间与状态码由 -w 回吐到 stdout 再拆开
  read -r total code <<< "$(curl "${ARGS[@]}" -o "$OUT" -w '%{time_total} %{http_code}' "$URL")"
  rc=$?
  [ $rc -ne 0 ] && { echo "$PROG: curl 失败（rc=$rc）—— $URL" >&2; exit $rc; }
  [ "$SHOW_TIME" -eq 1 ] && echo "[ghcurl] total=${total}s http=${code} → $OUT（$(wc -c < "$OUT") bytes）" >&2
  echo "$code"
elif [ -n "$EXPECT" ]; then
  code=$(curl "${ARGS[@]}" -o /dev/null -w '%{http_code}' "$URL")
  rc=$?
  [ $rc -ne 0 ] && { echo "$PROG: curl 失败（rc=$rc）—— $URL" >&2; exit $rc; }
  echo "$code"
else
  # 只是取正文：直接透传到 stdout（-T 在这种模式下没有意义，故忽略）
  curl "${ARGS[@]}" "$URL"
  exit $?
fi

if [ -n "$EXPECT" ] && [ "$code" != "$EXPECT" ]; then
  echo "$PROG: HTTP $code，期望 $EXPECT —— $URL" >&2
  exit 2
fi

exit 0
