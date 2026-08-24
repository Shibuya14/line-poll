# terraform output で取り出せる値。
# scripts/gen-wrangler.sh がこれを読んで wrangler.jsonc を組み立てる。

output "database_name" {
  description = "D1データベース名"
  value       = cloudflare_d1_database.poll.name
}

output "database_id" {
  description = "D1データベースのUUID。wranglerのバインディングに必要。"
  value       = cloudflare_d1_database.poll.uuid
}

output "worker_name" {
  description = "Worker名（wranglerがこの名前で配備する）"
  value       = "${var.project}-${var.env}"
}

output "account_id" {
  value = var.account_id
}
