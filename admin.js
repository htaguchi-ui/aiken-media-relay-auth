// 管理コンソール。名簿（members）・回（cohorts）・会場（venues）の管理と使用量の確認を、管理者本人のログインで行う
// （権限は DB の is_admin と RLS で判定）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// 幅 900px 以上は表＋右のパネル（PC）、未満はカード＋下から出るシート（スマホ）。
// supabase-js は admin.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
import {
  ADMIN_ACTIVITY_KEY,
  ADMIN_IDLE_LIMIT_MS,
  ADMIN_STORAGE_KEY,
  browserStorage,
  clearStoredSession,
  idleExpired,
  LEGACY_STORAGE_PREFIX,
} from "./auth-storage.js";
import {
  accessText,
  approxCreditsText,
  canGrant,
  cohortIdOf,
  cohortLabel,
  cohortStatus,
  cohortUsage,
  coursePeriods,
  creditsOf,
  DEFAULT_MONTHLY_CREDITS,
  defaultCohortId,
  displayName,
  emailProblem,
  explainError,
  formatCredits,
  formatDateTime,
  formatDateWithWeekday,
  formatShortDateTime,
  formatUsd,
  formatYen,
  grantTotalProblem,
  matchesFilter,
  matchesQuery,
  MAX_CREDITS,
  MAX_GRANT_TOTAL,
  MONTHLY_FIELDS,
  needsAttention,
  normalizeEmail,
  parseBulk,
  parseCohortForm,
  parseCreditForm,
  parseCredits,
  parseGrantCredits,
  parseVenueForm,
  readInputValue,
  ROLE_LABELS,
  ROLE_SHORT_LABELS,
  ROSTER_FILTERS,
  sortByLastUsed,
  sortByRemaining,
  sumUsage,
  windowLastDayText,
  windowView,
  YEN_PER_USD,
  catalogModes,
  DEFAULT_SETTING_TEXT,
  enabledModelsPayload,
  explainApiError,
  formatSettingValue,
  formatUsdShort,
  globalUsageView,
  applyMaster,
  availableLimits,
  buildModelSave,
  changedScopes,
  emptyScopeWarnings,
  groupModels,
  listText,
  masterState,
  toastOverflow,
  MODEL_SCOPES,
  modelChanges,
  modelLabeler,
  modeBaseOn,
  roleListNotice,
  rolesAvailable,
  saveConfirmLines,
  scopeList,
  scopeModeStatus,
  scopeSelection,
  scopeUsable,
  unknownList,
  activeScopes,
  parseSettingInput,
  sameIdSet,
  sameSettingValue,
  settingRangeText,
  settingsDiff,
  settingSource,
  cohortsSchemaMissing,
  limitChangeCheck,
  rebaseModelDraft,
  resetCarry,
  effectiveDrafts,
  isMissingSchemaError,
  isMonthlyRole,
  isWindowRole,
  rosterFilters,
  roleLabelsFor,
  MSG_STAGE_NOT_READY,
} from "./admin-lib.js";
import {
  adminGrantGroups,
  cohortDateProblem,
  cohortDateRule,
  cohortDeleteBlock,
  DAY_KIND_LABELS,
  DAY_KINDS,
  dayKindStartDate,
  dayKindStarted,
  dayTotals,
  grantRowAction,
  grantTotalLine,
  groupStagesByDay,
  memberDeleteBlock,
  normalizeStageStatus,
  parseStageRows,
  parseTemplateForm,
  REVOKE_CONFIRM_TEXT,
  stageGrantTotalProblem,
  stageName,
  templateApplyProblem,
  MAX_DAY_STAGE_TOTAL,
  MAX_STAGES_PER_DAY,
} from "./stage-lib.js";

// 他のサイトに埋め込まれて操作させられるのを防ぐ（GitHub Pages では frame-ancestors を指定できないため）
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("管理コンソールは埋め込みでは使えません");
}

const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
// 公開用のキー（ブラウザに置く前提のもの）。秘密鍵ではない。consent.html と同じ値
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN";

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない
if (typeof window.supabase?.createClient !== "function") {
  document.getElementById("status").textContent = "画面の部品を読み込めませんでした。通信状態を確認して、ページを開き直してください。";
  throw new Error("supabase-js を読み込めませんでした");
}

// 研修用の Mac でも管理者のログインを残さない：保存はこのタブの間だけ（sessionStorage）、許可の画面とは別の鍵。
// 以前の版が localStorage に残したセッション（許可の画面と共有していた）は、開いた時点で消す
const sessionStore = browserStorage("session");
clearStoredSession(browserStorage("local"), LEGACY_STORAGE_PREFIX);
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    storageKey: ADMIN_STORAGE_KEY,
    ...(sessionStore ? { storage: sessionStore } : {}),
  },
});

const $ = (id) => document.getElementById(id);
const SECTIONS = ["status", "login", "denied", "app"];
const desktopMq = window.matchMedia("(min-width: 900px)");
const isDesktop = () => desktopMq.matches;
let myEmail = "";

/** 画面の状態 */
const state = {
  tab: "roster",
  rows: [],
  /** loading | ok | error（一度も読めていないときだけ error） */
  rowsStatus: "loading",
  rowsError: "",
  cohorts: [],
  venues: [],
  cohortsStatus: "loading",
  cohortsError: "",
  filter: "all",
  query: "",
  selecting: false,
  /** まとめての操作のために選んだ受講者・メンバーの email */
  selected: new Set(),
  /** 回の詳細の「名簿から選ぶ」で来たときの回 */
  selectCohortTarget: null,
  /** 詳細を開いている人（PC は右のパネル、スマホはシート） */
  detailEmail: null,
  detailLoading: false,
  /** 開いている回 */
  cohortId: null,
  cohortLoading: false,
  /** スマホの回の詳細で、日程とクレジットを編集中か */
  cohortEditing: false,
  /** 回の編集欄の未保存の入力 { id, raw }（再読み込みで作り直しても残す） */
  cohortDraft: null,
  /** 回の読み込みの失敗（013 が無いかの判定に使う） */
  cohortsErrorRaw: null,
  updatedAt: null,
  /**
   * 段階（016）の情報。available は DB が 016 を当てているか（cohorts に credit_mode の列があるか）。
   * false の間は、新しい欄・操作を出さず、今までの書き込み（直接の insert・update・delete）を使う
   */
  stages: emptyStageState(),
  /** 設定の画面（初めて開いたときに読む。status は idle | loading | ok | error） */
  settings: {
    status: "idle",
    error: "",
    /** admin_get_settings の結果 */
    info: null,
    historyStatus: "idle",
    historyError: "",
    history: [],
    historyShown: 10,
    modelsStatus: "idle",
    modelsError: "",
    /** admin-api の GET /models の結果 */
    models: null,
    /** 画面上のオン・オフ（未保存を含む model_id の集合）。区分ごと：{ all, student, member } */
    drafts: null,
    /** 開いているモデル（モードごとのスイッチを出している）の key。ページを開き直すまで、保存・タブの切り替え・描き直しのあいだ覚えておく */
    openModels: new Set(),
    /** 「制限なしに戻す」を押した区分（{ student: true }）。保存で null にする。スイッチを押す・元に戻す・読み直しで消える */
    resetNull: {},
    /** 開いているタブ（all・student・member） */
    scope: "all",
  },
};

function show(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

function el(tag, props = {}, ...children) {
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
}

// ---- アイコン（固定の SVG。データは入れない） ----

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  close: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  warn: [["path", { d: "M12 3l9.5 17h-19z" }], ["path", { d: "M12 10v4" }], ["path", { d: "M12 17.5v.01" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7v5l3 2" }]],
  trash: [["path", { d: "M4 7h16" }], ["path", { d: "M9 7V4h6v3" }], ["path", { d: "M6 7l1 13h10l1-13" }]],
  chevron: [["path", { d: "M9 6l6 6-6 6" }]],
  edit: [["path", { d: "M4 20h4l10.5-10.5a2.1 2.1 0 00-3-3L5 17v3" }]],
  users: [
    ["circle", { cx: 9, cy: 8, r: 3.5 }],
    ["path", { d: "M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" }],
    ["path", { d: "M16 4.5a3.5 3.5 0 010 7" }],
    ["path", { d: "M18.5 14.8c1.7.7 2.7 2.4 3 5.2" }],
  ],
};

function icon(name, size = 18, strokeWidth = 2) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": strokeWidth,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

// ---- 小さな部品 ----

function roleBadge(role) {
  return el("span", { className: `badge ${role}`, text: ROLE_SHORT_LABELS[role] ?? role });
}

function statusBadge(status) {
  return status === "active"
    ? el("span", { className: "badge ok", text: "有効" })
    : el("span", { className: "badge stopped", text: "停止中" });
}

/** 段階ごとの枠の回の印（016 が当たっていて、段階の回のときだけ） */
function stageBadge(cohortId) {
  return stagesAvailable() && isStageCohort(cohortId) ? el("span", { className: "badge stage", text: "段階ごと" }) : null;
}

function cohortStatusBadge(period) {
  const s = cohortStatus(period);
  return el("span", { className: `badge ${s.kind}`, text: s.label });
}

/** 使用の割合のバー（low は残り少ない色） */
function bar(pct, low = false, cls = "") {
  const fill = el("span");
  fill.style.width = `${pct}%`;
  return el("span", { className: `bar ${cls} ${low ? "low" : ""}`, role: "img", "aria-label": `使用 ${pct}%` }, fill);
}

function warnBox(text, tag = "div") {
  return el(tag, { className: "warn-box" }, icon("warn", 16), el("span", { text }));
}

function field(labelText, input, hint = null) {
  if (!input.id) input.id = `f-${++fieldSeq}`;
  return el(
    "div",
    { className: "field" },
    el("label", { for: input.id, text: labelText }),
    input,
    hint ? (typeof hint === "string" ? el("span", { className: "hint", text: hint }) : hint) : null,
  );
}
/** 入力欄の id を一意にするための連番（データから id を作らない） */
let fieldSeq = 0;

function textInput(props = {}) {
  return el("input", { type: "text", className: "input", autocomplete: "off", ...props });
}

function creditInput(value, props = {}) {
  const input = textInput({ inputmode: "numeric", placeholder: "例：1000", className: "input num", ...props });
  input.value = value === null || value === undefined ? "" : String(value);
  return input;
}

function dateInput(value) {
  const input = el("input", { type: "date", className: "input num" });
  input.value = value ?? "";
  return input;
}

/** 日付の入力を読む（書きかけ・2/30 など、ブラウザが解釈できない入力は "invalid"） */
function readDate(input) {
  return readInputValue(input.value, input.validity?.badInput);
}

/** クレジットの入力の横に出す円の目安 */
function yenHint(input, suffix = `（1 ドル＝${YEN_PER_USD} 円の目安）`) {
  const hint = el("span", { className: "hint num" });
  const update = () => {
    const n = parseCredits(input.value);
    hint.textContent = n === null ? "" : n === undefined ? "整数で入力してください" : `${formatYen(n)}${suffix}`;
  };
  input.addEventListener("input", update);
  update();
  return hint;
}

function selectInput(options, value, props = {}) {
  const select = el(
    "select",
    { className: "input", ...props },
    ...options.map((o) => el("option", { value: o.value, text: o.label, selected: o.value === value })),
  );
  return select;
}

// ---- お知らせ（画面の上に浮かぶトースト。本文や上の帯を押し下げない） ----
// モーダルのシートは最前面（top layer）で、外は操作できなくなる。そのため、シートが開いている間は入れ物ごとシートの中へ移す（position: fixed なので位置は変わらない）

const NOTICE_MS = 5000;
const NOTICE_MAX = 3;
// 入れ物は最初から読み上げの領域（aria-live）。成功は中身が足されたことで読まれ、エラー・警告は role="alert" で読まれる
const noticeEl = el("div", { id: "notice", role: "region", "aria-label": "お知らせ", "aria-live": "polite", "aria-relevant": "additions text" });
/** 出ているトースト（古い順）。{ node, kind, key, count, timer, hover, focus } */
const toasts = [];

function placeNotice() {
  const host = $("sheet").open ? $("sheet") : document.body;
  if (noticeEl.parentNode === host) return;
  host.prepend(noticeEl);
  // 付け替えるとフォーカスは外れ、focusout が来ないことがある：「フォーカス中」「マウスを乗せている」の印を消して、消えるまでの数えを再開する
  for (const t of toasts) {
    t.focus = false;
    t.hover = false;
    scheduleToast(t);
  }
}

function dismissToast(t) {
  clearTimeout(t.timer);
  const i = toasts.indexOf(t);
  if (i >= 0) toasts.splice(i, 1);
  t.node.remove();
}

/** 成功・お知らせだけ自動で消す。マウスを乗せている間・フォーカスしている間は消さない */
function scheduleToast(t) {
  clearTimeout(t.timer);
  if (t.kind !== "ok" || t.hover || t.focus) return;
  t.timer = setTimeout(() => dismissToast(t), NOTICE_MS);
}

/** 画面上部のお知らせ。kind は "ok"（数秒で消える）・"error"・"warn"（閉じるまで残る）。details は箇条書き。直前と同じ文は 1 つにまとめる（×回数） */
function notify(message, kind = "ok", details = []) {
  if (kind !== "error" && kind !== "warn") kind = "ok";
  placeNotice();
  const key = [kind, message, ...details].join("\n");
  const last = toasts[toasts.length - 1];
  if (last && last.key === key) {
    last.count += 1;
    last.node.querySelector(".notice-count").textContent = `×${last.count}`;
    last.node.querySelector(".notice-count").hidden = false;
    scheduleToast(last);
    return;
  }
  const node = el(
    "div",
    { className: `toast ${kind}`, ...(kind === "ok" ? {} : { role: "alert" }) },
    el(
      "div",
      { className: "notice-body" },
      el("p", { className: "notice-msg" }, el("span", { text: message }), el("span", { className: "notice-count small num", hidden: true })),
      details.length ? el("ul", {}, ...details.map((d) => el("li", { text: d }))) : null,
    ),
  );
  const t = { node, kind, key, count: 1, timer: 0, hover: false, focus: false };
  node.append(el("button", { type: "button", className: "icon-btn bare", "aria-label": "お知らせを閉じる", onclick: () => dismissToast(t) }, icon("close")));
  node.addEventListener("mouseenter", () => {
    t.hover = true;
    scheduleToast(t);
  });
  node.addEventListener("mouseleave", () => {
    t.hover = false;
    scheduleToast(t);
  });
  node.addEventListener("focusin", () => {
    t.focus = true;
    scheduleToast(t);
  });
  node.addEventListener("focusout", (e) => {
    if (e.relatedTarget && node.contains(e.relatedTarget)) return;
    t.focus = false;
    scheduleToast(t);
  });
  toasts.push(t);
  noticeEl.append(node);
  // あふれたら、成功・お知らせから古い順に消す（エラー・警告は、それだけで上限を超えるときだけ）
  for (const i of toastOverflow(toasts.map((x) => x.kind), NOTICE_MAX).reverse()) dismissToast(toasts[i]);
  scheduleToast(t);
}

/** 出ているお知らせをすべて消す（操作のはじめに、前のお知らせを片づける） */
function clearNotice() {
  for (const t of [...toasts]) dismissToast(t);
}

// 読み上げの領域は、お知らせが出る前から画面に置いておく
placeNotice();

function fatal(message) {
  $("status").replaceChildren(el("p", { className: "error-text", text: message }));
  show("status");
}

// ---- シート（スマホは下から、PC は中央のダイアログ） ----

const sheet = $("sheet");
let sheetKind = null;
let sheetRender = null;

/** シートを開く（開いていれば中身を差し替える）。render は中身を作る関数（データの更新後にも呼ぶ） */
function openSheet(kind, render) {
  sheetKind = kind;
  sheetRender = render;
  render();
  if (!sheet.open) sheet.showModal();
  placeNotice();
}

function closeSheet() {
  if (sheet.open) sheet.close();
}

/** シートの中身を組み立てる。head を渡すときは、その中に id="sheet-title" の見出しを入れる */
function setSheet({ title = "", head = null, body = [], foot = [] }) {
  const scroll = sheet.scrollTop;
  // お知らせの入れ物は外さない（外して付け直すと、出る動きと読み上げがやり直しになる）。それ以外を入れ替える
  for (const c of [...sheet.children]) if (c !== noticeEl) c.remove();
  sheet.append(
    el("div", { className: "sheet-grab", "aria-hidden": "true" }),
    el(
      "div",
      { className: "sheet-head" },
      head ?? el("h2", { id: "sheet-title", text: title }),
      el("button", { type: "button", className: "icon-btn", "aria-label": "閉じる", onclick: closeSheet }, icon("close", 18, 2.2)),
    ),
    el("div", { className: "sheet-body" }, ...body),
    ...(foot.length ? [el("div", { className: "sheet-foot" }, ...foot)] : []),
  );
  placeNotice();
  sheet.scrollTop = scroll;
}

sheet.addEventListener("close", () => {
  sheetKind = null;
  sheetRender = null;
  placeNotice(); // 閉じたので入れ物を body へ戻す（シートの中身を消す前に）
  sheet.replaceChildren();
});
// 背景（シートの外）を押したら閉じる
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) closeSheet();
});

function cancelButton(text = "キャンセル") {
  return el("button", { type: "button", className: "btn big cancel", text, onclick: closeSheet });
}

// ---- ログイン ----

function returnUrl() {
  return location.origin + location.pathname;
}

async function signIn() {
  // Google から戻ったときに「記録が無い＝時間切れ」にならないよう、ログインを始めた時刻を書いておく
  markActive(true);
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: returnUrl(), queryParams: { prompt: "select_account" } },
  });
}

async function signOut() {
  // この管理コンソールのセッションだけを切る（global だと、管理者本人の ChatGPT・Codex・Claude Code の接続まで切れる）
  await endSession("local");
  location.replace(returnUrl());
}

/** ログアウトして、タブに残る分（セッション・最後の操作の時刻）も消す（通信できなくても消す） */
async function endSession(scope = "local") {
  try {
    await supabase.auth.signOut({ scope });
  } catch {
    // 下で消す
  }
  clearStoredSession(sessionStore, ADMIN_STORAGE_KEY);
}

// ---- 操作が無いときのログアウト（30 分） ----

let lastActiveWrite = 0;
let idleTimer = null;

/** 操作したことを記録する（書き込みは 15 秒に 1 回まで） */
function markActive(force = false) {
  const now = Date.now();
  if (!force && now - lastActiveWrite < 15000) return;
  lastActiveWrite = now;
  try {
    sessionStore?.setItem(ADMIN_ACTIVITY_KEY, String(now));
  } catch {
    // 記録できなくても続ける
  }
}

function lastActive() {
  try {
    return sessionStore?.getItem(ADMIN_ACTIVITY_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 30 分操作が無ければログアウトして、ログインの画面に戻す。ログアウトしたら true */
async function logoutIfIdle() {
  const last = lastActive();
  if (!idleExpired(last, Date.now(), ADMIN_IDLE_LIMIT_MS)) return false;
  stopIdleWatch();
  await endSession();
  if (sheet.open) closeSheet();
  clearNotice();
  showLoginNote(
    last === null
      ? "ログインの記録を確かめられなかったため、ログアウトしました。もう一度ログインしてください。"
      : `${ADMIN_IDLE_LIMIT_MS / 60000} 分間操作が無かったため、ログアウトしました。`,
  );
  show("login");
  return true;
}

function showLoginNote(text) {
  $("login-note").textContent = text;
  $("login-note").hidden = !text;
}

function startIdleWatch() {
  markActive(true);
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "input"]) {
    document.addEventListener(type, () => markActive(), { capture: true, passive: true });
  }
  // スリープ・背面のタブではタイマーが遅れるので、前に出たときにも確かめる
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") logoutIfIdle();
  });
  idleTimer = setInterval(logoutIfIdle, 30000);
}

function stopIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

// ---- 読み込み ----

/** 枠のある区分（まとめての操作・クレジット追加の対象） */
function hasWindow(r) {
  return isWindowRole(r.role);
}

function applyRows(data) {
  state.rows = sortByLastUsed(data ?? []);
  state.rowsStatus = "ok";
  state.rowsError = "";
  state.updatedAt = new Date().toISOString();
  for (const email of [...state.selected]) {
    const r = state.rows.find((x) => x.email === email);
    if (!r || !hasWindow(r)) state.selected.delete(email);
  }
}

async function loadUsage() {
  const { data, error } = await supabase.rpc("admin_usage");
  if (error) {
    state.rowsError = explainError(error);
    if (state.rowsStatus !== "ok") state.rowsStatus = "error";
    notify(`名簿を読み込めませんでした。${state.rowsError}`, "error");
    return false;
  }
  applyRows(data);
  return true;
}

/** 回と会場（013）がまだ DB に無いか（このときは members に cohort_id を送らない・名簿に案内を出す） */
function no013() {
  return cohortsSchemaMissing(state.cohortsErrorRaw, state.rows);
}

async function loadCohorts() {
  const [c, v] = await Promise.all([
    supabase.rpc("admin_cohorts"),
    supabase.from("venues").select("no, name, note, active").order("no"),
  ]);
  const error = c.error || v.error;
  state.cohortsErrorRaw = error ?? null;
  if (error) {
    state.cohortsError = explainError(error);
    if (state.cohortsStatus !== "ok") state.cohortsStatus = "error";
    return false;
  }
  state.cohorts = c.data ?? [];
  state.venues = v.data ?? [];
  state.cohortsStatus = "ok";
  state.cohortsError = "";
  return true;
}

/** 名簿・回・会場を読み直して、画面を作り直す */
async function refresh() {
  $("reload-btn").disabled = true;
  try {
    await Promise.all([loadUsage(), loadCohorts(), loadStageInfo(), state.settings.status !== "idle" ? loadSettingsAll() : null]);
  } finally {
    $("reload-btn").disabled = false;
  }
  renderAll();
}

/** その人の最新の行（今の枠）を読み直す。{ ok: false } は読み直しの失敗、row が無ければ名簿に無い */
async function freshRow(email) {
  const { data, error } = await supabase.rpc("admin_usage");
  if (error) return { ok: false };
  return { ok: true, rows: data ?? [], row: (data ?? []).find((x) => x.email === email) ?? null };
}

// ---- 全体の描画 ----

