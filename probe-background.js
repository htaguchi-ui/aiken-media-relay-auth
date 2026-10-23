// 裏に回った画面の試し（probe/background.html。2026-10-24）。ログインなし。サーバーに保存しない。
// ChatGPT・Codex のアプリの中のブラウザで Canvas の画面を開いたまま、利用者がチャットに戻った（画面が裏に回った）ときに、
// AI が頼む書き出しの前提（Realtime の知らせを受けて 60 秒の内に取りに来る・書き出し中は 5 秒ごとに生存の知らせを送って 30 秒の期限を延ばす）が
// 保たれるかを、田口さんの端末で測る。測るもの：
//   1. 主のスレッドの setInterval（1 秒）の実際の間隔
//   2. 専用の Worker（probe-background-worker.js）の中の setInterval（1 秒）の間隔
//   3. Worker から 5 秒ごとの fetch（同じ住所の静的なファイルへの GET・no-store）が送れたか
//   4. Supabase Realtime の WebSocket（公開の鍵・ランダムな名前の broadcast のチャンネル・self: true）が保たれたか。
//      Worker が 5 秒ごとに REST の broadcast で送り、主のスレッドで受けた時刻を記録する
//   5. WebCodecs の VideoEncoder（avc1）・OffscreenCanvas が Worker で使えるか
//   6. visibilitychange・pagehide・freeze・resume の時刻
// 測り始めてから RUN_LIMIT_MS（15 分）で、Worker のタイマー・通信・WebSocket・生存確認・つなぎ直しを全部止める（放っておかれても送り続けない）。
// 数えは止める時刻で締める（裏にいる間に過ぎても、戻ったときのまとめは止める時刻までの分）。
// Supabase の JS は使わず、WebSocket（Phoenix の vsn 1.0.0 の形）と fetch を直に使う（CDN を足さないため）。

const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
// 公開用のキー（ブラウザに置く前提のもの）。秘密鍵ではない。mypage.js・admin.js と同じ値
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN";
const REALTIME_WS_URL = `wss://tnzwhwitgnzoehbjrmoy.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_PUBLISHABLE_KEY)}&vsn=1.0.0`;
/** 測る長さ。これを過ぎたら全部止める（止める時刻を決めるのはここだけ） */
const RUN_LIMIT_MS = 15 * 60 * 1000;
/** Worker が送る間隔（probe-background-worker.js の BEAT_MS と同じ）と、送る回数の上限（15 分 ÷ 5 秒 ＝ 180 回） */
const SEND_INTERVAL_MS = 5000;
const MAX_SENDS = Math.ceil(RUN_LIMIT_MS / SEND_INTERVAL_MS);
/** 生存の知らせの代わりに Worker が取りに行く、同じ住所の静的なファイル（この画面そのもの） */
const PING_PATH = "/probe/background.html";
const TICK_MS = 1000;
const GAP_LIMIT_MS = 5000; // これを超えたタイマーの空きを数える
const HEARTBEAT_MS = 25000; // Realtime の生存確認（supabase-js と同じく主のスレッドのタイマーで送る）
const RECONNECT_MS = [1000, 2000, 5000, 10000]; // つなぎ直すまでの待ち（supabase-js に近い値）
const WORKER_STOP_WAIT_MS = 5000; // 止めるとき、Worker の最後の数えを待つ長さ
const SAVE_KEY = "aiken-probe-background"; // 裏に回る直前・止めたときのまとめを残す sessionStorage の鍵（画面が読み込み直されたときに出す）
const MAX_EVENTS = 400;

const $ = (id) => document.getElementById(id);

