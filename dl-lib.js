// 保存のページ（/dl/。docs/design-submissions.md 4.9「スマホで開く」「スマホでの保存の案内」・段 1D）の、画面に依存しない処理。
// 画面は dl.js、HTML は dl.html。試験は scripts/dl_lib_test.mjs・scripts/dl_page_nodetest.mjs。
// 文・日時・大きさ・空き容量は share-lib.js・submissions-lib.js を使い回し、ここでは作り直さない。
//
// ---- 画面が置いている、サーバー（`submissions` 関数の認証なしの口）の返し方（coder A の約束 第 0.6 版 `.orchestration/wt/a/contract.md` 10 章。ここだけを直す）----
//   POST /dl/open { key } → 200 { zip_state, zip_bytes, files: [{ work_id, name, bytes }], first_opened_at, expires_at, missing, unused_expires_at, window_ends_at, server_now }
//     key：URL の断片（#k=）から取った鍵。zip_state は share-lib.js と同じ 6 つ。準備中（waiting_checksum・building）に開いても時計は始まらず、files は []（D29）。
//     ready で初めて開いた時刻が付く。expires_at：このリンクが今使える終わり。missing：ZIP に入れられなかった作品の数（整数）。この問い合わせは仕事を進めない。
//   POST /dl/url { key, file? } → 200 { url, expires_at, name, bytes }
//     file（work_id）が無ければ ZIP、あればその作品。url は download=<名前> つきの署名つき URL（期限は 10 分と残りの短い方。残り 30 秒未満は出さない）。
//     断り：404 link_unusable（使えない理由は全部これ。区別しない）／429 url_limit（1 本のリンクで 30 回まで。31 回目）／409 zip_not_ready（準備中。開く側は /dl/open を読み直す）。
//   発行される URL は https://studio.a-i-ken-rc.com/dl#k=asl1_…（最後のスラッシュなし）。
// 欠けている項目は「分からない」として扱い、断定する文を出さない。

import { formatBytes, formatShortDateTime, submissionsPauseText } from "./submissions-lib.js";
import { DL_KEY_STORE, minutesLeft, SHARE_KEY_RE, saveGuide, zipPhase, zipPrepMinutes } from "./share-lib.js";

// 鍵の置き場の名前は share-lib.js（マイページが消すときにも使う）にある。dl.js はここから読む
export { DL_KEY_STORE };

const strOr = (v) => (typeof v === "string" && v ? v : null);
const numOr = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const plainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const DL_PATHS = { open: "/dl/open", url: "/dl/url" };
/** 画面の読み直しの間隔と回数（準備中だけ。10 秒ごと・最大 90 回＝15 分。この問い合わせは仕事を進めない） */
export const DL_POLL_MS = 10_000;
export const DL_POLL_MAX = 90;

export const DL_TITLE = "作品を保存する";
export const DL_RETRY_LABEL = "もう一度読み込む";
export const MSG_DL_RESCAN = "同じ QR をもう一度読み取っても開けます。開けないときは、マイページで QR を出し直してください。";
export const MSG_DL_EXPIRED = "このリンクの使える時間が終わりました。マイページで、もう一度 QR を出してください。";
export const DL_UNAVAILABLE = "このリンクは使えません。マイページで、もう一度 QR を出してください。";
export const DL_PREPARING_WAIT = "このページを開いたまま待つか、あとでもう一度開いてください。";
export const DL_READY = "準備ができました。";
export const DL_SAVE_ZIP = "ZIP を保存";
export const DL_SAVE_ONE = "保存";
export const DL_FILES_HEADING = "作品ごとに保存";
export const MSG_DL_NETWORK = "通信できませんでした。通信状態を確かめて、もう一度押してください。";
export const MSG_DL_BUSY = "保存の準備が混み合っています。少し待ってから、もう一度押してください。";
export const MSG_DL_LIMIT = "保存の URL を出せる回数の上限に達しました。しばらくしてからマイページで QR を出し直してください。";
export const MSG_DL_NOT_READY = "まだ準備ができていません。準備ができたら、もう一度押してください。";
export const MSG_DL_FAILED = "保存の準備ができませんでした。もう一度押してください。";
export const MSG_DL_STARTED = "保存を始めました。ダウンロードが始まらないときは、もう一度押してください。";
export const MSG_DL_PREPARING_LONG = "準備に時間がかかっています。しばらくしてから、このページを開き直してください。";
export const MSG_DL_LOAD_FAILED = "保存の状態を読み込めませんでした。通信状態を確かめて、このページを開き直してください。";

