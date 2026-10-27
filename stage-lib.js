// セミナーの段階（DB の変更 016。設計 docs/design-seminar-stages.md）の、画面に依存しない処理。
// 講師の画面（instructor.js）と管理コンソール（admin.js）から使う。テストは aiken-media-relay/scripts/stage_lib_test.ts。
// 境界は DB：ここの判定は「押せるか」「先に知らせるか」の目安で、最後に断るのは DB（お金の上限は DB だけが守る）。
//
// ---- 画面が約束ごととして置いている、DB の返し方（DB の担当と照らす。設計書 5.1 に形が無い所は、ここが画面側の前提）----
// cohort_stage_status(p_cohort_id) の jsonb（講師の画面・管理コンソールの回の画面）：
//   { cohort_id, name, credit_mode: "stage"|"day", period: "before"|"day1"|"bridge"|"day2"|"after", server_now: 時刻,
//     stage: 今の段階 | null,                    // { id, day_kind, seq, label, title, credits, entered_at }
//     stages_today: [今日の日の種類の段階（seq 順）],  // 同じ形。講師が移せるのはこの中だけ
//     stages: [回のすべての段階（Day1 → ブリッジワーク → Day2、seq 順）],  // 同じ形。講師の画面のワークショップの一覧（無ければ今日の分だけ）
//     last_move: { entered_at, from_stage_id, to_stage_id, actor, by_email, jobs_since } | null,
//     students: [{ email, display_name, status, stage_used, stage_limit, stage_remaining, day_used, day_limit,
//                  last_used_at, grant_total, instructor_stage_total }],
//     grants: [{ id, email, credits, note, stage_id, created_at, created_by_email, granted_as, revoked_at, is_mine }],
//     limits: { total_limit, instructor_per_grant, instructor_per_student_stage, instructor_per_cohort_day,
//               instructor_cohort_day_total } }
//   欠けている項目は「分からない」として扱い、画面は出さない・「—」にする（判定は DB に任せる）。
// instructor_cohorts() は、担当する回の配列（各要素 { cohort_id（または id）, name, venue_name, day1_date, day2_date, credit_mode }）。
//   `{ cohorts: [...] }` の形でも読む。

import { addDaysToDate, formatCredits, isValidDate, jstDayStart, parseCredits } from "./admin-lib.js";

export const DAY_KINDS = ["day1", "bridge", "day2"];
export const DAY_KIND_LABELS = { day1: "Day1", bridge: "ブリッジワーク", day2: "Day2" };
/** 1 つの段階の上限・1 日の種類の合計の上限・1 日の種類の段階の数（DB の check と同じ） */
export const MAX_STAGE_CREDITS = 10000;
export const MAX_DAY_STAGE_TOTAL = 10000;
export const MAX_STAGES_PER_DAY = 10;
/** 段階を移したあと、前の段階に戻す操作を出しておく時間（ミリ秒） */
export const UNDO_WINDOW_MS = 60 * 1000;

const str = (v) => (typeof v === "string" && v ? v : null);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const toMs = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

// ---- 段階の名前 ----

/** 「ワークショップ 2「台本と生成」」（題名が無ければ名前だけ） */
export function stageName(stage) {
  if (!stage) return "—";
  const label = String(stage.label ?? "").trim();
  const title = String(stage.title ?? "").trim();
  return title ? `${label}「${title}」` : label || "（名前なし）";
}

// ---- 日付と枠の種類の規則（DB の 5.3 の R1〜R3 を、押せるかの目安として写す） ----

