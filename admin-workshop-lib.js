// 管理コンソールの［ワークショップの案内］の純粋な部品（docs/design-workshop-guide.md 第 1.3.1 版 3.1・4.2・4.6・6.2、
// .orchestration/workshop-ui-20261028/DESIGN.md 第 I 部〔組 8〕）。画面（admin-workshop.js）と admin.js（適用の確かめ）から使う。
// DOM に触らない。試験：scripts/admin_workshop_lib_test.ts。
// 字数の上限・文の数・content の字数の式の検査は DB（workshop_guide_body_problem）が 1 か所で行う。入力中の欄は数えない（4.6）。
// 例外として、画面が最初のひと言を既定で作るときだけ、作った文の字数・文の数・問いかけの数を DB と同じ規則で数える
// （作れるかを決めるため。正は DB）。ほかに行うのは、入力の形をそろえること・受講者向けの言葉の警告・一覧と割り当ての表示の形・
// 確かめの本文の組み立て（ask() の本文は 6 行まで）。

/** 種類の名前 */
export const KIND_LABELS = { workshop: "ワークショップ", bridge: "ブリッジワーク" };
/** 日の種類の名前 */
export const DAY_LABELS = { day1: "Day1", bridge: "ブリッジワーク", day2: "Day2" };

/** 受講者に届く文で使わない語（6.2）。入っていたら警告する（保存・公開は止めない。DB は断らない） */
export const FORBIDDEN_WORDS = ["課題", "宿題", "締切", "締め切り", "評価", "必須", "カリキュラム"];

/** 項目の名前（警告と画面の見出しで同じ言葉を使う） */
export const FIELD_LABELS = {
  theme: "テーマ",
  why_it_matters: "大切なこと",
  opening: "最初のひと言",
  goal: "目標",
  minimum: "最低限の完成",
  flow: "手順",
  step: "手順の名前",
  first_question: "最初の問いかけ",
  student_decides: "受講者が決めること",
  ai_may_do: "AI が引き受けてよい操作",
  done_when: "完成の目安",
  optional_polish: "任意の仕上げ",
  avoid: "やってはいけないこと",
  coaching_note: "講師から AI への方針",
  materials: "使える素材・道具",
  hints: "ヒント",
  when: "こんなとき",
  say: "こう声をかける",
  finish_minutes: "仕上げに切り替える残り時間（分）",
};

/** 公開の確かめの文（3.4）：lines の 2 行目・11/18 からの注意（warnings）・急ぐときの note */
export const PUBLISH_LINE = "受講者の AI は、次に案内を読み直したときから新しい版を使います。";
export const PUBLISH_LATE_WARNING = "11/18 より後の公開は、田口さんの承認が要ります。";
export const PUBLISH_HURRY_NOTE = "急ぐときは、講師から受講者に「案内を読み直して」と伝えてもらってください。";
/** この日（日本時間）から、公開の確かめに 11/18 の注意を出す */
export const PUBLISH_LATE_FROM = "2026-11-18";

/** 新しい案内の空の形
 * @param {string} kind
 * @returns {Record<string, any>} */
export function emptyGuide(kind) {
  return {
    schema: 1,
    theme: "",
    why_it_matters: "",
    opening: "",
    goal: "",
    minimum: "",
    flow: [{ step: "", first_question: "", student_decides: "", ai_may_do: "" }],
    done_when: [""],
    optional_polish: [],
    avoid: [],
    coaching_note: "",
    materials: "",
    hints: [],
    ...(kind === "workshop" ? { finish_minutes: 20 } : {}),
  };
}

function str(v) {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/** DB の本文（または下書き）を、編集の欄の形にする（足りない欄を空で補う。知らない欄は落とさずに残す） */
/**
 * @param {any} body
 * @param {string} kind
 * @returns {Record<string, any>}
 */
export function toForm(body, kind) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const base = emptyGuide(kind);
  const flow = Array.isArray(b.flow) && b.flow.length
    ? b.flow.map((f) => ({
      step: str(f?.step),
      first_question: str(f?.first_question),
      student_decides: str(f?.student_decides),
      ai_may_do: str(f?.ai_may_do),
    }))
    : base.flow;
  const list = (v) => (Array.isArray(v) ? v.map(str) : []);
  const form = {
    ...b,
    schema: 1,
    theme: str(b.theme),
    why_it_matters: str(b.why_it_matters),
    opening: str(b.opening),
    goal: str(b.goal),
    minimum: str(b.minimum),
    flow,
    done_when: Array.isArray(b.done_when) ? list(b.done_when) : base.done_when,
    optional_polish: list(b.optional_polish),
    avoid: list(b.avoid),
    coaching_note: str(b.coaching_note),
    materials: str(b.materials),
    hints: Array.isArray(b.hints) ? b.hints.map((h) => ({ when: str(h?.when), say: str(h?.say) })) : [],
  };
  if (kind === "workshop") {
    form.finish_minutes = b.finish_minutes === undefined || b.finish_minutes === null ? 20 : b.finish_minutes;
  } else delete form.finish_minutes;
  return form;
}

/**
 * 編集の欄から、保存する本文を作る。前後の空白を除き、空の任意の項目と空の並びの要素を落とす。
 * 手順の行で名前と問いかけの両方が空の行も落とす。必須の項目が空でも落とさない（DB の検査が理由を返す）。
 * 仕上げの分は数にする（数にならなければ文字のまま渡し、DB の検査が断る）。ブリッジワークでは持たない
 */
/**
 * @param {Record<string, any>} form
 * @param {string} kind
 * @returns {Record<string, any>}
 */
export function toBody(form, kind) {
  const t = (v) => str(v).trim();
  const out = { schema: 1 };
  for (const k of ["theme", "why_it_matters", "opening", "goal", "minimum"]) out[k] = t(form[k]);
  out.flow = (form.flow ?? [])
    .map((f) => ({
      step: t(f.step),
      first_question: t(f.first_question),
      student_decides: t(f.student_decides),
      ai_may_do: t(f.ai_may_do),
    }))
    .filter((f) => f.step || f.first_question || f.student_decides || f.ai_may_do)
    .map((f) => {
      const o = { step: f.step, first_question: f.first_question };
      if (f.student_decides) o.student_decides = f.student_decides;
      if (f.ai_may_do) o.ai_may_do = f.ai_may_do;
      return o;
    });
  for (const k of ["done_when", "optional_polish", "avoid"]) {
    const v = (form[k] ?? []).map(t).filter((x) => x);
    if (v.length) out[k] = v;
  }
  for (const k of ["coaching_note", "materials"]) if (t(form[k])) out[k] = t(form[k]);
  const hints = (form.hints ?? []).map((h) => ({ when: t(h.when), say: t(h.say) })).filter((h) => h.when || h.say);
  if (hints.length) out.hints = hints;
  if (kind === "workshop") {
    const raw = t(form.finish_minutes);
    if (raw !== "") {
      const n = Number(raw);
      out.finish_minutes = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw) ? n : raw;
    }
  }
  return out;
}

