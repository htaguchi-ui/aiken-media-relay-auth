// マイページから手元の動画を直接提出する（組 11 の (8)。設計 kumi11-mypage-upload.md）の、画面に依存しない部品。
// 画面（ダイアログ・<video> での確かめ）は mypage-upload.js。試験は scripts/upload_lib_test.mjs。
//   - ファイルの確かめ（段 1〜4。設計 2.4）：checkFileName・checkSize・checkHead・judgeProbe
//   - 送る値：metaFields・labelOf・buildUploadBody
//   - 段 2「公開範囲を選んでください」：scopeStepReducer・scopeStepView（Canvas の submit/scopeStep.ts と同じ規則）
//   - 提出先：stageOptions・acceptText・stillAccepting（Canvas の submit/messages.ts と同じ規則。upcoming は「受付前」）
//   - 同じ動画の確かめ（dup-confirm-20261105/DESIGN.md・D-1105-183x・191x）：sameFileWorkNos・dupConfirmBody（題は TEXT.dupTitle）
//   - 断りの文と動き：uploadErrorText・uploadErrorCode・uploadTip・errorAction・failedFrom
//   - 流れ（begin → TUS → complete・［キャンセル］・［再送信］）：createUploadFlow（Canvas の submit/flow.ts の決まりを写した物）
// Canvas の tus.ts・flow.ts・scopeStep.ts・messages.ts を直すときは、この写しも同じ commit で直す（設計 2.8）。
// 締切・上限・権限はサーバーが決める。画面は、サーバーが返した受け付けの状態と、断りの名前（code）を文にするだけ。
import { TusError, tusDelete, tusUpload } from "./tus-lib.js";
import {
  FORBIDDEN_FOR_STUDENTS,
  formatBytes,
  formatShortDateTime,
  MSG_MEMBER_DISABLED,
  MSG_NETWORK_PRESS_AGAIN,
  PUBLIC_BLOCKED_LEGAL,
  PUBLIC_BLOCKED_LINK,
  PUBLIC_BLOCKED_TIPS,
  SCOPE_CHOICE_LABELS,
  SCOPE_CHOICE_NOTES,
} from "./submissions-lib.js";

/** 出せる大きさの上限（バイト。関数の印 upload.max_bytes が無いときの値。230 の file_bytes と同じ） */
export const UPLOAD_MAX_BYTES = 300_000_000;
/** ファイルを選ぶ欄の accept（MP4 と MOV） */
export const UPLOAD_ACCEPT = ".mp4,.mov,video/mp4,video/quicktime";
/** 段 4a（loadedmetadata）と段 4b（最初の 1 コマ）の待ち（ミリ秒。設計 2.4） */
export const PROBE_META_TIMEOUT_MS = 20_000;
export const PROBE_FRAME_TIMEOUT_MS = 10_000;

/**
 * 画面の文（設計 2.4・2.7・4.2。Canvas の submit/messages.ts と同じ言葉にそろえる。組 13 の文言の表）。
 * 「\n」の後ろは 2 行目（次の手）。出す所は white-space: pre-line。エラーコードは文に入れず UPLOAD_ERROR_CODES で持つ
 */
