// マイページから手元の動画を直接提出する（組 11 の (8)。設計 kumi11-mypage-upload.md）の、画面に依存しない部品。
// 画面（ダイアログ・<video> での確かめ）は mypage-upload.js。試験は scripts/upload_lib_test.mjs。
//   - ファイルの確かめ（段 1〜4。設計 2.4）：checkFileName・checkSize・checkHead・judgeProbe
//   - 送る値：metaFields・labelOf・buildUploadBody
//   - 段 2「公開の範囲を選んでください」：scopeStepReducer・scopeStepView（Canvas の submit/scopeStep.ts と同じ規則）
//   - 提出先：stageOptions・acceptText・stillAccepting（Canvas の submit/messages.ts と同じ規則。upcoming は「まだ始まっていません」）
//   - 断りの文と動き：uploadErrorText・errorAction・failedFrom
//   - 流れ（begin → TUS → complete・［やめる］・［もう一度送る］）：createUploadFlow（Canvas の submit/flow.ts の決まりを写した物）
// Canvas の tus.ts・flow.ts・scopeStep.ts・messages.ts を直すときは、この写しも同じ commit で直す（設計 2.8）。
// 締切・上限・権限はサーバーが決める。画面は、サーバーが返した受け付けの状態と、断りの名前（code）を文にするだけ。
import { TusError, tusDelete, tusUpload } from "./tus-lib.js";
import { FORBIDDEN_FOR_STUDENTS, formatBytes, formatShortDateTime } from "./submissions-lib.js";

/** 出せる大きさの上限（バイト。関数の印 upload.max_bytes が無いときの値。230 の file_bytes と同じ） */
export const UPLOAD_MAX_BYTES = 300_000_000;
/** ファイルを選ぶ欄の accept（MP4 と MOV） */
export const UPLOAD_ACCEPT = ".mp4,.mov,video/mp4,video/quicktime";
/** 段 4a（loadedmetadata）と段 4b（最初の 1 コマ）の待ち（ミリ秒。設計 2.4） */
export const PROBE_META_TIMEOUT_MS = 20_000;
export const PROBE_FRAME_TIMEOUT_MS = 10_000;

/** 画面の文（設計 2.4・2.7・4.2。Canvas の submit/messages.ts と同じ言葉にそろえる） */
export const TEXT = {
  open: "動画を提出する",
  title: "動画を提出",
  bridgeIntro1: "ブリッジワークは、各自が自主的に取り組む制作です。",
  bridgeIntro2: "出すかどうかも自由です。",
  file: "ファイル",
  stage: "提出先",
  fieldTitle: "タイトル",
  fieldPurpose: "何のため、誰に向けた動画ですか",
  scopeStepTitle: "公開の範囲を選んでください",
  scopeLecture: "講義内に限り公開（この回の受講者と講師だけ）",
  scopePrivate: "完全非公開（講師は見ます。講義では映しません）",
  scopePublic: "公開（A.I.KEN が社外で使ってよい）",
  scopePublicNote: "事例紹介・Web サイト・SNS・営業資料に使います。",
  consentCheck: "同意します",
  next: "次へ",
  back: "戻る",
  cancel: "やめる",
  submitWorkshop: "提出する",
  submitBridge: "出す",
  retry: "もう一度送る",
  again: "もう一度出す",
  close: "閉じる",
  keepGoing: "続ける",
  confirmStop: "送信をやめますか？",
  needFile: "動画のファイルを選んでください。",
  checking: "動画を確かめています…",
  notVideoFile: "MP4 か MOV の動画を選んでください。",
  fileTooLarge: "ファイルが大きすぎます（300 MB まで）。",
  unreadable: "動画として読めないファイルです。MP4 で書き出し直してから出してください。",
  cannotPlay: "このブラウザで再生できない動画です。MP4（H.264）で書き出し直してから出してください。",
  noVideoTrack: "映像の入っていないファイルです。動画のファイルを選んでください。",
  unconfirmed: "このブラウザでは再生を確かめられませんでした。このまま出せます。",
  sameSize: "同じ大きさの動画を、この提出先にもう出しています。",
  scopeMissing: "公開の範囲を選んでください。",
  stageEnded: "この提出先の受け付けが終わりました。［戻る］で選び直してください。",
  consentMissing: "「公開」を選ぶときは、同意の文を読んで「同意します」にチェックを入れてください。",
  surveyMissing: "タイトルと、何のため誰に向けた動画かを入れてください。",
  titleTooLong: "タイトルは 60 字までです。",
  purposeTooLong: "「何のため、誰に向けた動画か」は 400 字までです。",
  publicLegal: "公開は準備中です。準備ができたら、アカウントが有効な間にマイページで選べます。",
  publicLink: "公開は、アカウントが有効な間に、Google でログインしたマイページで選べます。",
  upcoming: "まだ始まっていません",
  notMp4: "MP4 か MOV の動画だけ出せます。",
  unavailable: "いまマイページからは提出できません。",
  stageNotFound: "提出先が見つかりません。読み込み直してください。",
  uploading: "送っています",
  completing: "提出を確かめています",
  starting: "準備しています",
  cancelling: "やめています",
  stopped: "送信が止まりました。",
  submissionsPaused: "いま提出の受け付けを止めています。講師の案内を待ってください。",
  submissionsReadPaused: "いま作品の再生と保存を止めています。講師の案内を待ってください。",
  cancelled: "送信をやめました。すぐに出し直せます。",
  cancelNotSent: "送信をやめました。サーバーへの連絡が届かなかったため、「送っている途中の動画」の［やめる］を、もう一度押してください。",
  replaced: "この送信は、ほかの操作で取り消されました。もう一度押してください。",
  busy: "混み合っています。少し待ってから、もう一度押してください。",
  network: "通信できませんでした。通信状態を確かめてください。",
  forbidden: "この操作の権限がありません。",
  unknown: "エラーが起きました。少し待ってから、もう一度押してください。",
  loading: "読み込んでいます",
  loadFailed: "提出先を読み込めませんでした。",
  reload: "もう一度読み込む",
  noStage: "今、提出できる段階はありません。",
};

