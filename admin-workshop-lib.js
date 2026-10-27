// 管理コンソールの［ワークショップの案内］の純粋な部品（docs/design-workshop-guide.md 第 1.3.1 版 3.1・4.2・4.6・6.2）。
// 画面（admin-workshop.js）から使う。DOM に触らない。試験：scripts/admin_workshop_lib_test.ts。
// 字数の上限・文の数・content の字数の式の検査は DB（workshop_guide_body_problem）が 1 か所で行う。ここでは数えない（4.6：入力中の
// 字数の数えは外した）。ここで行うのは、入力の形をそろえること・受講者向けの言葉の警告・一覧と割り当ての表示の形だけ。

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

/** 公開の前の注意（4.6。11/18 のあとは承認を取ってから押す） */
export const PUBLISH_NOTE =
  "公開すると、割り当てた回の受講者の AI は、次に案内を読み直したときから新しい案内を使います。急ぐときは、受講者に「案内を読み直して」と声をかけてもらってください。11/18 のあとは、田口さんの承認を取ってから公開してください。";

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

/** 一覧の 1 行の表示 */
export function guideListRow(g) {
  const state = g.published_version == null ? "まだ公開していない" : `公開 版 ${g.published_version}`;
  return {
    id: g.id,
    name: str(g.name),
    kind: KIND_LABELS[g.kind] ?? str(g.kind),
    state,
    draft: g.has_pending_draft ? "公開していない下書きあり" : "",
    assigned: `${Number(g.assignment_count ?? 0)} か所`,
    via: g.last_published_via === "ops_script" ? "最後の公開は管理用の手順書から" : "",
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

/** 回の選択肢（新しい Day1 の順）
 * @param {any[] | null | undefined} cohorts
 * @returns {{ id: string, label: string }[]} */
export function cohortOptions(cohorts) {
  return [...(cohorts ?? [])]
    .sort((a, b) => str(b.day1_date).localeCompare(str(a.day1_date)) || str(a.id).localeCompare(str(b.id)))
    .map((c) => ({ id: c.id, label: `${str(c.name) || c.id}（Day1 ${str(c.day1_date)}・Day2 ${str(c.day2_date)}）` }));
}