/** 日本時間の今日の日付 YYYY-MM-DD */
export function jstDateOf(now = new Date()) {
  return new Date(toMs(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 日の種類が始まる日（その日の 0:00 から。ブリッジワーク期間が無い回の bridge は null） */
export function dayKindStartDate(c, kind) {
  if (!isValidDate(c?.day1_date) || !isValidDate(c?.day2_date) || c.day2_date <= c.day1_date) return null;
  if (kind === "day1") return c.day1_date;
  if (kind === "day2") return c.day2_date;
  const start = addDaysToDate(c.day1_date, 1);
  return start <= addDaysToDate(c.day2_date, -1) ? start : null;
}

/** 日の種類が始まっているか（始まった日の種類は、段階の順番・数を変えられない） */
export function dayKindStarted(c, kind, now = new Date()) {
  const start = dayKindStartDate(c, kind);
  return start ? jstDayStart(start) <= toMs(now) : false;
}

/**
 * 回の日付の欄・枠の種類の変えやすさ。
 * テンプレートを当てたことのある回（stages_applied_at がある）と段階の回は、Day1 が始まったあとは Day1 と枠の種類を変えられず、
 * Day2 は「明日以降の日付どうし」の延期・前倒しだけ（DB の R1・R2・R3）。Day ごとの回は今までどおり自由
 */
export function cohortDateRule(c, now = new Date()) {
  const t = toMs(now);
  const guarded = !!c?.stages_applied_at || c?.credit_mode === "stage";
  const day1Started = isValidDate(c?.day1_date) ? jstDayStart(c.day1_date) <= t : false;
  const day2Started = isValidDate(c?.day2_date) ? jstDayStart(c.day2_date) <= t : false;
  const tomorrow = addDaysToDate(jstDateOf(now), 1);
  const rule = {
    guarded,
    day1Started,
    modeEditable: !day1Started,
    day1Editable: !guarded || !day1Started,
    day2Editable: !guarded || !day2Started,
    minDay1: guarded ? tomorrow : null,
    minDay2: null,
    note: "",
  };
  if (guarded) {
    const day1 = isValidDate(c?.day1_date) ? c.day1_date : tomorrow;
    const afterDay1 = addDaysToDate(day1, 1);
    rule.minDay2 = afterDay1 > tomorrow ? afterDay1 : tomorrow;
    if (day2Started) {
      rule.note = "Day2 まで始まったため、日付は変えられません。";
    } else if (day1Started) {
      rule.note = "Day1 が始まったため、Day1 と枠の種類は変えられません。Day2 は、明日以降の日付どうしで延期・前倒しができます。";
    } else {
      rule.note = "テンプレートを当てた回は、Day1 と Day2 を、まだ始まっていない日付（明日以降）にだけ変えられます。";
    }
  }
  return rule;
}

/**
 * 日付を変える保存の前の確かめ（DB の R1・R2 と同じ。DB の判定が正）。問題があれば理由（日本語）、なければ null。
 * 同じ値の送り直しは通る
 */
export function cohortDateProblem(c, patch, now = new Date()) {
  const rule = cohortDateRule(c, now);
  if (!rule.guarded) return null;
  const t = toMs(now);
  const future = (date) => isValidDate(date) && jstDayStart(date) > t;
  const day1 = "day1_date" in patch ? patch.day1_date : c.day1_date;
  const day2 = "day2_date" in patch ? patch.day2_date : c.day2_date;
  if (day1 !== c.day1_date && !(future(c.day1_date) && future(day1))) {
    return "Day1 は、テンプレートを当てた回では、まだ始まっていない日付（明日以降）どうしでしか変えられません。";
  }
  if (day2 !== c.day2_date) {
    if (!(future(c.day2_date) && future(day2))) {
      return "Day2 は、テンプレートを当てた回では、まだ始まっていない日付（明日以降）どうしでしか変えられません。";
    }
    if (!(day2 > day1)) return "Day2 は Day1 より後の日付にしてください。";
  }
  return null;
}

// ---- 段階の行・テンプレートの入力 ----

/**
 * 段階の行の入力（{ label, title, credits }。文字列）を検査する。kind は日の種類。
 * 返り値：{ rows: [{ label, title, credits }], problems: [日本語の理由] }
 */
export function parseStageRows(kind, rawRows) {
  const where = DAY_KIND_LABELS[kind] ?? kind;
  const rows = [];
  const problems = [];
  const list = Array.isArray(rawRows) ? rawRows : [];
  if (list.length > MAX_STAGES_PER_DAY) problems.push(`${where}の段階は ${MAX_STAGES_PER_DAY} 個までです`);
  if (kind === "bridge" && list.length > 1) problems.push("ブリッジワークの段階は 1 つだけです");
  let total = 0;
  list.forEach((raw, i) => {
    const n = i + 1;
    const label = String(raw?.label ?? "").trim();
    const title = String(raw?.title ?? "").trim();
    if (!label) problems.push(`${where}の ${n} 番目：名前を入力してください`);
    else if (label.length > 40) problems.push(`${where}の ${n} 番目：名前は 40 文字までです`);
    if (title.length > 60) problems.push(`${where}の ${n} 番目：題名は 60 文字までです`);
    const credits = parseCredits(raw?.credits);
    if (credits === null || credits === undefined) {
      problems.push(`${where}の ${n} 番目：クレジットは 0〜${formatCredits(MAX_STAGE_CREDITS)} の整数で入力してください`);
    } else {
      total += credits;
    }
    rows.push({ label, title: title || null, credits: credits ?? null });
  });
  if (total > MAX_DAY_STAGE_TOTAL) {
    problems.push(`${where}の段階のクレジットの合計は ${formatCredits(MAX_DAY_STAGE_TOTAL)} までです（今は ${formatCredits(total)}）`);
  }
  return { rows, problems };
}

/**
 * テンプレートの入力を検査して、admin_save_stage_template に送る値にする。
 * raw：{ name, note, active, days: { day1: [行], bridge: [行], day2: [行] } }（行は { label, title, credits }）
 * 返り値：{ value: { name, note, active, items: [{ day_kind, seq, label, title, credits }] }, problems }
 */
export function parseTemplateForm(raw) {
  const problems = [];
  const name = String(raw?.name ?? "").trim();
  if (!name) problems.push("テンプレートの名前を入力してください");
  else if (name.length > 60) problems.push("テンプレートの名前は 60 文字までです");
  const items = [];
  for (const kind of DAY_KINDS) {
    const parsed = parseStageRows(kind, raw?.days?.[kind]);
    problems.push(...parsed.problems);
    parsed.rows.forEach((r, i) => items.push({ day_kind: kind, seq: i + 1, ...r }));
  }
  if (!items.length) problems.push("段階を 1 つ以上入れてください");
  return {
    value: { name, note: String(raw?.note ?? "").trim() || null, active: raw?.active !== false, items },
    problems,
  };
}

/** テンプレートの items（{ day_kind }）を、回に当てられるか。当てられなければ理由（日本語）、よければ null（DB の確かめが正） */
export function templateApplyProblem(items, cohort) {
  const has = (kind) => (items ?? []).some((i) => i.day_kind === kind);
  if (!has("day1")) return "このテンプレートには Day1 の段階がありません。";
  if (!has("day2")) return "このテンプレートには Day2 の段階がありません。";
  if (dayKindStartDate(cohort, "bridge") && !has("bridge")) {
    return "この回にはブリッジワーク期間があります。ブリッジワークの段階があるテンプレートを選んでください。";
  }
  return null;
}

/** 回の段階の行を、日の種類ごと・seq 順にまとめる。stages は cohort_stages の行 */
export function groupStagesByDay(stages) {
  const out = { day1: [], bridge: [], day2: [] };
  for (const s of stages ?? []) if (out[s.day_kind]) out[s.day_kind].push(s);
  for (const kind of DAY_KINDS) out[kind].sort((a, b) => Number(a.seq) - Number(b.seq));
  return out;
}

/** 日の種類ごとの合計クレジット */
export function dayTotals(stages) {
  const g = groupStagesByDay(stages);
  return Object.fromEntries(DAY_KINDS.map((k) => [k, g[k].reduce((n, s) => n + Number(s.credits ?? 0), 0)]));
}

// ---- cohort_stage_status を、画面が使う形にする ----

function normStage(s) {
  if (!s || typeof s !== "object") return null;
  const id = str(s.id) ?? str(s.stage_id);
  if (!id) return null;
  return {
    id,
    dayKind: str(s.day_kind),
    seq: num(s.seq),
    label: typeof s.label === "string" ? s.label : "",
    title: str(s.title),
    credits: num(s.credits),
    granted: num(s.granted),
    used: num(s.used),
    enteredAt: str(s.entered_at),
    isCurrent: s.is_current === true,
  };
}

function normStudent(s) {
  const used = num(s?.stage_used ?? s?.used);
  const limit = num(s?.stage_limit ?? s?.limit);
  const remaining = num(s?.stage_remaining ?? s?.remaining) ?? (used !== null && limit !== null ? Math.max(limit - used, 0) : null);
  return {
    email: String(s?.email ?? ""),
    name: str(s?.display_name),
    active: s?.status === undefined || s.status === "active",
    used,
    limit,
    remaining,
    dayUsed: num(s?.day_used),
    dayLimit: num(s?.day_limit),
    lastUsedAt: str(s?.last_used_at),
    grantTotal: num(s?.grant_total ?? s?.cohort_grant_total),
    instructorStageTotal: num(s?.instructor_stage_total),
  };
}

function normGrant(g) {
  return {
    id: String(g?.id ?? ""),
    email: String(g?.email ?? ""),
    credits: num(g?.credits) ?? 0,
    note: str(g?.note),
    stageId: str(g?.stage_id),
    createdAt: str(g?.created_at),
    createdByEmail: str(g?.created_by_email),
    grantedAs: str(g?.granted_as),
    revokedAt: str(g?.revoked_at),
    revokedByEmail: str(g?.revoked_by_email),
    revokedNote: str(g?.revoked_note),
    isMine: g?.is_mine === true ? true : g?.is_mine === false ? false : null,
  };
}

/**
 * cohort_stage_status の jsonb を読む。形が違う・欠けている項目は null にして、画面が「分からない」として扱えるようにする。
 * receivedAt は読み込んだ時点の手元の時刻（ミリ秒）。server_now との差を clockOffset に記録し、時間が進んだあとの判定
 * （undoView）で「手元の今の時刻 ＋ 差」をサーバーの今の時刻として使う
 */
export function normalizeStageStatus(raw, receivedAt = Date.now()) {
  const r = raw && typeof raw === "object" ? raw : {};
  const stagesToday = (Array.isArray(r.stages_today) ? r.stages_today : [])
    .map(normStage)
    .filter(Boolean)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  // 回のすべての段階。返ってこない（配列でない）ときは null（分からない。画面は今日の分だけで描く）
  const stagesAll = Array.isArray(r.stages)
    ? r.stages
      .map(normStage)
      .filter((s) => s && DAY_KINDS.includes(s.dayKind))
      .sort((a, b) => DAY_KINDS.indexOf(a.dayKind) - DAY_KINDS.indexOf(b.dayKind) || (a.seq ?? 0) - (b.seq ?? 0))
    : null;
  const fromList = stagesToday.find((s) => s.isCurrent) ?? null;
  const current = normStage(r.stage ?? r.current_stage) ?? fromList;
  const lm = r.last_move && typeof r.last_move === "object" ? r.last_move : null;
  const lim = r.limits && typeof r.limits === "object" ? r.limits : {};
  return {
    cohortId: str(r.cohort_id),
    name: str(r.name),
    creditMode: str(r.credit_mode),
    period: str(r.period),
    serverNow: r.server_now ? toMs(r.server_now) : null,
    clockOffset: r.server_now && Number.isFinite(toMs(r.server_now)) ? toMs(r.server_now) - receivedAt : 0,
    current,
    stagesToday,
    stagesAll,
    lastMove: lm
      ? {
        enteredAt: str(lm.entered_at),
        fromStageId: str(lm.from_stage_id),
        toStageId: str(lm.to_stage_id),
        actor: str(lm.actor),
        byEmail: str(lm.by_email),
        jobsSince: num(lm.jobs_since),
      }
      : null,
    students: (Array.isArray(r.students) ? r.students : []).map(normStudent),
    grants: (Array.isArray(r.grants) ? r.grants : []).map(normGrant),
    limits: {
      total: num(lim.total_limit),
      perGrant: num(lim.instructor_per_grant),
      perStudentStage: num(lim.instructor_per_student_stage),
      perCohortDay: num(lim.instructor_per_cohort_day),
      cohortDayTotal: num(lim.instructor_cohort_day_total),
    },
  };
}

/** instructor_cohorts() の結果（配列、または { cohorts: [...] }）を、{ id, name, venueName, day1Date, day2Date, creditMode, period } の配列にする（period は回の一覧の並べ方に使う） */
export function normalizeInstructorCohorts(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cohorts) ? raw.cohorts : [];
  return list
    .map((c) => ({
      id: str(c?.cohort_id) ?? str(c?.id),
      name: str(c?.name),
      venueName: str(c?.venue_name),
      day1Date: str(c?.day1_date),
      day2Date: str(c?.day2_date),
      creditMode: str(c?.credit_mode),
      period: str(c?.period),
    }))
    .filter((c) => c.id);
}

/** 担当する回の選択肢の表示「06-261120 · 第2回 · 青山オフィス」 */
export function instructorCohortLabel(c) {
  return [c?.id, c?.name, c?.venueName].filter((v) => String(v ?? "").trim()).join(" · ");
}

// ---- ワークショップの一覧（講師の画面。設計 docs/design-instructor-page-v2.md 2.3） ----
// 「済み／今／これから」は位置（今より前・今・今より後）。段階は戻せるので「本当に終わったか」の記録ではない。

const STAGE_STATE_LABELS = { done: "済み", now: "今", next: "これから" };

/** 状態の言葉（"done" | "now" | "next" 以外は空） */
export function stageStateLabel(state) {
  return typeof state === "string" && Object.hasOwn(STAGE_STATE_LABELS, state) ? STAGE_STATE_LABELS[state] : "";
}

/**
 * ワークショップの一覧を日ごとに分け、各段階の状態を決める（normalizeStageStatus の値から）。
 * 返り値：{ fallback, groups: [{ dayKind, label, isToday, open, state, rows: [{ stage, state }] }] }
 *   fallback：回のすべての段階（stagesAll）が無く、今日の分（stagesToday）だけで作った
 *   state："done" | "now" | "next" | null（期間も今の段階も分からないときは null＝言葉を出さない）
 *   open：最初に開く日（「今」を含む日 → 今日の日 → 開催前は Day1・終了後は Day2 → それも無ければ最初の日）
 * 段階の無い日は groups に入れない。
 * stages はあるが今の段階の行が無い（壊れた行が落ちた）とき、今日の分に今の段階があれば、今日の分だけで作る
 * （stages が無いときと同じ縮退。「今」を出すことを、ほかの日の行より優先する）
 */
export function stageTimeline(status) {
  const period = str(status?.period);
  const currentId = status?.current?.id ?? null;
  const today = status?.stagesToday ?? [];
  const all = Array.isArray(status?.stagesAll) ? status.stagesAll : null;
  const nowLost = !!all && !!currentId && !all.some((s) => s.id === currentId) && today.some((s) => s.id === currentId);
  const fallback = !all || nowLost;
  const list = fallback ? today : all;
  const todayKind = DAY_KINDS.includes(period) ? period : null;
  const idx = currentId ? list.findIndex((s) => s.id === currentId) : -1;
  // 今日の分だけのときは、日の種類が欠けた行も今日の日に入れる
  const kindOf = (s) => (DAY_KINDS.includes(s.dayKind) ? s.dayKind : fallback ? todayKind ?? status?.current?.dayKind ?? null : null);
  const rowState = (s, i) => {
    if (idx >= 0) return i < idx ? "done" : i === idx ? "now" : "next";
    if (period === "before") return "next";
    if (period === "after") return "done";
    if (todayKind) return DAY_KINDS.indexOf(kindOf(s)) < DAY_KINDS.indexOf(todayKind) ? "done" : "next";
    return null;
  };
  const rows = list.map((stage, i) => ({ stage, state: rowState(stage, i), kind: kindOf(stage) }));
  const kinds = [...DAY_KINDS, null].filter((k) => rows.some((r) => r.kind === k));
  const groups = kinds.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind).map(({ stage, state }) => ({ stage, state }));
    const states = mine.map((r) => r.state);
    const state = states.every((s) => s === null)
      ? null
      : states.includes("now")
      ? "now"
      : states.every((s) => s === "done")
      ? "done"
      : "next";
    return { dayKind: kind, label: kind ? DAY_KIND_LABELS[kind] : "今日", isToday: !!kind && kind === todayKind, open: false, state, rows: mine };
  });
  const opened = groups.find((g) => g.state === "now") ??
    groups.find((g) => g.isToday) ??
    (period === "before" ? groups.find((g) => g.dayKind === "day1") : period === "after" ? groups.find((g) => g.dayKind === "day2") ?? groups.at(-1) : null) ??
    groups[0];
  if (opened) opened.open = true;
  return { fallback, groups };
}

