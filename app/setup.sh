#!/usr/bin/env bash
#
# 投票タイミング計測アプリ — セットアップ
#
#   ./setup.sh
#
# 必要な道具の導入から配備まで、これ1本で終わります。
# 途中で4つの値を聞きます。何度実行しても壊れません。
#
set -uo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; OFF=$'\033[0m'
step(){ printf "\n%s▸ %s%s\n" "$BOLD" "$1" "$OFF"; }
ok(){   printf "  %s✓%s %s\n" "$GRN" "$OFF" "$1"; }
warn(){ printf "  %s!%s %s\n" "$YLW" "$OFF" "$1"; }
die(){  printf "\n%s✗ %s%s\n\n" "$RED" "$1" "$OFF"; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }

printf "\n%s投票タイミング計測アプリ — セットアップ%s\n" "$BOLD" "$OFF"
printf "%s何度実行しても大丈夫です。途中で止めた場合も、もう一度実行すれば続きから進みます。%s\n" "$DIM" "$OFF"

# ---------------------------------------------------------------- 1. 道具
step "1/7  必要な道具を確認します"

if ! have brew; then
  warn "Homebrew がありません。導入します（Macのパスワードを聞かれます）"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Homebrew の導入に失敗しました"
  # Apple Silicon / Intel の両方でパスを通す
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$p" ] && eval "$($p shellenv)"
  done
fi
have brew && ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

if ! have node; then
  warn "Node.js がありません。導入します"
  brew install node || die "Node.js の導入に失敗しました"
fi
ok "Node.js $(node --version)"

if ! have terraform; then
  warn "Terraform がありません。導入します"
  brew tap hashicorp/tap >/dev/null 2>&1
  brew install hashicorp/tap/terraform || die "Terraform の導入に失敗しました"
fi
ok "Terraform $(terraform version | head -1 | awk '{print $2}')"

# ---------------------------------------------------------------- 2. 設定値
step "2/7  設定値を確認します"

[ -f .env ] && . ./.env
ask(){ # ask 変数名 "説明" "取得場所" secret?
  local var="$1" label="$2" where="$3" secret="${4:-}" cur="${!1:-}" val=""
  if [ -n "$cur" ] && [[ "$cur" != ここに* ]]; then
    ok "$label ... 設定済み"; printf -v "$var" '%s' "$cur"; return
  fi
  printf "\n  %s%s%s\n  %s%s%s\n" "$BOLD" "$label" "$OFF" "$DIM" "$where" "$OFF"
  while [ -z "$val" ]; do
    if [ -n "$secret" ]; then read -r -s -p "  > " val; echo; else read -r -p "  > " val; fi
  done
  printf -v "$var" '%s' "$val"
}

ask CLOUDFLARE_ACCOUNT_ID "CloudflareのアカウントID" \
  "ダッシュボード → Workers & Pages ページの右側にある32桁"
ask CLOUDFLARE_API_TOKEN "CloudflareのAPIトークン" \
  "右上のアイコン → プロフィール → APIトークン → カスタムトークンを作成する / 権限は「Workers スクリプト: 編集」と「D1: 編集」の2つ" secret
ask LINE_CHANNEL_ID "LINEのチャネルID" \
  "LINE Developers → LINEログインチャネル → チャネル基本設定"
ask LINE_CHANNEL_SECRET "LINEのチャネルシークレット" \
  "同じ画面の下の方「チャネルシークレット」" secret

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID LINE_CHANNEL_ID
DB_NAME="poll-${TF_ENV:-dev}"

cat > .env <<EOF
CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}
CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}
LINE_CHANNEL_ID=${LINE_CHANNEL_ID}
DB_NAME=${DB_NAME}
EOF
chmod 600 .env
cat > infra/terraform.tfvars <<EOF
account_id = "${CLOUDFLARE_ACCOUNT_ID}"
env        = "${TF_ENV:-dev}"
EOF
ok ".env と infra/terraform.tfvars を書きました（.gitignore 済み）"

# ---------------------------------------------------------------- 3. 依存
step "3/7  依存パッケージを入れます"
npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install に失敗しました"
ok "wrangler を導入しました"

