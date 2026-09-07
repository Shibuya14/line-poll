-- ------------------------------------------------------------------
-- 0002_log_extension : ログ仕様の拡張（新機能なしで取れる範囲まで）
--
-- 用語の整理:「サイクル」という新しい単位は作らない。1募集 = 1poll のまま。
-- ここで増えるのは、既存の操作（投票=応募、取消=辞退、締切など）に
-- 付随するメタ情報と、アプリの開閉・画面遷移を追うための app_sessions のみ。
-- 不参加(decline)・充足判定・確認画面・通知まわりは機能自体が無いため対象外。
--
-- テーブルの役割を明確に分ける:
--   users        : アカウント。誰か
--   polls        : 募集そのもの。何を
--   app_sessions : アプリを開いてから閉じるまでの単位。いつ・どの画面にいたか
--   poll_events  : 募集・投票まわりの出来事。何が起きたか
-- ------------------------------------------------------------------

-- ------------------------------------------------------------------
-- users（旧 participants）
-- ------------------------------------------------------------------

ALTER TABLE participants RENAME TO users;

-- LINEログイン時に受け取れるが今まで捨てていた表示名とアイコン。
-- ログインのたびに最新値で上書きする（過去時点の値は追わない）。
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN picture_url  TEXT;

-- role（coordinator/volunteer）は列として持たない。
-- 該当のpollを作った人(polls.created_by)かどうかで都度判定する。

-- ------------------------------------------------------------------
-- app_sessions（新規）
-- アプリを開いてから閉じるまでの単位。1セッション=1行で、進行に応じて更新する
-- （polls と同じ「状態を持つ行」。events系のような追記オンリーの表ではない）。
-- ------------------------------------------------------------------

CREATE TABLE app_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL,   -- LINEのuserId、または未識別時の仮ID
  identified        INTEGER NOT NULL DEFAULT 1,  -- 0 = 自動ログイン失敗による未識別
  poll_id           TEXT,               -- 開始時点で見ていた募集。無ければnull
  started_at        INTEGER NOT NULL,   -- 開始のサーバー受信時刻
  client_started_ts INTEGER,            -- 開始時の端末時刻。時計ズレ検出用
  last_activity_at  INTEGER NOT NULL,   -- 直近の操作のサーバー受信時刻。30分ルールの判定基準
  ended_at          INTEGER,            -- 明示的な終了シグナルを受け取れた時刻。無ければnull
  last_screen       TEXT,               -- list / create / poll。画面が変わるたびに上書き
  os                TEXT                -- iOS / Android / other
);

CREATE INDEX idx_app_sessions_user ON app_sessions (user_id, started_at);

-- ------------------------------------------------------------------
-- poll_events（旧 events）
-- 募集・投票まわりの出来事のみ。poll_opened/page_hidden は screen_view
-- （app_sessions側の画面遷移）に統合したため、今後は発生しない。
-- ------------------------------------------------------------------

ALTER TABLE events RENAME TO poll_events;

-- クライアント生成の重複排除キー。移行期間中に空で送られてくることを
-- 許容しNULL可にする。NULLは重複排除の対象外（同じ意味を持たないため）。
ALTER TABLE poll_events ADD COLUMN client_event_id TEXT;
CREATE UNIQUE INDEX idx_poll_events_client_event_id
  ON poll_events (client_event_id)
  WHERE client_event_id IS NOT NULL;

-- vote_cast/vote_changed/vote_withdrawnの直前に、その募集で投票中だった人数
-- （本人を含まない）。対象外のtypeでは常にNULL。
ALTER TABLE poll_events ADD COLUMN voter_count_at_action INTEGER;

-- この出来事がどのapp_sessions中に起きたか。
ALTER TABLE poll_events ADD COLUMN session_id INTEGER REFERENCES app_sessions(id);
CREATE INDEX idx_poll_events_session ON poll_events (session_id);

-- 旧テーブル名(events)時代のインデックスを、新名(poll_events)に揃えて張り直す。
-- リネーム後も内部的には有効だが、名前が古いままだと紛らわしいため。
DROP INDEX IF EXISTS idx_events_poll;
DROP INDEX IF EXISTS idx_events_user;
DROP INDEX IF EXISTS idx_events_type;
CREATE INDEX idx_poll_events_poll ON poll_events (poll_id, server_ts);
CREATE INDEX idx_poll_events_user ON poll_events (user_id, server_ts);
CREATE INDEX idx_poll_events_type ON poll_events (type, server_ts);
