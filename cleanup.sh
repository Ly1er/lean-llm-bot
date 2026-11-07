#!/usr/bin/env bash
# 开源前脱敏检查。默认只检查，发现问题返回 1。
#   ./cleanup.sh          # 检查
#   ./cleanup.sh --fix    # 自动替换 API Key、绝对路径（QQ 号等只报告，不自动改）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX=0
[[ "${1:-}" == "--fix" ]] && FIX=1

EXCLUDES=(--exclude-dir=.git --exclude-dir=data --exclude-dir=node_modules --exclude-dir=__pycache__)
BAD=0

if echo x | grep -P "x" >/dev/null 2>&1; then
  GREP_P=(-P)
else
  GREP_P=()
fi

report() {
  local title="$1"; shift
  local hits
  if [[ ${#GREP_P[@]} -gt 0 ]]; then
    hits=$(grep -RInP "$1" "${EXCLUDES[@]}" "$ROOT" 2>/dev/null | grep -v "cleanup.sh" || true)
  else
    hits=$(grep -RInE "$1" "${EXCLUDES[@]}" "$ROOT" 2>/dev/null | grep -v "cleanup.sh" || true)
  fi
  if [[ -n "$hits" ]]; then
    echo "✗ $title"
    echo "$hits" | sed 's/^/    /' | head -40
    BAD=1
  else
    echo "✓ $title"
  fi
}

fix_paths() {
  grep -RIlE "/home/[a-z0-9_-]+/" "${EXCLUDES[@]}" "$ROOT" 2>/dev/null | while read -r f; do
    sed -i -E 's#/home/[a-z0-9_-]+/#/path/to/#g' "$f"
    echo "  已替换绝对路径: ${f#$ROOT/}"
  done
}

fix_keys() {
  grep -RIlE "sk-[A-Za-z0-9_-]{16,}" "${EXCLUDES[@]}" "$ROOT" 2>/dev/null | while read -r f; do
    sed -i -E 's/sk-[A-Za-z0-9_-]{16,}/YOUR_DEEPSEEK_API_KEY/g' "$f"
    echo "  已替换 API Key: ${f#$ROOT/}"
  done
}

if [[ $FIX -eq 1 ]]; then
  echo "== 自动修复 =="
  fix_paths
  fix_keys
  echo
fi

echo "== 检查 =="
report "API Key（sk-...）" "sk-[A-Za-z0-9_-]{16,}"
report "个人绝对路径（/home/<user>/）" "/home/[a-z0-9_-]+/"
report "邮箱地址" "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
if [[ ${#GREP_P[@]} -gt 0 ]]; then
  report "疑似 QQ 号 / 群号（9~11 位数字，占位符除外）" "(?<!\d)(?!123456789\b|987654321\b)[1-9][0-9]{8,10}(?!\d)"
else
  report "疑似 QQ 号 / 群号（9~11 位数字，占位符除外）" "[1-9][0-9]{8,10}"
fi
report "chat_id / sender 等运行态标识" "(chat_id|sender|uin|openid)=[A-Za-z0-9_-]{8,}"

if [[ $BAD -eq 1 ]]; then
  echo
  echo "发现疑似敏感信息。确认后可运行 ./cleanup.sh --fix 处理路径与 Key，其余请手工确认。"
  exit 1
fi
echo
echo "通过：没有发现明显的硬编码敏感信息。"
