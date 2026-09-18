/**
 * 投票タイミング計測アプリ — APIの骨格
 *
 * この段階でやること:
 *   1. LINEログイン（オープンチャットのアプリ内ブラウザで自動ログインが走る）
 *   2. 認可コードを userId に交換する（設計書7章。ここが未検証だった最後の一点）
 *   3. イベントをD1に追記する
 *
 * 依存パッケージはゼロ。素の fetch ハンドラだけで動く。
 */

const LINE_AUTH   = "https://access.line.me/oauth2/v2.1/authorize";
const LINE_TOKEN  = "https://api.line.me/oauth2/v2.1/token";
const LINE_VERIFY = "https://api.line.me/oauth2/v2.1/verify";

const SESSION_COOKIE = "sid";
const STATE_COOKIE   = "oauth_state";
const SESSION_TTL    = 60 * 60 * 24 * 60;  // 60日
const STATE_TTL      = 60 * 10;            // 10分

/* ========================= 小道具 ========================= */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const b64urlEncode = (str) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (str) => {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(
    Uint8Array.from(atob(pad + "=".repeat((4 - pad.length % 4) % 4)), c => c.charCodeAt(0))
  );
};

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 署名付きトークンを作る。中身は読めるが、鍵がないと改ざんできない。 */
async function issue(secret, payload, ttlSec) {
  const body = b64urlEncode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return body + "." + await hmac(secret, body);
}

async function read(secret, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (await hmac(secret, body) !== sig) return null;          // 改ざん検出
  try {
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;  // 期限切れ
    return payload;
  } catch { return null; }
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const hit = raw.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const randomHex = (bytes = 16) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");

async function session(request, env) {
  if (!env.SESSION_SECRET) return null;
  return read(env.SESSION_SECRET, getCookie(request, SESSION_COOKIE));
}

/* ========================= ルート ========================= */

/** 配線が正しいかを一目で確認するための画面。 */
async function health(env) {
  const checks = { d1: "unknown", tables: [], config: {} };
  try {
    const r = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();
    checks.tables = r.results.map(x => x.name);
    checks.d1 = checks.tables.length ? "ok" : "migrations未適用";
  } catch (e) {
    checks.d1 = "error: " + e.message;
  }
  checks.config = {
    LINE_CHANNEL_ID:     env.LINE_CHANNEL_ID     ? "設定済み" : "未設定",
    LINE_CHANNEL_SECRET: env.LINE_CHANNEL_SECRET ? "設定済み" : "未設定（wrangler secret put）",
    SESSION_SECRET:      env.SESSION_SECRET      ? "設定済み" : "未設定（wrangler secret put）"
  };
  return json({ ok: checks.d1 === "ok", ...checks });
}

/** 設定漏れは500ではなく、何をすればよいかを返す。 */
function missingConfig(env, keys) {
  const missing = keys.filter(k => !env[k]);
  if (!missing.length) return null;
  return json({
    error: "設定が足りません: " + missing.join(", "),
    hint: "本番は make secrets、ローカルは .dev.vars に書いてください"
  }, 500);
}

/** LINEの認可画面へ送る。アプリ内ブラウザなら無操作で戻ってくる。 */
async function login(request, env, url) {
  const bad = missingConfig(env, ["LINE_CHANNEL_ID", "SESSION_SECRET"]);
  if (bad) return bad;

  const state = randomHex();
  const nonce = randomHex();
  const back  = url.searchParams.get("back") || "/";
  const redirectUri = url.origin + "/auth/callback";

  const authorize = new URL(LINE_AUTH);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id:     env.LINE_CHANNEL_ID,
    redirect_uri:  redirectUri,
    state, nonce,
    scope: "openid profile"
    // disable_auto_login は指定しない。既定の false が自動ログイン有効。
  }).toString();

  const stateToken = await issue(env.SESSION_SECRET, { state, nonce, back }, STATE_TTL);
  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString(), "set-cookie": setCookie(STATE_COOKIE, stateToken, STATE_TTL) }
  });
}