// ---- 段階を進める・戻す ----

const IN_COURSE = ["day1", "bridge", "day2"];

/** 期間が Day1〜Day2 の外のときの理由。period が null（回の日付が決まっていない）のときは、終わったとは言わない */
function periodOffText(period, texts) {
  return period === "before" ? texts.before : period === "after" ? texts.after : texts.unknown;
}

/**
 * 段階の操作のボタンの状態。移る先は今日の段階の中だけ（DB の stage_not_today）。
 * 返り値：{ current, prev, next, canPrev, canNext, prevWhy, nextWhy, enabled, whyOff }
 */
export function stageMoveView(status) {
  const list = status?.stagesToday ?? [];
  const currentId = status?.current?.id ?? null;
  const idx = currentId ? list.findIndex((s) => s.id === currentId) : -1;
  let whyOff = "";
  if (status?.creditMode !== "stage") whyOff = "この回は、段階ごとの枠になっていません。";
  else if (!IN_COURSE.includes(status?.period)) {
    whyOff = periodOffText(status?.period, {
      before: "Day1 の前は、段階を動かせません。Day1 の 0:00 に、最初の段階に自動で入ります。",
      after: "Day2 が終わったため、段階を動かせません。",
      unknown: "回の日付が決まっていないため、段階を動かせません。",
    });
  } else if (idx < 0) whyOff = "今の段階が分かりません。読み込み直してください。";
  const enabled = !whyOff;
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  return {
    current: idx >= 0 ? list[idx] : status?.current ?? null,
    prev,
    next,
    canPrev: enabled && !!prev,
    canNext: enabled && !!next,
    prevWhy: whyOff || (prev ? "" : "今日の最初の段階です。"),
    nextWhy: whyOff || (next ? "" : "今日の最後の段階です。"),
    enabled,
    whyOff,
  };
}

