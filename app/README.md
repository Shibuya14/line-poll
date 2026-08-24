# 投票タイミング計測アプリ — インフラ

LINEの投票機能に見た目を揃えた投票アプリを、Cloudflare上に再現可能な形で配備するための一式です。

---

## Terraform とは（はじめての方へ）

クラウドの設定は、普通は管理画面でボタンを押して作ります。手軽ですが、**誰がいつ何を作ったかが残りません。** 半年後に「このデータベースはどういう設定だったか」を思い出せず、論文の査読で環境を聞かれても答えられません。

Terraform は、**欲しい状態をテキストファイルに書いておくと、実際のクラウドをその状態に合わせてくれる**道具です。

```hcl
resource "cloudflare_d1_database" "poll" {
  account_id            = var.account_id
  name                  = "poll-dev"
  primary_location_hint = "apac"
}
```

これを書いて `terraform apply` すると、データベースが作られます。もう一度実行しても、すでに同じ状態なら何もしません。ファイルを消して `terraform destroy` すれば、作ったものが消えます。**手作業がゼロになり、構成がGitの履歴に残る**のが利点です。

研究用途では、これがそのまま「データをどこにどう置いたか」の証拠になります。

## 役割分担

Cloudflare を Terraform だけで全部管理することもできますが、勧めません。Worker のコードを Terraform に流し込む形になり、バンドルもローカル開発サーバーも失うからです。ここでは 2 つの道具を用途で分けています。

| やること | 担当 | 理由 |
|---|---|---|
| D1データベースを作る | **Terraform** | 手で作ると再現できない。設定がGitに残らない |
| Workerを配備する | **wrangler** | バンドル・ローカル開発・ログ確認が使える |
| スキーマを変更する | **wrangler d1 migrations** | `migrations/` の連番SQLで履歴が残る |
| シークレットを入れる | **wrangler secret** | Terraformの状態ファイルに平文で残るのを避けるため |

最後の行が重要です。**LINEのチャネルシークレットを Terraform で管理すると、`terraform.tfstate` に平文で保存されます。** 秘密情報だけは wrangler 側に置きます。

## ファイル構成

```
infra/              Terraform。D1データベースの宣言
  versions.tf         プロバイダのバージョン固定
  variables.tf        アカウントIDや環境名の入力
  main.tf             作るもの本体
  outputs.tf          他から使う値の出口
migrations/         D1のスキーマ。連番で積み上げる
  0001_init.sql
worker/index.js     API本体。依存パッケージなし
public/index.html   実際に使う画面(LINE風UI)
public/ogp4.jpg      LINEに貼ったときのリンクカード画像
wrangler.jsonc.tmpl 設定の雛形（実ファイルは自動生成）
scripts/            terraform output → wrangler.jsonc の橋渡し
Makefile            操作はすべてここから
```

`wrangler.jsonc` を直接編集しないでください。**`make config` が terraform output の値を埋めて自動生成します。** D1のIDを手でコピペする作業をなくすためです。

---

## 手順

セットアップの手順（自動 `./setup.sh` / 手動 `make bootstrap`〜、env ファイルの作り方）は、プロジェクトルートの `README.md` にまとめてあります。ここから先は、日々の操作と、prod環境の分け方・片付け方だけを載せています。

### 日々の操作

ローカルで動かすときは、シークレットを `.dev.vars` に置きます（本番の `make secrets` とは別）。

```bash
cp .dev.vars.example .dev.vars    # 中身を埋める
make migrate-local                # ローカルのD1にスキーマを当てる
make dev                          # http://localhost:8787
```

```bash
make dev            # ローカルで起動
make deploy         # 配備
make tail           # 本番のログを流し見る
make export-csv     # events を CSV に書き出す
```

スキーマを変えたくなったら、`migrations/0002_xxx.sql` を追加して `make migrate` します。**既存のファイルは書き換えないでください。** 適用済みの履歴が壊れます。

---

## 本番環境を分ける

`env` を変えるだけで、まったく別のデータベースが立ちます。

```bash
terraform -chdir=infra apply -var env=prod
make config && make migrate && make deploy
```

実験前の練習は `dev`、本番の実験は `prod` と分けておくと、テストデータが混ざりません。**意思決定タイミングのデータは取り直しがきかない**ので、この分離は最初から効かせておくことを勧めます。

## 片付け

```bash
make destroy
```

D1データベースごと消えます。**データも消えます。** 実験後は `make export-csv` でCSVを取り出してから実行してください。
