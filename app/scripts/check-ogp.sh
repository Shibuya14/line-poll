#!/usr/bin/env bash
# 配備済みのページが返している og:* タグと、その画像が実際に取れるかを確認する。
#   make ogp-check            # トップページ
#   make ogp-check P=/p/xxxx  # 投票の共有URL
set -euo pipefail

cd "$(dirname "$0")/.."

BASE="$(sed -n 's|.*<meta property="og:url" content="\(https://[^/"]*\).*|\1|p' public/index.html | head -1)"
URL="${BASE}${1:-/}"

echo "== ${URL}"
# LINEのクローラーと同じくUser-Agentを名乗って取得する
HTML="$(curl -sL -A 'facebookexternalhit/1.1;line-poker/1.0' "$URL")"
echo "$HTML" | grep -o '<meta property="og:[^>]*>' || echo "og:タグが見つかりません"

IMG="$(echo "$HTML" | sed -n 's|.*<meta property="og:image" content="\([^"]*\)".*|\1|p' | head -1)"
if [ -n "$IMG" ]; then
  echo ""
  echo "== 画像 ${IMG}"
  curl -sI "$IMG" | grep -iE '^(HTTP|content-type|content-length)'
  TMP="$(mktemp -t ogp).img"
  curl -s -o "$TMP" "$IMG" && open "$TMP"
fi

echo ""
echo "LINE上の表示がまだ古い場合は、LINEのキャッシュを https://poker.line.naver.jp/ で消してください。"