/** 本文の中の受講者向けでない語。[{ field, label, word }]（同じ欄の同じ語は 1 回） */
export function forbiddenWordsIn(body) {
  const found = [];
  const seen = new Set();
  const check = (field, label, text) => {
    for (const w of FORBIDDEN_WORDS) {
      if (str(text).includes(w) && !seen.has(`${field}|${w}`)) {
        seen.add(`${field}|${w}`);
        found.push({ field, label, word: w });
      }
    }
  };
  const b = body ?? {};
  for (const k of ["theme", "why_it_matters", "opening", "goal", "minimum", "coaching_note", "materials"]) {
    check(k, FIELD_LABELS[k], b[k]);
  }
  (b.flow ?? []).forEach((f, i) => {
    for (const k of ["step", "first_question", "student_decides", "ai_may_do"]) {
      check(`flow.${i}.${k}`, `手順 ${i + 1} の${FIELD_LABELS[k]}`, f?.[k]);
    }
  });
  for (const k of ["done_when", "optional_polish", "avoid"]) {
    (b[k] ?? []).forEach((x, i) => check(`${k}.${i}`, `${FIELD_LABELS[k]} ${i + 1}`, x));
  }
  (b.hints ?? []).forEach((h, i) => {
    check(`hints.${i}.when`, `ヒント ${i + 1} の${FIELD_LABELS.when}`, h?.when);
    check(`hints.${i}.say`, `ヒント ${i + 1} の${FIELD_LABELS.say}`, h?.say);
  });
  return found;
}

/** 警告の文（1 行ずつ） */
export function forbiddenWarnings(body) {
  return forbiddenWordsIn(body).map((f) =>
    `「${f.label}」に「${f.word}」があります。受講者に届く文では使わない言葉です（目標・完成の目安・受け付け・制作時間などに言い換えてください）。`
  );
}

/** 一覧（［案内の一覧］）の 1 行の表示。公開の札は guideState と同じ言葉（3.6・3.8）。割り当ての数（assignment_count）は
 * 外れた行も数えるので使わない（使っている所は usedIn）
 * @param {any} g */
export function guideListRow(g) {
  return {
    id: g.id,
    name: str(g.name),
    kind: KIND_LABELS[g.kind] ?? str(g.kind),
    state: guideState({ guide_id: g.id, guide_kind: g.kind, guide_active: g.active, published_version: g.published_version }, {
      pending: !!g.has_pending_draft,
      via: g.last_published_via,
    }).text,
    active: g.active !== false,
  };
}

/** 段階の名前（「ワークショップ 2「題」」） */
export function stageName(s) {
  return `${str(s.label)}${s.title ? `「${s.title}」` : ""}`;
}

/** 段階に割り当てられる案内（種類と日の種類が合うものだけ。無効にした案内も選べるが、名前に印を付ける）
 * @param {string} dayKind
 * @param {any[] | null | undefined} guides
 * @returns {{ id: string, label: string }[]} */
export function guideOptionsFor(dayKind, guides) {
  const kind = dayKind === "bridge" ? "bridge" : "workshop";
  return (guides ?? [])
    .filter((g) => g.kind === kind)
    .map((g) => ({
      id: g.id,
      label: `${str(g.name)}${g.published_version == null ? "（まだ公開していない）" : ""}${
        g.active === false ? "（無効）" : ""
      }`,
    }));
}

