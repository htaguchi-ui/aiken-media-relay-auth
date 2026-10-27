// 管理コンソールの「提出」の画面のうち、受け付けの終わり（締切）の設定（docs/design-submissions.md 6.3・2.3・D17・D23）。
// 本体はこの新しいファイル。admin.html・admin.js は、ここを呼ぶ入口の数行だけ（計画 3.5。11/5 の窓）。
// 管理者の RPC（管理コンソールのログインのまま）：submission_deadlines（読む）・submission_deadline_set（保存。null で既定に戻す）。
// 判定の最後は DB（回の終了から 7 日後以降・Day2 の日付が無い回は断る）。画面は目安の確かめと、入力と表示を最後の分にそろえるだけ。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
import {
  DEADLINE_INPUT_HELP,
  DEADLINE_RESET_CONFIRM,
  deadlineErrorText,
  deadlineEventLine,
  deadlineProblem,
  deadlineRuleLine,
  inputValueFromDeadline,
  MSG_DEADLINE_RESET,
  MSG_DEADLINE_SAVED,
  NO_DAY2_TEXT,
  normalizeDeadlines,
  submissionStageName,
  SUBMISSION_RPC,
  formatShortDateTime,
} from "./submissions-lib.js";

/**
 * @param {object} o
 * @param {HTMLElement} o.container 画面を入れる所
 * @param {(name: string, args: object) => Promise<{ data: any, error: any }>} o.rpc 管理コンソールの部品での RPC
 * @param {(opts: { title: string, lines: string[], okText: string }) => Promise<boolean>} o.confirm 確認（続けるなら true）
 * @param {(message: string, kind?: "ok" | "error") => void} o.notify お知らせ
 * @param {(error: any) => string} [o.explain] RPC の失敗の文（admin-lib の explainError）。DB の hint を出すとき
 * @param {() => number} [o.now]
 */
