// マイページの［スマホに保存する］（QR の欄）の、画面に依存しない処理（docs/design-submissions.md 4.9・4.10「スマホで開く」「スマホでの保存の案内」・段 1D）。
// 画面は mypage-share.js、QR を作るのは qr-code.js。試験は scripts/share_lib_test.mjs。
// 日時・大きさ・空き容量の目安は submissions-lib.js（requiredFreeGb・qrShortNote・formatBytes・formatShortDateTime）を使い回し、ここでは作り直さない。
//
// ---- 画面が置いている、サーバー（`submissions` 関数）の返し方（coder A の約束 第 0.6 版 `.orchestration/wt/a/contract.md` 10 章。ここだけを直す）----
// 認証は受講者の口と同じ。クローズ後の限られた利用（設計 4.10）も通る。鍵のログインは 401。
//   POST /share-links（本文なし）→ { url, unused_expires_at, window_ends_at, expires_at, first_opened_at, files, missing, zip_state, zip_bytes }
//     url：保存用のページ（https://studio.a-i-ken-rc.com/dl#k=asl1_…。最後のスラッシュなし）の完全な URL。鍵は断片（#k=）に入っている。この応答でだけ返る。**画面に文字で出さない**（QR と［この端末で開く］だけ）。
//     window_ends_at：全体の保存期限（1 時間の時計の終わりではない）。expires_at：今の時点でこのリンクが使える終わり
//       （開く前は unused_expires_at、開いたあとは「初めて開いた時刻＋1 時間」と window_ends_at の早い方）。画面の「あと何分」は expires_at で数える。
//     first_opened_at：準備ができてから初めて開いた時刻（発行の直後は null）。missing：ZIP に入れられなかった作品の数（整数。0 がふつう）。
//     zip_state：waiting_checksum・building・ready・failed・deleting・deleted の 6 つだけ。zip_bytes：ZIP の大きさ（計画ができるまで null）。
//     断り：409 no_works／429 rate_limited／409 share_period_closed／409 submission_busy／403 not_registered・not_stage_student。
//   GET /share/status → { server_now, can_issue, issue_until, works, link }
//     can_issue：今押せるか。issue_until：押せる期間の終わり（今の cold_due_at）。works：出している作品の数（0 ならボタンを押せない形）。
//     link：今有効な QR だけ（止めた・期限が切れた QR は null）。{ unused_expires_at, window_ends_at, expires_at, first_opened_at, files, missing, zip_state, zip_bytes }。url は返らない。
//   POST /share-links/stop（本文なし）→ 200 { stopped: true | false }（false は有効な QR が無かった。何度呼んでもよい）。
// 欠けている項目は「分からない」として扱い、断定する文を出さない。

import { formatBytes, formatShortDateTime, MSG_NETWORK_PRESS_AGAIN, qrShortNote, submissionsPauseText } from "./submissions-lib.js";

const strOr = (v) => (typeof v === "string" && v ? v : null);
const numOr = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const plainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 保存のページ（/dl）が鍵を一時に置く sessionStorage の名前（このタブの中だけ。dl.js の頭の注記を見る）。マイページは、ログアウト・別のアカウントでのログイン・開いた時点で消す（discardDlKey） */
export const DL_KEY_STORE = "aiken-dl-key";

/** /dl が置いた鍵を、このタブの sessionStorage から消す（storage が無い・使えなくても何もしない） */
export function discardDlKey(storage) {
  try {
    storage?.removeItem(DL_KEY_STORE);
  } catch {
    /* 消せなくても先へ進む */
  }
}

export const SHARE_PATHS = { issue: "/share-links", status: "/share/status", stop: "/share-links/stop" };

/** 保存の鍵の形（設計 4.9：asl1_ ＋ 43 文字） */
export const SHARE_KEY_RE = /^asl1_[A-Za-z0-9_-]{43}$/;