/** 時刻の欄（"HH:MM" か空）を DB の値（"HH:MM" か null）にする。読めなければ undefined */
export function timeValue(v) {
  const s = str(v).trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return undefined;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** DB の時刻（"10:00:00" など）を欄の値（"10:00"）にする */
export function timeField(v) {
  const s = str(v);
  return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : "";
}

/**
 * 割り当ての 1 行を保存できるか。返り：{ ok: true, args } か { ok: false, message }
 * ワークショップの時刻表は両方か両方空・始まりが終わりより前。ブリッジワークは時刻表を持たない
 */
export function assignmentArgs(cohortId, stage, guideId, start, end) {
  const gid = str(guideId) || null;
  if (stage.day_kind === "bridge") {
    return {
      ok: true,
      args: {
        p_cohort_id: cohortId,
        p_stage_id: stage.stage_id,
        p_guide_id: gid,
        p_planned_start: null,
        p_planned_end: null,
      },
    };
  }
  const s = timeValue(start), e = timeValue(end);
  if (s === undefined || e === undefined) return { ok: false, message: "時刻は 10:00 の形で入れてください。" };
  if ((s === null) !== (e === null)) {
    return {
      ok: false,
      message: "時刻表の目安は、始まりと終わりの両方を入れてください（入れないときは両方とも空に）。",
    };
  }
  if (s !== null && s >= e) return { ok: false, message: "時刻表の目安は、始まりを終わりより前にしてください。" };
  if (!gid && s !== null) return { ok: false, message: "時刻表の目安は、案内を選んだ段階にだけ入れられます。" };
  return {
    ok: true,
    args: { p_cohort_id: cohortId, p_stage_id: stage.stage_id, p_guide_id: gid, p_planned_start: s, p_planned_end: e },
  };
}

/** DB の誤りを画面の文にする（hint は日本語の理由。無ければ形で決めた文） */
export function explainError(error) {
  if (!error) return "";
  const msg = str(error.message);
  if (error.code === "42501" || msg === "admin_only") {
    return "管理者の権限がありません。管理コンソールにログインし直してください。";
  }
  if (error.code === "PGRST202") {
    return "この画面に要るサーバー側の準備がまだできていません（管理者に知らせてください）。";
  }
  if (error.hint) return str(error.hint);
  if (msg === "guide_draft_conflict") {
    return "ほかの操作で下書きが変わりました。読み直してから、もう一度保存してください。";
  }
  return `うまくいきませんでした（${msg || "理由不明"}）。`;
}

/** "2026-11-20" → "11/20"（読めなければそのまま） */
export function monthDay(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(str(date));
  return m ? `${Number(m[1])}/${Number(m[2])}` : str(date);
}

/** 回の短い名前（「第2回」。名前が無ければ id） */
export function cohortShort(c) {
  return str(c?.name).trim() || str(c?.id);
}

/** 回の選択肢（新しい Day1 の順）。表示は「第2回（11/20・11/27）」
 * @param {any[] | null | undefined} cohorts
 * @returns {{ id: string, label: string }[]} */
export function cohortOptions(cohorts) {
  return [...(cohorts ?? [])]
    .sort((a, b) => str(b.day1_date).localeCompare(str(a.day1_date)) || str(a.id).localeCompare(str(b.id)))
    .map((c) => ({ id: c.id, label: `${cohortShort(c)}（${monthDay(c.day1_date)}・${monthDay(c.day2_date)}）` }));
}

/** 日本時間の今日（"YYYY-MM-DD"） */
export function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 窓を開いたときに選ぶ回：今日から見て次に終わる回（Day2 が今日以後で一番早い）。無ければ一番新しい Day1 の回
 * @param {any[] | null | undefined} cohorts
 * @param {string} [today]
 * @returns {string} */
export function defaultCohortId(cohorts, today = todayJst()) {
  const list = [...(cohorts ?? [])];
  const end = (c) => str(c.day2_date || c.day1_date);
  const next = list
    .filter((c) => end(c) >= today)
    .sort((a, b) => end(a).localeCompare(end(b)) || str(a.id).localeCompare(str(b.id)))[0];
  return next?.id ?? cohortOptions(list)[0]?.id ?? "";
}

/** 研修中の回か（admin_cohorts の current_period。3.4） */
export function inTraining(c) {
  return ["day1", "bridge", "day2"].includes(str(c?.current_period));
}

// ---- 字数・文の数・問いかけの数（DB の char_length・workshop_text_sentences・workshop_text_questions と同じ規則） ----

const trimSpaces = (s) => str(s).replace(/^[ 　]+|[ 　]+$/g, "");

/** 字数（コードポイントの数。DB の char_length と同じ。s.length は UTF-16 の数なので使わない） */
export function charCount(s) {
  return [...str(s)].length;
}
/** 文の数：[。？！?!]+ で区切り、前後の半角・全角の空白を除いて空でない区切りの数 */
export function sentenceCount(s) {
  return str(s).split(/[。？！?!]+/).filter((x) => trimSpaces(x) !== "").length;
}
/** 問いかけの数（「？」と半角の ?） */
export function questionCount(s) {
  return (str(s).match(/[？?]/g) ?? []).length;
}

/** 最初のひと言の上限（DB と同じ） */
export const OPENING_MAX = 80;

/**
 * 最初のひと言の既定（D1）：「{大切なこと}まずは「{手順 1 の名前}」から、{手順 1 の最初の問いかけ}」。
 * 大切なことの終わりが文の区切りでなければ「。」を足す（2 つの文がつながらないように）。どれかが空なら作らない（""）。
 * 手順 1 は、入力のある最初の手順（保存のときに空の行は落ちるので、保存した本文の手順 1 と同じ）
 * @param {any} form
 * @returns {string}
 */
export function composeOpening(form) {
  const why = str(form?.why_it_matters).trim();
  const f = (form?.flow ?? []).find((/** @type {any} */ x) =>
    str(x?.step).trim() || str(x?.first_question).trim() || str(x?.student_decides).trim() || str(x?.ai_may_do).trim()
  );
  const step = str(f?.step).trim();
  const q = str(f?.first_question).trim();
  if (!why || !step || !q) return "";
  return `${why}${/[。？！?!]$/.test(why) ? "" : "。"}まずは「${step}」から、${q}`;
}

/** 最初のひと言が DB の決まり（80 字・2 文・問いかけ 1 つ）に収まるか。返り：{ ok, reason }（reason は欄の下の 1 行） */
export function openingFits(text) {
  const t = str(text).trim();
  if (charCount(t) > OPENING_MAX) return { ok: false, reason: "80 字を超えています。短くしてください" };
  if (sentenceCount(t) > 2) return { ok: false, reason: "2 文までにしてください" };
  if (questionCount(t) > 1) return { ok: false, reason: "問いかけは 1 つにしてください" };
  return { ok: true, reason: "" };
}

/** 読み込んだ本文の最初のひと言が「既定のまま」か（空か、既定と同じ。画面だけの判定。DB に印は持たない） */
export function openingIsDefault(form) {
  const o = str(form?.opening).trim();
  return o === "" || o === composeOpening(form);
}

/** 保存の前に既定を埋めた欄（toBody の前に通す。openingAuto なら最初のひと言を既定にする。toBody の形は変えない）
 * @param {Record<string, any>} form
 * @param {{ openingAuto: boolean }} o
 * @returns {Record<string, any>} */
export function withDefaults(form, { openingAuto }) {
  return openingAuto ? { ...form, opening: composeOpening(form) } : form;
}

// ---- 必ず書く欄（D1：テーマ・大切なこと・目標・最低限の完成・手順） ----

export const REQUIRED_KEYS = ["theme", "why_it_matters", "goal", "minimum"];

/**
 * 空の必須の欄。返り：[{ key, label }]。key は欄の印（"theme"・"flow.0.step"・"opening" など）。
 * 手順は、入力のある行の名前と問いかけ（入力のある行が無ければ 1 つ目の行）。最初のひと言は、作った文・書いた文が
 * 決まりに収まらないときに 1 か所
 * @param {any} form
 * @param {{ openingAuto?: boolean }} [o]
 * @returns {{ key: string, label: string }[]}
 */
export function missingRequired(form, { openingAuto = true } = {}) {
  /** @type {{ key: string, label: string }[]} */
  const out = [];
  const blank = (/** @type {any} */ v) => trimSpaces(v) === "";
  for (const k of REQUIRED_KEYS) if (blank(form?.[k])) out.push({ key: k, label: /** @type {any} */ (FIELD_LABELS)[k] });
  /** @type {any[]} */
  const flow = form?.flow ?? [];
  const used = flow
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !blank(f?.step) || !blank(f?.first_question) || !blank(f?.student_decides) || !blank(f?.ai_may_do));
  const rows = used.length ? used : [{ f: flow[0] ?? {}, i: 0 }];
  for (const { f, i } of rows) {
    if (blank(f?.step)) out.push({ key: `flow.${i}.step`, label: `手順 ${i + 1} の名前` });
    if (blank(f?.first_question)) out.push({ key: `flow.${i}.first_question`, label: `手順 ${i + 1} の最初の問いかけ` });
  }
  const opening = openingAuto ? composeOpening(form) : str(form?.opening).trim();
  if (opening && !openingFits(opening).ok) out.push({ key: "opening", label: FIELD_LABELS.opening });
  return out;
}

// ---- 段階の名前 ----

/** 段階の短い名前（「Day1 WS2」・「ブリッジワーク」） */
export function stageShort(s) {
  const label = str(s?.label).trim();
  if (s?.day_kind === "bridge") return label && label !== DAY_LABELS.bridge ? `${DAY_LABELS.bridge} ${label}` : DAY_LABELS.bridge;
  const day = /** @type {any} */ (DAY_LABELS)[s?.day_kind] ?? str(s?.day_kind);
  const short = label.replace(/^ワークショップ\s*/, "WS");
  return `${day} ${short}`.trim();
}

/** 段階の行に出す名前（「Day1 WS2「台本と生成」」） */
export function stageRowName(s) {
  return `${stageShort(s)}${s?.title ? `「${str(s.title)}」` : ""}`;
}

// ---- 管理用の名前の既定（2.2） ----

export const NAME_MAX = 60;

/** n 字（コードポイント）に収める。切ったら終わりを「…」に */
function cut(s, n) {
  const cs = [...s];
  return cs.length <= n ? s : `${cs.slice(0, Math.max(0, n - 1)).join("")}…`;
}

/**
 * 管理用の名前の既定。stage があれば「{日の名前} {段階の名前}「{題名}」」（題名が無ければ括弧ごと省く）、
 * 無ければ「新しい案内（10/28）」（作った日）。読み込んだ一覧の名前と重なれば「（2）」「（3）」…を足す。
 * 番号を足しても 60 字に収まるように本体を先に切る（切ったら本体の終わりを「…」に）
 * @param {{ stage?: any, names?: string[], now?: number }} [o]
 * @returns {string}
 */
