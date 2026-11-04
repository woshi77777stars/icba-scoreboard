#!/usr/bin/env bash
# 把单文件成品同步到 docs/index.html（GitHub Pages 的入口页）
# 用法：./scripts/sync-docs.sh
set -euo pipefail
cd "$(dirname "$0")/.."

cp "ICBA记分板.html" "docs/index.html"

echo "已同步，校验两份文件是否一致："
shasum -a 256 "ICBA记分板.html" "docs/index.html"

cat <<'TIP'

提交并上线：
  git add docs/index.html && git commit -m "publish: 同步单文件成品" && git push
GitHub Pages 约 1 分钟后自动刷新。
TIP
