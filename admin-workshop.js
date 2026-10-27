// 管理コンソールの［ワークショップの案内］（docs/design-workshop-guide.md 第 1.3.1 版 4.6。束 K の K3）。
// 左のメニュー（#side-menu）の最後に［案内］を 1 つ足し、押すと自分の <dialog> を開く。中は 2 つのつまみ：
//   ［案内の本］一覧（名前・種類・公開の版・下書きあり・割り当ての数・最後の公開が台本か）と編集（3.1 の項目）・［下書きを保存］・［公開する…］
//   ［回への割り当て］回を選ぶ → 段階ごとに案内と時刻表（ワークショップだけ）。段階が無くなった割り当ては 1 行と［外す］
// admin.js の内部の状態には依存しない。受け取るのは Supabase の client と、ボタンを足す親（#side-menu）と、閉じたかを返す関数だけ
// （admin.js の入口は動的な import の数行。読み込めない・失敗しても［案内］が出ないだけで、ほかの画面は止まらない）。
// 管理コンソールが閉じたら（isClosed が真・メニューが外れた・#app が隠れた）、窓を閉じて消し、読んだ中身も消す。
// 閉じたあと・新しい読み込みのあとに戻った古い応答は描かない（世代の確かめ）。
// 表示はすべて createElement / textContent で組み立てる（データを innerHTML に入れない）。読み書きは DB の管理の RPC だけ
// （admin_workshop_guides・admin_save_workshop_guide・admin_publish_workshop_guide・admin_cohorts・admin_cohort_stage_guides・
// admin_set_cohort_stage_guide。どれも中で is_admin()）。字数の検査は DB が行い、その理由をそのまま出す。
import {
  assignmentArgs,
  cohortOptions,
  DAY_LABELS,
  emptyGuide,
  explainError,
  FIELD_LABELS,
  forbiddenWarnings,
  guideListRow,
  guideOptionsFor,
  KIND_LABELS,
  PUBLISH_NOTE,
  stageName,
  timeField,
  toBody,
  toForm,
} from "./admin-workshop-lib.js";