function renderAll() {
  document.body.classList.toggle("selecting", state.selecting && state.tab === "roster");
  for (const [id, tab] of [["tab-roster", "roster"], ["tab-cohorts", "cohorts"], ["tab-settings", "settings"]]) {
    if (state.tab === tab) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  $("view-roster").hidden = state.tab !== "roster";
  $("view-cohorts").hidden = state.tab !== "cohorts";
  $("view-settings").hidden = state.tab !== "settings";
  if (state.detailEmail && state.rowsStatus === "ok" && !state.rows.some((r) => r.email === state.detailEmail)) {
    state.detailEmail = null;
  }
  if (state.cohortId && state.cohortsStatus === "ok" && !state.cohorts.some((c) => c.id === state.cohortId)) {
    state.cohortId = null;
  }
  renderOverview();
  renderRoster();
  renderCohorts();
  renderSettings();
  renderMemberAside();
  renderCohortAside();
  renderSelectBar();
  renderFab();
  $("updated-at").textContent = state.updatedAt ? formatShortDateTime(state.updatedAt) : "—";
  const me = state.rows.find((r) => r.email === myEmail);
  $("account-btn").textContent = (displayName(me ?? { email: myEmail }) || "?").slice(0, 1).toUpperCase();
  if (sheet.open && sheetRender) sheetRender();
}

function switchTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  if (tab !== "roster" && state.selecting) {
    state.selecting = false;
    state.selected.clear();
    state.selectCohortTarget = null;
  }
  renderAll();
  window.scrollTo(0, 0);
  if (tab === "settings" && state.settings.status === "idle") loadSettingsAll();
}

function renderFab() {
  const fab = $("fab");
  const roster = state.tab === "roster";
  fab.replaceChildren(icon("plus", 20, 2.4), roster ? "追加" : "回を作成");
  fab.hidden = (state.selecting && roster) || state.tab === "settings";
}

function ovItem({ label, value, unit, sub = null, subClass = "", className = "", warn = false, onclick = null, title = null }) {
  return el(
    onclick ? "button" : "div",
    { type: onclick ? "button" : null, className: `ov-item ${warn ? "warn" : ""} ${className}`, onclick, title },
    el("span", { className: "ov-label", text: label }),
    el("span", { className: "ov-value num" }, String(value), el("span", { className: "unit", text: unit })),
    sub ? el("span", { className: `ov-sub num ${subClass}`, text: sub }) : null,
  );
}

function renderOverview() {
  const box = $("overview");
  const line = $("overview-line");
  // 設定の画面は、直近 24 時間の利用を画面の中に出すので、概要は出さない
  box.hidden = state.tab === "settings";
  if (state.tab === "settings") {
    line.hidden = true;
    return;
  }
  if (state.tab === "roster") {
    box.classList.remove("desk-only");
    line.hidden = true;
    const rows = state.rows;
    const ok = state.rowsStatus === "ok";
    const t = sumUsage(rows);
    const needs = rows.filter(needsAttention).length;
    box.replaceChildren(
      ovItem({
        label: "登録",
        value: ok ? rows.length : "—",
        unit: "人",
        sub: ok ? `有効 ${rows.filter((r) => r.status === "active").length} 人` : null,
        subClass: "desk-only",
      }),
      ovItem({ label: "今日の生成", value: ok ? t.today_count : "—", unit: "回", sub: ok ? approxCreditsText(t.today_cost_usd) : null, subClass: "mobile-only" }),
      ovItem({
        label: "今日の消費（目安）",
        value: ok ? formatCredits(creditsOf(t.today_cost_usd)) : "—",
        unit: "クレジット",
        sub: ok ? `24時間 約 ${formatCredits(creditsOf(t.day_cost_usd))}・累計 約 ${formatCredits(creditsOf(t.total_cost_usd))}` : null,
        className: "desk-only",
        title: `見積額：今日 ${formatUsd(t.today_cost_usd)}・24時間 ${formatUsd(t.day_cost_usd)}・累計 ${formatUsd(t.total_cost_usd)}`,
      }),
      ovItem({
        label: "要対応",
        value: ok ? needs : "—",
        unit: "人",
        sub: ok ? (needs ? "未設定・残り少" : "なし") : null,
        warn: ok && needs > 0,
        onclick: () => setFilter("needs"),
      }),
    );
    return;
  }
  // 回：スマホは 1 行、PC は 4 つのカード
  const cs = state.cohorts;
  const students = cs.reduce((n, c) => n + Number(c.member_count ?? 0), 0);
  const unset = cs.filter((c) => c.has_unset_credits && c.current_period !== "after").length;
  line.hidden = state.cohortsStatus !== "ok";
  line.textContent = `回 ${cs.length}件 · 受講者 ${students}人`;
  box.classList.add("desk-only");
  const ok = state.cohortsStatus === "ok";
  const v = (n) => (ok ? n : "—");
  box.replaceChildren(
    ovItem({ label: "回", value: v(cs.length), unit: "件" }),
    ovItem({ label: "開催中", value: v(cs.filter((c) => cohortStatus(c.current_period).kind === "active").length), unit: "件" }),
    ovItem({ label: "受講者", value: v(students), unit: "人" }),
    ovItem({ label: "クレジット未設定", value: v(unset), unit: "件", warn: ok && unset > 0 }),
  );
}

// ---- 名簿 ----

function visibleRows() {
  return state.rows.filter((r) => matchesFilter(r, state.filter) && matchesQuery(r, state.query));
}

function setFilter(id) {
  state.filter = id;
  if (state.tab !== "roster") switchTab("roster");
  renderRoster();
}

function renderChips() {
  $("chips").replaceChildren(
    ...rosterFilters(state.rows).map((f) =>
      el(
        "button",
        {
          type: "button",
          className: "chip",
          "aria-pressed": String(state.filter === f.id),
          onclick: () => setFilter(f.id),
        },
        f.label,
        el("span", { className: "count num", text: String(state.rows.filter((r) => matchesFilter(r, f.id)).length) }),
      )
    ),
  );
}

function emptyBox(message, ...actions) {
  return el("div", { className: "empty" }, el("p", { text: message }), ...actions);
}

function errorBox(message, retry = refresh) {
  return el(
    "div",
    { className: "empty error", role: "alert" },
    el("p", { text: message }),
    el("button", { type: "button", className: "btn", text: "読み込み直す", onclick: retry }),
  );
}

function renderRoster() {
  renderChips();
  $("roster-banner").replaceChildren(
    ...(no013()
      ? [warnBox("DB の更新（回と会場：013）がまだ適用されていません。受講者は旧い個別の日付で判定され、回の設定・「回」の画面は使えません。受講者の追加は、回を設定せずに行います。")]
      : []),
  );
  const list = $("roster-list");
  if (state.rowsStatus === "loading") {
    $("shown-count").textContent = "";
    renderSelHead([]);
    list.replaceChildren(emptyBox("読み込み中…"));
    return;
  }
  if (state.rowsStatus === "error") {
    $("shown-count").textContent = "";
    renderSelHead([]);
    list.replaceChildren(errorBox(`名簿を読み込めませんでした。${state.rowsError}`));
    return;
  }
  const rows = visibleRows();
  $("shown-count").textContent = `${rows.length}人`;
  renderSelHead(rows);
  if (!state.rows.length) {
    list.replaceChildren(
      emptyBox(
        "まだ誰も登録されていません。",
        el("button", { type: "button", className: "btn primary", text: "名簿に追加", onclick: () => openAdd() }),
      ),
    );
    return;
  }
  if (!rows.length) {
    list.replaceChildren(
      emptyBox(
        "条件に合う人がいません。",
        el("button", {
          type: "button",
          className: "btn",
          text: "絞り込みを解除",
          onclick: () => {
            state.filter = "all";
            state.query = "";
            $("q").value = "";
            renderRoster();
          },
        }),
      ),
    );
    return;
  }
  const head = isDesktop() && !state.selecting
    ? el(
      "div",
      { className: "trow head", "aria-hidden": "true" },
      el("span", { text: "名前・メール" }),
      el("span", { text: "区分・回" }),
      el("span", { text: "今の枠（残り）" }),
      el("span", { text: "最終アクセス" }),
    )
    : null;
  list.replaceChildren(
    ...[head, el("ul", { className: "list", "aria-label": "名簿" }, ...rows.map((r) => el("li", {}, rosterItem(r))))].filter(Boolean),
  );
}

function rosterItem(r) {
  if (state.selecting) return pickItem(r);
  return isDesktop() ? tableRow(r) : rosterCard(r);
}

function nameText(r) {
  return displayName(r) + (r.email === myEmail ? "（自分）" : "");
}

/** 今の枠（カード用）。span だけで組む（ボタンの中に入れるため） */
function quotaBlock(r, v) {
  const prefix = r.role === "student" && r.cohort_id ? `${r.cohort_id} · ` : "";
  const out = [];
  if (v.state === "quota") {
    out.push(
      el(
        "span",
        { className: "quota" },
        el(
          "span",
          { className: "quota-row" },
          el("span", { className: "quota-label ellipsis num", text: prefix + v.shortLabel }),
          el(
            "span",
            { className: "quota-num num" },
            el("b", { className: v.low ? "low-text" : "", text: `残り ${formatCredits(v.remaining)}` }),
            el("span", { className: "muted", text: ` / ${formatCredits(v.limit)}` }),
          ),
        ),
        bar(v.pct, v.low),
      ),
    );
  } else if (v.state === "unset") {
    out.push(warnBox(v.text, "span"));
  } else {
    out.push(el("span", { className: "small muted num", text: prefix + v.text }));
  }
  if (v.legacy) out.push(warnBox("回が未設定です（今は旧い個別の期間で判定しています）", "span"));
  return out;
}

function rosterCard(r) {
  const v = windowView(r);
  return el(
    "button",
    { type: "button", className: "card", onclick: () => openMember(r.email) },
    el(
      "span",
      { className: "card-top" },
      el("span", { className: "card-name ellipsis", text: nameText(r) }),
      r.status !== "active" ? statusBadge(r.status) : null,
      roleBadge(r.role),
    ),
    r.display_name?.trim() ? el("span", { className: "card-email ellipsis", text: r.email }) : null,
    quotaBlock(r, v),
    el("span", { className: "meta" }, icon("clock", 14), el("span", { className: "num ellipsis", text: accessText(r) })),
  );
}

function tableRow(r) {
  const v = windowView(r);
  const cohortText = r.role === "student" ? (r.cohort_id ?? "回が未設定") : isMonthlyRole(r.role) ? "月額制" : "";
  let quota;
  if (v.state === "quota") {
    quota = [
      el(
        "span",
        { className: "num small" },
        el("b", { className: v.low ? "low-text" : "", text: `残り ${formatCredits(v.remaining)}` }),
        el("span", { className: "muted", text: ` / ${formatCredits(v.limit)}` }),
      ),
      bar(v.pct, v.low, "thin"),
    ];
  } else if (v.state === "unset") {
    quota = el("span", { className: "small warn-text", text: v.text });
  } else {
    quota = el("span", { className: "small muted", text: v.state === "none" ? "対象外" : v.text });
  }
  return el(
    "button",
    {
      type: "button",
      className: `trow ${state.detailEmail === r.email ? "is-selected" : ""}`,
      "aria-current": state.detailEmail === r.email ? "true" : null,
      onclick: () => openMember(r.email),
    },
    el(
      "span",
      { className: "cell" },
      el("span", { className: "ellipsis strong", text: nameText(r) }),
      r.display_name?.trim() ? el("span", { className: "small muted ellipsis", text: r.email }) : null,
    ),
    el(
      "span",
      { className: "cell" },
      el("span", { className: "badges" }, roleBadge(r.role), r.status !== "active" ? statusBadge(r.status) : null),
      cohortText ? el("span", { className: `small num ${r.role === "student" && !r.cohort_id ? "warn-text" : "muted"}`, text: cohortText }) : null,
    ),
    el("span", { className: "cell stretch" }, quota, v.legacy ? el("span", { className: "small warn-text", text: "回が未設定（旧い期間で判定中）" }) : null),
    el("span", { className: "num small muted", text: accessText(r) }),
  );
}

// ---- 選択モード（まとめての操作） ----

function selectedRows() {
  return state.rows.filter((r) => state.selected.has(r.email) && hasWindow(r));
}

function enterSelect({ cohortTarget = null } = {}) {
  closeSheet();
  state.tab = "roster";
  state.selecting = true;
  state.selected.clear();
  state.selectCohortTarget = cohortTarget;
  if (cohortTarget) {
    state.filter = "student";
    state.query = "";
    $("q").value = "";
  }
  renderAll();
  window.scrollTo(0, 0);
}

function exitSelect() {
  state.selecting = false;
  state.selected.clear();
  state.selectCohortTarget = null;
  renderAll();
}

function renderSelHead(visible) {
  const host = $("roster-selhead");
  if (!state.selecting) {
    host.replaceChildren();
    return;
  }
  const targets = visible.filter(hasWindow);
  const allOn = targets.length > 0 && targets.every((r) => state.selected.has(r.email));
  const sel = selectedRows();
  const students = sel.filter((r) => r.role === "student").length;
  const members = sel.length - students;
  const filterLabel = rosterFilters(state.rows).find((f) => f.id === state.filter)?.label;
  const narrowed = state.filter !== "all" || state.query.trim()
    ? `今は絞り込み（${[state.filter !== "all" ? filterLabel : "", state.query.trim() ? `「${state.query.trim()}」` : ""].filter(Boolean).join("・")}）中です。`
    : "";
  host.replaceChildren(
    el(
      "div",
      { className: "selhead" },
      el("h2", { className: "num", text: `${sel.length}人を選択` }),
      el(
        "div",
        { className: "actions" },
        el("button", {
          type: "button",
          className: "link-btn",
          text: allOn ? "選択を外す" : "すべて選択",
          disabled: !targets.length,
          onclick: () => {
            for (const r of targets) {
              if (allOn) state.selected.delete(r.email);
              else state.selected.add(r.email);
            }
            renderRoster();
            renderSelectBar();
          },
        }),
        el("button", { type: "button", className: "link-btn", text: "キャンセル", onclick: exitSelect }),
      ),
    ),
    el("p", {
      className: "sel-hint",
      text: [
        state.selectCohortTarget
          ? `${state.selectCohortTarget} に所属させる受講者を選びます。`
          : "まとめて設定するときは、受講者とメンバーを分けて選ぶと分かりやすくなります。",
        `受講者 ${students}人・メンバー ${members}人（管理者は選べません）。`,
        narrowed,
      ].join(""),
    }),
  );
}

function pickItem(r) {
  const selectable = hasWindow(r);
  const cb = el("input", { type: "checkbox", checked: selectable && state.selected.has(r.email), disabled: !selectable });
  cb.addEventListener("change", () => {
    if (cb.checked) state.selected.add(r.email);
    else state.selected.delete(r.email);
    renderSelHead(visibleRows());
    renderSelectBar();
  });
  return el(
    "label",
    { className: `pick ${selectable ? "" : "disabled"}`, title: selectable ? null : "まとめての操作は受講者と AIKENメンバーだけが対象です" },
    cb,
    el(
      "span",
      { className: "pick-text" },
      el("span", { className: "ellipsis strong", text: nameText(r) }),
      r.display_name?.trim() ? el("span", { className: "small muted ellipsis", text: r.email }) : null,
    ),
    r.status !== "active" ? statusBadge(r.status) : null,
    roleBadge(r.role),
  );
}

function renderSelectBar() {
  const barEl = $("selectbar");
  if (!state.selecting || state.tab !== "roster") {
    barEl.hidden = true;
    barEl.replaceChildren();
    return;
  }
  const sel = selectedRows();
  const students = sel.filter((r) => r.role === "student");
  const members = sel.filter((r) => isMonthlyRole(r.role));
  const allStopped = sel.length > 0 && sel.every((r) => r.status !== "active");
  const target = state.selectCohortTarget;
  barEl.hidden = false;
  barEl.replaceChildren(
    el(
      "div",
      { className: "selectbar-inner" },
      el("button", {
        type: "button",
        className: "btn primary big",
        text: target ? `${target} に所属させる` : "所属する回を設定",
        disabled: !students.length,
        title: students.length ? null : "受講者を選んでください",
        onclick: () => (target ? applyCohort(selectedRows(), target) : openCohortPicker(selectedRows())),
      }),
      el(
        "div",
        { className: "row" },
        members.length
          ? el("button", { type: "button", className: "btn", text: "月額を設定", onclick: () => openBulkMonthly(selectedRows()) })
          : null,
        el("button", { type: "button", className: "btn", text: "クレジットを追加", disabled: !sel.length, onclick: () => openBulkGrant(selectedRows()) }),
        el("button", {
          type: "button",
          className: "btn",
          text: allStopped ? "利用を再開" : "利用を停止",
          disabled: !sel.length,
          onclick: () => bulkStatus(selectedRows(), allStopped ? "active" : "disabled"),
        }),
      ),
    ),
  );
}

// ---- 受講者・メンバー・管理者の詳細 ----

let detailSeq = 0;

async function openMember(email) {
  const seq = ++detailSeq;
  state.detailEmail = email;
  state.detailLoading = true;
  if (isDesktop()) {
    renderRoster();
    renderMemberAside();
  } else {
    openSheet("member", () => setSheet({ title: "読み込み中…", body: [el("p", { className: "muted", text: "最新の状態を読み込んでいます…" })] }));
  }
  const fresh = await freshRow(email);
  if (seq !== detailSeq) return;
  state.detailLoading = false;
  if (!isDesktop() && sheetKind !== "member") return; // 読み込み中に閉じられた
  if (!fresh.ok) {
    notify("最新の状態を読めませんでした。一覧を読み込み直してください。", "error");
    closeMember();
    return;
  }
  applyRows(fresh.rows);
  if (!fresh.row) {
    closeMember();
    notify(`${email} は名簿に見つからなかったため、一覧を読み込み直しました。`, "error");
    renderAll();
    return;
  }
  if (!isDesktop()) openSheet("member", renderMemberSheet);
  renderAll();
}

function closeMember() {
  state.detailEmail = null;
  state.detailLoading = false;
  if (sheetKind === "member") closeSheet();
  renderMemberAside();
  renderRoster();
}

function renderMemberSheet() {
  const r = state.rows.find((x) => x.email === state.detailEmail);
  if (!r) {
    closeSheet();
    return;
  }
  const d = memberDetail(r, "sheet-title");
  setSheet({ head: d.head, body: d.sections });
}

function renderMemberAside() {
  const aside = $("roster-aside");
  if (!isDesktop()) return;
  if (state.detailLoading) {
    aside.replaceChildren(el("p", { className: "side-empty", text: "読み込み中…" }));
    return;
  }
  const r = state.detailEmail && state.rows.find((x) => x.email === state.detailEmail);
  if (!r) {
    aside.replaceChildren(el("p", { className: "side-empty", text: "名簿から人を選ぶと、ここに詳細が出ます。" }));
    return;
  }
  const d = memberDetail(r, "aside-title");
  aside.replaceChildren(d.head, ...d.sections);
}

function memberDetail(r, titleId) {
  const v = windowView(r);
  const head = el(
    "div",
    { className: "detail-title" },
    el("h2", { id: titleId, className: "title-lg", text: nameText(r) }),
    r.display_name?.trim() ? el("span", { className: "sub ellipsis", text: r.email, title: r.email }) : null,
    el("div", { className: "badges" }, roleBadge(r.role), statusBadge(r.status)),
  );
  const sections = [];
  if (hasWindow(r)) sections.push(windowSection(r, v));
  if (r.role === "student") sections.push(cohortSection(r, v));
  if (isMonthlyRole(r.role)) sections.push(monthlySection(r));
  sections.push(usageSection(r));
  if (hasWindow(r)) sections.push(grantsSection(r));
  sections.push(...manageSection(r));
  return { head, sections };
}

function windowSection(r, v) {
  const canAdd = canGrant(r);
  const credits = creditInput("", { placeholder: "例：500" });
  const note = textInput({ placeholder: "例：授業中に不足したため" });
  const form = el(
    "div",
    { className: "grant-form", hidden: true },
    field("追加するクレジット", credits, yenHint(credits)),
    field("メモ（任意。理由など）", note),
    el(
      "div",
      { className: "row-actions end" },
      el("button", {
        type: "button",
        className: "btn",
        text: "やめる",
        onclick: () => {
          form.hidden = true;
          toggle.setAttribute("aria-expanded", "false");
        },
      }),
      el("button", { type: "button", className: "btn primary", text: "追加する", onclick: () => addGrant(r, credits.value, note.value) }),
    ),
  );
  const toggle = el(
    "button",
    {
      type: "button",
      className: "btn soft",
      disabled: !canAdd,
      "aria-expanded": "false",
      onclick: () => {
        form.hidden = !form.hidden;
        toggle.setAttribute("aria-expanded", String(!form.hidden));
        if (!form.hidden) credits.focus();
      },
    },
    icon("plus", 18, 2.4),
    "クレジットを追加",
  );
  const content = [];
  if (v.state === "quota") {
    content.push(
      el(
        "div",
        { className: "bignum num" },
        el("span", { className: `big-n ${v.low ? "low" : ""}`, text: formatCredits(v.remaining) }),
        el("span", { className: "muted", text: `/ ${formatCredits(v.limit)} クレジット 残り` }),
      ),
      bar(v.pct, v.low, "thick"),
      el(
        "div",
        { className: "breakdown num" },
        el("span", { text: `基本 ${formatCredits(v.base)}` }),
        el("span", { text: `追加 +${formatCredits(v.granted)}` }),
        el("span", { text: `使用 ${formatCredits(v.used)}` }),
        isMonthlyRole(r.role) ? el("span", { text: `上限 ${formatYen(v.limit)}` }) : null,
      ),
    );
  } else if (v.state === "unset") {
    content.push(warnBox(v.text));
  } else {
    content.push(el("p", { className: "muted", text: v.text }));
  }
  if (v.legacy) content.push(warnBox("回が未設定です。今は旧い個別の期間で判定しています。所属する回を設定してください。"));
  return el(
    "section",
    { className: "box" },
    el(
      "div",
      { className: "box-head baseline" },
      el("h3", { className: "minor", text: "今の枠" }),
      v.label ? el("span", { className: "strong small num", text: v.label }) : null,
    ),
    ...content,
    toggle,
    canAdd ? null : el("p", { className: "hint", text: "今の枠が無い（期間外・未設定）ため、クレジットを追加できません。" }),
    isStageStudent(r)
      ? el("p", { className: "hint", text: "この人の回は、段階ごとの枠です。上限は今の段階で決まり、講師が段階を進めると切り替わります。追加は今の段階に付きます。" })
      : null,
    form,
  );
}