export function deriveName({ stage = null, names = [], now = Date.now() } = {}) {
  let base;
  if (stage) {
    const day = /** @type {any} */ (DAY_LABELS)[stage.day_kind] ?? "";
    const label = str(stage.label).trim();
    const head = day && label.startsWith(day) ? label : `${day} ${label}`.trim();
    base = `${head}${stage.title ? `「${str(stage.title).trim()}」` : ""}`;
  } else {
    base = `新しい案内（${monthDay(todayJst(now))}）`;
  }
  const taken = new Set((names ?? []).map((n) => str(n).trim()));
  const first = cut(base, NAME_MAX);
  if (!taken.has(first)) return first;
  for (let i = 2; i < 1000; i++) {
    const suffix = `（${i}）`;
    const name = `${cut(base, NAME_MAX - charCount(suffix))}${suffix}`;
    if (!taken.has(name)) return name;
  }
  return first;
}

// ---- 公開の札（3.8。DB の workshop_now の判定のうち、画面で見える物を同じ順で） ----

/**
 * row：{ guide_id, guide_kind, guide_active, published_version, day_kind? }。
 * opts：creditMode（回の枠。分からなければ undefined）・pending（直しかけ）・via（最後の公開の経路）。
 * 返り：{ key, text, tone }（tone は ok・warn・muted）。止めているかを未公開より先に見る（DB と同じ）
 * @param {any} row
 * @param {{ creditMode?: string|null, pending?: boolean, via?: string|null }} [o]
 * @returns {{ key: string, text: string, tone: string }}
 */
export function guideState(row, { creditMode = undefined, pending = false, via = null } = {}) {
  if (creditMode !== undefined && creditMode !== null && creditMode !== "stage") return { key: "not_stage", text: "出ない", tone: "warn" };
  if (!row?.guide_id) return { key: "none", text: "—", tone: "muted" };
  if (row.day_kind && row.guide_kind && (row.day_kind === "bridge") !== (row.guide_kind === "bridge")) {
    return { key: "kind", text: "出ない 種類が違う", tone: "warn" };
  }
  if (row.guide_active === false) return { key: "inactive", text: "止めている", tone: "warn" };
  if (row.published_version === null || row.published_version === undefined) return { key: "unpublished", text: "未公開", tone: "warn" };
  return {
    key: pending ? "pending" : "published",
    text: `公開中 版 ${row.published_version}${pending ? "・直しかけ" : ""}${via === "ops_script" ? "（手順書で公開）" : ""}`,
    tone: "ok",
  };
}

// ---- 使っている所（3.3。終わっていない回の割り当て。外れた行は数えない） ----

/**
 * guideId を付けている段階。assignByCohort：回の id → admin_cohort_stage_guides の返り、cohorts：admin_cohorts の行、
 * frames：回の id → { credit_mode }（読めなければ null）。返り：[{ cohortId, cohortName, label, training, hidden }]
 * （Day1 の古い順・段階の順）。templates（組 8b）を渡すと、既定にしているテンプレートを後ろに足す（{ template: true }。
 * matches_item が真の既定だけ。1 つのテンプレートは 1 回）。公開・止める確かめには渡さない（回に付くまで受講者に効かないため。3.4）
 * @param {string|null|undefined} guideId
 * @param {Map<string, any>|null|undefined} assignByCohort
 * @param {any[]|null|undefined} cohorts
 * @param {Map<string, any>|null} [frames]
 * @param {{ defaults: any[]|null, names: Map<string, string>|null }|null} [templates]
 */
export function usedIn(guideId, assignByCohort, cohorts, frames = null, templates = null) {
  /** @type {{ cohortId: string, cohortName: string, label: string, training: boolean, hidden: boolean, template?: boolean }[]} */
  const out = [];
  if (!guideId) return out;
  const sorted = [...(cohorts ?? [])].sort((a, b) =>
    str(a.day1_date).localeCompare(str(b.day1_date)) || str(a.id).localeCompare(str(b.id))
  );
  for (const c of sorted) {
    if (str(c.current_period) === "after") continue;
    const a = assignByCohort?.get(c.id);
    if (!a) continue;
    const mode = frames?.get(c.id)?.credit_mode;
    for (const s of a.stages ?? []) {
      if (s.guide_id !== guideId) continue;
      out.push({
        cohortId: c.id,
        cohortName: cohortShort(c),
        label: `${cohortShort(c)} ${stageShort(s)}`,
        training: inTraining(c),
        hidden: mode !== undefined && mode !== null && mode !== "stage",
      });
    }
  }
  if (templates?.defaults) {
    const seen = new Set();
    for (const d of templates.defaults) {
      if (d?.guide_id !== guideId || d.matches_item !== true || seen.has(d.template_id)) continue;
      seen.add(d.template_id);
      const name = templates.names?.get(d.template_id);
      out.push({ cohortId: "", cohortName: "", label: `テンプレート「${str(name) || "名前なし"}」`, training: false, hidden: false, template: true });
    }
  }
  return out;
}

/** 使っている所の 1 行（3 か所を超えるときは「A ほか N か所」。無ければ「まだどの段階にも付いていません。」） */
export function usedInText(list) {
  const items = (list ?? []).map((/** @type {any} */ u) => `${u.label}${u.hidden ? "（出ない）" : ""}`);
  if (!items.length) return "まだどの段階にも付いていません。";
  if (items.length > 3) return `使っている所：${items[0]} ほか ${items.length - 1} か所`;
  return `使っている所：${items.join("・")}`;
}

// ---- 確かめの本文（ask() の detail は畳まれずに見えるので、どの確かめも本文 6 行まで。3.4） ----

/** 本文の行の上限（11/18 の注意の warnings は別に 1 つ足してよい） */
export const ASK_LIMITS = { lines: 3, warnings: 1, detail: 2, note: 1, total: 6 };

/** ask() の本文の行の数（title とボタンは数えない） */
export function askRows(spec) {
  return (spec.lines?.length ?? 0) + (spec.warnings?.length ?? 0) + (spec.detail?.length ?? 0) + (spec.note ? 1 : 0);
}

/** 公開の確かめ（S3）。used：usedIn の返り、today：日本時間の今日
 * @param {{ name: string, used?: any[], today?: string }} o */
export function publishAsk({ name, used = [], today = todayJst() }) {
  const training = [...new Set(used.filter((u) => u.training && !u.hidden).map((u) => u.cohortName))];
  /** @type {string[]} */
  const warnings = [];
  if (training.length) warnings.push(`研修中の回（${training.join("・")}）の受講者にも、すぐ効きます。`);
  if (today >= PUBLISH_LATE_FROM) warnings.push(PUBLISH_LATE_WARNING);
  return {
    title: `「${str(name)}」を公開しますか？`,
    lines: [usedInText(used), PUBLISH_LINE],
    warnings,
    detail: /** @type {string[]} */ ([]),
    note: PUBLISH_HURRY_NOTE,
    okLabel: "公開する",
    kind: "primary",
  };
}

/** 案内を止める・再開する確かめ（3.8）。active：今が有効か（真なら止める確かめ）
 * @param {{ name: string, used?: any[], active: boolean }} o */
