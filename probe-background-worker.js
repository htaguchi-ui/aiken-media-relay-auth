// 裏に回った画面の試し（probe/background.html。2026-10-24）の専用の Worker。
// Canvas の書き出しは Worker（canvas-app の render/exporter.ts）で動くので、画面が裏に回ったときに Worker の中で
//   ・1 秒ごとのタイマーがどれだけ遅れるか
//   ・5 秒ごとの通信（生存の知らせの代わり：同じ住所の静的なファイルへの GET・no-store。サーバーに何も書かない）が送れるか
//   ・5 秒ごとに Supabase Realtime の REST の broadcast で自分のチャンネルへ送れるか（受けるのは主のスレッドの WebSocket）
//   ・VideoEncoder（avc1）と OffscreenCanvas が使えるか
// を測る。数え方は主のスレッド（probe-background.js）が { cmd: "snapshot" } で聞いたときに返す。
// 止める時刻（stopAt）と送る回数の上限（maxBeats）は主のスレッドから受け取り、Worker も自分で止まる
// （主のスレッドのタイマーが裏で絞られていても、送り続けないため）。止めたら { type: "stopped" } で最後の数えを返す。
// 主のスレッドから読み込む（new Worker）。classic の Worker（import しない）。
"use strict";

const TICK_MS = 1000;
const BEAT_MS = 5000;
const GAP_LIMIT_MS = 5000; // これを超えたタイマーの空きを数える
const FETCH_TIMEOUT_MS = 15000;
const STOP_WAIT_MS = 3000; // 止めるとき、送っている途中の通信を待つ長さ（過ぎたら打ち切る）
// 書き出しで試す H.264 の候補（1920×1080・30fps・8Mbps。High → Main → Baseline。canvas-app の renderWorker.ts と同じ順・同じ設定の形）
const AVC_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.420028"];

let st = null;

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.cmd === "start" && !st) start(m);
  else if (m.cmd === "broadcast-on" && st) st.bc.on = true;
  else if (m.cmd === "snapshot" && st) self.postMessage({ type: "snapshot", ...snapshot() });
  else if (m.cmd === "stop" && st) void stop();
};

function start(cfg) {
  const now = Date.now();
  st = {
    cfg,
    startedAt: now,
    stopAt: cfg.stopAt,
    maxBeats: cfg.maxBeats,
    stopped: false,
    endedAt: null,
    timers: [],
    inflight: new Set(),
    seq: 0,
    tick: { last: now, maxGap: 0, over: 0 },
    // 間隔は配列にためず、数と最大だけを持つ
    ping: { sent: 0, ok: 0, fail: 0, lastOkAt: null, intervals: 0, within10: 0, over30: 0, maxInterval: 0 },
    bc: { on: false, unusable: false },
  };
  st.timers.push(setInterval(tick, TICK_MS), setInterval(beat, BEAT_MS));
  beat();
  checkEncoder().then((r) => self.postMessage({ type: "encoder", ...r }));
}

/** 締めの時刻：止めたあとは止めた時刻、止める時刻を過ぎていれば止める時刻 */
const endOf = (now) => (st.stopped ? st.endedAt : Math.min(now, st.stopAt));

function tick() {
  if (st.stopped) return;
  const now = Date.now();
  const t = Math.min(now, st.stopAt);
  const gap = t - st.tick.last;
  st.tick.last = t;
  if (gap > st.tick.maxGap) st.tick.maxGap = gap;
  if (gap > GAP_LIMIT_MS) {
    st.tick.over += 1;
    self.postMessage({ type: "gap", at: t, gap });
  }
  if (now >= st.stopAt) void stop();
}

function beat() {
  if (st.stopped) return;
  if (Date.now() >= st.stopAt) {
    void stop();
    return;
  }
  st.seq += 1;
  void ping(st.seq);
  if (st.bc.on && !st.bc.unusable) void broadcast(st.seq);
  if (st.seq >= st.maxBeats) void stop();
}

/** タイマーを全部止め、送っている途中の通信を少し待ってから（過ぎたら打ち切って）最後の数えを返す */
async function stop() {
  if (st.stopped) return;
  st.stopped = true;
  st.endedAt = Math.min(Date.now(), st.stopAt);
  for (const t of st.timers) clearInterval(t);
  const items = [...st.inflight];
  const cut = setTimeout(() => {
    for (const it of items) it.ctl.abort();
  }, STOP_WAIT_MS);
  await Promise.allSettled(items.map((it) => it.done));
  clearTimeout(cut);
  self.postMessage({ type: "stopped", ...snapshot() });
}

