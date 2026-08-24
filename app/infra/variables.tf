variable "account_id" {
  description = "CloudflareのアカウントID。ダッシュボード右下、またはURLに含まれる32桁の16進数。"
  type        = string
}

variable "env" {
  description = "環境名。dev と prod で別々のデータベースを作るために使う。"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env は dev か prod のどちらかにしてください。"
  }
}

variable "project" {
  description = "プロジェクト名。作られるリソース名の先頭に付く。"
  type        = string
  default     = "poll"
}

variable "location_hint" {
  description = "D1のプライマリを置く地域。日本の参加者が対象なので apac が適切。"
  type        = string
  default     = "apac"
}
