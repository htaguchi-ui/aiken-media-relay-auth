// 段階の時間（分）の、画面を持たない関数。管理コンソール（段階を編集）と講師ページ（［時間を変える］）の共用。
// 設計 .orchestration/stage-minutes-20261029/DESIGN.md 第 6.1 版 1.2・2.1・2.3・2.4・3 章。
// 分を持つのは Day1・Day2 の段階だけ（ブリッジワークには持たせない）。1 段階 1〜480 分の整数・1 日の合計は 720 分まで（DB が断る）。
// 画面は 360 分（6 時間）を超えたら注意を 1 行出すだけで、保存は止めない。
// RPC の答えの形（3 章）：
//   admin_cohort_stage_minutes・admin_set_cohort_stage_minutes
//     { cohort_id, stages: [{ stage_id, day_kind, seq, minutes }], totals: { day1, day2 } }
//   instructor_stage_minutes・instructor_set_stage_minutes
//     { cohort_id, server_now, period, editable_day, stages, totals,
//       current: { stage_id, counted_from, ends_at, by_times, reason } | null, timer_running }

/** 1 段階の分の範囲（DB の check と同じ） */
export const STAGE_MINUTES_MIN = 1;
export const STAGE_MINUTES_MAX = 480;
/** 1 日の合計の上限（DB が断る） */
export const DAY_MINUTES_MAX = 720;
/** これを超えたら注意を 1 行（保存は止めない） */
export const DAY_MINUTES_WARN = 360;
/** 分を持つ日の種類 */
export const MINUTE_DAY_KINDS = Object.freeze(["day1", "day2"]);

export const MSG_MINUTES_INVALID = `分は ${STAGE_MINUTES_MIN}〜${STAGE_MINUTES_MAX} の整数で入れてください`;
export const MSG_DAY_MINUTES_WARN = "6 時間を超えています";
export const MSG_MINUTES_SAVED = "時間を保存しました。";
export const MSG_MINUTES_SAVE_FAILED = "時間を保存できませんでした。";
export const MSG_MINUTES_LOAD_FAILED = "時間を読み込めません。";
export const MSG_MINUTES_TIMER_RUNNING = "制作時間が動いている間は、AI は制作時間を使います。";
export const MSG_BY_TIMES = "時刻で決めています";
export const MSG_BY_TIMES_TITLE = "分を変えても AI の目安は変わりません";
export const MSG_NO_TARGET = "目安なし";
/** 「目安なし」のホバー（current.reason ごと） */
export const NO_TARGET_TITLES = Object.freeze({
  first_stage: "今日の最初の段階には目安がありません。制作時間を使ってください",
  guide_off: "案内が公開されていないため、AI は目安を使いません",
});

const text = (v) => (typeof v === "string" && v.trim() ? v : null);
const isoMs = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 分の入力を読む（全角の数字も受ける。前後の空白は無視）。
 * 返り値：{ ok: true, minutes: null }（空＝外す）・{ ok: true, minutes: 60 }・{ ok: false, minutes: null }（誤り）
 */
export function parseStageMinutes(value) {
  if (value === null || value === undefined) return { ok: true, minutes: null };
  if (typeof value === "number") return validMinutes(value) ? { ok: true, minutes: value } : { ok: false, minutes: null };
  const s = String(value).trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (s === "") return { ok: true, minutes: null };
  if (!/^\d{1,3}$/.test(s)) return { ok: false, minutes: null };
  const n = Number(s);
  return validMinutes(n) ? { ok: true, minutes: n } : { ok: false, minutes: null };
}

/** 1〜480 の整数か */
export function validMinutes(n) {
  return Number.isSafeInteger(n) && n >= STAGE_MINUTES_MIN && n <= STAGE_MINUTES_MAX;
}

/** 分の表示（「90 分」。分が無ければ空） */
export function formatStageMinutes(minutes) {
  return validMinutes(minutes) ? `${minutes} 分` : "";
}

/**
 * 講師ページの段階の行のクレジットの欄の文。分があれば「90 分 · 500 クレジット」、無ければ creditsLabel のまま
 * （creditsLabel は今の文：「500 クレジット」か、クレジットが null の「—」）
 */
