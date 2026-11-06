// 講師ページの制作時間のタイマー（KT）の、画面を持たない関数。設計 docs/design-workshop-guide.md 第 1.3.1 版 2.6・4.5。
// RPC の返り値の形は .orchestration/wt/g/kt-timer-rpc-contract.md（G・2026-10-26）。開始・延長・取り消しの可否と回の段階は DB が決める。
// 残りの時間は ends_at と、読んだときの server_now と端末の時計の差で数える（端末の時計がずれていても、サーバーの時刻で数える）。
// 終わったあとの延長は「今から」延ばす（main の決定。DB の stage_timer_extend は greatest(ends_at, now()) ＋ 分）。
import { isNetworkFailure, MSG_NETWORK_FAILURE } from "./admin-lib.js";
import { MSG_UPDATE_RESULT_UNKNOWN, stageName } from "./stage-lib.js";

/** ［20 分］［30 分］［40 分］［60 分］ */
export const TIMER_PRESETS = Object.freeze([20, 30, 40, 60]);
/** ［＋5 分］［＋10 分］ */
export const TIMER_EXTENDS = Object.freeze([5, 10]);
/** 始めるときの分（DB と同じ範囲） */
export const TIMER_MIN = 5;
export const TIMER_MAX = 180;
/** 延ばしたあとの合計の上限（DB と同じ） */
export const TIMER_TOTAL_MAX = 240;

const text = (v) => (typeof v === "string" && v.trim() ? v : null);
const ms = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/** timer の形（workshop_timer_json）。欠けている・形が違うときは null（動いていないとは決めない。呼ぶ側が札を隠す） */
export function normalizeTimer(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const startedAt = ms(raw.started_at);
  const endsAt = ms(raw.ends_at);
  const minutesTotal = posInt(raw.minutes_total);
  const revision = posInt(raw.revision);
  if (raw.id === undefined || raw.id === null || !text(raw.stage_id) || startedAt === null || endsAt === null || endsAt <= startedAt) return undefined;
  if (minutesTotal === null || minutesTotal > TIMER_TOTAL_MAX || revision === null) return undefined;
  return { id: String(raw.id), stageId: raw.stage_id, startedAt, endsAt, minutesTotal, revision, setByEmail: text(raw.set_by_email) };
}

/**
 * stage_timer_status の答え。形が違えば null（札を隠す）。
 * 返り値：{ cohortId, serverNow, clockOffset, period, stage: { id, dayKind, label, title } | null, canStart, timer | null }
 */
export function normalizeTimerStatus(raw, expectedCohortId, receivedAt = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!text(raw.cohort_id) || raw.cohort_id !== expectedCohortId) return null;
  const serverNow = ms(raw.server_now);
  if (serverNow === null || typeof raw.can_start !== "boolean") return null;
  let stage = null;
  if (raw.stage !== null && raw.stage !== undefined) {
    if (typeof raw.stage !== "object" || !text(raw.stage.id)) return null;
    stage = { id: raw.stage.id, dayKind: text(raw.stage.day_kind), label: text(raw.stage.label), title: text(raw.stage.title) };
  }
  if (raw.can_start && !stage) return null;
  const timer = normalizeTimer(raw.timer ?? null);
  if (timer === undefined) return null;
  // 今の段階のタイマーだけを見る（段階を移ったあとの古いタイマーは DB が null で返すが、念のため照らす）
  if (timer && (!stage || timer.stageId !== stage.id)) return null;
  return {
    cohortId: raw.cohort_id,
    serverNow,
    clockOffset: serverNow - receivedAt,
    period: text(raw.period),
    stage,
    canStart: raw.can_start,
    timer,
  };
}

/** 時刻（日本時間の 12:10） */
export function formatClock(msValue) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(msValue));
}

/** 延長のボタンの名前：走っている間は［＋5 分］、終わったあとは［今から 5 分］ */
export function extendLabel(minutes, state) {
  return state === "ended" ? `今から ${minutes} 分` : `＋${minutes} 分`;
}