export const TEXT = {
  open: "動画を提出する",
  title: "動画を提出",
  bridgeIntro: "ブリッジワークは自主的な制作です。提出は任意です。",
  file: "ファイル",
  stage: "提出先",
  fieldTitle: "タイトル",
  fieldPurpose: "何のため、誰に向けた動画ですか",
  scopeStepTitle: "公開範囲を選んでください",
  // 3 つの丸の名前と説明は、マイページの一覧の ？ の中と同じ（submissions-lib.js の SCOPE_CHOICE_LABELS・SCOPE_CHOICE_NOTES。組 13 の U-13・D-1105-121x）。
  // 説明は、それぞれの丸の下に常に 1 行ずつ出す（D-1104-130x-c）
  scopeLecture: SCOPE_CHOICE_LABELS.lecture,
  scopePrivate: SCOPE_CHOICE_LABELS.private,
  scopePublic: SCOPE_CHOICE_LABELS.public,
  scopeLectureNote: SCOPE_CHOICE_NOTES.lecture,
  scopePrivateNote: SCOPE_CHOICE_NOTES.private,
  scopePublicNote: SCOPE_CHOICE_NOTES.public,
  consentCheck: "同意します",
  next: "次へ",
  back: "戻る",
  cancel: "キャンセル",
  // 送信の中止の確認の赤いボタン（確認の題と同じ動作の名前。cancel とは別の値）
  cancelSend: "送信をキャンセル",
  submitWorkshop: "提出する",
  submitBridge: "提出する",
  retry: "再送信",
  again: "再提出",
  close: "閉じる",
  // 送信の中止の確認で、送信を続けるボタン（［キャンセル］にすると、止めたい人が押して送信が続く）
  keepGoing: "続ける",
  // 入力内容の破棄の確認で、破棄しないボタン
  discardKeep: "キャンセル",
  confirmStop: "送信をキャンセルしますか？",
  // 入れた内容があるときに Esc で閉じようとしたら、同じ窓の中で聞く（組 13 の U-11）
  confirmDiscard: "入力内容を破棄しますか？",
  discardClose: "破棄する",
  needFile: "ファイルを選んでください。",
  checking: "確認中…",
  notVideoFile: "MP4 か MOV の動画を選んでください。",
  fileTooLarge: "ファイルは 300 MB までです。",
  unreadable: "ファイルエラー：動画を読み込めません。\nMP4 で書き出してから、再度選んでください。",
  cannotPlay: "ファイルエラー：再生できない形式です。\nMP4（H.264）で書き出してください。",
  noVideoTrack: "ファイルエラー：映像がありません。\n動画のファイルを選んでください。",
  unconfirmed: "再生を確認できませんでした。\nこのまま提出できます。",
  // 同じ提出先に同じ動画を再度提出するときの確かめの題（本文は dupConfirmBody。ボタンは cancel と submitWorkshop・submitBridge。Canvas と同じ文）
  dupTitle: "再度提出しますか？",
  scopeMissing: "公開範囲を選んでください。",
  stageEnded: "この提出先の受付は終了しました。\n［戻る］で別の提出先を選んでください。",
  // 送信をキャンセルしたあと（［戻る］が出ない）に出す形（mypage-upload.js）
  stageEndedNoBack: "この提出先の受付は終了しました。",
  consentMissing: "「同意します」にチェックを入れてください。",
  surveyMissing: "未入力の欄があります。",
  titleTooLong: "タイトルは 60 字までです。",
  purposeTooLong: "「何のため、誰に向けた動画か」は 400 字までです。",
  // 「公開」を選べない理由（マイページの一覧と同じ文。続きはホバー）
  publicLegal: PUBLIC_BLOCKED_LEGAL,
  publicLink: PUBLIC_BLOCKED_LINK,
  publicLegalTip: PUBLIC_BLOCKED_TIPS[PUBLIC_BLOCKED_LEGAL],
  publicLinkTip: PUBLIC_BLOCKED_TIPS[PUBLIC_BLOCKED_LINK],
  upcoming: "受付前",
  notMp4: "MP4 か MOV の動画を選んでください。",
  unavailable: "現在、マイページからは提出できません。",
  stageNotFound: "提出エラー：提出先が見つかりません。\nページを再読み込みしてください。",
  // 状態の札。後ろに数が続くので「…」は付けない（mypage-upload.js で「送信中 45%（…）」）
  uploading: "送信中",
  completing: "確認中…",
  starting: "準備中…",
  cancelling: "キャンセル中…",
  stopped: "送信エラー：中断されました。\n［再送信］を押してください。",
  submissionsPaused: "提出の受付を停止中です。\n講師の案内をお待ちください。",
  submissionsReadPaused: "再生と保存を停止中です。\n講師の案内をお待ちください。",
  cancelled: "送信をキャンセルしました。",
  cancelNotSent: "キャンセルが完了していません。\n「送信中の動画」で再度キャンセルしてください。",
  cancelNotSentTip: "送信は停止済みです。",
  replaced: "送信エラー：この送信は無効になりました。\n再度お試しください。",
  busy: "混雑しています。\nしばらくしてから再度お試しください。",
  // 押した操作（［提出する］・［再送信］など）の失敗だけで出す（組 13 の U-10 の T-05）
  network: MSG_NETWORK_PRESS_AGAIN,
  forbidden: "権限エラー：この操作はできません。\n講師・スタッフにお知らせください。",
  unknown: "提出エラーが発生しました。\nしばらくしてから再度お試しください。",
  loading: "読み込み中…",
  loadFailed: "読み込みエラー：提出先を取得できません。",
  reload: "再読み込み",
  // 1 行だけの空の状態なので句点を付けない
  noStage: "現在、提出先はありません",
  // サーバーの断りの名前ごとの文（uploadErrorText）
  stateChanged: "提出エラー：回の設定が変わりました。\n再度お試しください。",
  workLimit: "提出上限に達しました。\n不要な動画を取り下げてから、再度提出してください。",
  workLimitTip: "送信中の動画も本数に入ります。",
  storageLimit: "保存容量の上限（2 GB）を超えます。\n不要な動画を取り下げてから、再度提出してください。",
  storageLimitTip: "提出のたびに 300 MB の空きが必要です。",
  tooManyAbandoned: "送信エラー：送信の回数が上限です。\n2 時間ほどしてから再度お試しください。",
  tooManyUploads: "送信エラー：ほかの動画を送信中です。\n完了を待つか、「送信中の動画」でキャンセルしてください。",
  tooManyAttempts: "送信エラー：送信の回数が上限です。\nしばらくしてから再度お試しください。",
  bridgeClosed: "ブリッジワークの受付は終了しました。",
  workshopClosed: "このワークショップの受付は終了しました。",
  sizeMismatch: "送信エラー：動画が正しく届きませんでした。\n再度ファイルを選んで、提出してください。",
  uploadNotFound: "送信エラー：動画が正しく届きませんでした。\n［再送信］を押してください。",
  notStageStudent: "提出エラー：受講者として未登録です。\n講師・スタッフにお知らせください。",
  memberDisabled: MSG_MEMBER_DISABLED,
  consentOutdated: "同意の文が更新されました。\nこのダイアログを閉じて、再度開いてください。",
  // 関数 submissions の認証の断り（組 13 の文言の表 MP-046・MP-047 の申し送り。サーバーの submissions/errors.ts の同じ理由の文と同じ）
  notRegistered: "利用登録が確認できません。\n講師・スタッフにお知らせください。",
  serverMisconfigured: "サーバーエラーが発生しました。\n講師・スタッフにお知らせください。",
  loginRequired: "ログインが必要です。",
  loginInvalid: "ログインが無効です。\n再度ログインしてください。",
  loginLinkEnded: "リンクでのログインが終了しました。\nGoogle で再度ログインしてください。",
};