function periodList(c, currentPeriod) {
  return el(
    "ol",
    { className: "periods" },
    ...coursePeriods(c, currentPeriod).map((p) =>
      el(
        "li",
        { className: p.state },
        el("span", { className: "dot", "aria-hidden": "true" }),
        el(
          "div",
          { className: "period-text" },
          el("span", { className: "period-name" }, p.name, p.state === "now" ? el("span", { className: "badge now", text: "今" }) : null),
          el("span", { className: "small muted num", text: p.dates }),
        ),
        el("span", { className: `period-credits num ${p.unset ? "unset" : ""}`, text: p.credits }),
      )
    ),
  );
}

function cohortSection(r, v) {
  if (!r.cohort_id) {
    return el(
      "section",
      { className: "box" },
      el("h3", { text: "所属する回" }),
      warnBox(v.legacy ? "回が未設定です（今は旧い個別の期間で判定しています）" : "回が未設定（生成できません）"),
      el("button", { type: "button", className: "btn primary", text: "回を設定", onclick: () => openCohortPicker([r]) }),
    );
  }
  const c = state.cohorts.find((x) => x.id === r.cohort_id);
  const labelText = cohortLabel(c ?? { id: r.cohort_id, name: r.cohort_name, venue_name: r.venue_name });
  return el(
    "section",
    { className: "box tight" },
    el(
      "div",
      { className: "box-head" },
      el("div", { className: "detail-title" }, el("h3", { text: "所属する回" }), el("span", { className: "small num", text: labelText })),
      el("button", { type: "button", className: "link-btn", text: "回を開く", onclick: () => openCohort(r.cohort_id) }),
    ),
    // admin_usage の日付・クレジットは「実際に適用される値」（回に所属していれば回の値）
    periodList(r, r.current_period),
    el("p", { className: "hint", text: "日付とクレジットは回で設定します。この人だけ足りないときは「クレジットを追加」を使います。" }),
  );
}

function monthlySection(r) {
  const input = creditInput(r.monthly_credits, { placeholder: "例：3300" });
  return el(
    "section",
    { className: "box" },
    el("h3", { text: "月額のクレジット" }),
    field("毎月（日本時間の 1 日に戻る・繰り越しなし）", input, yenHint(input)),
    el("p", { className: "hint", text: "空欄で保存すると未設定（生成できません）になります。" }),
    el("button", { type: "button", className: "btn primary", text: "月額を保存", onclick: () => saveMonthly(r, input.value) }),
  );
}

function usageSection(r) {
  const stat = (label, count, cost) =>
    el(
      "div",
      { className: "stat", title: `見積額 ${formatUsd(cost)}` },
      el("div", { className: "small muted", text: label }),
      el("div", { className: "stat-v num" }, String(Number(count ?? 0)), el("span", { className: "unit", text: " 回" })),
      el("div", { className: "small muted num", text: approxCreditsText(cost) }),
    );
  return el(
    "section",
    { className: "box" },
    el("h3", { text: "使用状況" }),
    el(
      "div",
      { className: "stats" },
      stat("今日", r.today_count, r.today_cost_usd),
      stat("24時間", r.day_count, r.day_cost_usd),
      stat("累計", r.total_count, r.total_cost_usd),
    ),
    el(
      "dl",
      { className: "kv num" },
      el("dt", { text: "最終生成" }),
      el("dd", { text: formatShortDateTime(r.last_used_at) }),
      el("dt", { text: "最終アクセス" }),
      el("dd", { text: accessText(r) }),
      r.note ? el("dt", { text: "メモ" }) : null,
      r.note ? el("dd", { text: r.note }) : null,
    ),
    el("p", { className: "hint", text: "「今日」は日本時間の 0 時から、「24時間」は直近 24 時間。クレジットは見積額からの目安です。" }),
  );
}

function grantsSection(r) {
  const list = el("ul", { className: "grants" }, el("li", { className: "muted", text: "読み込み中…" }));
  loadGrants(r, list);
  return el(
    "section",
    { className: "box" },
    el("h3", { text: isStageStudent(r) ? "この回で追加したクレジット" : "今の枠で追加したクレジット" }),
    list,
  );
}

/** 一時追加の一覧の 1 行（段階の回の行と、Day ごと・月額の行で、ボタンが違う） */
function grantItem(r, g, isStageRow) {
  const action = grantRowAction(g, isStageRow);
  const text = el(
    "div",
    { className: "gtext" },
    el("span", { className: `ellipsis ${g.note ? "" : "muted"}`, text: g.note || "メモなし", title: g.note || null }),
    el(
      "span",
      { className: "small muted num ellipsis" },
      `${formatShortDateTime(g.createdAt)} · ${g.createdByEmail ?? "付与した人は不明"}${g.grantedAs === "instructor" ? "（講師）" : ""}`,
    ),
  );
  let tail = null;
  if (action.kind === "revoke") {
    tail = el("button", { type: "button", className: "btn small-btn", text: action.label, "aria-label": `この追加（+${formatCredits(g.credits)}）を取り消す`, onclick: () => revokeStageGrant(r, g) });
  } else if (action.kind === "none") {
    tail = el("span", { className: "small muted", text: action.label });
  } else {
    tail = el("button", { type: "button", className: "icon-btn bare", "aria-label": `この追加（+${formatCredits(g.credits)}）を取り消す`, onclick: () => removeGrant(r, g) }, icon("trash"));
  }
  return el("li", { className: g.revoked ? "revoked" : "" }, el("span", { className: "plus num", text: `+${formatCredits(g.credits)}` }), text, tail);
}

const GRANT_COLUMNS = "id, credits, note, created_at, created_by_email";
const STAGE_GRANT_COLUMNS = `${GRANT_COLUMNS}, stage_id, revoked_at, revoked_by_email, granted_as`;

/** 今の枠の一時追加（Day ごと・月額）を読む。RLS で管理者だけが読める */
function queryWindowGrants(r, columns) {
  return supabase
    .from("credit_grants")
    .select(columns)
    .eq("email", r.email)
    // 区分を変えた人の前の区分の付与（受講者の期間 ↔ 月額）は、今の枠に数えないので出さない
    .eq("window_kind", r.current_kind)
    .gte("window_start", r.current_window_start)
    .lte("window_end", r.current_window_end)
    .order("created_at", { ascending: false });
}

/** 一時追加を一覧にする。段階の回の受講者は、段階ごとに分け、取り消した行は取り消し済みとして出す（設計 7.1 の案 B） */
async function loadGrants(r, list) {
  const stageStudent = isStageStudent(r);
  const hasWindowNow = !!(r.current_kind && r.current_window_start && r.current_window_end);
  if (!hasWindowNow && !stageStudent) {
    list.replaceChildren(el("li", { className: "muted", text: "今の枠がありません。" }));
    return;
  }
  const columns = stagesAvailable() ? STAGE_GRANT_COLUMNS : GRANT_COLUMNS;
  const [win, stg] = await Promise.all([
    hasWindowNow ? queryWindowGrants(r, columns) : { data: [] },
    stageStudent
      ? supabase.from("credit_grants").select(columns).eq("email", r.email).not("stage_id", "is", null).order("created_at", { ascending: false })
      : { data: [] },
  ]);
  const error = win.error || stg.error;
  if (error) {
    list.replaceChildren(el("li", { className: "error-text", text: explainError(error) }));
    return;
  }
  const stageRows = stageStudent ? (stg.data ?? []) : [];
  // 段階の回の追加は、段階の行に分ける。stage_id が無い行（その回に Day ごとの時代の追加が残っているなど）は、今の枠の分だけ別に出す
  const rows = [...(win.data ?? []).filter((g) => !g.stage_id), ...stageRows];
  if (!rows.length) {
    list.replaceChildren(el("li", { className: "muted", text: "追加はありません。" }));
    return;
  }
  const view = adminGrantGroups(
    rows.map((g) => ({ ...g })),
    stagesOfCohort(r.cohort_id),
  );
  const out = [];
  if (stageStudent) {
    out.push(el("li", { className: "grant-total small muted num", text: grantTotalLine(view.total, state.stages.limitT) }));
  }
  for (const g of view.groups) {
    out.push(el("li", { className: "grant-group-head", text: g.heading }));
    for (const row of g.rows) out.push(grantItem(r, row, true));
  }
  if (view.plain.length && stageStudent) out.push(el("li", { className: "grant-group-head", text: "Day ごとの枠の追加（段階の回にする前のもの）" }));
  for (const row of view.plain) out.push(grantItem(r, row, false));
  list.replaceChildren(...out);
}

function manageSection(r) {
  const isMe = r.email === myEmail;
  const roleSelect = el(
    "select",
    { "aria-label": `${r.email} の区分` },
    ...Object.entries(roleLabelsFor(stagesAvailable() || r.role === "instructor")).map(([value, label]) =>
      el("option", { value, text: label, selected: value === r.role })
    ),
  );
  roleSelect.addEventListener("change", () => changeRole(r, roleSelect));
  const rows = [el("label", { className: "mrow" }, el("span", { text: "区分を変更" }), el("span", { className: "mrow-val" }, roleSelect, icon("chevron", 16)))];
  if (r.role === "student") {
    const cohortSelect = el(
      "select",
      { "aria-label": `${r.email} の所属する回`, className: "num" },
      el("option", { value: "", text: "未設定", selected: !r.cohort_id }),
      ...cohortOptions(r.cohort_id, true).map((o) => el("option", { value: o.value, text: o.label, selected: o.value === r.cohort_id })),
    );
    cohortSelect.addEventListener("change", () => changeCohort(r, cohortSelect));
    rows.push(
      el("label", { className: "mrow" }, el("span", { text: "所属する回を変更" }), el("span", { className: "mrow-val" }, cohortSelect, icon("chevron", 16))),
    );
  }
  // 段階の回の追加がある受講者は削除できない（追加は記録として残す）。利用を止めるのは「停止」
  const deleteBlock = memberDeleteBlock({ hasStageGrants: state.stages.grantEmails.has(r.email) });
  rows.push(
    el("button", {
      type: "button",
      className: "mrow",
      text: r.status === "active" ? "利用を停止" : "利用を再開",
      onclick: () => changeStatus(r, r.status === "active" ? "disabled" : "active"),
    }),
    el("button", {
      type: "button",
      className: "mrow danger",
      text: "名簿から削除",
      disabled: isMe || !!deleteBlock,
      title: isMe ? "自分自身は削除できません" : deleteBlock,
      onclick: () => removeMember(r),
    }),
  );
  const notes = ["停止・削除・区分の変更は、実行前に確認が出ます。"];
  if (deleteBlock) notes.push(deleteBlock);
  if (isMe) notes.push("自分自身は削除できません。");
  if (r.role === "admin") notes.push("最後の有効な管理者は、停止・区分の変更・削除ができません。");
  return [
    el("h3", { className: "group-title", text: "管理" }),
    el("div", { className: "menu" }, ...rows),
    el("p", { className: "hint", text: notes.join("") }),
  ];
}

/** 回の選択肢（今の回は、終了していても出す。新しい順） */
function cohortOptions(currentId = null, short = false) {
  return state.cohorts
    .filter((c) => c.current_period !== "after" || c.id === currentId)
    .map((c) => ({
      value: c.id,
      label: `${short ? [c.id, c.name].filter(Boolean).join(" · ") : cohortLabel(c)}${c.current_period === "after" ? "（終了）" : ""}`,
    }));
}

// ---- 1 人ずつの操作 ----

async function updateMember(email, patch, doneMessage) {
  const { data, error } = await supabase.from("members").update(patch).eq("email", email).select("email");
  if (error) {
    notify(explainError(error), "error");
  } else if (!data?.length) {
    notify("変更できませんでした（権限が無いか、対象が見つかりません）。", "error");
  } else {
    notify(doneMessage);
  }
  await refresh();
}

/** 自分自身の管理者権限を失う操作は、メールアドレスの入力で強く確認する（誤って全員が締め出されるのを防ぐ） */
function confirmSelfLockout(r) {
  if (r.email !== myEmail) return true;
  const typed = prompt(
    `自分自身（${r.email}）の管理者権限が無くなり、このコンソールを使えなくなります。\n` +
      "ほかに実在する管理者がいることを確認してから進めてください。\n" +
      "続ける場合は、自分のメールアドレスを入力してください。",
  );
  return normalizeEmail(typed ?? "") === myEmail;
}

async function changeStatus(r, status) {
  const label = status === "active" ? "有効に" : "停止";
  if (status === "disabled" && !confirm(`${r.email} の利用を停止しますか？\n（1 分ほどで MCP が使えなくなります）`)) return;
  if (status === "active" && !confirm(`${r.email} の利用を再開しますか？`)) return;
  if (status === "disabled" && r.role === "admin" && !confirmSelfLockout(r)) return;
  await updateMember(r.email, { status }, `${r.email} を${label}しました。`);
}

async function changeRole(r, select) {
  const role = select.value;
  // AIKENメンバー・講師にするとき、月額が未設定なら初期値（3,300）を入れる
  const patch = { role };
  if (isMonthlyRole(role) && (r.monthly_credits === null || r.monthly_credits === undefined)) {
    patch.monthly_credits = DEFAULT_MONTHLY_CREDITS;
  }
  const extra = "monthly_credits" in patch
    ? `\n（月額クレジットは初期値 ${formatCredits(DEFAULT_MONTHLY_CREDITS)}〔${formatYen(DEFAULT_MONTHLY_CREDITS)}〕にします）`
    : "";
  const roleLabel = roleLabelsFor(true)[role] ?? role;
  if (!confirm(`${r.email} の区分を「${roleLabel}」に変更しますか？${extra}`)) {
    select.value = r.role;
    return;
  }
  if (r.role === "admin" && role !== "admin" && !confirmSelfLockout(r)) {
    select.value = r.role;
    return;
  }
  const hint = role === "student" && !r.cohort_id ? "所属する回を設定してください（回が未設定の間は生成できません）。" : "";
  await updateMember(r.email, patch, `${r.email} の区分を「${roleLabel}」に変更しました。${hint}`);
}

async function changeCohort(r, select) {
  const id = select.value || null;
  const c = state.cohorts.find((x) => x.id === id);
  const label = id ? cohortLabel(c ?? { id }) : "未設定";
  const note = id ? "日付とクレジットは回の設定に従います。" : "回を外すと、生成できなくなります（旧い個別の期間が残っている場合を除く）。";
  if (!confirm(`${r.email} の所属する回を「${label}」にしますか？\n（${note}）`)) {
    select.value = r.cohort_id ?? "";
    return;
  }
  await updateMember(r.email, { cohort_id: id }, `${r.email} の所属する回を「${label}」にしました。`);
}

async function saveMonthly(r, value) {
  clearNotice();
  const { patch, problems } = parseCreditForm({ monthly_credits: value }, { partial: false, fields: MONTHLY_FIELDS });
  if (problems.length) {
    notify("保存できません。次の項目を確認してください。", "error", problems);
    return;
  }
  const what = patch.monthly_credits === null ? "未設定" : `${formatCredits(patch.monthly_credits)}（${formatYen(patch.monthly_credits)}）`;
  if (!confirm(`${r.email} の月額クレジットを ${what} にしますか？`)) return;
  await updateMember(r.email, patch, `${r.email} の月額クレジットを保存しました。`);
}

/** 段階の回の受講者の、この回の追加の合計（G。取り消した追加も数える）を、追加の行から求める。読めなければ null */
async function stageGrantedTotal(r) {
  const { data, error } = await supabase.from("credit_grants").select("credits, stage_id").eq("email", r.email).not("stage_id", "is", null);
  if (error) return null;
  return (data ?? []).reduce((n, g) => n + Number(g.credits ?? 0), 0);
}

/** 今の枠に一時追加する（時間枠は DB のトリガが決め、枠外なら拒否する）。段階の回は今の段階に付く */
async function addGrant(r, creditsText, noteText) {
  clearNotice();
  const credits = parseGrantCredits(creditsText);
  if (credits === undefined) {
    notify(`追加するクレジットは 1〜${formatCredits(MAX_CREDITS)} の整数で入力してください。`, "error");
    return;
  }
  const stageStudent = isStageStudent(r);
  if (stageStudent) {
    // 段階の回は、10,000 の固定ではなく、この回の合計（T）で見る。T か追加済みが分からないときは DB が決める
    const over = stageGrantTotalProblem({ granted: await stageGrantedTotal(r), limit: state.stages.limitT }, credits);
    if (over) {
      notify(`追加できません。${over}`, "error");
      return;
    }
  } else {
    const over = grantTotalProblem(r, credits);
    if (over) {
      notify(`追加できません。${over}。`, "error");
      return;
    }
  }
  const note = String(noteText ?? "").trim();
  const where = stageStudent ? "今の段階（回の追加の合計に数えます。取り消しても戻りません）" : "今の枠";
  if (!confirm(`${r.email} の${where}に ${formatCredits(credits)} クレジット（${formatYen(credits)}）を追加しますか？`)) return;
  let data;
  let error;
  if (stagesAvailable()) {
    ({ data, error } = await supabase.rpc("admin_grant_credits", { p_emails: [r.email], p_credits: credits, p_note: note || null }));
  } else {
    ({ data, error } = await supabase
      .from("credit_grants")
      .insert({ email: r.email, credits, note: note || null })
      .select("window_start, window_end")
      .maybeSingle());
  }
  if (error) {
    notify(explainError(error), "error");
  } else {
    // 枠は DB のトリガがその時点の今の枠で決める（一覧が古いまま日付の境目をまたいでも、実際に付いた枠を示す）
    const row = Array.isArray(data) ? data[0] : data;
    const until = row?.window_end ? `（${windowLastDayText(row.window_end)} までの枠）` : "";
    notify(`${r.email} の${stageStudent ? "今の段階" : "今の枠"}${until}に ${formatCredits(credits)} クレジットを追加しました。`);
  }
  await refresh();
}

/** Day ごと・月額の追加の削除（段階の回の追加は削除できない。取り消す） */
async function removeGrant(r, g) {
  if (!confirm(`${r.email} への追加（+${formatCredits(g.credits)}）を取り消しますか？`)) return;
  let error;
  let removed = true;
  if (stagesAvailable()) {
    ({ error } = await supabase.rpc("admin_delete_grant", { p_grant_id: g.id }));
  } else {
    const res = await supabase.from("credit_grants").delete().eq("id", g.id).select("id");
    error = res.error;
    removed = !!res.data?.length;
  }
  if (error) notify(explainError(error), "error");
  else if (!removed) notify("取り消せませんでした（権限が無いか、対象が見つかりません）。", "error");
  else notify(`${r.email} への追加（+${formatCredits(g.credits)}）を取り消しました。`);
  await refresh();
}

/** 段階の回の追加の取り消し（印を付けるだけ。判定からは外れ、回の合計には残る） */
async function revokeStageGrant(r, g) {
  clearNotice();
  if (!confirm(`${r.email} への追加（+${formatCredits(g.credits)}）を取り消しますか？\n${REVOKE_CONFIRM_TEXT}`)) return;
  const { error } = await supabase.rpc("revoke_stage_grant", { p_grant_id: g.id, p_note: null });
  if (error) notify(explainError(error), "error");
  else notify(`${r.email} への追加（+${formatCredits(g.credits)}）を取り消しました。回の合計の枠は戻りません。`);
  await refresh();
}

async function removeMember(r) {
  if (r.email === myEmail) {
    notify("自分自身は削除できません。", "error");
    return;
  }
  const block = memberDeleteBlock({ hasStageGrants: state.stages.grantEmails.has(r.email) });
  if (block) {
    notify(block, "error");
    return;
  }
  if (!confirm(`${r.email} を名簿から削除しますか？\n（使用量の記録は残ります。元に戻すには追加し直してください）`)) return;
  const { data, error } = await supabase.from("members").delete().eq("email", r.email).select("email");
  if (error) notify(explainError(error), "error");
  else if (!data?.length) notify("削除できませんでした（権限が無いか、対象が見つかりません）。", "error");
  else notify(`${r.email} を削除しました。`);
  await refresh();
}

// ---- まとめての操作 ----

/** 送った人数より更新された人数が少ないとき（その間に削除・区分の変更があった）の説明 */
function shortfallText(sent, updated) {
  return updated < sent
    ? `${sent - updated} 人は更新されませんでした（その間に名簿から外された・区分が変わった可能性があります）。`
    : "";
}

/** 所属する回を設定する画面（受講者だけが対象） */
function openCohortPicker(targets) {
  const students = targets.filter((r) => r.role === "student");
  const single = students.length === 1 ? students[0] : null;
  let chosen = single?.cohort_id ?? defaultCohortId(state.cohorts) ?? "";
  const render = () => {
    const name = `pick-cohort-${++fieldSeq}`;
    const option = (value, title, sub, badge = null) => {
      const input = el("input", { type: "radio", name, value, checked: chosen === value });
      input.addEventListener("change", () => {
        chosen = value;
        submit.textContent = submitText();
      });
      return el(
        "label",
        { className: "radio-card" },
        input,
        el("span", { className: "rtext" }, el("span", { className: "strong num", text: title }), sub ? el("span", { className: "small muted num", text: sub }) : null),
        badge,
      );
    };
    const submitText = () => (chosen ? `${students.length}人を ${chosen} に所属させる` : `${students.length}人の回を外す`);
    const submit = el("button", {
      type: "button",
      className: "btn primary big",
      text: submitText(),
      disabled: !students.length,
      onclick: () => applyCohort(students, chosen || null),
    });
    const body = [
      el("p", {
        className: "muted",
        text: single
          ? `${displayName(single)} の所属する回を選びます。日付とクレジットは回の設定に従います。`
          : `選んだ受講者 ${students.length} 人の所属する回を選びます。日付とクレジットは回の設定に従います。` +
            (targets.length > students.length ? `（メンバー ${targets.length - students.length} 人は対象外です）` : ""),
      }),
    ];
    if (state.cohortsStatus === "error") body.push(warnBox(`回を読み込めませんでした。${state.cohortsError}`));
    const list = state.cohorts.map((c) =>
      option(
        c.id,
        c.id,
        [[c.name, c.venue_name].filter(Boolean).join(" · "), `Day1 ${formatDateWithWeekday(c.day1_date)} → Day2 ${formatDateWithWeekday(c.day2_date)}`]
          .filter(Boolean).join(" ／ "),
        cohortStatusBadge(c.current_period),
      )
    );
    body.push(
      el("div", { className: "radio-list", role: "radiogroup", "aria-label": "所属する回" }, ...list, option("", "所属なし（回を外す）", "回が未設定の間は生成できません")),
      el("button", { type: "button", className: "link-btn", text: "新しい回を作る", onclick: () => openCohortNew() }),
    );
    setSheet({ title: "所属する回を設定", body, foot: [submit, cancelButton()] });
  };
  openSheet("cohort-picker", render);
}

