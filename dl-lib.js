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
import { DL_KEY_STORE, minutesLeft, SHARE_KEY_RE, SHARE_PERIOD_OVER, saveGuide, zipPhase, zipPrepMinutes } from "./share-lib.js";

// 鍵の置き場の名前は share-lib.js（マイページが消すときにも使う）にある。dl.js はここから読む
export { DL_KEY_STORE };

const strOr = (v) => (typeof v === "string" && v ? v : null);
const numOr = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const plainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const DL_PATHS = { open: "/dl/open", url: "/dl/url" };
/** 画面の読み直しの間隔と回数（準備中だけ。10 秒ごと・最大 90 回＝15 分。この問い合わせは仕事を進めない） */
export const DL_POLL_MS = 10_000;
export const DL_POLL_MAX = 90;

// 文は組 13 の文言の表（DL-*）。断りは「1 行目＋改行＋次の手」（画面は white-space: pre-line。dl.css）
export const DL_TITLE = "動画を保存する";
export const DL_RETRY_LABEL = "再読み込み";
export const MSG_DL_RESCAN = "同じ QR を再度読み取っても開けます。";
export const MSG_DL_EXPIRED = "リンクの有効期限が切れました。\nマイページで QR を再発行してください。";
/** リンクの期限が保存期間の終わりで切れた（expires_at が window_ends_at と同じ）。期間のあとは再発行できないので次の手は書かない（DL-06-2。マイページの SH-36 と同じ文） */
export const MSG_DL_PERIOD_OVER = SHARE_PERIOD_OVER;
export const DL_UNAVAILABLE = "このリンクは使えません。\nマイページで QR を再発行してください。";
export const DL_PREPARING_WAIT = "このページを開いたままお待ちください。";
export const DL_READY = "準備ができました。";
export const DL_SAVE_ZIP = "ZIP を保存";
export const DL_SAVE_ONE = "保存";
export const DL_FILES_HEADING = "動画ごとに保存";
export const MSG_DL_NETWORK = "通信エラー：接続できませんでした。\nインターネット接続を確認してください。";
export const MSG_DL_BUSY = "混雑しています。\nしばらくしてから再度お試しください。";
export const MSG_DL_LIMIT = "保存の回数の上限に達しました。\nマイページで QR を再発行してください。";
export const MSG_DL_NOT_READY = "まだ準備中です。しばらくお待ちください。";
export const MSG_DL_FAILED = "保存エラーが発生しました。\nしばらくしてから再度お試しください。";
export const MSG_DL_STARTED = "保存を開始しました。\nダウンロードが始まらないときは、再度お試しください。";
export const MSG_DL_PREPARING_LONG = "準備に時間がかかっています。\nしばらくしてから再読み込みしてください。";
export const MSG_DL_LOAD_FAILED = "読み込みエラー：保存の状態を取得できません。";

/** コードを付ける断り（error-codes.md：E-WRK-99）。コードは文の定数に入れず、文 → コードの表で持つ（決まり 3.2） */
const DL_ERROR_CODES = new Map([[MSG_DL_FAILED, "E-WRK-99"]]);
/** 保存のページの断りの文に付けるコード（無ければ null） */
export function dlErrorCode(text) {
  return DL_ERROR_CODES.get(text) ?? null;
}

/** URL の断片（"#k=asl1_…"）から鍵を取り出す。形が違えば null（鍵は ^asl1_[A-Za-z0-9_-]{43}$） */
export function keyFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#k=")) return null;
  const key = hash.slice(3);
  return SHARE_KEY_RE.test(key) ? key : null;
}

/**
 * 保存の案内（設計 4.9：端末の種類で出し分けず、全部を出す）。マイページの短い案内（Wi-Fi・空き容量）と同じ文＋開き方。
 * 最後の 1 行だけ、このページの「下の動画ごとの［保存］」の言い方にする。
 */