export function activeAsk({ name, used = [], active }) {
  const where = used.length ? usedInText(used).replace(/^使っている所：/, "") : "";
  const line = active
    ? where ? `使っている所（${where}）の受講者の AI は、今から案内を使わなくなります。` : "まだどの段階にも付いていないので、受講者には変わりません。"
    : where ? `使っている所（${where}）の受講者の AI は、今から公開した版の案内を使います。` : "まだどの段階にも付いていません。";
  return {
    title: active ? `「${str(name)}」を止めますか？` : `「${str(name)}」を再開しますか？`,
    lines: [line],
    warnings: /** @type {string[]} */ ([]),
    detail: /** @type {string[]} */ ([]),
    note: "編集中の入力は送りません（保存した下書きのまま、止める・再開するだけです）。",
    okLabel: active ? "止める" : "再開する",
    kind: active ? "danger" : "primary",
  };
}

function timeRange(s) {
  const a = timeField(s?.planned_start), b = timeField(s?.planned_end);
  return a && b ? `${a}〜${b}` : "";
}

/**
 * テンプレートの適用で外れる案内（3.5。純粋な関数）。stages：admin_cohort_stage_guides の stages（外れた行〔orphans〕は渡さない。
 * もう受講者に出ていない）。割り当ての行がある段階を数える（時刻は行の列なので、行と一緒に外れる）。並びは日の種類と順番の順。
 * 返り：{ count, detail }（detail は ask() の detail。L=1 は 1 項目、2 は 2 項目、3 以上は 1 項目目と「ほか R か所」）
 * @param {any[]|null|undefined} stages
 * @returns {{ count: number, detail: string[] }}
 */
export function planApplyLoss(stages) {
  /** @type {Record<string, number>} */
  const order = { day1: 1, bridge: 2, day2: 3 };
  const hit = [...(stages ?? [])]
    .filter((s) => s?.guide_id)
    .sort((a, b) => (order[a.day_kind] ?? 9) - (order[b.day_kind] ?? 9) || Number(a.seq ?? 0) - Number(b.seq ?? 0));
  const item = (/** @type {any} */ s) => `${stageShort(s)}：「${str(s.guide_name)}」${timeRange(s)}`;
  const detail = hit.length >= 3
    ? [item(hit[0]), `ほか ${hit.length - 1} か所（［ワークショップの案内］で確かめられます）`]
    : hit.map(item);
  return { count: hit.length, detail };
}

/**
 * 適用の確かめ（3.5 の組 8 の形）。hasStages：今この回に段階があるか、already：今が段階ごとの枠か、loss：planApplyLoss の返り。
 * 「Day ごとの枠に戻す」の文は、段階の無い回への初めての適用だけに出す
 * @param {{ cohortName: string, templateName: string, memberCount?: number, already: boolean, hasStages: boolean,
 *   loss: { count: number, detail: string[] } }} o
 */
export function applyAsk({ cohortName, templateName, memberCount = 0, already, hasStages, loss }) {
  /** @type {string[]} */
  const lines = [];
  const first = !already && !hasStages;
  if (first) lines.push("この回の枠が、Day ごとではなく、ワークショップごとの段階になります。");
  else if (already) lines.push("段階を全部入れ替えます（名前・クレジットの変更は消えます）。");
  else lines.push("この回の枠が段階ごとになり、残っていた段階は全部入れ替わります（名前・クレジットの変更は消えます）。");
  if (Number(memberCount) > 0) lines.push(`所属している受講者 ${Number(memberCount)} 人全員に効きます。`);
  const L = first ? 0 : loss?.count ?? 0;
  return {
    title: `${str(cohortName)} に「${str(templateName)}」を適用しますか？`,
    lines,
    warnings: L > 0 ? [`この回で付けた案内 ${L} か所（予定の時刻を含む）は外れます。自動では付け直しません。`] : [],
    detail: L > 0 ? loss.detail : [],
    note: first
      ? "Day1 が始まる前なら、「Day ごとの枠に戻す」で戻せます。始まったあとは戻せません。"
      : L > 0
      ? "適用のあと、［ワークショップの案内］の［回ごと］で付け直してください。"
      : null,
    okLabel: "適用する",
    kind: "primary",
  };
}

/** 適用の結果の文
 * @param {{ cohortName: string, templateName: string, lost?: number }} o */
export function applyResultText({ cohortName, templateName, lost = 0 }) {
  return `${str(cohortName)} にテンプレート「${str(templateName)}」を適用しました。${
    lost > 0 ? `外れた案内 ${lost} か所は、［ワークショップの案内］で付け直してください。` : ""
  }`;
}

/** 段階の編集で、消す段階に付いた案内の 1 行（無ければ null）。removedIds：消す段階の id、stages：admin_cohort_stage_guides の stages
 * @param {string[]} removedIds
 * @param {any[]|null|undefined} stages */
export function stageRemovalLine(removedIds, stages) {
  const ids = new Set(removedIds ?? []);
  const hit = (stages ?? []).filter((s) => s?.guide_id && ids.has(s.stage_id));
  if (!hit.length) return null;
  return `消す段階に付けた案内 ${hit.length} か所（${hit.map((s) => stageShort(s)).join("・")}）は外れます。`;
}

/** まとめて保存の結果の文 */
export function bulkSaveText(ok, ng) {
  if (!ng) return `${ok} か所を保存しました。`;
  if (!ok) return `${ng} か所は保存できませんでした（下の行）。`;
  return `${ok} か所を保存し、${ng} か所は保存できませんでした（下の行）。`;
}

// ---- DB の理由と画面の欄の対応（3.9 の表） ----

/** @type {[string, string][]} */
const STEP_FIELDS = [
  ["の名前", "step"],
  ["の最初の問いかけ", "first_question"],
  ["の受講者が決めること", "student_decides"],
  ["の AI が引き受けてよい操作", "ai_may_do"],
];
/** @type {[string, string][]} */
const DETAIL_FIELDS = [
  ["完成の目安", "done_when"],
  ["任意の仕上げ", "optional_polish"],
  ["やってはいけないこと", "avoid"],
  ["講師から AI への方針", "coaching_note"],
  ["使える素材・道具", "materials"],
  ["ヒント", "hints"],
  ["仕上げに切り替える残り時間", "finish_minutes"],
];

/**
 * DB の検査の理由の文（save の problem・公開の hint）を、画面の欄に結ぶ。返り：{ area, key }
 *   area：field（必ず書く欄・手順の名前と問いかけ）・step（手順の「▸」の中）・opening・details（「詳しく」の中）・name（見出しの名前）・band（帯）
 * field（save の誤りの detail.field）が分かれば先に見る
 * @param {string|null|undefined} text
 * @param {string|null} [field]
 * @returns {{ area: string, key: string }}
 */
export function problemTarget(text, field = null) {
  if (field === "name") return { area: "name", key: "name" };
  if (field === "note") return { area: "details", key: "note" };
  if (field === "active") return { area: "band", key: "active" };
  const t = str(text);
  if (!t.startsWith("「")) return { area: "band", key: "" };
  const body = t.slice(1);
  /** @type {[string, string][]} */
  const main = [["テーマ", "theme"], ["大切なこと", "why_it_matters"], ["目標", "goal"], ["最低限の完成", "minimum"]];
  for (const [label, key] of main) if (body.startsWith(`${label}」`)) return { area: "field", key };
  if (body.startsWith("最初のひと言」")) return { area: "opening", key: "opening" };
  if (body.startsWith("手順」")) return { area: "field", key: "flow.0.step" };
  const m = /^手順 (\d+) /.exec(body);
  if (m) {
    const i = Number(m[1]) - 1;
    const rest = body.slice(m[0].length);
    for (const [suffix, key] of STEP_FIELDS) {
      if (rest.startsWith(`${suffix}」`)) {
        return { area: key === "step" || key === "first_question" ? "field" : "step", key: `flow.${i}.${key}` };
      }
    }
  }
  for (const [label, key] of DETAIL_FIELDS) if (body.startsWith(label)) return { area: "details", key };
  return { area: "band", key: "" };
}