/** 受講者に見える文の全部（試験で禁止語を確かめる） */
export function uploadTexts() {
  return Object.values(TEXT);
}
export const FORBIDDEN_WORDS = FORBIDDEN_FOR_STUDENTS;

// ---- 段 1〜3：名前・型・大きさ・先頭 12 バイト ----

/** 段 1：拡張子が .mp4・.mov（大文字も可）か、型の名前が video/mp4・video/quicktime。問題が無ければ null */
export function checkFileName(file) {
  const name = typeof file?.name === "string" ? file.name : "";
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  if (/\.(mp4|mov)$/i.test(name) || type === "video/mp4" || type === "video/quicktime") return null;
  return TEXT.notVideoFile;
}

/** 段 2：大きさが 1〜上限（既定 300,000,000）バイト。問題が無ければ null */
export function checkSize(bytes, maxBytes = UPLOAD_MAX_BYTES) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) return TEXT.unreadable;
  if (bytes > maxBytes) return TEXT.fileTooLarge;
  return null;
}

/**
 * 断る主の型の名前（先頭 8〜11 バイト。関数 submissions の video_head.ts と同じ表。設計 2.4.1）。
 * HEIF・AVIF の画像、音声（M4A など）、カメラの RAW。動画の型の名前は機器ごとに多いので、許す表にはしない
 */
export const DENIED_MAJOR_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "M4A ", "M4B ", "M4P ", "F4A ", "F4B ", "crx "];

const four = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** 段 3：先頭 12 バイトの 4〜7 バイト目が ftyp で、主の型の名前が断る表に無い。問題が無ければ null */
export function checkHead(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? new ArrayBuffer(0));
  if (b.length < 12) return TEXT.unreadable;
  if (four(b, 4) !== "ftyp") return TEXT.unreadable;
  if (DENIED_MAJOR_BRANDS.includes(four(b, 8))) return TEXT.unreadable;
  return null;
}

// ---- 段 4：ブラウザで読めるか（<video> の確かめの結果を、断る・確認・通す に写す） ----

const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * 段 4 の結果の表（設計 2.4）。ev：
 *   meta："loaded"（loadedmetadata が来た）・"error"（error が来た）・"timeout"（20 秒で何も来ない）
 *   duration・width・height：meta が loaded のときに読んだ値
 *   frame（4b）："ok"（readyState が 2 以上・loadeddata が来た）・"error"・"timeout"（10 秒）・"refused"（play() が断られた）・null（4b をしていない）
 * 返り値：{ verdict: "pass" | "confirm" | "reject", message: string | null, meta: { duration, width, height } | null }。
 * confirm は［次へ］を押せる。meta は begin に送る値（4a が時間切れのときは送らない）
 */
