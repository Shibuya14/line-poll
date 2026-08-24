-- ------------------------------------------------------------------
-- 0001_init : 初期スキーマ
--
-- 設計方針: 集計済みの表を持たず、起きたことを起きた順に events へ
-- 追記していく。「Aに何票入ったか」は毎回 events を数え直して出す。
-- 後から分析軸を変えても、記録し直す必要がない。
-- ------------------------------------------------------------------

CREATE TABLE polls (
  id               TEXT PRIMARY KEY,
  title            TEXT    NOT NULL,
  options_json     TEXT    NOT NULL,          -- [{"id":"o1","label":"午前"}, ...]
  created_by       TEXT    NOT NULL,          -- LINEの userId
  created_at       INTEGER NOT NULL,          -- サーバー受信時刻（UTCミリ秒）
  published_at     INTEGER,                   -- T0: グループに投稿した時刻
  closes_at        INTEGER,                   -- 予約された終了日時
  closed_at        INTEGER,                   -- 実際に締め切られた時刻
  multi_select     INTEGER NOT NULL DEFAULT 0,
  anonymous        INTEGER NOT NULL DEFAULT 0,
  allow_add_option INTEGER NOT NULL DEFAULT 0,
  show_progress    TEXT    NOT NULL DEFAULT 'all'   -- all | count | none
);

-- すべての記録。追記のみ。UPDATE も DELETE もしない。
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id      TEXT,
  user_id      TEXT    NOT NULL,   -- LINEの userId、または未識別時の仮ID
  identified   INTEGER NOT NULL DEFAULT 1,  -- 0 = 自動ログイン失敗による未識別
  type         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  server_ts    INTEGER NOT NULL,   -- サーバー受信時刻。これを正とする
  client_ts    INTEGER             -- 端末側の時刻。差分から時計ズレを検出する
);

CREATE INDEX idx_events_poll ON events (poll_id, server_ts);
CREATE INDEX idx_events_user ON events (user_id, server_ts);
CREATE INDEX idx_events_type ON events (type, server_ts);

-- 研究参加の同意状況。LINEの表示名は既定では保存しない。
CREATE TABLE participants (
  user_id      TEXT PRIMARY KEY,
  consented_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  note         TEXT
);