export const SHARE_OPEN_LABEL = "スマホに保存する";
// 確認の窓：題は「〇〇しますか？」、本文は結果だけ（組 13 の文言の表・決まり 1）
export const SHARE_ISSUE_TITLE = "QR を発行しますか？";
export const SHARE_ISSUE_CONFIRM = "前の QR は使えなくなります。";
export const SHARE_STOP_TITLE = "QR を停止しますか？";
export const SHARE_STOP_CONFIRM = "この QR では保存できなくなります。";
/** 提出した動画が無いときの 1 行（空の状態。回の終了の画面にも出るので「まだ」を付けない・句点なし。文言の決まり 2.2.1） */
export const SHARE_NO_WORKS = "提出した動画はありません";
/** no_works の断り（トースト）：空の状態の 1 行とは分け、同じ関数のほかの断りと前置き・句点をそろえる */
export const MSG_SHARE_NO_WORKS_ERROR = "保存エラー：提出した動画はありません。";
/** 1 時間の時計の始まり（設計 D29）。続きはホバー（SHARE_CLOCK_TIP） */
export const SHARE_CLOCK_NOTE = "準備ができてから開くと、1 時間保存できます。";
export const SHARE_CLOCK_TIP = "準備中に開いても、1 時間は数え始めません。";
export const SHARE_THIS_DEVICE = "この端末で開く";
export const SHARE_HERE_LABEL = "この端末で保存する";
export const SHARE_HERE_TITLE = "保存のページを開きますか？";
export const SHARE_HERE_CONFIRM = "前の QR は使えなくなります。";
export const SHARE_STOP_LABEL = "QR を停止";
export const SHARE_CLOSE_LABEL = "閉じる";
export const SHARE_QR_ALT = "スマホで読むための QR コード";
export const SHARE_READY_LINE = "準備ができました。QR を読み取ってください。";
/** QR が画面に出ていないとき（開き直したあと・［閉じる］のあと・終了の画面）：読む QR が無いので、読み取りの指示は出さない（Codex F244-03） */
export const SHARE_READY_NO_QR_LINE = "保存の準備ができています。\nQR は［スマホに保存する］で再発行できます。";
export const SHARE_FAILED_LINE = "保存エラー：ZIP を作成できません。\nQR を再発行してください。";
export const SHARE_GONE_LINE = "この QR は使えません。\nQR を再発行してください。";
export const MSG_SHARE_STOPPED = "QR を停止しました。";
export const MSG_SHARE_NOTHING_TO_STOP = "停止する QR はありません。";
export const MSG_SHARE_FAILED_LOAD = "読み込みエラー：保存の状態を取得できません。";
/** 通信の失敗（［発行する］・［停止する］など押した操作だけで出す。組 13 の U-10 の T-05） */
export const MSG_SHARE_NETWORK = MSG_NETWORK_PRESS_AGAIN;
/** 発行のあとで QR を作れなかった（応答の形が違う）。原因が分からない形（E-WRK-99） */
export const MSG_SHARE_BAD_REPLY = "保存エラーが発生しました。\nしばらくしてから再度お試しください。";
export const MSG_SHARE_PREPARING_LONG = "準備に時間がかかっています。\nしばらくしてから再読み込みしてください。";
export const SHARE_DETAILS_SUMMARY = "保存したあとの開き方";

/**
 * 保存の案内（設計 4.9「スマホでの保存の案内」。端末の種類で出し分けず、全部を出す。Android は確かめずに進める〔田口さんの決定 10-24〕ので一般的な手順として書き、機種の違いには触れない）。
 * @returns {{ short: string[], open: string[] }} short：QR の下に常に出す 2 行（Wi-Fi・空き容量。ZIP の大きさが分かる前は Wi-Fi だけ）。open：保存したあとの開き方（iPhone・Android・開けないとき）
 */
export function saveGuide(zipBytes) {
  return {
    short: qrShortNote(zipBytes),
    open: [
      "iPhone：「ファイル」アプリの「ダウンロード」にある ZIP をタップします。",
      "Android：「Files by Google」などで ZIP を開き、［展開］を押します。",
      "開けないときは、保存のページで動画ごとの［保存］を押してください。",
    ],
  };
}

