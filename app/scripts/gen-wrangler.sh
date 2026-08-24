#!/usr/bin/env bash
# terraform output の値を wrangler.jsonc.tmpl に流し込んで wrangler.jsonc を作る。
# これで「D1のIDを手でコピペする」作業がなくなる。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d infra/.terraform ]; then
  echo "先に make tf-init && make tf-apply を実行してください。" >&2
  exit 1
fi

out() { terraform -chdir=infra output -raw "$1"; }

DB_NAME="$(out database_name)"
DB_ID="$(out database_id)"
WORKER_NAME="$(out worker_name)"
ACCOUNT_ID="$(out account_id)"
LINE_CHANNEL_ID="${LINE_CHANNEL_ID:-}"

if [ -z "$LINE_CHANNEL_ID" ]; then
  echo "警告: LINE_CHANNEL_ID が未設定です。.env に書くか環境変数で渡してください。" >&2
fi

sed -e "s|__DB_NAME__|${DB_NAME}|g" \
    -e "s|__DB_ID__|${DB_ID}|g" \
    -e "s|__WORKER_NAME__|${WORKER_NAME}|g" \
    -e "s|__ACCOUNT_ID__|${ACCOUNT_ID}|g" \
    -e "s|__LINE_CHANNEL_ID__|${LINE_CHANNEL_ID}|g" \
    wrangler.jsonc.tmpl > wrangler.jsonc

echo "wrangler.jsonc を生成しました (db=${DB_NAME} worker=${WORKER_NAME})"
