#!/usr/bin/env bash
# リンクカード画像(og:image)を差し替える。
#   make ogp IMG=~/Downloads/card.png
#
# 画像を public/ogp-<内容のハッシュ>.<拡張子> として置き、古いogp画像を消し、
# index.html の og:image / width / height を書き換える。
# 中身が変わればファイル名(=URL)も変わるので、画像側のキャッシュで古い絵が出続けることがない。
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "使い方: make ogp IMG=画像ファイルのパス" >&2
  exit 1
fi

EXT="$(echo "${SRC##*.}" | tr '[:upper:]' '[:lower:]')"
case "$EXT" in
  png|jpg|jpeg) ;;
  *) echo "png か jpg を指定してください: $SRC" >&2; exit 1 ;;
esac

HASH="$(shasum -a 256 "$SRC" | cut -c1-8)"
NAME="ogp-${HASH}.${EXT}"

# 古いogp画像を消してから置く(ogp4.png のような旧命名も対象)
find public -maxdepth 1 -type f \( -name 'ogp*.png' -o -name 'ogp*.jpg' -o -name 'ogp*.jpeg' \) -delete
cp "$SRC" "public/$NAME"

# 画像のサイズを og:image:width/height に反映(macOS の sips を使う)
W="$(sips -g pixelWidth  "public/$NAME" | awk '/pixelWidth/{print $2}')"
H="$(sips -g pixelHeight "public/$NAME" | awk '/pixelHeight/{print $2}')"

sed -i '' \
  -e "s|\(<meta property=\"og:image\" content=\"[^\"]*/\)[^\"/]*\"|\1${NAME}\"|" \
  -e "s|\(<meta property=\"og:image:width\" content=\"\)[^\"]*\"|\1${W}\"|" \
  -e "s|\(<meta property=\"og:image:height\" content=\"\)[^\"]*\"|\1${H}\"|" \
  public/index.html

echo "public/$NAME を設定しました (${W}x${H})"
grep -n 'og:image' public/index.html
echo ""
echo "make deploy で配備し、make ogp-check で確認してください。"