/** 認可コードを userId に交換して、セッションを張る。 */
async function callback(request, env, url) {
  const bad = missingConfig(env, ["LINE_CHANNEL_ID", "LINE_CHANNEL_SECRET", "SESSION_SECRET"]);
  if (bad) return bad;

  const err = url.searchParams.get("error");
  if (err) return json({ error: err, description: url.searchParams.get("error_description") }, 400);

  const saved = await read(env.SESSION_SECRET, getCookie(request, STATE_COOKIE));
  const code  = url.searchParams.get("code");
  if (!saved)                                   return json({ error: "stateが見つからないか期限切れです" }, 400);
  if (saved.state !== url.searchParams.get("state")) return json({ error: "stateが一致しません" }, 400);
  if (!code)                                    return json({ error: "認可コードがありません" }, 400);

  // 1) 認可コード → トークン
  const tokenRes = await fetch(LINE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  url.origin + "/auth/callback",
      client_id:     env.LINE_CHANNEL_ID,
      client_secret: env.LINE_CHANNEL_SECRET
    })
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok) return json({ error: "トークン交換に失敗しました", detail: token }, 502);

  // 2) IDトークンを検証して userId を取り出す。
  //    クライアントから送られてきたプロフィールは信用しない（設計書7章）。
  const verifyRes = await fetch(LINE_VERIFY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id_token:  token.id_token,
      client_id: env.LINE_CHANNEL_ID,
      nonce:     saved.nonce
    })
  });
  const claims = await verifyRes.json();
  if (!verifyRes.ok || !claims.sub) return json({ error: "IDトークンの検証に失敗しました", detail: claims }, 502);

  const userId = claims.sub;   // ← これがLINEの userId。アカウント削除まで不変。
  const now = Date.now();

  // 表示名とアイコンはログインのたびに最新値で上書きする。
  // first_seen_at は初回のみ書き込み、以降は更新しない。
  await env.DB.prepare(
    `INSERT INTO users (user_id, first_seen_at, display_name, picture_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, picture_url = excluded.picture_url`
  ).bind(userId, now, claims.name || null, claims.picture || null).run();

  const sid = await issue(env.SESSION_SECRET, { uid: userId }, SESSION_TTL);
  return new Response(null, {
    status: 302,
    headers: {
      location: saved.back || "/",
      "set-cookie": setCookie(SESSION_COOKIE, sid, SESSION_TTL)
    }
  });
}

async function me(request, env) {
  const s = await session(request, env);
  if (!s) return json({ authenticated: false }, 200);
  const row = await env.DB.prepare("SELECT role FROM users WHERE user_id = ?").bind(s.uid).first();
  return json({ authenticated: true, user_id: s.uid, role: (row && row.role) || "user" });
}

/**
 * イベントを1件記録する（クライアント発）。
 * ログインしていない場合も拒否せず、identified=0 で受け付ける。
 * 識別できた人だけを分析すると、測定対象と相関した欠測が生まれるため（設計書7章）。
 */
async function postEvent(request, env) {
  const s = await session(request, env);
  const body = await request.json().catch(() => ({}));
  if (!body.type) return json({ error: "type は必須です" }, 400);

  const userId = s ? s.uid : ("anon_" + (body.anon_id || "unknown"));
  await env.DB.prepare(
    `INSERT INTO poll_events
       (poll_id, user_id, identified, type, payload_json, server_ts, client_ts, client_event_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING`
  ).bind(
    body.poll_id || null,
    userId,
    s ? 1 : 0,
    body.type,
    JSON.stringify(body.payload || {}),
    Date.now(),                                   // ← サーバー受信時刻を正とする
    Number.isFinite(body.client_ts) ? body.client_ts : null,
    body.client_event_id || null,
    Number.isFinite(body.session_id) ? body.session_id : null
  ).run();

  return json({ ok: true });
}

async function listEvents(request, env, url) {
  const pollId = url.searchParams.get("poll_id");
  const q = pollId
    ? env.DB.prepare("SELECT * FROM poll_events WHERE poll_id = ? ORDER BY id DESC LIMIT 200").bind(pollId)
    : env.DB.prepare("SELECT * FROM poll_events ORDER BY id DESC LIMIT 200");
  const r = await q.all();
  return json({ count: r.results.length, events: r.results });
}