# ---------------------------------------------------------------- 4. Terraform
step "4/7  D1データベースを作ります（Terraform）"
terraform -chdir=infra init -input=false >/dev/null || die "terraform init に失敗しました"
ok "初期化しました"

terraform -chdir=infra apply -input=false -auto-approve || die "terraform apply に失敗しました。APIトークンの権限に「D1: 編集」が入っているか確認してください"
ok "データベース $(terraform -chdir=infra output -raw database_name) を用意しました"

# ---------------------------------------------------------------- 5. 設定生成
step "5/7  wrangler.jsonc を生成します"
./scripts/gen-wrangler.sh >/dev/null || die "wrangler.jsonc の生成に失敗しました"
ok "terraform の出力からデータベースIDを埋めました"

# ---------------------------------------------------------------- 6. シークレット
step "6/7  シークレットを登録します"
printf '%s' "$LINE_CHANNEL_SECRET" | npx wrangler secret put LINE_CHANNEL_SECRET >/dev/null 2>&1 \
  && ok "LINE_CHANNEL_SECRET" || warn "LINE_CHANNEL_SECRET の登録に失敗（初回配備後に再実行されます）"

SESSION_SECRET="$(openssl rand -hex 32)"
printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET >/dev/null 2>&1 \
  && ok "SESSION_SECRET（自動生成）" || warn "SESSION_SECRET の登録に失敗（初回配備後に再実行されます）"

# ローカル開発用にも置いておく
cat > .dev.vars <<EOF
LINE_CHANNEL_SECRET=${LINE_CHANNEL_SECRET}
SESSION_SECRET=${SESSION_SECRET}
EOF
chmod 600 .dev.vars

# ---------------------------------------------------------------- 7. 配備
step "7/7  スキーマを適用して配備します"
npx wrangler d1 migrations apply "$DB_NAME" --remote >/dev/null 2>&1 \
  && ok "スキーマを適用しました" || warn "スキーマの適用に失敗しました（あとで make migrate）"

DEPLOY_LOG="$(npx wrangler deploy 2>&1)" || { echo "$DEPLOY_LOG"; die "配備に失敗しました"; }
URL="$(printf '%s' "$DEPLOY_LOG" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
ok "配備しました"

# シークレット登録が初回で失敗していた場合に備えて、配備後にもう一度試す
if ! npx wrangler secret list 2>/dev/null | grep -q SESSION_SECRET; then
  printf '%s' "$LINE_CHANNEL_SECRET" | npx wrangler secret put LINE_CHANNEL_SECRET >/dev/null 2>&1
  printf '%s' "$SESSION_SECRET"      | npx wrangler secret put SESSION_SECRET      >/dev/null 2>&1
  npx wrangler deploy >/dev/null 2>&1
  ok "シークレットを登録し直しました"
fi
npx wrangler d1 migrations apply "$DB_NAME" --remote >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 完了
printf "\n%s────────────────────────────────────────%s\n" "$GRN" "$OFF"
printf "%s セットアップが終わりました%s\n" "$BOLD" "$OFF"
printf "%s────────────────────────────────────────%s\n\n" "$GRN" "$OFF"

if [ -n "${URL:-}" ]; then
  printf "  配備先        %s%s%s\n\n" "$BOLD" "$URL" "$OFF"
  printf "  %s残り1つだけ、手作業が必要です。%s\n\n" "$BOLD" "$OFF"
  printf "  LINE Developers → LINEログイン設定 → コールバックURL に\n"
  printf "  %s改行して追記%s してください（診断ページ用のURLは消さないこと）\n\n" "$BOLD" "$OFF"
  printf "      %s%s/auth/callback%s\n\n" "$GRN" "$URL" "$OFF"
  printf "  そのあと、検証用のオープンチャットに %s%s%s を貼って\n" "$BOLD" "$URL" "$OFF"
  printf "  スマホで開き、「LINEでログイン」を押してください。\n"
  printf "  %suserId が表示されれば全て成功です。%s\n\n" "$BOLD" "$OFF"
  printf "  %s状態を確認する: %s/api/health%s\n\n" "$DIM" "$URL" "$OFF"
else
  warn "配備先URLを読み取れませんでした。上のログを確認してください"
fi