async function applyCohort(targets, cohortId) {
  clearNotice();
  const students = targets.filter((r) => r.role === "student");
  const excluded = targets.length - students.length;
  if (!students.length) {
    notify("受講者を選んでください（所属する回は受講者だけに設定します）。", "error");
    return;
  }
  const c = state.cohorts.find((x) => x.id === cohortId);
  const label = cohortId ? cohortLabel(c ?? { id: cohortId }) : "未設定";
  if (!confirm(`受講者 ${students.length} 人の所属する回を「${label}」にしますか？${excluded ? `\n（受講者以外の ${excluded} 人は対象外のため除きます）` : ""}`)) return;
  const emails = students.map((r) => r.email);
  const { data, error } = await supabase
    .from("members")
    .update({ cohort_id: cohortId })
    .in("email", emails)
    .eq("role", "student")
    .select("email");
  if (error) {
    notify(`所属する回を設定できませんでした（${explainError(error)}）。`, "error");
    await refresh();
    return;
  }
  const updated = data?.length ?? 0;
  const parts = [`受講者 ${updated} 人の所属する回を「${label}」にしました。`];
  const short = shortfallText(emails.length, updated);
  if (short) parts.push(short);
  if (excluded) parts.push(`受講者以外の ${excluded} 人は対象外のため除きました。`);
  const clean = !short;
  notify(parts.join(""), clean ? "ok" : "error");
  if (clean) {
    closeSheet();
    if (state.selecting) {
      state.selecting = false;
      state.selected.clear();
      state.selectCohortTarget = null;
    }
  }
  await refresh();
}

function openBulkMonthly(targets) {
  const members = targets.filter((r) => isMonthlyRole(r.role));
  const input = creditInput("", { placeholder: "例：3300" });
  openSheet("bulk-monthly", () =>
    setSheet({
      title: "月額を設定",
      body: [
        el("p", {
          className: "muted",
          text: `選んだ AIKENメンバー・講師 ${members.length} 人の月額クレジットを、同じ値にします。` +
            (targets.length > members.length ? `（受講者 ${targets.length - members.length} 人は対象外です）` : ""),
        }),
        field("毎月（日本時間の 1 日に戻る・繰り越しなし）", input, yenHint(input)),
      ],
      foot: [
        el("button", { type: "button", className: "btn primary big", text: `${members.length}人に設定`, onclick: () => applyBulkMonthly(members, input.value) }),
        cancelButton(),
      ],
    })
  );
}

async function applyBulkMonthly(members, value) {
  clearNotice();
  const n = parseCredits(value);
  if (n === null || n === undefined) {
    notify(`月額のクレジットは 0〜${formatCredits(MAX_CREDITS)} の整数で入力してください。`, "error");
    return;
  }
  if (!members.length) {
    notify("AIKENメンバーか講師を選んでください。", "error");
    return;
  }
  if (!confirm(`AIKENメンバー・講師 ${members.length} 人の月額を ${formatCredits(n)}（${formatYen(n)}）にしますか？`)) return;
  const emails = members.map((r) => r.email);
  const { data, error } = await supabase
    .from("members")
    .update({ monthly_credits: n })
    .in("email", emails)
    .in("role", ["member", "instructor"])
    .select("email");
  if (error) {
    notify(`月額を設定できませんでした（${explainError(error)}）。`, "error");
    await refresh();
    return;
  }
  const updated = data?.length ?? 0;
  const short = shortfallText(emails.length, updated);
  notify(`AIKENメンバー・講師 ${updated} 人の月額を設定しました。${short}`, short ? "error" : "ok");
  if (!short) closeSheet();
  await refresh();
}

function openBulkGrant(targets) {
  const credits = creditInput("", { placeholder: "例：500" });
  const note = textInput({ placeholder: "例：授業中に不足したため" });
  const eligible = targets.filter(canGrant);
  openSheet("bulk-grant", () =>
    setSheet({
      title: "クレジットを追加",
      body: [
        el("p", {
          className: "muted",
          text: `選んだ ${targets.length} 人の今の枠に、1 人あたり同じ数を一時的に足します（繰り越しなし）。` +
            (eligible.length < targets.length ? `今の枠が無い ${targets.length - eligible.length} 人は除きます。` : ""),
        }),
        field("1 人あたりのクレジット", credits, yenHint(credits)),
        field("メモ（任意。理由など）", note),
      ],
      foot: [
        el("button", {
          type: "button",
          className: "btn primary big",
          text: `${eligible.length}人に追加`,
          disabled: !eligible.length,
          onclick: () => applyBulkGrant(targets, credits.value, note.value),
        }),
        cancelButton(),
      ],
    })
  );
}

/**
 * まとめて追加する。016 の DB では admin_grant_credits を 1 回（全員分が通るか、全部断られる。枠・段階は DB が人ごとに決める）。
 * 016 の前の DB では、今までどおり 1 人ずつ順に追加し、途中で失敗した人は理由を添えて知らせる
 */
async function applyBulkGrant(targets, creditsText, noteText) {
  clearNotice();
  const credits = parseGrantCredits(creditsText);
  if (credits === undefined) {
    notify(`追加するクレジットは 1〜${formatCredits(MAX_CREDITS)} の整数で入力してください。`, "error");
    return;
  }
  const withWindow = targets.filter(canGrant);
  const skipped = targets.filter((r) => !canGrant(r));
  // 1 人あたりの追加の合計の上限を超える人は、送らずに除く（Day ごと・月額だけ。段階の回の受講者は回の合計で DB が判定する）
  const overTotal = withWindow.filter((r) => !isStageStudent(r) && grantTotalProblem(r, credits));
  const eligible = withWindow.filter((r) => isStageStudent(r) || !grantTotalProblem(r, credits));
  if (!eligible.length) {
    notify(
      overTotal.length
        ? `追加できる人がいません。${grantTotalProblem(overTotal[0], credits)}。`
        : "今の枠がある人がいません（期間外・未設定の人には追加できません）。",
      "error",
    );
    return;
  }
  const stageCount = eligible.filter(isStageStudent).length;
  const stageNote = stageCount ? `（うち ${stageCount} 人は段階の回です。今の段階に付き、回の合計に数えます）` : "";
  if (!confirm(`${eligible.length} 人の今の枠に、1 人あたり ${formatCredits(credits)} クレジット（${formatYen(credits)}）を追加しますか？${stageNote}`)) return;
  const note = String(noteText ?? "").trim() || null;
  let done = 0;
  const failed = [];
  if (stagesAvailable()) {
    const { error } = await supabase.rpc("admin_grant_credits", { p_emails: eligible.map((r) => r.email), p_credits: credits, p_note: note });
    if (error) {
      notify(`追加できませんでした（全員分とも追加していません）。${explainError(error)}`, "error");
      await refresh();
      return;
    }
    done = eligible.length;
  } else {
    for (const r of eligible) {
      const { error } = await supabase.from("credit_grants").insert({ email: r.email, credits, note }).select("id").maybeSingle();
      if (error) failed.push(`${r.email}：${explainError(error)}`);
      else done++;
    }
  }
  const parts = [`${done} 人の今の枠に ${formatCredits(credits)} クレジットを追加しました。`];
  if (failed.length) parts.push(`次の ${failed.length} 人には追加できませんでした。`);
  if (skipped.length) parts.push(`今の枠が無いため ${skipped.length} 人を除きました（${skipped.map((r) => r.email).join("、")}）。`);
  if (overTotal.length) {
    parts.push(
      `追加の合計が 1 人あたり ${formatCredits(MAX_GRANT_TOTAL)} を超えるため ${overTotal.length} 人を除きました（${overTotal.map((r) => r.email).join("、")}）。`,
    );
  }
  const clean = !failed.length && !skipped.length && !overTotal.length;
  notify(parts.join(""), clean ? "ok" : "error", failed);
  if (!failed.length) closeSheet();
  await refresh();
}

async function bulkStatus(targets, status) {
  clearNotice();
  if (!targets.length) return;
  const label = status === "active" ? "再開" : "停止";
  const extra = status === "disabled" ? "\n（1 分ほどで MCP が使えなくなります）" : "";
  if (!confirm(`選んだ ${targets.length} 人の利用を${label}しますか？${extra}`)) return;
  const emails = targets.map((r) => r.email);
  const { data, error } = await supabase
    .from("members")
    .update({ status })
    .in("email", emails)
    .in("role", ["student", "member"])
    .select("email");
  if (error) {
    notify(`利用を${label}できませんでした（${explainError(error)}）。`, "error");
    await refresh();
    return;
  }
  const updated = data?.length ?? 0;
  const short = shortfallText(emails.length, updated);
  notify(`${updated} 人の利用を${label}しました。${short}`, short ? "error" : "ok");
  await refresh();
}

// ---- 名簿に追加 ----

let addUi = null;

/** 追加の画面は一度だけ作り、閉じても入力を残す（「新しい回を作る」から戻ったときのため） */
function buildAddUi() {
  const mode = (value, label, checked) => el("label", {}, el("input", { type: "radio", name: "add-mode", value, checked }), label);
  const modeSeg = el("div", { className: "seg", role: "radiogroup", "aria-label": "追加のしかた" }, mode("single", "1人ずつ", true), mode("bulk", "まとめて", false));
  const email = el("input", { type: "email", inputmode: "email", className: "input", autocomplete: "off", placeholder: "name@a-i-ken.jp", id: "add-email" });
  const name = textInput({ placeholder: "例：受講者 05", id: "add-name" });
  const single = el("div", { className: "stack" }, field("メールアドレス", email, "@a-i-ken.jp または @a-i-ken.com のアカウント"), field("表示名（任意）", name));
  const bulkText = el("textarea", {
    className: "input",
    id: "add-bulk",
    rows: "6",
    placeholder: "student05@a-i-ken.jp\nstudent06@a-i-ken.jp, 受講者 06",
    autocomplete: "off",
  });
  const bulk = field("メールアドレス（1行に1人）", bulkText, "「メールアドレス, 氏名」の形でも入れられます。登録済みの人は上書きせずにスキップします。");
  const role = (value, label, checked) => el("label", {}, el("input", { type: "radio", name: "add-role", value, checked }), label);
  const roles = el(
    "fieldset",
    { className: "plain" },
    el("legend", { text: "区分" }),
    el("div", { className: "choice" }, role("student", "受講者", true), role("member", "メンバー", false), role("instructor", "講師", false), role("admin", "管理者", false)),
  );
  // 講師は 016 が DB に当たってから選べる（016 の前は members の区分の check が断る）
  const instructorChoice = roles.querySelector('input[value="instructor"]').closest("label");
  // 受講者：所属する回
  const cohortSelect = el("select", { className: "input num", id: "add-cohort" });
  const cohortPreview = el("div");
  const cohortField = field("回", cohortSelect);
  const newCohortBtn = el("button", { type: "button", className: "link-btn", text: "新しい回を作る", onclick: () => openCohortNew({ returnToAdd: true }) });
  const studentBox = el(
    "section",
    { className: "box" },
    el("div", { className: "detail-title" }, el("h3", { text: "所属する回" }), el("span", { className: "hint", text: "日付とクレジットは回の設定に従います。" })),
    cohortField,
    cohortPreview,
    newCohortBtn,
  );
  // メンバー：月額
  const monthly = creditInput(DEFAULT_MONTHLY_CREDITS, { placeholder: "例：3300", id: "add-monthly" });
  const memberBox = el(
    "section",
    { className: "box" },
    el("h3", { text: "月額のクレジット（メンバー・講師）" }),
    field("毎月（1日に戻る・繰越なし）", monthly, yenHint(monthly)),
    el("p", { className: "hint", text: `初期値は ${formatCredits(DEFAULT_MONTHLY_CREDITS)}。空欄にすると未設定（生成できません）。` }),
  );
  const adminNote = el("p", {
    className: "note-box",
    text: "管理者はクレジットの枠の対象外です（直近 24 時間の上限のみ）。名簿・回・クレジットを操作できるようになります。",
  });
  const submit = el("button", { type: "button", className: "btn primary big", id: "add-submit", onclick: () => submitAdd() });

  const currentMode = () => modeSeg.querySelector("input:checked")?.value ?? "single";
  const currentRole = () => roles.querySelector("input:checked")?.value ?? "student";
  const updateCohortPreview = () => {
    // 013 が無い DB では回を選べない（cohort_id を送ると members が拒否する）
    const missing = no013();
    cohortField.hidden = missing;
    newCohortBtn.hidden = missing;
    if (missing) {
      cohortPreview.replaceChildren(warnBox("DB の更新（回と会場：013）がまだ適用されていないため、回は設定せずに追加します。"));
      return;
    }
    const c = state.cohorts.find((x) => x.id === cohortSelect.value);
    if (!c) {
      cohortPreview.replaceChildren(
        state.cohortsStatus === "error"
          ? warnBox(`回を読み込めませんでした。${state.cohortsError}`)
          : warnBox("回が未設定のまま追加します（回を設定するまで生成できません）。"),
      );
      return;
    }
    const kv = coursePeriods(c, c.current_period).flatMap((p) => [
      el("dt", { text: p.key === "bridge" ? "ブリッジ" : p.name }),
      el("dd", { text: p.none ? p.dates : `${p.dates}・${p.credits}` }),
    ]);
    cohortPreview.replaceChildren(el("dl", { className: "kv boxed num" }, ...kv));
  };
  cohortSelect.addEventListener("change", () => {
    cohortSelect.dataset.touched = "1";
    updateCohortPreview();
  });
  const update = () => {
    const isSingle = currentMode() === "single";
    single.hidden = !isSingle;
    bulk.hidden = isSingle;
    const r = currentRole();
    studentBox.hidden = r !== "student";
    memberBox.hidden = !isMonthlyRole(r);
    adminNote.hidden = r !== "admin";
    submit.textContent = isSingle ? "追加する" : "まとめて追加する";
  };
  modeSeg.addEventListener("change", update);
  roles.addEventListener("change", update);
  update();

  return {
    body: [modeSeg, single, bulk, roles, studentBox, memberBox, adminNote],
    foot: [submit, cancelButton()],
    email,
    name,
    bulkText,
    monthly,
    cohortSelect,
    submit,
    currentMode,
    currentRole,
    /** 講師の選択肢を、016 が当たっているときだけ出す（外れたときに講師が選ばれていれば、受講者に戻す） */
    syncRoles() {
      instructorChoice.hidden = !stagesAvailable();
      if (instructorChoice.hidden && currentRole() === "instructor") this.setRole("student");
    },
    setRole(value) {
      const input = roles.querySelector(`input[value="${value}"]`);
      if (input) input.checked = true;
      update();
    },
    /** 回の選択肢を作り直す（keepId を優先し、無ければ今の選択、無ければ既定の回） */
    refreshCohorts(keepId) {
      const want = keepId !== undefined ? keepId : cohortSelect.dataset.touched ? cohortSelect.value : defaultCohortId(state.cohorts) ?? "";
      cohortSelect.replaceChildren(
        ...cohortOptions().map((o) => el("option", { value: o.value, text: o.label })),
        el("option", { value: "", text: "所属なし（あとで設定）" }),
      );
      cohortSelect.value = want ?? "";
      if (cohortSelect.value !== (want ?? "")) cohortSelect.value = "";
      updateCohortPreview();
    },
  };
}

function openAdd({ role = null, cohortId } = {}) {
  addUi ??= buildAddUi();
  if (role) addUi.setRole(role);
  if (cohortId !== undefined) {
    addUi.cohortSelect.dataset.touched = "1";
    addUi.refreshCohorts(cohortId);
  }
  openSheet("add", () => {
    addUi.syncRoles();
    addUi.refreshCohorts();
    setSheet({ title: "名簿に追加", body: addUi.body, foot: addUi.foot });
  });
}

/** 区分に合わせて入れる列（受講者：所属する回、AIKENメンバー：月額）。問題があれば notify して null */
function extrasForAdd(role) {
  // 013 が無い DB には cohort_id の列が無いので送らない（null でも送ると PGRST204 で拒否される）
  if (role === "student") return no013() ? {} : { cohort_id: addUi.cohortSelect.value || null };
  if (isMonthlyRole(role)) {
    const { patch, problems } = parseCreditForm({ monthly_credits: addUi.monthly.value }, { partial: false, fields: MONTHLY_FIELDS });
    if (problems.length) {
      notify("追加できません。月額クレジットを確認してください。", "error", problems);
      return null;
    }
    return patch;
  }
  return {};
}

/** 登録済みは上書きせずにスキップする（on conflict do nothing）。追加できた件数を返す */
async function insertMembers(rows) {
  const { data, error } = await supabase
    .from("members")
    .upsert(rows, { onConflict: "email", ignoreDuplicates: true })
    .select("email");
  if (error) return { error };
  return { added: data?.length ?? 0 };
}

async function submitAdd() {
  clearNotice();
  const role = addUi.currentRole();
  const extras = extrasForAdd(role);
  if (!extras) return;
  addUi.submit.disabled = true;
  try {
    if (addUi.currentMode() === "single") await addOne(role, extras);
    else await addBulk(role, extras);
  } finally {
    addUi.submit.disabled = false;
  }
}

async function addOne(role, extras) {
  const email = normalizeEmail(addUi.email.value);
  const problem = emailProblem(email);
  if (problem) {
    notify(`追加できません：${problem}`, "error");
    return;
  }
  const name = addUi.name.value.trim();
  const result = await insertMembers([{ email, display_name: name || null, role, ...extras }]);
  if (result.error) {
    notify(explainError(result.error), "error");
    return;
  }
  if (result.added === 0) {
    notify(`${email} は既に登録済みのため、スキップしました（上書きはしていません）。`, "error");
  } else {
    notify(`${email} を追加しました。`);
    addUi.email.value = "";
    addUi.name.value = "";
  }
  await refresh();
}

async function addBulk(role, extras) {
  const { valid, invalid, duplicates } = parseBulk(addUi.bulkText.value);
  const problems = invalid.map((p) => `${p.line} 行目「${p.text}」：${p.reason}`);
  if (!valid.length) {
    notify(invalid.length ? "追加できる行がありません。次の行を確認してください。" : "追加する行がありません。", "error", problems);
    return;
  }
  const result = await insertMembers(valid.map((v) => ({ ...v, role, ...extras })));
  if (result.error) {
    notify(explainError(result.error), "error", problems);
    return;
  }
  const skipped = valid.length - result.added;
  const parts = [`${result.added} 件を追加しました。`];
  if (skipped) parts.push(`登録済みのため ${skipped} 件をスキップしました（上書きはしていません）。`);
  if (duplicates) parts.push(`入力内の重複 ${duplicates} 件を除きました。`);
  if (invalid.length) parts.push(`次の ${invalid.length} 行は送らずに除きました。`);
  notify(parts.join(""), invalid.length ? "error" : "ok", problems);
  if (!invalid.length) addUi.bulkText.value = "";
  await refresh();
}

// ---- 回 ----

function renderCohorts() {
  const main = $("cohorts-main");
  if (state.tab !== "cohorts") return;
  if (state.cohortsStatus === "loading") {
    main.replaceChildren(emptyBox("読み込み中…"));
    return;
  }
  if (state.cohortsStatus === "error") {
    main.replaceChildren(errorBox(`回を読み込めませんでした。${state.cohortsError}`));
    return;
  }
  main.replaceChildren(isDesktop() ? cohortTable() : cohortCards(), venuesSection());
}

function cohortCards() {
  if (!state.cohorts.length) {
    return emptyBox(
      state.venues.length ? "回がまだありません。" : "回がまだありません。先に会場を追加してから、回を作ります。",
      el("button", { type: "button", className: "btn primary", text: "回を作成", onclick: () => openCohortNew() }),
    );
  }
  return el(
    "ul",
    { className: "list", "aria-label": "回の一覧" },
    ...state.cohorts.map((c) => {
      const u = cohortUsage(c);
      return el(
        "li",
        {},
        el(
          "button",
          { type: "button", className: "card", onclick: () => openCohort(c.id) },
          el("span", { className: "card-top" }, el("span", { className: "cid num", text: c.id }), el("span", { className: "card-name" }), stageBadge(c.id), cohortStatusBadge(c.current_period)),
          el("span", { className: "small ellipsis", text: [c.name, c.venue_name].filter(Boolean).join(" · ") || "（名前なし）" }),
          el("span", { className: "num", text: `Day1 ${formatDateWithWeekday(c.day1_date)}　→　Day2 ${formatDateWithWeekday(c.day2_date)}` }),
          u && u.limit !== null
            ? el(
              "span",
              { className: "quota" },
              el(
                "span",
                { className: "quota-row" },
                el("span", { className: "quota-label", text: `${u.periodLabel}の合計` }),
                el(
                  "span",
                  { className: "quota-num num" },
                  el("b", { text: `使用 ${formatCredits(u.used)}` }),
                  el("span", { className: "muted", text: ` / ${formatCredits(u.limit)}` }),
                ),
              ),
              bar(u.pct),
            )
            : null,
          c.has_unset_credits && c.current_period !== "after" ? warnBox("クレジットが未設定です（このままでは生成できません）", "span") : null,
          el("span", { className: "meta" }, icon("users", 14), el("span", { className: "num", text: `受講者 ${Number(c.member_count ?? 0)}人` })),
        ),
      );
    }),
  );
}