/** 受講者に見える文の全部（試験で禁止語を確かめる） */
export function uploadTexts() {
  return Object.values(TEXT);
}

/**
 * 断りの文に付けるエラーコード（D-1104-130x-b・決まり 3.2：文の定数に入れず、別の値で持つ。error-codes.md と同じ）。
 * 文 → コード。出す所（mypage-upload.js）が最後の文の後ろに小さく薄く「（E-SUB-04）」と出す
 */
const UPLOAD_ERROR_CODES = new Map([
  [TEXT.tooManyAbandoned, "E-SUB-04"],
  [TEXT.tooManyAttempts, "E-SUB-05"],
  [TEXT.sizeMismatch, "E-SUB-06"],
  [TEXT.uploadNotFound, "E-SUB-07"],
  [TEXT.notStageStudent, "E-SUB-50"],
  [TEXT.serverMisconfigured, "E-SUB-52"],
  [TEXT.memberDisabled, "E-LOG-50"],
  [TEXT.notRegistered, "E-LOG-51"],
  [TEXT.forbidden, "E-LOG-52"],
  [TEXT.unknown, "E-SUB-99"],
]);
/** 文に付けるエラーコード（無ければ null） */
export function uploadErrorCode(message) {
  return UPLOAD_ERROR_CODES.get(message) ?? null;
}

