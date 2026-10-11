-- ------------------------------------------------------------------
-- 0005_poll_soft_delete : 管理者による投票の削除（非表示）
--
-- 行は消さずに deleted_at を立てるだけ。立っている投票は一覧・詳細・
-- 共有URLのどこからも見えなくなるが、polls / poll_events の記録は残る
-- （ログは追記のみ・消さない、という 0001 の方針を崩さないため）。
-- 分析では deleted_at IS NOT NULL の投票をテスト等として除外できる。
-- 誤って削除した場合は deleted_at を NULL に戻せば復活する。
-- 削除の操作自体も poll_events に type='poll_deleted' として記録する。
-- ------------------------------------------------------------------

ALTER TABLE polls ADD COLUMN deleted_at INTEGER;   -- 削除した時刻（UTCミリ秒）。NULL = 表示中
ALTER TABLE polls ADD COLUMN deleted_by TEXT;      -- 削除した管理者の userId
