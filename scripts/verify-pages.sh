#!/usr/bin/env bash
# 验收脚本：确认 GitHub Pages 上的地址真的可打开、内容正确
# 用法：./scripts/verify-pages.sh
set -uo pipefail
cd "$(dirname "$0")/.."

URL="https://woshi77777stars.github.io/icba-scoreboard/"
LOCAL="ICBA记分板.html"
fail=0
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "验收目标：$URL"

# 1) HTTP 200
code=$(curl -s -o /tmp/pages-verify.html -w '%{http_code}' -L "$URL" 2>/dev/null || echo "000")
[ "$code" = "200" ] && ok "HTTP 200" || bad "HTTP 状态码是 ${code}（期望 200）"

# 2) 标题
grep -q '<title>ICBA 记分板</title>' /tmp/pages-verify.html && ok "页面标题为「ICBA 记分板」" || bad "页面标题不符"

# 3) 按钮数 44（记分/计时/队标等控件齐全）
n=$(grep -o '<button' /tmp/pages-verify.html | wc -l | tr -d ' ')
[ "$n" = "44" ] && ok "按钮数 44" || bad "按钮数是 ${n}（期望 44）"

# 4) 双计时默认值（静态初始值；休息计时静态写的是 0 补齐的 05:00，运行时 JS 才显示成 5:00）
grep -q '>10:00<' /tmp/pages-verify.html && ok "比赛计时默认 10:00" || bad "未找到 10:00"
grep -q '>05:00<' /tmp/pages-verify.html && ok "休息计时默认 05:00" || bad "未找到 05:00"

# 5) 零外链（自包含）
ext=$(grep -oE '(src|href)="(https?:)?//[^"]*"' /tmp/pages-verify.html | wc -l | tr -d ' ')
[ "$ext" = "0" ] && ok "外部引用 0 个（完全自包含）" || bad "存在 $ext 个外部引用"

# 6) 线上内容与本地成品逐字节一致（忽略换行归一化）
l=$(shasum -a 256 "$LOCAL" | cut -d' ' -f1)
r=$(shasum -a 256 /tmp/pages-verify.html | cut -d' ' -f1)
[ "$l" = "$r" ] && ok "线上文件与本地 ICBA记分板.html sha256 一致" || bad "线上内容与本地成品不一致（${r} vs ${l}）"

echo
if [ "$fail" = "0" ]; then
  echo "结论：全部通过，页面已上线可用。"
else
  echo "结论：存在失败项。"
fi
exit "$fail"