/** ホバー（title）に置く補足（文 → 補足。文言の表の tooltip）。次の手は本文にあるので、補足が見えなくても進める */
const UPLOAD_TIPS = new Map([
  [TEXT.workLimit, TEXT.workLimitTip],
  [TEXT.storageLimit, TEXT.storageLimitTip],
  [TEXT.cancelNotSent, TEXT.cancelNotSentTip],
  [TEXT.publicLegal, TEXT.publicLegalTip],
  [TEXT.publicLink, TEXT.publicLinkTip],
]);
/** 文のホバーの補足（無ければ null） */
export function uploadTip(message) {
  return UPLOAD_TIPS.get(message) ?? null;
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
  if (state === "upcoming") return `${kindName}は受付前です。`;
  if (state === "closed") return `${kindName}の受付は終了しました。`;
  if (state === "current") return "受付はこのワークショップの間です。";
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return `${kindName}の受付は終了しました。`;
  if (state === "grace") return `受付はあと ${Math.max(1, Math.ceil((untilMs - nowMs) / 60000))} 分です。`;
  // until は「この時刻を含まない終わり」。画面には最後の分（display_until。無ければ 1 分前）を出す
  const shown = stage.accept?.display_until ?? new Date(untilMs - 60000).toISOString();
  return `受付は ${formatShortDateTime(shown)} までです。`;
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
 * 提出先の選択肢。受け付け中の段階は選べる。まだ始まっていない段階は「受付前」を付けて選べない。終わった段階は出さない。
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

/** 「あと 3 本 · 空き容量 1.2 GB」 */
export function stageRoomText(stage, storage) {
  const parts = [];
  if (Number.isFinite(stage?.remaining_works)) parts.push(`あと ${Math.max(0, stage.remaining_works)} 本`);
  const used = Number(storage?.used_bytes);
  const limit = Number(storage?.limit_bytes);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) parts.push(`空き容量 ${formatBytes(Math.max(0, limit - used))}`);
  return parts.join(" · ");
}

/** GET /targets の答えに、マイページから出せる印（関数 submissions が足す。設計 4.2）があるか。あれば { maxBytes, types } */
export function uploadCaps(targets) {
  const u = targets?.upload;
  if (!u || typeof u !== "object" || u.enabled !== true) return null;
  const max = Number.isSafeInteger(u.max_bytes) && u.max_bytes > 0 ? Math.min(u.max_bytes, UPLOAD_MAX_BYTES) : UPLOAD_MAX_BYTES;
  return { maxBytes: max, types: Array.isArray(u.types) ? u.types.filter((t) => typeof t === "string") : ["mp4", "mov"] };
}

// ---- 同じ動画の確かめ（dup-confirm 2・3 章。止めない：確かめの［提出する］で今と同じ提出になる。D21・D24 の数え方は変えない） ----

/**
 * 同じ提出先に、同じファイル（同じ bytes）の動画をもう提出しているときの、その動画の番号（dup-confirm 2.1・2.2）。
 * 比べるのは同じ提出先の、出している作品だけ（GET /my/works は ready の作品だけを返す）。出どころ（Canvas・マイページ・AI）は問わない。
 * myWorks は submissions-lib.js の normalizeMyWorks の形（works: [{ stageId, workNo, bytes }]）。読めなかった（null）ときは []。
 * 返り値：当たった作品ごとに 1 つ（番号の順。番号の無い作品も数え、null として後ろに置く。本文には出さない）。当たらなければ []
 */
export function sameFileWorkNos(myWorks, stageId, bytes) {
  if (typeof stageId !== "string" || !stageId || !Number.isSafeInteger(bytes) || bytes < 1) return [];
  const works = Array.isArray(myWorks?.works) ? myWorks.works : [];
  return works
    .filter((w) => w && w.stageId === stageId && w.bytes === bytes)
    .map((w) => (Number.isInteger(w.workNo) && w.workNo >= 1 ? w.workNo : null))
    .sort((a, b) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b));
}