const PREPARING = new Set(["waiting_checksum", "building"]);
const UNUSABLE = new Set(["failed", "deleting", "deleted"]);

/** ZIP の状態の分類：ready／preparing／failed（使えない）。知らない値は準備中として扱う（待てば変わる側） */
export function zipPhase(state) {
  const s = typeof state === "string" ? state : "";
  if (s === "ready") return "ready";
  if (UNUSABLE.has(s)) return "failed";
  if (PREPARING.has(s)) return "preparing";
  return "preparing";
}

/** 準備の見込み（分）。本番の段 0：400 MB で 43 秒・1.9 GB で 206 秒・2.1 GB で 234 秒（約 9 MB/秒）。1〜5 分に収める。大きさが分からなければ null */
export function zipPrepMinutes(zipBytes) {
  const n = numOr(zipBytes);
  if (n === null || n <= 0) return null;
  return Math.min(5, Math.max(1, Math.ceil(n / 9_000_000 / 60)));
}

/** ZIP の状態の 1 行（準備中：「準備中（約 2 分）」・大きさが分からなければ「準備中…」／準備できた：QR が出ていれば「準備ができました。QR を読み取ってください。」、出ていなければ読み取りを求めない文） */
export function zipStateLine(state, zipBytes, hasQr = true) {
  const phase = zipPhase(state);
  if (phase === "ready") return hasQr ? SHARE_READY_LINE : SHARE_READY_NO_QR_LINE;
  if (phase === "failed") return SHARE_FAILED_LINE;
  const m = zipPrepMinutes(zipBytes);
  // 状態の札：後ろに数が続くときは「…」を付けない（文言の決まり 2.2.1）
  return m === null ? "準備中…" : `準備中（約 ${m} 分）`;
}

/** 入れられなかった作品の数（整数。無い・負・数でないときは 0） */
function missingCount(v) {
  const n = numOr(v);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

/** link の共通の項目の読み取り（発行の応答と状態の応答で同じ） */
function readLink(raw) {
  return {
    unusedExpiresAt: strOr(raw.unused_expires_at),
    windowEndsAt: strOr(raw.window_ends_at),
    expiresAt: strOr(raw.expires_at),
    firstOpenedAt: strOr(raw.first_opened_at),
    zipState: strOr(raw.zip_state),
    zipBytes: numOr(raw.zip_bytes),
    files: numOr(raw.files),
    missing: missingCount(raw.missing),
  };
}

/** 保存のページの URL を確かめる：https で、断片が #k=asl1_… の形のものだけ（それ以外は QR にしない） */
export function validShareUrl(url) {
  if (typeof url !== "string" || url.length > 300) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (!u.hash.startsWith("#k=")) return false;
  return SHARE_KEY_RE.test(u.hash.slice(3)) && u.search === "";
}

/** POST /share-links の応答 → 画面の値（形が違えば null） */
export function normalizeShareIssue(raw) {
  if (!plainObj(raw) || !validShareUrl(raw.url)) return null;
  return { url: raw.url, ...readLink(raw) };
}

/** GET /share/status の応答 → { works, canIssue, issueUntil, link }（形が違えば null。link は無ければ null。canIssue は true・false・分からない null） */
export function normalizeShareStatus(raw) {
  if (!plainObj(raw)) return null;
  const works = numOr(raw.works);
  const link = plainObj(raw.link) ? readLink(raw.link) : null;
  return {
    works: works === null ? null : Math.max(0, Math.floor(works)),
    canIssue: typeof raw.can_issue === "boolean" ? raw.can_issue : null,
    issueUntil: strOr(raw.issue_until),
    link,
  };
}

/** 残りの分（切り上げ。過ぎていたら 0。分からなければ null） */
export function minutesLeft(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 60000));
}

