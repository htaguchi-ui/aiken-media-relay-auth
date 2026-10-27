// 講師ページの制作時間のタイマー（KT）の、画面を持たない関数。設計 docs/design-workshop-guide.md 第 1.3.1 版 2.6・4.5。
// RPC の返り値の形は .orchestration/wt/g/kt-timer-rpc-contract.md（G・2026-10-26）。開始・延長・取り消しの可否と回の段階は DB が決める。
// 残りの時間は ends_at と、読んだときの server_now と端末の時計の差で数える（端末の時計がずれていても、サーバーの時刻で数える）。
// 終わったあとの延長は「今から」延ばす（main の決定。DB の stage_timer_extend は greatest(ends_at, now()) ＋ 分）。
import { stageName } from "./stage-lib.js";

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
  return endsAt === null ? `制作時間を ${minutes} 分延ばしました。` : `制作時間を ${minutes} 分延ばしました（${formatClock(endsAt)} まで）。`;
}

/** 始めたあとの知らせ。replaced（置き換えた動いているタイマーの数）が 1 以上ならそう添える */
export function startDoneText(minutes, replaced) {
  const base = `制作時間を ${minutes} 分で始めました。`;
  return Number.isSafeInteger(replaced) && replaced > 0 ? `${base}動いていた制作時間を置き換えました。` : base;
}

/** 札に出す段階の名前（講師ページの「今」の行と同じ書き方） */
export function timerStageLine(status) {
  return status?.stage ? `段階：${stageName(status.stage)}` : "";
}

/**
 * 札の見た目：{ visible, state: "idle" | "running" | "ended", remainingSec, line, stageLine, extendable: [分...], canCancel }。
 * visible は、段階の回の今のワークショップの段階があり（can_start）、回がクローズ済みでないとき。
 * now：端末の時計（Date.now()）。サーバーの時刻に直してから数える
 */
export function timerView(status, now, { closed = false } = {}) {
  const hidden = { visible: false, state: "idle", remainingSec: null, line: "", stageLine: "", extendable: [], canCancel: false };
  if (!status || !status.canStart || !status.stage || closed) return hidden;
  const stageLine = timerStageLine(status);
  const t = status.timer;
  if (!t) return { ...hidden, visible: true, line: "制作時間は始まっていません。", stageLine };
  const serverNow = now + (Number.isFinite(status.clockOffset) ? status.clockOffset : 0);
  const remainingSec = Math.max(0, Math.ceil((t.endsAt - serverNow) / 1000));
  const extendable = TIMER_EXTENDS.filter((m) => t.minutesTotal + m <= TIMER_TOTAL_MAX);
  if (remainingSec <= 0) {
    return { visible: true, state: "ended", remainingSec: 0, line: `制作時間が終わりました（${formatClock(t.endsAt)}）`, stageLine, extendable, canCancel: true };
  }
  const minutes = Math.ceil(remainingSec / 60);
  return {
    visible: true,
    state: "running",
    remainingSec,
    line: `制作時間：残り ${minutes} 分（${formatClock(t.endsAt)} まで）`,
    stageLine,
    extendable,
    canCancel: true,
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
  cohort_closed: "この回はクローズ済みです。制作時間は使えません。",
  stage_mode_off: "この回は段階の回ではないため、制作時間は使えません。",
  stage_outside_course: "この回の期間（Day1〜Day2）の外なので、制作時間を操作できません。",
  timer_bridge: "ブリッジワークの期間には制作時間のタイマーを使いません。",
  timer_no_stage: "今の段階がありません。段階を確かめてください。",
  timer_not_running: "今の段階の制作時間は始まっていません。",
  timer_limit: `制作時間は合計 ${TIMER_TOTAL_MAX} 分までです。`,
  workshop_input_invalid: `制作時間は ${TIMER_MIN}〜${TIMER_MAX} 分で指定してください。`,
  instructor_only: "この回の講師または管理者だけが操作できます。",
};

/**
 * 読み込みの失敗が一時的か。関数が無い（PGRST202）・権限が無い（42501）・DB が断った（P0001）は一時的でない（札を隠す）。
 * それ以外（通信の失敗・時間切れ・5xx など）は一時的とみなし、前に読んだ表示を残して次の読み直しを待つ
 */
export function isTransientTimerError(error) {
  const code = String(error?.code ?? "");
  return !["PGRST202", "42501", "P0001"].includes(code);
}

/** 失敗の文：DB の日本語の hint があればそれを、無ければ印から決めた文を出す */
export function timerErrorText(error) {
  const hint = text(error?.hint);
  if (hint) return hint;
  return ERRORS[error?.message] ?? ERRORS[error?.code] ?? "制作時間の操作を完了できませんでした。最新にしてから、もう一度お試しください。";
}
