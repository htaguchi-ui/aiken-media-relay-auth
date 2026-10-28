// 管理コンソールの［ワークショップの案内］（docs/design-workshop-guide.md 第 1.3.1 版 4.6。束 K の K3。
// .orchestration/workshop-ui-20261028/DESIGN.md 第 I 部〔組 8〕で、回を起点の画面に作り替えた）。
// 左のメニュー（#side-menu）の最後に［案内］を 1 つ足し、押すと自分の <dialog> を開く。中は 2 つのつまみ：
//   ［回ごと］回を選ぶ → 段階ごとに案内・公開の札・予定の時刻。行で選び、固定の帯の［まとめて保存］で付ける。行の［開く］で右に編集
//   ［案内の一覧］名前・公開の札・使っている所。名前を押すと右に編集
// 編集は必ず書く 5 欄（テーマ・大切なこと・目標・最低限の完成・手順）と「詳しく（任意）」。最初のひと言・管理用の名前・仕上げの分は
// 画面が既定で埋める（最初のひと言は「{大切なこと}まずは「{手順 1}」から、{問いかけ}」。［書き直す］で手で直せる。
// 作った文が 80 字・2 文・問い 1 に収まらないときは、欄から出たときと保存を押したときに、作った文を入れた欄を開く）。
// 確かめは管理コンソールの ask()／askDiscard()（引数で受け取る。画面の真ん中に必ず見える）。渡されないとき（古い admin.js）は、
// 確かめを固定の帯の中（押したボタンのすぐ上）に描いてフォーカスを移す。
// admin.js の内部の状態には依存しない。受け取るのは Supabase の client と、ボタンを足す親（#side-menu）と、閉じたかを返す関数と、確かめの関数だけ
// （admin.js の入口は動的な import の数行。読み込めない・失敗しても［案内］が出ないだけで、ほかの画面は止まらない）。
// 管理コンソールが閉じたら（isClosed が真・メニューが外れた・#app が隠れた）、窓を閉じて消し、読んだ中身も消す。
// 閉じたあと・新しい読み込みのあとに戻った古い応答は描かない（読み込みごとの番号の確かめ）。
// 表示はすべて createElement / textContent で組み立てる（データを innerHTML に入れない）。読み書きは DB の管理の RPC と、
// cohorts の枠の列（id, credit_mode, stage_template_id）の読みだけ（admin_workshop_guides・admin_save_workshop_guide・
// admin_publish_workshop_guide・admin_cohorts・admin_cohort_stage_guides・admin_set_cohort_stage_guide。どれも中で is_admin()）。
// 字数の検査は DB が行い、その理由をその欄の下に出す（正は DB）。組 8b の関数は呼ばない。
import {
  activeAsk,
  assignmentArgs,
  bulkSaveText,
  cohortOptions,
  composeOpening,
  defaultCohortId,
  deriveName,
  emptyGuide,
  errorField,
  explainError,
  FIELD_LABELS,
  forbiddenWarnings,
  guideListRow,
  guideOptionsFor,
  guideState,
  KIND_LABELS,
  missingRequired,
  nameErrorText,
  openingFits,
  openingIsDefault,
  problemTarget,
  publishAsk,
  stageRowName,
  timeField,
  todayJst,
  toBody,
  toForm,
  usedIn,
  usedInText,
  withDefaults,
} from "./admin-workshop-lib.js";