export function createAdminDeadlines(o) {
  const now = o.now ?? (() => Date.now());
  /** 世代：load / clear のたびに進め、前に始まった要求の応答は画面に入れない（回を替えた・ログアウトのあと） */
  let epoch = 0;
  let cohortId = null;
  let data = null;
  let busy = false;
  /** 入力の途中の値（段階ごと）。失敗して描き直しても、入れた値を消さない。保存に成功したら捨てる */
  const drafts = new Map();

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  };

  function failureText(error) {
    const code = error?.message && /deadline_after_cold_due|cohort_dates_missing|admin_only/.exec(String(error.message))?.[0];
    if (code) return deadlineErrorText(code, 400);
    if (error?.code === "42501") return deadlineErrorText("admin_only", 403);
    if (String(error?.code) === "PGRST202" || String(error?.code) === "42883") return "提出の機能は、まだ使えません。";
    return o.explain ? o.explain(error) : deadlineErrorText(null, 500);
  }

  async function load(nextCohortId) {
    const my = ++epoch;
    cohortId = nextCohortId;
    busy = false;
    drafts.clear();
    if (!cohortId) {
      data = null;
      o.container.replaceChildren();
      return;
    }
    o.container.replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    const { data: raw, error } = await o.rpc(SUBMISSION_RPC.deadlines, { p_cohort_id: cohortId });
    if (my !== epoch) return;
    if (error) {
      data = null;
      o.container.replaceChildren(el("p", { className: "error-text", role: "alert", text: failureText(error) }), el("button", { type: "button", className: "btn compact", text: "もう一度読み込む", onclick: () => void load(cohortId) }));
      return;
    }
    const d = normalizeDeadlines(raw);
    if (!d || d.cohortId !== cohortId) {
      data = null;
      o.container.replaceChildren(el("p", { className: "error-text", role: "alert", text: "受け付けの終わりを読み込めませんでした（応答の形が違います）。" }));
      return;
    }
    data = d;
    render();
  }

  /** 画面の中身を消す（ログアウト・回を離れるとき。出ている要求の応答も捨てる） */
  function clear() {
    epoch += 1;
    cohortId = null;
    data = null;
    busy = false;
    drafts.clear();
    o.container.replaceChildren();
  }

  function render() {
    if (!data) return;
    const noDay2 = !data.day2Date;
    const parts = [];
    if (noDay2) parts.push(el("p", { className: "warn-box", role: "status", text: NO_DAY2_TEXT }));
    else if (data.coldDueAt) parts.push(el("p", { className: "muted small", text: `どの段階も、回の終了から 7 日後（${formatShortDateTime(data.coldDueAt)}）より前しか選べません。` }));
    for (const s of data.stages) parts.push(stageBlock(s, noDay2));
    o.container.replaceChildren(...parts);
  }

  function stageBlock(s, noDay2) {
    const input = el("input", { type: "datetime-local", className: "input", id: `deadline-${s.stageId}`, "aria-label": `${submissionStageName(s)} の受け付けの終わり`, step: "60" });
    input.value = drafts.get(s.stageId) ?? inputValueFromDeadline(s.manualUntil);
    input.addEventListener("input", () => drafts.set(s.stageId, input.value));
    if (noDay2 || busy) input.disabled = true;
    const msg = el("p", { className: "error-text small", role: "alert", hidden: true });
    const save = el("button", { type: "button", className: "btn compact primary", "data-action": "deadline-save", text: "保存", disabled: noDay2 || busy, onclick: () => void saveOne(s, input, msg) });
    const reset = s.manualUntil ? el("button", { type: "button", className: "btn compact", "data-action": "deadline-reset", text: "既定に戻す", disabled: noDay2 || busy, onclick: () => void resetOne(s, msg) }) : null;
    const events = s.events.length ? el("details", { className: "plain-fold minor" }, el("summary", {}, el("span", { text: `変更の履歴（${s.events.length}）` })), el("ul", { className: "deadline-events small" }, ...s.events.map((e) => el("li", { text: deadlineEventLine(e) })))) : null;
    return el(
      "div",
      { className: "deadline-stage", "data-stage": s.stageId },
      el("h3", { text: submissionStageName(s) }),
      el("p", { className: "small", "data-testid": "deadline-rule", text: deadlineRuleLine(s, data.day2Date) }),
      el("div", { className: "row-actions" }, input, save, reset),
      el("p", { className: "muted small", text: DEADLINE_INPUT_HELP }),
      msg,
      events,
    );
  }

  function showError(msg, text) {
    msg.textContent = text;
    msg.hidden = !text;
  }

  async function call(my, stageId, deadlineAt) {
    const { data: raw, error } = await o.rpc(SUBMISSION_RPC.deadlineSet, { p_cohort_id: cohortId, p_stage_id: stageId, p_deadline_at: deadlineAt, p_note: null });
    if (my !== epoch) return { stale: true };
    if (error) return { error };
    // 保存の応答は、読み直した結果と同じ形（返らない・形が違うときは読み直す）
    const d = normalizeDeadlines(raw);
    if (d && d.cohortId === cohortId) data = d;
    else {
      await load(cohortId);
      return { reloaded: true };
    }
    return { ok: true };
  }

  async function saveOne(s, input, msg) {
    if (busy || !data) return;
    const my = epoch;
    const r = deadlineProblem(input.value, { coldDueAt: data.coldDueAt, nowMs: now() });
    if (r.error) {
      showError(msg, r.error);
      return;
    }
    showError(msg, "");
    if (r.confirm && !(await o.confirm({ title: "過去の日時です", lines: [r.confirm], okText: "保存する" }))) return;
    if (my !== epoch) return;
    busy = true;
    render();
    try {
      const res = await call(my, s.stageId, r.iso);
      if (res.stale) return;
      if (res.error) {
        o.notify(failureText(res.error), "error");
        return;
      }
      drafts.delete(s.stageId);
      o.notify(MSG_DEADLINE_SAVED);
    } finally {
      if (my === epoch) {
        busy = false;
        render();
      }
    }
  }

  async function resetOne(s) {
    if (busy || !data) return;
    const my = epoch;
    if (!(await o.confirm({ title: "既定に戻します", lines: [DEADLINE_RESET_CONFIRM], okText: "既定に戻す" }))) return;
    if (my !== epoch) return;
    busy = true;
    render();
    try {
      const res = await call(my, s.stageId, null);
      if (res.stale) return;
      if (res.error) {
        o.notify(failureText(res.error), "error");
        return;
      }
      drafts.delete(s.stageId);
      o.notify(MSG_DEADLINE_RESET);
    } finally {
      if (my === epoch) {
        busy = false;
        render();
      }
    }
  }

  return { load, clear, _state: () => ({ epoch, busy, data, cohortId }) };
}
