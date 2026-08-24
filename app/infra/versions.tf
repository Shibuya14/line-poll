# 使用するプロバイダとバージョンを固定する。
# ここを固定しておくと、半年後に実行しても同じ結果になる。
terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # APIトークンは環境変数 CLOUDFLARE_API_TOKEN から読む。
  # ここに直接書かないこと（Gitに載ってしまう）。
}