/** 段階を移す前の確認の文（確認のダイアログの既定は「やめる」） */
export function moveConfirmText(direction, from, to) {
  const verb = direction === "back" ? "戻します" : "進めます";
  return [
    `「${stageName(from)}」から「${stageName(to)}」へ${verb}。`,
    `この回の受講者全員の上限が、「${stageName(to)}」の上限に切り替わります。`,
  ];
}

/**
 * 移した直後の「取り消す（前の段階に戻す）」。60 秒の間、直前の移動が今の段階の入り方のときだけ出す。
 * 返り値：{ available, remainingSec, toStage（戻す先）, jobsSince（その間の生成の件数。分からなければ null） }
 */
export function undoView(status, nowMs = Date.now(), windowMs = UNDO_WINDOW_MS) {
  const none = { available: false, remainingSec: 0, toStage: null, jobsSince: null };
  const lm = status?.lastMove;
  const currentId = status?.current?.id;
  if (!lm?.enteredAt || !lm.fromStageId || !currentId) return none;
  if (lm.toStageId && lm.toStageId !== currentId) return none;
  const from = (status.stagesToday ?? []).find((s) => s.id === lm.fromStageId);
  if (!from || from.id === currentId) return none;
  // 時計のずれに備え、読み込んだときの「サーバーの時刻 − 手元の時刻」の差を足して、サーバーの今の時刻にする（読み込んだ時刻のままにしない）
  const now = nowMs + (status.clockOffset ?? 0);
  const elapsed = now - toMs(lm.enteredAt);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= windowMs) return none;
  return { available: true, remainingSec: Math.ceil((windowMs - elapsed) / 1000), toStage: from, jobsSince: lm.jobsSince };
}