const S = {
  running: false,
  finished: false,
  startedAt: 0,
  /** 止める時刻（startedAt + RUN_LIMIT_MS） */
  stopAt: 0,
  /** 止めた時刻（数えを締める時刻。止める時刻より後にはしない） */
  endedAt: null,
  timers: [],
  main: { last: 0, maxGap: 0, over: 0 },
  hidden: { since: null, total: 0, count: 0 },
  events: [],
  worker: null,
  workerSnap: null,
  workerError: null,
  encoder: null,
  /** Realtime の送り：seq → { sentAt, doneAt, recvAt, failed }（Worker が bc-sent で知らせた seq だけ。最大 MAX_SENDS 件） */
  bc: new Map(),
  /** bc-sent より先に届いた受け取り：seq → 受けた時刻（あとで bc-sent が来たら合わせる。最大 MAX_SENDS 件） */
  early: new Map(),
  lastSentAt: null,
  /** Worker が bc-sent で知らせた一番大きい seq */
  lastSeq: 0,
  bcFail: 0,
  bcUnusable: null,
  rt: { ws: null, topic: "", ref: 0, joinRef: null, hbRef: null, opens: 0, drops: 0, failedConnects: 0, attempt: 0, joined: false, everJoined: false, unusable: null, retryTimer: null },
};