/**
 * app_sessions の作成・更新・終了。
 * kind: "ping"（開始 or 継続の合図。30分以上空いていれば新しいセッションを作る）
 *       "end"（明示的な終了シグナル）
 */
async function postSession(request, env) {
  const s = await session(request, env);
  const body = await request.json().catch(() => ({}));
  const userId = s ? s.uid : ("anon_" + (body.anon_id || "unknown"));
  const now = Date.now();
  const SESSION_GAP_MS = 30 * 60 * 1000;

  if (body.kind === "end") {
    const id = Number(body.session_id);
    if (Number.isFinite(id)) {
      await env.DB.prepare(
        "UPDATE app_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL"
      ).bind(now, id).run();
    }
    return json({ ok: true });
  }

  // kind === "ping"（既定）
  const screen = ["list", "create", "poll"].includes(body.screen) ? body.screen : null;
  const existingId = Number.isFinite(Number(body.session_id)) ? Number(body.session_id) : null;

  let row = existingId
    ? await env.DB.prepare("SELECT id, last_activity_at, ended_at FROM app_sessions WHERE id = ?").bind(existingId).first()
    : null;

  const stale = !row || row.ended_at !== null || (now - row.last_activity_at) > SESSION_GAP_MS;

  if (!stale) {
    // poll_id は「今いる画面」に合わせて毎回上書きする（開始時点だけの記録にしない）。
    // 投票詳細ページ以外にいる時はnullにして、「どのpollの詳細ページで離脱したか」を
    // last_screen='poll' と組み合わせて特定できるようにする。
    await env.DB.prepare(
      "UPDATE app_sessions SET last_activity_at = ?, last_screen = COALESCE(?, last_screen), poll_id = ? WHERE id = ?"
    ).bind(now, screen, body.poll_id || null, existingId).run();
    return json({ ok: true, session_id: existingId });
  }

  // 前のセッションが終了シグナルを受け取れないまま止まっていた場合、
  // 最後に分かっている活動時刻をもって終了とみなす（サーバー側の後始末）。
  if (row && row.ended_at === null) {
    await env.DB.prepare(
      "UPDATE app_sessions SET ended_at = ? WHERE id = ?"
    ).bind(row.last_activity_at, existingId).run();
  }

  const ins = await env.DB.prepare(
    `INSERT INTO app_sessions (user_id, identified, poll_id, started_at, client_started_ts, last_activity_at, last_screen, os)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId,
    s ? 1 : 0,
    body.poll_id || null,
    now,
    Number.isFinite(body.client_ts) ? body.client_ts : null,
    now,
    screen,
    body.os || null
  ).run();

  return json({ ok: true, session_id: ins.meta.last_row_id });
}


/* ========================= 投票 ========================= */

const nowMs = () => Date.now();

/** リクエストボディから record() に渡す共通オプションだけ取り出す */
const evtOpts = b => ({
  clientEventId: b.client_event_id || null,
  sessionId: Number.isFinite(b.session_id) ? b.session_id : null
});

/**
 * イベントを1件書く（サーバー起点。API呼び出しの結果として記録するもの）。
 * opts.sessionId    — このイベントが起きたapp_sessions.id（無ければnull）
 * opts.clientEventId — クライアント生成の重複排除キー（無ければnull）
 * opts.voterCount   — vote_cast/vote_changed/vote_withdrawn の直前の投票者数（無ければnull）
 */
async function record(env, pollId, userId, type, payload, opts = {}) {
  await env.DB.prepare(
    `INSERT INTO poll_events
       (poll_id, user_id, identified, type, payload_json, server_ts, client_event_id, voter_count_at_action, session_id)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING`
  ).bind(
    pollId, userId, type, JSON.stringify(payload || {}), nowMs(),
    opts.clientEventId || null,
    Number.isFinite(opts.voterCount) ? opts.voterCount : null,
    Number.isFinite(opts.sessionId) ? opts.sessionId : null
  ).run();
}

async function loadPoll(env, id) {
  const r = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(id).first();
  if (!r) return null;
  r.options = JSON.parse(r.options_json);
  return r;
}

/**
 * 投票状況をイベントログから数え直す。集計表は持たない。
 * 返り値: Map<userId, string[]>
 */
async function tally(env, pollId) {
  const r = await env.DB.prepare(
    "SELECT user_id, type, payload_json FROM poll_events WHERE poll_id = ? AND type IN ('vote_cast','vote_changed','vote_withdrawn') ORDER BY id"
  ).bind(pollId).all();

  const m = new Map();
  for (const e of r.results) {
    const p = JSON.parse(e.payload_json);
    if (e.type === "vote_withdrawn") m.delete(e.user_id);
    else m.set(e.user_id, p.to);
  }
  return m;
}

/** 参加者に返す形。show_progress と anonymous と締切状態で見せる量を変える。 */
function shape(poll, votes, uid) {
  const closed  = !!poll.closed_at;
  const reveal  = closed || poll.show_progress === "all";
  const showNum = closed || poll.show_progress === "all" || poll.show_progress === "count";

  const counts = {};
  poll.options.forEach(o => counts[o.id] = []);
  votes.forEach((ids, u) => (ids || []).forEach(id => { if (counts[id]) counts[id].push(u); }));

  return {
    id: poll.id,
    title: poll.title,
    created_by: poll.created_by,
    is_owner: poll.created_by === uid,
    published_at: poll.published_at,
    closes_at: poll.closes_at,
    closed: closed,
    multi_select: !!poll.multi_select,
    anonymous: !!poll.anonymous,
    allow_add_option: !!poll.allow_add_option,
    show_progress: poll.show_progress,
    participants: showNum ? votes.size : null,
    my_vote: votes.get(uid) || null,
    options: poll.options.map(o => ({
      id: o.id,
      label: o.label,
      count: reveal ? counts[o.id].length : null,
      // 匿名投票では投票者を返さない。作成者にも返さない（設計書5.3）
      voters: (reveal && !poll.anonymous) ? counts[o.id] : null
    }))
  };
}

/**
 * shape() が返す options[].voters（userIdの配列）に display_name/picture_url を載せる。
 * 匿名投票では voters 自体が null なので何もしない。
 * 投票した人一覧画面（設計書には無いが、選択肢の人数からドリルダウンする導線）のため。
 */
async function attachVoterNames(env, shaped) {
  const ids = new Set();
  shaped.options.forEach(o => { if (Array.isArray(o.voters)) o.voters.forEach(id => ids.add(id)); });
  if (!ids.size) return shaped;

  const idList = [...ids];
  const placeholders = idList.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `SELECT user_id, display_name, picture_url FROM users WHERE user_id IN (${placeholders})`
  ).bind(...idList).all();
  const info = new Map(r.results.map(u => [u.user_id, u]));

  shaped.options = shaped.options.map(o => {
    if (!Array.isArray(o.voters)) return o;
    return Object.assign({}, o, {
      voters: o.voters.map(id => ({
        user_id: id,
        display_name: (info.get(id) && info.get(id).display_name) || null,
        picture_url: (info.get(id) && info.get(id).picture_url) || null
      }))
    });
  });
  return shaped;
}

async function listPolls(env, uid) {
  const r = await env.DB.prepare("SELECT * FROM polls ORDER BY created_at DESC LIMIT 100").all();
  const out = [];
  for (const row of r.results) {
    row.options = JSON.parse(row.options_json);
    out.push(shape(row, await tally(env, row.id), uid));
  }
  return json({ polls: out });
}

async function createPoll(request, env, uid) {
  const b = await request.json().catch(() => ({}));
  const title = (b.title || "").trim();
  const labels = (b.options || []).map(x => String(x || "").trim()).filter(Boolean);

  if (!title)            return json({ error: "質問を入力してください" }, 400);
  if (labels.length < 2) return json({ error: "選択肢は2つ以上必要です" }, 400);
  if (labels.length > 20) return json({ error: "選択肢が多すぎます" }, 400);

  const id = "p" + crypto.randomUUID().slice(0, 8);
  const options = labels.map((l, i) => ({ id: "o" + (i + 1), label: l }));
  const progress = ["all", "count", "none"].includes(b.show_progress) ? b.show_progress : "all";
  const ts = nowMs();

  await env.DB.prepare(
    `INSERT INTO polls (id, title, options_json, created_by, created_at, closes_at,
                        multi_select, anonymous, allow_add_option, show_progress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, title, JSON.stringify(options), uid, ts,
    Number.isFinite(b.closes_at) ? b.closes_at : null,
    b.multi_select ? 1 : 0, b.anonymous ? 1 : 0, b.allow_add_option ? 1 : 0, progress
  ).run();

  await record(env, id, uid, "poll_created", { options: options.length, show_progress: progress }, evtOpts(b));
  const poll = await loadPoll(env, id);
  return json({ poll: shape(poll, new Map(), uid) }, 201);
}

/** T0 の記録。作成者がグループに投稿した瞬間を押さえる（設計書5.5）。 */
async function publishPoll(request, env, poll, uid) {
  if (poll.created_by !== uid) return json({ error: "作成者のみ実行できます" }, 403);
  if (poll.published_at)       return json({ error: "すでに投稿済みです" }, 409);
  const b = await request.json().catch(() => ({}));
  const ts = nowMs();
  await env.DB.prepare("UPDATE polls SET published_at = ? WHERE id = ?").bind(ts, poll.id).run();
  await record(env, poll.id, uid, "poll_published", { note: "T0" }, evtOpts(b));
  return json({ ok: true, published_at: ts });
}

async function castVote(request, env, poll, uid) {
  if (poll.closed_at) return json({ error: "この投票は終了しています" }, 409);

  const b = await request.json().catch(() => ({}));
  const picked = Array.isArray(b.options) ? b.options : (b.option ? [b.option] : []);
  const valid = new Set(poll.options.map(o => o.id));

  if (!picked.length)                       return json({ error: "選択肢を選んでください" }, 400);
  if (picked.some(x => !valid.has(x)))      return json({ error: "存在しない選択肢です" }, 400);
  if (!poll.multi_select && picked.length > 1) return json({ error: "この投票は1つだけ選べます" }, 400);

  const votes = await tally(env, poll.id);
  const prev = votes.get(uid) || null;
  const same = prev && prev.length === picked.length && prev.every(x => picked.includes(x));

  if (same) return json({ ok: true, unchanged: true, poll: await attachVoterNames(env, shape(poll, votes, uid)) });

  // 本人のこの行動が反映される直前の投票者数（本人を含まない）。
  const voterCount = votes.size - (prev ? 1 : 0);
  const opts = { ...evtOpts(b), voterCount };
  if (prev) await record(env, poll.id, uid, "vote_changed", { from: prev, to: picked }, opts);
  else      await record(env, poll.id, uid, "vote_cast",    { to: picked }, opts);

  return json({ ok: true, poll: await attachVoterNames(env, shape(poll, await tally(env, poll.id), uid)) });
}

async function withdrawVote(request, env, poll, uid) {
  if (poll.closed_at) return json({ error: "この投票は終了しています" }, 409);
  const b = await request.json().catch(() => ({}));
  const votes = await tally(env, poll.id);
  if (!votes.has(uid)) return json({ error: "まだ投票していません" }, 400);
  // 取り消す直前の投票者数（本人を含まない。他の定義と揃える）。
  await record(env, poll.id, uid, "vote_withdrawn", { from: votes.get(uid) }, { ...evtOpts(b), voterCount: votes.size - 1 });
  return json({ ok: true, poll: await attachVoterNames(env, shape(poll, await tally(env, poll.id), uid)) });
}

async function closePoll(request, env, poll, uid) {
  if (poll.created_by !== uid) return json({ error: "作成者のみ終了できます" }, 403);
  if (poll.closed_at)          return json({ error: "すでに終了しています" }, 409);
  const b = await request.json().catch(() => ({}));
  const ts = nowMs();
  await env.DB.prepare("UPDATE polls SET closed_at = ? WHERE id = ?").bind(ts, poll.id).run();
  await record(env, poll.id, uid, "poll_closed", {}, evtOpts(b));
  const fresh = await loadPoll(env, poll.id);
  return json({ ok: true, poll: await attachVoterNames(env, shape(fresh, await tally(env, poll.id), uid)) });
}

/**
 * 選択肢の追加(allow_add_optionが立っている投票のみ)。
 * 誰でも追加できる(作成者限定ではない) — 参加者どうしで選択肢を出し合う機能のため。
 */
async function addOption(request, env, poll, uid) {
  if (poll.closed_at)          return json({ error: "この投票は終了しています" }, 409);
  if (!poll.allow_add_option)  return json({ error: "選択肢の追加は許可されていません" }, 403);

  const b = await request.json().catch(() => ({}));
  const label = String(b.label || "").trim();
  if (!label)                      return json({ error: "選択肢を入力してください" }, 400);
  if (poll.options.length >= 20)   return json({ error: "選択肢が多すぎます" }, 400);

  const nextNum = poll.options.reduce((max, o) => {
    const m = /^o(\d+)$/.exec(o.id);
    return m ? Math.max(max, +m[1]) : max;
  }, 0) + 1;
  const newOpt = { id: "o" + nextNum, label };
  const options = poll.options.concat([newOpt]);

  await env.DB.prepare("UPDATE polls SET options_json = ? WHERE id = ?").bind(JSON.stringify(options), poll.id).run();
  await record(env, poll.id, uid, "option_added", { id: newOpt.id, label }, evtOpts(b));

  const fresh = await loadPoll(env, poll.id);
  return json({ ok: true, poll: await attachVoterNames(env, shape(fresh, await tally(env, poll.id), uid)) });
}

/** 生ログのCSV。作成者のみ。分析はここから始める。 */
async function exportCsv(env, poll, uid) {
  if (poll.created_by !== uid) return new Response("作成者のみ取得できます", { status: 403 });

  const r = await env.DB.prepare(
    `SELECT id, poll_id, user_id, identified, type, payload_json, server_ts, client_ts,
            client_event_id, voter_count_at_action, session_id
     FROM poll_events WHERE poll_id = ? ORDER BY id`
  ).bind(poll.id).all();

  const t0 = poll.published_at;
  const head = "id,poll_id,user_id,identified,type,payload,server_ts,server_iso,client_ts,ms_since_t0,client_event_id,voter_count_at_action,session_id";
  const esc = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = r.results.map(e => [
    e.id, e.poll_id, e.user_id, e.identified, e.type, e.payload_json,
    e.server_ts, new Date(e.server_ts).toISOString(), e.client_ts,
    t0 ? e.server_ts - t0 : "",
    e.client_event_id, e.voter_count_at_action, e.session_id
  ].map(esc).join(","));

  return new Response([head, ...rows].join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${poll.id}-events.csv"`
    }
  });
}