// ---- 一時追加（講師の画面・管理コンソール） ----

/** 追加できる状態か（今の段階があり、Day1〜Day2 の期間内）。できなければ理由（日本語） */
export function grantAvailability(status) {
  if (status?.creditMode !== "stage") return { ok: false, why: "この回は、段階ごとの枠になっていません。" };
  if (!IN_COURSE.includes(status?.period)) {
    return {
      ok: false,
      why: periodOffText(status?.period, {
        before: "Day1 の前は、クレジットを追加できません。",
        after: "Day2 が終わったため、クレジットを追加できません。",
        unknown: "回の日付が決まっていないため、クレジットを追加できません。",
      }),
    };
  }
  if (!status?.current) return { ok: false, why: "今の段階がありません（この日の段階がありません）。クレジットを追加できません。" };
  return { ok: true, why: "" };
}

/** 追加するクレジットの入力を解釈する。1 以上の整数でなければ undefined（上限は DB が断る。ここでは大きすぎる値だけ止める） */
export function parseStageGrantCredits(value, max = 50000) {
  const s = String(value ?? "").trim().replace(/[,，]/g, "");
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= max ? n : undefined;
}

/**
 * 回の合計の上限（T）に収まるか。granted は取り消した追加も数えた合計（G）。収まらなければ理由、
 * 収まる・分からない（limit か granted が null）なら null（分からないときは DB が決める）
 */