/**
 * 確かめの本文（dup-confirm 3.2。Canvas の submit/messages.ts と同じ文）：「この動画は提出済みです（ワークショップ 1・動画 3）。」。
 * 2 本以上は「動画 3、4」。提出先の名前が空なら「（動画 3）」、番号が無ければ「（ワークショップ 1）」、どちらも無ければ括弧ごと出さない
 */
export function dupConfirmBody(label, workNos) {
  const nos = [...new Set((Array.isArray(workNos) ? workNos : []).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  const parts = [typeof label === "string" ? label.trim() : "", nos.length ? `動画 ${nos.join("、")}` : ""].filter(Boolean);
  return parts.length ? `この動画は提出済みです（${parts.join("・")}）。` : "この動画は提出済みです。";
}

// ---- 段 2「公開範囲を選んでください」（Canvas の submit/scopeStep.ts と同じ規則） ----

/** 「公開」を選べない理由（1 行）。選べるなら null */
export function publicBlockedReason({ loginKind, legalReviewed }) {
  if (loginKind !== "google") return TEXT.publicLink;
  if (!legalReviewed) return TEXT.publicLegal;
  return null;
}

/** 段 2 の丸の並び（講義内 → 完全非公開 → 公開）。note は丸の下に常に出す 1 行（D-1104-130x-c） */
export const SCOPE_ORDER = [
  { value: "lecture", label: TEXT.scopeLecture, note: TEXT.scopeLectureNote },
  { value: "private", label: TEXT.scopePrivate, note: TEXT.scopePrivateNote },
  { value: "public", label: TEXT.scopePublic, note: TEXT.scopePublicNote },
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

/** 済みの文（Canvas の doneText と同じ。受講者の文は「動画」） */
export function doneText(workNo, remaining) {
  if (workNo === null) return "提出しました。";
  if (remaining === null) return `提出しました（動画 ${workNo}）。`;
  return remaining > 0 ? `提出しました（動画 ${workNo}）。\nあと ${remaining} 本提出できます。` : `提出しました（動画 ${workNo}）。\n提出上限に達しました。`;
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
      return TEXT.stateChanged;
    case "work_limit_reached":
      return TEXT.workLimit;
    case "storage_limit_reached":
      return TEXT.storageLimit;
    case "too_many_abandoned":
      return TEXT.tooManyAbandoned;
    case "too_many_uploads":
      return TEXT.tooManyUploads;
    case "too_many_attempts":
      return TEXT.tooManyAttempts;
    case "submission_closed":
    case "late":
      return stageKind === "bridge" ? TEXT.bridgeClosed : TEXT.workshopClosed;
    case "file_too_large":
      return TEXT.fileTooLarge;
    case "not_mp4":
    case "unsupported_media_type":
      return TEXT.notMp4;
    case "upload_replaced":
      return TEXT.replaced;
    case "size_mismatch":
      return TEXT.sizeMismatch;
    case "upload_not_found":
      return TEXT.uploadNotFound;
    case "not_stage_student":
      return TEXT.notStageStudent;
    case "member_disabled":
      return TEXT.memberDisabled;
    case "public_unavailable":
      return TEXT.publicLegal;
    case "public_needs_google":
      return TEXT.publicLink;
    case "consent_outdated":
      return TEXT.consentOutdated;
    case "survey_required":
      return TEXT.surveyMissing;
    // 認証の断り（submissions/auth.ts・index.ts）。前は 403 → 権限の文、401・500 → 原因が分からない文になっていた
    case "not_registered":
      return TEXT.notRegistered;
    case "server_misconfigured":
      return TEXT.serverMisconfigured;
    case "unauthorized":
      return TEXT.loginRequired;
    case "invalid_token":
      return TEXT.loginInvalid;
    case "login_link_session_revoked":
      return TEXT.loginLinkEnded;
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
  // 送り直しが続いた（too_many_abandoned）ときは［再送信］を出さない（送り直すほど予約が増える。設計 2.5）
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
      // 送り始めの応答が、［キャンセル］のあとに届いた：送らずに捨てる
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