/** DB の誤りの detail（JSON の文字）の中身。読めなければ null */
function errorDetail(error) {
  try {
    const d = error?.detail ?? error?.details;
    return typeof d === "string" ? JSON.parse(d) : d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

/** save の誤り（workshop_input_invalid）の detail.field。読めなければ null */
export function errorField(error) {
  return errorDetail(error)?.field ?? null;
}

/** 名前の誤りの文（3.9 の表） */
export function nameErrorText(error) {
  return errorDetail(error)?.reason === "duplicate"
    ? "同じ名前の案内があります。［名前を変える］で変えてください。"
    : "名前が長すぎます";
}

// ---- 組 8b：テンプレートの既定の案内（.orchestration/workshop-ui-20261028/DESIGN.md 第 II 部 6.4・6.5・8.1〜8.5） ----

/** 組 8b の新しい関数の名前。「関数が無い」の判定は、呼んだ関数ごとにその名前で行う（4 つは互いに部分の文字列にならない。8.5） */
export const TPL_FN = {
  list: "admin_template_guides_list",
  applied: "admin_cohort_applied_defaults",
  save: "admin_template_guides_save",
  apply: "admin_template_guides_apply",
};

/**
 * 名前の関数（RPC）が DB に無い誤りか（PGRST202 か 42883 で、誤りの message に名前が入る）。admin-lib.js の isMissingFunctionError と
 * 同じ判定（admin-workshop.js の import の関係を変えないために写す。試験で同じ答えになることを固定）
 * @param {any} error
 * @param {string} name
 */
export function missingFunction(error, name) {
  if (!["PGRST202", "42883"].includes(str(error?.code))) return false;
  return !name || str(error?.message).includes(name);
}

/** 既定（写し・テンプレートの既定）を読めなかったときの 1 行（8.4） */
export const DEFAULTS_READ_FAILED = "既定の案内を読めませんでした";
/** 使っている途中で包む RPC が無くなったとき（8.5。016 に送り直さない） */
export const DEFAULTS_GONE = "既定の案内の機能が使えなくなりました。画面を最新にしてから、もう一度操作してください。";
/** 窓の見出しの ？ の 1 文目（8.1。あとの 2 文は組 8 のまま） */
export const HELP_MAIN_FIRST_8B = "テンプレートで付いた案内を、回ごとに替えられます。";

const DAY_ORDER = { day1: 1, bridge: 2, day2: 3 };
const posKey = (/** @type {any} */ dayKind, /** @type {any} */ seq) => `${str(dayKind)}|${Number(seq)}`;
const blankToNull = (/** @type {any} */ v) => (str(v).trim() === "" ? null : str(v).trim());
const byStageOrder = (/** @type {any} */ a, /** @type {any} */ b) =>
  ((/** @type {any} */ (DAY_ORDER))[a.day_kind] ?? 9) - ((/** @type {any} */ (DAY_ORDER))[b.day_kind] ?? 9) ||
  Number(a.seq ?? 0) - Number(b.seq ?? 0);

/** 比べる 3 つ（案内・始まり・終わり。時刻は "HH:MM" か ""）。案内が無ければ null */
function triple(/** @type {any} */ x) {
  if (!x?.guide_id) return null;
  return { guide_id: str(x.guide_id), start: timeField(x.planned_start), end: timeField(x.planned_end) };
}
function sameTriple(/** @type {any} */ a, /** @type {any} */ b) {
  if (!a || !b) return !a && !b;
  return a.guide_id === b.guide_id && a.start === b.start && a.end === b.end;
}

/** テンプレートの既定（admin_template_guides_list の行）のうち、そのテンプレートの分を位置（日の種類＋順番）で引く表
 * @param {any[]|null|undefined} defaults
 * @param {string|null|undefined} templateId
 * @returns {Map<string, any>} */
export function defaultsByPos(defaults, templateId) {
  const m = new Map();
  if (!templateId) return m;
  for (const d of defaults ?? []) if (d?.template_id === templateId) m.set(posKey(d.day_kind, d.seq), d);
  return m;
}
/** 位置の鍵（日の種類＋順番） */
export function templatePos(dayKind, seq) {
  return posKey(dayKind, seq);
}

/** 既定がこの段階に使えるか（matches_item が真で、回の段階の名前と題名が既定の保存の時点の名前と題名と同じ。6.5 の 4） */
export function defaultUsable(stage, d) {
  return !!d?.guide_id && d.matches_item === true && str(stage?.label).trim() === str(d.item_label).trim() &&
    blankToNull(stage?.title) === blankToNull(d.item_title);
}

/** 由来の札の文（8.4） */
export const ORIGIN_TEXT = {
  default: "テンプレートの既定",
  changed: "この回で書き換え",
  removed: "この回で外した",
  unset: "既定は付いていません",
  mismatch: "段階がテンプレートと違います",
};
/** 「段階がテンプレートと違います」のホバー（8.4） */
export const ORIGIN_MISMATCH_TITLE = "この段階の名前か題名が、テンプレートの同じ順番の段階と違うので、既定を付けません。";

/**
 * 由来の札（6.5 の表の 8 つの順）。stage：段階（day_kind・seq・label・title）、row：今の割り当て（guide_id・planned_start・planned_end。
 * 無ければ null）、applied：その段階の写し（admin_cohort_applied_defaults の applied の行。無ければ null）、tplDefault：回の今のテンプレートの
 * 同じ位置の既定（admin_template_guides_list の行。無ければ null）。比べるのは案内・始まり・終わりの 3 つ。
 * 返り：{ order, key, text, title, action, value }。action は revert（［既定に戻す］）・attach（［既定を付ける］）か null、
 * value は行に入れる値（{ guide_id, start, end }。時刻は "HH:MM" か ""）
 * @param {any} stage
 * @param {any} row
 * @param {any} applied
 * @param {any} tplDefault
 */
export function originState(stage, row, applied, tplDefault) {
  const cur = triple(row);
  const mk = (/** @type {number} */ order, /** @type {string} */ key, /** @type {string|null} */ action = null, /** @type {any} */ value = null) => ({
    order,
    key,
    text: /** @type {any} */ (ORIGIN_TEXT)[key] ?? "",
    title: key === "mismatch" ? ORIGIN_MISMATCH_TITLE : "",
    action,
    value,
  });
  const copy = triple(applied);
  if (copy) {
    if (sameTriple(cur, copy)) return mk(1, "default");
    return cur ? mk(2, "changed", "revert", copy) : mk(3, "removed", "revert", copy);
  }
  if (tplDefault?.guide_id) {
    if (!defaultUsable(stage, tplDefault)) return mk(7, "mismatch");
    const d = triple(tplDefault);
    if (sameTriple(cur, d)) return mk(4, "default");
    return cur ? mk(5, "changed", "revert", d) : mk(6, "unset", "attach", d);
  }
  return mk(8, "none");
}

/** 時刻の幅（"10:30〜12:00"。無ければ「なし」） */
function rangeText(/** @type {any} */ t) {
  return t?.start && t?.end ? `${t.start}〜${t.end}` : "なし";
}

/**
 * 包む適用 RPC で失われる物と替わる物を数える（8.2。純粋な関数）。
 * stages：admin_cohort_stage_guides の stages（外れた行〔orphans〕は渡さない）、rows：今の割り当て（stage_id・guide_id・guide_name・
 * planned_start・planned_end・set_via。stages から guide_id のある物を渡す）、applied：admin_cohort_applied_defaults の applied、
 * curTplDefaults：回の今のテンプレートの既定（無ければ []）、newTplDefaults：適用するテンプレートの既定、orphanOps：admin_cohort_applied_defaults の
 * orphan_ops。sameTemplate：回のテンプレートと適用するテンプレートが同じか（言い方を替える）。
 * 返り：{ N, M, E, K, attach, items }。N＝この回で書き換えた段階・M＝テンプレートの変更で替わる段階・E＝N のうち既定が無く外れる段階・
 * K＝消える行のうち手順書で付けた記録の件数（今の段階の ops_script の行＋orphanOps）・attach＝付ける既定の数（matches_item が真）。
 * items は detail の項目（N を先に M をあとに。それぞれの中では案内が替わる・外れる段階を先に、時刻だけが変わる段階をあとに）
 * @param {any[]|null|undefined} stages
 * @param {any[]|null|undefined} rows
 * @param {any[]|null|undefined} applied
 * @param {any[]|null|undefined} curTplDefaults
 * @param {any[]|null|undefined} newTplDefaults
 * @param {number|null|undefined} orphanOps
 * @param {{ sameTemplate?: boolean }} [o]
 */
export function planApplyDiff(stages, rows, applied, curTplDefaults, newTplDefaults, orphanOps, { sameTemplate = true } = {}) {
  const rowById = new Map((rows ?? []).filter((r) => r?.guide_id).map((r) => [r.stage_id, r]));
  const copyById = new Map((applied ?? []).map((a) => [a.stage_id, a]));
  const cur = new Map();
  for (const d of curTplDefaults ?? []) cur.set(posKey(d.day_kind, d.seq), d);
  const next = new Map();
  for (const d of newTplDefaults ?? []) if (d?.guide_id && d.matches_item === true) next.set(posKey(d.day_kind, d.seq), d);
  const head = sameTemplate ? "テンプレートの変更：" : "新しいテンプレート：";
  /** @type {{ group: number, rank: number, ord: number, text: string }[]} */
  const hits = [];
  let N = 0, M = 0, E = 0, ord = 0;
  for (const s of [...(stages ?? [])].sort(byStageOrder)) {
    const row = rowById.get(s.stage_id) ?? null;
    const a = triple(row);
    const nd = next.get(posKey(s.day_kind, s.seq)) ?? null;
    const b = triple(nd);
    if (sameTriple(a, b)) continue;
    const o = originState(s, row, copyById.get(s.stage_id) ?? null, cur.get(posKey(s.day_kind, s.seq)) ?? null);
    let group;
    if (o.order === 2 || o.order === 3 || o.order === 5 || ((o.order === 7 || o.order === 8) && a)) group = 0;
    else if (o.order === 1 || o.order === 4) group = 1;
    else continue;
    const name = stageShort(s);
    let text, rank = 0;
    if (a && b && a.guide_id === b.guide_id) {
      text = `${name}：時刻 ${rangeText(a)} → ${rangeText(b)}`;
      rank = 1;
    } else if (a && b) {
      const t = a.start !== b.start || a.end !== b.end ? `（時刻 ${rangeText(a)} → ${rangeText(b)}）` : "";
      text = `${name}：「${str(row?.guide_name)}」→「${str(nd?.guide_name)}」${t}`;
    } else if (b) text = `${name}：外していた →「${str(nd?.guide_name)}」`;
    else text = `${name}：「${str(row?.guide_name)}」→ 外れます`;
    if (group === 0) {
      N++;
      if (!b) E++;
    } else {
      M++;
      text = `${head}${text}`;
    }
    hits.push({ group, rank, ord: ord++, text });
  }
  hits.sort((x, y) => x.group - y.group || x.rank - y.rank || x.ord - y.ord);
  const K = (stages ?? []).filter((s) => s?.guide_id && s.set_via === "ops_script").length + Math.max(0, Number(orphanOps ?? 0) || 0);
  return { N, M, E, K, attach: next.size, items: hits.map((h) => h.text) };
}

/**
 * 包む適用 RPC の確かめ（8.2。本文 6 行まで）。diff：planApplyDiff の返り、hasRows：今の段階に割り当てが 1 つ以上あるか。
 * 7 行になるとき（lines 3・warnings 1・detail 2・note 1）だけ、detail を 1 項目にまとめて「ほか R か所」を残す
 * @param {{ cohortName: string, templateName: string, memberCount?: number, already: boolean, hasStages: boolean, hasRows?: boolean,
 *   sameTemplate?: boolean, diff: { N: number, M: number, E: number, K: number, attach: number, items: string[] } }} o
 */
export function applyDiffAsk({ cohortName, templateName, memberCount = 0, already, hasStages, hasRows = false, sameTemplate = true, diff }) {
  /** @type {string[]} */
  const lines = [];
  const first = !already && !hasStages;
  if (first) lines.push("この回の枠が、Day ごとではなく、ワークショップごとの段階になります。");
  else if (already) lines.push("段階を全部入れ替えます（名前・クレジットの変更は消えます）。");
  else lines.push("この回の枠が段階ごとになり、残っていた段階は全部入れ替わります（名前・クレジットの変更は消えます）。");
  const { N, M, E, K, attach } = diff;
  if (attach > 0) {
    const part = first || M < 1
      ? ""
      : sameTemplate
      ? `（うち ${M} か所は、テンプレートの変更で替わります）`
      : `（うち ${M} か所は、新しいテンプレートの既定に替わります）`;
    lines.push(`案内は、テンプレートの既定を ${attach} か所に付けます${part}。`);
  } else if (!first && hasRows) lines.push("このテンプレートには既定の案内がありません。付けた案内は外れます。");
  if (Number(memberCount) > 0) lines.push(`所属している受講者 ${Number(memberCount)} 人全員に効きます。`);
  /** @type {string[]} */
  const warnings = [];
  if (!first && N > 0) {
    const tail = sameTemplate
      ? E > 0 ? `適用すると、テンプレートの既定に戻ります（既定の無い ${E} か所は外れます）。` : "適用すると、テンプレートの既定に戻ります。"
      : E > 0
      ? `適用すると、新しいテンプレートの既定になります（既定の無い ${E} か所は外れます）。`
      : "適用すると、新しいテンプレートの既定になります。";
    warnings.push(`この回で書き換えた段階が ${N} か所あります。${tail}`);
  }
  const note = K > 0
    ? `手順書で付けた記録 ${K} 件も消えます（台帳に残っています）。`
    : first
    ? "Day1 が始まる前なら、「Day ごとの枠に戻す」で戻せます。始まったあとは戻せません。"
    : null;
  const items = first ? [] : diff.items ?? [];
  let detail = items.length <= 2 ? [...items] : [items[0], `ほか ${items.length - 1} か所（［ワークショップの案内］で確かめられます）`];
  if (detail.length && lines.length + warnings.length + detail.length + (note ? 1 : 0) > ASK_LIMITS.total) {
    detail = [items.length > 1 ? `${items[0]} ほか ${items.length - 1} か所` : items[0]];
  }
  return {
    title: `${str(cohortName)} に「${str(templateName)}」を適用しますか？`,
    lines,
    warnings,
    detail,
    note,
    okLabel: "適用する",
    kind: "primary",
  };
}

/** 包む適用 RPC の結果の文（8.2）
 * @param {{ cohortName: string, templateName: string, attached?: number, skipped?: number }} o */
export function applyDiffResultText({ cohortName, templateName, attached = 0, skipped = 0 }) {
  const a = Number(attached) || 0, s = Number(skipped) || 0;
  return `${str(cohortName)} にテンプレート「${str(templateName)}」を適用しました。${a > 0 ? `案内を ${a} か所に付けました。` : ""}${
    s > 0 ? `${s} か所は、テンプレートの段階が変わっていたので付けていません。テンプレートの［変更］で既定を選び直してください。` : ""
  }`;
}

/** 包む適用 RPC の前に読めなかったとき（8.2） */
export const APPLY_DIFF_READ_FAILED =
  "この回の案内の割り当てを読めませんでした。書き換えた段階を数えられないので、適用を止めました。［最新にする］のあと、もう一度押してください。";

// ---- テンプレートの編集（T1。8.3） ----

/** テンプレートの編集の「既定の案内」の ？ の中身（8.3） */
export const TEMPLATE_GUIDE_HELP = "回にこのテンプレートを適用すると、各段階にこの案内が付きます。回ごとに替えるときは［ワークショップの案内］の［回ごと］で行います。";
/** テンプレートの編集のシートの下の 1 行（8.3） */
export const TEMPLATE_GUIDE_FOOT = "既定の案内と時刻は、これから適用する回に付きます。すでに適用した回は変わりません。";
/** 既定か案内の一覧を読めなかったとき（8.3。保存を止める） */
export const TEMPLATE_GUIDES_READ_FAILED = "既定の案内を読めませんでした。このまま保存すると既定が消えるので、保存を止めています。［閉じる］のあと、もう一度開いてください。";
/** 画面の書き誤り（missing_key）で DB が断ったとき（8.3） */
export const TEMPLATE_MISSING_KEY = "画面の不具合で保存できませんでした。画面を最新にしてください。";

/** matches_item が偽の既定を外して表示したときの 1 行（8.3） */
export function templateHiddenLine(n) {
  return n > 0 ? `テンプレートの段階が別の画面で変わったため、既定の案内 ${n} か所を外して表示しています。保存すると確定します。` : "";
}

/**
 * テンプレートの編集の既定の値。返り：{ byPos: Map<"day|seq", { guide, start, end }>, hidden }（hidden は matches_item が偽で外して表示する数）
 * @param {any[]|null|undefined} defaults
 * @param {string|null|undefined} templateId
 */
export function templateDefaultRows(defaults, templateId) {
  /** @type {Map<string, { guide: string, start: string, end: string }>} */
  const byPos = new Map();
  let hidden = 0;
  for (const d of defaultsByPos(defaults, templateId).values()) {
    if (d.matches_item !== true) {
      hidden++;
      continue;
    }
    const bridge = d.day_kind === "bridge";
    byPos.set(posKey(d.day_kind, d.seq), {
      guide: str(d.guide_id),
      start: bridge ? "" : timeField(d.planned_start),
      end: bridge ? "" : timeField(d.planned_end),
    });
  }
  return { byPos, hidden };
}

/** テンプレートの編集の既定の案内の選択肢（日の種類に合う種類だけ。後ろに「未公開」「止めている」） */
export function templateGuideOptions(dayKind, guides) {
  const kind = dayKind === "bridge" ? "bridge" : "workshop";
  return (guides ?? [])
    .filter((g) => g.kind === kind)
    .map((g) => ({
      id: g.id,
      label: `${str(g.name)}${g.published_version == null ? "（未公開）" : ""}${g.active === false ? "（止めている）" : ""}`,
    }));
}

/**
 * parseTemplateForm の items（day_kind・seq〔その日の中の 1 からの順〕）に、行の既定の案内と時刻を位置で足す（8.3）。
 * days：日の種類 → 行の並び（{ guide, start, end }。並べ替えのあとの並び）。どの項目にも guide_id・planned_start・planned_end の
 * 3 つの鍵を必ず入れる（「案内なし」は null）。時刻はワークショップだけ（ブリッジワークは null）。片方だけ・始まり≧終わり・案内なしに時刻は断る。
 * 返り：{ items, problems }
 * @param {any[]} items
 * @param {Record<string, any[]>} days
 */
export function templateItemsWithGuides(items, days) {
  /** @type {string[]} */
  const problems = [];
  const out = (items ?? []).map((it) => {
    const r = days?.[it.day_kind]?.[Number(it.seq) - 1] ?? {};
    const gid = str(r.guide).trim() || null;
    const where = `${(/** @type {any} */ (DAY_LABELS))[it.day_kind] ?? str(it.day_kind)}の ${Number(it.seq)} 番目`;
    let s = null, e = null;
    if (it.day_kind !== "bridge") {
      const a = timeValue(r.start), b = timeValue(r.end);
      if (a === undefined || b === undefined) problems.push(`${where}：時刻は 10:00 の形で入れてください`);
      else if ((a === null) !== (b === null)) problems.push(`${where}：時刻の目安は、始まりと終わりの両方を入れてください（入れないときは両方とも空に）`);
      else if (a !== null && b !== null && a >= b) problems.push(`${where}：時刻の目安は、始まりを終わりより前にしてください`);
      else if (!gid && a !== null) problems.push(`${where}：時刻の目安は、既定の案内を選んだ段階にだけ入れられます`);
      else {
        s = a;
        e = b;
      }
    }
    return { ...it, guide_id: gid, planned_start: s, planned_end: e };
  });
  return { items: out, problems };
}

/**
 * 包む保存 RPC の誤りを、テンプレートの編集の場所に結ぶ（3.9 の表に足した 1 行。8.3）。items：送った p_items。
 * DB（251）の detail の index は p_items の 1 から数えた番号（251 の頭の注記）。返りの index はその日の中の 0 からの番号。
 * 返り：{ area: "band", text }（missing_key）・{ area: "row", dayKind, index, text }（detail に index がある）・null（ほか）
 * @param {any} error
 * @param {any[]} items
 */
export function templateSaveErrorTarget(error, items) {
  const d = errorDetail(error);
  if (d?.reason === "missing_key") return { area: "band", text: TEMPLATE_MISSING_KEY };
  const i = Number(d?.index) - 1;
  if (d && d.index !== null && d.index !== undefined && Number.isInteger(i) && i >= 0 && items?.[i]) {
    return {
      area: "row",
      dayKind: items[i].day_kind,
      index: Number(items[i].seq) - 1,
      text: str(error?.hint) || explainError(error),
    };
  }
  return null;
}