export function stageGrantTotalProblem({ granted, limit }, credits) {
  if (limit === null || limit === undefined || granted === null || granted === undefined) return null;
  if (Number(granted) + Number(credits) <= Number(limit)) return null;
  const room = Math.max(0, Number(limit) - Number(granted));
  return `この人への追加は、この回の合計で ${formatCredits(limit)} クレジットまでです（追加済み ${formatCredits(granted)}。取り消した追加も数えます。あと ${formatCredits(room)} まで）。`;
}

/**
 * 講師が追加する前の確かめ（目安。DB の 3 つの上限・回の合計と同じ見方で、先に知らせる）。
 * emails：追加する相手、students：status.students（名前・追加済みの合計を引く）、limits：status.limits、
 * isInstructor：管理者は講師の 3 つの上限の外なので false。status：渡すと、今の段階がない・期間外のときは断る（grantAvailability）。
 * 返り値：{ ok, problems }（problems は日本語。分からない値は確かめない）
 */
export function instructorGrantPlan({ emails, credits, students, limits, isInstructor = true, status = /** @type {any} */ (undefined) }) {
  const problems = [];
  if (status !== undefined) {
    const a = grantAvailability(status);
    if (!a.ok) return { ok: false, problems: [a.why] };
  }
  const list = Array.isArray(emails) ? emails : [];
  const nameOf = (email) => {
    const s = (students ?? []).find((x) => x.email === email);
    return s?.name || email;
  };
  if (!list.length) problems.push("追加する相手を選んでください。");
  if (!(Number.isInteger(credits) && credits >= 1)) problems.push("追加するクレジットは 1 以上の整数で入力してください。");
  if (problems.length) return { ok: false, problems };
  const lim = limits ?? {};
  if (isInstructor) {
    if (lim.perGrant !== null && lim.perGrant !== undefined && credits > lim.perGrant) {
      problems.push(
        lim.perGrant === 0
          ? "今は、講師の追加が 0 に設定されているため、追加できません。"
          : `1 回に追加できるのは ${formatCredits(lim.perGrant)} クレジットまでです。`,
      );
    }
    if (lim.perStudentStage !== null && lim.perStudentStage !== undefined) {
      for (const email of list) {
        const s = (students ?? []).find((x) => x.email === email);
        if (s?.instructorStageTotal !== null && s?.instructorStageTotal !== undefined &&
          s.instructorStageTotal + credits > lim.perStudentStage) {
          problems.push(
            `${nameOf(email)} は、この段階で追加できる上限（${formatCredits(lim.perStudentStage)}）を超えます（追加済み ${
              formatCredits(s.instructorStageTotal)
            }、今回 ${formatCredits(credits)}）。`,
          );
        }
      }
    }
    if (lim.perCohortDay !== null && lim.perCohortDay !== undefined && lim.cohortDayTotal !== null && lim.cohortDayTotal !== undefined) {
      const request = credits * list.length;
      if (lim.cohortDayTotal + request > lim.perCohortDay) {
        problems.push(
          `今日のこの回に追加できる合計の上限（${formatCredits(lim.perCohortDay)}）を超えます（追加済み ${formatCredits(lim.cohortDayTotal)}、今回 ${
            formatCredits(request)
          }）。`,
        );
      }
    }
  }
  for (const email of list) {
    const s = (students ?? []).find((x) => x.email === email);
    const p = stageGrantTotalProblem({ granted: s?.grantTotal ?? null, limit: lim.total ?? null }, credits);
    if (p) problems.push(`${nameOf(email)}：${p}`);
  }
  return { ok: problems.length === 0, problems };
}