export function dlGuide(zipBytes) {
  const g = saveGuide(zipBytes);
  return [...g.short, g.open[0], g.open[1], "開けないときは、下の動画ごとの［保存］を押してください。"];
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
    windowEndsAt: strOr(raw.window_ends_at),
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

/** 準備中の文：「準備中（約 2 分）」（大きさが分からなければ「準備中…」。マイページの zipStateLine と同じ） */
export function dlPreparingLine(zipBytes) {
  const m = zipPrepMinutes(zipBytes);
  return m === null ? "準備中…" : `準備中（約 ${m} 分）`;
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
 * 期限が切れたときの文。リンクの期限が保存期間の終わり（window_ends_at）と同じなら「保存期間は終了しました。」（再発行できない）、
 * それ以外は「リンクの有効期限が切れました。」と再発行の案内。window_ends_at が無い・読めないときは後者
 */
export function dlExpiredText(open) {
  const end = open?.expiresAt ? new Date(open.expiresAt).getTime() : NaN;
  const windowEnd = open?.windowEndsAt ? new Date(open.windowEndsAt).getTime() : NaN;
  return !Number.isNaN(end) && end === windowEnd ? MSG_DL_PERIOD_OVER : MSG_DL_EXPIRED;
}

/**
 * 使える残りの文：「有効期限：11/27 17:30（あと 42 分）」。0 分になったら終わりの文（dlExpiredText）。expires_at が無ければ null。
 * nowMs はサーバーの今。**nowMs が null（サーバーの時計が分からない）のときは、「あと ○ 分」を言わず、絶対の期限だけ**：「有効期限：11/27 17:30」
 */
export function dlRemainingLine(open, nowMs = Date.now()) {
  if (!open.expiresAt || Number.isNaN(new Date(open.expiresAt).getTime())) return null;
  if (nowMs === null) return `有効期限：${formatShortDateTime(open.expiresAt)}`;
  const left = minutesLeft(open.expiresAt, nowMs);
  if (left === null) return null;
  if (left === 0) return dlExpiredText(open);
  return `有効期限：${formatShortDateTime(open.expiresAt)}（あと ${left} 分）`;
}

/** 作品ごとの行の 1 行（「WS02-佐藤.mp4（24 MB）」） */
export function dlFileLabel(file) {
  return file.bytes !== null && file.bytes > 0 ? `${file.name}（${formatBytes(file.bytes)}）` : file.name;
}

/** ZIP に入れられなかった動画の文（黙って抜かない。一覧にも出ず 1 本ずつの保存もできないので、次の手は書かない。マイページの missingLine と同じ形） */
export function dlMissingLine(open) {
  return open.missing > 0 ? `${open.missing} 本の動画が ZIP に入っていません。` : null;
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
    DL_TITLE, DL_RETRY_LABEL, MSG_DL_RESCAN, MSG_DL_EXPIRED, MSG_DL_PERIOD_OVER, DL_UNAVAILABLE, DL_PREPARING_WAIT, DL_READY, DL_SAVE_ZIP, DL_SAVE_ONE, DL_FILES_HEADING, MSG_DL_NETWORK, MSG_DL_BUSY, MSG_DL_LIMIT, MSG_DL_FAILED,
    MSG_DL_STARTED, MSG_DL_NOT_READY, MSG_DL_PREPARING_LONG, MSG_DL_LOAD_FAILED, ...dlGuide(1_200_000_000), dlPreparingLine(1_200_000_000), dlPreparingLine(null),
    dlSizeLine(open), dlRemainingLine(open, Date.parse("2026-11-27T08:00:00Z")), dlFileLabel(open.files[0]), dlMissingLine(open),
    dlUrlErrorText(0), dlUrlErrorText(429, "url_limit"), dlUrlErrorText(429), dlUrlErrorText(409, "zip_not_ready"), dlUrlErrorText(503), dlUrlErrorText(500),
  ];
}