export function stageCreditsText(minutes, creditsLabel) {
  return validMinutes(minutes) ? `${minutes} 分 · ${creditsLabel}` : creditsLabel;
}

/** 分の合計（null・誤りは数えない） */
export function sumMinutes(values) {
  let total = 0;
  for (const v of values ?? []) if (validMinutes(v)) total += v;
  return total;
}

/** 1 日の合計の見た目：{ total, text: "合計 N 分", warn: 注意の文か "" } */
export function dayTotalView(values) {
  const total = sumMinutes(values);
  return { total, text: `合計 ${total} 分`, warn: total > DAY_MINUTES_WARN ? MSG_DAY_MINUTES_WARN : "" };
}

/**
 * 変わった段階だけを、RPC の p_items の形（[{ stage_id, minutes }]。minutes が null なら外す）で集める。
 * before：段階の id → 今の分（Map か、{ id: 分 } の物。無い id は null と同じ）。
 * rows：[{ stageId, minutes }]（minutes は parseStageMinutes の答えの数か null）。id の無い行・同じ id の 2 つ目は送らない
 */
export function collectMinuteChanges(before, rows) {
  const get = (id) => {
    const v = before instanceof Map ? before.get(id) : isObj(before) ? before[id] : undefined;
    return validMinutes(v) ? v : null;
  };
  const seen = new Set();
  const out = [];
  for (const r of rows ?? []) {
    const id = text(r?.stageId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const now = validMinutes(r.minutes) ? r.minutes : null;
    if (now !== get(id)) out.push({ stage_id: id, minutes: now });
  }
  return out;
}

/**
 * 保存のあとの id の結び：段階を入れ替える RPC（admin_replace_day_stages）の戻りの行（順番どおり）と、
 * 送った行（同じ順番）を、順番で結ぶ（名前で結ばない。同じ名前の段階があり得る）。数が合わなければ null（結べない）
 */
export function bindStageIds(sentRows, returnedRows) {
  if (!Array.isArray(sentRows) || !Array.isArray(returnedRows) || sentRows.length !== returnedRows.length) return null;
  const ids = returnedRows.map((r) => text(r?.id) ?? text(r?.stage_id));
  return ids.every(Boolean) ? ids : null;
}

/** 日本時間の時刻（「14:35」）。終わりが数え始めと違う日（日本時間）になるときは「翌 0:30」の形にする */
export function formatTargetClock(endMs, fromMs = endMs) {
  if (!Number.isFinite(endMs)) return "";
  const fmt = (ms) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  const day = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const clock = fmt(endMs);
  return Number.isFinite(fromMs) && day(endMs) !== day(fromMs) ? `翌 ${clock}` : clock;
}

/**
 * 講師ページの窓の、今の段階の行の右の文。current は normalizeInstructorStageMinutes の current（null なら出さない）。
 * minutes は今入っている分（数か null）。返り値：{ text, title }（出さないときは text が ""）。
 * by_times →「時刻で決めています」／counted_from がある →「目安 HH:MM まで」（分が空なら出さない）／どちらも無い →「目安なし」
 */
export function targetView(current, minutes) {
  if (!current) return { text: "", title: "" };
  if (current.byTimes) return { text: MSG_BY_TIMES, title: MSG_BY_TIMES_TITLE };
  if (current.countedFrom !== null) {
    if (!validMinutes(minutes)) return { text: "", title: "" };
    return { text: `目安 ${formatTargetClock(current.countedFrom + minutes * 60_000, current.countedFrom)} まで`, title: "" };
  }
  return { text: MSG_NO_TARGET, title: current.reason && Object.hasOwn(NO_TARGET_TITLES, current.reason) ? NO_TARGET_TITLES[current.reason] : "" };
}

/** 段階の行（stages の 1 項目）。形が違えば null */
function normStageRow(r) {
  if (!isObj(r)) return null;
  const stageId = text(r.stage_id);
  const dayKind = text(r.day_kind);
  if (!stageId || !dayKind) return null;
  if (r.seq !== null && r.seq !== undefined && !Number.isSafeInteger(r.seq)) return null;
  if (r.minutes !== null && r.minutes !== undefined && !validMinutes(r.minutes)) return null;
  return { stageId, dayKind, seq: Number.isSafeInteger(r.seq) ? r.seq : null, minutes: validMinutes(r.minutes) ? r.minutes : null };
}

/**
 * admin_cohort_stage_minutes・admin_set_cohort_stage_minutes の答え。形が違う・回が違うときは null（読めない）。
 * 返り値：{ cohortId, stages: [{ stageId, dayKind, seq, minutes }]（日・順番の順）, byStage: Map（id → 分か null）, totals: { day1, day2 } }
 * totals は stages から数え直す（答えの totals は形だけ確かめる）
 */
export function normalizeStageMinutes(raw, expectedCohortId) {
  if (!isObj(raw) || !text(raw.cohort_id) || raw.cohort_id !== expectedCohortId) return null;
  if (!Array.isArray(raw.stages) || !isObj(raw.totals)) return null;
  const stages = [];
  for (const r of raw.stages) {
    const s = normStageRow(r);
    if (!s) return null;
    stages.push(s);
  }
  const order = (k) => (MINUTE_DAY_KINDS.includes(k) ? MINUTE_DAY_KINDS.indexOf(k) : MINUTE_DAY_KINDS.length);
  stages.sort((a, b) => order(a.dayKind) - order(b.dayKind) || (a.seq ?? 0) - (b.seq ?? 0));
  const byStage = new Map(stages.map((s) => [s.stageId, s.minutes]));
  const totals = Object.fromEntries(MINUTE_DAY_KINDS.map((k) => [k, sumMinutes(stages.filter((s) => s.dayKind === k).map((s) => s.minutes))]));
  return { cohortId: raw.cohort_id, stages, byStage, totals };
}

/**
 * instructor_stage_minutes・instructor_set_stage_minutes の答え。形が違う・回が違うときは null（読めない）。
 * 返り値：normalizeStageMinutes の答え ＋ { serverNow, period, editableDay（"day1" | "day2" | null）,
 *   current: { stageId, countedFrom, endsAt（ミリ秒か null）, byTimes, reason } | null, timerRunning }
 */
export function normalizeInstructorStageMinutes(raw, expectedCohortId) {
  const base = normalizeStageMinutes(raw, expectedCohortId);
  if (!base) return null;
  const serverNow = isoMs(raw.server_now);
  if (serverNow === null || typeof raw.timer_running !== "boolean") return null;
  const editable = raw.editable_day ?? null;
  if (editable !== null && !MINUTE_DAY_KINDS.includes(editable)) return null;
  let current = null;
  if (raw.current !== null && raw.current !== undefined) {
    const c = raw.current;
    if (!isObj(c) || !text(c.stage_id) || typeof c.by_times !== "boolean") return null;
    const countedFrom = c.counted_from === null || c.counted_from === undefined ? null : isoMs(c.counted_from);
    const endsAt = c.ends_at === null || c.ends_at === undefined ? null : isoMs(c.ends_at);
    if ((c.counted_from ?? null) !== null && countedFrom === null) return null;
    if ((c.ends_at ?? null) !== null && endsAt === null) return null;
    if (c.reason !== null && c.reason !== undefined && !text(c.reason)) return null;
    current = { stageId: c.stage_id, countedFrom, endsAt, byTimes: c.by_times, reason: text(c.reason) };
  }
  return { ...base, serverNow, period: text(raw.period), editableDay: editable, current, timerRunning: raw.timer_running };
}

/** 分を入れた段階の数（テンプレートの適用で「未設定に戻る」段階の数。読めていなければ null） */
export function countStagesWithMinutes(normalized) {
  if (!normalized || !Array.isArray(normalized.stages)) return null;
  return normalized.stages.filter((s) => validMinutes(s.minutes)).length;
}

/** その日の段階（seq の順）。講師ページの窓の行 */
export function stagesOfDay(normalized, dayKind) {
  if (!normalized || !dayKind) return [];
  return normalized.stages.filter((s) => s.dayKind === dayKind).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** 保存・読み込みの失敗の文：DB の日本語の hint があればそれ、無ければ fallback */
export function minutesErrorText(error, fallback = MSG_MINUTES_SAVE_FAILED) {
  return text(error?.hint) ?? fallback;
}