function cohortTable() {
  const head = el(
    "div",
    { className: "card-section-head" },
    el("h2", { text: "回" }),
    el("button", { type: "button", className: "btn primary", text: "回を作成", onclick: () => openCohortNew() }),
  );
  if (!state.cohorts.length) {
    return el(
      "section",
      { className: "list-panel" },
      head,
      emptyBox(state.venues.length ? "回がまだありません。「回を作成」から作ります。" : "回がまだありません。先に下の「会場を追加」から会場を登録します。"),
    );
  }
  const th = el(
    "div",
    { className: "trow cohort head", "aria-hidden": "true" },
    el("span", { text: "回の ID" }),
    el("span", { text: "名前・会場" }),
    el("span", { text: "日程" }),
    el("span", { text: "受講者" }),
    el("span", { text: "今の期間の合計" }),
  );
  const rows = state.cohorts.map((c) => {
    const u = cohortUsage(c);
    let usage;
    if (c.has_unset_credits && c.current_period !== "after" && !(u && u.limit !== null)) {
      usage = el("span", { className: "small warn-text", text: "クレジット未設定" });
    } else if (u && u.limit !== null) {
      usage = [
        el("span", { className: "num small strong", text: `使用 ${formatCredits(u.used)} / ${formatCredits(u.limit)}` }),
        bar(u.pct, false, "thin"),
      ];
    } else {
      usage = el("span", { className: "small muted", text: c.current_period === "after" ? "終了" : c.current_period === "before" ? "開催前" : "—" });
    }
    return el(
      "li",
      {},
      el(
        "button",
        {
          type: "button",
          className: `trow cohort ${state.cohortId === c.id ? "is-selected" : ""}`,
          "aria-current": state.cohortId === c.id ? "true" : null,
          onclick: () => openCohort(c.id),
        },
        el("span", { className: "cell" }, el("span", { className: "num strong", text: c.id }), cohortStatusBadge(c.current_period), stageBadge(c.id)),
        el(
          "span",
          { className: "cell" },
          el("span", { className: "strong ellipsis", text: c.name || "（名前なし）" }),
          el("span", { className: "small muted ellipsis", text: `${c.venue_no} ${c.venue_name ?? ""}` }),
        ),
        el(
          "span",
          { className: "cell num small" },
          el("span", { text: `Day1 ${formatDateWithWeekday(c.day1_date)}` }),
          el("span", { text: `Day2 ${formatDateWithWeekday(c.day2_date)}` }),
        ),
        el("span", { className: "num strong", text: `${Number(c.member_count ?? 0)}人` }),
        el("span", { className: "cell stretch" }, usage),
      ),
    );
  });
  return el("section", { className: "list-panel" }, head, el("div", { className: "table-scroll" }, th, el("ul", { className: "list", "aria-label": "回の一覧" }, ...rows)));
}

function venuesSection() {
  const counts = (no) => state.cohorts.filter((c) => c.venue_no === no).length;
  const items = state.venues.map((v) =>
    el(
      "li",
      {},
      el("span", { className: "venue-no num", text: v.no }),
      el(
        "span",
        { className: "vname" },
        el("span", { className: "strong", text: v.name }),
        v.active ? null : el("span", { className: "small muted", text: "（新しい回では選べません）" }),
      ),
      el("span", { className: "small muted num desk-only", text: `回 ${counts(v.no)}件` }),
      isDesktop()
        ? el("button", { type: "button", className: "btn", text: "編集", onclick: () => openVenue(v) })
        : el("button", { type: "button", className: "icon-btn bare", "aria-label": `${v.name}を編集`, onclick: () => openVenue(v) }, icon("edit")),
    )
  );
  const list = items.length ? el("ul", { className: "venues" }, ...items) : el("p", { className: "muted small", text: "会場がありません。" });
  const addBtn = el("button", { type: "button", className: isDesktop() ? "btn" : "link-btn", text: "会場を追加", onclick: () => openVenue(null) });
  const note = el("p", { className: "hint", text: "会場番号は回の ID の先頭 2 桁になります。番号を変えると、その会場の回の ID も変わります。" });
  if (isDesktop()) {
    return el("section", { className: "list-panel", "aria-labelledby": "venues-h" }, el("div", { className: "card-section-head" }, el("h2", { id: "venues-h", text: "会場" }), addBtn), list, el("div", { className: "panel-foot" }, note));
  }
  return el(
    "section",
    { className: "box tight venues-box", "aria-labelledby": "venues-h" },
    el("div", { className: "box-head" }, el("h3", { id: "venues-h", text: "会場" }), addBtn),
    list,
    note,
  );
}

let cohortSeq = 0;

async function openCohort(id) {
  if (state.cohortDraft && state.cohortDraft.id !== id) {
    if (!confirm(`${state.cohortDraft.id} の未保存の変更を捨てて、${id} を開きますか？`)) return;
    state.cohortDraft = null;
  }
  const seq = ++cohortSeq;
  state.cohortId = id;
  state.cohortEditing = false;
  state.cohortLoading = true;
  if (isDesktop()) {
    if (state.tab !== "cohorts") switchTab("cohorts");
    else renderCohorts();
    renderCohortAside();
  } else {
    openSheet("cohort", () => setSheet({ title: id, body: [el("p", { className: "muted", text: "最新の状態を読み込んでいます…" })] }));
  }
  // 編集の前に読み直す（人数・使用・日付を最新に）
  await Promise.all([loadCohorts(), loadUsage(), loadStageInfo()]);
  if (stagesAvailable() && isStageCohort(id)) await loadCohortStageStatus(id);
  if (seq !== cohortSeq) return;
  state.cohortLoading = false;
  if (!isDesktop() && sheetKind !== "cohort") return;
  if (!state.cohorts.some((c) => c.id === id)) {
    notify(
      state.cohortsStatus === "error" ? `回を読み込めませんでした。${state.cohortsError}` : `${id} は見つかりませんでした（削除・ID の変更があった可能性があります）。`,
      "error",
    );
    state.cohortId = null;
    if (sheetKind === "cohort") closeSheet();
    renderAll();
    return;
  }
  if (!isDesktop()) openSheet("cohort", renderCohortSheet);
  renderAll();
}

function cohortHead(c, titleId) {
  return el(
    "div",
    { className: "detail-title" },
    el("h2", { id: titleId, className: "title-lg num cid", text: c.id }),
    el("span", { className: "sub", text: [c.name, `会場 ${c.venue_no} ${c.venue_name ?? ""}`].filter(Boolean).join(" · ") }),
    el("div", { className: "badges" }, cohortStatusBadge(c.current_period), stageBadge(c.id)),
  );
}

function cohortMembers(c) {
  return sortByRemaining(state.rows.filter((r) => r.role === "student" && r.cohort_id === c.id));
}

function renderCohortSheet() {
  const c = state.cohorts.find((x) => x.id === state.cohortId);
  if (!c) {
    closeSheet();
    return;
  }
  const schedule = state.cohortEditing
    ? el("section", { className: "box" }, el("h3", { text: "日程と 1 人あたりのクレジット" }), cohortEditForm(c))
    : el(
      "section",
      { className: "box tight" },
      el(
        "div",
        { className: "box-head" },
        el("h3", { text: "日程と 1 人あたりのクレジット" }),
        el("button", {
          type: "button",
          className: "link-btn",
          text: "編集",
          onclick: () => {
            state.cohortEditing = true;
            renderCohortSheet();
          },
        }),
      ),
      periodList(c, c.current_period),
      el("p", { className: "hint", text: "変更すると、所属している受講者全員に反映されます。" }),
    );
  setSheet({
    head: cohortHead(c, "sheet-title"),
    body: [schedule, cohortSumBox(c), ...stageBoxes(c), cohortStudentsBox(c, 5), cohortAddButtons(c), ...cohortManage(c)],
  });
}

function renderCohortAside() {
  const aside = $("cohort-aside");
  if (!isDesktop()) return;
  if (state.cohortLoading) {
    aside.replaceChildren(el("p", { className: "side-empty", text: "読み込み中…" }));
    return;
  }
  const c = state.cohortId && state.cohorts.find((x) => x.id === state.cohortId);
  if (!c) {
    aside.replaceChildren(el("p", { className: "side-empty", text: "回を選ぶと、ここで設定できます。" }));
    return;
  }
  aside.replaceChildren(cohortHead(c, "aside-cohort-title"), cohortEditForm(c), cohortSumBox(c), ...stageBoxes(c), cohortStudentsBox(c, 5), cohortAddButtons(c), ...cohortManage(c));
}

function cohortSumBox(c) {
  const u = cohortUsage(c);
  const members = cohortMembers(c);
  const low = members.filter((r) => {
    const v = windowView(r);
    return v.state === "quota" && v.low;
  }).length;
  const content = [];
  if (u && u.limit !== null) {
    content.push(
      el(
        "div",
        { className: "bignum num" },
        el("span", { className: "big-n mid", text: formatCredits(u.used) }),
        el("span", { className: "muted", text: `/ ${formatCredits(u.limit)} 使用` }),
      ),
      bar(u.pct, false, "thick"),
    );
  } else if (u) {
    content.push(warnBox(`${u.periodLabel}のクレジットが未設定です（このままでは生成できません）`));
  } else {
    content.push(
      el("p", {
        className: "muted",
        text: c.current_period === "before" ? `開催前です（Day1 ${formatDateWithWeekday(c.day1_date)} から）。` : "終了しました。",
      }),
    );
  }
  if (low) content.push(el("span", { className: "warn-text small", text: `残りが少ない人 ${low}人` }));
  return el(
    "section",
    { className: "box" },
    el(
      "div",
      { className: "box-head baseline" },
      el("h3", { className: "minor", text: u ? `${u.periodLabel}の合計` : "今の期間" }),
      el("span", { className: "small muted num", text: `受講者 ${Number(c.member_count ?? 0)}人` }),
    ),
    ...content,
    u ? el("p", { className: "hint", text: "1 人あたりのクレジット × 人数に対する使用（一時的な追加は含みません）。" }) : null,
  );
}

function cohortStudentsBox(c, limit) {
  const members = cohortMembers(c);
  const shown = members.slice(0, limit);
  const items = shown.map((r) => {
    const v = windowView(r);
    const rem = v.state === "quota"
      ? el(
        "span",
        { className: "person-rem" },
        el("span", { className: `num ${v.low ? "low-text" : "strong"}`, text: `残り ${formatCredits(v.remaining)}` }),
        bar(v.pct, v.low, "thin"),
      )
      : el("span", { className: `person-rem small ${v.state === "unset" ? "warn-text" : "muted"}`, text: v.state === "unset" ? "未設定" : v.state === "before" ? "期間前" : "終了" });
    return el(
      "li",
      {},
      el(
        "button",
        { type: "button", className: "person", onclick: () => openMemberFromCohort(r.email) },
        el("span", { className: "person-name ellipsis", text: nameText(r) }),
        rem,
        icon("chevron", 16),
      ),
    );
  });
  return el(
    "section",
    { className: "box tight" },
    el("div", { className: "box-head" }, el("h3", { text: "受講者" }), el("span", { className: "small muted", text: "残りの少ない順" })),
    items.length ? el("ul", { className: "people" }, ...items) : el("p", { className: "muted small", text: "まだ所属している受講者がいません。" }),
    members.length
      ? el("button", {
        type: "button",
        className: "link-btn",
        text: `${members.length}人すべてを名簿で見る`,
        onclick: () => showCohortInRoster(c.id),
      })
      : null,
  );
}

function openMemberFromCohort(email) {
  if (isDesktop()) {
    switchTab("roster");
    openMember(email);
  } else {
    openMember(email);
  }
}

function showCohortInRoster(id) {
  closeSheet();
  // 受講者だけ（受講者以外の行に残った cohort_id には当てない）
  state.filter = "student";
  state.query = id;
  $("q").value = id;
  switchTab("roster");
  renderRoster();
}

function cohortAddButtons(c) {
  return el(
    "div",
    { className: "grid-2" },
    el("button", { type: "button", className: "btn primary", text: "受講者を追加", onclick: () => openAdd({ role: "student", cohortId: c.id }) }),
    el("button", { type: "button", className: "btn", text: "名簿から選ぶ", onclick: () => enterSelect({ cohortTarget: c.id }) }),
  );
}

function cohortManage(c) {
  const block = cohortDeleteBlock({ memberCount: c.member_count, ...cohortStageData(c.id) });
  return [
    el("h3", { className: "group-title", text: "管理" }),
    el(
      "div",
      { className: "menu" },
      el("button", { type: "button", className: "mrow danger", text: "回を削除", disabled: !!block, title: block, onclick: () => removeCohort(c) }),
    ),
    el("p", { className: "hint", text: block ?? "削除すると元に戻せません。" }),
  ];
}

/** 回の入力欄（作成・編集で共通）。読む関数と ID の予告を返す */
function cohortInputs(values = {}, rule = null) {
  const venueOptions = state.venues
    .filter((v) => v.active || v.no === values.venue_no)
    .map((v) => ({ value: v.no, label: `${v.no} ${v.name}` }));
  const venue = selectInput(
    [...(values.venue_no ? [] : [{ value: "", label: "会場を選ぶ" }]), ...venueOptions],
    values.venue_no ?? (venueOptions.length === 1 ? venueOptions[0].value : ""),
  );
  const day1 = dateInput(values.day1_date);
  const day2 = dateInput(values.day2_date);
  // テンプレートを当てた回は、Day1 が始まったあとは Day1 を、Day2 は明日以降の日付どうしだけ変えられる（DB の規則と同じ。最後に断るのは DB）
  if (rule?.guarded) {
    day1.disabled = !rule.day1Editable;
    day2.disabled = !rule.day2Editable;
    if (rule.day1Editable && rule.minDay1) day1.min = rule.minDay1;
    if (rule.day2Editable && rule.minDay2) day2.min = rule.minDay2;
  }
  const credits = {
    day1_credits: creditInput(values.day1_credits),
    bridge_credits: creditInput(values.bridge_credits),
    day2_credits: creditInput(values.day2_credits),
  };
  const name = textInput({ placeholder: "例：第2回" });
  name.value = values.name ?? "";
  const note = textInput({ placeholder: "例：講師 小野寺さん" });
  note.value = values.note ?? "";
  const idNow = () => cohortIdOf(venue.value, day1.value);
  return {
    venue,
    day1,
    day2,
    credits,
    name,
    note,
    idNow,
    read: () => ({
      venue_no: venue.value,
      day1_date: readDate(day1),
      day2_date: readDate(day2),
      day1_credits: credits.day1_credits.value,
      bridge_credits: credits.bridge_credits.value,
      day2_credits: credits.day2_credits.value,
      name: name.value,
      note: note.value,
    }),
    onChange(fn) {
      for (const i of [venue, day1, day2]) i.addEventListener("input", fn);
      venue.addEventListener("change", fn);
    },
  };
}

function creditsFieldset(f, currentPeriod = null) {
  const labels = { day1_credits: "Day1", bridge_credits: "ブリッジ", day2_credits: "Day2" };
  const now = ["day1", "bridge", "day2"].includes(currentPeriod) ? `${currentPeriod}_credits` : null;
  if (now) f.credits[now].classList.add("now");
  return el(
    "fieldset",
    { className: "plain" },
    el("legend", { text: "1 人あたりのクレジット" }),
    el("div", { className: "grid-3" }, ...Object.entries(labels).map(([k, label]) => field(label, f.credits[k]))),
    el("span", {
      className: "hint",
      text: `1 クレジット＝$0.01（約 ${YEN_PER_USD / 100} 円）。空欄のままだと、その期間は生成できません。${now ? "太枠は今の期間です。" : ""}`,
    }),
  );
}

function noVenueBox() {
  return el(
    "div",
    { className: "stack" },
    warnBox("会場がありません。先に会場を追加してください。"),
    el("button", { type: "button", className: "btn", text: "会場を追加", onclick: () => openVenue(null) }),
  );
}

/** 回の作成（スマホはシート、PC はダイアログ） */
function openCohortNew({ returnToAdd = false } = {}) {
  const f = cohortInputs({});
  const idText = el("span", { className: "id num" });
  const dup = el("span", { className: "hint warn-text" });
  const submit = el("button", { type: "button", className: "btn primary big", onclick: () => createCohort(f, { returnToAdd }) });
  const update = () => {
    const id = f.idNow();
    idText.textContent = id ?? `${f.venue.value || "__"}-______`;
    submit.textContent = id ? `${id} を作成する` : "作成する";
    dup.textContent = id && state.cohorts.some((c) => c.id === id) ? `${id} は既にあります（同じ会場・同じ Day1 の回は作れません）。` : "";
  };
  f.onChange(update);
  update();
  const dates = el(
    "div",
    { className: "cohort-dates" },
    field("会場", f.venue),
    field("Day1", f.day1),
    el("div", { className: "day2-cell" }, field("Day2", f.day2, "Day1 の翌日から Day2 の前日までがブリッジワーク期間です。")),
    el(
      "div",
      { className: "preview-cell id-preview", "aria-live": "polite" },
      el("div", { className: "field" }, el("span", { className: "hint", text: "回の ID（自動）" }), idText, dup),
      el("span", { className: "hint", text: "会場番号と Day1 の日付で決まります。同じ会場・同じ日の回は作れません。" }),
    ),
  );
  openSheet("cohort-new", () =>
    setSheet({
      title: "回を作成",
      body: [
        state.venues.some((v) => v.active) ? null : noVenueBox(),
        dates,
        el("div", { className: "box" }, creditsFieldset(f)),
        el("div", { className: "grid-2" }, field("名前（任意）", f.name), field("メモ（任意）", f.note)),
      ],
      foot: [
        submit,
        returnToAdd
          ? el("button", { type: "button", className: "btn big cancel", text: "追加に戻る", onclick: () => openAdd() })
          : cancelButton(),
      ],
    })
  );
}

async function createCohort(f, { returnToAdd }) {
  clearNotice();
  const { patch, problems } = parseCohortForm(f.read());
  if (problems.length) {
    notify("作成できません。次の項目を確認してください。", "error", problems);
    return;
  }
  const id = cohortIdOf(patch.venue_no, patch.day1_date);
  if (state.cohorts.some((c) => c.id === id)) {
    notify(`${id} は既にあります（同じ会場・同じ Day1 の回は作れません）。`, "error");
    return;
  }
  const unset = ["day1_credits", "bridge_credits", "day2_credits"].filter((k) => patch[k] === null);
  if (unset.length && !confirm(`クレジットが未設定の期間があります（その期間は生成できません）。このまま ${id} を作成しますか？`)) return;
  // id は送らない（DB が会場番号と Day1 から決める）
  const { data, error } = await supabase.from("cohorts").insert(patch).select("id").maybeSingle();
  if (error) {
    notify(explainError(error), "error");
    return;
  }
  const newId = data?.id ?? id;
  notify(`${newId} を作成しました。`);
  await Promise.all([loadCohorts(), loadUsage()]);
  if (returnToAdd) {
    openAdd({ cohortId: newId });
    renderAll();
    return;
  }
  closeSheet();
  state.tab = "cohorts";
  renderAll();
  openCohort(newId);
}

/** 回の編集（PC は右のパネル、スマホはシートの中） */
function cohortEditForm(c) {
  // 未保存の入力は、再読み込みで作り直しても残す（保存・「元に戻す」で捨てる）
  const draft = state.cohortDraft?.id === c.id ? state.cohortDraft.raw : null;
  const rule = stagesAvailable() ? cohortDateRule(cohortFull(c)) : null;
  const stageMode = isStageCohort(c.id);
  const f = cohortInputs(draft ? { ...c, ...draft } : c, rule);
  const idLine = el("p", { className: "note-box num", "aria-live": "polite" });
  const draftLine = el("p", { className: "hint warn-text", role: "status" });
  const showDraft = () => {
    draftLine.textContent = state.cohortDraft?.id === c.id ? "未保存の変更があります（保存するまで反映されません。「元に戻す」で捨てます）。" : "";
    draftLine.hidden = !draftLine.textContent;
  };
  const remember = () => {
    state.cohortDraft = {
      id: c.id,
      raw: {
        venue_no: f.venue.value,
        day1_date: f.day1.value,
        day2_date: f.day2.value,
        day1_credits: f.credits.day1_credits.value,
        bridge_credits: f.credits.bridge_credits.value,
        day2_credits: f.credits.day2_credits.value,
        name: f.name.value,
        note: f.note.value,
      },
    };
    showDraft();
  };
  showDraft();
  const update = () => {
    const id = f.idNow();
    const parts = [`変更は所属している受講者 ${Number(c.member_count ?? 0)} 人全員に反映されます。`];
    if (id && id !== c.id) parts.push(`回の ID が ${c.id} → ${id} に変わります。`);
    else parts.push("Day1 の日付・会場を変えると、回の ID も変わります。");
    idLine.textContent = parts.join("");
  };
  f.onChange(update);
  update();
  const form = el(
    "form",
    { className: "stack", onsubmit: (e) => e.preventDefault() },
    field("会場", f.venue),
    el("div", { className: "grid-2" }, field("Day1", f.day1), field("Day2", f.day2)),
    rule?.guarded ? el("p", { className: "hint", text: rule.note }) : null,
    stageMode
      ? el("p", { className: "note-box", text: "この回の上限は、段階ごとに決まります（下の「段階」で変えます）。" })
      : creditsFieldset(f, c.current_period),
    field("名前", f.name),
    field("メモ", f.note),
    idLine,
    draftLine,
    el(
      "div",
      { className: "row-actions end" },
      el("button", {
        type: "button",
        className: "btn",
        text: state.cohortEditing && !isDesktop() ? "やめる" : "元に戻す",
        onclick: () => {
          state.cohortDraft = null;
          state.cohortEditing = false;
          if (isDesktop()) renderCohortAside();
          else renderCohortSheet();
        },
      }),
      el("button", { type: "button", className: "btn primary", text: "保存", onclick: () => saveCohort(c, f) }),
    ),
  );
  form.addEventListener("input", remember);
  form.addEventListener("change", remember);
  return form;
}

async function saveCohort(c, f) {
  clearNotice();
  const { patch, problems } = parseCohortForm(f.read());
  if (problems.length) {
    notify("保存できません。次の項目を確認してください。", "error", problems);
    return;
  }
  const newId = cohortIdOf(patch.venue_no, patch.day1_date);
  if (newId !== c.id && state.cohorts.some((x) => x.id === newId)) {
    notify(`${newId} は既にあります（同じ会場・同じ Day1 の回にはできません）。`, "error");
    return;
  }
  const available = stagesAvailable();
  const stageMode = available && isStageCohort(c.id);
  if (available) {
    // 段階の回の 3 期間のクレジットは、段階の合計を表示しているだけ。書き戻さない（Day ごとに戻したときの値を消さない）
    if (stageMode) for (const k of ["day1_credits", "bridge_credits", "day2_credits"]) delete patch[k];
    const dateProblem = cohortDateProblem(cohortFull(c), patch);
    if (dateProblem) {
      notify(`保存できません。${dateProblem}`, "error");
      return;
    }
  }
  const lines = [`${c.id} の設定を保存しますか？`];
  if (newId !== c.id) lines.push(`・回の ID が ${c.id} → ${newId} に変わります（所属する受講者は新しい ID に移ります）。`);
  if (Number(c.member_count ?? 0) > 0) lines.push(`・所属している受講者 ${c.member_count} 人全員に反映されます。`);
  if (patch.day1_date !== c.day1_date || patch.day2_date !== c.day2_date) {
    lines.push("・日付を変えると、前の日付の枠に付けた一時的な追加は、新しい枠には数えられません。");
  }
  if (!confirm(lines.join("\n"))) return;
  // id は送らない（会場番号・Day1 を変えると DB が計算し直す）。016 の DB では admin_update_cohort（日付の規則は DB が判定する）
  let rowId = null;
  let error = null;
  let notFound = false;
  if (available) {
    const res = await supabase.rpc("admin_update_cohort", { p_cohort_id: c.id, p_changes: patch });
    error = res.error;
    rowId = (Array.isArray(res.data) ? res.data[0] : res.data)?.id ?? null;
    notFound = !error && !rowId;
  } else {
    const res = await supabase.from("cohorts").update(patch).eq("id", c.id).select("id");
    error = res.error;
    rowId = res.data?.[0]?.id ?? null;
    notFound = !error && !rowId;
  }
  if (error) {
    notify(explainError(error), "error");
    await refresh();
    return;
  }
  if (notFound) {
    notify("変更できませんでした（権限が無いか、対象が見つかりません）。", "error");
  } else {
    state.cohortId = rowId;
    state.cohortEditing = false;
    state.cohortDraft = null;
    notify(`${rowId} を保存しました。`);
  }
  await refresh();
}