/**
 * 延長したあとの知らせ。終わりの時刻は延長の応答（stage_timer_extend の timer.ends_at）から作る。
 * 押す前の札の状態からは決めない（ほかの講師が先に延ばしていると、DB はその終わりに足すため、「今から 5 分」とは限らない）。
 * 応答に終わりの時刻が無いときは、足した分だけを知らせる
 */
export function extendDoneText(minutes, data) {
  const endsAt = ms(data?.timer?.ends_at);
  return endsAt === null ? `${minutes} 分延長しました。` : `${minutes} 分延長しました（${formatClock(endsAt)} まで）。`;
}

/** 始めたあとの知らせ。replaced（置き換えた動いているタイマーの数）が 1 以上ならそう添える */
export function startDoneText(minutes, replaced) {
  const base = `タイマーを ${minutes} 分で開始しました。`;
  return Number.isSafeInteger(replaced) && replaced > 0 ? `${base}前のタイマーを置き換えました。` : base;
}

/** 札に出す段階の名前（講師ページの「今」の行と同じ書き方） */
export function timerStageLine(status) {
  return status?.stage ? `段階：${stageName(status.stage)}` : "";
}

/**
 * WS のカードの右上の残り（分：秒。組 11 の (6)）。60 分以上も時間に繰り上げない（75:00・240:00）。
 * 60 分を切る瞬間に形が変わって読み違えないため。負・数でない値は 00:00
 */
