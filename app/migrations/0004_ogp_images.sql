-- ------------------------------------------------------------------
-- 0004_ogp_images : リンクカード画像(og:image)を管理者画面から差し替える
--
-- 画像そのものをD1に置く（1枚1MBまで。D1の1行上限2MBに収まる）。
-- R2を使わないのは、Terraform/CIに新しい資源を足さずに済ませるため。
--
-- id は画像内容のSHA-256先頭12桁。同じ画像を上げ直しても行は増えない。
-- 使用中の画像 = activated_at が最も新しい行。過去の画像は残しておき、
-- 管理者画面から「これに戻す」で activated_at を更新すれば元に戻せる。
-- 1行もなければ public/ の静的画像（make ogp で置いたもの）がそのまま使われる。
-- ------------------------------------------------------------------

CREATE TABLE ogp_images (
  id           TEXT PRIMARY KEY,
  mime         TEXT    NOT NULL,          -- image/png | image/jpeg
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        BLOB    NOT NULL,
  uploaded_by  TEXT    NOT NULL,          -- LINEの userId
  uploaded_at  INTEGER NOT NULL,          -- UTCミリ秒
  activated_at INTEGER                    -- 使用中にした時刻（UTCミリ秒）
);