export function judgeProbe(ev) {
  const e = ev ?? {};
  if (e.meta === "error") return { verdict: "reject", message: TEXT.cannotPlay, meta: null };
  if (e.meta !== "loaded") return { verdict: "confirm", message: TEXT.unconfirmed, meta: null };
  if (!(positive(e.width) && positive(e.height)) || !positive(e.duration)) return { verdict: "reject", message: TEXT.noVideoTrack, meta: null };
  const meta = { duration: e.duration, width: e.width, height: e.height };
  if (e.frame === "error") return { verdict: "reject", message: TEXT.cannotPlay, meta: null };
  if (e.frame === "ok") return { verdict: "pass", message: null, meta };
  return { verdict: "confirm", message: TEXT.unconfirmed, meta };
}

// ---- 送る値 ----

/** 長さの上限（秒）と、幅・高さの範囲（ピクセル）。サーバー（submission_begin）が受ける範囲と同じ（Canvas の META_LIMITS） */
export const META_LIMITS = { maxDurationS: 86400, minPixels: 1, maxPixels: 10000 };

/**
 * 送る長さ・幅・高さ（Canvas の metaFields と同じ丸め。kumi11-site.md 2.1）。整数に丸め、範囲外・無い・数でない欄は送らない。
 * 幅と高さは 2 つがそろって範囲の中にあるときだけ送る
 */
export function metaFields(m) {
  const out = {};
  const d = m?.duration;
  if (typeof d === "number" && Number.isFinite(d) && d >= 0 && d <= META_LIMITS.maxDurationS) out.duration_s = Math.round(d);
  const w = m?.width;
  const h = m?.height;
  if (typeof w === "number" && typeof h === "number" && Number.isFinite(w) && Number.isFinite(h)) {
    const W = Math.round(w);
    const H = Math.round(h);
    const ok = (v) => v >= META_LIMITS.minPixels && v <= META_LIMITS.maxPixels;
    if (ok(W) && ok(H)) {
      out.width = W;
      out.height = H;
    }
  }
  return out;
}