/** /api/polls 以下のルーティング */
async function pollsRouter(request, env, url, path) {
  const s = await session(request, env);
  if (!s) return json({ error: "ログインが必要です", login: "/auth/login" }, 401);
  const uid = s.uid;

  if (path === "/api/polls") {
    if (request.method === "POST") return createPoll(request, env, uid);
    return listPolls(env, uid);
  }

  const m = path.match(/^\/api\/polls\/([A-Za-z0-9_-]+)(\/[a-z.]+)?$/);
  if (!m) return json({ error: "見つかりません" }, 404);

  const poll = await loadPoll(env, m[1]);
  if (!poll) return json({ error: "投票が見つかりません" }, 404);
  const action = m[2] || "";

  switch (action) {
    case "":            return json({ poll: await attachVoterNames(env, shape(poll, await tally(env, poll.id), uid)) });
    case "/publish":    return publishPoll(request, env, poll, uid);
    case "/vote":       return request.method === "DELETE"
                               ? withdrawVote(request, env, poll, uid)
                               : castVote(request, env, poll, uid);
    case "/close":      return closePoll(request, env, poll, uid);
    case "/options":    return addOption(request, env, poll, uid);
    case "/export.csv": return exportCsv(env, poll, uid);
    default:            return json({ error: "見つかりません" }, 404);
  }
}