const STYLE_ID = "workshop-guide-style";
const CSS = `
dialog.wg-dialog { width: min(1100px, 96vw); max-height: 92vh; padding: 0; border: 1px solid var(--line, #E3E6EB);
  border-radius: 16px; background: var(--surface, #fff); color: var(--text, #16181D); overflow: hidden; }
/* 窓は縦に並べ、本文（.wg-body）だけをスクロールする（窓と本文の 2 重のスクロールにしない） */
dialog.wg-dialog[open] { display: flex; flex-direction: column; }
.wg-head, .wg-tabs { flex: none; }
dialog.wg-dialog::backdrop { background: var(--scrim, rgba(26, 30, 38, 0.62)); }
.wg-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line, #E3E6EB); }
.wg-head h2 { margin: 0; font-size: 16px; flex: 1; }
.wg-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px 0; }
.wg-tabs button { min-height: 34px; padding: 0 12px; border-radius: 17px; border: 1px solid var(--line-2, #DDE1E7);
  background: var(--surface, #fff); color: var(--text, #16181D); font: inherit; font-size: 13px; cursor: pointer; }
.wg-tabs button[aria-selected="true"] { background: var(--accent, #26396E); color: var(--on-accent, #fff); border-color: var(--accent, #26396E); }
.wg-body { padding: 10px 16px 16px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.wg-msgwrap { padding: 0 16px; flex: none; max-height: 30vh; overflow: auto; }
.wg-body h3 { font-size: 14px; margin: 16px 0 6px; }
.wg-body table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.wg-body th, .wg-body td { border-bottom: 1px solid var(--line-soft, #EEF0F3); padding: 6px 8px; text-align: left; vertical-align: top;
  overflow-wrap: anywhere; }
.wg-body th { color: var(--muted, #4C525F); font-weight: 600; }
.wg-row-btn { all: unset; cursor: pointer; color: var(--accent, #26396E); font-weight: 600; overflow-wrap: anywhere; }
.wg-row-btn:focus-visible, .wg-btn:focus-visible { outline: 2px solid var(--accent, #26396E); outline-offset: 2px; }
.wg-btn { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-2, #DDE1E7); background: var(--surface, #fff);
  color: var(--text, #16181D); font: inherit; font-size: 13px; cursor: pointer; }
.wg-btn.primary { background: var(--accent, #26396E); color: var(--on-accent, #fff); border-color: var(--accent, #26396E); }
.wg-btn.danger { color: var(--danger, #96413A); }
.wg-btn:disabled { opacity: 0.5; cursor: default; }
.wg-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
.wg-bar input[type="checkbox"] + label { flex: 1 1 0; min-width: 0; }
.wg-field { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.wg-field label, .wg-label { font-size: 12.5px; font-weight: 600; color: var(--text-2, #4A505B); }
.wg-field input, .wg-field textarea, .wg-field select, .wg-body select, .wg-body input[type="time"] {
  font: inherit; font-size: 14px; border: 1px solid var(--input-line, #C9CED6); border-radius: 8px; padding: 6px 8px;
  background: var(--surface, #fff); color: var(--text, #16181D); min-width: 0; }
.wg-field textarea { min-height: 56px; resize: vertical; }
.wg-box { border: 1px solid var(--line, #E3E6EB); border-radius: 12px; padding: 8px 12px; margin: 8px 0; }
.wg-box .wg-sub { border-top: 1px dashed var(--line, #E3E6EB); margin-top: 6px; padding-top: 4px; }
.wg-hint { font-size: 12px; color: var(--muted, #4C525F); margin: 2px 0; }
.wg-line { border-top: 2px solid var(--line, #E3E6EB); margin: 16px 0 4px; padding-top: 6px; font-size: 12.5px; color: var(--muted, #4C525F); }
.wg-msg { border-radius: 10px; padding: 8px 12px; margin: 8px 0; font-size: 13px; }
.wg-msg.ok { background: var(--ok-bg, #EEF5F0); color: var(--ok-fg, #3D5B45); }
.wg-msg.warn { background: var(--warn-bg, #F5EFE7); color: var(--warn-fg, #74512C); }
.wg-msg.err { background: var(--surface-2, #F6F7F9); color: var(--danger, #96413A); border: 1px solid var(--danger-line, #E2CDC9); }
.wg-row-err { color: var(--danger, #96413A); font-size: 12.5px; margin: 4px 0 0; }
.wg-msg ul { margin: 4px 0 0; padding-left: 18px; }
.wg-confirm { border: 2px solid var(--accent, #26396E); border-radius: 12px; padding: 10px 12px; margin: 8px 0; }
.wg-body td select { width: 100%; }
.wg-times { display: inline-flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
.wg-split { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 699.98px) {
  .wg-split { grid-template-columns: 1fr; }
  /* 狭い幅では、表の 1 行を 1 枚のカードにする（列に押し込んで 1 字ずつ折れないように）。見出しの行は隠し、各欄の前に見出しの言葉を出す */
  .wg-body table, .wg-body tbody, .wg-body tr, .wg-body td { display: block; width: auto; }
  .wg-body thead { display: none; }
  .wg-body tr { border: 1px solid var(--line, #E3E6EB); border-radius: 12px; padding: 6px 10px; margin: 8px 0; }
  .wg-body td { border: 0; padding: 3px 0; }
  .wg-body td[data-label]::before { content: attr(data-label) "："; color: var(--muted, #4C525F); font-weight: 600; margin-right: 4px; }
  .wg-body td.wg-stack::before { display: block; margin: 0 0 2px; }
}
`;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "className") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "value") e.value = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** 開いた本の形（lucide の book-open と同じ線）。左のメニューのほかのアイコンと同じ大きさ・同じクラス */
function bookIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (
    const [k, v] of Object.entries({
      width: "20",
      height: "20",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
      class: "site-nav-icon",
    })
  ) svg.setAttribute(k, v);
  for (
    const d of [
      "M12 7v14",
      "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
    ]
  ) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** 閉じたかを確かめる間隔（ミリ秒） */
const CLOSE_CHECK_MS = 300;

/**
 * 左のメニューに［案内］を足す。返り：{ open, dispose }
 * @param {{ supabase: any, menu: any, isClosed?: () => boolean }} opts
 */
