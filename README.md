# LINE準拠 投票タイミング計測アプリ

LINEの投票機能に見た目と操作を揃えたうえで、誰がいつ投票したかを記録する研究用アプリ。
対象は既存のオープンチャット（約100名）。

本体はすでにCloudflareに配備済みで、実際に投票を作って動かせる状態です。

**本番URL: https://poll-dev.poll-timing-research.workers.dev**

## 目次

- [このフォルダの中身](#このフォルダの中身)
- [アーキテクチャ](#アーキテクチャ)
  - [全体像](#全体像)
  - [認証: LINEログイン（OAuth 2.1）](#認証-lineログインoauth-21)
  - [データ設計: 集計テーブルを持たない](#データ設計-集計テーブルを持たない)
  - [投票のライフサイクル](#投票のライフサイクル)
  - [途中経過の見せ方 / 匿名投票](#途中経過の見せ方-匿名投票)
  - [リンクプレビュー（OGP）](#リンクプレビューogp)
  - [デプロイ構成](#デプロイ構成)
- [セットアップ](#セットアップ)
  - [前提](#前提)
  - [環境ファイルを作る](#環境ファイルを作る)
  - [自動セットアップ](#自動セットアップsetupsh)
  - [手動セットアップ](#手動セットアップ)
  - [ローカルで動かす](#ローカルで動かす)
  - [LINE Developers側の設定](#line-developers側の設定)
  - [動作確認](#動作確認)
- [LINEチャネルの公開設定](#lineチャネルの公開設定)
- [済んでいること](#済んでいること)
- [まだやっていないこと](#まだやっていないこと)

## このフォルダの中身

```
app/      本体。Cloudflare Workers + D1。ここで作業する
  README.md         ← IaC(Terraform/wrangler)の考え方・日々の操作
  infra/             Terraform（D1データベースの宣言）
  worker/index.js    API本体 + OGPカードの差し替え
  migrations/        データベースのスキーマ
  public/
    index.html         実際に使う画面（LINE風UI。投票APIに接続済み）
    ogp.png             LINEに貼ったときのリンクカード画像
  Makefile           操作はすべてここから
  setup.sh           初回セットアップを1本で終わらせるスクリプト

docs/     ブラウザで開ける資料（ダブルクリック）
  設計書.html            仕様と、決めるべきことの一覧
  モック.html            LINE投票を再現した画面 ＋ 取れるデータ。ログイン不要のインメモリ試作。
                          実データには繋がっていないので、本番を汚さずにUIだけ見せたい時用
  TODO.html              やることリスト
  自動ログイン診断.html   検証に使ったページ（済み）
```

## アーキテクチャ

### 全体像

```
┌────────────────────┐   LINEログイン (OAuth 2.1)   ┌───────────────────┐
│ オープンチャット      │ ─────────────────────────▶ │  LINE Platform      │
│ (アプリ内ブラウザ)    │ ◀───────────────────────── │  access.line.me     │
└──────────┬─────────┘   認可コード → IDトークン検証  └───────────────────┘
           │ HTTPS（同一オリジン。Cookieで完結）
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                              │
│  poll-dev.poll-timing-research.workers.dev                      │
│                                                                   │
│   /               public/index.html を返す（LINE風UIのSPA）       │
│   /p/:id          同じHTMLを、その投票のタイトルでOGPだけ差し替え   │
│   /api/polls*     投票の作成・一覧・投稿・投票・締切・CSV書き出し   │
│   /api/events     poll_opened / choice_focused / page_hidden 等   │
│   /auth/login     LINE認可画面へリダイレクト                       │
│   /auth/callback  認可コード→userId交換、セッション発行            │
│   それ以外         public/ の静的ファイル(assets binding)          │
└───────────────────────────────┬────────────────────────────────┘
                                 ▼
                    ┌─────────────────────┐
                    │  D1 (SQLite)          │
                    │  polls / events /      │
                    │  participants           │
                    └─────────────────────┘
```

画面配信とAPIを同じWorkerの同じオリジンで返しているのがポイントです。オリジンが分かれるとCookieの扱い（SameSite等）が面倒になりますが、1つにまとめることでセッションCookieだけで完結しています。

### 認証: LINEログイン（OAuth 2.1）

1. `/auth/login` — `state`/`nonce`を生成し、10分だけ有効な署名付きCookie(`oauth_state`)に積んで、LINEの認可URLへ302リダイレクトする。オープンチャットのアプリ内ブラウザなら、ここが無操作で一瞬で通過する（実機で確認済み）
2. `/auth/callback` — 認可コードをLINEのトークンエンドポイントに渡してIDトークンに交換し、**そのIDトークンをLINE側の検証エンドポイントに投げてuserIdを取り出す**。クライアントが自己申告してくるプロフィール情報は一切信用しない
3. `userId`を60日有効の署名付きセッションCookie(`sid`)に積む。表示名・アイコンは受け取れても保存しない

署名はHMAC-SHA256を自前実装（外部ライブラリなし）。改ざんされていないか・期限切れでないかをリクエストごとに検証する。

### データ設計: 集計テーブルを持たない

`polls` / `events` / `participants` の3テーブルのみ。投票数や参加人数のような集計値はどこにも保存せず、**すべて `events` を読み直して数え直す**（`worker/index.js` の `tally()`）。

理由は、あとから分析の切り口を変えたくなっても、データを取り直さずに済むこと。`events`は追記オンリーで、記録される種別は次のとおり：

```
poll_created / poll_published(T0) / poll_opened / choice_focused /
vote_cast / vote_changed / vote_withdrawn / page_hidden / poll_closed
```

`server_ts`（サーバー受信時刻）を正としつつ、`client_ts`も一緒に残してクロックのズレを後から見られるようにしている。

### 投票のライフサイクル

```
作成 (POST /api/polls)
  └─▶ 投稿 (POST /polls/:id/publish) … これがT0。オープンチャットに貼った瞬間を記録
        └─▶ 投票 (POST /polls/:id/vote) … vote_cast / 変更は vote_changed
              └─▶ 締切 (POST /polls/:id/close) … 以降は結果を常に全員へ開示
```

作成者以外に自動送信はできない（オープンチャットにBotがいないため）ので、作成者にだけ投票URLとコピー用ボタンを見せている。

### 途中経過の見せ方 / 匿名投票

`show_progress`（`all` / `count` / `none`）は投票ごとに持たせてあるが、今は既定の`all`（LINE準拠、票数もバーも全部見せる）で運用している。匿名投票は「他の参加者に名前を見せない」だけの機能で、**サーバー側にはuserIdとタイムスタンプを常に記録する**（作成者にも投票者名は返さない実装になっている）。

### リンクプレビュー（OGP）

`/p/:id` はLINEなどのクローラーが読みにいっても、静的ファイルをそのまま返さずWorkerが一度介在し、その投票のタイトルを`og:title`に差し込んで返す（`pollShareCard()`）。画像は`public/ogp.png`固定。説明文はあえて「タップして投票に参加」という中立な文言にしてあり、研究目的をリンクカードの時点で参加者に悟らせないようにしている。

一度LINEに読み込まれたURLはLINE側でプレビューがキャッシュされるため、OGPの見た目を直した後は**新しい投票URLで確認する**こと。

### デプロイ構成

D1データベースの宣言だけTerraformで管理し、Workerのコード・シークレット・マイグレーション・配備はwranglerが担当（チャネルシークレットが`terraform.tfstate`に平文で残るのを避けるため）。考え方の詳しい説明は `app/README.md` を参照。

## セットアップ

すでに本番は動いていますが、作り直したい・別環境（prod等）を立てたい場合の手順です。

### 前提

- Node.js（`app/package.json` は wrangler ^4 を要求）
- Terraform（D1データベースの宣言に使う）

`./setup.sh` を使うなら、Homebrewが入っていればNode.js・Terraformの導入もスクリプトが行います。

### 環境ファイルを作る

秘密情報を持つファイルは3つあり、すべて`.gitignore`済み（Gitには載らない）です。それぞれ`.example`ファイルをコピーして中身を埋めます。

```bash
cd app
cp .env.example .env
cp .dev.vars.example .dev.vars
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

| ファイル | 使われる場面 | 中身 | 値の取得場所 |
|---|---|---|---|
| `.env` | `make`コマンド全般・`setup.sh` | `CLOUDFLARE_API_TOKEN`, `LINE_CHANNEL_ID`, `DB_NAME` | Cloudflareダッシュボード → 右上アイコン→プロフィール→APIトークン（権限は**Workers スクリプト:編集**と**D1:編集**の2つだけ）／LINE Developers→LINEログインチャネル→チャネル基本設定 |
| `.dev.vars` | `wrangler dev`（ローカル実行時のみ） | `LINE_CHANNEL_SECRET`, `SESSION_SECRET` | LINE Developersのチャネル基本設定の下の方／`openssl rand -hex 32`で自分で生成 |
| `infra/terraform.tfvars` | Terraform | `account_id`, `env` | Cloudflareダッシュボード（Workers & Pagesページ右側、または`dash.cloudflare.com/<ここ>`の32桁） |

本番のチャネルシークレット・セッション鍵は`.dev.vars`ではなく`wrangler secret put`（後述の`make secrets`）で登録します。`terraform.tfstate`に平文で残るのを避けるためで、Terraformでは扱いません。

### 自動セットアップ（`setup.sh`）

```bash
cd app
./setup.sh
```

上の3ファイルの中身を対話的に聞かれるので、その場で貼り付けても構いません（すでに埋めてあれば聞かれません）。Homebrew・Node.js・Terraformの導入から、D1の作成・スキーマ適用・配備まで一括で行います。**何度実行しても壊れません**。終わると配備先URLが表示されます。

### 手動セットアップ

中で何が起きているかを知りたい場合、または`setup.sh`を使わない場合の手順です。

```bash
cd app
npm install
make bootstrap    # terraform init → D1作成 → wrangler.jsonc生成
make secrets      # LINEチャネルシークレット・セッション鍵をCloudflareに登録
make migrate      # 本番のD1にスキーマを適用
make deploy       # 配備
```

`make bootstrap`の途中で`terraform apply`が「何を作るか」を表示して確認を求めます。内容を読んで`yes`と入力してください。

### ローカルで動かす

`.dev.vars`にシークレットを置いてある前提です。

```bash
cd app
make migrate-local   # ローカルのD1にスキーマを当てる
make dev             # http://localhost:8787
```

### LINE Developers側の設定

配備先URL（`https://<worker名>.<あなた>.workers.dev`）が決まったら、LINE Developersの対象チャネルのコールバックURLに次を追記します（完全一致でないと弾かれます。改行して追記、既存のURLは消さない）。

```
https://<配備先>/auth/callback
```

### 動作確認

配備先URLを開くか、`/api/health`を見ます。

- `"d1": "ok"` とテーブル名が並んでいればデータベースまで繋がっている
- 実機（オープンチャットのアプリ内ブラウザ）で開いて、投票の作成→投稿→投票が一通りできれば完了

## LINEチャネルの公開設定

現在LINEログインのチャネルは「開発中」で、管理者・テスターとして登録したLINEアカウントしかログインできません。オープンチャットの100人全員が入れるようにするには、LINE Developersコンソールでチャネルを「公開」に切り替える必要があります（**一度公開にすると開発中には戻せない**ので、検証したい相手が揃ってから）。少人数でもう少しテストしたいだけなら、そのアカウントをテスターとして追加すればチャネルは開発中のままで試せます。

## 済んでいること

- オープンチャットのアプリ内ブラウザで、LINEログインの**自動ログインが無操作で通ることを実機で確認**（iOS 18.7 / LINE 26.12.1、アプリ完全終了を跨いでも成功）
- localStorage / sessionStorage / Cookie がいずれも保持されることを確認
- 投票API一式（作成・投稿・投票・変更・締切・CSV書き出し）を実装し、本番で動作確認済み
- LINE風の画面を実際のAPIに接続し、本番URLで一覧・作成・投票・終了までの一連の操作が動くことを確認済み
- LINEに貼ったときのリンクカード（画像・タイトル）に対応済み

## まだやっていないこと

- LINEログインチャネルの公開（上記）
- 会話中に貼ってもらったCloudflare APIトークンとLINEチャネルシークレットのローテーション（漏洩リスクを下げるため推奨、未実施）
- 「終了後の画面」は設計書の推測どおりに実装しており、LINE公式の実物スクリーンショットではまだ確認できていない
- 本番/検証用のデータベース分離（今は`dev`のみ）