/** URL の断片（"#k=asl1_…"）から鍵を取り出す。形が違えば null（鍵は ^asl1_[A-Za-z0-9_-]{43}$） */
export function keyFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#k=")) return null;
  const key = hash.slice(3);
  return SHARE_KEY_RE.test(key) ? key : null;
}

/**
 * 保存の案内（設計 4.9：端末の種類で出し分けず、全部を出す）。マイページの短い案内（Wi-Fi・空き容量）と同じ文＋開き方。
 * 最後の 1 行だけ、このページの「下の作品ごとの［保存］」の言い方にする。
 */
export function dlGuide(zipBytes) {
  const g = saveGuide(zipBytes);
  return [...g.short, g.open[0], g.open[1], "開けないときは、下の作品ごとの［保存］を使ってください。"];
}

/** POST /dl/open の応答 → 画面の値（形が違えば null） */
export function normalizeDlOpen(raw) {
  if (!plainObj(raw)) return null;
  const files = [];
  if (Array.isArray(raw.files)) {
    for (const f of raw.files) {
      if (!plainObj(f)) continue;
      const id = strOr(f.work_id);
      const name = strOr(f.name);
      if (id && name) files.push({ workId: id, name, bytes: numOr(f.bytes) });
    }
  }
  const missing = numOr(raw.missing);
  return {
    zipState: strOr(raw.zip_state),
    zipBytes: numOr(raw.zip_bytes),
    files,
    firstOpenedAt: strOr(raw.first_opened_at),
    expiresAt: strOr(raw.expires_at),
    serverNow: strOr(raw.server_now),
    missing: missing !== null && missing > 0 ? Math.floor(missing) : 0,
  };
}