/** 追加の確認の文 */
export function grantConfirmText(names, credits, stage) {
  const who = names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} ほか ${names.length - 3} 人`;
  return [
    `${who}（${names.length} 人）に、1 人あたり ${formatCredits(credits)} クレジットを追加します。`,
    `追加は「${stageName(stage)}」の段階に付きます。`,
    "全員分が通るか、1 人でも断られたら全員分とも追加されません。",
  ];
}

/** 取り消しの確認の文（講師の画面） */
export const REVOKE_CONFIRM_TEXT = "取り消すと、この段階の上限からは外れますが、回の合計の枠は戻りません。";

/**
 * 講師の画面で取り消せる追加（今の段階の、まだ取り消していない行）。
 * 講師は「自分が講師として追加した行」（granted_as が instructor）だけ（DB と同じ）。管理者は今の段階のすべて
 */
export function revocableGrants(status, myEmail, isAdmin = false) {
  const currentId = status?.current?.id;
  if (!currentId) return [];
  const me = String(myEmail ?? "").toLowerCase();
  return (status.grants ?? []).filter((g) =>
    g.stageId === currentId && !g.revokedAt &&
    (isAdmin || (g.grantedAs === "instructor" && (g.isMine === true || (g.isMine === null && !!me && g.createdByEmail === me))))
  );
}

/** 今の段階で取り消した追加（取り消しのメモつき。一覧に「取り消し済み」として出す） */
export function revokedGrants(status) {
  const currentId = status?.current?.id;
  if (!currentId) return [];
  return (status.grants ?? []).filter((g) => g.stageId === currentId && !!g.revokedAt);
}

/**
 * 管理コンソールの一時追加の一覧（7.1 の案 B）。rows は credit_grants の行
 * （id, credits, note, created_at, created_by_email, stage_id, revoked_at, granted_as）、stages は回の段階の行。
 * 段階ごとに分け、取り消した行は revoked = true（回の合計には数え続ける。ボタンを出さない）。
 * stage_id が無い行（Day ごと・月額）は plain に分ける。
 * 返り値：{ groups: [{ stageId, heading, rows }], plain: [行], total: { all, active, revoked } }
 */
export function adminGrantGroups(rows, stages) {
  const order = new Map();
  [...(stages ?? [])]
    .sort((a, b) => DAY_KINDS.indexOf(a.day_kind) - DAY_KINDS.indexOf(b.day_kind) || Number(a.seq) - Number(b.seq))
    .forEach((s, i) => order.set(s.id, { i, s }));
  const groups = new Map();
  const plain = [];
  const total = { all: 0, active: 0, revoked: 0 };
  for (const g of rows ?? []) {
    const row = {
      id: g.id,
      credits: Number(g.credits ?? 0),
      note: g.note ?? null,
      createdAt: g.created_at ?? null,
      createdByEmail: g.created_by_email ?? null,
      grantedAs: g.granted_as ?? null,
      revoked: !!g.revoked_at,
      revokedByEmail: g.revoked_by_email ?? null,
      revokedNote: g.revoked_note ?? null,
    };
    if (!g.stage_id) {
      plain.push(row);
      continue;
    }
    total.all += row.credits;
    if (row.revoked) total.revoked += row.credits;
    else total.active += row.credits;
    if (!groups.has(g.stage_id)) {
      const o = order.get(g.stage_id);
      groups.set(g.stage_id, {
        stageId: g.stage_id,
        heading: o ? `${DAY_KIND_LABELS[o.s.day_kind] ?? o.s.day_kind}：${stageName(o.s)}` : "（回に無い段階）",
        index: o ? o.i : Number.MAX_SAFE_INTEGER,
        rows: [],
      });
    }
    groups.get(g.stage_id).rows.push(row);
  }
  return {
    groups: [...groups.values()].sort((a, b) => a.index - b.index).map(({ index: _index, ...g }) => g),
    plain,
    total,
  };
}

/** 一覧の 1 行のボタン：取り消した行は出さず、「取り消し済み」の説明を返す */
export function grantRowAction(row, isStageRow) {
  if (!isStageRow) return { kind: "delete", label: "削除" };
  if (row.revoked) return { kind: "none", label: "取り消し済み（回の合計には数えます）" };
  return { kind: "revoke", label: "取り消す" };
}

/** 回の合計の表示「この回の追加の合計：1,200 / 10,000（取り消した 300 を含む）」。T が分からなければ「/」以降を出さない */
export function grantTotalLine(total, limit) {
  const base = `この回の追加の合計：${formatCredits(total.all)}${limit === null || limit === undefined ? "" : ` / ${formatCredits(limit)}`}`;
  return total.revoked > 0 ? `${base}（取り消した ${formatCredits(total.revoked)} を含む）` : base;
}

// ---- 削除できない理由（DB は外部キーと、段階の回の追加の記録で断る。先に押せなくして理由を出す） ----

/** 段階の記録・段階の回の追加がある回は削除できない。削除できなければ理由、できれば null */
export function cohortDeleteBlock({ memberCount = 0, hasEntries = false, hasGrants = false } = {}) {
  if (Number(memberCount) > 0) return "所属している受講者がいる回は削除できません。先に別の回へ移すか、名簿から外してください。";
  if (hasEntries || hasGrants) {
    return "段階を動かした記録、または段階の回の追加がある回は、記録として残すため削除できません。名前で練習用と分かるようにしてください。";
  }
  return null;
}

/** 段階の回の追加がある受講者は名簿から削除できない。削除できなければ理由、できれば null */
export function memberDeleteBlock({ hasStageGrants = false } = {}) {
  return hasStageGrants
    ? "段階の回の追加があるため、削除できません（追加は記録として残ります）。利用を止めるときは「利用を停止」を使ってください。"
    : null;
}
