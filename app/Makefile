# 投票タイミング計測アプリ — 操作はすべてここから
.DEFAULT_GOAL := help
SHELL := /bin/bash
-include .env
export

help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

## ---------- 1回だけ ----------
tf-init: ## Terraformの初期化（プロバイダの取得）
	terraform -chdir=infra init

bootstrap: tf-init tf-apply config ## 初回セットアップを一括で
	@echo ""
	@echo "次は make secrets → make migrate → make deploy"

## ---------- インフラ ----------
tf-plan: ## 何が変わるかを事前に見る（実行はしない）
	terraform -chdir=infra plan

tf-apply: ## 宣言した状態にCloudflareを合わせる
	terraform -chdir=infra apply

config: ## terraform output から wrangler.jsonc を生成
	./scripts/gen-wrangler.sh

## ---------- アプリ ----------
secrets: ## チャネルシークレットとセッション鍵を登録（Terraformには保存しない）
	@echo "LINEのチャネルシークレットを入力してください:"
	@npx wrangler secret put LINE_CHANNEL_SECRET
	@echo "セッション署名鍵（下の値をコピーして貼り付け）:"
	@openssl rand -hex 32
	@npx wrangler secret put SESSION_SECRET

migrate-local: ## ローカルのD1にマイグレーションを当てる
	npx wrangler d1 migrations apply $(DB_NAME) --local

migrate: ## 本番のD1にマイグレーションを当てる
	npx wrangler d1 migrations apply $(DB_NAME) --remote

dev: ## ローカルで起動（http://localhost:8787）
	npx wrangler dev

deploy: ## Cloudflareへ配備
	npx wrangler deploy

tail: ## 本番のログを流し見る
	npx wrangler tail

## ---------- データ ----------
export-csv: ## events を CSV に書き出す
	@npx wrangler d1 execute $(DB_NAME) --remote --json \
	  --command "SELECT * FROM events ORDER BY id" \
	  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s)[0].results;if(!r.length){console.error('データがありません');process.exit(0)}console.log(Object.keys(r[0]).join(','));r.forEach(x=>console.log(Object.values(x).map(v=>typeof v==='string'&&v.includes(',')?'\"'+v+'\"':v).join(',')))})" \
	  > events.csv
	@echo "events.csv を書き出しました"

## ---------- 片付け ----------
destroy: ## Terraformが作ったものを削除（D1のデータも消えます）
	terraform -chdir=infra destroy

.PHONY: help tf-init tf-plan tf-apply bootstrap config secrets migrate-local migrate dev deploy tail export-csv destroy