const STYLE_ID = "workshop-guide-style";
const CSS = `
dialog.wg-dialog { width: min(1180px, 96vw); height: 92vh; max-height: 92vh; padding: 0; border: 1px solid var(--line, #E3E6EB);
  border-radius: 16px; background: var(--surface, #fff); color: var(--text, #16181D); overflow: hidden; }
/* 窓は縦に並べ、左右の欄の中身（.wg-scroll）だけをスクロールする。帯（.wg-band）は欄の下に固定 */
dialog.wg-dialog[open] { display: flex; flex-direction: column; }
dialog.wg-dialog::backdrop { background: var(--scrim, rgba(26, 30, 38, 0.62)); }
.wg-head, .wg-top, .wg-msgwrap { flex: none; }
.wg-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line, #E3E6EB); }
.wg-head h2 { margin: 0; font-size: 16px; }
.wg-head .wg-grow { flex: 1; }
.wg-top { padding: 8px 16px 0; }
.wg-intro { margin: 0 0 6px; font-size: 13px; color: var(--text-2, #4A505B); }
.wg-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.wg-tabs button { min-height: 34px; padding: 0 12px; border-radius: 17px; border: 1px solid var(--line-2, #DDE1E7);
  background: var(--surface, #fff); color: var(--text, #16181D); font: inherit; font-size: 13px; cursor: pointer; }
.wg-tabs button[aria-selected="true"] { background: var(--accent, #26396E); color: var(--on-accent, #fff); border-color: var(--accent, #26396E); }
.wg-msgwrap { padding: 0 16px; max-height: 24vh; overflow: auto; }
.wg-main { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); border-top: 1px solid var(--line, #E3E6EB); margin-top: 8px; }
.wg-main.wg-editing { grid-template-columns: minmax(250px, 330px) minmax(0, 1fr); }
.wg-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.wg-pane.wg-right { border-left: 1px solid var(--line, #E3E6EB); }
.wg-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 16px 12px; }
.wg-band { flex: none; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 16px;
  border-top: 1px solid var(--line, #E3E6EB); background: var(--surface-2, #F6F7F9); }
.wg-band .wg-band-text { flex: 1 1 auto; min-width: 0; font-size: 13px; }
.wg-scroll h3 { font-size: 15px; margin: 4px 0; overflow-wrap: anywhere; }
.wg-scroll table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.wg-scroll th, .wg-scroll td { border-bottom: 1px solid var(--line-soft, #EEF0F3); padding: 5px 6px; text-align: left; vertical-align: middle;
  overflow-wrap: anywhere; }
.wg-scroll th { color: var(--muted, #4C525F); font-weight: 600; }
.wg-row-btn { all: unset; cursor: pointer; color: var(--accent, #26396E); font-weight: 600; overflow-wrap: anywhere; }
.wg-row-btn[aria-current="true"] { text-decoration: underline; }
.wg-row-btn:focus-visible, .wg-btn:focus-visible, .wg-q:focus-visible { outline: 2px solid var(--accent, #26396E); outline-offset: 2px; }
.wg-btn { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-2, #DDE1E7); background: var(--surface, #fff);
  color: var(--text, #16181D); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.wg-btn.small { min-height: 28px; padding: 0 8px; font-size: 12.5px; }
.wg-btn.primary { background: var(--accent, #26396E); color: var(--on-accent, #fff); border-color: var(--accent, #26396E); }
.wg-btn.danger { color: var(--danger, #96413A); }
.wg-btn:disabled { opacity: 0.5; cursor: default; }
.wg-q { min-width: 22px; min-height: 22px; border-radius: 11px; border: 1px solid var(--line-2, #DDE1E7); background: var(--surface, #fff);
  color: var(--muted, #4C525F); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; padding: 0 6px; }
.wg-qtext { font-size: 12.5px; color: var(--text-2, #4A505B); background: var(--surface-2, #F6F7F9); border-radius: 8px; padding: 6px 10px; margin: 4px 0; }
.wg-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
.wg-field { display: flex; flex-direction: column; gap: 3px; margin: 5px 0; }
.wg-field label, .wg-label { font-size: 12.5px; font-weight: 600; color: var(--text-2, #4A505B); }
.wg-req { color: var(--danger, #96413A); margin-left: 2px; }
.wg-field input, .wg-field textarea, .wg-field select, .wg-scroll select, .wg-scroll input[type="time"], .wg-step input {
  font: inherit; font-size: 14px; border: 1px solid var(--input-line, #C9CED6); border-radius: 8px; padding: 5px 8px;
  background: var(--surface, #fff); color: var(--text, #16181D); min-width: 0; }
/* 文の欄は中身に合わせて伸びる（短い文で 3 行分の高さを取らない） */
.wg-field textarea { min-height: 36px; resize: vertical; field-sizing: content; }
.wg-scroll input[type="time"] { width: 7.2em; padding: 4px 4px; }
/* ［まとめて保存］の最中など、押せない欄は薄く */
.wg-scroll select:disabled, .wg-scroll input:disabled { opacity: 0.55; cursor: default; }
.wg-box { border: 1px solid var(--line, #E3E6EB); border-radius: 12px; padding: 6px 10px; margin: 6px 0; }
.wg-step { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.3fr) auto; gap: 6px; align-items: center; margin: 4px 0; }
.wg-step input, .wg-step-q { width: 100%; box-sizing: border-box; }
.wg-step-q { display: flex; }
.wg-step .wg-num { font-weight: 700; color: var(--muted, #4C525F); min-width: 1.2em; }
.wg-step .wg-step-ops { display: inline-flex; gap: 2px; }
.wg-step-more { grid-column: 2 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.wg-hint { font-size: 12px; color: var(--muted, #4C525F); margin: 2px 0; }
.wg-state { font-size: 12.5px; margin: 2px 0; }
.wg-tone-ok { color: var(--ok-fg, #3D5B45); }
.wg-tone-warn { color: var(--warn-fg, #74512C); font-weight: 600; }
.wg-tone-muted { color: var(--muted, #4C525F); }
.wg-unsaved { color: var(--warn-fg, #74512C); font-weight: 700; font-size: 12px; white-space: nowrap; }
.wg-opening { margin: 2px 0; padding: 6px 10px; border-radius: 8px; background: var(--surface-2, #F6F7F9); font-size: 14px; }
.wg-msg { border-radius: 10px; padding: 8px 12px; margin: 8px 0 0; font-size: 13px; }
.wg-msg.ok { background: var(--ok-bg, #EEF5F0); color: var(--ok-fg, #3D5B45); }
.wg-msg.warn { background: var(--warn-bg, #F5EFE7); color: var(--warn-fg, #74512C); }
.wg-msg.err { background: var(--surface-2, #F6F7F9); color: var(--danger, #96413A); border: 1px solid var(--danger-line, #E2CDC9); }
.wg-row-err { color: var(--danger, #96413A); font-size: 12.5px; margin: 2px 0 0; }
.wg-msg ul { margin: 4px 0 0; padding-left: 18px; }
.wg-confirm { flex: 1 1 100%; border: 2px solid var(--accent, #26396E); border-radius: 12px; padding: 8px 12px; background: var(--surface, #fff); }
.wg-confirm p { margin: 2px 0; font-size: 13px; }
.wg-scroll td select { width: 100%; }
.wg-times { display: inline-flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
.wg-ops { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
details.wg-more > summary { cursor: pointer; font-size: 13px; font-weight: 600; margin: 8px 0 4px; }
@media (max-width: 699.98px) {
  /* 狭い幅は 1 列で「一覧 → 編集」と進む。編集を開いたら一覧を隠し、［← 段階の一覧］で戻る（広い幅でも、同じボタンで編集を閉じて表に戻る） */
  .wg-main.wg-editing { grid-template-columns: minmax(0, 1fr); }
  .wg-main.wg-editing .wg-left { display: none; }
  .wg-pane.wg-right { border-left: 0; }
  .wg-head { padding: 8px 10px; }
  .wg-top, .wg-msgwrap { padding-left: 10px; padding-right: 10px; }
  .wg-scroll { padding: 6px 10px 10px; }
  .wg-band { padding: 6px 10px; }
  .wg-step { grid-template-columns: auto minmax(0, 1fr); }
  .wg-step .wg-step-q, .wg-step .wg-step-ops, .wg-step-more { grid-column: 2 / -1; }
  .wg-step-more { grid-template-columns: 1fr; }
  /* 表の 1 行を 1 枚のカードにする（段階は 4 段：名前・選択・札・時刻と操作） */
  .wg-scroll table, .wg-scroll tbody, .wg-scroll tr, .wg-scroll td { display: block; width: auto; }
  .wg-scroll thead { display: none; }
  .wg-scroll tr { border: 1px solid var(--line, #E3E6EB); border-radius: 12px; padding: 4px 10px; margin: 6px 0; }
  .wg-scroll td { border: 0; padding: 2px 0; }
  .wg-scroll td[data-label]::before { content: attr(data-label) "："; color: var(--muted, #4C525F); font-weight: 600; margin-right: 4px; }
  .wg-scroll td.wg-ops-cell { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
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

/** 見出しの ？ の中身（3.2。組 8b で 1 文目を替える） */
const HELP_MAIN =
  "段階ごとに案内を選び、［まとめて保存］で付けます。公開した版は、受講者の AI が次に案内を読み直したときから使われます。受講者の AI に届くのは、段階ごとの枠の回で、受講者向けのスイッチ（WORKSHOP_GUIDE）が入っているときだけです。";
/** 最初のひと言の ？ の中身（3.3） */
const HELP_OPENING = "大切なことと手順 1 から、画面が作ります。直したいときは［書き直す］を押してください。";
/** 既定の最初のひと言を DB が断ったとき（3.9 の表） */
const OPENING_TOO_LONG = "自動で作った最初のひと言が長すぎます。［書き直す］で短くするか、大切なことを短くしてください。";

/**
 * 左のメニューに［案内］を足す。返り：{ open, dispose }
 * @param {{ supabase: any, menu: any, isClosed?: () => boolean,
 *   ask?: (o: any) => Promise<any>, askDiscard?: (what?: string, okLabel?: string) => Promise<boolean> }} opts
 */
export function mountWorkshopGuide({ supabase, menu, isClosed, ask, askDiscard }) {
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
  const main = el("div", { className: "wg-main" });
  const tabs = el("div", { className: "wg-tabs", role: "tablist", "aria-label": "案内の見方" });
  const VIEWS = [{ key: "cohort", label: "回ごと" }, { key: "list", label: "案内の一覧" }];
  for (const t of VIEWS) {
    tabs.append(
      el("button", { type: "button", role: "tab", "data-key": t.key, text: t.label, onclick: () => switchView(t.key) }),
    );
  }
  const helpMain = el("p", { className: "wg-qtext", hidden: true, text: HELP_MAIN });
  const helpMainBtn = el("button", {
    type: "button",
    className: "wg-q",
    text: "?",
    title: HELP_MAIN,
    "aria-label": "この画面の説明",
    "aria-expanded": "false",
    onclick: () => {
      helpMain.hidden = !helpMain.hidden;
      helpMainBtn.setAttribute("aria-expanded", helpMain.hidden ? "false" : "true");
    },
  });
  dialog.append(
    el(
      "div",
      { className: "wg-head" },
      el("h2", { id: "wg-title", text: "ワークショップの案内" }),
      helpMainBtn,
      el("span", { className: "wg-grow" }),
      el("button", { type: "button", className: "wg-btn", text: "最新にする", onclick: () => reload() }),
      el("button", { type: "button", className: "wg-btn", text: "閉じる", onclick: () => requestClose() }),
    ),
    el(
      "div",
      { className: "wg-top" },
      helpMain,
      el("p", { className: "wg-intro", text: "受講者の AI が、ワークショップの進め方として読む案内です。" }),
      tabs,
    ),
    el("div", { className: "wg-msgwrap" }, msg),
    main,
  );
  document.body.append(dialog);

  const S = {
    view: "cohort",
    guides: null,
    guidesError: "",
    cohorts: null,
    cohortsError: "",
    /** 回の id → { credit_mode, stage_template_id }。読めなければ null（framesError） */
    frames: null,
    framesError: false,
    /** 回の id → admin_cohort_stage_guides の返り（使っている所と回ごとの表）・読めなかった回の誤り */
    assign: new Map(),
    assignErrors: new Map(),
    cohortId: "",
    /** 編集中の案内：{ id, kind, name, note, active, sha, form, openingAuto, saved: { name, note, active, draft }, attach } */
    sel: null,
    dirty: false,
    showMissing: false,
    /** DB の検査の理由：{ text, area, key } */
    problem: null,
    nameError: "",
    nameEditing: false,
    stepOpen: new Set(),
    detailsOpen: false,
    openingHelp: false,
    busy: false,
    /** 確かめ（ask が渡されないときだけ。帯の中に描く）：{ spec, resolve } */
    confirm: null,
    // 回への割り当ての行ごとの保存していない入力（回と段階で 1 つ）と、その行の誤り（F240-02）
    rowDrafts: new Map(),
    rowErrors: new Map(),
  };
  // 選んでいる案内・窓が替わるたびに進める番号（確かめを出した時点の対象を、あとで替わっていないか確かめる。F240-01）
  let epoch = 0;
  // 読み込みごとの番号（新しい読み込みのあとに戻った古い応答は描かない）
  const seq = { guides: 0, cohorts: 0, frames: 0, assign: new Map() };
  // 文字を入れたときに、描き直さずに状態だけ替える所（F240-05）
  let live = null;
  let disposed = false;
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
    epoch++;
    clearInterval(timer);
    observer?.disconnect();
    cancelInlineConfirm();
    if (dialog.open) dialog.close();
    main.replaceChildren();
    msg.replaceChildren();
    dialog.remove();
    entry.remove();
    S.guides = null;
    S.sel = null;
    S.cohorts = null;
    S.assign = new Map();
    S.rowDrafts.clear();
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
    try {
      const { data, error } = args === undefined ? await supabase.rpc(name) : await supabase.rpc(name, args);
      return { data, error };
    } catch (e) {
      return { data: null, error: { message: String(e?.message ?? e) } };
    }
  }

  // ---- 確かめ（ask() か、帯の中の確かめ） ----

  /** spec：{ title, lines, warnings, detail, note, okLabel, kind, cancelLabel, where }。押したら true */
  async function confirmAsk(spec) {
    if (typeof ask === "function") {
      const v = await ask({
        title: spec.title,
        lines: spec.lines ?? [],
        warnings: spec.warnings ?? [],
        detail: spec.detail ?? [],
        note: spec.note ?? null,
        buttons: [
          { label: spec.cancelLabel ?? "やめる", value: false },
          { label: spec.okLabel, value: true, kind: spec.kind ?? "primary" },
        ],
        cancelValue: false,
      });
      return v === true;
    }
    cancelInlineConfirm();
    return await new Promise((resolve) => {
      S.confirm = { spec, resolve };
      render();
      live?.confirmCancel?.focus?.();
    });
  }
  function cancelInlineConfirm() {
    const c = S.confirm;
    if (!c) return;
    S.confirm = null;
    c.resolve(false);
  }
  /** 保存していない変更を捨ててよいか（［編集を続ける］が既定） */
  async function confirmDiscard(what, okLabel) {
    if (typeof askDiscard === "function") return (await askDiscard(what, okLabel)) === true;
    return await confirmAsk({
      title: "保存していない変更を破棄しますか？",
      lines: [`${what}は、まだ保存していません。`],
      okLabel,
      kind: "danger",
      cancelLabel: "編集を続ける",
      where: S.sel ? "editor" : "left",
    });
  }
  const hasRowDrafts = () => S.rowDrafts.size > 0;
  function unsavedWhat({ editor = true, rows = true } = {}) {
    const e = editor && S.dirty, r = rows && hasRowDrafts();
    if (e && r) return "案内の入力と、段階の行で選んだ案内・時刻";
    if (e) return "案内の入力";
    if (r) return "段階の行で選んだ案内・時刻";
    return "";
  }
  /** 未保存（編集の欄・行の下書き）があれば確かめる。破棄したら消す。続けてよければ true */
  async function guardUnsaved(okLabel, { editor = true, rows = true } = {}) {
    const what = unsavedWhat({ editor, rows });
    if (!what) return true;
    const ok = await confirmDiscard(what, okLabel);
    if (!ok || checkClosed()) return false;
    if (editor && S.dirty) {
      S.dirty = false;
      if (S.sel?.id) selectGuide(S.sel.id, { keepMsg: true });
      else closeEditor();
    }
    if (rows) {
      S.rowDrafts.clear();
      S.rowErrors.clear();
    }
    return true;
  }

  // ---- 読み込み ----

  async function loadGuides() {
    const my = ++seq.guides;
    const { data, error } = await rpc("admin_workshop_guides");
    if (my !== seq.guides || checkClosed()) return false;
    S.guides = error ? null : (data ?? []);
    S.guidesError = error ? explainError(error) : "";
    return !error;
  }
  async function loadCohorts() {
    const my = ++seq.cohorts;
    const { data, error } = await rpc("admin_cohorts");
    if (my !== seq.cohorts || checkClosed()) return;
    S.cohorts = error ? [] : (data ?? []);
    S.cohortsError = error ? explainError(error) : "";
  }
  /** 回の枠（credit_mode）。admin_cohorts は返さないので cohorts の列を読む。読めなければ null（札は今の判定のまま） */
  async function loadFrames() {
    const my = ++seq.frames;
    let res;
    try {
      res = typeof supabase.from === "function"
        ? await supabase.from("cohorts").select("id, credit_mode, stage_template_id")
        : { data: null, error: { message: "no table api" } };
    } catch (e) {
      res = { data: null, error: { message: String(e) } };
    }
    if (my !== seq.frames || checkClosed()) return;
    S.frames = res?.error ? null : new Map((res?.data ?? []).map((x) => [x.id, x]));
    S.framesError = !!res?.error;
  }
  async function loadAssignFor(cid) {
    if (!cid) return;
    const my = (seq.assign.get(cid) ?? 0) + 1;
    seq.assign.set(cid, my);
    const { data, error } = await rpc("admin_cohort_stage_guides", { p_cohort_id: cid });
    if (my !== seq.assign.get(cid) || checkClosed()) return;
    if (error) {
      S.assign.delete(cid);
      S.assignErrors.set(cid, explainError(error));
    } else {
      S.assign.set(cid, data ?? { stages: [], orphans: [] });
      S.assignErrors.delete(cid);
    }
  }
  /** 使っている所のために、終わっていない回（と選んでいる回）の割り当てを読む */
  async function loadAssignAll() {
    const ids = (S.cohorts ?? []).filter((c) => c.current_period !== "after" || c.id === S.cohortId).map((c) => c.id);
    await Promise.all(ids.map((id) => loadAssignFor(id)));
  }
  async function loadAll() {
    await Promise.all([loadGuides(), loadCohorts(), loadFrames()]);
    if (checkClosed()) return;
    if (!S.cohortId || !(S.cohorts ?? []).some((c) => c.id === S.cohortId)) S.cohortId = defaultCohortId(S.cohorts, todayJst());
    await loadAssignAll();
  }
  async function reload() {
    if (checkClosed() || S.busy) return;
    if (!(await guardUnsaved("破棄して最新にする"))) return;
    await loadAll();
    if (checkClosed()) return;
    if (S.sel?.id) selectGuide(S.sel.id, { keepMsg: true });
    render();
  }

  async function open() {
    if (checkClosed()) return;
    if (!dialog.open) dialog.showModal();
    cancelInlineConfirm();
    setMsg("", "");
    render();
    await loadAll();
    render();
  }
  entry.addEventListener("click", () => open());

  function closeNow() {
    epoch++;
    cancelInlineConfirm();
    S.sel = null;
    S.dirty = false;
    S.problem = null;
    S.rowDrafts.clear();
    S.rowErrors.clear();
    live = null;
    if (dialog.open) dialog.close();
  }
  async function requestClose() {
    if (S.busy || checkClosed()) return;
    if (!(await guardUnsaved("破棄して閉じる"))) return;
    closeNow();
  }
  dialog.addEventListener("cancel", (e) => {
    if (S.dirty || S.busy || hasRowDrafts() || S.confirm) {
      e.preventDefault?.();
      if (S.confirm) cancelInlineConfirm();
      else if (!S.busy) requestClose();
    } else closeNow();
  });

  async function switchView(key) {
    if (S.view === key || checkClosed() || S.busy) return;
    if (!(await guardUnsaved("破棄して移る"))) return;
    S.view = key;
    closeEditor();
    render();
  }

  // ---- 編集の欄 ----

  const guideById = (id) => (S.guides ?? []).find((x) => x.id === id) ?? null;

  function selectGuide(id, { keepMsg = false } = {}) {
    const g = guideById(id);
    epoch++;
    cancelInlineConfirm();
    if (!g) {
      S.sel = null;
      return;
    }
    const form = toForm(g.draft, g.kind);
    S.sel = {
      id: g.id,
      kind: g.kind,
      name: g.name,
      note: g.note ?? "",
      active: g.active !== false,
      sha: g.draft_sha256,
      form,
      openingAuto: openingIsDefault(form),
      saved: { name: g.name, note: g.note ?? "", active: g.active !== false, draft: g.draft },
      attach: null,
    };
    S.dirty = false;
    S.showMissing = true;
    S.problem = null;
    S.nameError = "";
    S.nameEditing = false;
    S.stepOpen = new Set();
    S.detailsOpen = false;
    if (!keepMsg) setMsg("", "");
  }
  function closeEditor() {
    epoch++;
    cancelInlineConfirm();
    S.sel = null;
    S.dirty = false;
    S.problem = null;
    S.nameError = "";
  }
  /** 編集を開いた操作のあとだけ、編集の見出しを見える所へ移して focus する（描き直しのたびには動かさない） */
  function showEditor() {
    const h = live?.editHead;
    if (!h) return;
    h.setAttribute("tabindex", "-1");
    h.scrollIntoView?.({ block: "start" });
    h.focus?.();
  }
  async function chooseGuide(id) {
    if (S.busy || checkClosed()) return;
    if (S.sel?.id === id && !S.dirty) {
      showEditor();
      return;
    }
    if (!(await guardUnsaved("破棄して開く", { rows: false }))) return;
    selectGuide(id);
    render();
    showEditor();
  }
  /** 新しい案内。stage があれば、その段階から名前を作り、最初の保存が通ったらその段階に付ける */
  async function newGuide(kind, stage = null) {
    if (S.busy || checkClosed()) return;
    if (!(await guardUnsaved("破棄して新しく作る", { rows: false }))) return;
    epoch++;
    cancelInlineConfirm();
    const names = (S.guides ?? []).map((g) => g.name);
    S.sel = {
      id: null,
      kind,
      name: deriveName({ stage, names }),
      note: "",
      active: true,
      sha: null,
      form: emptyGuide(kind),
      openingAuto: true,
      saved: null,
      attach: stage ? { cohortId: S.cohortId, stage } : null,
    };
    S.dirty = false;
    S.showMissing = false;
    S.problem = null;
    S.nameError = "";
    S.nameEditing = false;
    S.stepOpen = new Set();
    S.detailsOpen = false;
    setMsg("", "");
    render();
    showEditor();
  }
  async function backToList() {
    if (S.busy) return;
    if (!(await guardUnsaved("破棄して戻る", { rows: false }))) return;
    closeEditor();
    render();
  }

  function touch() {
    S.dirty = true;
    updateLive();
  }

  /** 文字を入れたときに、描き直さずに替える所（帯の数・公開のボタン・必須の印・最初のひと言） */
  function updateLive() {
    const sel = S.sel;
    if (!live || !sel) return;
    const missing = missingRequired(sel.form, { openingAuto: sel.openingAuto });
    const keys = new Set(missing.map((m) => m.key));
    if (live.count) live.count.textContent = bandCountText(missing.length);
    if (live.publish) {
      const off = S.busy || missing.length > 0;
      live.publish.disabled = off;
      if (off) live.publish.setAttribute("aria-disabled", "true");
      else if (typeof live.publish.removeAttribute === "function") live.publish.removeAttribute("aria-disabled");
      live.publish.textContent = publishLabel();
    }
    for (const [k, node] of live.miss) node.hidden = !(S.showMissing && keys.has(k));
    if (live.openingText && sel.openingAuto) live.openingText.textContent = openingPreview(sel.form);
    if (live.openingReason) {
      const t = sel.openingAuto ? composeOpening(sel.form) : String(sel.form.opening ?? "").trim();
      const fit = t ? openingFits(t) : { ok: true, reason: "" };
      live.openingReason.textContent = fit.ok ? "" : fit.reason;
      live.openingReason.hidden = fit.ok;
    }
  }
  const publishLabel = () => (S.dirty || !S.sel?.id ? "保存して公開…" : "公開する…");
  const bandCountText = (n) => (n ? `あと ${n} か所` : "あと 0 か所");
  function openingPreview(form) {
    return composeOpening(form) || "（大切なことと手順 1 を入れると、ここに作ります）";
  }
  /**
   * 作った最初のひと言が決まり（80 字・2 文・問い 1）に収まらなければ、作った文を入れた欄を開く（D1）。開いたら true。
   * 入力中は呼ばない（打っている途中の文で欄が固まらないように）。欄から出たとき（blur）と、保存を押したときだけ。
   * 送る本文は自動のときと同じ文なので、未保存（S.dirty）は変えない
   */
  function openOpeningIfTooLong() {
    const sel = S.sel;
    if (!sel?.openingAuto) return false;
    const t = composeOpening(sel.form);
    if (!t || openingFits(t).ok) return false;
    sel.openingAuto = false;
    sel.form.opening = t;
    return true;
  }
  /** 欄から出たとき：最初のひと言の箱だけを差し替える（ほかの欄と、これから押すボタンは描き直さない） */
  function onFieldLeave() {
    const old = live?.openingBox;
    if (!old?.isConnected || !openOpeningIfTooLong()) return;
    old.replaceWith(openingBox());
    updateLive();
  }

  /** 下書きを保存する。返り：{ id, sha, problem }（失敗・対象が替わったら null） */
  async function saveDraft() {
    if (!S.sel || S.busy || checkClosed()) return null;
    const sel = S.sel;
    S.showMissing = true;
    openOpeningIfTooLong();
    const draft = toBody(withDefaults(sel.form, { openingAuto: sel.openingAuto }), sel.kind);
    const name = String(sel.name ?? "").trim() || deriveName({ names: (S.guides ?? []).map((g) => g.name) });
    const wasNew = !sel.id;
    S.busy = true;
    render();
    const { data, error } = await rpc("admin_save_workshop_guide", {
      p_guide_id: sel.id,
      p_kind: sel.kind,
      p_name: name,
      p_note: sel.note,
      p_active: sel.active,
      p_draft: draft,
      p_expected_draft_sha256: sel.id ? sel.sha : null,
    });
    S.busy = false;
    if (checkClosed() || S.sel !== sel) return null;
    if (error) {
      const field = errorField(error);
      if (field === "name") {
        S.nameError = nameErrorText(error);
        S.nameEditing = true;
        setMsg("err", `保存できませんでした。${S.nameError}`);
      } else {
        setProblem(error.hint ? String(error.hint) : "", field);
        setMsg("err", `保存できませんでした。${explainError(error)}`);
      }
      render();
      return null;
    }
    sel.id = data.id;
    sel.sha = data.draft_sha256;
    sel.name = name;
    sel.saved = { name, note: sel.note, active: sel.active, draft };
    S.dirty = false;
    S.nameError = "";
    setProblem(data.problem ?? "");
    const warns = forbiddenWarnings(draft);
    const notes = [];
    if (wasNew && sel.attach) {
      const at = sel.attach;
      sel.attach = null;
      const key = `${at.cohortId}|${at.stage.stage_id}`;
      const d = S.rowDrafts.get(key);
      const chk = assignmentArgs(at.cohortId, at.stage, data.id, d?.start ?? "", d?.end ?? "");
      const args = chk.ok ? chk.args : assignmentArgs(at.cohortId, at.stage, data.id, "", "").args;
      const r = await rpc("admin_set_cohort_stage_guide", args);
      if (checkClosed()) return null;
      if (r.error) notes.push(`段階（${stageRowName(at.stage)}）に付けられませんでした。${explainError(r.error)}`);
      else {
        S.rowDrafts.delete(key);
        S.rowErrors.delete(key);
        notes.push(`段階（${stageRowName(at.stage)}）に付けました（まだ公開していません）。`);
      }
      await loadAssignFor(at.cohortId);
    }
    if (S.problem) setMsg("warn", "下書きを保存しました。公開する前に、次を直してください。", [S.problem.text, ...notes, ...warns]);
    else if (warns.length) setMsg("warn", "下書きを保存しました。受講者に届く文の言葉を確かめてください。", [...notes, ...warns]);
    else setMsg("ok", "下書きを保存しました。", notes);
    // 一覧を読み直す（公開に使う sha は、保存が返した sha のまま。読み直しで差し替えない）
    await loadGuides();
    if (checkClosed()) return null;
    render();
    return { id: data.id, sha: data.draft_sha256, problem: data.problem ?? null };
  }

  /** DB の検査の理由を、その欄に結ぶ（「▸」・「詳しく」の中なら開く） */
  function setProblem(text, field = null) {
    if (!text && !field) {
      S.problem = null;
      return;
    }
    const t = problemTarget(text, field);
    S.problem = { text, ...t };
    if (t.area === "step") {
      const i = Number(String(t.key).split(".")[1]);
      if (Number.isInteger(i)) S.stepOpen.add(i);
    }
    if (t.area === "details") S.detailsOpen = true;
  }

  /** ［保存して公開…］：保存 → DB の検査の結果を見る → 問題が無ければ確かめ → 公開 */
  async function savePublish() {
    const sel = S.sel;
    if (!sel || S.busy || checkClosed()) return;
    openOpeningIfTooLong();
    if (missingRequired(sel.form, { openingAuto: sel.openingAuto }).length) {
      S.showMissing = true;
      render();
      return;
    }
    let target;
    if (S.dirty || !sel.id) {
      const r = await saveDraft();
      if (!r || r.problem) return;
      target = { id: r.id, sha: r.sha, name: S.sel?.name ?? "" };
    } else {
      target = { id: sel.id, sha: sel.sha, name: sel.name };
    }
    await askPublish(target);
  }
  /** 確かめを出した時点で、公開の対象（案内の id と sha）を固定する（F240-01） */
  async function askPublish(target) {
    const my = epoch;
    const spec = publishAsk({ name: target.name, used: usedIn(target.id, S.assign, S.cohorts, S.frames), today: todayJst() });
    const ok = await confirmAsk({ ...spec, where: "editor" });
    if (!ok || checkClosed()) return;
    await publish(target, my);
  }
  async function publish(target, my) {
    const sel = S.sel;
    if (!target || S.busy || checkClosed()) return;
    if (my !== epoch || !sel || sel.id !== target.id || sel.sha !== target.sha || S.dirty) {
      setMsg("err", "公開の対象が変わりました。もう一度［保存して公開…］から確かめてください。");
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
    if (error) {
      if (error.hint) setProblem(String(error.hint));
      setMsg("err", `公開できませんでした。${problemText(explainError(error))}`);
    } else {
      setProblem("");
      if (data?.published) setMsg("ok", `版 ${data.version} を公開しました。`);
      else setMsg("ok", `下書きは前に公開した版と同じなので、版は進めませんでした（版 ${data?.version}）。`);
    }
    await loadGuides();
    if (checkClosed()) return;
    render();
  }
  /** 既定のままの最初のひと言を DB が断ったときは、欄の文に読み替える（3.9） */
  function problemText(text) {
    return S.problem?.area === "opening" && S.sel?.openingAuto ? OPENING_TOO_LONG : text;
  }

  /** ［案内を止める…］［案内を再開…］：保存済みの下書きと今の sha のまま active だけを替える（編集中の入力は送らない） */
  async function toggleActive() {
    const sel = S.sel;
    if (!sel?.id || !sel.saved || S.busy || checkClosed()) return;
    const wasActive = sel.saved.active !== false;
    const ok = await confirmAsk({
      ...activeAsk({ name: sel.saved.name, used: usedIn(sel.id, S.assign, S.cohorts, S.frames), active: wasActive }),
      where: "editor",
    });
    if (!ok || checkClosed() || S.sel !== sel) return;
    S.busy = true;
    render();
    const { data, error } = await rpc("admin_save_workshop_guide", {
      p_guide_id: sel.id,
      p_kind: sel.kind,
      p_name: sel.saved.name,
      p_note: sel.saved.note,
      p_active: !wasActive,
      p_draft: sel.saved.draft,
      p_expected_draft_sha256: sel.sha,
    });
    S.busy = false;
    if (checkClosed() || S.sel !== sel) return;
    if (error) setMsg("err", `${wasActive ? "止められませんでした" : "再開できませんでした"}。${explainError(error)}`);
    else {
      sel.sha = data.draft_sha256;
      sel.saved.active = !wasActive;
      sel.active = !wasActive;
      setMsg("ok", wasActive ? "案内を止めました。" : "案内を再開しました。");
    }
    await loadGuides();
    if (checkClosed()) return;
    render();
  }

  // ---- 回ごとの割り当て ----

  async function chooseCohort(id, selectEl) {
    if (S.busy || checkClosed()) return;
    if (!(await guardUnsaved("破棄して回を替える", { editor: false }))) {
      if (selectEl) selectEl.value = S.cohortId;
      return;
    }
    // 段階の行の［新しく作る］で開いた（まだ保存していない）案内は、回を替えたら付け先を外す（見えない回の段階に付けない）
    if (S.sel?.attach && S.sel.attach.cohortId !== id) S.sel.attach = null;
    S.cohortId = id;
    render();
    await loadAssignFor(id);
    render();
  }
  const rowKey = (cid, s) => `${cid}|${s.stage_id}`;
  const savedRow = (s) => ({
    guide: s.guide_id ?? "",
    start: s.day_kind === "bridge" ? "" : timeField(s.planned_start),
    end: s.day_kind === "bridge" ? "" : timeField(s.planned_end),
  });
  const sameRow = (a, b) => a.guide === b.guide && a.start === b.start && a.end === b.end;
  /** 今の回の、保存していない行の数（今の回の段階〔a.stages〕にある行だけ。無くなった段階の下書きは［まとめて保存］で送らないので数えない） */
  function draftCount(cid = S.cohortId) {
    let n = 0;
    for (const s of S.assign.get(cid)?.stages ?? []) if (S.rowDrafts.has(rowKey(cid, s))) n++;
    return n;
  }

  /** ［まとめて保存］：行を順に保存する。一部が失敗しても、ほかの行の下書きは全部残す（保存が通った行の下書きだけを消す。F240-02） */
  async function saveRows() {
    const cid = S.cohortId;
    const a = S.assign.get(cid);
    if (S.busy || checkClosed() || !a) return;
    const jobs = [];
    let bad = 0;
    for (const s of a.stages ?? []) {
      const key = rowKey(cid, s);
      const d = S.rowDrafts.get(key);
      if (!d) continue;
      const chk = assignmentArgs(cid, s, d.guide, d.start, d.end);
      if (!chk.ok) {
        S.rowErrors.set(key, chk.message);
        bad++;
        continue;
      }
      S.rowErrors.delete(key);
      jobs.push({ key, sent: { ...d }, args: chk.args });
    }
    if (!jobs.length) {
      if (bad) setMsg("err", bulkSaveText(0, bad));
      render();
      return;
    }
    S.busy = true;
    render();
    let ok = 0, ng = bad;
    for (const j of jobs) {
      const { error } = await rpc("admin_set_cohort_stage_guide", j.args);
      if (checkClosed()) return;
      if (error) {
        ng++;
        S.rowErrors.set(j.key, `保存できませんでした。${explainError(error)}`);
      } else {
        ok++;
        // 送ったあとに同じ行をまた変えていたら、その下書きは残す
        const cur = S.rowDrafts.get(j.key);
        if (cur && sameRow(cur, j.sent)) S.rowDrafts.delete(j.key);
      }
    }
    S.busy = false;
    setMsg(ng ? "warn" : "ok", bulkSaveText(ok, ng));
    await Promise.all([loadAssignFor(cid), loadGuides()]);
    if (checkClosed()) return;
    render();
  }
  function revertRows() {
    for (const k of [...S.rowDrafts.keys()]) {
      if (k.startsWith(`${S.cohortId}|`)) {
        S.rowDrafts.delete(k);
        S.rowErrors.delete(k);
      }
    }
    render();
  }
  /** 段階が無くなった割り当てを外す（1 つか全部） */
  async function removeOrphans(list) {
    const cid = S.cohortId;
    if (S.busy || checkClosed() || !list.length) return;
    S.busy = true;
    render();
    let ok = 0, ng = 0, last = "";
    for (const o of list) {
      const { error } = await rpc("admin_set_cohort_stage_guide", {
        p_cohort_id: cid,
        p_stage_id: o.stage_id,
        p_guide_id: null,
        p_planned_start: null,
        p_planned_end: null,
      });
      if (checkClosed()) return;
      if (error) {
        ng++;
        last = explainError(error);
      } else ok++;
    }
    S.busy = false;
    if (ng) setMsg("err", `${ok ? `${ok} 件を外し、` : ""}${ng} 件は外せませんでした。${last}`);
    else setMsg("ok", `段階が無くなった割り当てを ${ok} 件外しました。`);
    await Promise.all([loadAssignFor(cid), loadGuides()]);
    if (checkClosed()) return;
    render();
  }

  // ---- 描画 ----

  function help(text, open, onToggle) {
    const box = el("p", { className: "wg-qtext", hidden: !open, text });
    const b = el("button", {
      type: "button",
      className: "wg-q",
      text: "?",
      title: text,
      "aria-label": "説明",
      "aria-expanded": open ? "true" : "false",
      onclick: () => {
        box.hidden = !box.hidden;
        b.setAttribute("aria-expanded", box.hidden ? "false" : "true");
        onToggle?.(!box.hidden);
      },
    });
    return { button: b, box };
  }

  /** 欄。key は必須の印・DB の理由を出す所の名前 */
  function field(label, value, onInput, { key, required = false, multiline = false, max, type = "text", title, hint } = {}) {
    const id = `wg-f-${Math.random().toString(36).slice(2, 10)}`;
    const input = multiline
      ? el("textarea", { id, maxlength: max, value, title, "data-fk": key })
      : el("input", {
        id,
        type,
        maxlength: max,
        value,
        title,
        "data-fk": key,
        inputmode: type === "number" ? "numeric" : undefined,
      });
    input.value = value ?? "";
    input.addEventListener("input", () => {
      onInput(input.value);
      touch();
    });
    input.addEventListener("blur", () => onFieldLeave());
    const wrap = el(
      "div",
      { className: "wg-field" },
      el("label", { for: id, title }, label, required ? el("span", { className: "wg-req", text: "*", "aria-hidden": "true" }) : null),
      input,
      hint ? el("p", { className: "wg-hint", text: hint }) : null,
    );
    if (key) appendFieldNotes(wrap, key, required);
    if (key) live.fk.set(key, input);
    return wrap;
  }
  /** 欄の下の「入れてください」と DB の理由 */
  function appendFieldNotes(wrap, key, required) {
    if (required) {
      const miss = el("p", { className: "wg-row-err", text: "入れてください", hidden: true });
      live.miss.set(key, miss);
      wrap.append(miss);
    }
    if (S.problem && S.problem.key === key && S.problem.area !== "band") {
      wrap.append(el("p", { className: "wg-row-err", role: "alert", text: S.problem.text }));
    }
  }

  function listEditor(key, itemLabel, max, maxItems) {
    const f = S.sel.form;
    const box = el("div", { className: "wg-box" }, el("div", { className: "wg-label", text: FIELD_LABELS[key] }));
    (f[key] ?? []).forEach((v, i) => {
      box.append(field(`${itemLabel} ${i + 1}`, v, (x) => (f[key][i] = x), { max }));
      box.append(el("button", {
        type: "button",
        className: "wg-btn small danger",
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
          className: "wg-btn small",
          text: `${itemLabel}を足す`,
          title: `${maxItems} つまで`,
          onclick: () => {
            (f[key] ??= []).push("");
            touch();
            render();
          },
        }),
      ));
    }
    if (S.problem?.key === key) box.append(el("p", { className: "wg-row-err", role: "alert", text: S.problem.text }));
    return box;
  }

  function stepInput(label, value, onInput, key, max, extra = {}) {
    const input = el("input", { type: "text", maxlength: max, "aria-label": label, value, "data-fk": key, ...extra });
    input.value = value ?? "";
    input.addEventListener("input", () => {
      onInput(input.value);
      touch();
    });
    input.addEventListener("blur", () => onFieldLeave());
    live.fk.set(key, input);
    return input;
  }

  function stepsBox() {
    const f = S.sel.form;
    const box = el(
      "div",
      { className: "wg-box" },
      el("div", { className: "wg-label" }, "手順", el("span", { className: "wg-req", text: "*", "aria-hidden": "true" })),
    );
    f.flow.forEach((s, i) => {
      const open = S.stepOpen.has(i);
      const row = el(
        "div",
        { className: "wg-step" },
        el("span", { className: "wg-num", text: String(i + 1) }),
        stepInput(`手順 ${i + 1} の名前`, s.step, (v) => (s.step = v), `flow.${i}.step`, 40, { placeholder: "手順の名前" }),
        el(
          "span",
          { className: "wg-step-q" },
          stepInput(`手順 ${i + 1} の最初の問いかけ`, s.first_question, (v) => (s.first_question = v), `flow.${i}.first_question`, 80, {
            placeholder: "最初の問いかけ",
          }),
        ),
        el(
          "span",
          { className: "wg-step-ops" },
          el("button", {
            type: "button",
            className: "wg-btn small",
            text: open ? "▾" : "▸",
            title: "受講者が決めること・AI が引き受けてよい操作",
            "aria-label": `手順 ${i + 1} の詳しく`,
            "aria-expanded": open ? "true" : "false",
            onclick: () => {
              if (open) S.stepOpen.delete(i);
              else S.stepOpen.add(i);
              render();
            },
          }),
          el("button", {
            type: "button",
            className: "wg-btn small",
            text: "↑",
            "aria-label": `手順 ${i + 1} を上へ`,
            disabled: i === 0,
            onclick: () => moveStep(i, -1),
          }),
          el("button", {
            type: "button",
            className: "wg-btn small",
            text: "↓",
            "aria-label": `手順 ${i + 1} を下へ`,
            disabled: i === f.flow.length - 1,
            onclick: () => moveStep(i, 1),
          }),
          f.flow.length > 1
            ? el("button", {
              type: "button",
              className: "wg-btn small danger",
              text: "×",
              "aria-label": `手順 ${i + 1} を消す`,
              onclick: () => {
                f.flow.splice(i, 1);
                S.stepOpen = new Set();
                touch();
                render();
              },
            })
            : null,
        ),
      );
      box.append(row);
      for (const k of ["step", "first_question"]) {
        const miss = el("p", { className: "wg-row-err", text: `手順 ${i + 1} の${FIELD_LABELS[k]}を入れてください`, hidden: true });
        live.miss.set(`flow.${i}.${k}`, miss);
        box.append(miss);
        if (S.problem?.key === `flow.${i}.${k}`) box.append(el("p", { className: "wg-row-err", role: "alert", text: S.problem.text }));
      }
      if (open) {
        const more = el(
          "div",
          { className: "wg-step-more" },
          field(FIELD_LABELS.student_decides, s.student_decides, (v) => (s.student_decides = v), {
            key: `flow.${i}.student_decides`,
            max: 60,
          }),
          field(FIELD_LABELS.ai_may_do, s.ai_may_do, (v) => (s.ai_may_do = v), {
            key: `flow.${i}.ai_may_do`,
            max: 80,
            title: "受講者の了承のあとに、AI が引き受けてよい操作。空なら、AI は操作の前に了承を取ります",
          }),
        );
        box.append(el("div", { className: "wg-step" }, more));
      }
    });
    if (f.flow.length < 7) {
      box.append(el(
        "div",
        { className: "wg-bar" },
        el("button", {
          type: "button",
          className: "wg-btn small",
          text: "＋ 手順を足す",
          title: "7 つまで",
          onclick: () => {
            f.flow.push({ step: "", first_question: "", student_decides: "", ai_may_do: "" });
            touch();
            render();
          },
        }),
      ));
    }
    return box;
  }
  function moveStep(i, d) {
    const f = S.sel.form;
    const j = i + d;
    if (j < 0 || j >= f.flow.length) return;
    [f.flow[i], f.flow[j]] = [f.flow[j], f.flow[i]];
    const oi = S.stepOpen.has(i), oj = S.stepOpen.has(j);
    S.stepOpen.delete(i);
    S.stepOpen.delete(j);
    if (oi) S.stepOpen.add(j);
    if (oj) S.stepOpen.add(i);
    touch();
    render();
  }

  function openingBox() {
    const sel = S.sel;
    const f = sel.form;
    const h = help(HELP_OPENING, S.openingHelp, (v) => (S.openingHelp = v));
    const box = el("div", { className: "wg-field" });
    live.openingText = null;
    live.openingBox = box;
    box.append(el("div", { className: "wg-bar" }, el("span", { className: "wg-label", text: "AI の最初のひと言" }), h.button));
    box.append(h.box);
    if (sel.openingAuto) {
      live.openingText = el("p", { className: "wg-opening", text: openingPreview(f) });
      box.append(
        live.openingText,
        el(
          "div",
          { className: "wg-bar" },
          el("button", {
            type: "button",
            className: "wg-btn small",
            text: "書き直す",
            onclick: () => {
              sel.openingAuto = false;
              f.opening = composeOpening(f);
              touch();
              render();
              live?.fk.get("opening")?.focus?.();
            },
          }),
        ),
      );
    } else {
      const id = `wg-f-${Math.random().toString(36).slice(2, 10)}`;
      const ta = el("textarea", { id, maxlength: 80, "aria-label": "AI の最初のひと言", "data-fk": "opening" });
      ta.value = f.opening ?? "";
      ta.addEventListener("input", () => {
        f.opening = ta.value;
        // 空にしたら既定に戻る（ボタンは足さない）
        sel.openingAuto = ta.value.trim() === "";
        touch();
      });
      // 空にして出たとき、作った文が収まらなければ、作った文を入れ直す
      ta.addEventListener("blur", () => onFieldLeave());
      live.fk.set("opening", ta);
      box.append(ta, el("p", { className: "wg-hint", text: "空にすると、自動で作る文に戻ります。" }));
    }
    live.openingReason = el("p", { className: "wg-row-err", hidden: true });
    box.append(live.openingReason);
    if (S.problem?.area === "opening") {
      box.append(el("p", { className: "wg-row-err", role: "alert", text: problemText(S.problem.text) }));
    }
    return box;
  }

  function detailsBox() {
    const sel = S.sel;
    const f = sel.form;
    const filled = [
      (f.done_when ?? []).some((x) => String(x).trim()),
      (f.optional_polish ?? []).some((x) => String(x).trim()),
      (f.avoid ?? []).some((x) => String(x).trim()),
      String(f.coaching_note ?? "").trim(),
      String(f.materials ?? "").trim(),
      (f.hints ?? []).some((h) => String(h.when).trim() || String(h.say).trim()),
      sel.kind === "workshop" && String(f.finish_minutes ?? "") !== "20",
      String(sel.note ?? "").trim(),
    ].filter(Boolean).length;
    const warnCount = forbiddenWarnings(toBody(withDefaults(f, { openingAuto: sel.openingAuto }), sel.kind)).length;
    const d = el("details", { className: "wg-more" });
    d.open = S.detailsOpen;
    if (S.detailsOpen) d.setAttribute("open", "");
    d.addEventListener("toggle", () => (S.detailsOpen = !!d.open));
    d.append(el(
      "summary",
      {},
      `詳しく（任意）${filled ? ` ${filled} 項目に入力あり` : ""}${warnCount ? `・言葉の注意 ${warnCount} 件` : ""}`,
    ));
    d.append(listEditor("done_when", "完成の目安", 50, 5));
    d.append(listEditor("optional_polish", "任意の仕上げ", 30, 4));
    d.append(listEditor("avoid", "やってはいけないこと", 60, 5));
    d.append(field(FIELD_LABELS.coaching_note, f.coaching_note, (v) => (f.coaching_note = v), {
      key: "coaching_note",
      multiline: true,
      max: 200,
    }));
    d.append(field(FIELD_LABELS.materials, f.materials, (v) => (f.materials = v), { key: "materials", multiline: true, max: 120 }));
    const hints = el("div", { className: "wg-box" }, el("div", { className: "wg-label", text: FIELD_LABELS.hints }));
    f.hints.forEach((h, i) => {
      hints.append(field(`ヒント ${i + 1}：${FIELD_LABELS.when}`, h.when, (v) => (h.when = v), { max: 40 }));
      hints.append(field(`ヒント ${i + 1}：${FIELD_LABELS.say}`, h.say, (v) => (h.say = v), { max: 120 }));
      hints.append(el("button", {
        type: "button",
        className: "wg-btn small danger",
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
          className: "wg-btn small",
          text: "ヒントを足す",
          title: "6 つまで",
          onclick: () => {
            f.hints.push({ when: "", say: "" });
            touch();
            render();
          },
        }),
      ));
    }
    if (S.problem?.key === "hints") hints.append(el("p", { className: "wg-row-err", role: "alert", text: S.problem.text }));
    d.append(hints);
    // 仕上げの分はワークショップの案内だけ（ブリッジワークの案内では欄を出さず、本文にも入れない）
    if (sel.kind === "workshop") {
      d.append(field(FIELD_LABELS.finish_minutes, String(f.finish_minutes ?? ""), (v) => (f.finish_minutes = v), {
        key: "finish_minutes",
        type: "number",
        title: "5〜60 分。既定は 20。制作時間の残りがこの分になったら、AI が仕上げを手伝う進め方に替えます",
      }));
    }
    d.append(field("メモ（受講者には届きません）", sel.note, (v) => (sel.note = v), { key: "note", multiline: true, max: 400 }));
    return d;
  }

  function editorStatus(sel) {
    if (!sel.id) return { text: "まだ保存していません", tone: "muted" };
    const g = guideById(sel.id);
    if (!g) return { text: "", tone: "muted" };
    const st = guideState(
      { guide_id: g.id, guide_kind: g.kind, guide_active: g.active, published_version: g.published_version },
      { via: g.last_published_via },
    );
    return { text: `${st.text}${g.has_pending_draft ? "｜直しかけあり" : ""}`, tone: st.tone };
  }

  function editor() {
    const sel = S.sel;
    const f = sel.form;
    const scroll = el("div", { className: "wg-scroll" });
    scroll.append(el(
      "div",
      { className: "wg-bar" },
      el("button", {
        type: "button",
        className: "wg-btn small wg-back",
        text: S.view === "cohort" ? "← 段階の一覧" : "← 案内の一覧",
        onclick: () => backToList(),
      }),
    ));
    const head = el("h3", { id: "wg-edit-h", text: sel.name || `新しい${KIND_LABELS[sel.kind]}の案内` });
    live.editHead = head;
    scroll.append(el(
      "div",
      { className: "wg-bar" },
      head,
      el("button", {
        type: "button",
        className: "wg-btn small",
        text: "名前を変える",
        "aria-expanded": S.nameEditing ? "true" : "false",
        onclick: () => {
          S.nameEditing = !S.nameEditing;
          render();
          if (S.nameEditing) live?.fk.get("name")?.focus?.();
        },
      }),
    ));
    if (S.nameEditing) {
      scroll.append(field("管理用の名前", sel.name, (v) => (sel.name = v), {
        key: "name",
        max: 60,
        title: "受講者には届きません。60 字まで",
      }));
    }
    if (S.nameError) scroll.append(el("p", { className: "wg-row-err", role: "alert", text: S.nameError }));
    const st = editorStatus(sel);
    scroll.append(el("p", { className: `wg-state wg-tone-${st.tone}`, text: `${KIND_LABELS[sel.kind]}｜${st.text}` }));
    if (sel.id) scroll.append(el("p", { className: "wg-hint", text: usedInText(usedIn(sel.id, S.assign, S.cohorts, S.frames)) }));
    if (sel.id && sel.saved) {
      const on = sel.saved.active !== false;
      scroll.append(el(
        "div",
        { className: "wg-bar" },
        el("button", {
          type: "button",
          className: `wg-btn small${on ? " danger" : ""}`,
          text: on ? "案内を止める…" : "案内を再開…",
          disabled: S.busy,
          onclick: () => toggleActive(),
        }),
      ));
    }
    scroll.append(field(FIELD_LABELS.theme, f.theme, (v) => (f.theme = v), { key: "theme", required: true, max: 60 }));
    scroll.append(field(`${FIELD_LABELS.why_it_matters}（1 文）`, f.why_it_matters, (v) => (f.why_it_matters = v), {
      key: "why_it_matters",
      required: true,
      multiline: true,
      max: 120,
      title: "目安 40 字前後・理由だけを 1 文で。途中で読み直したときにも、AI がそのまま言います",
    }));
    scroll.append(field(FIELD_LABELS.goal, f.goal, (v) => (f.goal = v), { key: "goal", required: true, multiline: true, max: 120 }));
    scroll.append(
      field(FIELD_LABELS.minimum, f.minimum, (v) => (f.minimum = v), { key: "minimum", required: true, multiline: true, max: 100 }),
    );
    scroll.append(stepsBox());
    scroll.append(openingBox());
    scroll.append(detailsBox());
    const warns = forbiddenWarnings(toBody(withDefaults(f, { openingAuto: sel.openingAuto }), sel.kind));
    if (warns.length) {
      scroll.append(el(
        "div",
        { className: "wg-msg warn" },
        el("div", { text: "受講者に届く文の言葉" }),
        el("ul", {}, ...warns.map((w) => el("li", { text: w }))),
      ));
    }

    const band = el("div", { className: "wg-band" });
    if (S.confirm && S.confirm.spec.where === "editor") band.append(inlineConfirm());
    const missing = missingRequired(f, { openingAuto: sel.openingAuto });
    live.count = el("span", { text: bandCountText(missing.length) });
    const text = el("span", { className: "wg-band-text" }, live.count);
    if (sel.attach && !sel.id) text.append(el("span", { className: "wg-hint", text: "　保存すると、この段階に付けます" }));
    if (S.problem && S.problem.area === "band" && S.problem.text) {
      text.append(el("span", { className: "wg-row-err", role: "alert", text: `　${S.problem.text}` }));
    }
    band.append(text);
    band.append(el("button", { type: "button", className: "wg-btn", text: "下書きを保存", disabled: S.busy, onclick: () => saveDraft() }));
    const off = S.busy || missing.length > 0;
    live.publish = el("button", {
      type: "button",
      className: "wg-btn primary",
      text: publishLabel(),
      disabled: off,
      "aria-disabled": off ? "true" : undefined,
      title: missing.length ? "入れていない欄があるので、まだ公開できません" : undefined,
      onclick: () => savePublish(),
    });
    band.append(live.publish);
    return el("section", { className: "wg-pane wg-right", "aria-labelledby": "wg-edit-h" }, scroll, band);
  }

  function inlineConfirm() {
    const c = S.confirm;
    const sp = c.spec;
    const cancel = el("button", {
      type: "button",
      className: "wg-btn",
      text: sp.cancelLabel ?? "やめる",
      onclick: () => cancelInlineConfirm(),
    });
    live.confirmCancel = cancel;
    return el(
      "div",
      { className: "wg-confirm", role: "alertdialog", "aria-label": sp.title },
      el("p", { className: "wg-label", text: sp.title }),
      ...(sp.lines ?? []).map((t) => el("p", { text: t })),
      ...(sp.warnings ?? []).map((t) => el("p", { className: "wg-tone-warn", text: `⚠ ${t}` })),
      ...(sp.detail ?? []).map((t) => el("p", { className: "wg-hint", text: `・${t}` })),
      sp.note ? el("p", { className: "wg-hint", text: sp.note }) : null,
      el(
        "div",
        { className: "wg-bar" },
        cancel,
        el("button", {
          type: "button",
          className: `wg-btn ${sp.kind === "danger" ? "danger" : "primary"}`,
          text: sp.okLabel,
          onclick: () => {
            const r = c.resolve;
            S.confirm = null;
            r(true);
            render();
          },
        }),
      ),
    );
  }

  function stateCell(st, label) {
    return el("td", { className: `wg-tone-${st.tone}`, "data-label": label, text: st.text });
  }
  /** 行の公開の札（選んでいる案内の今の状態。一覧が読めなければ割り当ての行の値） */
  function rowState(cid, s, d) {
    const gid = d.guide || null;
    const g = gid ? guideById(gid) : null;
    const saved = gid && gid === s.guide_id;
    return guideState({
      day_kind: s.day_kind,
      guide_id: gid,
      guide_kind: g?.kind ?? (saved ? s.guide_kind : undefined),
      guide_active: g ? g.active !== false : saved ? s.guide_active : undefined,
      published_version: g ? g.published_version : saved ? s.published_version : null,
    }, {
      creditMode: S.frames ? S.frames.get(cid)?.credit_mode : undefined,
      pending: !!g?.has_pending_draft,
      via: g?.last_published_via ?? null,
    });
  }

  function cohortView(compact) {
    const scroll = el("div", { className: "wg-scroll" });
    const band = el("div", { className: "wg-band" });
    if (S.cohorts === null) {
      scroll.append(el("p", { text: "読み込んでいます…" }));
      return el("section", { className: "wg-pane wg-left" }, scroll);
    }
    const sel = el("select", { id: "wg-cohort", disabled: S.busy, "data-fk": "cohort" });
    if (!S.cohortId) sel.append(el("option", { value: "", text: "回を選んでください" }));
    for (const o of cohortOptions(S.cohorts)) {
      const opt = el("option", { value: o.id, text: o.label });
      if (o.id === S.cohortId) opt.selected = true;
      sel.append(opt);
    }
    sel.value = S.cohortId;
    sel.addEventListener("change", () => chooseCohort(sel.value, sel));
    live.fk.set("cohort", sel);
    scroll.append(el("div", { className: "wg-field" }, el("label", { for: "wg-cohort", text: "回" }), sel));
    if (S.cohortsError) scroll.append(el("div", { className: "wg-msg err", text: `回を読めませんでした。${S.cohortsError}` }));
    if (S.guidesError) scroll.append(el("div", { className: "wg-msg err", text: `案内の一覧を読めませんでした。${S.guidesError}` }));
    const cid = S.cohortId;
    if (!cid) return el("section", { className: "wg-pane wg-left" }, scroll);
    const err = S.assignErrors.get(cid);
    if (err) scroll.append(el("div", { className: "wg-msg err", text: `この回の割り当てを読めませんでした。${err}` }));
    const a = S.assign.get(cid);
    if (!a) {
      if (!err) scroll.append(el("p", { text: "読み込んでいます…" }));
      return el("section", { className: "wg-pane wg-left" }, scroll);
    }
    const mode = S.frames ? S.frames.get(cid)?.credit_mode : undefined;
    if (S.framesError) scroll.append(el("p", { className: "wg-hint", text: "回の枠を読めませんでした。" }));
    else if (mode && mode !== "stage") {
      scroll.append(el("p", { className: "wg-tone-warn", text: "この回は Day ごとの枠なので、案内は受講者に出ません。" }));
    }
    const orphans = a.orphans ?? [];
    if (orphans.length) {
      const box = el(
        "div",
        { className: "wg-msg warn" },
        el("div", { text: `段階が無くなった割り当てが ${orphans.length} 件あります（受講者には出ません）` }),
      );
      for (const o of orphans) {
        box.append(el(
          "div",
          { className: "wg-bar" },
          el("span", { text: `「${o.guide_name ?? ""}」` }),
          el("button", { type: "button", className: "wg-btn small", text: "外す", disabled: S.busy, onclick: () => removeOrphans([o]) }),
        ));
      }
      if (orphans.length > 1) {
        box.append(el("button", {
          type: "button",
          className: "wg-btn small",
          text: "まとめて外す",
          disabled: S.busy,
          onclick: () => removeOrphans(orphans),
        }));
      }
      scroll.append(box);
    }
    const stages = a.stages ?? [];
    if (!stages.length) {
      scroll.append(el("p", {
        className: "wg-hint",
        text: "この回には段階がありません。回の画面でテンプレートを適用すると、段階ができます。",
      }));
    } else {
      const t = el("table");
      const head = el("tr");
      for (const h of compact ? ["段階", "公開"] : ["段階", "案内", "公開", "予定の時刻"]) {
        head.append(el("th", { scope: "col", text: h }));
      }
      t.append(el("thead", {}, head));
      const tb = el("tbody");
      for (const s of stages) tb.append(compact ? compactStageRow(cid, s) : stageRow(cid, s));
      t.append(tb);
      scroll.append(t);
    }
    // 固定の帯（保存していない行の数と［元に戻す］［まとめて保存］）
    if (S.confirm && S.confirm.spec.where === "left") band.append(inlineConfirm());
    const n = draftCount(cid);
    const bandText = el("span", {
      className: "wg-band-text",
      text: n ? `保存していない行が ${n} つあります` : "段階ごとに案内を選び、［まとめて保存］で付けます",
    });
    const revert = el("button", { type: "button", className: "wg-btn", text: "元に戻す", disabled: S.busy || !n, onclick: () => revertRows() });
    const saveAll = el("button", {
      type: "button",
      className: "wg-btn primary",
      text: "まとめて保存",
      disabled: S.busy || !n,
      onclick: () => saveRows(),
    });
    band.append(bandText, revert, saveAll);
    live.rowBand = { text: bandText, buttons: [revert, saveAll] };
    return el("section", { className: "wg-pane wg-left" }, scroll, band);
  }

  function stageRow(cid, s) {
    const key = rowKey(cid, s);
    const saved = savedRow(s);
    const d = S.rowDrafts.get(key) ?? saved;
    // ［まとめて保存］の最中は押せない（保存中に元の値に戻すと、下書きが消えて送った値が残るため）
    const g = el("select", { "aria-label": `${stageRowName(s)}の案内`, "data-fk": `row:${key}:g`, disabled: S.busy });
    g.append(el("option", { value: "", text: "案内なし" }));
    const opts = guideOptionsFor(s.day_kind, S.guides);
    for (const o of opts) {
      const opt = el("option", { value: o.id, text: o.label });
      if (o.id === d.guide) opt.selected = true;
      g.append(opt);
    }
    // 一覧に無い案内（読めなかったなど）が付いていれば、その名前のまま選択肢に残す
    if (d.guide && !opts.some((o) => o.id === d.guide)) {
      const opt = el("option", { value: d.guide, text: s.guide_name ?? d.guide });
      opt.selected = true;
      g.append(opt);
    }
    g.value = d.guide;
    live.fk.set(`row:${key}:g`, g);
    let start = null, end = null;
    const times = el("span", { className: "wg-times" });
    if (s.day_kind === "bridge") times.append(el("span", { className: "wg-hint", text: "—" }));
    else {
      start = el("input", { type: "time", "aria-label": `${stageRowName(s)}の始まり`, "data-fk": `row:${key}:s`, disabled: S.busy });
      end = el("input", { type: "time", "aria-label": `${stageRowName(s)}の終わり`, "data-fk": `row:${key}:e`, disabled: S.busy });
      start.value = d.start;
      end.value = d.end;
      live.fk.set(`row:${key}:s`, start);
      live.fk.set(`row:${key}:e`, end);
      times.append(start, el("span", { text: "〜" }), end);
    }
    const mark = el("span", { className: "wg-unsaved", text: " ●未保存", hidden: !S.rowDrafts.has(key) });
    // 入れたものを行の下書きに残す（ほかの行の保存や、この行の誤りで描き直しても消えない）。元の値に戻したら下書きから外す
    const keep = () => {
      const v = { guide: g.value, start: start?.value ?? "", end: end?.value ?? "" };
      if (sameRow(v, saved)) {
        S.rowDrafts.delete(key);
        S.rowErrors.delete(key);
      } else S.rowDrafts.set(key, v);
      mark.hidden = !S.rowDrafts.has(key);
    };
    g.addEventListener("change", () => {
      keep();
      render();
    });
    for (const t of [start, end]) {
      if (!t) continue;
      t.addEventListener("input", () => {
        keep();
        updateRowBand();
      });
      t.addEventListener("change", () => {
        keep();
        updateRowBand();
      });
    }
    const st = rowState(cid, s, d);
    const rowErr = S.rowErrors.get(key);
    const op = d.guide
      ? el("button", { type: "button", className: "wg-btn small", text: "開く", disabled: S.busy, onclick: () => chooseGuide(d.guide) })
      : el("button", {
        type: "button",
        className: "wg-btn small",
        text: "新しく作る",
        disabled: S.busy || S.guides === null,
        onclick: () => newGuide(s.day_kind === "bridge" ? "bridge" : "workshop", s),
      });
    return el(
      "tr",
      {},
      el("td", { className: "wg-stage-name" }, el("span", { text: stageRowName(s) }), mark),
      el("td", {}, g, rowErr ? el("p", { className: "wg-row-err", role: "alert", text: rowErr }) : null),
      stateCell(st, "公開"),
      el("td", { className: "wg-ops-cell" }, times, op),
    );
  }
  function compactStageRow(cid, s) {
    const key = rowKey(cid, s);
    const d = S.rowDrafts.get(key) ?? savedRow(s);
    const st = rowState(cid, s, d);
    const current = !!d.guide && S.sel?.id === d.guide;
    return el(
      "tr",
      {},
      el(
        "td",
        {},
        el("button", {
          type: "button",
          className: "wg-row-btn",
          text: `${current ? "▶" : ""}${stageRowName(s)}`,
          "aria-current": current ? "true" : undefined,
          onclick: () => (d.guide ? chooseGuide(d.guide) : newGuide(s.day_kind === "bridge" ? "bridge" : "workshop", s)),
        }),
        S.rowDrafts.has(key) ? el("span", { className: "wg-unsaved", text: " ●未保存" }) : null,
      ),
      stateCell(st, "公開"),
    );
  }
  function updateRowBand() {
    // 時刻を入れている間は描き直さない（入力の focus を保つ）。帯の文とボタンだけ替える
    if (!live?.rowBand) return;
    const n = draftCount();
    live.rowBand.text.textContent = n ? `保存していない行が ${n} つあります` : "段階ごとに案内を選び、［まとめて保存］で付けます";
    for (const b of live.rowBand.buttons) b.disabled = S.busy || !n;
  }

  function listView(compact) {
    const scroll = el("div", { className: "wg-scroll" });
    scroll.append(el(
      "div",
      { className: "wg-bar" },
      el("button", {
        type: "button",
        className: "wg-btn",
        text: "新しいワークショップの案内",
        disabled: S.busy,
        onclick: () => newGuide("workshop"),
      }),
      el("button", {
        type: "button",
        className: "wg-btn",
        text: "新しいブリッジワークの案内",
        disabled: S.busy,
        onclick: () => newGuide("bridge"),
      }),
    ));
    if (S.guidesError) {
      scroll.append(el("div", { className: "wg-msg err", text: `一覧を読めませんでした。${S.guidesError}` }));
    } else if (S.guides === null) scroll.append(el("p", { text: "読み込んでいます…" }));
    else if (!S.guides.length) scroll.append(el("p", { className: "wg-hint", text: "まだ案内がありません。" }));
    else {
      const t = el("table");
      const head = el("tr");
      for (const h of compact ? ["名前", "公開"] : ["名前", "種類", "公開", "使っている所"]) head.append(el("th", { scope: "col", text: h }));
      t.append(el("thead", {}, head));
      const tb = el("tbody");
      for (const g of S.guides) {
        const r = guideListRow(g);
        const st = guideState(
          { guide_id: g.id, guide_kind: g.kind, guide_active: g.active, published_version: g.published_version },
          { pending: !!g.has_pending_draft, via: g.last_published_via },
        );
        const cells = [
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
        ];
        if (!compact) cells.push(el("td", { "data-label": "種類", text: r.kind }));
        cells.push(stateCell(st, "公開"));
        if (!compact) {
          const u = usedIn(g.id, S.assign, S.cohorts, S.frames);
          cells.push(el("td", { "data-label": "使っている所", text: u.length ? usedInText(u).replace(/^使っている所：/, "") : "なし" }));
        }
        tb.append(el("tr", {}, ...cells));
      }
      t.append(tb);
      scroll.append(t);
    }
    const parts = [scroll];
    if (S.confirm && S.confirm.spec.where === "left") parts.push(el("div", { className: "wg-band" }, inlineConfirm()));
    return el("section", { className: "wg-pane wg-left" }, ...parts);
  }

  function render() {
    if (checkClosed()) return;
    // 描き直しの前後で、入力の focus と選択の位置を保つ（data-fk の同じ欄へ戻す）
    const ae = typeof document !== "undefined" ? document.activeElement : null;
    const fk = ae && typeof ae.getAttribute === "function" ? ae.getAttribute("data-fk") : null;
    const range = fk && typeof ae.selectionStart === "number" ? [ae.selectionStart, ae.selectionEnd] : null;
    for (const b of tabs.children) {
      const on = b.getAttribute("data-key") === S.view;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    live = { fk: new Map(), miss: new Map(), count: null, publish: null, openingText: null, openingReason: null, openingBox: null, editHead: null, confirmCancel: null, rowBand: null };
    const editing = !!S.sel;
    main.className = editing ? "wg-main wg-editing" : "wg-main";
    const left = S.view === "cohort" ? cohortView(editing) : listView(editing);
    const parts = [left];
    if (editing) parts.push(editor());
    main.replaceChildren(...parts);
    updateLive();
    if (fk) {
      const n = live.fk.get(fk);
      if (n && n !== ae && typeof n.focus === "function") {
        n.focus();
        if (range && typeof n.setSelectionRange === "function") {
          try {
            n.setSelectionRange(range[0], range[1]);
          } catch { /* 時刻の欄などは選択の位置を持たない */ }
        }
      }
    }
  }

  return { open, dispose };
}