export function mountWorkshopGuide({ supabase, menu, isClosed }) {
  if (!supabase || !menu) return { open: async () => {}, dispose: () => {} };
  if (!document.getElementById(STYLE_ID)) document.head.append(el("style", { id: STYLE_ID, text: CSS }));
  const entry = el(
    "button",
    {
      type: "button",
      className: "side-item",
      id: "tab-workshop",
      "aria-haspopup": "dialog",
      "aria-label": "ワークショップの案内",
    },
    bookIcon(),
    el("span", { text: "案内" }),
  );
  menu.append(entry);

  const dialog = el("dialog", { className: "wg-dialog", "aria-labelledby": "wg-title" });
  const msg = el("div", { role: "status" });
  const body = el("div", { className: "wg-body" });
  const tabs = el("div", { className: "wg-tabs", role: "tablist", "aria-label": "案内の分類" });
  const TABS = [{ key: "guides", label: "案内の本" }, { key: "assign", label: "回への割り当て" }];
  for (const t of TABS) {
    tabs.append(
      el("button", { type: "button", role: "tab", "data-key": t.key, text: t.label, onclick: () => switchTab(t.key) }),
    );
  }
  dialog.append(
    el(
      "div",
      { className: "wg-head" },
      el("h2", { id: "wg-title", text: "ワークショップの案内" }),
      el("button", { type: "button", className: "wg-btn", text: "読み直す", onclick: () => reload() }),
      el("button", { type: "button", className: "wg-btn", text: "閉じる", onclick: () => requestClose() }),
    ),
    tabs,
    el("div", { className: "wg-msgwrap" }, msg),
    body,
  );
  document.body.append(dialog);

  const S = {
    tab: "guides",
    guides: null,
    guidesError: "",
    sel: null, // { id: string|null, kind, name, note, active, sha, form }
    dirty: false,
    problem: null,
    busy: false,
    confirm: null, // { text, okLabel, ok }
    cohorts: null,
    cohortId: "",
    assign: null,
    assignError: "",
    // 割り当ての行ごとの保存していない入力（回と段階で 1 つ）と、その行の誤り（F240-02）
    rowDrafts: new Map(),
    rowErrors: new Map(),
  };
  // 編集の［公開する…］と、その横の案内（文字を入れたときに、描き直さずに状態だけ替える。F240-05）
  let publishBtnRef = null;
  let publishHintRef = null;
  let disposed = false;
  let gen = 0;
  let observer;

  function setMsg(kind, text, items = []) {
    if (!text) {
      msg.replaceChildren();
      return;
    }
    const box = el("div", { className: `wg-msg ${kind}` }, el("div", { text }));
    if (items.length) box.append(el("ul", {}, ...items.map((t) => el("li", { text: t }))));
    msg.replaceChildren(box);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    gen++;
    clearInterval(timer);
    observer?.disconnect();
    if (dialog.open) dialog.close();
    body.replaceChildren();
    msg.replaceChildren();
    dialog.remove();
    entry.remove();
    S.guides = null;
    S.sel = null;
    S.cohorts = null;
    S.assign = null;
  }
  function checkClosed() {
    if (disposed) return true;
    const app = typeof menu.closest === "function" ? menu.closest("#app") : null;
    if ((typeof isClosed === "function" && isClosed()) || !menu.isConnected || !entry.isConnected || app?.hidden) {
      dispose();
    }
    return disposed;
  }
  const timer = setInterval(checkClosed, CLOSE_CHECK_MS);
  {
    const app = typeof menu.closest === "function" ? menu.closest("#app") : null;
    if (app && typeof MutationObserver === "function") {
      observer = new MutationObserver(() => checkClosed());
      observer.observe(app, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  async function rpc(name, args) {
    const { data, error } = args === undefined ? await supabase.rpc(name) : await supabase.rpc(name, args);
    return { data, error };
  }

  // ---- 読み込み ----

  async function loadGuides() {
    const my = ++gen;
    const { data, error } = await rpc("admin_workshop_guides");
    if (my !== gen || checkClosed()) return false;
    S.guides = error ? null : (data ?? []);
    S.guidesError = error ? explainError(error) : "";
    return !error;
  }
  async function loadCohorts() {
    const my = gen;
    const { data, error } = await rpc("admin_cohorts");
    if (my !== gen || checkClosed()) return;
    S.cohorts = error ? [] : (data ?? []);
    if (error) S.assignError = explainError(error);
  }
  async function loadAssign() {
    if (!S.cohortId) {
      S.assign = null;
      return;
    }
    const my = ++gen;
    const { data, error } = await rpc("admin_cohort_stage_guides", { p_cohort_id: S.cohortId });
    if (my !== gen || checkClosed()) return;
    S.assign = error ? null : data;
    S.assignError = error ? explainError(error) : "";
  }
  async function reload() {
    if (checkClosed()) return;
    if (S.dirty) {
      askConfirm("保存していない変更があります。読み直すと消えます。", "破棄して読み直す", async () => {
        S.dirty = false;
        await reload();
      });
      return;
    }
    await loadGuides();
    if (S.sel?.id) selectGuide(S.sel.id, { keepMsg: true });
    if (S.tab === "assign") {
      if (!S.cohorts) await loadCohorts();
      await loadAssign();
    }
    render();
  }

  async function open() {
    if (checkClosed()) return;
    if (!dialog.open) dialog.showModal();
    S.confirm = null;
    setMsg("", "");
    await loadGuides();
    render();
  }
  entry.addEventListener("click", () => open());

  function requestClose() {
    if (S.dirty) {
      askConfirm("保存していない変更があります。閉じると消えます。", "破棄して閉じる", () => {
        S.dirty = false;
        S.sel = null;
        dialog.close();
      });
      return;
    }
    S.confirm = null;
    dialog.close();
  }
  dialog.addEventListener("cancel", (e) => {
    if (S.dirty || S.busy) {
      e.preventDefault?.();
      if (!S.busy) requestClose();
    }
  });

  function askConfirm(text, okLabel, ok) {
    S.confirm = { text, okLabel, ok };
    render();
  }

  async function switchTab(key) {
    if (S.tab === key || checkClosed()) return;
    S.tab = key;
    S.confirm = null;
    if (key === "assign") {
      render();
      if (!S.cohorts) await loadCohorts();
      if (S.guides === null) await loadGuides();
    }
    render();
  }

  // ---- 案内の本 ----

  function selectGuide(id, { keepMsg = false } = {}) {
    const g = (S.guides ?? []).find((x) => x.id === id);
    if (!g) {
      S.sel = null;
      return;
    }
    S.sel = {
      id: g.id,
      kind: g.kind,
      name: g.name,
      note: g.note ?? "",
      active: g.active !== false,
      sha: g.draft_sha256,
      form: toForm(g.draft, g.kind),
    };
    S.dirty = false;
    S.problem = null;
    S.confirm = null;
    if (!keepMsg) setMsg("", "");
  }
  /** 編集を開いた操作のあとだけ、編集の見出しを見える所へ移して focus する（描き直しのたびには動かさない） */
  function showEditor() {
    const h = document.getElementById("wg-edit-h");
    if (!h) return;
    h.setAttribute("tabindex", "-1");
    h.scrollIntoView?.({ block: "start" });
    h.focus?.();
  }
  function chooseGuide(id) {
    const go = () => {
      selectGuide(id);
      render();
      showEditor();
    };
    if (S.dirty) askConfirm("保存していない変更があります。ほかの案内を開くと消えます。", "破棄して開く", go);
    else go();
  }
  function newGuide(kind) {
    const go = () => {
      S.sel = { id: null, kind, name: "", note: "", active: true, sha: null, form: emptyGuide(kind) };
      S.dirty = false;
      S.problem = null;
      S.confirm = null;
      setMsg("", "");
      render();
      showEditor();
    };
    if (S.dirty) askConfirm("保存していない変更があります。新しく作ると消えます。", "破棄して新しく作る", go);
    else go();
  }
  function touch() {
    if (S.dirty) return;
    S.dirty = true;
    // 描き直さずに（入力の focus を保ったまま）、公開のボタンと案内だけを替える
    if (publishBtnRef) {
      publishBtnRef.disabled = true;
      publishBtnRef.setAttribute("aria-disabled", "true");
    }
    if (publishHintRef) publishHintRef.textContent = "公開は、下書きを保存してからできます。";
  }

  async function save() {
    if (!S.sel || S.busy || checkClosed()) return;
    const sel = S.sel;
    const draft = toBody(sel.form, sel.kind);
    S.busy = true;
    render();
    const { data, error } = await rpc("admin_save_workshop_guide", {
      p_guide_id: sel.id,
      p_kind: sel.kind,
      p_name: sel.name,
      p_note: sel.note,
      p_active: sel.active,
      p_draft: draft,
      p_expected_draft_sha256: sel.id ? sel.sha : null,
    });
    S.busy = false;
    if (checkClosed() || S.sel !== sel) return;
    if (error) {
      setMsg("err", explainError(error));
      render();
      return;
    }
    sel.id = data.id;
    sel.sha = data.draft_sha256;
    S.dirty = false;
    S.problem = data.problem ?? null;
    const warns = forbiddenWarnings(draft);
    if (S.problem) setMsg("warn", "下書きを保存しました。公開する前に、次を直してください。", [S.problem, ...warns]);
    else if (warns.length) setMsg("warn", "下書きを保存しました。受講者に届く文の言葉を確かめてください。", warns);
    else setMsg("ok", "下書きを保存しました。");
    await loadGuides();
    if (S.sel === sel) {
      const g = (S.guides ?? []).find((x) => x.id === sel.id);
      if (g) sel.sha = g.draft_sha256;
    }
    render();
  }

  function askPublish() {
    if (!S.sel?.id || S.busy) return;
    if (S.dirty) {
      setMsg("warn", "先に下書きを保存してください。公開は、保存した下書きだけを対象にします。");
      render();
      return;
    }
    const target = { id: S.sel.id, sha: S.sel.sha, name: S.sel.name };
    const warns = forbiddenWarnings(toBody(S.sel.form, S.sel.kind));
    askConfirm(
      [
        `「${target.name}」を公開します。`,
        PUBLISH_NOTE,
        ...(warns.length ? ["受講者に届く文に、使わない言葉があります（下の注意）。"] : []),
      ].join(" "),
      "公開する",
      () => publish(target),
    );
  }
  async function publish(target) {
    const sel = S.sel;
    if (!target || !sel?.id || S.busy || checkClosed()) return;
    if (sel.id !== target.id || sel.sha !== target.sha || S.dirty) {
      setMsg("err", "公開の対象が変わりました。もう一度［公開する…］から確かめてください。");
      render();
      return;
    }
    S.busy = true;
    render();
    const { data, error } = await rpc("admin_publish_workshop_guide", {
      p_guide_id: target.id,
      p_expected_draft_sha256: target.sha,
    });
    S.busy = false;
    if (checkClosed() || S.sel !== sel) return;
    if (error) setMsg("err", `公開できませんでした。${explainError(error)}`);
    else if (data?.published) setMsg("ok", `版 ${data.version} を公開しました。`);
    else setMsg("ok", `下書きは前に公開した版と同じなので、版は進めませんでした（版 ${data?.version}）。`);
    await loadGuides();
    render();
  }

  // ---- 回への割り当て ----

  async function chooseCohort(id) {
    S.cohortId = id;
    S.assign = null;
    S.assignError = "";
    render();
    await loadAssign();
    render();
  }
  /** key は「回|段階」（今は無い段階を外すときは null）。行の入力は、保存がうまくいった行だけ下書きから消す */
  async function saveAssignment(stage, key, guideId, start, end) {
    if (S.busy || checkClosed()) return;
    if (key) S.rowDrafts.set(key, { guide: guideId ?? "", start: start ?? "", end: end ?? "" });
    const chk = assignmentArgs(S.cohortId, stage, guideId, start, end);
    if (!chk.ok) {
      if (key) S.rowErrors.set(key, chk.message);
      else setMsg("err", chk.message);
      render();
      return;
    }
    if (key) S.rowErrors.delete(key);
    S.busy = true;
    render();
    const { error } = await rpc("admin_set_cohort_stage_guide", chk.args);
    S.busy = false;
    if (checkClosed()) return;
    if (error) {
      const text = `保存できませんでした。${explainError(error)}`;
      if (key) S.rowErrors.set(key, text);
      else setMsg("err", `割り当てを${text}`);
    } else {
      if (key) S.rowDrafts.delete(key);
      setMsg("ok", `「${stageName(stage)}」の割り当てを保存しました。`);
    }
    await loadAssign();
    await loadGuides();
    render();
  }

  // ---- 描画 ----

  function field(label, value, onInput, { multiline = false, max, type = "text", hint } = {}) {
    const id = `wg-f-${Math.random().toString(36).slice(2, 10)}`;
    const input = multiline
      ? el("textarea", { id, maxlength: max, value })
      : el("input", { id, type, maxlength: max, value, inputmode: type === "number" ? "numeric" : undefined });
    input.value = value ?? "";
    input.addEventListener("input", () => {
      onInput(input.value);
      touch();
    });
    return el(
      "div",
      { className: "wg-field" },
      el("label", { for: id, text: label }),
      input,
      hint ? el("p", { className: "wg-hint", text: hint }) : null,
    );
  }

  function listEditor(key, itemLabel, max, maxItems) {
    const f = S.sel.form;
    const box = el(
      "div",
      { className: "wg-box" },
      el("div", { className: "wg-label", text: `${FIELD_LABELS[key]}（${maxItems} つまで）` }),
    );
    (f[key] ?? []).forEach((v, i) => {
      box.append(field(`${itemLabel} ${i + 1}`, v, (x) => (f[key][i] = x), { max }));
      box.append(el("button", {
        type: "button",
        className: "wg-btn danger",
        text: `${itemLabel} ${i + 1} を消す`,
        onclick: () => {
          f[key].splice(i, 1);
          touch();
          render();
        },
      }));
    });
    if ((f[key] ?? []).length < maxItems) {
      box.append(el(
        "div",
        { className: "wg-bar" },
        el("button", {
          type: "button",
          className: "wg-btn",
          text: `${itemLabel}を足す`,
          onclick: () => {
            (f[key] ??= []).push("");
            touch();
            render();
          },
        }),
      ));
    }
    return box;
  }

  function editor() {
    const sel = S.sel;
    const f = sel.form;
    const wrap = el("section", { "aria-labelledby": "wg-edit-h" });
    wrap.append(
      el("h3", { id: "wg-edit-h", text: sel.id ? `編集：${sel.name}` : `新しい${KIND_LABELS[sel.kind]}の案内` }),
    );
    wrap.append(
      el("p", { className: "wg-hint", text: `種類：${KIND_LABELS[sel.kind]}（作ったあとは変えられません）` }),
    );
    wrap.append(field("管理用の名前（60 字）", sel.name, (v) => (sel.name = v), { max: 60 }));
    wrap.append(
      field("メモ（受講者には届かない。400 字）", sel.note, (v) => (sel.note = v), { multiline: true, max: 400 }),
    );
    {
      const id = "wg-active";
      const cb = el("input", { id, type: "checkbox" });
      cb.checked = sel.active;
      cb.addEventListener("change", () => {
        sel.active = !!cb.checked;
        touch();
      });
      wrap.append(
        el(
          "div",
          { className: "wg-bar" },
          cb,
          el("label", { for: id, text: "有効（外すと、割り当てた段階でも案内を出さない）" }),
        ),
      );
    }
    wrap.append(el("p", {
      className: "wg-hint",
      text: "字数・文の数・音声で使う項目の合計（1,600 字）は、保存と公開のときに確かめ、直す所をここに出します。",
    }));
    wrap.append(field(`${FIELD_LABELS.theme}（60 字）`, f.theme, (v) => (f.theme = v), { max: 60 }));
    wrap.append(
      field(
        `${FIELD_LABELS.why_it_matters}（120 字・1 文。読み直しのときに AI がそのまま言う）`,
        f.why_it_matters,
        (v) => (f.why_it_matters = v),
        { multiline: true, max: 120 },
      ),
    );
    wrap.append(
      field(`${FIELD_LABELS.opening}（80 字・2 文まで・問いかけ 1 つ）`, f.opening, (v) => (f.opening = v), {
        multiline: true,
        max: 80,
      }),
    );
    wrap.append(field(`${FIELD_LABELS.goal}（120 字）`, f.goal, (v) => (f.goal = v), { multiline: true, max: 120 }));
    wrap.append(
      field(`${FIELD_LABELS.minimum}（100 字）`, f.minimum, (v) => (f.minimum = v), { multiline: true, max: 100 }),
    );

    const flow = el("div", { className: "wg-box" }, el("div", { className: "wg-label", text: "手順（7 つまで）" }));
    f.flow.forEach((s, i) => {
      const box = el("div", { className: "wg-box" }, el("div", { className: "wg-label", text: `手順 ${i + 1}` }));
      box.append(el(
        "div",
        { className: "wg-split" },
        field(`${FIELD_LABELS.step}（40 字）`, s.step, (v) => (s.step = v), { max: 40 }),
        field(`${FIELD_LABELS.first_question}（80 字）`, s.first_question, (v) => (s.first_question = v), { max: 80 }),
      ));
      box.append(el(
        "div",
        { className: "wg-sub" },
        el("p", { className: "wg-hint", text: "ここから下は AI の音声の文には載らない（AI が必要なときに読む）" }),
        el(
          "div",
          { className: "wg-split" },
          field(`${FIELD_LABELS.student_decides}（60 字）`, s.student_decides, (v) => (s.student_decides = v), {
            max: 60,
          }),
          field(`${FIELD_LABELS.ai_may_do}（了承のあと。80 字）`, s.ai_may_do, (v) => (s.ai_may_do = v), { max: 80 }),
        ),
      ));
      if (f.flow.length > 1) {
        box.append(el("button", {
          type: "button",
          className: "wg-btn danger",
          text: `手順 ${i + 1} を消す`,
          onclick: () => {
            f.flow.splice(i, 1);
            touch();
            render();
          },
        }));
      }
      flow.append(box);
    });
    if (f.flow.length < 7) {
      flow.append(el(
        "div",
        { className: "wg-bar" },
        el("button", {
          type: "button",
          className: "wg-btn",
          text: "手順を足す",
          onclick: () => {
            f.flow.push({ step: "", first_question: "", student_decides: "", ai_may_do: "" });
            touch();
            render();
          },
        }),
      ));
    }
    wrap.append(flow);
    wrap.append(listEditor("done_when", "完成の目安", 50, 5));
    wrap.append(listEditor("optional_polish", "任意の仕上げ", 30, 4));
    wrap.append(listEditor("avoid", "やってはいけないこと", 60, 5));
    wrap.append(
      field(`${FIELD_LABELS.coaching_note}（200 字）`, f.coaching_note, (v) => (f.coaching_note = v), {
        multiline: true,
        max: 200,
      }),
    );

    wrap.append(
      el("div", { className: "wg-line", text: "ここから下は AI の音声の文には載らない（AI が必要なときに読む）" }),
    );
    wrap.append(
      field(`${FIELD_LABELS.materials}（120 字）`, f.materials, (v) => (f.materials = v), {
        multiline: true,
        max: 120,
      }),
    );
    const hints = el("div", { className: "wg-box" }, el("div", { className: "wg-label", text: "ヒント（6 つまで）" }));
    f.hints.forEach((h, i) => {
      hints.append(el(
        "div",
        { className: "wg-split" },
        field(`ヒント ${i + 1}：${FIELD_LABELS.when}（40 字）`, h.when, (v) => (h.when = v), { max: 40 }),
        field(`ヒント ${i + 1}：${FIELD_LABELS.say}（120 字）`, h.say, (v) => (h.say = v), { max: 120 }),
      ));
      hints.append(el("button", {
        type: "button",
        className: "wg-btn danger",
        text: `ヒント ${i + 1} を消す`,
        onclick: () => {
          f.hints.splice(i, 1);
          touch();
          render();
        },
      }));
    });
    if (f.hints.length < 6) {
      hints.append(el(
        "div",
        { className: "wg-bar" },
        el("button", {
          type: "button",
          className: "wg-btn",
          text: "ヒントを足す",
          onclick: () => {
            f.hints.push({ when: "", say: "" });
            touch();
            render();
          },
        }),
      ));
    }
    wrap.append(hints);
    if (sel.kind === "workshop") {
      wrap.append(field(FIELD_LABELS.finish_minutes, String(f.finish_minutes ?? ""), (v) => (f.finish_minutes = v), {
        type: "number",
        hint: "5〜60 分。既定は 20。制作時間の残りがこの分になったら、AI が仕上げを手伝う進め方に替える。",
      }));
    } else {
      wrap.append(
        el("p", {
          className: "wg-hint",
          text: "ブリッジワークは時間に触れないので、仕上げに切り替える残り時間はありません。",
        }),
      );
    }

    const warns = forbiddenWarnings(toBody(f, sel.kind));
    if (warns.length) {
      wrap.append(
        el(
          "div",
          { className: "wg-msg warn" },
          el("div", { text: "受講者に届く文の言葉" }),
          el("ul", {}, ...warns.map((w) => el("li", { text: w }))),
        ),
      );
    }
    if (S.problem) {
      wrap.append(el("div", { className: "wg-msg warn" }, el("div", { text: `公開する前に直すこと：${S.problem}` })));
    }

    wrap.append(el(
      "div",
      { className: "wg-bar" },
      el("button", {
        type: "button",
        className: "wg-btn primary",
        text: "下書きを保存",
        disabled: S.busy,
        onclick: () => save(),
      }),
      publishBtnRef = el("button", {
        type: "button",
        className: "wg-btn",
        text: "公開する…",
        disabled: S.busy || !sel.id || S.dirty,
        "aria-disabled": S.busy || !sel.id || S.dirty ? "true" : undefined,
        onclick: () => askPublish(),
      }),
      publishHintRef = el("span", {
        className: "wg-hint",
        text: !sel.id || S.dirty ? "公開は、下書きを保存してからできます。" : "",
      }),
    ));
    wrap.append(
      el("p", { className: "wg-hint", text: "11/18 のあとは、田口さんの承認を取ってから公開してください。" }),
    );
    return wrap;
  }

  function guidesView() {
    const frag = document.createDocumentFragment();
    frag.append(el(
      "div",
      { className: "wg-bar" },
      el("button", {
        type: "button",
        className: "wg-btn",
        text: "新しいワークショップの案内",
        onclick: () => newGuide("workshop"),
      }),
      el("button", {
        type: "button",
        className: "wg-btn",
        text: "新しいブリッジワークの案内",
        onclick: () => newGuide("bridge"),
      }),
    ));
    if (S.guidesError) {
      frag.append(el("div", { className: "wg-msg err", text: `一覧を読めませんでした。${S.guidesError}` }));
    } else if (S.guides === null) frag.append(el("p", { text: "読み込んでいます…" }));
    else if (!S.guides.length) frag.append(el("p", { className: "wg-hint", text: "まだ案内がありません。" }));
    else {
      const t = el("table");
      const head = el("tr");
      for (const h of ["名前", "種類", "公開", "下書き", "割り当て", "公開の経路", "有効"]) {
        head.append(el("th", { scope: "col", text: h }));
      }
      t.append(el("thead", {}, head));
      const tb = el("tbody");
      for (const g of S.guides) {
        const r = guideListRow(g);
        tb.append(el(
          "tr",
          {},
          el(
            "td",
            {},
            el("button", {
              type: "button",
              className: "wg-row-btn",
              text: r.name,
              "aria-current": S.sel?.id === r.id ? "true" : undefined,
              onclick: () => chooseGuide(r.id),
            }),
          ),
          el("td", { "data-label": "種類", text: r.kind }),
          el("td", { "data-label": "公開", text: r.state }),
          el("td", { "data-label": "下書き", text: r.draft || "—" }),
          el("td", { "data-label": "割り当て", text: r.assigned }),
          el("td", { "data-label": "公開の経路", text: r.via || "—" }),
          el("td", { "data-label": "有効", text: r.active ? "有効" : "無効" }),
        ));
      }
      t.append(tb);
      frag.append(t);
    }
    publishBtnRef = null;
    publishHintRef = null;
    if (S.sel) frag.append(editor());
    return frag;
  }

  function assignView() {
    const frag = document.createDocumentFragment();
    if (S.cohorts === null) {
      frag.append(el("p", { text: "読み込んでいます…" }));
      return frag;
    }
    const sel = el("select", { id: "wg-cohort" });
    sel.append(el("option", { value: "", text: "回を選んでください" }));
    for (const o of cohortOptions(S.cohorts)) {
      const opt = el("option", { value: o.id, text: o.label });
      if (o.id === S.cohortId) opt.selected = true;
      sel.append(opt);
    }
    sel.value = S.cohortId;
    sel.addEventListener("change", () => chooseCohort(sel.value));
    frag.append(el("div", { className: "wg-field" }, el("label", { for: "wg-cohort", text: "回" }), sel));
    if (S.assignError) frag.append(el("div", { className: "wg-msg err", text: S.assignError }));
    if (!S.cohortId) return frag;
    if (!S.assign) {
      if (!S.assignError) frag.append(el("p", { text: "読み込んでいます…" }));
      return frag;
    }
    const stages = S.assign.stages ?? [];
    if (!stages.length) {
      frag.append(
        el("p", {
          className: "wg-hint",
          text: "この回には段階がありません（段階の回ではないか、テンプレートを当てていません）。",
        }),
      );
    } else {
      const t = el("table");
      const head = el("tr");
      for (const h of ["日", "段階", "案内", "時刻表の目安（日本時間）", ""]) {
        head.append(el("th", { scope: "col", text: h }));
      }
      t.append(el("thead", {}, head));
      const tb = el("tbody");
      for (const s of stages) {
        const key = `${S.cohortId}|${s.stage_id}`;
        const d = S.rowDrafts.get(key) ??
          { guide: s.guide_id ?? "", start: timeField(s.planned_start), end: timeField(s.planned_end) };
        const g = el("select", { "aria-label": `${stageName(s)}の案内` });
        g.append(el("option", { value: "", text: "案内なし" }));
        for (const o of guideOptionsFor(s.day_kind, S.guides)) {
          const opt = el("option", { value: o.id, text: o.label });
          if (o.id === d.guide) opt.selected = true;
          g.append(opt);
        }
        g.value = d.guide;
        let timeCell;
        let start = null, end = null;
        if (s.day_kind === "bridge") {
          timeCell = el("td", {
            className: "wg-hint",
            "data-label": "時刻表の目安",
            text: "—（ブリッジワークは時間に触れない）",
          });
        } else {
          start = el("input", { type: "time", "aria-label": `${stageName(s)}の始まり` });
          end = el("input", { type: "time", "aria-label": `${stageName(s)}の終わり` });
          start.value = d.start;
          end.value = d.end;
          timeCell = el(
            "td",
            { className: "wg-stack", "data-label": "時刻表の目安" },
            el("span", { className: "wg-times" }, start, el("span", { text: "〜" }), end),
          );
        }
        // 入れたものを行の下書きに残す（ほかの行の保存や、この行の誤りで描き直しても消えない）
        const keep = () => S.rowDrafts.set(key, { guide: g.value, start: start?.value ?? "", end: end?.value ?? "" });
        g.addEventListener("change", keep);
        for (const t of [start, end]) {
          if (!t) continue;
          t.addEventListener("input", keep);
          t.addEventListener("change", keep);
        }
        const rowErr = S.rowErrors.get(key);
        tb.append(el(
          "tr",
          {},
          el("td", { "data-label": "日", text: DAY_LABELS[s.day_kind] ?? s.day_kind }),
          el("td", { "data-label": "段階", text: stageName(s) }),
          el("td", { className: "wg-stack", "data-label": "案内" }, g),
          timeCell,
          el(
            "td",
            {},
            el("button", {
              type: "button",
              className: "wg-btn",
              text: "保存",
              disabled: S.busy,
              onclick: () => saveAssignment(s, key, g.value, start?.value, end?.value),
            }),
            rowErr ? el("p", { className: "wg-row-err", role: "alert", text: rowErr }) : null,
          ),
        ));
      }
      t.append(tb);
      frag.append(t);
    }
    for (const o of S.assign.orphans ?? []) {
      frag.append(el(
        "div",
        { className: "wg-msg warn" },
        el("span", {
          text: `この段階は今はありません（案内「${
            o.guide_name ?? ""
          }」の割り当てが残っています。受講者には出ません）。`,
        }),
        el("button", {
          type: "button",
          className: "wg-btn",
          text: "外す",
          disabled: S.busy,
          onclick: () =>
            saveAssignment({ stage_id: o.stage_id, day_kind: "bridge", label: "今はない段階" }, null, "", null, null),
        }),
      ));
    }
    return frag;
  }

  function render() {
    if (checkClosed()) return;
    for (const b of tabs.children) {
      const on = b.getAttribute("data-key") === S.tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    const parts = [];
    if (S.confirm) {
      const c = S.confirm;
      parts.push(el(
        "div",
        { className: "wg-confirm", role: "alertdialog", "aria-label": "確かめ" },
        el("p", { text: c.text }),
        el(
          "div",
          { className: "wg-bar" },
          el("button", {
            type: "button",
            className: "wg-btn primary",
            text: c.okLabel,
            onclick: async () => {
              S.confirm = null;
              await c.ok();
              render();
            },
          }),
          el("button", {
            type: "button",
            className: "wg-btn",
            text: "やめる",
            onclick: () => {
              S.confirm = null;
              render();
            },
          }),
        ),
      ));
    }
    parts.push(S.tab === "guides" ? guidesView() : assignView());
    body.replaceChildren(...parts);
  }

  return { open, dispose };
}