/** 止めるときに待つ・打ち切れるよう、送っている途中の通信を st.inflight に入れておく fetch（返事の中身も読み切る） */
function fetchTracked(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const it = { ctl, done: null };
  const run = (async () => {
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      await res.arrayBuffer();
      return res;
    } finally {
      clearTimeout(timer);
      st.inflight.delete(it);
    }
  })();
  it.done = run.catch(() => {});
  st.inflight.add(it);
  return run;
}

const reasonOf = (err) => (err && err.name === "AbortError" ? `${FETCH_TIMEOUT_MS / 1000} 秒で返事が無い` : String((err && err.message) || err));
/** 止めるときに打ち切った通信（失敗には数えない） */
const cutByStop = (err) => st.stopped && err && err.name === "AbortError";

/** 生存の知らせの代わり。返事まで届いた時刻（＝送れた時刻）の間隔を数える */
async function ping(seq) {
  const sentAt = Date.now();
  st.ping.sent += 1;
  try {
    const res = await fetchTracked(st.cfg.pingUrl, { cache: "no-store", credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const at = Date.now();
    const p = st.ping;
    p.ok += 1;
    if (p.lastOkAt !== null) {
      const iv = at - p.lastOkAt;
      p.intervals += 1;
      if (iv <= 10000) p.within10 += 1;
      if (iv > 30000) p.over30 += 1;
      if (iv > p.maxInterval) p.maxInterval = iv;
    }
    p.lastOkAt = at;
  } catch (err) {
    if (cutByStop(err)) return;
    st.ping.fail += 1;
    self.postMessage({ type: "ping-fail", at: Date.now(), seq, sentAt, reason: reasonOf(err) });
  }
}

/** Realtime の REST の broadcast で、自分のチャンネルへ { seq } を送る（公開のチャンネル。DB・Storage には書かない）。送った時刻は主のスレッドが bc-sent で記録する */
async function broadcast(seq) {
  self.postMessage({ type: "bc-sent", seq, sentAt: Date.now() });
  try {
    const res = await fetchTracked(`${st.cfg.supabaseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: st.cfg.key, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: st.cfg.topic, event: "probe", payload: { seq }, private: false }] }),
      cache: "no-store",
      credentials: "omit",
    });
    if (res.ok) {
      self.postMessage({ type: "bc-done", seq, doneAt: Date.now(), status: res.status });
      return;
    }
    // 鍵・設定で断られた（公開の broadcast が使えない）ときは、以後は送らない
    const unusable = res.status === 401 || res.status === 403 || res.status === 404;
    if (unusable) st.bc.unusable = true;
    self.postMessage({ type: "bc-fail", seq, at: Date.now(), reason: `HTTP ${res.status}`, unusable });
  } catch (err) {
    if (cutByStop(err)) return;
    self.postMessage({ type: "bc-fail", seq, at: Date.now(), reason: reasonOf(err), unusable: false });
  }
}

function snapshot() {
  const end = endOf(Date.now());
  const p = st.ping;
  // 今まさに続いている空き（最後に送れた時刻から締めの時刻まで。まだ 1 回も送れていなければ測り始めから）も最大に入れる
  const openPing = Math.max(0, end - (p.lastOkAt ?? st.startedAt));
  return {
    at: end,
    stopped: st.stopped,
    tick: { maxGap: Math.max(st.tick.maxGap, end - st.tick.last), over: st.tick.over },
    ping: {
      sent: p.sent,
      ok: p.ok,
      fail: p.fail,
      intervals: p.intervals,
      within10: p.within10,
      over30: p.over30,
      maxInterval: Math.max(p.maxInterval, openPing),
      openGap: openPing,
    },
  };
}

async function checkEncoder() {
  const out = { offscreen: false, videoEncoder: typeof VideoEncoder === "function", supported: false, codec: null, hardware: null, error: null };
  try {
    out.offscreen = typeof OffscreenCanvas === "function" && new OffscreenCanvas(16, 16).getContext("2d") !== null;
  } catch {
    out.offscreen = false;
  }
  if (!out.videoEncoder) return out;
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
    for (const codec of AVC_CODECS) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30, hardwareAcceleration, avc: { format: "avc" } });
        if (r.supported) return { ...out, supported: true, codec, hardware: hardwareAcceleration };
      } catch (err) {
        out.error = String((err && err.message) || err);
      }
    }
  }
  return out;
}