export function formatRemaining(sec) {
  const n = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/**
 * タイマーを始める分の既定（組 11 の (6)。組 10 の J6 を改める＝決定 C）：回の WS の分（cohort_stage_minutes）を 5〜180 に切り詰める。
 * 返り値：{ value: 分 | null（既定なし）, clamped: 切り詰める前の分 | null（切り詰めていない） }
 */
export function defaultTimerMinutes(m) {
  if (!Number.isSafeInteger(m) || m <= 0) return { value: null, clamped: null };
  const v = Math.min(TIMER_MAX, Math.max(TIMER_MIN, m));
  return { value: v, clamped: v !== m ? m : null };
}

/** 既定の分を切り詰めたときだけ、入力の下に出す 1 行（切り詰めていなければ空） */
export function defaultMinutesNote(d) {
  if (!d || d.clamped === null || d.value === null) return "";
  return d.clamped > TIMER_MAX
    ? `予定 ${d.clamped} 分（タイマーは最大 ${TIMER_MAX} 分）`
    : `予定 ${d.clamped} 分（タイマーは最短 ${TIMER_MIN} 分）`;
}

/**
 * 札の見た目：{ visible, state: "idle" | "running" | "ended", remainingSec, line, stageLine, extendable: [分...], canCancel, clock }。
 * clock：WS のカードの右上に出す残り（動いている・終わったときだけ。始まっていない・札を出さないときは空）。
 * visible は、段階の回の今のワークショップの段階があり（can_start）、回がクローズ済みでないとき。
 * now：端末の時計（Date.now()）。サーバーの時刻に直してから数える
 */
export function timerView(status, now, { closed = false } = {}) {
  const hidden = { visible: false, state: "idle", remainingSec: null, line: "", stageLine: "", extendable: [], canCancel: false, clock: "" };
  if (!status || !status.canStart || !status.stage || closed) return hidden;
  const stageLine = timerStageLine(status);
  const t = status.timer;
  if (!t) return { ...hidden, visible: true, line: "まだ始まっていません", stageLine };
  const serverNow = now + (Number.isFinite(status.clockOffset) ? status.clockOffset : 0);
  const remainingSec = Math.max(0, Math.ceil((t.endsAt - serverNow) / 1000));
  const extendable = TIMER_EXTENDS.filter((m) => t.minutesTotal + m <= TIMER_TOTAL_MAX);
  if (remainingSec <= 0) {
    return { visible: true, state: "ended", remainingSec: 0, line: `終了しました（${formatClock(t.endsAt)}）`, stageLine, extendable, canCancel: true, clock: formatRemaining(0) };
  }
  const minutes = Math.ceil(remainingSec / 60);
  return {
    visible: true,
    state: "running",
    remainingSec,
    line: `残り ${minutes} 分（${formatClock(t.endsAt)} まで）`,
    stageLine,
    extendable,
    canCancel: true,
    clock: formatRemaining(remainingSec),
  };
}

/** 分の入力（全角の数字も受ける）。5〜180 の整数でなければ null */
export function parseTimerMinutes(value) {
  const s = String(value ?? "").trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= TIMER_MIN && n <= TIMER_MAX ? n : null;
}

const ERRORS = {
  cohort_closed: "タイマーエラー：クローズ済みの回です。",
  stage_mode_off: "タイマーエラー：この回には段階がありません。",
  stage_outside_course: "タイマーエラー：回の期間外です。",
  timer_bridge: "タイマーエラー：ブリッジワークの期間は使えません。",
  timer_no_stage: "タイマーエラー：今の段階がありません。",
  timer_not_running: "タイマーエラー：今の段階には設定されていません。",
  // 量の上限（今の合計＋延ばす分＞240）なので前置きを付けず単独（決まり 3.7）
  timer_limit: `タイマーの上限（合計 ${TIMER_TOTAL_MAX} 分）を超えます。`,
  workshop_input_invalid: `タイマーは ${TIMER_MIN}〜${TIMER_MAX} 分です。`,
  instructor_only: "権限エラー：この回の担当ではありません。",
};
/** 延長（1〜60 分。workshop_guide.sql:974）の workshop_input_invalid（開始と同じ名前なので、操作で分ける） */
const MSG_EXTEND_INVALID = "タイマーエラー：延長は 1〜60 分です。";
/** 断りのエラーコード（決まり 3.2。文と別の値）。50 番台の 2 行目「管理者にお知らせください。」は講師ページの側で足す */
const ERROR_CODES = { instructor_only: "E-LOG-53" };

/**
 * 読み込みの失敗が一時的か。関数が無い（PGRST202）・権限が無い（42501）・DB が断った（P0001）は一時的でない（札を隠す）。
 * それ以外（通信の失敗・時間切れ・5xx など）は一時的とみなし、前に読んだ表示を残して次の読み直しを待つ
 */
export function isTransientTimerError(error) {
  const code = String(error?.code ?? "");
  return !["PGRST202", "42501", "P0001"].includes(code);
}

/** 断りの理由の名前（ERRORS の鍵）。表に無ければ null */
function timerErrorKey(error) {
  if (Object.hasOwn(ERRORS, String(error?.message ?? ""))) return String(error.message);
  if (Object.hasOwn(ERRORS, String(error?.code ?? ""))) return String(error.code);
  return null;
}

/**
 * 失敗の文：理由の名前から表の文を選ぶ（DB の日本語の hint は console だけ。11-04g）。
 * op：押した操作（"start"・"extend"・"cancel"）。延長の workshop_input_invalid だけ延長の範囲の文にする。
 * phase：呼んだ RPC が読み込み（"read"）か更新（"update"）か。通信の失敗は、読み込みなら接続の文、更新なら結果が不明の文（前置きなし。決まり 3.7）
 */
export function timerErrorText(error, op = "", phase = "update") {
  const hint = text(error?.hint);
  if (hint) console.info(`DB の hint：${hint}`);
  if (isNetworkFailure(error)) return phase === "read" ? MSG_NETWORK_FAILURE : MSG_UPDATE_RESULT_UNKNOWN;
  const key = timerErrorKey(error);
  if (key === "workshop_input_invalid" && op === "extend") return MSG_EXTEND_INVALID;
  return key ? ERRORS[key] : "タイマーエラーが発生しました。\n［最新にする］を押して再度お試しください。";
}

/** timerErrorText の文に付けるエラーコード（無ければ null。通信の失敗には付けない〔決まり 3.1・11-04g〕。表に無い理由は E-INS-99） */
export function timerErrorCode(error) {
  const key = timerErrorKey(error);
  if (key) return ERROR_CODES[key] ?? null;
  return isNetworkFailure(error) ? null : "E-INS-99";
}