async function removeCohort(c) {
  const block = cohortDeleteBlock({ memberCount: c.member_count, ...cohortStageData(c.id) });
  if (block) {
    notify(block, "error");
    return;
  }
  if (!confirm(`${c.id} を削除しますか？（元に戻せません）`)) return;
  const { data, error } = await supabase.from("cohorts").delete().eq("id", c.id).select("id");
  if (error) notify(explainError(error), "error");
  else if (!data?.length) notify("削除できませんでした（権限が無いか、対象が見つかりません）。", "error");
  else {
    notify(`${c.id} を削除しました。`);
    state.cohortId = null;
    closeSheet();
  }
  await refresh();
}

// ---- 会場 ----

function openVenue(v) {
  const no = textInput({ inputmode: "numeric", maxlength: "2", placeholder: "例：06", className: "input num" });
  no.value = v?.no ?? "";
  const name = textInput({ placeholder: "例：青山オフィス" });
  name.value = v?.name ?? "";
  const note = textInput({ placeholder: "例：3F セミナールーム" });
  note.value = v?.note ?? "";
  const active = el("input", { type: "checkbox", checked: v ? v.active : true });
  const used = v ? state.cohorts.filter((c) => c.venue_no === v.no).length : 0;
  openSheet("venue", () =>
    setSheet({
      title: v ? `会場 ${v.no} を編集` : "会場を追加",
      body: [
        el("div", { className: "grid-2" }, field("会場番号（2 桁）", no), field("会場名", name)),
        field("メモ（任意）", note),
        el("label", { className: "check" }, active, "新しい回で選べるようにする"),
        el("p", {
          className: "hint",
          text: v && used
            ? `この会場には回が ${used} 件あります。番号を変えると、その回の ID の先頭 2 桁も変わります。`
            : "会場番号は回の ID の先頭 2 桁になります（例：06-261120）。",
        }),
        v
          ? el(
            "div",
            { className: "menu" },
            el("button", {
              type: "button",
              className: "mrow danger",
              text: "会場を削除",
              disabled: used > 0,
              title: used ? "回がある会場は削除できません" : null,
              onclick: () => removeVenue(v),
            }),
          )
          : null,
        v && used ? el("p", { className: "hint", text: "回がある会場は削除できません（新しい回で選べないようにするには、上のチェックを外します）。" }) : null,
      ],
      foot: [
        el("button", { type: "button", className: "btn primary big", text: v ? "保存" : "追加する", onclick: () => saveVenue(v, { no: no.value, name: name.value, note: note.value, active: active.checked }) }),
        cancelButton(),
      ],
    })
  );
}

async function saveVenue(v, raw) {
  clearNotice();
  const { patch, problems } = parseVenueForm(raw);
  if (problems.length) {
    notify("保存できません。次の項目を確認してください。", "error", problems);
    return;
  }
  if ((!v || patch.no !== v.no) && state.venues.some((x) => x.no === patch.no)) {
    notify(`会場番号 ${patch.no} は既に使われています。`, "error");
    return;
  }
  let result;
  if (!v) {
    result = await supabase.from("venues").insert(patch).select("no");
  } else {
    const used = state.cohorts.filter((c) => c.venue_no === v.no);
    if (patch.no !== v.no && used.length) {
      const example = used[0].id;
      if (!confirm(`会場番号を ${v.no} → ${patch.no} に変えると、この会場の回 ${used.length} 件の ID も変わります（例：${example} → ${patch.no}${example.slice(2)}）。よろしいですか？`)) return;
    }
    result = await supabase.from("venues").update(patch).eq("no", v.no).select("no");
  }
  if (result.error) {
    notify(explainError(result.error), "error");
    return;
  }
  if (!result.data?.length) {
    notify("保存できませんでした（権限が無いか、対象が見つかりません）。", "error");
  } else {
    notify(v ? `会場 ${patch.no} を保存しました。` : `会場 ${patch.no}（${patch.name}）を追加しました。`);
    closeSheet();
  }
  await refresh();
}

async function removeVenue(v) {
  if (!confirm(`会場 ${v.no}（${v.name}）を削除しますか？`)) return;
  const { data, error } = await supabase.from("venues").delete().eq("no", v.no).select("no");
  if (error) notify(explainError(error), "error");
  else if (!data?.length) notify("削除できませんでした（権限が無いか、対象が見つかりません）。", "error");
  else {
    notify(`会場 ${v.no} を削除しました。`);
    closeSheet();
  }
  await refresh();
}

// ---- 設定（利用の上限・モデルのオン・オフ・変更の履歴） ----
// 上限と履歴は DB の RPC（014：admin_get_settings・admin_update_settings・admin_settings_history）、
// モデルの一覧は Edge Function admin-api の GET /models（カタログは TS にしか無いため）。保存はどちらも admin_update_settings。

const ADMIN_API_URL = `${SUPABASE_URL}/functions/v1/admin-api`;

async function loadSettingsInfo() {
  const S = state.settings;
  const { data, error } = await supabase.rpc("admin_get_settings");
  if (error) {
    S.error = explainError(error);
    if (S.status !== "ok") S.status = "error";
    return false;
  }
  S.info = data;
  S.status = "ok";
  S.error = "";
  return true;
}

async function loadSettingsHistory() {
  const S = state.settings;
  const { data, error } = await supabase.rpc("admin_settings_history", { p_limit: 50 });
  if (error) {
    S.historyError = explainError(error);
    if (S.historyStatus !== "ok") S.historyStatus = "error";
    return false;
  }
  S.history = data ?? [];
  S.historyStatus = "ok";
  S.historyError = "";
  return true;
}

/** モデルの一覧（admin-api。管理者本人のログインのトークンで呼ぶ）。resetDraft なら未保存のオン・オフを捨てる */
async function loadModels({ resetDraft = false } = {}) {
  const S = state.settings;
  let status = 0;
  let body = null;
  try {
    const { data } = await supabase.auth.getSession();
    const res = await fetch(`${ADMIN_API_URL}/models`, {
      headers: { Authorization: `Bearer ${data?.session?.access_token ?? ""}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      cache: "no-store",
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  if (status !== 200 || !Array.isArray(body?.models)) {
    S.modelsError = status === 200 ? "モデルの一覧の形が正しくありません。" : explainApiError(status, body);
    if (S.modelsStatus !== "ok") S.modelsStatus = "error";
    return false;
  }
  const prev = S.models;
  // 保存しないまま読み直した（1 回の上限の保存・「最新にする」など）とき、「制限なしに戻す」の印は、その区分の一覧が変わっていなければ残す。変わっていれば消して、下書きも基準に戻す
  const carry = resetCarry(prev, body, resetDraft ? {} : S.resetNull);
  const prevDrafts = S.drafts;
  // 区分ごとの未保存の変更の数（読み込み前の基準との差）
  const pendingBy = {};
  for (const sc of MODEL_SCOPES) {
    pendingBy[sc.key] = !resetDraft && prev && prevDrafts && !carry.keep.includes(sc.key) && !carry.lost.includes(sc.key) ? modelChanges(prev.models, scopeSelection(prev.models, sc.key), prevDrafts[sc.key]).count : 0;
  }
  S.models = body;
  const next = Object.fromEntries(MODEL_SCOPES.map((sc) => [sc.key, scopeSelection(body.models, sc.key)]));
  // ほかの管理者が変えた区分（基準の一覧が変わった）で、未保存の変更があるもの
  const conflicts = MODEL_SCOPES.filter((sc) => pendingBy[sc.key] > 0 && !sameIdSet(scopeList(prev, sc.key), scopeList(body, sc.key)));
  let keep = true;
  if (conflicts.length) {
    // 基準だけが黙って新しくならないよう、乗せ直すか捨てるかを選ばせる
    const n = conflicts.reduce((sum, sc) => sum + pendingBy[sc.key], 0);
    keep = confirm(
      `読み込み直したところ、ほかの管理者がモデルの設定（${conflicts.map((sc) => sc.label).join("・")}）を変えていました。\n` +
        `未保存の変更（${n} 件）を、新しい設定に乗せ直しますか？\n` +
        "・OK：あなたが変えたところだけを、新しい設定に当てる\n" +
        "・キャンセル：未保存の変更を捨てて、新しい設定を表示する",
    );
  }
  for (const sc of MODEL_SCOPES) {
    // 未保存の変更がある区分は乗せ直す（捨てるを選んだときの、ほかの管理者が変えた区分は新しい設定のまま）。基準が同じ区分は、カタログが変わった分だけ合わせて残す
    if (pendingBy[sc.key] > 0 && (keep || !conflicts.includes(sc))) {
      next[sc.key] = rebaseModelDraft(prev.models, body.models, prevDrafts[sc.key], sc.key);
    }
  }
  S.drafts = next;
  S.resetNull = Object.fromEntries(carry.keep.map((key) => [key, true]));
  if (carry.lost.length) {
    // 消した区分は、下書きも基準（読み直した値）に戻してある。表示と合わせて、閉じるまで残す警告で知らせる
    notify(`${carry.lost.map(scopeLabel).join("・")}の一覧がほかで変わったため、「制限なしに戻す」は取り消されました。表示は最新の設定に戻しています。もう一度押してから保存してください。`, "warn");
  }
  S.modelsStatus = "ok";
  S.modelsError = "";
  return true;
}

/** 設定の画面の 3 つを読み直す。前に読めていた部分の読み直しに失敗したら知らせる（画面は前の値のまま） */
async function loadSettingsAll(options = {}) {
  const S = state.settings;
  for (const k of ["status", "historyStatus", "modelsStatus"]) if (S[k] === "idle") S[k] = "loading";
  renderSettings();
  const [a, b, c] = await Promise.all([loadSettingsInfo(), loadSettingsHistory(), loadModels(options)]);
  const stale = [];
  if (!a && S.status === "ok") stale.push(`上限：${S.error}`);
  if (!b && S.historyStatus === "ok") stale.push(`履歴：${S.historyError}`);
  if (!c && S.modelsStatus === "ok") stale.push(`モデル：${S.modelsError}`);
  if (stale.length) notify("設定の一部を読み直せませんでした（前に読んだ値を出しています）。", "error", stale);
  renderSettings();
}

function renderSettings() {
  if (state.tab !== "settings") return;
  $("settings-main").replaceChildren(usageBox(), limitsBox(), ...(stagesAvailable() ? [templatesBox()] : []));
  renderModelsBox();
  $("settings-history").replaceChildren(historyBox());
}

/** 見出しつきの面。読み込み中・エラーのときは中身の代わりに状態を出す */
function settingsBox(id, title, status, error, aside, content) {
  let body;
  if (status === "ok") body = content();
  else if (status === "error") body = [errorBox(error, () => loadSettingsAll())];
  else body = [el("p", { className: "muted", text: "読み込み中…" })];
  return el(
    "section",
    { className: "box", "aria-labelledby": id },
    el("div", { className: "box-head baseline" }, el("h3", { id, text: title }), status === "ok" ? aside : null),
    ...body,
  );
}

function usageBox() {
  const S = state.settings;
  return settingsBox("usage-h", "直近 24 時間の利用（全体）", S.status, S.error, el("span", { className: "small muted", text: "見積額" }), () => {
    const u = globalUsageView(S.info);
    const out = [
      el(
        "div",
        { className: "bignum num" },
        el("span", { className: `big-n mid ${u.low ? "low" : ""}`, text: formatUsdShort(u.cost) }),
        el("span", { className: "muted", text: u.limit === null ? `上限は${DEFAULT_SETTING_TEXT}` : `/ 上限 ${formatUsdShort(u.limit)}` }),
      ),
    ];
    if (u.pct !== null) {
      out.push(
        bar(u.pct, u.low, "thick"),
        el("p", { className: `small num ${u.low ? "low-text" : ""}`, text: `上限の ${u.pct}% を使用・生成 ${formatCredits(u.count)} 回` }),
      );
    } else {
      out.push(el("p", { className: "small num", text: `生成 ${formatCredits(u.count)} 回。上限が既定のため、割合は出せません。` }));
    }
    out.push(el("p", { className: "hint", text: "全員の合計です（はっきり投入されなかったものは除く）。上限を超えると、全員が生成できなくなります。" }));
    const top = Array.isArray(S.info?.top_users) ? S.info.top_users : [];
    out.push(el("h4", { className: "group-title", text: "回数の多い利用者（上位 5 人）" }));
    if (!top.length) {
      out.push(el("p", { className: "muted small", text: "直近 24 時間の生成はありません。" }));
    } else {
      out.push(
        el(
          "ol",
          { className: "top-users", "aria-label": "回数の多い利用者" },
          ...top.map((t, i) => {
            const r = state.rows.find((x) => x.email === t.email);
            const named = r?.display_name?.trim();
            return el(
              "li",
              {},
              el("span", { className: "rank num", text: `${i + 1}` }),
              el(
                "span",
                { className: "who" },
                el("span", { className: "strong ellipsis", text: named ? r.display_name : (t.email ?? "（不明）") }),
                named ? el("span", { className: "small muted ellipsis", text: t.email }) : null,
              ),
              el("span", { className: "val num", text: `${formatCredits(t.count)} 回 · ${formatUsdShort(Number(t.cost_usd ?? 0).toFixed(2))}` }),
            );
          }),
        ),
      );
    }
    return out;
  });
}

function limitsBox() {
  const S = state.settings;
  const updated = S.info?.settings?.updated_at;
  return settingsBox(
    "limits-h",
    "利用の上限",
    S.status,
    S.error,
    updated ? el("span", { className: "small muted num", text: `最終変更 ${formatShortDateTime(updated)}` }) : null,
    () => {
      const row = S.info?.settings ?? {};
      // 015 より前のサーバー（設定の行に新しい列が無い）では、1 回の生成の上限の欄を出さない
      const limits = availableLimits(row);
      return [
        el("div", {}, ...limits.map((spec) => limitRow(spec, row[spec.key] ?? null))),
        el("p", {
          className: "hint",
          text: "「既定」はサーバーの環境変数の値です（その数値はこのコンソールからは見えません）。" +
            "「既定に戻す」は DB の値を消して、環境変数の値に戻します。変更は次の生成からすぐに効きます。" +
            (limits.some((l) => l.key === "job_max_credits") ? "「1 回の生成の上限」だけは環境変数の既定がなく、空欄は「上限なし」です。" : "") +
            (limits.some((l) => l.defaultValue !== undefined)
              ? "段階の回・講師の追加の項目は、「既定」のとき括弧の中の値で動きます（講師の 3 つの既定は仮の値です）。"
              : ""),
        }),
      ];
    },
  );
}

function limitRow(spec, current) {
  const src = settingSource(current, spec.key);
  const input = textInput({
    id: `f-${++fieldSeq}`,
    inputmode: spec.integer ? "numeric" : "decimal",
    className: "input num",
    placeholder: current === null
      ? (spec.usd ? `例：${spec.min * 10}` : spec.defaultValue !== undefined ? `例：${spec.defaultValue}` : spec.credits ? "例：1,500" : "例：200")
      : String(current),
  });
  const save = el("button", {
    type: "button",
    className: "btn primary",
    text: "保存",
    "aria-label": `${spec.label}を保存`,
    onclick: () => saveLimit(spec, input.value, current),
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save.click();
  });
  return el(
    "div",
    { className: "set-row", "data-setting": spec.key },
    el("div", { className: "set-head" }, el("h4", { text: spec.label }), el("span", { className: `badge ${src.kind}`, text: src.label })),
    el("p", { className: "set-now num" }, "今の値：", el("b", { text: formatSettingValue(spec.key, current) })),
    el("p", { className: "hint", text: `${spec.desc}範囲：${settingRangeText(spec.key)}。` }),
    el("label", { for: input.id, className: "field-label", text: `新しい値（${settingRangeText(spec.key)}）` }),
    el(
      "div",
      { className: "set-edit" },
      input,
      save,
      el("button", {
        type: "button",
        className: "link-btn reset",
        text: current === null ? (spec.nullText ? `${spec.nullText}のまま` : "既定のまま") : (spec.resetLabel ?? "既定に戻す"),
        "aria-label": `${spec.label}を${spec.resetLabel ?? "既定に戻す"}`,
        disabled: current === null,
        onclick: () => resetLimit(spec, current),
      }),
    ),
  );
}

async function saveLimit(spec, text, current) {
  clearNotice();
  const r = parseSettingInput(spec.key, text);
  if (r.problem) {
    notify(`保存できません。${r.problem}。`, "error");
    return;
  }
  if (sameSettingValue(r.value, current)) {
    notify(`${spec.label}は既に ${formatSettingValue(spec.key, r.value)} です。`);
    return;
  }
  const to = formatSettingValue(spec.key, r.value);
  // 全体の額（常に）と 1 人の回数（下げるとき）は、生成を止めうるので確認する。すぐに止まる人がいれば警告を添える
  const check = limitChangeCheck(spec.key, current, r.value, state.settings.info);
  if (check.confirm) {
    const lines = [
      `${spec.label}を ${formatSettingValue(spec.key, current)} → ${to} にしますか？`,
      ...(check.note ? [check.note] : []),
      ...check.warnings.map((w) => `注意：${w}`),
      "（次の生成から、すぐに効きます）",
    ];
    if (!confirm(lines.join("\n"))) return;
  }
  await updateSettings({ [spec.key]: r.value }, `${spec.label}を ${to} にしました。`);
}

async function resetLimit(spec, current) {
  clearNotice();
  // 既定の数値はコンソールから見えない（今より下がるかもしれない）ので、どの項目も確認する
  if (spec.nullText) {
    // 環境変数の既定が無い項目（null は「上限なし」）
    if (!confirm(`${spec.label}を「${spec.nullText}」に戻しますか？\n今の値：${formatSettingValue(spec.key, current)}\n（次の生成から、すぐに効きます）`)) return;
    await updateSettings({ [spec.key]: null }, `${spec.label}を「${spec.nullText}」に戻しました。`);
    return;
  }
  if (!confirm(`${spec.label}を既定（サーバーの環境変数の値）に戻しますか？\n今の値：${formatSettingValue(spec.key, current)}\n（既定の数値はこのコンソールからは見えません）`)) return;
  await updateSettings({ [spec.key]: null }, `${spec.label}を既定に戻しました。`);
}

async function updateSettings(changes, doneMessage) {
  const { error } = await supabase.rpc("admin_update_settings", { p_changes: changes });
  if (error) notify(`保存できませんでした。${explainError(error)}`, "error");
  else notify(doneMessage);
  await loadSettingsAll();
}

/** モデルの面だけを描き直す（オン・オフのたびに。押したスイッチ・タブにフォーカスを戻す） */
function renderModelsBox() {
  const host = $("settings-models");
  const focused = document.activeElement?.closest?.("#settings-models") ? document.activeElement.dataset?.focusKey : null;
  host.replaceChildren(modelsBox());
  if (focused) [...host.querySelectorAll("[data-focus-key]")].find((n) => n.dataset.focusKey === focused)?.focus();
}

/** 区分のタブを出すか（古い admin-api・古い設定の行のときは出さず、全体だけ） */
function rolesOn() {
  const S = state.settings;
  return rolesAvailable(S.models, S.info?.settings);
}

/** いま開いているタブ（区分のタブが無いときは全体） */
function currentScope() {
  return rolesOn() ? state.settings.scope : "all";
}

function scopeLabel(key) {
  return MODEL_SCOPES.find((s) => s.key === key)?.label ?? key;
}

function modelTabs(plan) {
  const S = state.settings;
  const scope = currentScope();
  const buttons = MODEL_SCOPES.map((sc, i) => {
    const n = plan.counts[sc.key];
    return el(
      "button",
      {
        type: "button",
        role: "tab",
        id: `model-tab-${sc.key}`,
        "aria-selected": String(sc.key === scope),
        "aria-controls": "model-panel",
        tabindex: sc.key === scope ? "0" : "-1",
        "data-focus-key": `tab:${sc.key}`,
        onclick: () => {
          S.scope = sc.key;
          renderModelsBox();
        },
        onkeydown: (e) => {
          const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: MODEL_SCOPES.length - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          S.scope = MODEL_SCOPES[(to + MODEL_SCOPES.length) % MODEL_SCOPES.length].key;
          renderModelsBox();
          $("settings-models").querySelector(`#model-tab-${S.scope}`)?.focus();
        },
      },
      sc.label,
      n > 0 ? el("span", { className: "tab-count num", text: `${n}`, "aria-label": `（未保存 ${n} 件）` }) : null,
    );
  });
  return el("div", { className: "seg model-tabs", role: "tablist", "aria-label": "モデルの設定の対象" }, ...buttons);
}

