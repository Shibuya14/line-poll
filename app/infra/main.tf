# ------------------------------------------------------------------
# 投票タイミング計測アプリのインフラ定義
#
# ここで宣言するのは「D1データベース」だけ。
# Worker本体とスキーマは wrangler が配備する（README の「役割分担」参照）。
# ------------------------------------------------------------------

resource "cloudflare_d1_database" "poll" {
  account_id = var.account_id
  name       = "${var.project}-${var.env}"

  # 参加者が日本にいるので、プライマリを東京側に寄せる。
  # 書き込みのレイテンシがそのまま時刻の測定誤差になるため、ここは効く。
  primary_location_hint = var.location_hint

  # primary_location_hintは作成時にしか効かず、Cloudflare側は読み取り時に
  # この値を返さない。そのためimport/refreshのたびに「差分あり→作り直し」
  # と判定され、applyのたびに既存DBを破壊して再作成してしまう事故があった
  # (2026-09-18)。既存DBに対しては常に無視する。
  lifecycle {
    ignore_changes = [primary_location_hint, read_replication]
  }
}

# ------------------------------------------------------------------
# 独自ドメインを使う場合はここを有効にする。
# 使わなければ *.workers.dev のURLがそのまま使える（研究用途では十分）。
# ------------------------------------------------------------------
# resource "cloudflare_workers_custom_domain" "poll" {
#   account_id  = var.account_id
#   zone_id     = var.zone_id
#   hostname    = "vote.example.jp"
#   service     = "${var.project}-${var.env}"
#   environment = "production"
# }