/** QR の状態の文。「あと何分」は expires_at（今の時点で使える終わり）で数える。分からない項目は書かない */
export function linkStateLines(link, nowMs = Date.now()) {
  const lines = [];
  const end = link.expiresAt ?? (link.firstOpenedAt ? null : link.unusedExpiresAt);
  const left = minutesLeft(end, nowMs);
  if (link.firstOpenedAt) {
    lines.push(`${formatShortDateTime(link.firstOpenedAt)} に開かれました。`);
    if (end) lines.push(`${formatShortDateTime(end)} まで保存できます${left === null ? "" : `（あと ${left} 分）`}。`);
  } else if (end) {
    lines.push(`${formatShortDateTime(end)} までに開いてください${left === null ? "" : `（あと ${left} 分）`}。`);
  }
  // 全体の保存期限が、今の使える終わりより先にあるときだけ書く（同じ時刻なら重ねない）
  if (link.windowEndsAt && end && formatShortDateTime(link.windowEndsAt) !== formatShortDateTime(end)) lines.push(`${formatShortDateTime(link.windowEndsAt)} 以降は保存できません。`);
  return lines;
}

/** ZIP に入れられなかった作品があるときの文（黙って抜かない。設計 4.9） */
export function missingLine(link) {
  if (!link || link.missing <= 0) return null;
  return `${link.missing} 本の動画が ZIP に入っていません。`;
}

/** 作品の数と大きさの 1 行（「3 本・1.2 GB」。分からない項目は出さない） */
export function linkSizeLine(link) {
  const parts = [];
  if (link.files !== null && link.files > 0) parts.push(`${link.files} 本`);
  if (link.zipBytes !== null && link.zipBytes > 0) parts.push(formatBytes(link.zipBytes));
  return parts.length ? parts.join("・") : null;
}

export const SHARE_PERIOD_NOT_YET = "最後のワークショップの開始後に保存できます。";
export const SHARE_PERIOD_OVER = "保存期間は終了しました。";