function modelsBox() {
  const S = state.settings;
  const list = S.models?.models ?? [];
  const modes = catalogModes(list);
  const roles = rolesOn();
  const scope = currentScope();
  const sLabel = scopeLabel(scope);
  const drafts = S.drafts ? effectiveDrafts(S.models, S.drafts, S.resetNull) : null;
  const usable = drafts ? scopeUsable(list, scope, drafts) : 0;
  return settingsBox(
    "models-h",
    "モデルのオン・オフ",
    S.modelsStatus,
    S.modelsError,
    el("span", { className: "small muted num", text: `${scope === "all" ? "使える" : `${sLabel}が使える`} ${usable} / ${modes.length}` }),
    () => {
      const plan = buildModelSave(S.models, drafts, roles, S.resetNull);
      const draft = drafts[scope];
      const out = [];
      if (roles) out.push(modelTabs(plan));
      const panel = [];
      if (scope === "all") {
        panel.push(
          el("p", {
            className: "hint",
            text: "サーバーの環境変数で許可されたものだけをオンにできます（「サーバー側で無効」は押せません）。保存するまで反映されません。",
          }),
        );
        if (S.models.console_enabled_models === null) {
          panel.push(el("p", { className: "note-box", text: "今は制限なしです（サーバーで許可されたモデルがすべてオン）。" }));
        }
        const notice = roleListNotice(S.models);
        if (notice) panel.push(el("p", { className: "note-box", text: notice }));
      } else {
        panel.push(
          el("p", {
            className: "hint",
            text: `${sLabel}が使えるモデルを選びます。全体でオフのモデルは、ここでは変えられません。管理者には区分の制限はかかりません（全体の設定に従います）。`,
          }),
        );
        if (scopeList(S.models, scope) === null) {
          panel.push(el("p", { className: "note-box", text: `今は制限なしです（全体でオンのモデルは、これから足すモデルも含めて、${sLabel}もすべて使えます）。` }));
        }
        // 保存されている一覧が明示（null でない）のときは、全部オンに見えても出す（古い ID を外すだけの保存は明示の一覧のまま残るため）。
        // 一覧が null で未保存のオフがあるだけなら「元に戻す」で足りる
        if (Array.isArray(scopeList(S.models, scope)) && !S.resetNull[scope]) {
          panel.push(
            el("p", { className: "small muted", text: "今は一覧で決めています。新しく足したモデルは自動では使えるようになりません。" }),
            el("button", {
              type: "button",
              className: "btn restore-null",
              text: "制限なしに戻す",
              onclick: () => {
                if (!confirm(`${sLabel}の制限をなくしますか？\n全体でオンのモデルは、これから足すモデルも含めて、${sLabel}もすべて使えるようになります。\n（保存するまで反映されません）`)) return;
                // 印だけを持つ。この区分の下書きは、表示・件数・確認の文・保存のたびに、今の全体の下書きから作る（effectiveDrafts）
                S.resetNull[scope] = true;
                renderModelsBox();
              },
            }),
          );
        }
      }
      // 今のカタログに無いモデルの ID（どの区分の一覧にも）。次に保存すると外す
      let unknownCount = 0;
      for (const sc of activeScopes(roles)) {
        const unknown = unknownList(S.models, sc.key);
        unknownCount += unknown.length;
        if (unknown.length) {
          const where = sc.key === "all" ? "設定" : `${sc.label}の一覧`;
          panel.push(warnBox(`今のカタログに無いモデルの ID が ${unknown.length} 件、${where}に残っています（効果はありません。次に保存すると外します）：${listText(unknown, 6)}`));
        }
      }
      if (!list.length) panel.push(el("p", { className: "muted", text: "モデルがありません。" }));
      for (const g of groupModels(list)) {
        panel.push(
          el(
            "div",
            { className: "model-group" },
            el("h4", { className: "group-title", text: `${g.label}（${g.models.length}）` }),
            el("div", { className: "menu" }, ...g.models.map((m) => modelItem(m, scope))),
          ),
        );
      }
      out.push(
        roles
          ? el("div", { id: "model-panel", className: "model-panel", role: "tabpanel", "aria-labelledby": `model-tab-${scope}` }, ...panel)
          : el("div", { className: "model-panel" }, ...panel),
      );
      const dirty = plan.count > 0;
      const on = plan.entries.reduce((n, e) => n + e.on.length, 0);
      const off = plan.entries.reduce((n, e) => n + e.off.length, 0);
      const detail = roles
        ? `全体 ${plan.counts.all}・受講者 ${plan.counts.student}・AIKENメンバー ${plan.counts.member}`
        : `オン ${on}・オフ ${off}`;
      out.push(
        el(
          "div",
          { className: "save-bar" },
          el("span", {
            className: `save-state num ${dirty ? "dirty" : ""}`,
            role: "status",
            text: dirty ? `未保存の変更 ${plan.count} 件（${detail}）` : "未保存の変更はありません",
          }),
          el("button", {
            type: "button",
            className: "btn",
            text: "元に戻す",
            disabled: !dirty,
            onclick: () => {
              S.drafts = Object.fromEntries(MODEL_SCOPES.map((sc) => [sc.key, scopeSelection(list, sc.key)]));
              S.resetNull = {};
              renderModelsBox();
            },
          }),
          el("button", {
            type: "button",
            className: "btn primary",
            text: "モデルの設定を保存",
            disabled: !dirty && !unknownCount,
            onclick: saveModels,
          }),
        ),
      );
      return out;
    },
  );
}

const LOCKED_TITLE = "サーバーの環境変数（ENABLED_PROVIDER_MODELS）で許可されていないため、ここでは変えられません";

/** 押せない理由（title の文）。kind は scopeModeStatus の kind */
function lockedTitle(kind, scope) {
  if (kind === "global_off") return `全体でオフのため、${scopeLabel(scope)}のタブでは変えられません。全体のタブでオンにしてください`;
  if (kind === "server_off") return LOCKED_TITLE;
  return "サーバー側で無効、または全体でオフのため、ここでは変えられません";
}

/** 開閉の領域の id を重ねないための連番 */
let modelPanelSeq = 0;

/** モデル 1 つ：見出しの行に一括スイッチ、その下に字下げしてモードごとのスイッチ（モードが 1 つだけなら一括スイッチだけ） */
function modelItem(m, scope) {
  const S = state.settings;
  const drafts = effectiveDrafts(S.models, S.drafts, S.resetNull);
  const draft = drafts[scope];
  const modes = m.modes ?? [];
  const statusOf = (mode, on) => scopeModeStatus(m, mode, on, scope, drafts.all);
  const lockedFn = (mode) => statusOf(mode, false).locked;
  const ms = masterState(modes, draft, lockedFn);
  const free = modes.filter((mode) => !lockedFn(mode));
  const single = modes.length === 1 ? modes[0] : null;
  const sub = [single?.label, m.provider, m.price?.text, single?.model_id].filter(Boolean).join(" · ");
  const lockKinds = [...new Set(modes.map((mode) => statusOf(mode, false)).filter((st) => st.locked).map((st) => st.kind))];

  let stateKind;
  let stateText;
  if (single) {
    const st = statusOf(single, draft.has(single.model_id));
    stateKind = st.kind;
    stateText = st.text;
  } else if (modes.length === 0) {
    stateKind = "server_off";
    stateText = "経路なし";
  } else if (ms === "locked") {
    stateKind = lockKinds.length === 1 ? lockKinds[0] : "server_off";
    stateText = lockKinds.length === 1 ? (lockKinds[0] === "global_off" ? "全体でオフ" : "サーバー側で無効") : "変更できません";
  } else if (ms === "mixed") {
    stateKind = "mixed";
    stateText = "一部";
  } else if (ms === "on") {
    stateKind = m.provider_available ? "on" : "provider_off";
    stateText = m.provider_available ? "オン" : "オン（提供元が使えない）";
  } else {
    stateKind = "off";
    stateText = "オフ";
  }
  const changed = free.some((mode) => draft.has(mode.model_id) !== modeBaseOn(mode, scope));

  const input = el("input", {
    type: "checkbox",
    role: "switch",
    checked: ms === "on" || (ms === "locked" && modes.some((mode) => draft.has(mode.model_id))),
    disabled: ms === "locked",
    "aria-label": single ? `${m.label}：${single.label}` : `${m.label}：まとめて`,
  });
  input.indeterminate = ms === "mixed";
  input.setAttribute("aria-checked", ms === "mixed" ? "mixed" : String(input.checked));
  input.dataset.focusKey = `master:${m.key ?? m.label}`;
  input.addEventListener("change", () => {
    S.drafts[scope] = applyMaster(modes, draft, lockedFn); // draft は印のある区分では「今の形」。ここで下書きとして持ち、印を外す
    S.resetNull[scope] = false;
    renderModelsBox();
  });

  let title = null;
  if (ms === "locked") title = modes.length ? lockedTitle(lockKinds.length === 1 ? lockKinds[0] : "", scope) : "振り分け先の経路が無いため、切り替えられません";
  else if (free.length < modes.length) title = "押せないモード（サーバー側で無効・全体でオフ）は変わりません";

  // 一部だけオンのとき、閉じていても分かるよう「2 つのうち 1 つ」を添える
  const onCount = free.filter((mode) => draft.has(mode.model_id)).length;
  const multi = modes.length > 1;
  const tstate = el(
    "span",
    { className: `tstate mstate ${multi ? "clickable" : ""} ${stateKind}`, title },
    stateText,
    changed ? el("span", { className: "changed", text: "（未保存）" }) : null,
    ms === "mixed" ? el("span", { className: "tcount small muted", text: `${free.length} つのうち ${onCount} つ` }) : null,
  );
  const nameBlock = el("span", { className: "tlabel" }, el("span", { className: "model-name", text: m.label }), sub ? el("span", { className: "small muted ellipsis", text: sub }) : null);
  // スイッチを切り替えるのは、スイッチそのものを押したときだけ（label の範囲はスイッチだけ。名前は aria-label で付けている）
  const switchLabel = (extra = "") => el("label", { className: `toggle master switch-only ${extra} ${ms === "locked" ? "locked" : ""}`, title }, input);

  let row;
  let wrap = null;
  if (!multi) {
    // 切り替えが 1 つだけ（または無い）モデル：開閉のボタンは出さず、スイッチ 1 つだけ（名前・状態の文字を押しても何も起きない）。右端の位置は開閉のボタンと揃える
    row = el("div", { className: "model-row" }, el("div", { className: "model-main" }, nameBlock), tstate, switchLabel(), el("span", { className: "chev-space", "aria-hidden": "true" }));
  } else {
    // 普段は名前と全体のスイッチだけ。右端のボタン・名前・状態の文字を押すと、モードごとのスイッチが下へ出る（スイッチを押しても開閉しない）
    const key = m.key ?? m.label;
    const panelId = `model-modes-${++modelPanelSeq}`;
    const open = S.openModels.has(key);
    const inner = el("div", { className: "modes", id: panelId, inert: !open }, el("div", { className: "modes-in" }, ...modes.map((mode) => modeToggle(m, mode, scope))));
    wrap = el("div", { className: `modes-wrap ${open ? "open" : ""}` }, inner);
    const chev = el(
      "button",
      {
        type: "button",
        className: "chev-btn",
        "aria-expanded": String(open),
        "aria-controls": panelId,
        "aria-label": `${m.label}：モードごとの設定`,
        "data-focus-key": `chev:${key}`,
      },
      icon("chevron", 16, 2.2),
    );
    // 開閉は描き直さずにその場で切り替える（動きを付けるため）。開いた状態は S.openModels に覚える
    const toggleOpen = () => {
      const now = !S.openModels.has(key);
      if (now) S.openModels.add(key);
      else S.openModels.delete(key);
      wrap.classList.toggle("open", now);
      chev.setAttribute("aria-expanded", String(now));
      if (now) inner.removeAttribute("inert");
      else inner.setAttribute("inert", "");
    };
    chev.addEventListener("click", toggleOpen);
    tstate.addEventListener("click", toggleOpen);
    const main = el("div", { className: "model-main clickable", onclick: toggleOpen }, nameBlock);
    row = el("div", { className: "model-row" }, main, tstate, switchLabel("sw"), chev);
  }
  return el(
    "div",
    { className: "model" },
    row,
    m.provider_available ? null : el("p", { className: "small warn-text", text: "提供元が使えません（API キーが未設定など）。オンにしても生成できません。" }),
    modes.length ? null : el("p", { className: "small muted", text: "振り分け先の経路が無いため使えません。" }),
    wrap,
  );
}

function modeToggle(m, mode, scope) {
  const S = state.settings;
  const drafts = effectiveDrafts(S.models, S.drafts, S.resetNull);
  const draft = drafts[scope];
  const on = draft.has(mode.model_id);
  const st = scopeModeStatus(m, mode, on, scope, drafts.all);
  const input = el("input", {
    type: "checkbox",
    role: "switch",
    checked: on,
    disabled: st.locked,
    "aria-label": `${m.label}：${mode.label}`,
  });
  input.dataset.focusKey = mode.model_id;
  input.addEventListener("change", () => {
    // 印のある区分でも、押した時点の見えている形から始める（派生の下書きを持ち替えて、印を外す）
    const next = new Set(draft);
    if (input.checked) next.add(mode.model_id);
    else next.delete(mode.model_id);
    S.drafts[scope] = next;
    S.resetNull[scope] = false;
    renderModelsBox();
  });
  return el(
    "label",
    {
      className: `toggle sub ${st.locked ? "locked" : ""}`,
      title: st.locked ? lockedTitle(st.kind, scope) : null,
    },
    el("span", { className: "tlabel" }, el("span", { className: "mode-name", text: mode.label }), el("span", { className: "small muted ellipsis", text: mode.model_id })),
    el("span", { className: `tstate ${st.kind}` }, st.text, on !== modeBaseOn(mode, scope) && !st.locked ? el("span", { className: "changed", text: "（未保存）" }) : null),
    input,
  );
}

async function saveModels() {
  clearNotice();
  const S = state.settings;
  const roles = rolesOn();
  const plan = buildModelSave(S.models, effectiveDrafts(S.models, S.drafts, S.resetNull), roles, S.resetNull);
  if (!plan.entries.length) return;
  const labelOf = modelLabeler(S.models.models);
  if (!confirm(saveConfirmLines(plan, labelOf).join("\n"))) return;
  for (const warning of emptyScopeWarnings(plan)) if (!confirm(warning)) return;
  // 保存の直前に読み直す（確認のダイアログの間に、ほかの管理者が変えていないか）。3 つの一覧のどれかが変わっていたら保存しない
  const fresh = await supabase.rpc("admin_get_settings");
  if (fresh.error) {
    notify(`保存できませんでした。${explainError(fresh.error)}`, "error");
    return;
  }
  const drift = changedScopes(fresh.data?.settings, S.models, roles);
  if (drift.length) {
    notify(`読み込んだあとに、ほかの管理者がモデルの設定（${drift.join("・")}）を変えたため、保存しませんでした。最新の設定を読み込み直しました。`, "error");
    await loadSettingsAll();
    return;
  }
  const { error } = await supabase.rpc("admin_update_settings", { p_changes: plan.changes });
  if (error) {
    notify(`保存できませんでした。${explainError(error)}`, "error");
    await loadSettingsAll();
    return;
  }
  const on = plan.entries.reduce((n, e) => n + e.on.length, 0);
  const off = plan.entries.reduce((n, e) => n + e.off.length, 0);
  const where = roles ? `${plan.entries.map((e) => e.label).join("・")}：` : "";
  notify(`モデルの設定を保存しました（${where}オン ${on} 件・オフ ${off} 件）。`);
  await loadSettingsAll({ resetDraft: true });
}

function historyBox() {
  const S = state.settings;
  return settingsBox("history-h", "変更の履歴", S.historyStatus, S.historyError, el("span", { className: "small muted", text: "新しい順・直近 50 件" }), () => {
    if (!S.history.length) return [el("p", { className: "muted small", text: "まだ変更はありません。" })];
    const labelOf = S.models ? modelLabeler(S.models.models) : (id) => id;
    const shown = S.history.slice(0, S.historyShown);
    const rest = S.history.length - shown.length;
    return [
      el(
        "ol",
        { className: "history", "aria-label": "変更の履歴" },
        ...shown.map((h) =>
          el(
            "li",
            {},
            el("span", { className: "hmeta num", text: `${formatDateTime(h.changed_at)} · ${h.changed_by_email ?? "変更した人は不明"}` }),
            el("ul", {}, ...settingsDiff(h.before_values, h.after_values, labelOf).map((t) => el("li", { text: t }))),
          )
        ),
      ),
      rest > 0
        ? el("button", {
          type: "button",
          className: "link-btn",
          text: `さらに表示（残り ${rest} 件）`,
          onclick: () => {
            S.historyShown += 10;
            $("settings-history").replaceChildren(historyBox());
          },
        })
        : null,
    ];
  });
}

// ---- 段階（016：セミナーの段階）----
// 回の枠を、Day ごとではなく「ワークショップごとの段階」にする。テンプレートを回に当て、講師を担当にする。
// 段階を進める・戻すのは講師の画面（instructor.html）。ここの書き込みはすべて DB の RPC（守りは DB が入れる）。
// DB が 016 を当てていない間（state.stages.available が false）は、このブロックの欄・操作を出さない。

function emptyStageState() {
  return {
    available: false,
    loaded: false,
    /** cohorts の新しい列：id → { id, credit_mode, stage_template_id, stages_applied_at } */
    cohortInfo: new Map(),
    stages: [],
    templates: [],
    templateItems: [],
    /** 回の講師の担当：{ cohort_id, email } */
    instructors: [],
    /** 段階を動かした記録がある回の id */
    entryCohorts: new Set(),
    /** 段階の回の追加がある段階の id・受講者の email */
    grantStageIds: new Set(),
    grantEmails: new Set(),
    /** 1 人あたり・この回の追加の合計の上限（T）。分からなければ null（DB が判定する） */
    limitT: null,
    /** 回ごとの cohort_stage_status（normalizeStageStatus した値） */
    status: new Map(),
    /** 回ごとに選んでいるテンプレートの id */
    pick: new Map(),
  };
}

const stagesAvailable = () => state.stages.available;
const cohortInfoOf = (id) => state.stages.cohortInfo.get(id) ?? null;
/** 回の行（admin_cohorts）に、段階の列（credit_mode・stages_applied_at）を足したもの */
const cohortFull = (c) => ({ ...c, ...(cohortInfoOf(c?.id) ?? {}) });
const isStageCohort = (id) => cohortInfoOf(id)?.credit_mode === "stage";
const isStageStudent = (r) => r?.role === "student" && !!r.cohort_id && stagesAvailable() && isStageCohort(r.cohort_id);
const stagesOfCohort = (id) => state.stages.stages.filter((s) => s.cohort_id === id);

/** 回の段階の記録・追加の有無（回は、あると削除できない） */
function cohortStageData(id) {
  const S = state.stages;
  return {
    hasEntries: S.entryCohorts.has(id),
    hasGrants: S.stages.some((s) => s.cohort_id === id && S.grantStageIds.has(s.id)),
  };
}

/**
 * 段階の情報を読む。cohorts に新しい列（credit_mode など）が無ければ 016 の前の DB：available を false にして、何も出さない。
 * 読めなかった（通信の失敗など）ときは、前の値のまま
 */
async function loadStageInfo() {
  const S = state.stages;
  const c = await supabase.from("cohorts").select("id, credit_mode, stage_template_id, stages_applied_at");
  if (c.error) {
    if (isMissingSchemaError(c.error)) Object.assign(S, emptyStageState(), { loaded: true });
    return false;
  }
  const [st, en, tp, ti, ins, gr, set] = await Promise.all([
    supabase.from("cohort_stages").select("id, cohort_id, day_kind, seq, label, title, credits").order("seq"),
    supabase.from("cohort_stage_entries").select("cohort_id").limit(1000),
    supabase.from("stage_templates").select("id, name, note, active, updated_at").order("name"),
    supabase.from("stage_template_items").select("id, template_id, day_kind, seq, label, title, credits").order("seq"),
    supabase.from("cohort_instructors").select("cohort_id, email"),
    supabase.from("credit_grants").select("email, stage_id").not("stage_id", "is", null).limit(1000),
    supabase.rpc("admin_get_settings"),
  ]);
  S.available = true;
  S.loaded = true;
  S.cohortInfo = new Map((c.data ?? []).map((x) => [x.id, x]));
  if (!st.error) S.stages = st.data ?? [];
  if (!en.error) S.entryCohorts = new Set((en.data ?? []).map((x) => x.cohort_id));
  if (!tp.error) S.templates = tp.data ?? [];
  if (!ti.error) S.templateItems = ti.data ?? [];
  if (!ins.error) S.instructors = ins.data ?? [];
  if (!gr.error) {
    S.grantStageIds = new Set((gr.data ?? []).map((x) => x.stage_id));
    S.grantEmails = new Set((gr.data ?? []).map((x) => x.email));
  }
  if (!set.error) S.limitT = set.data?.settings?.stage_grant_total_limit ?? 10000;
  return true;
}

/** 回の今の段階など（cohort_stage_status）を読む。読めなければ null（段階の欄に今の段階を出さないだけ） */
async function loadCohortStageStatus(id) {
  const { data, error } = await supabase.rpc("cohort_stage_status", { p_cohort_id: id });
  state.stages.status.set(id, error ? null : normalizeStageStatus(data));
}

/** 回の詳細に足す箱（016 が当たっているときだけ） */
function stageBoxes(c) {
  if (!stagesAvailable() || !cohortInfoOf(c.id)) return [];
  return [stagesSection(c), instructorsSection(c)];
}

function templateItemsOf(id) {
  return state.stages.templateItems.filter((i) => i.template_id === id);
}

function templateName(id) {
  return state.stages.templates.find((t) => t.id === id)?.name ?? null;
}