/* ========================= 管理者 ========================= */

const ADMIN_TABLES = ["users", "polls", "app_sessions", "poll_events"];
const ADMIN_ORDER  = { users: "first_seen_at", polls: "created_at", app_sessions: "id", poll_events: "id" };

async function requireAdmin(request, env) {
  const s = await session(request, env);
  if (!s) return { error: json({ error: "ログインが必要です", login: "/auth/login" }, 401) };
  const row = await env.DB.prepare("SELECT role FROM users WHERE user_id = ?").bind(s.uid).first();
  if (!row || row.role !== "admin") return { error: json({ error: "管理者のみアクセスできます" }, 403) };
  return { uid: s.uid };
}

function rowsToCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}

/** テーブルの中身をそのまま返す。閲覧・CSVダウンロードともadminのみ（settingページ用）。 */
async function adminTable(request, env, url, tableName) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  if (!ADMIN_TABLES.includes(tableName)) return json({ error: "不明なテーブルです" }, 404);

  const r = await env.DB.prepare(
    `SELECT * FROM ${tableName} ORDER BY ${ADMIN_ORDER[tableName]} DESC LIMIT 1000`
  ).all();

  if (url.searchParams.get("format") === "csv") {
    return new Response(rowsToCsv(r.results), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${tableName}.csv"`
      }
    });
  }
  return json({ table: tableName, rows: r.results });
}