/** 保存できる最後の日の「12/4」（issue_until は今の cold_due_at＝その日の次の 0:00。日本時間で 1 ミリ秒前の日付。分からなければ null） */
export function closedUntilLabel(issueUntil) {
  const t = issueUntil ? new Date(issueUntil).getTime() : NaN;
  if (Number.isNaN(t)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).formatToParts(new Date(t - 1)).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day}`;
}

/** 回が終わったあとのマイページの文（設計 4.10）：「この回は終了しました。／提出した動画は 12/4 まで保存できます。」 */
export function closedNote(issueUntil) {
  const day = closedUntilLabel(issueUntil);
  return day ? `この回は終了しました。\n提出した動画は ${day} まで保存できます。` : "この回は終了しました。\n提出した動画を保存できます。";
}

/** 押せない期間の文（can_issue が false のとき。issue_until を過ぎていれば「終わりました」、まだなら「始まってから」） */
export function sharePeriodLine(issueUntil, nowMs = Date.now()) {
  const t = issueUntil ? new Date(issueUntil).getTime() : NaN;
  return !Number.isNaN(t) && t <= nowMs ? SHARE_PERIOD_OVER : SHARE_PERIOD_NOT_YET;
}

/** コードを付ける断り（error-codes.md：E-LOG-51・E-SUB-50・E-LOG-52・E-WRK-99） */
export const MSG_SHARE_NOT_REGISTERED = "利用登録が確認できません。\n講師・スタッフにお知らせください。";
export const MSG_SHARE_NOT_STAGE_STUDENT = "保存エラー：受講者として未登録です。\n講師・スタッフにお知らせください。";
export const MSG_SHARE_FORBIDDEN = "権限エラー：この操作はできません。\n講師・スタッフにお知らせください。";
export const MSG_SHARE_FAILED = "保存エラーが発生しました。\nしばらくしてから再度お試しください。";
/** スマホに保存の断りのコード（文 → コード。コードは文と別の値で持つ。決まり 3.2） */
const SHARE_ERROR_CODES = new Map([
  [MSG_SHARE_NOT_REGISTERED, "E-LOG-51"],
  [MSG_SHARE_NOT_STAGE_STUDENT, "E-SUB-50"],
  [MSG_SHARE_FORBIDDEN, "E-LOG-52"],
  [MSG_SHARE_FAILED, "E-WRK-99"],
  [MSG_SHARE_BAD_REPLY, "E-WRK-99"],
]);
/** shareErrorText・MSG_SHARE_BAD_REPLY の文に付けるコード（無ければ null） */
export function shareErrorCode(text) {
  return SHARE_ERROR_CODES.get(text) ?? null;
}

/** 失敗の文（サーバーの拒否の名前 → 文。A の約束 10 章）。設計 4.9 の回数の上限（1 時間 5 回・1 日 20 回）・作品が 0 件のとき */
export function shareErrorText(code, status) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  const c = typeof code === "string" ? code : "";
  if (c === "no_works") return MSG_SHARE_NO_WORKS_ERROR;
  if (c === "rate_limited" || status === 429) return "QR の発行の上限に達しました。\nしばらくしてから再度お試しください。";
  if (c === "submission_busy") return "保存エラー：回の設定が変わりました。\n再度お試しください。";
  // 名簿に無い（停止中の人も同じ名前で来る）と、その回の受講者でないは原因が違うので分ける（コードも別）
  if (c === "not_registered") return MSG_SHARE_NOT_REGISTERED;
  if (c === "not_stage_student") return MSG_SHARE_NOT_STAGE_STUDENT;
  if (c === "share_period_closed") return "保存エラー：保存期間外です。";
  if (status === 0) return MSG_SHARE_NETWORK;
  if (status === 401) return "ログインの有効期限が切れました。\n再度ログインしてください。";
  if (status === 403) return MSG_SHARE_FORBIDDEN;
  if (status === 503) return "混雑しています。\nしばらくしてから再度お試しください。";
  return MSG_SHARE_FAILED;
}

/** 受講者に見える文の一覧（試験で D12 の言葉を使っていないことを確かめる） */
export function shareFacingTexts() {
  const g = saveGuide(1_200_000_000);
  const now = Date.parse("2026-11-27T08:00:00Z");
  return [
    SHARE_OPEN_LABEL, SHARE_ISSUE_TITLE, SHARE_ISSUE_CONFIRM, SHARE_STOP_TITLE, SHARE_STOP_CONFIRM, SHARE_NO_WORKS, SHARE_CLOCK_NOTE, SHARE_CLOCK_TIP, SHARE_THIS_DEVICE, SHARE_STOP_LABEL,
    SHARE_HERE_LABEL, SHARE_HERE_TITLE, SHARE_HERE_CONFIRM, closedNote("2026-12-05T15:00:00Z"), closedNote(null),
    SHARE_CLOSE_LABEL, SHARE_QR_ALT, SHARE_READY_LINE, SHARE_READY_NO_QR_LINE, SHARE_FAILED_LINE, SHARE_GONE_LINE, MSG_SHARE_STOPPED, MSG_SHARE_NOTHING_TO_STOP, MSG_SHARE_FAILED_LOAD, MSG_SHARE_NETWORK, MSG_SHARE_BAD_REPLY,
    MSG_SHARE_PREPARING_LONG, SHARE_DETAILS_SUMMARY, SHARE_PERIOD_NOT_YET, SHARE_PERIOD_OVER, ...g.short, ...g.open,
    zipStateLine("building", 1_200_000_000), zipStateLine("building", null),
    ...["submissions_paused", "submissions_read_paused", "no_works", "rate_limited", "submission_busy", "not_registered", "not_stage_student", "share_period_closed", "x"].map((c) => shareErrorText(c, 400)),
    shareErrorText("x", 0), shareErrorText("x", 401), shareErrorText("x", 403), shareErrorText("x", 429), shareErrorText("x", 503),
    ...linkStateLines({ firstOpenedAt: "2026-11-27T08:00:00Z", unusedExpiresAt: null, windowEndsAt: "2026-11-27T10:00:00Z", expiresAt: "2026-11-27T09:00:00Z" }, now),
    ...linkStateLines({ firstOpenedAt: null, unusedExpiresAt: "2026-11-28T08:00:00Z", windowEndsAt: null, expiresAt: "2026-11-28T08:00:00Z" }, now),
    missingLine({ missing: 2 }),
  ];
}