/** 対になっていないサロゲートを U+FFFD に置き換える（String.prototype.toWellFormed と同じ働き。無いブラウザ向け） */
export function replaceLoneSurrogates(s) {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** source_label（選んだファイルの名前）：割れたサロゲートを直してから、コードポイントで 200 文字に切る（UTF-16 の単位で切らない。設計 4.2） */
export function labelOf(name) {
  const s = String(name ?? "");
  const fixed = typeof s.toWellFormed === "function" ? s.toWellFormed() : replaceLoneSurrogates(s);
  return Array.from(fixed).slice(0, 200).join("");
}

const isBridge = (stage) => stage?.kind === "bridge" || stage?.survey_required === true;

/**
 * POST /my/uploads の本体（設計 4.2）。経路・出どころ（via・source）と Canvas の欄は送らない（関数が決める・拾わない）。
 * input：{ stage: { stage_id, kind, survey_required }, file: { size, name }, meta: { duration, width, height } | null,
 *          survey?: { title, purpose }, scope: "lecture" | "private" | "public" | null, consentTextId: string | null }
 */
export function buildUploadBody(input) {
  const body = { stage_id: input.stage.stage_id, bytes: input.file.size, source_label: labelOf(input.file.name), ...metaFields(input.meta ?? {}) };
  if (isBridge(input.stage) && input.survey) {
    body.title = input.survey.title.trim();
    body.purpose = input.survey.purpose.trim();
  }
  if (input.scope !== null && input.scope !== undefined) {
    body.scope = input.scope;
    if (input.scope === "public" && input.consentTextId) body.consent_text_id = input.consentTextId;
  }
  return body;
}

const len = (s) => Array.from(String(s ?? "").trim()).length;

/**
 * 段 1 の入力の確かめ（ファイル・大きさ・確かめの結果・ブリッジワークのアンケート）。問題が無ければ null（［次へ］を押せる）。
 * check：{ status: "none" | "checking" | "pass" | "confirm" | "reject", message }
 */
export function validateForm({ stage, file, check, survey, maxBytes = UPLOAD_MAX_BYTES }) {
  if (!file) return TEXT.needFile;
  if (check?.status === "checking") return TEXT.checking;
  if (check?.status === "reject") return check.message ?? TEXT.unreadable;
  if (check?.status !== "pass" && check?.status !== "confirm") return TEXT.checking;
  const bad = checkSize(file.size, maxBytes);
  if (bad) return bad;
  if (isBridge(stage)) {
    if (!survey || len(survey.title) < 1 || len(survey.purpose) < 1) return TEXT.surveyMissing;
    if (len(survey.title) > 60) return TEXT.titleTooLong;
    if (len(survey.purpose) > 400) return TEXT.purposeTooLong;
  }
  return null;
}

/** 送る前の確かめ（サーバーが最後に決める）。大きさ・アンケート・公開の範囲・同意。問題が無ければ null */
export function validateSend(input) {
  const bad = checkSize(input.file?.size, input.maxBytes ?? UPLOAD_MAX_BYTES);
  if (bad) return bad;
  if (isBridge(input.stage)) {
    const sv = input.survey;
    if (!sv || len(sv.title) < 1 || len(sv.purpose) < 1) return TEXT.surveyMissing;
    if (len(sv.title) > 60) return TEXT.titleTooLong;
    if (len(sv.purpose) > 400) return TEXT.purposeTooLong;
  }
  if (input.scope === null || input.scope === undefined) return TEXT.scopeMissing;
  if (input.scope === "public" && (!input.consented || !input.consentTextId)) return TEXT.consentMissing;
  return null;
}

// ---- 提出先と受け付け（Canvas の submit/messages.ts と同じ規則） ----

const ACCEPT_STATES = ["current", "grace", "until", "closed", "upcoming"];

/** サーバーの受け付けの状態。知らない値は closed として読む（DB 254 との約束） */
export function acceptStateOf(stage) {
  const s = stage?.accept?.state;
  return ACCEPT_STATES.includes(s) ? s : "closed";
}

/** 受け付けの文（Canvas の acceptText と同じ） */
export function acceptText(stage, nowMs) {
  const kindName = stage.kind === "bridge" ? "ブリッジワーク" : "このワークショップ";
  const state = acceptStateOf(stage);
  const until = stage.accept?.until ?? null;
  const untilMs = until ? Date.parse(until) : NaN;
  if (state === "upcoming") return `${kindName}は、まだ始まっていません。`;
  if (state === "closed") return `${kindName}の受け付けは終わりました。`;
  if (state === "current") return "受け付けは、このワークショップの間です。";
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return `${kindName}の受け付けは終わりました。`;
  if (state === "grace") return `このワークショップは、あと ${Math.max(1, Math.ceil((untilMs - nowMs) / 60000))} 分出せます。`;
  // until は「この時刻を含まない終わり」。画面には最後の分（display_until。無ければ 1 分前）を出す
  const shown = stage.accept?.display_until ?? new Date(untilMs - 60000).toISOString();
  return `受け付けは ${formatShortDateTime(shown)} までです。`;
}

/** 受け付けの状態が、今の時刻でも「受け付け中」か（upcoming・closed は受け付けない） */
export function stillAccepting(stage, nowMs) {
  const state = acceptStateOf(stage);
  if (state === "closed" || state === "upcoming") return false;
  if (state === "current") return true;
  const until = stage.accept?.until ?? null;
  const untilMs = until ? Date.parse(until) : NaN;
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

export function stageOptionLabel(s) {
  return s.title ? `${s.label}「${s.title}」` : s.label;
}

/**
 * 提出先の選択肢。受け付け中の段階は選べる。まだ始まっていない段階は「まだ始まっていません」を付けて選べない。終わった段階は出さない。
 * 返り値：[{ stage, value, label, disabled }]
 */
export function stageOptions(targets, nowMs) {
  const out = [];
  for (const s of Array.isArray(targets?.stages) ? targets.stages : []) {
    if (!s || typeof s.stage_id !== "string") continue;
    if (stillAccepting(s, nowMs)) out.push({ stage: s, value: s.stage_id, label: stageOptionLabel(s), disabled: false });
    else if (acceptStateOf(s) === "upcoming") out.push({ stage: s, value: s.stage_id, label: `${stageOptionLabel(s)}（${TEXT.upcoming}）`, disabled: true });
  }
  return out;
}

/** 初めに選ぶ提出先：今の段階 → 選べる最初の段階。選べる段階が無ければ null */
export function defaultStageId(options) {
  const open = options.filter((o) => !o.disabled);
  return (open.find((o) => o.stage.is_current) ?? open[0])?.value ?? null;
}

/** 「あと 3 本 · 保存の残り 1.2 GB」 */
export function stageRoomText(stage, storage) {
  const parts = [];
  if (Number.isFinite(stage?.remaining_works)) parts.push(`あと ${Math.max(0, stage.remaining_works)} 本`);
  const used = Number(storage?.used_bytes);
  const limit = Number(storage?.limit_bytes);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) parts.push(`保存の残り ${formatBytes(Math.max(0, limit - used))}`);
  return parts.join(" · ");
}

/** GET /targets の答えに、マイページから出せる印（関数 submissions が足す。設計 4.2）があるか。あれば { maxBytes, types } */
export function uploadCaps(targets) {
  const u = targets?.upload;
  if (!u || typeof u !== "object" || u.enabled !== true) return null;
  const max = Number.isSafeInteger(u.max_bytes) && u.max_bytes > 0 ? Math.min(u.max_bytes, UPLOAD_MAX_BYTES) : UPLOAD_MAX_BYTES;
  return { maxBytes: max, types: Array.isArray(u.types) ? u.types.filter((t) => typeof t === "string") : ["mp4", "mov"] };
}

/**
 * 同じ大きさの作品をこの提出先にもう出しているときの一言（止めはしない。設計 2.5）。
 * myWorks は submissions-lib.js の normalizeMyWorks の形（works: [{ stageId, bytes }]）
 */
export function sameSizeWarning(myWorks, stageId, bytes) {
  const works = Array.isArray(myWorks?.works) ? myWorks.works : [];
  return works.some((w) => w.stageId === stageId && w.bytes === bytes) ? TEXT.sameSize : null;
}

// ---- 段 2「公開の範囲を選んでください」（Canvas の submit/scopeStep.ts と同じ規則） ----

/** 「公開」を選べない理由（1 行）。選べるなら null */
export function publicBlockedReason({ loginKind, legalReviewed }) {
  if (loginKind !== "google") return TEXT.publicLink;
  if (!legalReviewed) return TEXT.publicLegal;
  return null;
}

/** 段 2 の丸の並び（講義内 → 完全非公開 → 公開） */
export const SCOPE_ORDER = [
  { value: "lecture", label: TEXT.scopeLecture },
  { value: "private", label: TEXT.scopePrivate },
  { value: "public", label: TEXT.scopePublic },
];

export function initialScopeStep() {
  return { step: "form", stage: null, scope: null, consented: false };
}

/** ［戻る］は固定を外すだけ（選んだ範囲と同意のチェックは、同じダイアログの間は残す）。範囲を替えたら同意のチェックは外す */
export function scopeStepReducer(s, a) {
  switch (a.type) {
    case "next":
      return { ...s, step: "scope", stage: a.stage };
    case "back":
      return { ...s, step: "form", stage: null };
    case "pick":
      return { ...s, scope: a.scope, consented: a.scope === s.scope ? s.consented : false };
    case "consent":
      return { ...s, consented: a.on };
    default:
      return s;
  }
}

/** c：{ nowMs, loginKind, legalReviewed, consent, form（入力の形か。送信中・済みのときは false） } */
export function scopeStepView(s, c) {
  const publicBlocked = publicBlockedReason({ loginKind: c.loginKind, legalReviewed: c.legalReviewed });
  const stageOpen = s.stage !== null && stillAccepting(s.stage, c.nowMs);
  let reason = null;
  if (!stageOpen) reason = TEXT.stageEnded;
  else if (s.scope === null) reason = TEXT.scopeMissing;
  else if (s.scope === "public" && publicBlocked) reason = publicBlocked;
  else if (s.scope === "public" && (!c.consent || !s.consented)) reason = TEXT.consentMissing;
  return {
    canSubmit: c.form && reason === null,
    reason,
    publicBlocked,
    showConsent: s.scope === "public" && publicBlocked === null && c.consent !== null,
    stageLine: s.stage ? `提出先：${stageOptionLabel(s.stage)}` : "",
  };
}

// ---- 断りの文と動き ----

/** 済みの文（Canvas の doneText と同じ） */
export function doneText(workNo, remaining) {
  if (workNo === null) return "提出しました。";
  if (remaining === null) return `提出しました（作品 ${workNo}）。`;
  return remaining > 0 ? `提出しました（作品 ${workNo}）。あと ${remaining} 本出せます。` : `提出しました（作品 ${workNo}）。この段階には、これ以上出せません。`;
}

/** サーバーの断りの名前 → 受講者に見せる文（Canvas の errorText を、マイページの言葉に合わせた物） */
export function uploadErrorText(code, status, stageKind = "workshop") {
  switch (code) {
    case "not_found":
      return TEXT.unavailable;
    case "stage_not_found":
      return TEXT.stageNotFound;
    case "submissions_paused":
      return TEXT.submissionsPaused;
    case "submissions_read_paused":
      return TEXT.submissionsReadPaused;
    case "submission_busy":
      return "回の情報が変わりました。もう一度押してください。";
    case "work_limit_reached":
      return "この段階には、もう 5 本出しています。要らない作品を取り下げてから出してください。";
    case "storage_limit_reached":
      return "保存できる合計（2 GB）を超えます。受け付け中の要らない作品を取り下げると、すぐに空きが戻ります。";
    case "too_many_abandoned":
      return "送り直しが続いたため、しばらく新しい送信を始められません。2 時間ほどで戻ります。";
    case "too_many_uploads":
      return "ほかの動画を送っています。終わるか、「送っている途中の動画」の［やめる］を押してから、もう一度押してください。";
    case "too_many_attempts":
      return "短い時間に送り始めた回数が多すぎます。しばらく待ってから、もう一度押してください。";
    case "submission_closed":
    case "late":
      return stageKind === "bridge" ? "ブリッジワークの受け付けは終わりました。" : "このワークショップの受け付けは終わりました。";
    case "file_too_large":
      return TEXT.fileTooLarge;
    case "not_mp4":
    case "unsupported_media_type":
      return TEXT.notMp4;
    case "upload_replaced":
      return TEXT.replaced;
    case "size_mismatch":
      return "送ったファイルの大きさが合いませんでした。もう一度出してください。";
    case "upload_not_found":
      return "動画がまだ届いていません。もう一度送ってください。";
    case "not_stage_student":
      return "この回の受講者として登録されていないため、提出できません。";
    case "member_disabled":
      return "アカウントが止められているため、提出できません。";
    case "public_unavailable":
      return TEXT.publicLegal;
    case "public_needs_google":
      return TEXT.publicLink;
    case "consent_outdated":
      return "同意の文が新しくなりました。閉じて開き直し、もう一度読んでから選んでください。";
    case "survey_required":
      return TEXT.surveyMissing;
    default:
      break;
  }
  if (status === 0 || code === "network") return TEXT.network;
  if (status === 413) return TEXT.fileTooLarge;
  if (status === 415) return TEXT.notMp4;
  if (status === 403) return TEXT.forbidden;
  if (status === 429 || status === 503) return TEXT.busy;
  return TEXT.unknown;
}

/** 関数の失敗（状態の番号と断りの名前）。code は答えの code、無ければ状態の番号から決める（本体が JSON でない 404 は not_found） */
export class UploadApiError extends Error {
  constructor(status, code, detail = {}) {
    super(`submissions ${code} (${status})`);
    this.name = "UploadApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
  /** 送り直して当たる見込みがある（通信の失敗・混雑・回数の上限） */
  get retryable() {
    return this.status === 0 || this.status === 503 || this.status === 429 || this.status >= 500;
  }
}

/** 答えの本体の断りの名前（error.code・code・error の文字）。無ければ状態の番号から（Canvas の errorFromBody と同じ） */
export function errorCodeOf(status, body) {
  const b = body && typeof body === "object" ? body : {};
  const nested = b.error && typeof b.error === "object" ? b.error : null;
  const code = nested?.code ?? b.code ?? (typeof b.error === "string" ? b.error : null);
  if (typeof code === "string" && code) return code;
  if (status === 400) return "validation_failed";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 503) return "busy";
  if (status === 0) return "network";
  return "server_error";
}

/**
 * 断りの名前ごとの動き（設計 4.2 の表）。判定は code で行い、状態の番号だけで決めない（not_found と stage_not_found はどちらも 404）。
 * 返り値：{ message, hideButton（送り始めの口が無い＝前の版の関数。ボタンを隠す）, retryFrom: "begin" | "complete" | null }
 */
export function errorAction({ code, status, step = "begin", retryable = false, stageKind = "workshop" }) {
  const c = code || errorCodeOf(status, null);
  if (step === "begin" && c === "not_found") return { message: TEXT.unavailable, hideButton: true, retryFrom: null };
  const message = uploadErrorText(c, status, stageKind);
  // 送り直しが続いた（too_many_abandoned）ときは［もう一度送る］を出さない（送り直すほど予約が増える。設計 2.5）
  if (c === "too_many_abandoned") return { message, hideButton: false, retryFrom: null };
  // complete の受付停止は送信済みの同じ作品を確定し直す。begin や他の理由へは広げない
  const pausedComplete = step === "complete" && c === "submissions_paused";
  const canRetry = pausedComplete || retryable || c === "submission_busy" || c === "upload_replaced" || c === "upload_not_found";
  if (!canRetry) return { message, hideButton: false, retryFrom: null };
  // complete の通信の失敗は complete だけをやり直す（2 回目は同じ結果）。それ以外は新しい begin（置き換え）
  const retryFrom = step === "complete" && (pausedComplete || retryable || c === "submission_busy") ? "complete" : "begin";
  return { message, hideButton: false, retryFrom };
}

/** 失敗 → 画面の状態（Canvas の flow.ts の failedFrom と同じ決まり） */
export function failedFrom(e, stageKind, step, workId) {
  if (e instanceof UploadApiError) {
    const a = errorAction({ code: e.code, status: e.status, step, retryable: e.retryable, stageKind });
    return { kind: "failed", message: a.message, retryFrom: a.retryFrom, workId, code: e.code, hideButton: a.hideButton };
  }
  if (e instanceof TusError) {
    if (e.kind === "too_large") return { kind: "failed", message: TEXT.fileTooLarge, retryFrom: null, workId, code: "file_too_large", hideButton: false };
    if (e.kind === "bad_type") return { kind: "failed", message: TEXT.notMp4, retryFrom: null, workId, code: "unsupported_media_type", hideButton: false };
    // 通信の失敗・token の期限切れ・409・ほか：送信が止まった。同じファイルから送り直す（置き換え）
    return { kind: "failed", message: TEXT.stopped, retryFrom: "begin", workId, code: `tus_${e.kind}`, hideButton: false };
  }
  return { kind: "failed", message: TEXT.unknown, retryFrom: step === "complete" ? "complete" : "begin", workId, code: "unexpected", hideButton: false };
}

// ---- 流れ（Canvas の submit/flow.ts の createSubmitFlow の写し。入力の形だけをマイページに合わせた） ----

/** 送信が止まって確定待ちが残っている（捨ててよい）か。受付停止で確定できなかった送信済み動画は捨てない */
const discardable = (p) => p.kind === "failed" && !!p.workId && !(p.code === "submissions_paused" && p.retryFrom === "complete");

/**
 * deps：{ api: { begin(body), complete(workId), cancel(workId) }（失敗は UploadApiError を投げる）, apiKey,
 *         defaultEndpoint（答えに endpoint が無いときの TUS の作る口）, transport?, retryWaitMs? }
 * onChange(phase)：phase は idle・starting{cancelling}・uploading{workId,sent,total}・completing{workId}・
 *   done{workId,workNo,remaining}・failed{message,retryFrom,workId,code,hideButton}・cancelled{notSent}
 * 返り値：{ phase(), start(input), retry(), cancel(), discard(), halt() }
 */
export function createUploadFlow(deps, onChange) {
  let phase = { kind: "idle" };
  let input = null;
  /** 今の流れの番号。止めたあと・やり直したあとに届いた古い結果を捨てる */
  let run = 0;
  let abort = null;
  let tusUrl = null;
  let tusTarget = null;
  let cancelRequested = false;
  const set = (p) => {
    phase = p;
    onChange(p);
  };
  const busy = () => phase.kind === "starting" || phase.kind === "uploading" || phase.kind === "completing";
  const targetArgs = (t) => ({ endpoint: t.endpoint ?? deps.defaultEndpoint, token: t.token, apiKey: deps.apiKey, transport: deps.transport });

  /** サーバーの確定待ちを捨てる。{ kind: "ok" } ／ { kind: "ready", workNo }（その前に確定していた）／ { kind: "failed" }（届かなかった） */
  const cancelOnServer = async (workId) => {
    try {
      await deps.api.cancel(workId);
      return { kind: "ok" };
    } catch (e) {
      if (e instanceof UploadApiError && e.code === "already_ready") {
        const d = e.detail ?? {};
        const n = Number(d.work_no ?? d.error?.work_no);
        return { kind: "ready", workNo: Number.isInteger(n) && n >= 1 ? n : null };
      }
      return { kind: "failed" };
    }
  };
  /** TUS の DELETE → cancel（この順。DELETE の成否にかかわらず cancel を呼ぶ） */
  const abandon = async (workId) => {
    if (tusUrl && tusTarget) await tusDelete(targetArgs(tusTarget), tusUrl).catch(() => false);
    return cancelOnServer(workId);
  };
  const settleAfterCancel = (workId, r) => {
    if (r.kind === "ready") set({ kind: "done", workId, workNo: r.workNo, remaining: null });
    else set({ kind: "cancelled", notSent: r.kind === "failed" });
  };

  const complete = async (my, workId, inp) => {
    set({ kind: "completing", workId });
    try {
      const r = await deps.api.complete(workId);
      if (my !== run) return;
      const n = Number(r?.work_no);
      const left = Number(r?.remaining_works);
      set({ kind: "done", workId, workNo: Number.isInteger(n) && n >= 1 ? n : null, remaining: Number.isInteger(left) ? left : null });
    } catch (e) {
      if (my !== run) return;
      set(failedFrom(e, inp.stage.kind, "complete", workId));
    }
  };

  const sendAndComplete = async (my, begun, inp) => {
    const total = inp.file.size;
    tusTarget = begun.upload;
    tusUrl = null;
    abort = new AbortController();
    set({ kind: "uploading", workId: begun.work_id, sent: 0, total });
    try {
      await tusUpload({
        ...targetArgs(begun.upload),
        blob: inp.file,
        bucket: begun.upload.bucket,
        objectName: begun.upload.object_name,
        // 型の名前は begin の答え（いつも video/mp4）。ファイルの type（MOV の video/quicktime）はバケットが 415 で断る（設計 2.3）
        contentType: begun.upload.content_type,
        signal: abort.signal,
        retryWaitMs: deps.retryWaitMs,
        onCreated: (u) => {
          if (my === run) tusUrl = u;
        },
        onProgress: (sent, t) => {
          if (my === run && phase.kind === "uploading") set({ kind: "uploading", workId: begun.work_id, sent, total: t });
        },
      });
    } catch (e) {
      if (my !== run) return; // やめた・やり直した
      if (e instanceof TusError && e.kind === "aborted") return;
      const f = failedFrom(e, inp.stage.kind, "upload", begun.work_id);
      // 大きすぎる・型が違うは送り直しても通らない：確定待ちを今のうちに捨てて、予約を戻す。送り直せる失敗は捨てない（置き換えが基準の時刻を引き継ぐため）
      if (f.retryFrom === null) await abandon(begun.work_id);
      if (my === run) set(f);
      return;
    }
    if (my !== run) return;
    await complete(my, begun.work_id, inp);
  };

  const begin = async (my, inp) => {
    cancelRequested = false;
    set({ kind: "starting", cancelling: false });
    let begun;
    try {
      begun = await deps.api.begin(buildUploadBody(inp));
    } catch (e) {
      if (my !== run) return;
      if (cancelRequested) {
        set({ kind: "cancelled", notSent: false });
        return;
      }
      set(failedFrom(e, inp.stage.kind, "begin", null));
      return;
    }
    if (my !== run) return;
    if (cancelRequested) {
      // 送り始めの応答が、［やめる］のあとに届いた：送らずに捨てる
      const r = await cancelOnServer(begun.work_id);
      if (my === run) settleAfterCancel(begun.work_id, r);
      return;
    }
    await sendAndComplete(my, begun, inp);
  };

  return {
    phase: () => phase,
    async start(inp) {
      if (busy()) return;
      const bad = validateSend(inp);
      if (bad) {
        set({ kind: "failed", message: bad, retryFrom: null, workId: null, code: "validation", hideButton: false });
        return;
      }
      input = { ...inp };
      run += 1;
      await begin(run, input);
    },
    async retry() {
      if (phase.kind !== "failed" || !input) return;
      const from = phase.retryFrom;
      if (!from) return;
      run += 1;
      if (from === "complete" && phase.workId) await complete(run, phase.workId, input);
      else await begin(run, input);
    },
    async cancel() {
      if (phase.kind === "starting") {
        cancelRequested = true;
        set({ kind: "starting", cancelling: true });
        return;
      }
      if (phase.kind !== "uploading") return;
      const workId = phase.workId;
      run += 1; // これ以後に届く送信の結果・進みは捨てる
      abort?.abort();
      settleAfterCancel(workId, await abandon(workId));
    },
    async discard() {
      if (!discardable(phase)) return;
      const workId = phase.workId;
      run += 1;
      const r = await abandon(workId);
      if (r.kind === "ready") settleAfterCancel(workId, r);
      else set({ kind: "idle" });
    },
    /**
     * ログアウトなどで画面を消すとき：これ以後の結果を捨て、送信（XMLHttpRequest）を止める。画面の状態は変えない。
     * 送っている途中、または送信が止まって確定待ちが残っている（failed で workId がある。discard と同じ決まり）なら、
     * 捨てるための材料 { workId, tusUrl, tusArgs } を返す（呼び出し側が DELETE と cancel を 1 回試す）。
     * begin の答えを待っている途中（starting）は返さない（work_id がまだ無い。見回りの掃除に任せる。設計 2.5）
     */
    halt() {
      const p = phase;
      run += 1;
      abort?.abort();
      if (p.kind !== "uploading" && !discardable(p)) return null;
      return { workId: p.workId, tusUrl, tusArgs: tusTarget ? targetArgs(tusTarget) : null };
    },
  };
}