/** ユーザーのroleを変更する。admin自身しか実行できない。 */
async function adminSetRole(request, env, targetUserId) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const b = await request.json().catch(() => ({}));
  if (b.role !== "admin" && b.role !== "user") return json({ error: "roleはadminかuserを指定してください" }, 400);

  const r = await env.DB.prepare("UPDATE users SET role = ? WHERE user_id = ?").bind(b.role, targetUserId).run();
  if (!r.meta.changes) return json({ error: "ユーザーが見つかりません" }, 404);
  return json({ ok: true, user_id: targetUserId, role: b.role });
}

/* ========================= 共有カード(OGP) ========================= */

const escAttr = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/**
 * /p/:id はSPAのindex.htmlをそのまま返すだけだと、LINEにURLを貼った時の
 * リンクプレビューが「投票」固定・画像なしになる(og:titleが投票名にならない)。
 * ここでリンクカード用のメタだけをその投票のタイトルに差し替えて返す。
 * 実際の画面(JS)は差し替え後もそのまま動く — index.htmlの中身は変えていない。
 */
async function pollShareCard(request, env, url, id) {
  const assetRes = await env.ASSETS.fetch(new Request(new URL("/", url), request));
  if (!assetRes.ok) return assetRes;

  let title = "投票";
  try {
    const row = await env.DB.prepare("SELECT title FROM polls WHERE id = ?").bind(id).first();
    if (row && row.title) title = row.title;
  } catch (e) { /* タイトルが取れなくても既定値でカードは出す */ }

  const html = await assetRes.text();
  const t = escAttr(title);
  const shareUrl = escAttr(url.origin + "/p/" + id);
  const injected = html
    .replace(/<title>.*?<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1タップして投票に参加$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${shareUrl}$2`);

  return new Response(injected, {
    status: assetRes.status,
    headers: assetRes.headers
  });
}

/* ========================= 入口 ========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health")   return await health(env);
      if (path === "/auth/login")   return await login(request, env, url);
      if (path === "/auth/callback")return await callback(request, env, url);
      if (path === "/api/me")       return await me(request, env);
      if (path === "/api/events")   {
        return request.method === "POST"
          ? await postEvent(request, env)
          : await listEvents(request, env, url);
      }
      if (path === "/api/sessions" && request.method === "POST") return await postSession(request, env);
      const adminTableMatch = path.match(/^\/api\/admin\/tables\/([a-z_]+)$/);
      if (adminTableMatch && request.method === "GET") return await adminTable(request, env, url, adminTableMatch[1]);
      const adminRoleMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
      if (adminRoleMatch && request.method === "POST") return await adminSetRole(request, env, decodeURIComponent(adminRoleMatch[1]));
      if (path.startsWith("/api/polls")) return await pollsRouter(request, env, url, path);
      if (path === "/auth/logout") {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie(SESSION_COOKIE, "", 0) } });
      }
      const shareMatch = path.match(/^\/p\/([A-Za-z0-9_-]+)$/);
      if (shareMatch && request.method === "GET") return await pollShareCard(request, env, url, shareMatch[1]);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }

    // それ以外は public/ の静的ファイルを返す
    return env.ASSETS.fetch(request);
  }
};