// ---- 表し方 ----
const sec = (ms) => (ms / 1000).toFixed(1);
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}
function elapsed(at) {
  const s = Math.max(0, Math.floor((at - S.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function clock(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const messageOf = (err) => String((err && err.message) || err);
/** 数えを締める時刻：止めたあとは止めた時刻、止める時刻を過ぎていれば止める時刻 */
const endOf = (now = Date.now()) => (S.finished ? S.endedAt : Math.min(now, S.stopAt));

/** 端末の種類（userAgent の要約。個人の情報は含まない） */
function deviceSummary(ua = navigator.userAgent) {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "不明な OS";
  const pick = (re, name) => {
    const m = ua.match(re);
    return m ? `${name} ${m[1]}` : null;
  };
  const browser = pick(/Edg\/(\d+)/, "Edge") ?? pick(/CriOS\/(\d+)/, "Chrome（iOS）") ?? pick(/Chrome\/(\d+)/, "Chrome") ?? pick(/Firefox\/(\d+)/, "Firefox") ?? pick(/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/, "Safari") ?? "不明なブラウザ";
  const extra = [];
  const electron = pick(/Electron\/(\d+)/, "Electron");
  if (electron) extra.push(electron);
  for (const app of ["ChatGPT", "Codex", "OpenAI"]) if (new RegExp(`\\b${app}\\b`).test(ua)) extra.push(app);
  if (/; wv\)/.test(ua)) extra.push("Android の WebView");
  if (/iPhone|iPad/.test(ua) && !/Safari\//.test(ua)) extra.push("アプリの中の画面");
  if (/HeadlessChrome/.test(ua)) extra.push("ヘッドレス");
  return [browser, os, ...extra].join("・");
}

// ---- 出来事の記録 ----
/** brief：結果のコピーにも入れる短い名前（画面の出入り・Realtime の切断・止めた時刻） */
function log(text, at = Date.now(), brief = null) {
  S.events.push({ at, text, brief });
  if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
  if (document.visibilityState === "visible") renderEvents();
}

// ---- Realtime（主のスレッドの WebSocket） ----
const channelTopic = () => `realtime:${S.rt.topic}`;
function rtSend(msg) {
  const ws = S.rt.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function rtConnect() {
  S.rt.retryTimer = null;
  if (S.rt.unusable || S.finished) return;
  let ws;
  try {
    ws = new WebSocket(REALTIME_WS_URL);
  } catch (err) {
    rtUnusable(`WebSocket を開けない（${messageOf(err)}）`);
    return;
  }
  let opened = false;
  S.rt.ws = ws;
  S.rt.hbRef = null;
  S.rt.joined = false;
  ws.onopen = () => {
    if (S.rt.ws !== ws) return;
    opened = true;
    S.rt.opens += 1;
    log(S.rt.opens === 1 ? "Realtime：つながった" : "Realtime：つなぎ直した", Date.now(), S.rt.opens === 1 ? null : "Realtime つなぎ直し");
    rtJoin();
  };
  ws.onmessage = (e) => {
    if (S.rt.ws === ws) rtMessage(e.data);
  };
  ws.onclose = (e) => {
    if (S.rt.ws !== ws) return; // 自分で閉じた（止めた・使えない）ときは数えない
    S.rt.ws = null;
    S.rt.joined = false;
    if (S.rt.unusable || S.finished) return;
    const why = `コード ${e.code}${e.reason ? `・${e.reason}` : ""}`;
    if (opened) {
      S.rt.drops += 1;
      log(`Realtime：切れた（${why}）`, Date.now(), "Realtime 切断");
    } else {
      S.rt.failedConnects += 1;
      log(`Realtime：つなげなかった（${why}）`);
    }
    const wait = RECONNECT_MS[Math.min(S.rt.attempt, RECONNECT_MS.length - 1)];
    S.rt.attempt += 1;
    S.rt.retryTimer = setTimeout(rtConnect, wait);
  };
}
/** WebSocket を閉じる（onclose では数えない・つなぎ直さない） */
function rtClose(reason) {
  const ws = S.rt.ws;
  S.rt.ws = null;
  S.rt.joined = false;
  if (S.rt.retryTimer !== null) clearTimeout(S.rt.retryTimer);
  S.rt.retryTimer = null;
  if (ws) {
    try {
      ws.close(1000, reason);
    } catch {
      /* すでに閉じている */
    }
  }
}
function rtJoin() {
  S.rt.ref += 1;
  S.rt.joinRef = String(S.rt.ref);
  rtSend({
    topic: channelTopic(),
    event: "phx_join",
    payload: { config: { broadcast: { ack: false, self: true }, presence: { key: "", enabled: false }, postgres_changes: [], private: false } },
    ref: S.rt.joinRef,
    join_ref: S.rt.joinRef,
  });
}
function rtUnusable(reason) {
  S.rt.unusable = reason;
  log(`Realtime：使えない（${reason}）。ほかの項目は測り続けます`);
  rtClose("unusable");
  render();
}
/** 自分のチャンネルの知らせを受けた。Worker が bc-sent で知らせた seq だけを数え、送った時刻は自分の記録から取る */
function rtReceived(seq, at) {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SENDS) return;
  const r = S.bc.get(seq);
  if (r) {
    if (r.recvAt === undefined) r.recvAt = at;
  } else if (seq === S.lastSeq + 1 && !S.early.has(seq) && S.early.size < MAX_SENDS) {
    // bc-sent より先に届いた（画面の凍結が解けたときなど、知らせの順が入れ替わる）。次に送る番号だけを預かり、bc-sent が来たら合わせる
    S.early.set(seq, at);
  }
}
function rtMessage(data) {
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (!m || typeof m !== "object") return;
  if (m.topic === "phoenix" && m.event === "phx_reply") {
    if (m.ref === S.rt.hbRef) S.rt.hbRef = null;
    return;
  }
  if (m.topic !== channelTopic()) return;
  const payload = m.payload && typeof m.payload === "object" ? m.payload : {};
  if (m.event === "phx_reply" && m.ref === S.rt.joinRef) {
    if (payload.status === "ok") {
      S.rt.joined = true;
      S.rt.attempt = 0;
      log(S.rt.everJoined ? "Realtime：チャンネルに入り直した" : "Realtime：チャンネルに入った");
      if (!S.rt.everJoined && S.worker) S.worker.postMessage({ cmd: "broadcast-on" });
      S.rt.everJoined = true;
    } else {
      const r = payload.response || {};
      rtUnusable(`チャンネルに入れない：${String(r.reason ?? JSON.stringify(r)).slice(0, 160)}`);
    }
    return;
  }
  if (m.event === "broadcast" && payload.event === "probe") {
    const p = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
    rtReceived(p.seq, Date.now());
    return;
  }
  if (m.event === "phx_close" || m.event === "phx_error") {
    S.rt.joined = false;
    log(`Realtime：チャンネルから外れた（${m.event}）。入り直す`);
    setTimeout(() => {
      if (!S.finished && S.rt.ws && S.rt.ws.readyState === WebSocket.OPEN && !S.rt.joined) rtJoin();
    }, 1000);
    return;
  }
  if (m.event === "system" && payload.status === "error") log(`Realtime：知らせ（${String(payload.message ?? "").slice(0, 160)}）`);
}
/** supabase-js と同じく、前の生存確認に返事が無いまま次の時刻が来たら、閉じてつなぎ直す */
function rtHeartbeat() {
  if (S.finished) return;
  const ws = S.rt.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (S.rt.hbRef !== null) {
    S.rt.hbRef = null;
    log("Realtime：前の生存確認に返事が無い（閉じてつなぎ直す）");
    ws.close(3000, "heartbeat timeout");
    return;
  }
  S.rt.ref += 1;
  S.rt.hbRef = String(S.rt.ref);
  rtSend({ topic: "phoenix", event: "heartbeat", payload: {}, ref: S.rt.hbRef });
}

// ---- Worker ----
function onWorker(e) {
  const m = e.data || {};
  if (m.type === "snapshot") {
    if (!S.finished) S.workerSnap = m;
    render();
  } else if (m.type === "stopped") {
    // Worker が止まった（止める時刻・送る回数の上限・こちらからの stop）。最後の数えを残して閉じる
    S.workerSnap = m;
    if (S.worker) S.worker.terminate();
    S.worker = null;
    finish();
    render();
  } else if (m.type === "gap") {
    log(`Worker のタイマー：${sec(m.gap)} 秒の空き`, m.at);
  } else if (m.type === "ping-fail") {
    log(`生存の知らせ（fetch）：送れなかった（${m.reason}）`, m.at);
  } else if (m.type === "bc-sent") {
    if (!Number.isInteger(m.seq) || S.bc.has(m.seq) || S.bc.size >= MAX_SENDS) return;
    const r = { sentAt: m.sentAt };
    if (S.early.has(m.seq)) {
      r.recvAt = S.early.get(m.seq);
      S.early.delete(m.seq);
    }
    S.bc.set(m.seq, r);
    S.lastSentAt = m.sentAt;
    S.lastSeq = Math.max(S.lastSeq, m.seq);
    for (const k of S.early.keys()) if (k <= S.lastSeq) S.early.delete(k); // 合わなかった預かりは捨てる
  } else if (m.type === "bc-done") {
    const r = S.bc.get(m.seq);
    if (r) r.doneAt = m.doneAt;
  } else if (m.type === "bc-fail") {
    const r = S.bc.get(m.seq);
    if (r) r.failed = true;
    S.bcFail += 1;
    log(`Realtime の送り（REST）：送れなかった（${m.reason}）`, m.at);
    if (m.unusable && !S.bcUnusable) {
      S.bcUnusable = m.reason;
      log(`Realtime の送り（REST）：使えない（${m.reason}）。以後は送らない`, m.at);
    }
  } else if (m.type === "encoder") {
    S.encoder = m;
    render();
  }
}

// ---- 主のタイマー ----
function tick() {
  if (S.finished) return;
  const now = Date.now();
  const t = Math.min(now, S.stopAt);
  const gap = t - S.main.last;
  S.main.last = t;
  if (gap > S.main.maxGap) S.main.maxGap = gap;
  if (gap > GAP_LIMIT_MS) {
    S.main.over += 1;
    log(`主のタイマー：${sec(gap)} 秒の空き`, t);
  }
  if (now >= S.stopAt) {
    finish();
    return;
  }
  if (document.visibilityState === "visible") requestSnapshot();
}
function requestSnapshot() {
  if (S.worker && !S.workerError && !S.finished) S.worker.postMessage({ cmd: "snapshot" });
  else render();
}

/** 測るのをやめる：主のタイマー・生存確認・つなぎ直し・WebSocket を止め、Worker にも止めさせる（Worker は最後の数えを返して閉じる） */
function finish() {
  if (S.finished || !S.running) return;
  S.endedAt = Math.min(Date.now(), S.stopAt);
  S.finished = true;
  for (const t of S.timers) clearInterval(t);
  S.timers = [];
  rtClose("probe finished");
  if (S.hidden.since !== null) {
    S.hidden.total += Math.max(0, S.endedAt - S.hidden.since);
    S.hidden.since = null;
  }
  if (S.worker) {
    const w = S.worker;
    w.postMessage({ cmd: "stop" });
    // 返事（stopped）が来なくても、少し待ったら閉じる
    setTimeout(() => {
      if (S.worker === w) {
        w.terminate();
        S.worker = null;
        render();
      }
    }, WORKER_STOP_WAIT_MS);
  }
  // 止めるのは自動だけ（止める時刻・送る回数の上限。止めるボタンは無い）
  log(`測り終えた（${RUN_LIMIT_MS / 60000} 分で自動で止めた）`, S.endedAt, "測り終え");
  $("start").textContent = "測り終えました";
  setStatus(`測り終えました（${RUN_LIMIT_MS / 60000} 分で自動で止めました）。［結果をコピー］で結果をコピーできます。`, true);
  save();
  render();
}

// ---- 画面の出入り ----
function hiddenTotal(now = Date.now()) {
  return S.hidden.total + (S.hidden.since !== null ? Math.max(0, endOf(now) - S.hidden.since) : 0);
}
let lastVisibility = document.visibilityState;
function onVisibility() {
  const now = Date.now();
  // 凍結の前後などで同じ状態の知らせが重ねて来ることがあるので、変わったときだけ数える
  if (document.visibilityState === lastVisibility) return;
  lastVisibility = document.visibilityState;
  if (!S.finished && now >= S.stopAt) finish(); // 裏にいる間に止める時刻を過ぎていた
  if (S.finished) {
    if (document.visibilityState === "visible") {
      renderEvents();
      render();
    }
    return;
  }
  if (document.visibilityState === "hidden") {
    if (S.hidden.since === null) {
      S.hidden.since = now;
      S.hidden.count += 1;
    }
    log("画面：裏に回った（hidden）", now, "裏へ");
    save();
  } else {
    if (S.hidden.since !== null) {
      S.hidden.total += now - S.hidden.since;
      S.hidden.since = null;
    }
    log("画面：表に戻った（visible）", now, "表へ");
    setStatus(`表に戻りました（裏にいた時間の合計 ${duration(hiddenTotal(now))}）。下のまとめを確かめて［結果をコピー］を押してください。測定は続いています（測り始めてから ${RUN_LIMIT_MS / 60000} 分で自動で止まります）。`, true);
    renderEvents();
    requestSnapshot();
  }
}
function listenLifecycle() {
  document.addEventListener("visibilitychange", onVisibility);
  addEventListener("pagehide", (e) => {
    if (S.finished) return;
    log(`pagehide（persisted: ${e.persisted}）`, Date.now(), "pagehide");
    save();
  });
  addEventListener("pageshow", (e) => {
    if (e.persisted && !S.finished) log("pageshow（戻る・進むのキャッシュから戻った）", Date.now(), "pageshow");
  });
  document.addEventListener("freeze", () => {
    if (S.finished) return;
    log("freeze（画面が凍結された）", Date.now(), "freeze");
    save();
  });
  document.addEventListener("resume", () => {
    if (S.finished) return;
    log("resume（凍結から戻った）", Date.now(), "resume");
    if (Date.now() >= S.stopAt) finish();
  });
}

// ---- まとめ ----
function realtimeStats(end) {
  let sent = 0;
  let received = 0;
  let maxDelay = 0;
  let maxSendGap = 0;
  let prevSent = null;
  const rows = [...S.bc.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  for (const r of rows) {
    if (prevSent !== null) maxSendGap = Math.max(maxSendGap, r.sentAt - prevSent);
    prevSent = r.sentAt;
    if (r.doneAt === undefined) continue;
    sent += 1;
    if (r.recvAt !== undefined) {
      received += 1;
      maxDelay = Math.max(maxDelay, r.recvAt - r.sentAt);
    }
  }
  // 今まさに続いている送る側の空き（最後に送った時刻から締めの時刻まで）も最大に入れる。送っている間（チャンネルに入れて、使えるとき）だけ
  if (S.lastSentAt !== null && !S.bcUnusable && !S.rt.unusable) maxSendGap = Math.max(maxSendGap, end - S.lastSentAt);
  return { sent, received, maxDelay, maxSendGap };
}

/** まとめの行（画面とコピーで同じ文）。技術の言葉の行には、後ろに〔 〕で短い言い換えを添える */
function summaryLines(now = Date.now()) {
  const end = endOf(now);
  const lines = [];
  lines.push(S.hidden.count ? `裏にいた時間：${duration(hiddenTotal(now))}（裏に回った回数 ${S.hidden.count} 回）` : "裏にいた時間：0 秒（まだ裏に回っていません）");
  const mainMax = Math.max(S.main.maxGap, end - S.main.last, 0);
  lines.push(`主のタイマー：最大 ${sec(mainMax)} 秒の空き（5 秒を超えた空き ${S.main.over} 回）〔画面の時計が止まった最も長い時間〕`);
  const w = S.workerSnap;
  if (S.workerError) lines.push(`Worker：動いていません（${S.workerError}）〔書き出し用の処理が動かない〕`);
  else if (!w) lines.push("Worker：まだ数えていません〔書き出し用の処理〕");
  else {
    lines.push(`Worker のタイマー：最大 ${sec(w.tick.maxGap)} 秒の空き（5 秒を超えた空き ${w.tick.over} 回）〔書き出し用の処理の時計が止まった最も長い時間〕`);
    const p = w.ping;
    lines.push(`生存の知らせ（Worker から 5 秒ごとの fetch）：${p.intervals} 回中 ${p.within10} 回が 10 秒以内（最大 ${sec(p.maxInterval)} 秒の空き・30 秒を超えた空き ${p.over30} 回・送れなかった ${p.fail} 回）〔書き出し中に「まだ動いています」とサーバーへ送る知らせが途切れなかったか〕`);
  }
  const rs = realtimeStats(end);
  const rtGloss = "〔AI からの依頼の知らせを、画面がすぐ受け取れるか〕";
  if (S.rt.unusable) lines.push(`Realtime：使えない（${S.rt.unusable}）${rtGloss}`);
  else if (!S.rt.everJoined) lines.push(`Realtime：チャンネルに入れていません（つなげなかった回数 ${S.rt.failedConnects} 回）${rtGloss}`);
  else {
    const kept = S.rt.drops === 0 ? "つながったまま" : `${S.rt.drops} 回切れた（つなぎ直し ${Math.max(0, S.rt.opens - 1)} 回）`;
    const outside = !S.finished && !S.rt.joined ? "・今はチャンネルの外" : "";
    lines.push(`Realtime：${kept}${outside}・Worker が送れた ${rs.sent} 回のうち受けた ${rs.received} 回（受けるまでの遅れ 最大 ${sec(rs.maxDelay)} 秒・送る側の空き 最大 ${sec(rs.maxSendGap)} 秒・送れなかった ${S.bcFail} 回）${rtGloss}`);
  }
  if (S.bcUnusable) lines.push(`Realtime の送り（REST の broadcast）：使えない（${S.bcUnusable}）〔試しの知らせを送れない〕`);
  const enc = S.encoder;
  const encGloss = "〔この端末で動画（MP4）を書き出せるか〕";
  if (S.workerError) lines.push(`WebCodecs：Worker が動かないため確かめられません${encGloss}`);
  else if (!enc) lines.push(`WebCodecs：確かめています${encGloss}`);
  else {
    const v = enc.supported ? `使える（Worker の中・${enc.codec}・${enc.hardware}）` : enc.videoEncoder ? `使えない（Worker の中。VideoEncoder はあるが avc1 の設定が通らない${enc.error ? `：${enc.error}` : ""}）` : "使えない（Worker の中に VideoEncoder が無い）";
    lines.push(`WebCodecs（VideoEncoder・avc1）：${v}・OffscreenCanvas：${enc.offscreen ? "使える" : "使えない"}${encGloss}`);
  }
  if (w) lines.push(`書き出しの前提との照らし合わせ：生存の知らせの最大の空き ${sec(w.ping.maxInterval)} 秒（期限 30 秒）・Realtime の受けるまでの最大の遅れ ${sec(rs.maxDelay)} 秒（取りに来るまで 60 秒）〔どちらも括弧の中の秒数より小さければ前提どおり〕`);
  return lines;
}

function copyText(now = Date.now()) {
  const brief = S.events.filter((e) => e.brief).map((e) => `${elapsed(e.at)} ${e.brief}`);
  const shown = brief.length > 16 ? [...brief.slice(0, 15), `ほか ${brief.length - 15} 件`] : brief;
  const end = endOf(now);
  return [
    "【裏に回った画面の試し】A.I.KEN Studio",
    `開始 ${clock(S.startedAt)}・${S.finished ? `測った長さ ${duration(end - S.startedAt)}（測り終え）` : `経過 ${duration(end - S.startedAt)}`}`,
    `端末：${deviceSummary()}`,
    ...summaryLines(now).map((l) => `・${l}`),
    `出来事（経過 分:秒）：${shown.length ? shown.join("／") : "なし"}`,
  ].join("\n");
}

function save() {
  if (!S.running) return;
  try {
    sessionStorage.setItem(SAVE_KEY, JSON.stringify({ startedAt: S.startedAt, savedAt: Date.now(), finished: S.finished, text: copyText() }));
  } catch {
    /* 保存できなくても測り続ける */
  }
}

// ---- 描画 ----
function setStatus(text, done = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("done", done);
}
function render() {
  if (!S.running) return;
  const now = Date.now();
  const end = endOf(now);
  const head = S.finished ? `測り終えました（測った長さ ${duration(end - S.startedAt)}・開始 ${clock(S.startedAt)}）` : `経過 ${duration(end - S.startedAt)}（開始 ${clock(S.startedAt)}・${RUN_LIMIT_MS / 60000} 分で自動で止まります）`;
  $("summary").replaceChildren(
    ...[head, ...summaryLines(now)].map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }),
  );
  const ta = $("copy-text");
  if (document.activeElement !== ta) ta.value = copyText(now);
}
function renderEvents() {
  if (!S.running) return;
  $("events").replaceChildren(
    ...S.events.map((e) => {
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.className = "time";
      t.textContent = elapsed(e.at);
      li.append(t, e.text);
      return li;
    }),
  );
}

/** text をクリップボードへ。だめなら ta（読み取り専用の textarea）を選んで execCommand。結果を note に出す */
async function copyToClipboard(text, ta, note) {
  ta.value = text;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ta.focus();
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
  }
  note.textContent = ok ? "結果をコピーしました。チャットに貼ってください。" : "コピーできませんでした。上の文を長押しして選び、コピーしてください。";
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function start() {
  if (S.running) return;
  S.running = true;
  S.startedAt = Date.now();
  S.stopAt = S.startedAt + RUN_LIMIT_MS;
  S.main.last = S.startedAt;
  S.rt.topic = `probe-bg-${randomHex(8)}`;
  try {
    sessionStorage.removeItem(SAVE_KEY);
  } catch {
    /* 無視 */
  }
  $("start").disabled = true;
  $("start").textContent = "測っています";
  $("copy").disabled = false;
  $("result").hidden = false;
  $("events-card").hidden = false;
  setStatus(`測っています。この画面を開いたまま、チャットに戻って 5〜8 分待ってください（${RUN_LIMIT_MS / 60000} 分で自動で止まります）。`);
  listenLifecycle();
  log("測り始めた");

  try {
    S.worker = new Worker(new URL("./probe-background-worker.js", import.meta.url));
    S.worker.onmessage = onWorker;
    S.worker.onerror = (e) => {
      S.workerError = e.message || "Worker を読み込めない";
      log(`Worker：止まった（${S.workerError}）`);
      render();
    };
    S.worker.postMessage({
      cmd: "start",
      pingUrl: new URL(PING_PATH, location.origin).href,
      supabaseUrl: SUPABASE_URL,
      key: SUPABASE_PUBLISHABLE_KEY,
      topic: S.rt.topic,
      stopAt: S.stopAt,
      maxBeats: MAX_SENDS,
    });
  } catch (err) {
    S.workerError = `Worker を作れない（${messageOf(err)}）`;
    log(`Worker：${S.workerError}`);
  }

  S.timers.push(setInterval(tick, TICK_MS), setInterval(rtHeartbeat, HEARTBEAT_MS));
  rtConnect();
  render();
  renderEvents();
}

// ---- 開いたとき ----
function showPrevious() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SAVE_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (!saved || typeof saved.text !== "string") return;
  $("previous").hidden = false;
  if (saved.finished) $("previous-lead").textContent = "前に測り終えた結果です（この画面が読み込み直されたので、ここに出しています）。";
  const note = document.wasDiscarded ? "（ブラウザの知らせ：この画面は裏にいる間に捨てられ、読み込み直されました）\n" : "";
  $("previous-text").value = `${note}${saved.text}`;
}

showPrevious();
$("start").addEventListener("click", start);
$("copy").addEventListener("click", () => void copyToClipboard(copyText(), $("copy-text"), $("copy-note")));
$("copy-previous").addEventListener("click", () => {
  const ta = $("previous-text");
  void copyToClipboard(ta.value, ta, $("copy-previous-note"));
});