/** POST /dl/url の応答 → 署名つき URL（https の URL だけ。違えば null） */
export function downloadUrlOf(raw) {
  if (!plainObj(raw) || typeof raw.url !== "string" || raw.url.length > 4000) return null;
  try {
    const u = new URL(raw.url);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** 準備中の文：「準備しています（約 2 分）。」（大きさが分からなければ約 ○ 分を付けない） */
export function dlPreparingLine(zipBytes) {
  const m = zipPrepMinutes(zipBytes);
  return m === null ? "準備しています。" : `準備しています（約 ${m} 分）。`;
}

/** ZIP の大きさの 1 行（「ZIP の大きさ：1.2 GB・3 本」。分からない項目は出さない） */
export function dlSizeLine(open) {
  const parts = [];
  if (open.zipBytes !== null && open.zipBytes > 0) parts.push(formatBytes(open.zipBytes));
  if (open.files.length) parts.push(`${open.files.length} 本`);
  return parts.length ? `ZIP の大きさ：${parts.join("・")}` : null;
}

/**
 * 端末の時計とサーバーの時計の差（ミリ秒）。/dl/open の server_now と、その応答を受けた時点の端末の時刻から数える。
 * 「あと何分」・期限切れの判定は、端末の時計がずれていても正しいように、端末の今 ＋ この差（＝サーバーの今）で行う（A の約束 1 章）。
 * **server_now が無い・壊れているときは null**（端末の時計だけでは、あと何分も期限切れも決めない。終わるのはサーバーが 404 にしたとき）
 */
export function serverOffsetMs(open, clientNowMs) {
  const t = open?.serverNow ? new Date(open.serverNow).getTime() : NaN;
  return Number.isNaN(t) ? null : t - clientNowMs;
}

/**
 * 使える残りの文：「このリンクは、あと 42 分（11/27 17:30）まで使えます。」。0 分になったら終わりの文。expires_at が無ければ null。
 * nowMs はサーバーの今。**nowMs が null（サーバーの時計が分からない）のときは、「あと ○ 分」を言わず、絶対の期限だけ**：「このリンクは、11/27 17:30 まで使えます。」
 */
export function dlRemainingLine(open, nowMs = Date.now()) {
  if (!open.expiresAt || Number.isNaN(new Date(open.expiresAt).getTime())) return null;
  if (nowMs === null) return `このリンクは、${formatShortDateTime(open.expiresAt)} まで使えます。`;
  const left = minutesLeft(open.expiresAt, nowMs);
  if (left === null) return null;
  if (left === 0) return MSG_DL_EXPIRED;
  return `このリンクは、あと ${left} 分（${formatShortDateTime(open.expiresAt)}）まで使えます。`;
}

/** 作品ごとの行の 1 行（「WS02-佐藤.mp4（24 MB）」） */
export function dlFileLabel(file) {
  return file.bytes !== null && file.bytes > 0 ? `${file.name}（${formatBytes(file.bytes)}）` : file.name;
}

/** ZIP に入れられなかった作品の文（黙って抜かない） */
export function dlMissingLine(open) {
  return open.missing > 0 ? `${open.missing} 本の作品は ZIP に入れられませんでした。` : null;
}

/** ページの状態：unavailable（使えない）／preparing（準備中）／ready（保存できる）／failed（ZIP が作れなかった・消えた＝使えない扱い） */
export function dlPhase(open) {
  const p = zipPhase(open.zipState);
  return p === "failed" ? "unavailable" : p;
}

/** 失敗の文（/dl/url）。429 url_limit は上限・ほかの 429 と 503 は混雑・0 は通信。404 link_unusable は「使えない」の画面（ここでは文にしない）・409 zip_not_ready は準備中の表示に戻す */
export function dlUrlErrorText(status, code) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  if (status === 0) return MSG_DL_NETWORK;
  if (status === 409 && code === "zip_not_ready") return MSG_DL_NOT_READY;
  if (status === 429) return code === "url_limit" ? MSG_DL_LIMIT : MSG_DL_BUSY;
  if (status === 503) return MSG_DL_BUSY;
  return MSG_DL_FAILED;
}

/** /dl/open の失敗。停止の理由だけを分け、ほかの読み込み失敗の扱いは変えない。 */
export function dlLoadErrorText(code) {
  return submissionsPauseText(code) ?? MSG_DL_LOAD_FAILED;
}

/** 受講者に見える文の一覧（試験で D12 の言葉を使っていないことを確かめる） */
export function dlFacingTexts() {
  const open = { zipBytes: 1_200_000_000, files: [{ workId: "w", name: "WS02-佐藤.mp4", bytes: 24_000_000 }], expiresAt: "2026-11-27T09:00:00Z", missing: 2 };
  return [
    DL_TITLE, DL_RETRY_LABEL, MSG_DL_RESCAN, MSG_DL_EXPIRED, DL_UNAVAILABLE, DL_PREPARING_WAIT, DL_READY, DL_SAVE_ZIP, DL_SAVE_ONE, DL_FILES_HEADING, MSG_DL_NETWORK, MSG_DL_BUSY, MSG_DL_LIMIT, MSG_DL_FAILED,
    MSG_DL_STARTED, MSG_DL_NOT_READY, MSG_DL_PREPARING_LONG, MSG_DL_LOAD_FAILED, ...dlGuide(1_200_000_000), dlPreparingLine(1_200_000_000), dlPreparingLine(null),
    dlSizeLine(open), dlRemainingLine(open, Date.parse("2026-11-27T08:00:00Z")), dlFileLabel(open.files[0]), dlMissingLine(open),
    dlUrlErrorText(0), dlUrlErrorText(429, "url_limit"), dlUrlErrorText(429), dlUrlErrorText(409, "zip_not_ready"), dlUrlErrorText(503), dlUrlErrorText(500),
  ];
}