/** 段階の行の入力欄の組（テンプレートの編集・回の段階の編集で共通）。canStructure は順番・数を変えられるか */
function rowsEditor(kind, initial, { canStructure }) {
  const where = DAY_KIND_LABELS[kind];
  const max = kind === "bridge" ? 1 : MAX_STAGES_PER_DAY;
  let rows = initial.map((r) => ({
    id: r.id ?? null,
    label: r.label ?? "",
    title: r.title ?? "",
    credits: r.credits === null || r.credits === undefined ? "" : String(r.credits),
  }));
  const host = el("div", { className: "stage-rows" });
  const total = el("p", { className: "hint num", "aria-live": "polite" });
  const addBtn = el("button", { type: "button", className: "btn", text: "段階を足す", onclick: () => {
    read();
    rows.push({ id: null, label: "", title: "", credits: "" });
    draw();
  } });
  /** 画面の入力を rows に取り込む */
  function read() {
    host.querySelectorAll(".stage-row").forEach((row, i) => {
      if (!rows[i]) return;
      rows[i].label = row.querySelector('[data-f="label"]').value;
      rows[i].title = row.querySelector('[data-f="title"]').value;
      rows[i].credits = row.querySelector('[data-f="credits"]').value;
    });
    return rows;
  }
  function updateTotal() {
    read();
    const sum = rows.reduce((n, r) => n + (parseCredits(r.credits) ?? 0), 0);
    total.textContent = `${where}の合計 ${formatCredits(sum)} / ${formatCredits(MAX_DAY_STAGE_TOTAL)}`;
    total.classList.toggle("warn-text", sum > MAX_DAY_STAGE_TOTAL);
  }
  function move(i, d) {
    read();
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    draw();
  }
  function draw() {
    host.replaceChildren(
      ...rows.map((r, i) => {
        const label = textInput({ maxlength: "40", placeholder: "名前（例：ワークショップ 1）", "aria-label": `${where} ${i + 1} 番目の名前`, "data-f": "label" });
        label.value = r.label;
        const title = textInput({ maxlength: "60", placeholder: "題名（任意。例：企画）", "aria-label": `${where} ${i + 1} 番目の題名`, "data-f": "title" });
        title.value = r.title;
        const credits = creditInput(r.credits, { placeholder: "上限", "aria-label": `${where} ${i + 1} 番目のクレジット`, "data-f": "credits" });
        for (const input of [label, title, credits]) input.addEventListener("input", updateTotal);
        return el(
          "div",
          { className: "stage-row" },
          el("span", { className: "stage-no num", text: `${i + 1}` }),
          label,
          title,
          credits,
          canStructure
            ? el(
              "span",
              { className: "stage-actions" },
              el("button", { type: "button", className: "btn small-btn", text: "↑", "aria-label": `${i + 1} 番目を上へ`, disabled: i === 0, onclick: () => move(i, -1) }),
              el("button", { type: "button", className: "btn small-btn", text: "↓", "aria-label": `${i + 1} 番目を下へ`, disabled: i === rows.length - 1, onclick: () => move(i, 1) }),
              el("button", {
                type: "button",
                className: "btn small-btn",
                text: "削除",
                "aria-label": `${i + 1} 番目を削除`,
                onclick: () => {
                  read();
                  rows.splice(i, 1);
                  draw();
                },
              }),
            )
            : null,
        );
      }),
    );
    addBtn.disabled = rows.length >= max;
    updateTotal();
  }
  draw();
  return {
    node: el("div", { className: "stack" }, host, canStructure ? addBtn : null, total),
    /** 入力された行（id・名前・題名・クレジットの文字） */
    read: () => read().map((r) => ({ ...r })),
  };
}

// ---- 回の「段階」の箱 ----

function stagesSection(c) {
  const full = cohortFull(c);
  const info = cohortInfoOf(c.id);
  const S = state.stages;
  const rule = cohortDateRule(full);
  const stageMode = info.credit_mode === "stage";
  const rows = stagesOfCohort(c.id);
  const out = [];
  if (stageMode) {
    out.push(
      el("p", { className: "small", text: `テンプレート：${templateName(info.stage_template_id) ?? "（当てたテンプレートは削除されました）"}。当てたあとに変えた分は、テンプレートには戻りません。` }),
    );
    const status = S.status.get(c.id);
    if (status?.current) {
      out.push(el("p", { className: "small strong", text: `今の段階：${stageName(status.current)}` }));
    } else if (status && status.period && !["day1", "bridge", "day2"].includes(status.period)) {
      out.push(el("p", { className: "small muted", text: status.period === "before" ? "Day1 の 0:00 に、最初の段階に自動で入ります。" : "Day2 が終わりました。" }));
    }
    const totals = dayTotals(rows);
    const g = groupStagesByDay(rows);
    for (const kind of DAY_KINDS) {
      if (kind === "bridge" && !dayKindStartDate(full, "bridge")) continue;
      out.push(
        el(
          "div",
          { className: "stage-day" },
          el("div", { className: "box-head" }, el("h4", { className: "group-title", text: DAY_KIND_LABELS[kind] }), el("span", { className: "small muted num", text: `合計 ${formatCredits(totals[kind])}` })),
          g[kind].length
            ? el(
              "ol",
              { className: "periods" },
              ...g[kind].map((s) =>
                el(
                  "li",
                  {},
                  el("div", { className: "period-text" }, el("span", { className: "period-name", text: stageName(s) })),
                  el("span", { className: "period-credits num", text: formatCredits(s.credits) }),
                )
              ),
            )
            : el("p", { className: "warn-text small", text: "段階がありません（このままでは、この日は生成できません）。" }),
        ),
      );
    }
    out.push(
      el("button", { type: "button", className: "btn", text: "段階を編集", onclick: () => openStageEditor(c.id) }),
      el("p", {
        className: "hint",
        text: "段階の名前・題名・クレジットは、授業の途中でも変えられます。順番と数は、その日が始まる前だけ変えられます。段階を進める・戻すのは、講師の画面で行います。",
      }),
      el("a", { className: "link-btn", href: "instructor.html", target: "_blank", rel: "noopener", text: "講師の画面を開く（別のタブ）" }),
    );
  } else {
    out.push(el("p", { className: "small", text: "今は Day ごとの枠です（Day1・ブリッジワーク・Day2 の 1 人あたりの上限）。" }));
  }
  // テンプレートを当てる・枠の種類を戻す（Day1 が始まる前だけ）
  if (!rule.modeEditable) {
    out.push(
      el("p", {
        className: "hint",
        text: stageMode ? "Day1 が始まったため、テンプレートの当て直し・Day ごとの枠に戻すことはできません。" : "Day1 が始まったため、段階ごとの枠にはできません。",
      }),
    );
  } else {
    const active = S.templates.filter((t) => t.active);
    if (!active.length && !S.templates.length) {
      out.push(el("p", { className: "hint", text: "テンプレートがありません。設定の画面の「段階のテンプレート」で作ります。" }));
    } else {
      const choices = active.length ? active : S.templates;
      const select = el(
        "select",
        { className: "input", "aria-label": "当てるテンプレート" },
        ...choices.map((t) => el("option", { value: t.id, text: t.name, selected: t.id === (S.pick.get(c.id) ?? info.stage_template_id) })),
      );
      select.addEventListener("change", () => S.pick.set(c.id, select.value));
      out.push(
        field(stageMode ? "テンプレートを当て直す" : "テンプレートを当てる", select),
        el("button", {
          type: "button",
          className: "btn primary",
          text: stageMode ? "当て直す（段階を全部入れ替える）" : "当てて、段階ごとの枠にする",
          onclick: () => applyTemplate(c, select.value),
        }),
      );
    }
    if (stageMode) {
      out.push(el("button", { type: "button", className: "btn", text: "Day ごとの枠に戻す", onclick: () => setCreditMode(c, "day") }));
    } else if (rows.length) {
      out.push(el("button", { type: "button", className: "btn", text: "前の段階の設定で、段階ごとの枠にする", onclick: () => setCreditMode(c, "stage") }));
    }
  }
  return el("section", { className: "box" }, el("div", { className: "box-head" }, el("h3", { text: "段階（ワークショップごとの上限）" }), stageMode ? el("span", { className: "badge stage", text: "段階ごと" }) : null), ...out);
}

async function applyTemplate(c, templateId) {
  clearNotice();
  const full = cohortFull(c);
  const items = templateItemsOf(templateId);
  const problem = templateApplyProblem(items, full);
  if (problem) {
    notify(`当てられません。${problem}`, "error");
    return;
  }
  const t = templateName(templateId);
  const already = isStageCohort(c.id);
  const lines = [`${c.id} に、テンプレート「${t}」を当てますか？`];
  lines.push(already ? "・いまの段階を全部、テンプレートの内容に入れ替えます（段階の名前・クレジットを変えていた分は消えます）。" : "・この回の枠が、Day ごとではなく、ワークショップごとの段階になります。");
  lines.push("・Day1 が始まる前なら、「Day ごとの枠に戻す」で戻せます。始まったあとは戻せません。");
  if (Number(c.member_count ?? 0) > 0) lines.push(`・所属している受講者 ${c.member_count} 人全員に効きます。`);
  if (!confirm(lines.join(String.fromCharCode(10)))) return;
  const { error } = await supabase.rpc("admin_apply_stage_template", { p_cohort_id: c.id, p_template_id: templateId });
  if (error) notify(explainError(error), "error");
  else notify(`${c.id} にテンプレート「${t}」を当てました。`);
  await refresh();
  if (!error && isStageCohort(c.id)) {
    await loadCohortStageStatus(c.id);
    renderAll();
  }
}

async function setCreditMode(c, mode) {
  clearNotice();
  const text = mode === "day"
    ? `${c.id} を Day ごとの枠に戻しますか？（Day1 が始まる前だけ戻せます。段階の設定は残ります）`
    : `${c.id} を、前に設定した段階ごとの枠にしますか？`;
  if (!confirm(text)) return;
  const { error } = await supabase.rpc("admin_set_cohort_credit_mode", { p_cohort_id: c.id, p_mode: mode });
  if (error) notify(explainError(error), "error");
  else notify(mode === "day" ? `${c.id} を Day ごとの枠に戻しました。` : `${c.id} を段階ごとの枠にしました。`);
  await refresh();
}

/** 段階の編集（回の段階の名前・題名・クレジット。順番と数は、その日が始まる前だけ） */
function openStageEditor(cid) {
  const c = state.cohorts.find((x) => x.id === cid);
  if (!c) return;
  const full = cohortFull(c);
  const groups = groupStagesByDay(stagesOfCohort(cid));
  const editors = {};
  const body = [];
  for (const kind of DAY_KINDS) {
    if (kind === "bridge" && !dayKindStartDate(full, "bridge")) continue;
    const started = dayKindStarted(full, kind);
    editors[kind] = rowsEditor(kind, groups[kind], { canStructure: !started });
    body.push(
      el(
        "section",
        { className: "box" },
        el("h3", { text: DAY_KIND_LABELS[kind] }),
        started ? el("p", { className: "hint", text: "この日はもう始まっているため、名前・題名・クレジットだけ変えられます（順番と数は変えられません）。" }) : null,
        editors[kind].node,
      ),
    );
  }
  openSheet("stage-editor", () =>
    setSheet({
      title: `${cid} の段階`,
      body: [
        el("p", { className: "muted", text: "1 つの段階の上限は 0〜10,000、1 日の合計は 10,000 までです。変えると、所属している受講者全員に効きます。" }),
        ...body,
      ],
      foot: [
        el("button", { type: "button", className: "btn primary big", text: "保存", onclick: () => saveStages(cid, groups, editors) }),
        cancelButton(),
      ],
    })
  );
}

async function saveStages(cid, groups, editors) {
  clearNotice();
  const problems = [];
  const plans = [];
  for (const [kind, editor] of Object.entries(editors)) {
    const rows = editor.read();
    const parsed = parseStageRows(kind, rows);
    problems.push(...parsed.problems);
    const orig = groups[kind];
    const same = rows.length === orig.length && rows.every((r, i) => r.id === orig[i].id);
    if (!same) {
      plans.push({
        kind: "replace",
        day: kind,
        stages: parsed.rows.map((r, i) => ({ ...(rows[i].id ? { id: rows[i].id } : {}), seq: i + 1, label: r.label, title: r.title, credits: r.credits })),
      });
    } else {
      rows.forEach((r, i) => {
        const p = parsed.rows[i];
        const o = orig[i];
        if (p.label !== o.label || (p.title ?? null) !== (o.title ?? null) || p.credits !== Number(o.credits)) {
          plans.push({ kind: "update", id: o.id, label: p.label, title: p.title, credits: p.credits, delta: (p.credits ?? 0) - Number(o.credits ?? 0) });
        }
      });
    }
  }
  if (problems.length) {
    notify("保存できません。次の項目を確認してください。", "error", problems);
    return;
  }
  if (!plans.length) {
    notify("変更はありません。");
    return;
  }
  if (!confirm(`${cid} の段階を保存しますか？${String.fromCharCode(10)}（所属している受講者全員の上限が変わります）`)) return;
  // 1 日の合計が途中で 10,000 を超えないよう、クレジットを下げる更新を先に行う
  plans.sort((a, b) => (a.kind === "update" ? a.delta : -Infinity) - (b.kind === "update" ? b.delta : -Infinity));
  for (const p of plans) {
    const { error } = p.kind === "replace"
      ? await supabase.rpc("admin_replace_day_stages", { p_cohort_id: cid, p_day_kind: p.day, p_stages: p.stages })
      : await supabase.rpc("admin_update_cohort_stage", { p_stage_id: p.id, p_label: p.label, p_title: p.title, p_credits: p.credits });
    if (error) {
      notify(`保存の途中で止まりました。${explainError(error)}`, "error");
      await refresh();
      return;
    }
  }
  notify(`${cid} の段階を保存しました。`);
  closeSheet();
  await refresh();
}

// ---- 講師の担当 ----

function instructorsSection(c) {
  const S = state.stages;
  const candidates = state.rows.filter((r) => r.role === "instructor" && r.status === "active");
  const assigned = new Set(S.instructors.filter((x) => x.cohort_id === c.id).map((x) => x.email));
  const boxes = candidates.map((r) => {
    const cb = el("input", { type: "checkbox", value: r.email, checked: assigned.has(r.email) });
    return el("label", { className: "check" }, cb, `${displayName(r)}${r.display_name?.trim() ? `（${r.email}）` : ""}`);
  });
  // 担当に入っているが、いま講師でない・停止中の人（保存すると外れる）
  const stale = [...assigned].filter((e) => !candidates.some((r) => r.email === e));
  return el(
    "section",
    { className: "box" },
    el("h3", { text: "担当の講師" }),
    boxes.length
      ? el("div", { className: "stack" }, ...boxes)
      : el("p", { className: "hint", text: "講師がいません。名簿で、講師にする人の区分を「講師」にします。" }),
    stale.length ? el("p", { className: "warn-text small", text: `次の人は講師でないか停止中です（保存すると担当から外れます）：${stale.join("、")}` }) : null,
    el("button", {
      type: "button",
      className: "btn",
      text: "担当を保存",
      disabled: !boxes.length && !assigned.size,
      onclick: (e) => saveInstructors(c, e.currentTarget.closest("section")),
    }),
    el("p", { className: "hint", text: "担当の講師は、講師の画面で、この回の段階を進める・戻す・クレジットを追加できます。" }),
  );
}

async function saveInstructors(c, section) {
  clearNotice();
  const emails = [...section.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  const { error } = await supabase.rpc("admin_set_cohort_instructors", { p_cohort_id: c.id, p_emails: emails });
  if (error) notify(explainError(error), "error");
  else notify(emails.length ? `${c.id} の担当を ${emails.length} 人にしました。` : `${c.id} の担当を、なしにしました。`);
  await refresh();
}

// ---- テンプレート（設定の画面） ----

function templatesBox() {
  const S = state.stages;
  const items = S.templates.map((t) => {
    const its = templateItemsOf(t.id);
    const count = (k) => its.filter((i) => i.day_kind === k).length;
    return el(
      "li",
      { className: "template-item" },
      el(
        "div",
        { className: "template-text" },
        el("span", { className: "strong ellipsis", text: t.name }, t.active ? null : el("span", { className: "small muted", text: "（使わない）" })),
        el("span", { className: "small muted num", text: `Day1 ${count("day1")} 段階・ブリッジワーク ${count("bridge")} 段階・Day2 ${count("day2")} 段階` }),
        t.note ? el("span", { className: "small muted ellipsis", text: t.note, title: t.note }) : null,
      ),
      el("button", { type: "button", className: "btn small-btn", text: "編集", onclick: () => openTemplateEditor(t) }),
    );
  });
  return el(
    "section",
    { className: "box", "aria-labelledby": "templates-h" },
    el("div", { className: "box-head baseline" }, el("h3", { id: "templates-h", text: "段階のテンプレート" }), el("button", { type: "button", className: "btn small-btn", text: "テンプレートを作る", onclick: () => openTemplateEditor(null) })),
    items.length ? el("ul", { className: "templates" }, ...items) : el("p", { className: "muted small", text: "テンプレートがまだありません。" }),
    el("p", { className: "hint", text: "テンプレートは、回の「段階」から当てます。当てると、段階の内容が回に写されます（そのあとテンプレートを直しても、すでに当てた回は変わりません）。" }),
  );
}

function openTemplateEditor(t) {
  const items = t ? templateItemsOf(t.id) : [];
  const name = textInput({ maxlength: "60", placeholder: "例：標準（Day1 に 3 つ・Day2 に 2 つ）" });
  name.value = t?.name ?? "";
  const note = textInput({ placeholder: "例：2 日間の標準の型" });
  note.value = t?.note ?? "";
  const active = el("input", { type: "checkbox", checked: t ? t.active : true });
  const g = groupStagesByDay(items);
  const editors = Object.fromEntries(DAY_KINDS.map((k) => [k, rowsEditor(k, g[k], { canStructure: true })]));
  openSheet("template-editor", () =>
    setSheet({
      title: t ? "テンプレートを編集" : "テンプレートを作る",
      body: [
        field("テンプレートの名前", name),
        field("メモ（任意）", note),
        el("label", { className: "check" }, active, "回に当てるテンプレートの候補に出す"),
        ...DAY_KINDS.map((kind) =>
          el(
            "section",
            { className: "box" },
            el("h3", { text: DAY_KIND_LABELS[kind] }),
            kind === "bridge" ? el("p", { className: "hint", text: "ブリッジワーク期間がある回だけで使います。段階は 1 つだけです。" }) : null,
            editors[kind].node,
          )
        ),
        el("p", { className: "hint", text: "1 つの段階の上限は 0〜10,000、1 日の合計は 10,000 までです。" }),
      ],
      foot: [
        el("button", { type: "button", className: "btn primary big", text: "保存", onclick: () => saveTemplate(t, { name, note, active, editors }) }),
        t ? el("button", { type: "button", className: "btn big danger-btn", text: "削除", onclick: () => deleteTemplate(t) }) : null,
        cancelButton(),
      ],
    })
  );
}

async function saveTemplate(t, f) {
  clearNotice();
  const { value, problems } = parseTemplateForm({
    name: f.name.value,
    note: f.note.value,
    active: f.active.checked,
    days: Object.fromEntries(DAY_KINDS.map((k) => [k, f.editors[k].read()])),
  });
  if (problems.length) {
    notify("保存できません。次の項目を確認してください。", "error", problems);
    return;
  }
  const { error } = await supabase.rpc("admin_save_stage_template", {
    p_template_id: t?.id ?? null,
    p_name: value.name,
    p_note: value.note,
    p_active: value.active,
    p_items: value.items,
  });
  if (error) {
    notify(explainError(error), "error");
    return;
  }
  notify(`テンプレート「${value.name}」を保存しました。`);
  closeSheet();
  await refresh();
}

async function deleteTemplate(t) {
  if (!confirm(`テンプレート「${t.name}」を削除しますか？${String.fromCharCode(10)}（すでに当てた回は、段階の内容を持っているので変わりません）`)) return;
  const { error } = await supabase.rpc("admin_delete_stage_template", { p_template_id: t.id });
  if (error) {
    notify(explainError(error), "error");
    return;
  }
  notify(`テンプレート「${t.name}」を削除しました。`);
  closeSheet();
  await refresh();
}

// ---- アカウント（スマホ） ----

function openAccount() {
  openSheet("account", () =>
    setSheet({
      title: "アカウント",
      body: [
        el(
          "dl",
          { className: "kv boxed num" },
          el("dt", { text: "ログイン中" }),
          el("dd", { text: myEmail }),
          el("dt", { text: "最終更新" }),
          el("dd", { text: state.updatedAt ? formatDateTime(state.updatedAt) : "—" }),
        ),
      ],
      foot: [
        el("button", {
          type: "button",
          className: "btn primary big",
          text: "再読み込み",
          onclick: async () => {
            clearNotice();
            await refresh();
            notify("最新の状態にしました。");
          },
        }),
        el("button", { type: "button", className: "btn big", text: "ログアウト", onclick: signOut }),
      ],
    })
  );
}

// ---- 起動 ----

async function main() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const params = new URLSearchParams(location.search);
  if (params.get("error_description") || hash.get("error_description")) {
    // 文言は誰でも書き換えられるので、URL の内容は表示しない
    fatal("ログインできませんでした。管理者の Google アカウントでログインし直してください。");
    $("status").append(el("button", { type: "button", className: "btn primary big", text: "Google でログイン", onclick: signIn }));
    return;
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) {
    fatal("ログイン状態を確認できませんでした。ページを開き直してください。");
    return;
  }
  if (!session) {
    show("login");
    return;
  }
  // 閉じたタブを開き直したときなど、前の操作から 30 分を過ぎている（記録が無い）なら使わせない
  if (await logoutIfIdle()) return;
  startIdleWatch();
  // 戻ってきた直後の URL に残る code などを消す
  if (location.search) history.replaceState(null, "", returnUrl());

  // 「自分」の判定は DB と同じく Google の ID 連携の email で行う（auth.users の email とは異なる場合がある）
  const { data: googleEmail } = await supabase.rpc("current_google_email");
  myEmail = normalizeEmail(googleEmail ?? session.user.email ?? "");
  const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");
  if (adminError) {
    fatal(`権限を確認できませんでした。${explainError(adminError)}`);
    return;
  }
  if (!isAdmin) {
    $("denied-email").textContent = session.user.email ?? "";
    show("denied");
    return;
  }

  $("me-email").textContent = myEmail;
  $("account-btn").setAttribute("aria-label", `アカウント（${myEmail}）`);
  show("app");
  renderAll();
  await Promise.all([loadUsage(), loadCohorts(), loadStageInfo()]);
  renderAll();
}

$("login-btn").addEventListener("click", signIn);
$("logout-btn").addEventListener("click", signOut);
$("denied-logout-btn").addEventListener("click", signOut);
$("reload-btn").addEventListener("click", () => {
  clearNotice();
  refresh();
});
$("account-btn").addEventListener("click", openAccount);
$("tab-roster").addEventListener("click", () => switchTab("roster"));
$("tab-cohorts").addEventListener("click", () => switchTab("cohorts"));
$("tab-settings").addEventListener("click", () => switchTab("settings"));
$("q").addEventListener("input", () => {
  state.query = $("q").value;
  renderRoster();
});
$("select-btn").addEventListener("click", () => enterSelect());
$("select-btn-desk").addEventListener("click", () => (state.selecting ? exitSelect() : enterSelect()));
$("add-btn-desk").addEventListener("click", () => openAdd());
$("fab").addEventListener("click", () => (state.tab === "roster" ? openAdd() : openCohortNew()));
// 幅が変わったら、表とカード・右のパネルとシートを切り替える
desktopMq.addEventListener("change", () => {
  if (sheet.open && ["member", "cohort", "account"].includes(sheetKind)) closeSheet();
  placeNotice();
  renderAll();
});

main().catch((e) => fatal(`エラーが発生しました：${e?.message || e}`));
