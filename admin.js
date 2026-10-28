// 管理コンソール。名簿（members）・回（cohorts）・会場（venues）の管理と使用量の確認を、管理者本人のログインで行う
// （権限は DB の is_admin と RLS で判定）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// 幅 900px 以上は表＋右のパネル（PC）、未満はカード＋下から出るシート（スマホ）。
// supabase-js は admin.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
import {
  ADMIN_CONSOLE_STORAGE_KEY,
  ADMIN_LOGIN_FLOW_KEY,
  ADMIN_SESSION_LIMIT_MS,
  adminConsoleExpired,
  adminConsoleExpiresAt,
  authEventKind,
  browserStorage,
  clearStoredSession,
  discardOldTabSessions,
  LEGACY_STORAGE_PREFIX,
  OLD_ADMIN_STORAGE_PREFIXES,
  sameIdentity,
  sessionChangeKind,
  sessionIdentity,
  storedAccessToken,
  takeStoredSession,
} from "./auth-storage.js";
import { discardDlKey } from "./share-lib.js";
import {
  accessText,
  addSubmitLabel,
  adminAddConfirmView,
  adminLoginErrorText,
  approxCreditsText,
  bulkAddResult,
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
  isNetworkFailure,
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
  usageCellView,
  windowLastDayText,
  windowView,
  fxRateNote,
  setFxRate,
  yenPerCredit,
  catalogModes,
  enabledModelsPayload,
  applyMasterOptIn,
  masterView,
  optInModelIds,
  modeStatus,
  normalizeOptInModes,
  explainApiError,
  formatUsdShort,
  availableLimits,
  settingDesc,
  settingLabel,
  buildModelSave,
  changedScopes,
  emptyScopeWarnings,
  groupModels,
  listText,
  toastOverflow,
  MODEL_SCOPES,
  modelChanges,
  modelLabeler,
  modeBaseOn,
  roleListNotice,
  rolesAvailable,
  saveConfirmLines,
  saveConfirmNote,
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
  setStageDbReady,
  isMonthlyRole,
  isWindowRole,
  rosterFilters,
  roleLabelsFor,
  MSG_STAGE_NOT_READY,
  checkedText,
  editDirty,
  freshnessView,
  groupSettingLimits,
  limitConfirmView,
  modelScopeSummary,
  resetConfirmView,
  settingEmptyText,
  settingInitialText,
  settingSpec,
  settingTarget,
  settingUnitText,
  settingValueText,
  usageSummaryView,
  usdCreditsText,
  createLoadGate,
  normalizeSubtab,
  SETTINGS_SUBTABS,
  subtabByKey,
  subtabOfSelection,
  formatAxisCredits,
  normalizeTrendDim,
  normalizeTrendRange,
  TREND_DIMS,
  TREND_RANGES,
  trendAxisLabels,
  trendDataOk,
  trendSeriesPlan,
  trendStackGeometry,
  trendTicks,
  trendView,
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
  MSG_BULK_GRANT_NETWORK_FAILURE,
  normalizeStageStatus,
  parseStageRows,
  parseTemplateForm,
  REVOKE_CONFIRM_LINES,
  REVOKE_CONFIRM_TEXT,
  stageGrantTotalProblem,
  stageName,
  templateApplyProblem,
  MAX_DAY_STAGE_TOTAL,
  MAX_STAGES_PER_DAY,
} from "./stage-lib.js";
import { storageUsageView } from "./storage-usage-lib.js";
import {
  cohortCloseCanAct,
  cohortCloseError,
  cohortCloseLines,
  cohortCloseSameIdentity,
  createCohortCloseAction,
  normalizeCohortCloseStatus,
  normalizeCohortCloseSummaries,
} from "./cohort-close-lib.js";
import { fillIcons, renderSiteNav } from "./site-nav.js";

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
  document.getElementById("status").textContent = "画面を表示できませんでした。インターネットの接続を確かめて、ページを開き直してください。";
  throw new Error("supabase-js を読み込めませんでした");
}

// 管理コンソールのログインは、ほかの画面（マイページ・講師の画面・Canvas・許可の画面）と共有しない（決定 70）。
// 管理者の権限は、管理コンソールのログインの流れで作ったセッションだけ・登録から 12 時間（決定 74・193 の 1930。
// docs/design-canvas-login-link.md 5.3）：admin-api が PKCE の検証子を持ち（/admin-login/start）、Google から戻った認証コードを
// サーバーで交換して登録する（/admin-login/finish）。supabase-js の OAuth のログインは使わない（URL のコードを部品に交換させない。detectSessionInUrl: false）。
// 保存先は localStorage の管理コンソールだけの新しい鍵（ADMIN_CONSOLE_STORAGE_KEY）。12 時間はサーバーの期限（admin_expires_at・
// admin_console_status()）だけで数え、画面の側で時刻を記録しない。
// 以前の版が localStorage（sb-…・決定 70 の版の aiken-studio-admin-auth）・sessionStorage（aiken-admin-auth など）に残した
// セッションは、開いた時点で捨てる（移さない。この端末だけのログアウトを送ってから消す）
const localStore = browserStorage("local");
const sessionStore = browserStorage("session");

/** この端末のセッションだけをサーバーで終わらせる（keepalive。失敗しても先へ進む） */
function sendLocalLogout(token) {
  if (!token) return;
  try {
    fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: "POST",
      keepalive: true,
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  } catch {
    // 送れなくても、保存先は呼び出し側で消す
  }
}

clearStoredSession(localStore, LEGACY_STORAGE_PREFIX);
discardOldTabSessions(sessionStore, sendLocalLogout);
discardOldTabSessions(localStore, sendLocalLogout, OLD_ADMIN_STORAGE_PREFIXES);
// 保存のページ（/dl）が、このタブの sessionStorage に一時に置いた鍵：開いた時点で消す（設計 4.9 の消す条件 (d)）
discardDlKey(sessionStore);

/**
 * Google から戻った認証コード（?code）と失敗の印。supabase-js の部品を作る前に URL から取り出し、すぐ消す
 * （部品が自分で交換しないように。コードはこの関数の中と /admin-login/finish の本文にだけ置く）
 */
const loginReturn = (() => {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = params.get("code");
  const failed = !!(params.get("error") || params.get("error_description") || hash.get("error_description"));
  if (location.search || location.hash) history.replaceState(null, "", location.origin + location.pathname);
  return { code: code || null, failed };
})();

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
    storageKey: ADMIN_CONSOLE_STORAGE_KEY,
    ...(localStore ? { storage: localStore } : {}),
  },
});

const $ = (id) => document.getElementById(id);
const SECTIONS = ["status", "login", "denied", "app"];
/** 設定の小さなタブの覚え先（sessionStorage。ログインの保存とは別の鍵。使えないときは覚えないだけ） */
const SUBTAB_KEY = "aiken-admin-settings-subtab";
function readSubtab() {
  try {
    return normalizeSubtab(browserStorage("session")?.getItem(SUBTAB_KEY) ?? null);
  } catch {
    return "usage";
  }
}
function writeSubtab(key) {
  try {
    browserStorage("session")?.setItem(SUBTAB_KEY, key);
  } catch {
    // 覚えられなくても続ける
  }
}

const desktopMq = window.matchMedia("(min-width: 900px)");
const isDesktop = () => desktopMq.matches;
// 設定タブの右の欄は 1,100px 以上（em なので、文字を大きくしたときは早めにシートの形へ戻す。提案書 11.2）
const wideMq = window.matchMedia("(min-width: 68.75em)");
const isWide = () => wideMq.matches;
let myEmail = "";
/** 12 時間でログアウトした・ほかのタブでログアウトした（このあと遅れて届いた応答で、画面や前の人の値を出さない） */
let appClosed = false;

/** 画面の状態 */
const state = {
  tab: "roster",
  /** 提出の受け付けの終わりの部品（admin-submissions.js。入口は loadDeadlines。ログアウトで null） */
  deadlines: null,
  /** 名簿に追加のシートの入力（buildAddUi の戻り値。開いたときに入る。ログアウトで clearAppView が入力を消す。U3-2） */
  addUi: null,
  rows: [],
  /** loading | ok | error（一度も読めていないときだけ error） */
  rowsStatus: "loading",
  rowsError: "",
  cohorts: [],
  venues: [],
  cohortsStatus: "loading",
  cohortsError: "",
  cohortCloseStates: new Map(),
  cohortCloseStatuses: new Map(),
  cohortCloseErrors: new Map(),
  cohortCloseListError: "",
  cohortCloseBusy: false,
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
  /**
   * 読み込みの部分ごとの、最後に成功した時刻（ms）と、最後の読み込みが失敗したか（前に読んだ値を出している）。
   * 設定の 3 つ（上限・モデル・履歴）は state.settings の infoAt などに持つ。新しく一定間隔の取得はしない（手動の更新が起点）
   */
  fresh: { rows: { at: null, stale: false }, cohorts: { at: null, stale: false }, stages: { at: null, stale: false } },
  /** タブごとのスクロールの位置（タブを行き来したときに戻す） */
  scroll: { roster: 0, cohorts: 0, settings: 0 },
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
    storageStatus: "idle",
    storageError: "",
    storage: null,
    storageAt: null,
    /** 画面上のオン・オフ（未保存を含む model_id の集合）。区分ごと：{ all, student, member } */
    drafts: null,
    /** 開いているモデル（モードごとのスイッチを出している）の key。ページを開き直すまで、保存・タブの切り替え・描き直しのあいだ覚えておく */
    openModels: new Set(),
    /** 「制限なしに戻す」を押した区分（{ student: true }）。保存で null にする。スイッチを押す・元に戻す・読み直しで消える */
    resetNull: {},
    /** 開いているタブ（all・student・member） */
    scope: "all",
    /** 部分ごとの最後に成功した時刻（ms） */
    infoAt: null,
    modelsAt: null,
    historyAt: null,
    /** 選んでいる項目（{ kind: "limit", key } か { kind: "template", id }）。広い幅は右の欄、狭い幅は下の帯からシート */
    sel: null,
    /** 数値の編集の下書き（{ key, text, initial, base, error, saving }）。画面を描き直しても、閉じても、明示して捨てるまで残す */
    edit: null,
    /** モデルを変更中か（読む表示から［モデルを変更］で入る） */
    modelsEditing: false,
    /** モデルの保存中 */
    modelSaving: false,
    historyOpen: false,
    /** 設定の中の小さなタブ（usage・models・templates・history。決定 71）。最初は［利用と上限］。このタブの間は再読み込みのあとも保つ */
    sub: readSubtab(),
    breakdownOpen: false,
    /** 設定の保存中（結果が決まるまで、ほかの項目の編集・タブの移動を止める） */
    busy: false,
  },
  /**
   * 消費の推移（228：admin_usage_trend。設定の［利用と上限］のグラフ）。設定を初めて開いたときに読む。
   * status は idle | loading | ok | error | missing（DB に 228 が無い）。range は month | year、dim は model | role | cohort | kind
   */
  trend: {
    status: "idle",
    error: "",
    data: null,
    at: null,
    range: "month",
    dim: "model",
    /** 表（「表で見る」）を開いているか */
    tableOpen: false,
    /** 描いている形（trendView の結果）・ホバー中の棒の番号と系列・描いた幅と位置（描き直すまで） */
    view: null,
    active: null,
    activeKey: null,
    geo: null,
    /** 前に描いたときの鍵（同じなら描き直さない。ホバーの表示を消さないため） */
    sig: "",
  },
};

/**
 * 読み込みの部分ごとの、応答の順番の番人（createLoadGate）。遅れて届いた古い応答で、新しい値（保存のあとの値）を戻さない。
 * 保存を始めたとき・終わったときは invalidate() で、それより前に出した読み込みの応答を捨てる
 */
const gates = {
  rows: createLoadGate(),
  cohorts: createLoadGate(),
  stages: createLoadGate(),
  info: createLoadGate(),
  models: createLoadGate(),
  history: createLoadGate(),
  trend: createLoadGate(),
  storage: createLoadGate(),
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
  refresh: [["path", { d: "M20 11a8 8 0 1 0-2.34 5.66" }], ["path", { d: "M20 4v7h-7" }]],
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

/**
 * 作った円の目安（要素への WeakRef）と、その書き直しの関数。名簿の追加の画面などは一度作った DOM を使い回すので、ドル円を読み直したら
 * applyFxRate で、出ている金額と注記を一緒に今のレートに書き直す（Codex TASK-0189 F189-02）。要素が捨てられたら一覧から外す
 */
const yenHintRefs = new Set();
const yenHintUpdaters = new WeakMap();

/** クレジットの入力の横に出す円の目安（ドル円はサーバーの直近 3 か月の平均。無ければ 150 円）。注記は書き直すたびに今のレートから作る */
function yenHint(input) {
  const hint = el("span", { className: "hint num" });
  const update = () => {
    const n = parseCredits(input.value);
    hint.textContent = n === null ? "" : n === undefined ? "整数で入力してください" : `${formatYen(n)}（${fxRateNote()}）`;
  };
  input.addEventListener("input", update);
  update();
  yenHintUpdaters.set(hint, update);
  yenHintRefs.add(new WeakRef(hint));
  return hint;
}

/** 円の目安のドル円を入れ替え（admin_get_settings の fx_usd_jpy。読めない値なら 150）、作ってある円の目安をすべて書き直す */
function applyFxRate(raw) {
  setFxRate(raw);
  for (const ref of yenHintRefs) {
    const hint = ref.deref();
    if (!hint) yenHintRefs.delete(ref);
    else yenHintUpdaters.get(hint)?.();
  }
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

/**
 * 画面上部のお知らせ。kind は "ok"（数秒で消える）・"error"・"warn"（閉じるまで残る）。details は箇条書き。直前と同じ文は 1 つにまとめる（×回数）。
 * action（{ label, onClick }）は、操作のあとに戻る道（［変更履歴を見る］など。3.4 の 9）。
 * fold（{ label, items }）は、折りたたみの中の箇条書き（U3-12）
 */
function notify(message, kind = "ok", details = [], action = null, fold = null) {
  if (appClosed) return;
  if (kind !== "error" && kind !== "warn") kind = "ok";
  placeNotice();
  const key = [kind, message, ...details, action?.label ?? "", ...(fold ? [fold.label, ...fold.items] : [])].join("\n");
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
      // 折りたたみ（［詳しく］。登録済みでスキップした人のメールなど。U3-12）
      fold && fold.items.length
        ? el("details", { className: "notice-fold" }, el("summary", { text: fold.label }), el("ul", {}, ...fold.items.map((d) => el("li", { text: d }))))
        : null,
    ),
  );
  const t = { node, kind, key, count: 1, timer: 0, hover: false, focus: false };
  if (action) {
    node.querySelector(".notice-body").append(
      el("button", {
        type: "button",
        className: "link-btn notice-action",
        text: action.label,
        onclick: () => {
          dismissToast(t);
          action.onClick();
        },
      }),
    );
  }
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

/**
 * 閉じる前に確かめる関数（未保存の編集があるシートだけ。reason は "esc"・"close"。true を返したら閉じてよい）。
 * シートが閉じたら消える。確かめの無いシート（名簿・回など）は、今までどおりすぐ閉じる
 */
let sheetGuard = null;

/** 閉じるボタン・背景・Esc・キャンセルから閉じる（未保存の編集があれば確かめる） */
async function requestCloseSheet(reason = "close") {
  if (sheetGuard && !(await sheetGuard(reason))) return;
  closeSheet();
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
      el("button", { type: "button", className: "icon-btn", "aria-label": "閉じる", onclick: () => requestCloseSheet("close") }, icon("close", 18, 2.2)),
    ),
    el("div", { className: "sheet-body" }, ...body),
    ...(foot.length ? [el("div", { className: "sheet-foot" }, ...foot)] : []),
  );
  placeNotice();
  sheet.scrollTop = scroll;
}

sheet.addEventListener("close", () => {
  const kind = sheetKind;
  sheetKind = null;
  sheetRender = null;
  sheetGuard = null;
  templateDirty = null;
  placeNotice(); // 閉じたので入れ物を body へ戻す（シートの中身を消す前に）
  sheet.replaceChildren();
  // 設定の項目のシートを閉じたら、入口の行へフォーカスを戻す（選択は残る。下の帯から開き直せる）
  if (kind === "setting") {
    renderSettings();
    if (state.settings.sel) focusKey(selFocusKey(state.settings.sel));
  }
});
// 背景（シートの外）を押したら閉じる
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) requestCloseSheet("close");
});
// Esc：確かめのあるシートは、上から 1 つずつ（編集 → 読む → 閉じる）
sheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  requestCloseSheet("esc");
});

function cancelButton(text = "キャンセル") {
  return el("button", { type: "button", className: "btn big cancel", text, onclick: () => requestCloseSheet("close") });
}

// ---- 確かめるダイアログ（ブラウザの confirm の代わり。提案書 3.4 の 4・11.7） ----
// 見出しは問い、本文は 3 行まで（lines）、注意は warnings、長い内訳は detail（同じダイアログの中の一覧）。
// 最初のフォーカスと Esc は安全な側（cancelValue）。シートの上にも重ねて出せる（別の dialog）

const askEl = $("ask");
let askDone = null;

/**
 * @param {{ title: string, lines?: string[], note?: string|null, warnings?: string[], detail?: string[],
 *   buttons: { label: string, value: any, kind?: "primary"|"danger"|"" }[], cancelValue?: any, focusValue?: any }} o
 * @returns {Promise<any>} 押したボタンの value（Esc・背景・強制的に閉じたときは cancelValue）
 */
function ask({ title, lines = [], note = null, warnings = [], detail = [], buttons, cancelValue = false, focusValue = cancelValue }) {
  if (askDone) askDone(undefined);
  const back = document.activeElement;
  return new Promise((resolve) => {
    let settled = false;
    askDone = (v) => {
      if (settled) return;
      settled = true;
      askDone = null;
      if (askEl.open) askEl.close();
      resolve(v === undefined ? cancelValue : v);
      if (back && back.isConnected && typeof back.focus === "function") back.focus();
    };
    const btns = buttons.map((b) =>
      el("button", {
        type: "button",
        className: `btn ${b.kind === "danger" ? "danger-fill" : b.kind === "primary" ? "primary" : ""}`,
        text: b.label,
        onclick: () => askDone?.(b.value),
      })
    );
    askEl.replaceChildren(
      el(
        "div",
        { className: "ask-body" },
        el("h2", { id: "ask-title", text: title }),
        ...lines.map((t) => el("p", { text: t })),
        ...warnings.map((w) => el("p", { className: "warn-line", role: "alert" }, el("span", { "aria-hidden": "true", text: "⚠" }), el("span", { text: w }))),
        detail.length ? el("div", { className: "ask-detail" }, el("ul", {}, ...detail.map((d) => el("li", { text: d })))) : null,
        note ? el("p", { className: "ask-note", text: note }) : null,
      ),
      el("div", { className: "ask-foot" }, ...btns),
    );
    askEl.showModal();
    const i = buttons.findIndex((b) => b.value === focusValue);
    (btns[i >= 0 ? i : 0]).focus();
  });
}
askEl.addEventListener("cancel", (e) => {
  e.preventDefault();
  askDone?.(undefined);
});
askEl.addEventListener("click", (e) => {
  if (e.target === askEl) askDone?.(undefined);
});
// ブラウザが閉じた（Esc の連打など）ときも、安全な側で終える。
// close は後のタスクで届く。前の確認を閉じた直後に次の確認が開いていたら（askEl.open）、その close は前の確認のものなので無視する
// （そうしないと、続けて出した確認〔モードが 0 になる警告のあとの保存など〕が、押す前に取り消される。Codex TASK-0092 F1）
askEl.addEventListener("close", () => {
  if (askEl.open) return;
  askDone?.(undefined);
});

/** 保存していない変更を捨ててよいか（［編集を続ける］が既定） */
function askDiscard(what = "入力した値", okLabel = "破棄して閉じる") {
  return ask({
    title: "保存していない変更を破棄しますか？",
    lines: [`${what}は、まだ保存していません。`],
    buttons: [{ label: "編集を続ける", value: false }, { label: okLabel, value: true, kind: "danger" }],
    cancelValue: false,
  });
}

/** data-focus-key でフォーカスを移す（描き直したあと、閉じたあと） */
function focusKey(key, root = document) {
  if (!key) return false;
  const node = [...root.querySelectorAll("[data-focus-key]")].find((n) => n.dataset.focusKey === key && !n.closest("[hidden]"));
  if (!node) return false;
  node.focus();
  return true;
}

// ---- ログイン ----

function returnUrl() {
  return location.origin + location.pathname;
}

/** admin-api（ログインの流れ・モデルの一覧） */
function adminApiUrl(path) {
  return `${SUPABASE_URL}/functions/v1/admin-api${path}`;
}

/** admin-api のログインの流れの口を呼ぶ（JSON の POST）。返り値は { status, body }（通信できなければ status 0） */
async function postLogin(path, payload) {
  try {
    const res = await fetch(adminApiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function signIn() {
  // ログインの流れを始める（検証子は admin-api が持ち、ここには code_challenge と流れの印だけが来る）。
  // 管理コンソールは、従来どおり Google のアカウントを選ぶ画面を出す（ほかの画面のログインと分けて、管理者のアカウントを選ばせる）
  showLoginNote("");
  $("login-btn").disabled = true;
  try {
    const { status, body } = await postLogin("/admin-login/start", {});
    if (status !== 200 || typeof body?.flow_state !== "string" || typeof body?.code_challenge !== "string") {
      showLoginNote(adminLoginErrorText(status, body));
      show("login");
      return;
    }
    try {
      sessionStore?.setItem(ADMIN_LOGIN_FLOW_KEY, body.flow_state);
    } catch {
      sessionStore?.removeItem?.(ADMIN_LOGIN_FLOW_KEY);
    }
    if (sessionStore?.getItem(ADMIN_LOGIN_FLOW_KEY) !== body.flow_state) {
      showLoginNote("このブラウザでは、ログインの途中の記録を保存できません。プライベートブラウズを使っていれば、通常のウィンドウで開いてください。");
      show("login");
      return;
    }
    const q = new URLSearchParams({
      provider: "google",
      redirect_to: returnUrl(),
      code_challenge: body.code_challenge,
      code_challenge_method: "s256",
      prompt: "select_account",
    });
    location.assign(`${SUPABASE_URL}/auth/v1/authorize?${q}`);
  } finally {
    $("login-btn").disabled = false;
  }
}

/**
 * Google から戻ったあと：このタブで始めた流れの印と認証コードを /admin-login/finish に送り、登録できたセッションだけを保存先に入れる。
 * 返り値は { expiresAt }（サーバーの 12 時間の終わり。ミリ秒）か { error }（画面に出す文）
 */
async function finishSignIn(code) {
  let flowState = null;
  try {
    flowState = sessionStore?.getItem(ADMIN_LOGIN_FLOW_KEY) ?? null;
    sessionStore?.removeItem(ADMIN_LOGIN_FLOW_KEY);
  } catch {
    flowState = null;
  }
  if (!flowState) return { error: "このタブで始めたログインではないため、続けられません。もう一度ログインしてください。" };
  const { status, body } = await postLogin("/admin-login/finish", { flow_state: flowState, code });
  const expiresAt = adminConsoleExpiresAt(body?.admin_expires_at ?? null, Date.now());
  if (status !== 200 || typeof body?.access_token !== "string" || typeof body?.refresh_token !== "string" || expiresAt === null) {
    return { error: adminLoginErrorText(status, body) };
  }
  // この端末に前の管理コンソールのセッションが残っていれば、先に終わらせる（新しいログインで置き換える。古いトークンを残さない）
  const previous = storedAccessToken(localStore, ADMIN_CONSOLE_STORAGE_KEY);
  if (previous && previous !== body.access_token) await endConsoleToken(previous);
  const { error } = await supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
  if (error) return { error: "ログインを保存できませんでした。ページを開き直して、もう一度ログインしてください。" };
  return { expiresAt };
}

/** 管理コンソールのセッションをサーバーで終わらせる（admin_console_end で取り消し・終わらせる → この端末だけのログアウト） */
async function endConsoleToken(token) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_console_end`, {
      method: "POST",
      keepalive: true,
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    // 送れなくても続ける（サーバーの掃除が 12 時間のあとに終わらせる）
  }
  sendLocalLogout(token);
}

async function signOut() {
  discardDlKey(sessionStore); // /dl が置いた鍵は、ログアウトで消す（通信を待つ前に）
  // この管理コンソールのセッションだけを終わらせる（マイページなどの共有のログインは別の鍵なので、そのまま。本人の ChatGPT・Codex・
  // Claude Code の接続も切らない）。通信を待つ前に、本人の値・編集中の内容を消して操作を止める（F107-04）
  stopExpireWatch();
  clearAppView();
  $("status").textContent = "ログアウトしています…";
  show("status");
  await endConsoleSession(currentIdentity());
  location.replace(returnUrl());
}

/**
 * 決めたセッション（target）だけをこの端末から消し、サーバーで終わらせる。保存先がまだ target のときだけ、その場で消してから、
 * そのトークンで admin_console_end とログアウトを送る。通信を待つ間にほかのタブで入った新しいログインは消さない（F112-03）
 */
async function endConsoleSession(target) {
  try {
    supabase.auth.stopAutoRefresh?.();
  } catch {
    // 無視
  }
  const token = takeStoredSession(localStore, ADMIN_CONSOLE_STORAGE_KEY, target);
  if (token) await endConsoleToken(token);
}

// ---- 管理コンソールの 12 時間（サーバーの期限）・ほかのタブでのログアウト ----

let expireTimer = null;
let statusTimer = null;
/** サーバーの管理コンソールの期限（ミリ秒。admin_expires_at・admin_console_status() の expires_at）。分からなければ null */
let adminExpiresAt = null;
/** その期限がどのセッションのものか（{ userId, sessionId }）。ほかのタブがログインし直して保存先が替わったら、期限を聞き直す */
let adminExpiresFor = null;

/**
 * サーバーの期限を、そのセッション（identity。照会を始めたときに決めたもの）のものとして覚える。identity を省くのは、
 * 期限を受け取った直後（登録のすぐあと）だけ（TASK-0142 F142-01：あとから保存先を読み直して、別のセッションに結び付けない）
 */
function setConsoleExpiry(expiresAt, identity = currentIdentity()) {
  adminExpiresAt = expiresAt;
  adminExpiresFor = identity;
}
/** サーバーの登録を読み直す間隔（ほかのタブのログアウト・名簿の変更・取り消しに気づく） */
const ADMIN_STATUS_RECHECK_MS = 5 * 60 * 1000;

/** 今保存されている管理コンソールのセッション（{ userId, sessionId }。無ければ null） */
function currentIdentity() {
  try {
    return sessionIdentity(localStore?.getItem(ADMIN_CONSOLE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * サーバーに、今のセッションが管理コンソールの有効なセッションか（登録から 12 時間の内か）を聞く（admin_console_status）。
 * 照会を始めたときのセッション（identity）を決めておき、応答が来るまでに保存先のセッションが替わっていたら（ほかのタブがログインし直した）、
 * その応答は古いものとして stale にする（TASK-0142 F142-01）。返り値は { identity, admin, expiresAt } か { identity, stale } か { error }
 */
async function consoleStatus() {
  const identity = currentIdentity();
  const { data, error } = await supabase.rpc("admin_console_status");
  if (error) return { error, identity };
  if (!identity || !sameIdentity(currentIdentity(), identity)) return { identity, stale: true };
  const admin = data?.admin === true;
  return { identity, admin, expiresAt: admin ? adminConsoleExpiresAt(data?.expires_at ?? null, Date.now()) : null };
}

/** 本人の値・編集中の内容を画面から消す（前の人の値を残さない） */
function clearAppView() {
  appClosed = true;
  state.deadlines?.view?.clear(); // 提出の受け付けの終わり（出ている要求の応答も捨てる）
  state.deadlines = null;
  askDone?.(undefined);
  if (sheet.open) closeSheet();
  clearNotice();
  state.addUi?.reset(); // 追加のシートの入力（メール・氏名・まとめての入力・区分）も消す。前の人の入力を残さない（U3-2）
  state.rows = [];
  state.cohortCloseStates?.clear();
  state.cohortCloseStatuses?.clear();
  state.cohortCloseErrors?.clear();
  state.settings.info = null;
  state.settings.models = null;
  state.settings.history = [];
  state.settings.storage = null;
  state.settings.edit = null;
  state.settings.drafts = null;
  for (const id of ["settings-summary", "settings-main", "settings-storage", "settings-models", "settings-templates", "settings-history", "settings-aside", "settings-bar", "roster-list", "roster-aside", "cohorts-main", "cohort-aside", "overview"]) $(id).replaceChildren();
  // 画面の間の移動の帯も隠す（期限切れなどで、ログインの画面を出す前に endConsoleSession の通信を待つ間も残さない。Codex TASK-0189 F189-03）
  renderSiteNav($("site-nav"), null, "admin");
}

/** 確かめの途中（30 秒ごと・前に出たとき・読み直しが重なっても、1 つずつ） */
let expiring = false;

/**
 * 管理コンソールのログインを終えて、ログインの画面に戻す。終わらせるのは target（呼ぶ側が判定に使ったセッション）だけで、
 * ここで保存先を読み直さない（その間にほかのタブで入った新しいログインは消さない。F112-03・TASK-0142 F142-01）
 */
async function closeConsole(note, target) {
  discardDlKey(sessionStore); // 期限切れ・再確認・起動時の終了でも、通信を待つ前に /dl の鍵を消す
  stopExpireWatch();
  clearAppView();
  await endConsoleSession(target);
  showLoginNote(note);
  show("login");
}

/** サーバーの期限（12 時間）を過ぎていれば（期限が分からないときも）ログアウトして、ログインの画面に戻す。ログアウトしたら true */
async function logoutIfExpired() {
  if (expiring) return false;
  // 判定は auth-storage.js の adminConsoleExpired の 1 か所
  if (!adminConsoleExpired(adminExpiresAt, Date.now())) return false;
  expiring = true;
  try {
    // 期限が切れたのは adminExpiresFor のセッション。ほかのタブがログインし直して、保存先のセッションが替わっていたら（スリープから
    // 戻ったタブなど）、そのセッションの期限をサーバーに聞き直す（古いセッションの期限で、新しいログインを終わらせない）。
    // 応答が古い（照会の間にまた替わった）・読めないときは、何もせず次の確かめに任せる
    const now = currentIdentity();
    let target = adminExpiresFor ?? now;
    if (now && adminExpiresFor && !sameIdentity(now, adminExpiresFor)) {
      const st = await consoleStatus();
      if (st.error || st.stale) return false;
      if (st.admin && st.expiresAt !== null) {
        setConsoleExpiry(st.expiresAt, st.identity);
        if (!adminConsoleExpired(adminExpiresAt, Date.now())) return false;
      }
      target = st.identity;
    }
    await closeConsole(`管理コンソールにログインしてから ${ADMIN_SESSION_LIMIT_MS / 3600000} 時間たったため、ログアウトしました。もう一度ログインしてください。`, target);
    return true;
  } finally {
    expiring = false;
  }
}

/**
 * サーバーの登録を読み直す（前に出たとき・5 分ごと）。管理コンソールの有効なセッションでなくなっていたら（ほかのタブでログアウトした・
 * 取り消された・名簿で管理者でなくなった）ログアウトする。読めなかった（通信の失敗）ときは何もしない（次の確かめに任せる）
 */
async function recheckConsole() {
  if (expiring || appClosed) return false;
  if (await logoutIfExpired()) return true;
  const st = await consoleStatus();
  // 古い応答（照会の間に、ほかのタブでログインし直した）は使わない。期限にも、終わらせる対象にもしない（F142-01）
  if (st.error || st.stale || appClosed || expiring) return false;
  if (st.admin && st.expiresAt !== null) {
    setConsoleExpiry(st.expiresAt, st.identity);
    return false;
  }
  expiring = true;
  try {
    await closeConsole("管理コンソールのログインが終わっていたため、ログアウトしました。もう一度ログインしてください。", st.identity);
    return true;
  } finally {
    expiring = false;
  }
}

function showLoginNote(text) {
  $("login-note").textContent = text;
  $("login-note").hidden = !text;
}

/** このタブが表示している管理者の ID（ログイン前は null） */
let shownUser = null;

/** ほかのタブで管理コンソールからログアウトした・別のアカウントに替わった：中身を消して、ページを読み込み直す */
function onSessionChanged(kind) {
  if (!kind || appClosed) return;
  stopExpireWatch();
  clearAppView();
  $("status").textContent = kind === "signed-out" ? "ログアウトしました。" : "読み込み中…";
  show("status");
  location.replace(returnUrl());
}

function startExpireWatch(userId) {
  shownUser = userId;
  // スリープ・背面のタブではタイマーが遅れるので、前に出たときにも確かめる（サーバーの登録も読み直す）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !appClosed) recheckConsole();
  });
  expireTimer = setInterval(logoutIfExpired, 30000);
  statusTimer = setInterval(recheckConsole, ADMIN_STATUS_RECHECK_MS);
  // ほかのタブの管理コンソールが鍵を書き換えた・消した（マイページなどの共有のログインの変化は見ない）
  window.addEventListener("storage", (e) => onSessionChanged(sessionChangeKind(e, ADMIN_CONSOLE_STORAGE_KEY, shownUser)));
  // supabase-js の知らせ（ほかの管理コンソールのタブの BroadcastChannel・このタブのトークンの更新の失敗）。知らせの中では supabase を待たない
  supabase.auth.onAuthStateChange((event, session) => {
    const kind = authEventKind(event, session, shownUser);
    if (kind) setTimeout(() => onSessionChanged(kind), 0);
  });
}

function stopExpireWatch() {
  if (expireTimer) clearInterval(expireTimer);
  if (statusTimer) clearInterval(statusTimer);
  expireTimer = null;
  statusTimer = null;
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
  state.fresh.rows = { at: Date.now(), stale: false };
  for (const email of [...state.selected]) {
    const r = state.rows.find((x) => x.email === email);
    if (!r || !hasWindow(r)) state.selected.delete(email);
  }
}

async function loadUsage() {
  // 閉じたあとは、新しい読み込みの券を出さない・閉じる前に出した応答を値へ戻さない（F185-01）
  if (appClosed) return false;
  const ticket = gates.rows.begin();
  const { data, error } = await supabase.rpc("admin_usage");
  if (appClosed) return false;
  // より新しい読み込みの応答をもう受け取っている：この古い応答は捨てる（値も確認の時刻も変えない）
  if (!gates.rows.accept(ticket)) return true;
  if (error) {
    state.rowsError = explainError(error);
    if (state.rowsStatus !== "ok") state.rowsStatus = "error";
    state.fresh.rows.stale = true;
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
  if (appClosed) return false;
  const ticket = gates.cohorts.begin();
  const [c, v] = await Promise.all([
    supabase.rpc("admin_cohorts"),
    supabase.from("venues").select("no, name, note, active").order("no"),
  ]);
  if (appClosed) return false;
  if (!gates.cohorts.accept(ticket)) return true;
  const error = c.error || v.error;
  state.cohortsErrorRaw = error ?? null;
  if (error) {
    state.cohortsError = explainError(error);
    if (state.cohortsStatus !== "ok") state.cohortsStatus = "error";
    state.fresh.cohorts.stale = true;
    return false;
  }
  state.cohorts = c.data ?? [];
  state.venues = v.data ?? [];
  state.cohortsStatus = "ok";
  state.cohortsError = "";
  state.fresh.cohorts = { at: Date.now(), stale: false };
  await loadCohortCloseStates();
  return true;
}

/** 読み込み中の数（更新のボタンを回す・続けて押せないようにする） */
let refreshing = 0;

function setReloadBusy() {
  for (const b of document.querySelectorAll("[data-reload]")) {
    b.classList.toggle("busy", refreshing > 0);
    b.setAttribute("aria-disabled", String(refreshing > 0));
  }
}

/** 名簿・回・会場（と、開いたことのある設定）を読み直して、画面を作り直す */
async function refresh() {
  refreshing++;
  setReloadBusy();
  try {
    await Promise.all([loadUsage(), loadCohorts(), loadStageInfo(), state.settings.status !== "idle" ? loadSettingsAll() : null]);
    if (state.cohortId) await loadCohortCloseStatus(state.cohortId);
  } finally {
    refreshing--;
    setReloadBusy();
  }
  renderAll();
}

/** 更新のボタン（ヘッダーの ⟳・設定の要約の ⟳・アカウントのシート）。読み込み中は重ねない */
function onReload() {
  if (refreshing > 0) return;
  clearNotice();
  refresh();
}

/**
 * その人の最新の行（今の枠）を読み直す。{ ok: false } は読み直しの失敗、row が無ければ名簿に無い。
 * 名簿の読み込みと同じ番人（gates.rows）を通し、券（ticket）を返す。受け取ってから当てるまでの間（呼び出し元の await）に、
 * より新しい名簿の応答が当たることがあるので、当てる側は当てる直前に gates.rows.current(ticket) を確かめる（Codex TASK-0093 R1・TASK-0095）
 */
async function freshRow(email) {
  const ticket = gates.rows.begin();
  const { data, error } = await supabase.rpc("admin_usage");
  gates.rows.accept(ticket);
  if (error) return { ok: false, ticket };
  return { ok: true, ticket, rows: data ?? [], row: (data ?? []).find((x) => x.email === email) ?? null };
}

// ---- 全体の描画 ----

function renderAll() {
  if (appClosed) return;
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
  renderHeader();
  if (sheet.open && sheetRender && sheetKind !== "setting") sheetRender();
}

/** タブごとに、画面に出している読み込みの部分（確認の時刻は、このうち最も古い成功の時刻） */
function tabParts(tab) {
  const S = state.settings;
  const F = state.fresh;
  const stages = stagesAvailable() || F.stages.stale ? [F.stages] : [];
  if (tab === "roster") return [F.rows];
  if (tab === "cohorts") return [F.cohorts, ...stages];
  // 消費の推移は、DB に 228 が無い（missing）間は数えない（読める時刻が来ないため）
  const trend = state.trend.status === "missing" ? [] : [{ at: state.trend.at, stale: !!state.trend.error }];
  return [
    { at: S.infoAt, stale: !!S.error },
    { at: S.modelsAt, stale: !!S.modelsError },
    { at: S.historyAt, stale: !!S.historyError },
    { at: S.storageAt, stale: !!S.storageError },
    ...trend,
    ...stages,
  ];
}

/** ヘッダーの「確認 13:42」（今のタブの部分の、最も古い成功）。どれかを読み直せていなければ印を添える */
function renderHeader() {
  const v = freshnessView(tabParts(state.tab));
  const node = $("checked-at");
  node.replaceChildren(
    ...[
      v.text ?? (v.failed ? "" : "読み込み中…"),
      v.stale || v.failed
        ? el("span", { className: "stale-mark" }, el("span", { "aria-hidden": "true", text: " ⚠" }), v.text ? "一部は前に読んだ値" : "読み込めていない部分があります")
        : null,
    ].filter(Boolean),
  );
}

/** 設定に、保存していない変更があるか（数値の編集・モデル・テンプレートの編集） */
function unsavedSettings() {
  const S = state.settings;
  const parts = [];
  if (editDirty(S.edit)) parts.push(`${settingLabel(S.edit.key, S.info?.settings)}の新しい値`);
  if (modelDraftCount() > 0) parts.push(`モデルの変更（${modelDraftCount()} 件）`);
  if (templateDirty?.()) parts.push("テンプレートの編集");
  return parts;
}

/** 設定のタブを離れる前：保存していない変更があれば、編集を続けるか捨てるかを選んでもらう。移ってよければ true */
async function confirmLeaveSettings() {
  const parts = unsavedSettings();
  if (!parts.length) return true;
  const ok = await ask({
    title: "保存していない変更を破棄しますか？",
    lines: [`${parts.join("・")}を、まだ保存していません。`, "破棄すると、設定は今のままです。"],
    buttons: [{ label: "編集を続ける", value: false }, { label: "破棄して移る", value: true, kind: "danger" }],
    cancelValue: false,
  });
  if (!ok) return false;
  discardSettingDrafts();
  return true;
}

async function switchTab(tab) {
  if (state.tab === tab) return true;
  if (state.settings.busy) {
    notify("設定の保存の結果を待っています。終わってから移ってください。");
    return false;
  }
  if (state.tab === "settings" && !(await confirmLeaveSettings())) return false;
  state.scroll[state.tab] = window.scrollY;
  state.tab = tab;
  if (tab !== "roster" && state.selecting) {
    state.selecting = false;
    state.selected.clear();
    state.selectCohortTarget = null;
  }
  renderAll();
  // 戻ったときは、前に見ていた位置へ（選択も state に残っている）
  window.scrollTo(0, state.scroll[tab] ?? 0);
  if (tab === "settings" && state.settings.status === "idle") loadSettingsAll();
  return true;
}

/** 設定の要約の［今日の利用を見る］：名簿の今日の概要へ */
async function goTodayUsage() {
  if (!(await switchTab("roster"))) return;
  window.scrollTo(0, 0);
  $("overview").setAttribute("tabindex", "-1");
  $("overview").focus({ preventScroll: true });
}

/** 名簿の概要の［直近 24 時間の利用と上限］：設定の要約へ */
async function goSettingsSummary() {
  if (!(await switchTab("settings"))) return;
  if (!(await switchSubtab("usage"))) return;
  window.scrollTo(0, 0);
  $("sum-h")?.focus({ preventScroll: true });
}

function renderFab() {
  const fab = $("fab");
  const roster = state.tab === "roster";
  fab.replaceChildren(icon("plus", 20, 2.4), roster ? "追加" : "回を作成");
  fab.hidden = (state.selecting && roster) || state.tab === "settings";
}

function ovItem({ label, value, unit, sub = null, subClass = "", sub2 = null, sub2Class = "", className = "", warn = false, onclick = null, title = null }) {
  return el(
    onclick ? "button" : "div",
    { type: onclick ? "button" : null, className: `ov-item ${warn ? "warn" : ""} ${className}`, onclick, title },
    el("span", { className: "ov-label", text: label }),
    el("span", { className: "ov-value num" }, String(value), el("span", { className: "unit", text: unit })),
    sub ? el("span", { className: `ov-sub num ${subClass}`, text: sub }) : null,
    sub2 ? el("span", { className: `ov-sub num ${sub2Class}`, text: sub2 }) : null,
  );
}

function renderOverview() {
  const box = $("overview");
  const line = $("overview-line");
  const link = $("overview-link");
  link.hidden = state.tab !== "roster";
  if (!link.firstChild) {
    link.append(el("button", { type: "button", className: "link-btn", text: "直近 24 時間の利用と上限を見る（設定）", onclick: goSettingsSummary }));
  }
  // 設定の画面は、直近 24 時間の利用を画面の中に出すので、概要は出さない
  box.hidden = state.tab === "settings";
  if (state.tab === "settings") {
    line.hidden = true;
    return;
  }
  box.classList.toggle("ov-4", state.tab === "roster");
  if (state.tab === "roster") {
    box.classList.remove("desk-only");
    line.hidden = true;
    const rows = state.rows;
    const ok = state.rowsStatus === "ok";
    const t = sumUsage(rows);
    // 今月の列が無い古い DB の応答は「—」（usageCellView が判定する）
    const month = usageCellView(t.month_count, t.month_cost_usd);
    const needs = rows.filter(needsAttention).length;
    box.replaceChildren(
      ovItem({
        label: "登録",
        value: ok ? rows.length : "—",
        unit: "人",
        sub: ok ? `有効 ${rows.filter((r) => r.status === "active").length} 人` : null,
        subClass: "desk-only",
      }),
      // スマホは 2 列 × 2 行（ov-4）で、今日・今月の生成と、クレジットの目安（sub）・見積額のドル（sub2）を見せる。PC は下の「消費（目安）」のカードにも出す
      ovItem({
        label: "今日の生成",
        value: ok ? t.today_count : "—",
        unit: "回",
        sub: ok ? approxCreditsText(t.today_cost_usd) : null,
        subClass: "mobile-only",
        sub2: ok ? `見積額 ${formatUsd(t.today_cost_usd)}` : null,
        sub2Class: "mobile-only",
        className: "ov-r",
      }),
      ovItem({
        label: "今月の生成",
        value: ok && month.has ? month.count : "—",
        unit: "回",
        sub: ok && month.has ? month.credits : null,
        subClass: "mobile-only",
        sub2: ok && month.has ? month.usd : null,
        sub2Class: "mobile-only",
        title: "今月は日本時間の 1 日 0 時から",
      }),
      ovItem({
        label: "今日の消費（目安）",
        value: ok ? formatCredits(creditsOf(t.today_cost_usd)) : "—",
        unit: "クレジット",
        sub: ok ? `見積額 ${formatUsd(t.today_cost_usd)}` : null,
        sub2: ok ? `24時間 約 ${formatCredits(creditsOf(t.day_cost_usd))}・累計 約 ${formatCredits(creditsOf(t.total_cost_usd))}` : null,
        className: "desk-only",
        title: `見積額：今日 ${formatUsd(t.today_cost_usd)}・24時間 ${formatUsd(t.day_cost_usd)}・累計 ${formatUsd(t.total_cost_usd)}`,
      }),
      ovItem({
        label: "今月の消費（目安）",
        value: ok && month.has ? formatCredits(creditsOf(t.month_cost_usd)) : "—",
        unit: "クレジット",
        sub: ok && month.has ? month.usd : null,
        sub2: ok && month.has ? "日本時間の 1 日 0 時から" : null,
        className: "desk-only",
        title: ok && month.has ? `見積額：今月 ${formatUsd(t.month_cost_usd)}（日本時間の 1 日 0 時から）` : "今月の集計はまだ使えません（DB の更新待ち）",
      }),
      ovItem({
        label: "要対応",
        value: ok ? needs : "—",
        unit: "人",
        sub: ok ? (needs ? "未設定・残り少" : "なし") : null,
        warn: ok && needs > 0,
        className: "ov-r",
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
  if (seq !== detailSeq || appClosed) return;
  state.detailLoading = false;
  if (!isDesktop() && sheetKind !== "member") return; // 読み込み中に閉じられた
  // 当てる直前に、この応答がまだ最新か確かめる。古ければ（より新しい名簿の応答が当たった）当てず、最新の名簿からその人を選び直す。
  // 古い成功で一覧・確認の時刻・前に読んだ値の印を戻さず、古い失敗で詳細を閉じない
  const current = gates.rows.current(fresh.ticket);
  const row = current ? fresh.row : (state.rows.find((x) => x.email === email) ?? null);
  if (!fresh.ok && current) {
    notify("最新の状態を読めませんでした。一覧を読み込み直してください。", "error");
    closeMember();
    return;
  }
  if (fresh.ok && current) applyRows(fresh.rows);
  if (row) await loadMemberFlag(email);
  if (seq !== detailSeq) return;
  if (!row) {
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
  // 値が無い（古い DB に今月の列が無い）ときは「—」（usageCellView）
  const stat = (label, count, cost) => {
    const v = usageCellView(count, cost);
    return el(
      "div",
      { className: "stat", title: v.usd },
      el("div", { className: "small muted", text: label }),
      el("div", { className: "stat-v num" }, v.count, v.has ? el("span", { className: "unit", text: " 回" }) : null),
      el("div", { className: "small muted num", text: v.credits }),
      el("div", { className: "small muted num", text: v.usd }),
    );
  };
  return el(
    "section",
    { className: "box" },
    el("h3", { text: "使用状況" }),
    el(
      "div",
      { className: "stats stats-2" },
      stat("今日", r.today_count, r.today_cost_usd),
      stat("24時間", r.day_count, r.day_cost_usd),
      stat("今月", r.month_count, r.month_cost_usd),
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
    el("p", { className: "hint", text: "「今日」は日本時間の 0 時から、「24時間」は直近 24 時間、「今月」は日本時間の 1 日 0 時から。見積額（ドル）は生成のときの見積もりで、クレジットは見積額からの目安です。" }),
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
  if (g.revoked && g.revokedNote) {
    text.append(el("span", { className: "small muted ellipsis", text: `取り消しのメモ：${g.revokedNote}`, title: g.revokedNote }));
  }
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
const STAGE_GRANT_COLUMNS = `${GRANT_COLUMNS}, stage_id, revoked_at, revoked_by_email, revoked_note, granted_as`;

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
    // 段階が 0 件の回は、問い合わせない（空の in は送らない）
    stageStudent && stagesOfCohort(r.cohort_id).length
      ? supabase.from("credit_grants").select(columns).eq("email", r.email).in("stage_id", stagesOfCohort(r.cohort_id).map((s) => s.id)).order("created_at", { ascending: false })
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
  const deleteBlock = memberDeleteBlock({ hasStageGrants: memberHasStageGrants(r.email) });
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
  // この回の段階に付いた追加だけ数える（ほかの回の追加は、この回の合計に入れない）
  const ids = stagesOfCohort(r.cohort_id).map((s) => s.id);
  if (!ids.length) return null;
  const { data, error } = await supabase.from("credit_grants").select("credits, stage_id").eq("email", r.email).in("stage_id", ids);
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
  const where = stageStudent ? "今の段階" : "今の枠";
  const stageLine = stageStudent ? "\nこの追加は、1 人あたりのこの回の追加の合計に数えます。取り消しても、合計からは減りません。" : "";
  if (!confirm(`${r.email} の${where}に ${formatCredits(credits)} クレジット（${formatYen(credits)}）を追加しますか？${stageLine}`)) return;
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
  else notify(`${r.email} への追加（+${formatCredits(g.credits)}）を取り消しました。${REVOKE_CONFIRM_LINES[1]}`);
  await refresh();
}

async function removeMember(r) {
  if (r.email === myEmail) {
    notify("自分自身は削除できません。", "error");
    return;
  }
  const block = memberDeleteBlock({ hasStageGrants: await loadMemberFlag(r.email) });
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
      // 通信の失敗では、追加が済んでいるかもしれない。「追加していません」とは言わず、読み直した名簿で確かめてもらう（U3-1）
      notify(isNetworkFailure(error) ? MSG_BULK_GRANT_NETWORK_FAILURE : `追加できませんでした（全員分とも追加していません）。${explainError(error)}`, "error");
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
  const single = el("div", { className: "stack" }, field("メールアドレス", email, "@a-i-ken.jp / @a-i-ken.com / @orenda.co.jp / @net-fun.co.jp のアカウント"), field("表示名（任意）", name));
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
  const monthlyInitial = monthly.value;
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
    // ボタンに区分と人数を出す（「受講者として 10 人を追加」。U3-2）
    submit.textContent = addSubmitLabel(r, isSingle ? 1 : parseBulk(bulkText.value).valid.length);
  };
  modeSeg.addEventListener("change", update);
  roles.addEventListener("change", update);
  bulkText.addEventListener("input", update);
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
    /** 入力を消して、最初の状態（1 人ずつ・受講者）に戻す。ログアウトのとき（clearAppView）に使う（U3-2） */
    reset() {
      email.value = "";
      name.value = "";
      bulkText.value = "";
      monthly.value = monthlyInitial;
      delete cohortSelect.dataset.touched;
      const single = modeSeg.querySelector('input[value="single"]');
      if (single) single.checked = true;
      this.setRole("student");
    },
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
  state.addUi = addUi;
  // 開くたびに区分を「受講者」に戻す。前に選んだ「管理者」が残ったまま、まとめて登録しない（U3-2）
  addUi.setRole(role ?? "student");
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

/** 登録済みは送信前に除く。BEFORE INSERT は ON CONFLICT より先に動くため、閉じた回の既存名簿も再挿入しない。 */
async function insertMembers(rows) {
  const identity = currentIdentity();
  const stale = () => appClosed || !cohortCloseSameIdentity(currentIdentity(), identity);
  const staleError = { message: "ログイン状態が変わりました。読み込み直してから追加してください。" };
  if (stale()) return { error: staleError };
  const existing = new Set();
  for (let i = 0; i < rows.length; i += 50) {
    const emails = rows.slice(i, i + 50).map((r) => r.email);
    const { data, error } = await supabase.from("members").select("email").in("email", emails);
    if (stale()) return { error: staleError };
    if (error) return { error };
    if (!Array.isArray(data) || data.some((r) => typeof r?.email !== "string" || !emails.includes(r.email))) {
      return { error: { message: "登録済みの名簿を確認できませんでした。読み込み直してから追加してください。" } };
    }
    for (const row of data) existing.add(row.email);
  }
  const pending = rows.filter((r) => !existing.has(r.email));
  const skippedEmails = rows.filter((r) => existing.has(r.email)).map((r) => r.email);
  if (!pending.length) return { added: 0, skippedEmails };
  const { data, error } = await supabase
    .from("members")
    .upsert(pending, { onConflict: "email", ignoreDuplicates: true })
    .select("email");
  if (error) return { error };
  return { added: data?.length ?? 0, skippedEmails };
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

/** 区分を管理者にして追加する前の確認（U3-2）。管理者のときだけ出す。続けるなら true（既定は［やめる］。確認のあいだにログアウトしたら false） */
async function confirmAddAsAdmin(role, emails) {
  if (role !== "admin") return true;
  const v = adminAddConfirmView(emails);
  const ok = await ask({
    title: v.title,
    lines: v.lines,
    detail: v.detail,
    buttons: [{ label: v.cancelLabel, value: false }, { label: v.okLabel, value: true, kind: "danger" }],
    cancelValue: false,
  });
  return ok === true && !appClosed;
}

async function addOne(role, extras) {
  const email = normalizeEmail(addUi.email.value);
  const problem = emailProblem(email);
  if (problem) {
    notify(`追加できません：${problem}`, "error");
    return;
  }
  const name = addUi.name.value.trim();
  if (!(await confirmAddAsAdmin(role, [email]))) return;
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
  if (!(await confirmAddAsAdmin(role, valid.map((v) => v.email)))) return;
  const result = await insertMembers(valid.map((v) => ({ ...v, role, ...extras })));
  if (result.error) {
    notify(explainError(result.error), "error", problems);
    return;
  }
  // 登録済みでスキップした人は誰かを、折りたたみ［詳しく］のメールで見せる（U3-12。その人は当日使えない）
  const skipped = valid.length - result.added;
  const { message, kind } = bulkAddResult({ added: result.added, skipped, duplicates, invalid: invalid.length });
  const skippedEmails = result.skippedEmails ?? [];
  notify(message, kind, problems, null, skippedEmails.length ? { label: "詳しく", items: skippedEmails } : null);
  if (!invalid.length) addUi.bulkText.value = "";
  await refresh();
}

// ---- 回 ----

let cohortCloseListSeq = 0;
let cohortCloseDetailSeq = 0;

/** 回一覧は一括の読取1回。未導入・失敗を「未クローズ」と推定しない。 */
async function loadCohortCloseStates() {
  const seq = ++cohortCloseListSeq;
  const identity = currentIdentity();
  let response;
  try {
    response = await supabase.rpc("admin_cohort_close_states");
  } catch (error) {
    response = { data: null, error };
  }
  if (appClosed || seq !== cohortCloseListSeq || !cohortCloseSameIdentity(currentIdentity(), identity)) return false;
  const { data, error } = response ?? {};
  const summaries = error ? null : normalizeCohortCloseSummaries(data);
  state.cohortCloseStates = summaries ?? new Map();
  state.cohortCloseListError = summaries ? "" : cohortCloseError(error ?? { message: "cohort_close_invalid_response" });
  return !!summaries;
}

/** 操作の詳細は対象回だけ。別回・古い読み直し・ログアウト後の応答を捨てる。 */
async function loadCohortCloseStatus(id) {
  const seq = ++cohortCloseDetailSeq;
  const identity = currentIdentity();
  let response;
  try {
    response = await supabase.rpc("cohort_close_status", { p_cohort_id: id });
  } catch (error) {
    response = { data: null, error };
  }
  if (appClosed || id !== state.cohortId || seq !== cohortCloseDetailSeq || !cohortCloseSameIdentity(currentIdentity(), identity)) return false;
  const { data, error } = response ?? {};
  const status = error ? null : normalizeCohortCloseStatus(data, id);
  state.cohortCloseStatuses.set(id, status);
  state.cohortCloseErrors.set(id, status ? "" : cohortCloseError(error ?? { message: "cohort_close_invalid_response" }));
  return !!status;
}

function cohortCloseBadge(id) {
  const summary = state.cohortCloseStates.get(id);
  return el("span", {
    className: `badge ${summary?.state === "closed" ? "stopped" : "default"}`, // 0179 の "off" は CSS に無い。停止の色（stopped）にそろえる
    text: summary ? summary.state === "closed" ? "クローズ済み" : "未クローズ" : "クローズ未確認",
  });
}

function cohortCloseBox(c) {
  const status = state.cohortCloseStatuses.get(c.id);
  const error = state.cohortCloseErrors.get(c.id);
  const kind = status?.state === "closed" ? "reopen" : "close";
  return el("section", { className: "box tight", "aria-label": "回のクローズ" },
    el("h3", { text: "回のクローズ" }),
    ...(error ? [error] : cohortCloseLines(status)).map((text) => el("p", { className: error ? "warn-text small" : "hint", text })),
    cohortCloseCanAct(status, kind) ? el("button", {
      type: "button", className: kind === "close" ? "btn danger" : "btn",
      text: kind === "close" ? "この回をクローズ" : "回を開き直す", disabled: state.cohortCloseBusy,
      onclick: () => changeAdminCohortClose(kind, c.id),
    }) : null,
    el("button", {
      type: "button", className: "link-btn", text: "クローズの状態を読み直す", disabled: state.cohortCloseBusy,
      onclick: async () => { await loadCohortCloseStatus(c.id); renderAll(); },
    }),
  );
}

const adminCohortCloseAction = createCohortCloseAction({
  rpc: (name, args) => supabase.rpc(name, args),
  canStart: () => !appClosed && !state.cohortCloseBusy,
  confirm: ({ title, lines, okText }) => ask({ title, lines, buttons: [
    { label: "やめる", value: false }, { label: okText, value: true, kind: "danger" },
  ], cancelValue: false, focusValue: false }),
  onBusy: (busy) => {
    state.cohortCloseBusy = busy;
    if (busy) { cohortCloseDetailSeq++; cohortCloseListSeq++; }
    renderAll();
  },
  onStatus: (status) => {
    cohortCloseListSeq++;
    state.cohortCloseStatuses.set(status.cohortId, status);
    state.cohortCloseErrors.set(status.cohortId, "");
    state.cohortCloseStates.set(status.cohortId, status);
  },
  onSuccess: async (_status, raw, kind, isCurrent) => {
    if (!isCurrent()) return;
    notify(raw.changed === false
      ? kind === "close" ? "この回はすでにクローズされています。" : "この回はすでに開き直されています。"
      : kind === "close" ? "回をクローズしました。最新の名簿と削除予定を確認してください。"
      : `回を開き直し、${raw.restored_count} 人を有効に戻しました。個別変更などで戻さなかった人は ${raw.skipped_count} 人です。`);
    await Promise.all([loadCohorts(), loadUsage()]);
    if (isCurrent()) await loadCohortCloseStatus(state.cohortId);
  },
  onError: async (message) => {
    notify(message, "error");
    await Promise.all([loadCohortCloseStates(), loadCohortCloseStatus(state.cohortId)]);
  },
});

function changeAdminCohortClose(kind, id) {
  const identity = currentIdentity();
  return adminCohortCloseAction.run(kind, id, () => !appClosed && id === state.cohortId && cohortCloseSameIdentity(currentIdentity(), identity));
}

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
  main.replaceChildren(...[
    state.cohortCloseListError ? warnBox(state.cohortCloseListError) : null,
    isDesktop() ? cohortTable() : cohortCards(), venuesSection(),
  ].filter(Boolean));
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
          el("span", { className: "card-top" }, el("span", { className: "cid num", text: c.id }), el("span", { className: "card-name" }), stageBadge(c.id), cohortStatusBadge(c.current_period), cohortCloseBadge(c.id)),
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
        el("span", { className: "cell" }, el("span", { className: "num strong", text: c.id }), cohortStatusBadge(c.current_period), stageBadge(c.id), cohortCloseBadge(c.id)),
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
  if (stagesAvailable()) await Promise.all([loadCohortFlags(id), isStageCohort(id) ? loadCohortStageStatus(id) : null]);
  await loadCohortCloseStatus(id);
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

// ---- 提出の「受け付けの終わり」（本体は admin-submissions.js。docs/design-submissions.md 6.3。入口はここだけ） ----
// 動的に読み込む：読み込めない・失敗しても、この画面の残り（admin.js 全体）は止めない。回を開くたびに読み、同じ回の描き直しでは読み直さない。
// 状態は state.deadlines（ログアウトで clearAppView が捨てる）。
const deadlinesHost = el("div", { id: "cohort-submissions" });
const loadAdminSubmissions = () => import("./admin-submissions.js");
async function loadDeadlines(cohortId) {
  const d = (state.deadlines ??= { view: null, cohortId: null });
  d.cohortId = cohortId;
  try {
    if (!d.view) {
      const mod = await loadAdminSubmissions();
      if (state.deadlines !== d) return; // 待っている間にログアウトした
      d.view ??= mod.createAdminDeadlines({
        container: deadlinesHost,
        rpc: async (name, args) => {
          try {
            return await supabase.rpc(name, args);
          } catch (error) {
            return { data: null, error };
          }
        },
        confirm: ({ title, lines, okText }) => ask({ title, lines, buttons: [{ label: "やめる", value: false }, { label: okText, value: true, kind: "primary" }], cancelValue: false }),
        notify: (message, kind) => notify(message, kind),
        explain: explainError,
      });
    }
    if (state.deadlines === d && d.cohortId === cohortId) await d.view.load(cohortId);
  } catch {
    if (state.deadlines !== d || d.cohortId !== cohortId) return;
    d.cohortId = null; // 次の描き直しで、もう一度読む
    deadlinesHost.replaceChildren(el("p", { className: "muted small", text: "提出の受け付けの設定を読み込めませんでした。" }));
  }
}
function submissionDeadlinesBox(c) {
  if (state.deadlines?.cohortId !== c.id) void loadDeadlines(c.id);
  return el("section", { className: "box", id: "cohort-submissions-box" }, el("h3", { className: "minor", text: "提出の受け付けの終わり" }), deadlinesHost);
}

function cohortHead(c, titleId) {
  return el(
    "div",
    { className: "detail-title" },
    el("h2", { id: titleId, className: "title-lg num cid", text: c.id }),
    el("span", { className: "sub", text: [c.name, `会場 ${c.venue_no} ${c.venue_name ?? ""}`].filter(Boolean).join(" · ") }),
    el("div", { className: "badges" }, cohortStatusBadge(c.current_period), stageBadge(c.id), cohortCloseBadge(c.id)),
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
    body: [schedule, cohortSumBox(c), cohortCloseBox(c), ...stageBoxes(c), cohortStudentsBox(c, 5), cohortAddButtons(c), ...cohortManage(c)],
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
  aside.replaceChildren(cohortHead(c, "aside-cohort-title"), cohortEditForm(c), cohortSumBox(c), cohortCloseBox(c), ...stageBoxes(c), cohortStudentsBox(c, 5), cohortAddButtons(c), ...cohortManage(c));
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
      text: `1 クレジット＝$0.01（約 ${yenPerCredit()} 円）。空欄のままだと、その期間は生成できません。${now ? "太枠は今の期間です。" : ""}`,
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
  await loadCohortFlags(c.id);
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

// ---- 設定（提案書 11 章。①直近 24 時間の要約 → ②上限と枠 → ③モデル → ④段階テンプレート → ⑤変更履歴） ----
// 上限と履歴は DB の RPC（014：admin_get_settings・admin_update_settings・admin_settings_history）、
// モデルの一覧は Edge Function admin-api の GET /models（カタログは TS にしか無いため）。保存はどちらも admin_update_settings。
// 呼び出し・保存する値・範囲・確認の条件は今までと同じ。この単位で変えたのは、並べ方・「読む → ［変更］で直す」・自前の確かめ・部分ごとの状態。
// 選んだ項目は、広い幅（1,100px 以上）は右の欄、狭い幅は下の帯「詳細を開く」からシート。編集の下書きは state に持ち、明示して捨てるまで残す。

const ADMIN_API_URL = adminApiUrl("");

async function loadSettingsInfo() {
  const S = state.settings;
  const ticket = gates.info.begin();
  const { data, error } = await supabase.rpc("admin_get_settings");
  if (appClosed) return false;
  // 保存より前に出した読み込み・より新しい読み込みに追い越された応答は捨てる（保存のあとの値を古い値に戻さない。Codex TASK-0092 F2）
  if (!gates.info.accept(ticket)) return true;
  if (error) {
    S.error = explainError(error);
    if (S.status !== "ok") S.status = "error";
    return false;
  }
  S.info = data;
  // 円の目安のドル円（227。無い・読めない値なら 150 に戻す）。出ている円の目安も書き直す
  applyFxRate(data?.fx_usd_jpy);
  S.status = "ok";
  S.error = "";
  S.infoAt = Date.now();
  return true;
}

async function loadSettingsHistory() {
  const S = state.settings;
  const ticket = gates.history.begin();
  const { data, error } = await supabase.rpc("admin_settings_history", { p_limit: 50 });
  if (appClosed) return false;
  if (!gates.history.accept(ticket)) return true;
  if (error) {
    S.historyError = explainError(error);
    if (S.historyStatus !== "ok") S.historyStatus = "error";
    return false;
  }
  S.history = data ?? [];
  S.historyStatus = "ok";
  S.historyError = "";
  S.historyAt = Date.now();
  return true;
}

/** モデルの一覧（admin-api。管理者本人のログインのトークンで呼ぶ）。resetDraft なら未保存のオン・オフを捨てる */
async function loadModels({ resetDraft = false } = {}) {
  const S = state.settings;
  const ticket = gates.models.begin();
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
  if (appClosed) return false;
  if (!gates.models.accept(ticket)) return true;
  if (status !== 200 || !Array.isArray(body?.models)) {
    S.modelsError = status === 200 ? "モデルの一覧の形が正しくありません。" : explainApiError(status, body);
    if (S.modelsStatus !== "ok") S.modelsStatus = "error";
    return false;
  }
  // 明示が要る行（口パクなど）のオン・オフは、保存されている一覧だけから決め直す（admin-api の版に依らず同じ見え方にする）
  body = normalizeOptInModes(body);
  const prev = S.models;
  // 保存しないまま読み直した（1 回の上限の保存・「最新にする」など）とき、「制限なしに戻す」の印は、その区分の一覧が変わっていなければ残す。変わっていれば消して、下書きも基準に戻す
  const carry = resetCarry(prev, body, resetDraft ? {} : S.resetNull);
  const prevDrafts = S.drafts;
  // 区分ごとの未保存の変更の数（読み込み前の基準との差）
  const pendingBy = {};
  for (const sc of MODEL_SCOPES) {
    pendingBy[sc.key] = !resetDraft && prev && prevDrafts && !carry.keep.includes(sc.key) && !carry.lost.includes(sc.key) ? modelChanges(prev.models, scopeSelection(prev.models, sc.key), prevDrafts[sc.key]).count : 0;
  }
  const next = Object.fromEntries(MODEL_SCOPES.map((sc) => [sc.key, scopeSelection(body.models, sc.key)]));
  // ほかの管理者が変えた区分（基準の一覧が変わった）で、未保存の変更があるもの
  const conflicts = MODEL_SCOPES.filter((sc) => pendingBy[sc.key] > 0 && !sameIdSet(scopeList(prev, sc.key), scopeList(body, sc.key)));
  let keep = true;
  if (conflicts.length) {
    // 基準だけが黙って新しくならないよう、乗せ直すか捨てるかを選ばせる。Esc・背景は「乗せ直す」（下書きを捨てない側。保存はまだしない）
    const n = conflicts.reduce((sum, sc) => sum + pendingBy[sc.key], 0);
    keep = await ask({
      title: "未保存のモデルの変更を、新しい設定に乗せ直しますか？",
      lines: [
        `読み込み直したところ、ほかの管理者がモデルの設定（${conflicts.map((sc) => sc.label).join("・")}）を変えていました。`,
        `あなたの未保存の変更は ${n} 件です。乗せ直すと、あなたが変えたところだけを新しい設定に当てます（保存はまだしません）。`,
      ],
      buttons: [
        { label: "破棄して新しい設定を表示", value: false, kind: "danger" },
        { label: "新しい設定に乗せ直す", value: true, kind: "primary" },
      ],
      cancelValue: true,
    });
    if (appClosed) return false;
    // 確かめているあいだに、保存や新しい読み込みで古くなった応答は当てない
    if (!gates.models.current(ticket)) return true;
  }
  S.models = body;
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
  S.modelsAt = Date.now();
  return true;
}

/** Storage の使用量は読取専用の集計。設定やモデルを読めなくても、この部分だけ再試行できる。 */
async function loadStorageUsage() {
  const S = state.settings;
  const ticket = gates.storage.begin();
  let status = 0;
  let body = null;
  try {
    const { data } = await supabase.auth.getSession();
    const res = await fetch(`${ADMIN_API_URL}/storage-usage`, {
      headers: { Authorization: `Bearer ${data?.session?.access_token ?? ""}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  if (appClosed) return false;
  if (!gates.storage.accept(ticket)) return true;
  const view = status === 200 ? storageUsageView(body) : null;
  if (!view) {
    const knownError = [0, 401, 403, 404, 503].includes(status);
    S.storageError = status === 200 ? "Storage の集計の形が正しくありません。" : knownError ? explainApiError(status, body) : `Storage の使用量を読み込めませんでした（HTTP ${status}）。`;
    if (S.storageStatus !== "ok") S.storageStatus = "error";
    return false;
  }
  S.storage = body;
  S.storageStatus = "ok";
  S.storageError = "";
  S.storageAt = Date.now();
  return true;
}

/**
 * 設定の画面の各部分を読み直す。前に読めていた部分の読み直しに失敗したら知らせる（画面は前の値のまま。その部分に「前に読んだ値」と再試行を出す）。
 * 返り値：部分ごとに読めたか
 */
async function loadSettingsAll(options = {}) {
  const S = state.settings;
  for (const k of ["status", "historyStatus", "modelsStatus", "storageStatus"]) if (S[k] === "idle") S[k] = "loading";
  if (state.trend.status === "idle") state.trend.status = "loading";
  renderSettings();
  // 消費の推移（228）は待たない（集計が遅くても、上限と枠・保存のあとの読み直し〔S.busy の解除〕を止めない）。届いたら、その面だけ描き直す
  reloadTrendInBackground();
  const [info, history, models, storage] = await Promise.all([loadSettingsInfo(), loadSettingsHistory(), loadModels(options), loadStorageUsage()]);
  if (appClosed) return { info: false, history: false, models: false, storage: false };
  const stale = [];
  if (!info && S.status === "ok") stale.push(`上限と枠：${S.error}`);
  if (!history && S.historyStatus === "ok") stale.push(`履歴：${S.historyError}`);
  if (!models && S.modelsStatus === "ok") stale.push(`モデル：${S.modelsError}`);
  if (!storage && S.storageStatus === "ok") stale.push(`Storage：${S.storageError}`);
  if (stale.length) notify("設定の一部を読み直せませんでした（前に読んだ値を出しています）。", "error", stale);
  renderSettings();
  renderHeader();
  return { info, history, models, storage };
}

/** その部分だけを読み直す（部分の失敗の［再試行］） */
function retryPart(load) {
  return async (e) => {
    if (e?.currentTarget) e.currentTarget.disabled = true;
    await load();
    if (appClosed) return;
    renderSettings();
    renderHeader();
  };
}
const retryInfo = retryPart(loadSettingsInfo);
const retryModels = retryPart(() => loadModels());
const retryHistory = retryPart(loadSettingsHistory);
const retryStorage = retryPart(loadStorageUsage);
const retryStages = retryPart(async () => {
  await loadStageInfo();
  renderAll();
});

// ---- 設定：描画 ----

const settingsRow = () => state.settings.info?.settings ?? {};
const currentOf = (key) => settingsRow()[key] ?? null;
const labelOf = (key) => settingLabel(key, state.settings.info?.settings);

/** 選んだ項目の行のフォーカスの鍵（閉じたあとに戻る入口） */
function selFocusKey(sel) {
  if (!sel) return null;
  return sel.kind === "limit" ? `sel:${sel.key}` : `tpl:${sel.id}`;
}

function selName(sel) {
  if (!sel) return "";
  if (sel.kind === "limit") return labelOf(sel.key);
  return state.stages.templates.find((t) => t.id === sel.id)?.name ?? "テンプレート";
}

/** 描き直しの前後で、フォーカスとカーソルの位置を保つ（data-focus-key の付いた部品） */
function keepFocus(hosts, fn) {
  const a = document.activeElement;
  const inside = !!a && hosts.some((h) => h && h.contains(a));
  const key = inside ? a.dataset?.focusKey : null;
  const caret = inside && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  if (!key || (a.isConnected && document.activeElement === a)) return;
  for (const h of hosts) {
    if (h && focusKey(key, h)) {
      const n = document.activeElement;
      if (caret && typeof n.setSelectionRange === "function") {
        try {
          n.setSelectionRange(...caret);
        } catch {
          // 数値以外の入力欄では位置を戻せないことがある
        }
      }
      return;
    }
  }
}

/** 選んでいた項目が無くなった（列の無いサーバー・削除されたテンプレート）なら、選択と編集を外す */
function pruneSelection() {
  const S = state.settings;
  const sel = S.sel;
  if (!sel) return;
  if (subtabOfSelection(sel) !== S.sub) {
    S.sel = null;
    if (S.edit && !S.edit.saving) S.edit = null;
    return;
  }
  if (sel.kind === "limit" && S.status === "ok" && !availableLimits(settingsRow()).some((l) => l.key === sel.key)) {
    S.sel = null;
    S.edit = null;
  } else if (sel.kind === "template" && state.stages.loaded && !state.stages.templates.some((t) => t.id === sel.id)) {
    S.sel = null;
    notify("選んでいたテンプレートは見つかりません（削除された可能性があります）。", "warn");
  }
}

function renderSettings() {
  if (appClosed) return;
  pruneSelection();
  if (state.tab !== "settings") {
    $("settings-aside").hidden = true;
    renderSettingsBar();
    hideTrendTip();
    return;
  }
  keepFocus([$("view-settings"), $("settings-bar"), sheetKind === "setting" ? sheet : null], () => {
    const sub = state.settings.sub;
    renderSubtabs();
    // 押した小さなタブの中身だけを作る（ほかは空にして隠す）
    $("settings-summary").hidden = sub !== "usage";
    $("settings-summary").replaceChildren(...(sub === "usage" ? summaryContent().filter(Boolean) : []));
    renderTrend();
    $("settings-main").replaceChildren(...(sub === "usage" ? [limitsSection()] : []));
    $("settings-storage").replaceChildren(...(sub === "usage" ? [storageSection()] : []));
    $("settings-models").replaceChildren(...(sub === "models" ? [modelsSection()] : []));
    $("settings-templates").replaceChildren(
      ...(sub !== "templates"
        ? []
        : stagesAvailable() || state.fresh.stages.stale
        ? [templatesSection()]
        : [el("section", { className: "box" }, el("h3", { text: "段階テンプレート" }), el("p", { className: "muted", text: state.stages.loaded ? "段階テンプレートは、DB の更新（016）のあとで使えます。" : "読み込み中…" }))]),
    );
    $("settings-history").replaceChildren(...(sub === "history" ? [historySection()] : []));
    renderSettingsAside();
    renderSettingsBar();
    if (sheet.open && sheetKind === "setting" && sheetRender) sheetRender();
  });
  setReloadBusy();
}

/** 小さなタブ（role=tab。選んでいるものだけ Tab で入れる。矢印キー・Home・End で移る） */
function renderSubtabs() {
  const sub = state.settings.sub;
  for (const t of SETTINGS_SUBTABS) {
    const b = $(`subtab-${t.key}`);
    const on = t.key === sub;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    b.disabled = false;
  }
  $("settings-panel").setAttribute("aria-labelledby", `subtab-${sub}`);
}

/**
 * 小さなタブを移る。保存していない入力・モデルの変更があれば、タブを移るときと同じ確認を出す。
 * 右の欄・シートで開いている詳細は閉じる（選択と編集を外す）。移れたら true
 */
async function switchSubtab(key, { focusTab = false } = {}) {
  const S = state.settings;
  const to = normalizeSubtab(key);
  if (S.sub === to) {
    if (focusTab) $(`subtab-${to}`)?.focus();
    return true;
  }
  if (S.busy) {
    notify("設定の保存の結果を待っています。終わってから移ってください。");
    return false;
  }
  if (!(await confirmLeaveSettings())) return false;
  // 開いていた詳細は閉じる（保存していない入力は、上の確認で破棄を選んだか、もともと無い）
  S.edit = null;
  S.sel = null;
  // 設定のシート（項目の詳細と、テンプレートの編集）は閉じる。テンプレートの入力は上の確認で破棄を選んだか、もともと無い。
  // 保存のお知らせはシートの中へ移るので、テンプレートの編集の中から［変更履歴を見る］を押したときもここへ来る（Codex TASK-0104 F104-01）。
  // 閉じたときの後始末（templateDirty など）は、シートの close の処理が行う
  if (sheet.open && (sheetKind === "setting" || sheetKind === "template-editor")) closeSheet();
  S.sub = to;
  if (to === "history") S.historyOpen = true;
  writeSubtab(to);
  renderSettings();
  window.scrollTo(0, 0);
  if (focusTab) $(`subtab-${to}`)?.focus();
  return true;
}

/** 見出しつきの面。読み込み中・失敗（一度も読めていない）は中身の代わりに状態を、前に読んだ値なら上に印と再試行を出す */
function partBox({ id, title, status, error, at, retry, side = null, content }) {
  let body;
  if (status === "ok") body = [error ? staleLine(error, at, retry) : null, ...content()];
  else if (status === "error") body = [errorBox(error, retry)];
  else body = [el("p", { className: "muted", text: "読み込み中…" })];
  return el(
    "section",
    { className: "box", "aria-labelledby": id },
    el("div", { className: "box-head" }, el("h3", { id, text: title }), status === "ok" && side ? el("div", { className: "head-side" }, side) : null),
    ...body,
  );
}

/** 前に読んだ値を出しているときの印（全体を最新に見せない）。その部分だけの再試行 */
function staleLine(error, at, retry) {
  return el(
    "div",
    { className: "stale-line", role: "status" },
    el("p", {}, el("span", { "aria-hidden": "true", text: "⚠ " }), `前に読んだ値です（${checkedText(at) ?? "確認の時刻なし"}）。最新を読めませんでした：${error}`),
    el("button", { type: "button", className: "btn", text: "再試行", onclick: retry }),
  );
}

function warnLine(text) {
  return el("p", { className: "warn-line" }, el("span", { "aria-hidden": "true", text: "⚠" }), el("span", { text }));
}

/** ① 直近 24 時間の利用の要約（全員の合計の見積額・上限・割合・回数・注意・内訳）。費用はドル */
function summaryContent() {
  const S = state.settings;
  const head = el(
    "div",
    { className: "box-head" },
    el("h3", { id: "sum-h", tabindex: "-1", text: "直近 24 時間の利用" }),
    el(
      "div",
      { className: "head-side" },
      S.infoAt ? el("span", { className: "checked num", text: checkedText(S.infoAt) }) : null,
      // 狭い幅はヘッダーに更新のボタンが無いので、ここに置く
      el("button", {
        type: "button",
        className: "icon-btn mobile-only",
        "data-reload": "",
        "aria-label": "最新の状態を読み込む",
        "data-tip": "最新にする",
        "data-focus-key": "sum-reload",
        onclick: onReload,
      }, icon("refresh", 18)),
    ),
  );
  if (S.status === "error") return [head, errorBox(S.error, retryInfo)];
  if (S.status !== "ok") return [head, el("p", { className: "muted", text: "読み込み中…" })];
  const u = usageSummaryView(S.info);
  const hasGlobal = availableLimits(settingsRow()).some((l) => l.key === "global_daily_cost_limit_usd");
  return [
    head,
    S.error ? staleLine(S.error, S.infoAt, retryInfo) : null,
    el(
      "div",
      { className: "sum-figures" },
      el("span", { className: `sum-cost num ${u.low ? "low" : ""}`, text: u.costText }),
      el("span", { className: "sum-limit num", text: u.limitText }),
    ),
    u.pct !== null ? bar(u.pct, u.low, "thick") : null,
    el(
      "p",
      { className: "sum-sub num" },
      el("span", { text: "全員の合計の見積額（ドル）" }),
      u.pctText ? el("span", { text: u.pctText }) : null,
      el("span", { text: u.countText }),
    ),
    u.warn ? warnLine(u.warn) : null,
    breakdownFold(),
    el(
      "div",
      { className: "sum-actions" },
      el("button", { type: "button", className: "link-btn", text: "今日の利用を見る（名簿）", "data-focus-key": "sum-today", onclick: goTodayUsage }),
      hasGlobal
        ? el("button", {
          type: "button",
          className: "link-btn",
          text: "全体の上限を変更",
          "data-focus-key": "sum-limit",
          onclick: () => startEdit("global_daily_cost_limit_usd"),
        })
        : null,
    ),
  ];
}

/** 要約の［内訳］：回数の多い利用者（上位 5 人。回数順のまま）。名簿にいる人は、押すと名簿の詳細へ */
function breakdownFold() {
  const S = state.settings;
  const top = Array.isArray(S.info?.top_users) ? S.info.top_users : [];
  const list = top.length
    ? el(
      "ol",
      { className: "top-users", "aria-label": "回数の多い利用者" },
      ...top.map((t, i) => {
        const r = state.rows.find((x) => x.email === t.email);
        const named = r?.display_name?.trim();
        const name = named ? r.display_name : (t.email ?? "（不明）");
        const who = el(
          "span",
          { className: "who" },
          el("span", { className: "strong ellipsis", text: name }),
          named ? el("span", { className: "small muted ellipsis", text: t.email }) : null,
        );
        return el(
          "li",
          {},
          el("span", { className: "rank num", text: `${i + 1}` }),
          r
            ? el("button", { type: "button", className: "who-btn", "aria-label": `${name}（${t.email}）の名簿の詳細を開く`, onclick: () => openMemberFromSettings(t.email) }, who)
            : who,
          el("span", { className: "val num", text: `${formatCredits(t.count)} 回 · ${formatUsdShort(Number(t.cost_usd ?? 0).toFixed(2))}` }),
        );
      }),
    )
    : el("p", { className: "muted", text: "直近 24 時間の生成はありません。" });
  const d = el(
    "details",
    { className: "plain-fold minor", open: S.breakdownOpen },
    el("summary", { "data-focus-key": "sum-breakdown" }, "内訳：回数の多い利用者（上位 5 人）"),
    el("div", { className: "fold-in" }, list),
  );
  d.addEventListener("toggle", () => {
    S.breakdownOpen = d.open;
  });
  return d;
}

async function openMemberFromSettings(email) {
  if (!(await switchTab("roster"))) return;
  openMember(email);
}

// ---- 設定：消費の推移（228：admin_usage_trend。［利用と上限］の 2 つ目の面） ----
// 単位はクレジット（1 クレジット＝$0.01。枠の消費と同じ数え方）。今月（日ごと）と直近 12 か月（月ごと）を、モデル・区分・回・種類で
// 色分けした積み上げの棒で出す。SVG はここで描く（外のライブラリは CSP で読めない）。文字はすべて textContent。
// 色は admin.html の --series-1〜8（明暗）と --series-other（その他）。どの項目に色を付けるかは admin-lib.js の trendSeriesPlan。
// 値は棒のホバー・タップ（キーボードは左右の矢印）と、下の「表で見る」で読める（ホバーだけにしない）。

async function loadTrend() {
  const T = state.trend;
  if (appClosed) return false;
  const ticket = gates.trend.begin();
  const { data, error } = await supabase.rpc("admin_usage_trend");
  if (appClosed) return false;
  if (!gates.trend.accept(ticket)) return true;
  if (error && isMissingSchemaError(error)) {
    // DB に 228 がまだ無い：欄に「DB の更新待ち」を出す（失敗の印は出さない）
    T.status = "missing";
    T.error = "";
    return true;
  }
  if (error || !trendDataOk(data)) {
    T.error = error ? explainError(error) : "消費の推移の形が正しくありません。";
    if (T.status !== "ok") T.status = "error";
    return false;
  }
  T.data = data;
  T.status = "ok";
  T.error = "";
  T.at = Date.now();
  return true;
}
const retryTrend = retryPart(loadTrend);

/** 推移を裏で読み直す（設定の読み込みから。待たない）。前に読めていた値の読み直しに失敗したら知らせる */
function reloadTrendInBackground() {
  loadTrend().then((ok) => {
    if (appClosed) return;
    if (!ok && state.trend.status === "ok") notify("消費の推移を読み直せませんでした（前に読んだ値を出しています）。", "error", [state.trend.error]);
    renderTrend();
    renderHeader();
  });
}

/** 今の切り口の系列（モデルの名前と並びは、読み込んだモデルの一覧から。まだ無ければ key のまま） */
function trendPlanNow() {
  const T = state.trend;
  const models = Array.isArray(state.settings.models?.models) ? state.settings.models.models : [];
  const labels = new Map(models.map((m) => [String(m.key), String(m.label ?? m.key)]));
  return trendSeriesPlan(T.data, T.dim, { modelOrder: models.map((m) => String(m.key)), modelLabel: (k) => labels.get(k) ?? k });
}

const serClass = (slot) => (slot ? `ser-${slot}` : "ser-other");

/** 消費の推移の面を描く（［利用と上限］のときだけ）。読み込み・切り替え・モデルの名前・円の目安が変わったときだけ作り直す */
function renderTrend() {
  const host = $("settings-trend");
  const T = state.trend;
  const show = state.tab === "settings" && state.settings.sub === "usage";
  host.hidden = !show;
  if (!show) {
    hideTrendTip();
    return;
  }
  const sig = [T.status, T.error, T.at, T.range, T.dim, state.settings.modelsAt, state.settings.infoAt].join("|");
  if (sig === T.sig && host.firstChild) {
    // 描き直さないときも、狭い幅はグラフの下の内訳を出しておく（ほかのタブ・小さなタブから戻ったとき）
    if (T.geo?.narrow) showTrendTip(T.active ?? defaultTrendIndex(), T.activeKey);
    return;
  }
  T.sig = sig;
  keepFocus([host], () => {
    T.view = null;
    T.geo = null;
    T.active = null;
    T.activeKey = null;
    host.replaceChildren(...trendContent().filter(Boolean));
    drawTrendPlot();
  });
}

function trendContent() {
  const T = state.trend;
  const head = el(
    "div",
    { className: "box-head" },
    el("h3", { id: "trend-h", text: "消費の推移" }),
    T.at ? el("div", { className: "head-side" }, el("span", { className: "checked num", text: checkedText(T.at) })) : null,
  );
  if (T.status === "missing") return [head, el("p", { className: "muted", text: "消費の推移は、DB の更新（228）のあとで使えます。" })];
  if (T.status === "error") return [head, errorBox(T.error, retryTrend)];
  if (T.status !== "ok") return [head, el("p", { className: "muted", text: "読み込み中…" })];
  const plan = trendPlanNow();
  const view = trendView(T.data, T.range, plan);
  T.view = view;
  const has = view.total.jobs > 0;
  return [
    head,
    T.error ? staleLine(T.error, T.at, retryTrend) : null,
    trendControls(),
    el(
      "div",
      { className: "trend-figure" },
      el(
        "p",
        { className: "trend-hero" },
        el("span", { className: "trend-hero-n", text: formatCredits(view.total.credits) }),
        el("span", { className: "trend-hero-u", text: "クレジット" }),
      ),
      el(
        "p",
        { className: "trend-sub num" },
        view.periodText ? el("span", { text: `${view.periodText}（日本時間）` }) : null,
        el("span", { text: `生成 ${formatCredits(view.total.jobs)} 回` }),
        el("span", { text: formatYen(view.total.credits) }),
      ),
    ),
    T.dim === "role" || T.dim === "cohort"
      ? el("p", {
        className: "trend-approx",
        text: `${T.dim === "role" ? "区分" : "回"}は、今の名簿の値で分けた近似です（生成した時点の区分・回は記録していません）。` +
          (T.dim === "role"
            ? "途中で区分を変えた人の生成は今の区分に入り、名簿から消えた人の生成は「名簿にない人」に入ります。"
            : "途中で回を変えた受講者の生成は今の回に入ります。回は受講者にだけ付くので、メンバー・講師・管理者・名簿から消えた人の生成は" +
              "「受講者以外」、回に入っていない受講者の生成は「回なし」に入ります。"),
      })
      : null,
    has ? trendLegend(view) : null,
    has
      ? el(
        "div",
        { className: "trend-plot", id: "trend-plot" },
        el("div", { className: "trend-tip", id: "trend-tip", "aria-hidden": "true", hidden: true }),
      )
      : el("p", { className: "trend-empty", text: T.range === "month" ? "今月の生成はまだありません。" : "直近 12 か月の生成はありません。" }),
    has ? el("p", { className: "sr-only", id: "trend-live", "aria-live": "polite" }) : null,
    has ? trendTable(view) : null,
    trendNotes(plan),
  ];
}

/** 期間と切り口の切り替え（ラジオ。矢印キーで移れる）。切り替えても読み直さない（1 回の応答に両方の期間がある） */
function trendControls() {
  const T = state.trend;
  const group = (name, label, items, value, pick) =>
    el(
      "div",
      { className: "seg trend-switch", role: "radiogroup", "aria-label": label },
      ...items.map((it) =>
        el(
          "label",
          {},
          el("input", {
            type: "radio",
            name,
            value: it.key,
            checked: it.key === value,
            "data-focus-key": `${name}:${it.key}`,
            onchange: () => pick(it.key),
          }),
          it.label,
        )
      ),
    );
  return el(
    "div",
    { className: "trend-controls" },
    group("trend-range", "期間", TREND_RANGES, T.range, (k) => {
      T.range = normalizeTrendRange(k);
      renderTrend();
    }),
    group("trend-dim", "色分けの切り口", TREND_DIMS, T.dim, (k) => {
      T.dim = normalizeTrendDim(k);
      renderTrend();
    }),
  );
}

/** 凡例（四角は棒の色。文字は文字の色）。期間の合計のクレジットつき */
function trendLegend(view) {
  return el(
    "ul",
    { className: "trend-legend", "aria-label": "色の凡例（期間の合計クレジット）" },
    ...view.series.map((s) =>
      el(
        "li",
        {},
        el("span", { className: `trend-swatch ${serClass(s.slot)}`, "aria-hidden": "true" }),
        el("span", { className: "trend-legend-name", text: s.label }),
        el("span", { className: "trend-legend-val num", text: formatCredits(s.credits) }),
      )
    ),
  );
}

/** 表で見る：日（月）ごとの合計と系列ごとのクレジット・回数。今月はまだ来ていない日を出さない */
function trendTable(view) {
  const T = state.trend;
  const cell = (v) =>
    v && (v.credits || v.jobs)
      ? el(
        "td",
        { className: "num" },
        el("span", { className: "trend-td-c", text: formatCredits(v.credits) }),
        el("span", { className: "trend-td-j", text: `${formatCredits(v.jobs)} 回` }),
      )
      : el("td", { className: "num trend-td-none", text: "—" });
  const table = el(
    "table",
    { className: "trend-table" },
    el("caption", { className: "sr-only", text: `${view.periodText}の消費（クレジットと生成の回数）` }),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col", text: view.range === "month" ? "日" : "月" }),
        el("th", { scope: "col", text: "合計" }),
        ...view.series.map((s) =>
          el("th", { scope: "col" }, el("span", { className: `trend-swatch ${serClass(s.slot)}`, "aria-hidden": "true" }), el("span", { text: s.label }))
        ),
      ),
    ),
    el(
      "tbody",
      {},
      ...view.buckets.filter((b) => !b.future).map((b) =>
        el("tr", {}, el("th", { scope: "row", text: b.title }), cell(b.total), ...view.series.map((s) => cell(b.values.get(s.key))))
      ),
    ),
    el("tfoot", {}, el("tr", {}, el("th", { scope: "row", text: "合計" }), cell(view.total), ...view.series.map((s) => cell(s)))),
  );
  // その他にまとめた項目ごとの、期間の合計（F194-01。色の付く項目は上の表の列で読める）
  const other = view.series.find((s) => !s.slot);
  const parts = other && view.otherParts.length
    ? el(
      "table",
      { className: "trend-table trend-parts" },
      el("caption", { className: "trend-parts-cap", text: `「${other.label}」の内訳（${view.periodText}の合計）` }),
      el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "項目" }), el("th", { scope: "col", text: "クレジット" }), el("th", { scope: "col", text: "回数" }))),
      el(
        "tbody",
        {},
        ...view.otherParts.map((p) =>
          el(
            "tr",
            {},
            el("th", { scope: "row", text: p.label }),
            el("td", { className: "num", text: formatCredits(p.credits) }),
            el("td", { className: "num", text: `${formatCredits(p.jobs)} 回` }),
          )
        ),
      ),
    )
    : null;
  const d = el(
    "details",
    { className: "plain-fold minor trend-fold", open: T.tableOpen },
    el("summary", { "data-focus-key": "trend-table" }, "表で見る（クレジットと回数）"),
    el("div", { className: "table-scroll" }, table),
    parts ? el("div", { className: "table-scroll" }, parts) : null,
  );
  d.addEventListener("toggle", () => {
    T.tableOpen = d.open;
  });
  return d;
}

function trendNotes(plan) {
  const T = state.trend;
  return el(
    "div",
    { className: "trend-notes" },
    el("p", {
      className: "hint",
      text: "クレジットは、生成ごとの見積額から数えた消費です（1 クレジット＝$0.01。上限の枠と同じ数え方）。" +
        "投入できなかった生成と、提供元が失敗を返した生成（返金）は数えません。" +
        "名簿の「今月の消費（目安）」は失敗した生成も含む見積額なので、ここより大きくなることがあります。日付は日本時間です。",
    }),
    T.dim === "kind" ? el("p", { className: "hint", text: "「動画」には口パク（リップシンク）を含みます。" }) : null,
    plan.folded && T.dim === "model"
      ? el("p", { className: "hint", text: `色は直近 12 か月で多く使った 7 つのモデルに付け、残りの ${plan.folded} つは「その他のモデル」にまとめています。` })
      : null,
    plan.folded && T.dim === "cohort"
      ? el("p", { className: "hint", text: `色は新しい回と「受講者以外」に付け、それより前の ${plan.folded} つの回は「回なし・それより前の回」にまとめています。` })
      : null,
  );
}

function svgNode(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  return n;
}

/** 上だけ角を丸めた棒の形（r が 0 なら角のない四角） */
function topRoundedPath(x, y, w, h, r) {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** 棒グラフを、入れ物の今の幅で描く（幅が変われば描き直す。ResizeObserver） */
function drawTrendPlot() {
  const T = state.trend;
  const plot = $("trend-plot");
  const view = T.view;
  if (!plot || !view) return;
  const width = Math.floor(plot.clientWidth);
  if (width <= 0) return;
  const narrow = width < 520;
  const ticks = trendTicks(view.max);
  const top = ticks[ticks.length - 1];
  const tickText = ticks.map(formatAxisCredits);
  const x0 = Math.ceil(Math.max(...tickText.map((t) => t.length)) * 7 + 10);
  const x1 = width - 2;
  const padT = 10;
  const plotH = narrow ? 170 : 210;
  const xBand = view.range === "year" ? 38 : 22;
  const height = padT + plotH + xBand;
  const n = view.buckets.length;
  const slotW = (x1 - x0) / n;
  // 棒は 24px まで・枠いっぱいにしない（間を空ける）。積み上げの段の間は 2px の背景の色の隙間（線で囲まない）
  const barW = Math.max(2, Math.min(24, slotW * 0.62));
  const GAP = 2;
  const yOf = (v) => padT + plotH - (v / top) * plotH;
  const rangeText = view.range === "month" ? "今月の日ごと" : "直近 12 か月の月ごと";
  const root = svgNode("svg", {
    class: "trend-svg",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    tabindex: "0",
    "data-focus-key": "trend-plot",
    "aria-label": `${rangeText}の消費の積み上げ棒グラフ。合計 ${formatCredits(view.total.credits)} クレジット。` +
      "左右の矢印キーで棒を選ぶと内訳を読み上げます。数は下の「表で見る」にもあります。",
  });
  // 目盛りの線（1px・実線・控えめ）と数（文字の色）
  ticks.forEach((t, i) => {
    const y = Math.round(yOf(t)) + 0.5;
    root.append(svgNode("line", { class: i === 0 ? "trend-base" : "trend-grid", x1: x0, x2: x1, y1: y, y2: y }));
    const label = svgNode("text", { class: "trend-tick", x: x0 - 6, y: y + 4, "text-anchor": "end" });
    label.textContent = tickText[i];
    root.append(label);
  });
  root.append(svgNode("rect", { class: "trend-wash", x: 0, y: padT, width: Math.max(1, slotW), height: plotH, visibility: "hidden" }));
  // 棒：下から系列の順に積む。いちばん上の段だけ上の角を 4px 丸める
  const geo = view.buckets.map((b, i) => {
    const cx = x0 + slotW * (i + 0.5);
    const x = cx - barW / 2;
    const stack = trendStackGeometry(view.series.map((s) => b.values.get(s.key)?.credits ?? 0), { top, plotH, baseY: padT + plotH, gap: GAP });
    const segs = stack.map((g) => {
      const s = view.series[g.index];
      const hh = g.y1 - g.y0;
      const r = g.round ? Math.min(4, barW / 2, hh) : 0;
      root.append(svgNode("path", { class: `trend-seg ${serClass(s.slot)}`, d: topRoundedPath(x, g.y0, barW, hh, r), "data-i": i, "data-key": s.key }));
      return { key: s.key, y0: g.y0, y1: g.y1 };
    });
    return { cx, segs };
  });
  // 横の軸の文字：1 段目は日（今月）・月（12 か月）、2 段目は年。同じ段で重なるものは出さない（今日・今月は必ず出す。admin-lib.js の trendAxisLabels）
  for (const l of trendAxisLabels(view, { x0, slotW })) {
    const t = svgNode("text", { class: `trend-xlabel${l.today ? " today" : ""}`, x: l.x, y: padT + plotH + (l.row ? 32 : 16), "text-anchor": "middle" });
    t.textContent = l.text;
    root.append(t);
  }
  T.geo = { x0, x1, slotW, padT, plotH, width, narrow, n, segs: geo };
  // 押せる範囲は棒の 1 本分の幅いっぱい・高さはグラフ全体（細い棒の上に指を正確に置かなくてよい）
  const pick = (e) => {
    const r = root.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < x0 || x > x1 + 1) return null;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x - x0) / slotW)));
    const seg = geo[i].segs.find((g) => y >= g.y0 - 1 && y <= g.y1 + 1);
    return { i, key: seg?.key ?? null };
  };
  const onPoint = (e) => {
    const p = pick(e);
    if (p) showTrendTip(p.i, p.key);
    else if (!narrow) hideTrendTip();
  };
  root.addEventListener("pointermove", onPoint);
  root.addEventListener("pointerdown", onPoint);
  root.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && !narrow) hideTrendTip();
  });
  root.addEventListener("focus", () => {
    if (T.active === null) showTrendTip(defaultTrendIndex(), null, true);
  });
  root.addEventListener("blur", () => {
    if (!narrow && !T.redrawing) hideTrendTip();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !narrow) {
      hideTrendTip();
      return;
    }
    const cur = T.active ?? defaultTrendIndex();
    const to = { ArrowRight: cur + 1, ArrowLeft: cur - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    showTrendTip(Math.min(n - 1, Math.max(0, to)), null, true);
  });
  // 描き直す前にグラフにフォーカスがあれば、新しいグラフへ移す（幅が変わったとき。ホバーの内訳も同じ棒のまま）
  const old = plot.querySelector("svg");
  const hadFocus = !!old && document.activeElement === old;
  const keepActive = T.active;
  const keepKey = T.activeKey;
  T.redrawing = true;
  old?.remove();
  plot.prepend(root);
  plot.classList.toggle("narrow", narrow);
  trendStepRow(plot, narrow, n, view.range);
  if (hadFocus) root.focus({ preventScroll: true });
  T.redrawing = false;
  T.active = keepActive;
  T.activeKey = keepKey;
  // 狭い幅は、内訳をグラフの下にいつも出しておく（指で棒を押すと変わる）。広い幅はホバー・フォーカスのときだけ浮かべる
  if (narrow) showTrendTip(T.active ?? defaultTrendIndex(), T.activeKey);
  else if (T.active !== null) showTrendTip(T.active, T.activeKey);
  else hideTrendTip();
}

/**
 * 狭い幅（520px 未満）だけ、グラフの下に［前］［次］のボタン（44px 四方）と「なぞる」の案内を出す。
 * 1 本の棒の幅が 8px ほどになるため、指で押す代わりに 1 本ずつ選べるようにする。広い幅では外す
 */
function trendStepRow(plot, narrow, n, range) {
  plot.querySelector(".trend-step")?.remove();
  if (!narrow) return;
  const unit = range === "month" ? "日" : "月";
  const step = (d) =>
    el("button", {
      type: "button",
      className: "icon-btn trend-step-btn",
      "data-step": String(d),
      "aria-label": d < 0 ? `前の${unit}` : `次の${unit}`,
      text: d < 0 ? "‹" : "›",
      onclick: () => {
        const T = state.trend;
        const to = Math.min(n - 1, Math.max(0, (T.active ?? defaultTrendIndex()) + d));
        showTrendTip(to, null, true);
      },
    });
  const tip = $("trend-tip");
  plot.insertBefore(
    el("div", { className: "trend-step" }, step(-1), el("p", { className: "trend-step-hint", text: `棒を押したまま左右になぞるか、‹ › で${unit}を選べます` }), step(1)),
    tip,
  );
}

/** 最初に選ぶ棒：今日（今月）・今月（12 か月）。無ければ最後の棒 */
function defaultTrendIndex() {
  const b = state.trend.view?.buckets ?? [];
  const i = b.findIndex((x) => x.today);
  return i >= 0 ? i : Math.max(0, b.length - 1);
}

/** その棒の内訳（見出し・合計・系列ごとのクレジットと回数。上に積んだ段から）を出す。announce は読み上げの領域にも入れる */
function showTrendTip(i, key = null, announce = false) {
  const T = state.trend;
  const view = T.view;
  const g = T.geo;
  const plot = $("trend-plot");
  const tip = $("trend-tip");
  if (!view || !g || !plot || !tip) return;
  const b = view.buckets[i];
  if (!b) return;
  T.active = i;
  T.activeKey = key;
  const wash = plot.querySelector(".trend-wash");
  if (wash) {
    wash.setAttribute("x", String(g.x0 + g.slotW * i));
    wash.setAttribute("visibility", "visible");
  }
  for (const n of plot.querySelectorAll(".trend-seg.is-hover")) n.classList.remove("is-hover");
  if (key !== null) {
    for (const n of plot.querySelectorAll(`.trend-seg[data-i="${i}"]`)) if (n.dataset.key === key) n.classList.add("is-hover");
  }
  const rows = [...view.series].reverse().filter((s) => {
    const v = b.values.get(s.key);
    return v && (v.credits || v.jobs);
  });
  const suffix = b.today && view.range === "month" ? "（今日）" : b.today ? "（今月）" : b.future ? "（これから）" : "";
  tip.replaceChildren(
    el("p", { className: "tip-title", text: `${b.title}${suffix}` }),
    el(
      "p",
      { className: "tip-total" },
      el("b", { className: "num", text: formatCredits(b.total.credits) }),
      el("span", { className: "num", text: ` クレジット・${formatCredits(b.total.jobs)} 回` }),
    ),
    rows.length
      ? el(
        "ul",
        { className: "tip-rows" },
        ...rows.flatMap((s) => {
          const v = b.values.get(s.key);
          const li = el(
            "li",
            { className: s.key === key ? "is-hover" : "" },
            el("span", { className: `tip-key ${serClass(s.slot)}`, "aria-hidden": "true" }),
            el("b", { className: "num", text: formatCredits(v.credits) }),
            el("span", { className: "tip-unit num", text: `クレジット・${formatCredits(v.jobs)} 回` }),
            el("span", { className: "tip-name", text: s.label }),
          );
          // その他：まとめた項目ごとの名前と値（F194-01）
          if (s.slot || !b.otherParts.length) return [li];
          return [
            li,
            ...b.otherParts.map((p) =>
              el("li", { className: "tip-part" }, el("span", { className: "tip-name", text: `${p.label}：${formatCredits(p.credits)} クレジット・${formatCredits(p.jobs)} 回` }))
            ),
          ];
        }),
      )
      : el("p", { className: "tip-empty", text: b.future ? "まだ来ていない日です。" : "生成はありません。" }),
  );
  tip.hidden = false;
  if (g.narrow) {
    tip.style.left = "";
    tip.style.top = "";
  } else {
    const cx = g.x0 + g.slotW * (i + 0.5);
    const tw = tip.offsetWidth;
    let left = cx + 16;
    if (left + tw > g.width) left = cx - 16 - tw;
    if (left < 0) left = Math.max(0, Math.min(g.width - tw, cx - tw / 2));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = "0px";
  }
  if (announce) {
    const live = $("trend-live");
    if (live) {
      live.textContent = `${b.title}${suffix}：合計 ${formatCredits(b.total.credits)} クレジット・${formatCredits(b.total.jobs)} 回。` +
        rows.map((s) => `${s.label} ${formatCredits(b.values.get(s.key).credits)} クレジット・${formatCredits(b.values.get(s.key).jobs)} 回`).join("、") +
        (b.otherParts.length
          ? `。${view.series.find((s) => !s.slot)?.label ?? "その他"}の内訳：` +
            b.otherParts.map((p) => `${p.label} ${formatCredits(p.credits)} クレジット・${formatCredits(p.jobs)} 回`).join("、")
          : "");
    }
  }
}

function hideTrendTip() {
  const T = state.trend;
  const plot = $("trend-plot");
  // 狭い幅は下にいつも出しておく（ほかのタブへ移って面が隠れている間も消さない。戻ったら同じ内訳）
  if (T.geo?.narrow) return;
  T.active = null;
  T.activeKey = null;
  const tip = $("trend-tip");
  if (tip) tip.hidden = true;
  if (!plot) return;
  plot.querySelector(".trend-wash")?.setAttribute("visibility", "hidden");
  for (const n of plot.querySelectorAll(".trend-seg.is-hover")) n.classList.remove("is-hover");
}

// 幅が変わったら描き直す（右の欄の開閉・画面の回転・窓の大きさ）。広い幅で、グラフの外を押したらホバーの内訳を閉じる
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    const plot = $("trend-plot");
    if (plot && state.trend.geo && Math.floor(plot.clientWidth) !== state.trend.geo.width) drawTrendPlot();
  }).observe($("settings-trend"));
}
document.addEventListener("pointerdown", (e) => {
  const plot = $("trend-plot");
  if (plot && state.trend.active !== null && !state.trend.geo?.narrow && !plot.contains(e.target)) hideTrendTip();
});

/** ② 上限と枠：まとまりごとに 1 件 1 行（項目名・今の値と単位・短い対象・［変更］）。行を押すと選ぶ */
function limitsSection() {
  const S = state.settings;
  const updated = S.info?.settings?.updated_at;
  return partBox({
    id: "limits-h",
    title: "上限と枠",
    status: S.status,
    error: S.error,
    at: S.infoAt,
    retry: retryInfo,
    side: updated ? el("span", { className: "meta num", text: `設定の最終変更 ${formatShortDateTime(updated)}` }) : null,
    content: () =>
      groupSettingLimits(availableLimits(settingsRow())).map((g) =>
        el(
          "div",
          { className: "set-group" },
          el("h4", { id: `grp-${g.id}`, text: g.label }),
          el("ul", { className: "set-rows", "aria-labelledby": `grp-${g.id}` }, ...g.items.map(limitListRow)),
        )
      ),
  });
}

/** Storage と保存期限の集計。削除や設定変更の操作はこの欄には置かない。 */
function storageSection() {
  const S = state.settings;
  return partBox({
    id: "storage-usage-h",
    title: "Storage の使用量と保存期限",
    status: S.storageStatus,
    error: S.storageError,
    at: S.storageAt,
    retry: retryStorage,
    side: S.storageAt ? el("span", { className: "checked num", text: checkedText(S.storageAt) }) : null,
    content: () => {
      const view = storageUsageView(S.storage, formatDateTime);
      if (!view) return [el("p", { className: "error-text", text: "Storage の集計の形が正しくありません。再度読み込んでください。" })];
      return [
        el("p", { className: "hint", text: "保存済みのファイルの容量です。1 GB は 10 億バイト。容量が分からないファイルは、件数を分けて表示します。" }),
        el("ul", { className: "storage-usage-list", "aria-label": "バケットごとのファイル件数と容量" },
          ...view.buckets.map((row) => el("li", { className: "storage-usage-row" },
            el("span", { className: "storage-usage-label", text: row.label }),
            el("span", { className: "num", text: row.count }),
            el("span", { className: "num", text: row.capacity }),
          )),
        ),
        el("p", { className: "strong num", text: view.total }),
        el("p", { className: "num", text: `${view.retention} · ${view.pending}` }),
        el("p", { className: "num", text: view.earliest }),
        ...view.cleanup.map((line) => el("p", { className: "hint num", text: line })),
      ];
    },
  });
}

function limitListRow(spec) {
  const S = state.settings;
  const key = spec.key;
  const label = labelOf(key);
  const selected = S.sel?.kind === "limit" && S.sel.key === key;
  const editing = S.edit?.key === key;
  return el(
    "li",
    { className: `set-li ${selected ? "is-selected" : ""}`, "data-setting": key },
    el(
      "button",
      {
        type: "button",
        className: "set-item",
        "aria-current": selected ? "true" : null,
        "data-focus-key": `sel:${key}`,
        onclick: () => selectSetting({ kind: "limit", key }),
      },
      el("span", { className: "set-name", text: label }),
      el(
        "span",
        { className: "set-line" },
        el("span", { className: "set-val num", text: settingValueText(key, currentOf(key)) + (editing ? (editDirty(S.edit) ? "（変更中・未保存）" : "（変更中）") : "") }),
        el("span", { className: "set-target", text: settingTarget(key) }),
      ),
    ),
    el("button", {
      type: "button",
      className: "btn set-change",
      text: "変更",
      "aria-label": `${label}を変更`,
      "data-focus-key": `chg:${key}`,
      disabled: S.busy,
      onclick: () => startEdit(key),
    }),
  );
}

// ---- 設定：選ぶ・読む・直す（共通の部品：下書き・確かめ・保存。提案書 11.7・11.8） ----

/** 数値の編集の下書きを捨ててよいか（保存していない入力があれば確かめる） */
async function confirmLeaveEdit() {
  const S = state.settings;
  if (!S.edit) return true;
  if (S.edit.saving) return false;
  if (editDirty(S.edit) && !(await askDiscard(`${labelOf(S.edit.key)}の新しい値`))) return false;
  S.edit = null;
  return true;
}

async function selectSetting(sel) {
  const S = state.settings;
  if (S.busy) return;
  const same = S.sel && S.sel.kind === sel.kind && S.sel.key === sel.key && S.sel.id === sel.id;
  if (same) {
    // 選んである行をもう一度押す：狭い幅はシートを開く
    if (!isWide()) openSettingSheet();
    return;
  }
  if (S.edit && !(sel.kind === "limit" && S.edit.key === sel.key) && !(await confirmLeaveEdit())) return;
  S.sel = sel;
  renderSettings();
}

/** ［変更］：選んで、読む欄を編集の形にする（狭い幅は編集のシートを開く） */
async function startEdit(key) {
  const S = state.settings;
  if (S.busy || S.status !== "ok") return;
  if (state.tab !== "settings" && !(await switchTab("settings"))) return;
  if (!(S.edit && S.edit.key === key)) {
    if (S.edit && !(await confirmLeaveEdit())) return;
    const cur = currentOf(key);
    S.edit = { key, text: settingInitialText(cur), initial: settingInitialText(cur), base: cur, error: "", saving: false };
  }
  S.sel = { kind: "limit", key };
  renderSettings();
  if (isWide()) focusEditInput();
  else openSettingSheet();
}

function focusEditInput() {
  const input = [...document.querySelectorAll("#edit-input")].find((n) => !n.closest("[hidden]"));
  if (!input) return;
  input.focus();
  input.select?.();
}

/** 編集をやめる（保存していない入力があれば確かめる）。読む形に戻り、［変更］へフォーカスを戻す */
async function cancelEdit() {
  const S = state.settings;
  if (!S.edit || S.edit.saving) return false;
  if (!(await confirmLeaveEdit())) {
    focusEditInput();
    return false;
  }
  renderSettings();
  focusKey("panel-change", isWide() ? $("settings-aside") : sheet);
  return true;
}

/** 選択を外す（右の欄・下の帯を閉じる）。編集中なら先に確かめる。入口の行へフォーカスを戻す */
async function closeSelection() {
  const S = state.settings;
  if (S.busy || !S.sel) return;
  if (S.edit && !(await confirmLeaveEdit())) {
    focusEditInput();
    return;
  }
  const back = selFocusKey(S.sel);
  S.sel = null;
  if (sheet.open && sheetKind === "setting") closeSheet();
  renderSettings();
  focusKey(back);
}

function showEditError(message) {
  const S = state.settings;
  if (!S.edit) return;
  S.edit.error = message;
  renderSettings();
  focusEditInput();
}

/** 保存：検査 → 今の値が読み込み直しで変わっていないか → 必要なら確かめる → 送る。失敗しても入力を残す。成功するまで今の値は変えない */
async function saveEdit() {
  const S = state.settings;
  const e = S.edit;
  if (!e || e.saving || S.busy) return;
  const key = e.key;
  const label = labelOf(key);
  const r = parseSettingInput(key, e.text, label);
  if (r.problem) return showEditError(`${r.problem}。`);
  const cur = currentOf(key);
  if (!sameSettingValue(cur, e.base)) {
    e.base = cur;
    return showEditError(`読み込み直したところ、今の値が ${settingValueText(key, cur)} に変わっていました。確かめてから、もう一度保存してください。`);
  }
  if (sameSettingValue(r.value, cur)) return showEditError(`今の値と同じです（${settingValueText(key, cur)}）。`);
  // 全体の額（常に）・回数・1 回の上限・厳しくなる向きの上限は確かめる（条件は limitChangeCheck のまま）
  const check = limitChangeCheck(key, cur, r.value, S.info);
  if (check.confirm) {
    const v = limitConfirmView(key, label, cur, r.value, check);
    const ok = await ask({
      title: v.title,
      lines: v.lines,
      warnings: v.warnings,
      buttons: [{ label: "やめる", value: false }, { label: v.ok, value: true, kind: v.warnings.length ? "danger" : "primary" }],
    });
    if (S.edit !== e || appClosed) return;
    if (!ok) return focusEditInput();
    // 確かめているあいだに今の値が変わった（読み込み直し）なら、保存しない
    if (!sameSettingValue(currentOf(key), cur)) {
      e.base = currentOf(key);
      return showEditError(`確かめているあいだに、今の値が ${settingValueText(key, currentOf(key))} に変わりました。もう一度確かめてから保存してください。`);
    }
  }
  await commitSetting(key, r.value, `${label}を ${settingValueText(key, r.value)} にしました。`, e);
}

/** ［既定に戻す］［上限なしに戻す］：いつも確かめる（既定の数値は分からないことがある）。今が null なら出さない */
async function resetSetting(key) {
  const S = state.settings;
  if (S.busy) return;
  const cur = currentOf(key);
  if (cur === null) return;
  const label = labelOf(key);
  const v = resetConfirmView(key, label, cur);
  const ok = await ask({ title: v.title, lines: v.lines, buttons: [{ label: "やめる", value: false }, { label: v.ok, value: true, kind: "primary" }] });
  if (!ok || appClosed) return;
  if (!sameSettingValue(currentOf(key), cur)) {
    notify("確かめているあいだに、今の値が変わりました。もう一度確かめてください。", "error");
    return;
  }
  await commitSetting(key, null, `${label}を「${settingValueText(key, null)}」にしました。`, S.edit?.key === key ? S.edit : null);
}

/**
 * 1 つの数値の設定を送る。送っている間は二重の操作・ほかの項目の編集・タブの移動を止める。
 * 失敗：入力と編集の形を残し、理由を欄のそばと（閉じるまで残る）お知らせに出す。自動で送り直さない。
 * 成功：編集を閉じ、正本を読み直してから今の値を出す。読み直せなければ「保存済み・再確認できません」と分けて知らせる
 */
async function commitSetting(key, value, doneMessage, edit) {
  const S = state.settings;
  S.busy = true;
  if (edit) {
    edit.saving = true;
    edit.error = "";
  }
  renderSettings();
  gates.info.invalidate();
  gates.history.invalidate();
  const { error } = await supabase.rpc("admin_update_settings", { p_changes: { [key]: value } });
  gates.info.invalidate();
  gates.history.invalidate();
  if (appClosed) return;
  if (error) {
    S.busy = false;
    const msg = `保存できませんでした。${explainError(error)}`;
    if (edit) {
      edit.saving = false;
      if (S.edit === edit) edit.error = `${msg}入力は残してあります。`;
    }
    notify(msg, "error");
    renderSettings();
    focusEditInput();
    // 保存の前後で、読み込み中だった上限・履歴の応答を捨てた。代わりを読み直して「読み込み中」のまま止めない（入力は残す。Codex TASK-0093 R2）
    await Promise.all([loadSettingsInfo(), loadSettingsHistory()]);
    if (appClosed) return;
    renderSettings();
    renderHeader();
    return;
  }
  if (S.edit && S.edit.key === key) S.edit = null;
  const read = await loadSettingsAll();
  S.busy = false;
  if (appClosed) return;
  if (!read.info) {
    notify(`${doneMessage}ただし、最新の値を読み直せませんでした（表示は前に読んだ値です）。同じ変更を送り直す必要はありません。`, "warn");
  } else {
    notify(doneMessage, "ok", [], { label: "変更履歴を見る", onClick: openHistory });
  }
  renderSettings();
  if (!focusKey("panel-change", isWide() ? $("settings-aside") : sheet)) focusKey(`sel:${key}`);
}

/** 選んだ項目の中身（右の欄・シートで共通）。{ title, body, foot } */
function settingPanel() {
  const S = state.settings;
  const sel = S.sel;
  if (!sel) return { title: "", body: [], foot: [] };
  if (sel.kind === "template") return templatePanel(sel.id);
  if (S.status !== "ok") return { title: labelOf(sel.key), body: [el("p", { className: "muted", text: "読み込み中…" })], foot: [] };
  return S.edit?.key === sel.key ? limitEditPanel(sel.key) : limitReadPanel(sel.key);
}

/** 読む形：何に効くか・今の値・適用対象・範囲・設定全体の最終変更・詳しい情報。［変更］を押すまで入力欄は出さない */
function limitReadPanel(key) {
  const S = state.settings;
  const spec = settingSpec(key);
  const cur = currentOf(key);
  const src = settingSource(cur, key);
  const updated = S.info?.settings?.updated_at;
  const u = key === "global_daily_cost_limit_usd" ? usageSummaryView(S.info) : null;
  const credits = spec?.usd && cur !== null ? usdCreditsText(cur) : null;
  return {
    title: labelOf(key),
    body: [
      el("p", { className: "read-value num", text: settingValueText(key, cur) }),
      el(
        "dl",
        { className: "read-kv" },
        el("dt", { text: "効く対象" }),
        el("dd", { text: settingDesc(key, S.info?.settings) }),
        el("dt", { text: "範囲" }),
        el("dd", { className: "num", text: settingRangeText(key) }),
        el("dt", { text: "設定の種類" }),
        el("dd", { text: src.kind === "db" ? "個別設定（この画面で決めた値）" : `既定（個別設定なし）` }),
        credits ? el("dt", { text: "クレジットの目安" }) : null,
        credits ? el("dd", { className: "num", text: `${credits}（1 クレジット＝0.01 ドルの単純な換算。実際の消費は生成ごとに切り上げます）` }) : null,
        u ? el("dt", { text: "今の利用" }) : null,
        u ? el("dd", { className: "num", text: `直近 24 時間の見積額 ${u.costText}${u.pctText ? `（${u.pctText}）` : ""}` }) : null,
        el("dt", { text: "最終変更" }),
        el("dd", { className: "num", text: updated ? `${formatShortDateTime(updated)}（設定全体）` : "—" }),
      ),
      techDetails(key, cur),
    ],
    foot: [
      el("button", {
        type: "button",
        className: "btn primary",
        text: "変更",
        "aria-label": `${labelOf(key)}を変更`,
        "data-focus-key": "panel-change",
        disabled: S.busy,
        onclick: () => startEdit(key),
      }),
    ],
  };
}

/** 詳しい情報（開発の言葉・設定キー・既定の出どころ。普段は閉じる。11.3） */
function techDetails(key, cur) {
  const spec = settingSpec(key);
  const since = spec?.canvas
    ? "019"
    : key === "lipsync_max_audio_seconds"
    ? "017"
    : spec?.defaultValue !== undefined
    ? "016"
    : key === "job_max_credits"
    ? "015"
    : "014";
  const lines = [
    el("p", { className: "tech" }, "設定キー：", el("code", { text: key }), `（DB の app_settings。admin_update_settings で保存。DB の更新 ${since} の項目）`),
    el("p", { className: "tech", text: cur === null ? "今は DB の値が空（null）です。" : `今の DB の値：${cur}` }),
  ];
  if (spec && !spec.nullText) lines.push(el("p", { className: "tech", text: "空（null）のときは、サーバーの環境変数の値で動きます。その数値は、この画面からは読めません。" }));
  else if (key === "job_max_credits") lines.push(el("p", { className: "tech", text: "空（null）は上限なしです（環境変数の既定はありません）。" }));
  else if (spec?.defaultValue !== undefined) lines.push(el("p", { className: "tech", text: `空（null）のときの値は ${spec.defaultValue} です（DB の既定と同じ）。` }));
  return el("details", { className: "plain-fold minor" }, el("summary", { "data-focus-key": "panel-tech" }, "詳しい情報"), el("div", { className: "fold-in" }, ...lines));
}

/** 直す形：今の値 → 新しい値（単位・範囲・空欄の意味・効く対象を入力のそばに）→［保存］［既定に戻す］［やめる］ */
function limitEditPanel(key) {
  const S = state.settings;
  const e = S.edit;
  const spec = settingSpec(key);
  const cur = currentOf(key);
  const label = labelOf(key);
  const input = el("input", {
    type: "text",
    id: "edit-input",
    className: "input num",
    inputmode: spec?.integer ? "numeric" : "decimal",
    autocomplete: "off",
    enterkeyhint: "done",
    "aria-describedby": "edit-hint edit-desc edit-error",
    "aria-invalid": e.error ? "true" : "false",
    "data-focus-key": "edit-input",
    readonly: e.saving,
  });
  input.value = e.text;
  const errorNode = el("p", { className: "field-error", id: "edit-error", role: "alert", hidden: !e.error, text: e.error });
  input.addEventListener("input", () => {
    const wasDirty = editDirty(e);
    e.text = input.value;
    if (e.error) {
      e.error = "";
      errorNode.hidden = true;
      input.setAttribute("aria-invalid", "false");
    }
    // 下の帯・一覧の「変更中・未保存」は、変わったときだけ描き直す（入力のたびに描き直さない）
    if (wasDirty !== editDirty(e)) {
      renderSettingsBar();
      const row = $("settings-main").querySelector(`[data-setting="${key}"] .set-val`);
      if (row) row.textContent = settingValueText(key, cur) + (editDirty(e) ? "（変更中・未保存）" : "（変更中）");
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      saveEdit();
    }
  });
  return {
    title: `${label}を変更`,
    body: [
      el("dl", { className: "read-kv" }, el("dt", { text: "今の値" }), el("dd", { className: "num strong", text: settingValueText(key, cur) })),
      el(
        "div",
        { className: "edit-form" },
        el("label", { for: "edit-input", className: "field-label", text: `新しい値（${settingUnitText(key)}）` }),
        input,
        el("p", { className: "hint num", id: "edit-hint", text: `範囲：${settingRangeText(key)}。${settingEmptyText(key)}` }),
        el("p", { className: "hint", id: "edit-desc", text: settingDesc(key, S.info?.settings) }),
        errorNode,
      ),
    ],
    foot: [
      el("button", {
        type: "button",
        className: "btn primary",
        text: e.saving ? "保存中…" : "保存",
        "data-focus-key": "panel-save",
        disabled: e.saving,
        onclick: saveEdit,
      }),
      cur !== null
        ? el("button", {
          type: "button",
          className: "btn",
          text: spec?.resetLabel ?? "既定に戻す",
          "data-focus-key": "panel-reset",
          disabled: e.saving,
          onclick: () => resetSetting(key),
        })
        : null,
      el("button", { type: "button", className: "btn", text: "やめる", "data-focus-key": "panel-cancel", disabled: e.saving, onclick: cancelEdit }),
    ],
  };
}

/** 広い幅の右の欄（何も選んでいなければ出さない。空の欄を取っておかない） */
function renderSettingsAside() {
  const aside = $("settings-aside");
  const S = state.settings;
  const show = state.tab === "settings" && !!S.sel && isWide();
  aside.hidden = !show;
  if (!show) {
    aside.replaceChildren();
    return;
  }
  const p = settingPanel();
  aside.replaceChildren(
    el(
      "div",
      { className: "aside-head" },
      el("h2", { id: "aside-title", tabindex: "-1", text: p.title }),
      el("button", {
        type: "button",
        className: "icon-btn",
        "aria-label": "閉じる",
        "data-tip": "閉じる",
        "data-focus-key": "aside-close",
        disabled: S.busy,
        onclick: closeSelection,
      }, icon("close", 18, 2.2)),
    ),
    ...[...p.body, p.foot.length ? el("div", { className: "edit-actions" }, ...p.foot) : null, ...(p.after ?? [])].filter(Boolean),
  );
}

/** 狭い幅の下の帯：選んだ項目の名前と［詳細を開く］（編集中は［変更を続ける］） */
function renderSettingsBar() {
  const bar = $("settings-bar");
  const S = state.settings;
  const show = state.tab === "settings" && !!S.sel && !isWide() && !appClosed;
  bar.hidden = !show;
  document.body.classList.toggle("setbar", show);
  if (!show) {
    bar.replaceChildren();
    return;
  }
  const editing = S.edit && S.sel.kind === "limit" && S.edit.key === S.sel.key;
  bar.replaceChildren(
    el(
      "div",
      { className: "selectbar-inner" },
      el(
        "p",
        { className: "bar-title" },
        el("span", { className: "muted", text: editing ? (editDirty(S.edit) ? "変更中（未保存）" : "変更中") : "選択中" }),
        selName(S.sel),
      ),
      el("button", {
        type: "button",
        className: "icon-btn",
        "aria-label": "選択を外す",
        "data-tip": "選択を外す",
        "data-focus-key": "bar-close",
        disabled: S.busy,
        onclick: closeSelection,
      }, icon("close", 18, 2.2)),
      el("button", {
        type: "button",
        className: "btn primary",
        text: editing ? "変更を続ける" : "詳細を開く",
        "data-focus-key": "bar-open",
        onclick: openSettingSheet,
      }),
    ),
  );
}

/** 狭い幅：選んだ項目のシート（読む形・直す形。Esc は 編集 → 読む → 閉じる の順） */
function openSettingSheet() {
  const S = state.settings;
  if (!S.sel) return;
  if (isWide()) {
    $("aside-title")?.focus();
    return;
  }
  openSheet("setting", () => {
    const p = settingPanel();
    // 取り消せない操作（p.after）があるときは、主の操作を本文の中に置き、取り消せない操作をいちばん下に分ける
    if (p.after?.length) setSheet({ head: el("h2", { id: "sheet-title", text: p.title }), body: [...p.body, el("div", { className: "edit-actions" }, ...p.foot), ...p.after] });
    else setSheet({ head: el("h2", { id: "sheet-title", text: p.title }), body: p.body, foot: p.foot });
  });
  sheetGuard = settingSheetGuard;
  if (S.edit && S.sel.kind === "limit" && S.edit.key === S.sel.key) focusEditInput();
}

async function settingSheetGuard(reason) {
  const S = state.settings;
  if (S.busy) return false;
  if (S.edit) {
    if (reason === "esc") {
      // Esc の 1 回目は編集をやめて読む形へ（保存していない入力があれば確かめる）
      await cancelEdit();
      return false;
    }
    if (!(await confirmLeaveEdit())) {
      focusEditInput();
      return false;
    }
  }
  return true;
}

// ---- 設定：モデル（読む表示 →［モデルを変更］で 3 区分のタブ・種類別の切り替え・保存の帯） ----

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

/** モデルの未保存の変更の数（区分の合計） */
function modelDraftCount() {
  const S = state.settings;
  if (!S.models || !S.drafts) return 0;
  return buildModelSave(S.models, effectiveDrafts(S.models, S.drafts, S.resetNull), rolesOn(), S.resetNull).count;
}

/** 設定の未保存の下書きを捨てる（タブを移るときに［破棄して移る］を選んだ） */
function discardSettingDrafts() {
  const S = state.settings;
  S.edit = null;
  if (S.models) {
    S.drafts = Object.fromEntries(MODEL_SCOPES.map((sc) => [sc.key, scopeSelection(S.models.models ?? [], sc.key)]));
    S.resetNull = {};
  }
  S.modelsEditing = false;
}

/** モデルの面だけを描き直す（オン・オフのたびに。押したスイッチ・タブにフォーカスを戻す） */
function renderModelsBox() {
  if (appClosed) return;
  const host = $("settings-models");
  keepFocus([host], () => host.replaceChildren(modelsSection()));
}

function openModelEdit() {
  const S = state.settings;
  if (S.busy) return;
  S.modelsEditing = true;
  renderModelsBox();
  if (!focusKey(`tab:${currentScope()}`, $("settings-models"))) focusKey("models-close");
}

async function closeModelEdit() {
  const S = state.settings;
  if (S.modelSaving) return;
  if (modelDraftCount() > 0) {
    if (!(await askDiscard("モデルの変更"))) return;
    S.drafts = Object.fromEntries(MODEL_SCOPES.map((sc) => [sc.key, scopeSelection(S.models?.models ?? [], sc.key)]));
    S.resetNull = {};
  }
  S.modelsEditing = false;
  renderModelsBox();
  focusKey("models-edit");
}

function modelsSection() {
  const S = state.settings;
  const count = S.modelsStatus === "ok" ? modelDraftCount() : 0;
  const side = S.modelsEditing
    ? el("button", { type: "button", className: "btn", text: "編集を閉じる", "data-focus-key": "models-close", disabled: S.modelSaving, onclick: closeModelEdit })
    : el("button", { type: "button", className: "btn", text: count ? "変更を続ける" : "モデルを変更", "data-focus-key": "models-edit", disabled: S.busy, onclick: openModelEdit });
  return partBox({
    id: "models-h",
    title: "モデル",
    status: S.modelsStatus,
    error: S.modelsError,
    at: S.modelsAt,
    retry: retryModels,
    side,
    content: () => {
      const roles = rolesOn();
      const out = [
        el(
          "ul",
          { className: "scope-sum", "aria-label": "区分ごとの使えるモード（保存されている設定）" },
          ...modelScopeSummary(S.models, roles).map((x) =>
            el(
              "li",
              {},
              el("span", { className: "sname", text: x.label }),
              el("span", { className: "snum", text: `使える ${x.usable} / ${x.total}` }),
              el("span", { className: "spolicy", text: x.policy }),
            )
          ),
        ),
      ];
      const unknown = activeScopes(roles).reduce((n, sc) => n + unknownList(S.models, sc.key).length, 0);
      if (!S.modelsEditing) {
        if (count) out.push(warnLine(`保存していないモデルの変更が ${count} 件あります。［変更を続ける］から保存するか、元に戻してください。`));
        if (unknown) out.push(warnLine(`今のカタログに無いモデルが ${unknown} 件、設定に残っています（効果はありません。次に保存すると外します）。`));
        return out;
      }
      return [...out, ...modelEditor()];
    },
  });
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

/** モデルの編集の中身（今までのモデルの面と同じ操作。開発の言葉と生の ID は「詳しい情報」へ） */
function modelEditor() {
  const S = state.settings;
  const list = S.models?.models ?? [];
  const modes = catalogModes(list);
  const roles = rolesOn();
  const scope = currentScope();
  const sLabel = scopeLabel(scope);
  const drafts = effectiveDrafts(S.models, S.drafts, S.resetNull);
  const usable = scopeUsable(list, scope, drafts);
  const plan = buildModelSave(S.models, drafts, roles, S.resetNull);
  const out = [];
  if (roles) out.push(modelTabs(plan));
  const panel = [el("p", { className: "set-target num", text: `${scope === "all" ? "使える" : `${sLabel}が使える`}モード ${usable} / ${modes.length}（未保存の変更を含む）` })];
  if (scope === "all") {
    panel.push(el("p", { className: "hint", text: "サーバーで許可されたものだけをオンにできます（「サーバー側で無効」は押せません）。保存するまで反映されません。" }));
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
      panel.push(el("p", { className: "note-box", text: `今は制限なしです（全体でオンのモデルは、これから足すモデルも含めて、${sLabel}もすべて使えます。口パクなど明示が要るモデルは、このタブでオンにしたものだけ）。` }));
    }
    // 保存されている一覧が明示（null でない）のときは、全部オンに見えても出す（古い ID を外すだけの保存は明示の一覧のまま残るため）。
    // 一覧が null で未保存のオフがあるだけなら「元に戻す」で足りる
    if (Array.isArray(scopeList(S.models, scope)) && !S.resetNull[scope]) {
      panel.push(
        el("p", { className: "hint", text: "今は一覧で決めています。新しく足したモデルは自動では使えるようになりません。" }),
        el("button", {
          type: "button",
          className: "btn restore-null",
          text: "制限なしに戻す",
          disabled: S.modelSaving,
          onclick: async () => {
            const ok = await ask({
              title: `${sLabel}の制限をなくしますか？`,
              lines: [
                `全体でオンのモデルは、これから足すモデルも含めて、${sLabel}もすべて使えるようになります。`,
                "口パクなど、明示が要るモデルは使えなくなります（使わせるには、このタブでオンにして保存します）。",
                "保存するまで反映されません。",
              ],
              buttons: [{ label: "やめる", value: false }, { label: "制限なしに戻す", value: true, kind: "primary" }],
            });
            if (!ok) return;
            // 印だけを持つ。この区分の下書きは、表示・件数・確認の文・保存のたびに、今の全体の下書きから作る（effectiveDrafts）
            S.resetNull[scope] = true;
            renderModelsBox();
          },
        }),
      );
    }
  }
  // 今のカタログに無いモデルの ID（どの区分の一覧にも）。次に保存すると外す。件数と影響はここ、ID は詳しい情報へ
  let unknownCount = 0;
  const unknownIds = [];
  for (const sc of activeScopes(roles)) {
    const unknown = unknownList(S.models, sc.key);
    unknownCount += unknown.length;
    if (unknown.length) {
      const where = sc.key === "all" ? "設定" : `${sc.label}の一覧`;
      panel.push(warnBox(`今のカタログに無いモデルが ${unknown.length} 件、${where}に残っています（効果はありません。次に保存すると外します）。`));
      unknownIds.push(`${where}：${unknown.join("、")}`);
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
  panel.push(
    el(
      "details",
      { className: "plain-fold minor" },
      el("summary", {}, "詳しい情報（モデルの ID など）"),
      el(
        "div",
        { className: "fold-in" },
        el("p", { className: "tech", text: "「サーバー側で無効」は、サーバーの環境変数 ENABLED_PROVIDER_MODELS で許可されていないモデルです。「参照から動画」は fal の経路だけで使えます。" }),
        ...unknownIds.map((t) => el("p", { className: "tech", text: `カタログに無い ID（${t}）` })),
        el(
          "ul",
          { className: "tech" },
          ...modes.map(({ model, mode }) => el("li", {}, `${model.label}（${mode.label}）：`, el("code", { text: mode.model_id }))),
        ),
      ),
    ),
  );
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
        disabled: !dirty || S.modelSaving,
        onclick: () => {
          S.drafts = Object.fromEntries(MODEL_SCOPES.map((sc) => [sc.key, scopeSelection(list, sc.key)]));
          S.resetNull = {};
          renderModelsBox();
        },
      }),
      el("button", {
        type: "button",
        className: "btn primary",
        text: S.modelSaving ? "保存中…" : "モデルの設定を保存",
        "data-focus-key": "models-save",
        disabled: (!dirty && !unknownCount) || S.modelSaving || S.busy,
        onclick: saveModels,
      }),
    ),
  );
  return out;
}

/** 開閉の領域の id を重ねないための連番 */
let modelPanelSeq = 0;

/** モデル 1 つ：見出しの行に一括スイッチ、その下に字下げしてモードごとのスイッチ（モードが 1 つだけなら一括スイッチだけ） */
function modelItem(m, scope) {
  const S = state.settings;
  const drafts = effectiveDrafts(S.models, S.drafts, S.resetNull);
  const draft = drafts[scope];
  const modes = m.modes ?? [];
  const optIds = optInModelIds(S.models?.models);
  const optModes = modes.filter((mode) => optIds.has(mode.model_id));
  // 説明（全体のタブでオンにして保存したときだけ使える）は、使える経路の行だけ（別の提供元に振り分け中の参照には出さない）
  const noteModes = optModes.filter((mode) => modeStatus(m, mode, false).kind !== "route_off");
  const statusOf = (mode, on) => scopeModeStatus(m, mode, on, scope, drafts.all);
  // 押せないか：使えない行（別の提供元の参照など）は、保存済みの一覧に残っているとき（オン）だけ、オフにできる
  const lockedFn = (mode) => statusOf(mode, draft.has(mode.model_id)).locked;
  // 一括スイッチは、明示が要る行（参照から動画）を含めない（「まとめてオン」で参照が有効にならない。参照は行のスイッチで個別に）。
  // 明示が要る行しか無いモデル（口パク）は、そのまま全体を対象にする
  // 見出し：一括スイッチの対象（core）が全部オフでも、明示が要る行（参照）がオンなら「一部」（参照のオンが見出しで分かる）
  const { core, state: ms } = masterView(modes, draft, lockedFn, optIds);
  // 数える行（「○ つのうち ○ つ」）：押せる行すべて（参照を含む）
  const free = modes.filter((mode) => !lockedFn(mode));
  const single = modes.length === 1 ? modes[0] : null;
  // 生の ID（model_id）は詳しい情報へ。提供元と価格はここに残す
  const sub = [single?.label, m.provider, m.price?.text].filter(Boolean).join(" · ");
  const lockKinds = [...new Set(core.map((mode) => statusOf(mode, false)).filter((st) => st.locked).map((st) => st.kind))];

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
    stateText = lockKinds.length === 1 ? (lockKinds[0] === "global_off" ? "全体でオフ" : lockKinds[0] === "route_off" ? "この経路では使えません" : "サーバー側で無効") : "変更できません";
    // 一括スイッチの対象は押せないが、参照の行は押せる（またはオンのまま）ときは、その状態を添える
    const optNow = optModes.filter((mode) => core !== modes && draft.has(mode.model_id) && !lockedFn(mode));
    if (core !== modes && optModes.some((mode) => !lockedFn(mode))) stateText += optNow.length ? "（参照はオン）" : "（参照はオフ）";
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
  const changed = modes.some((mode) => draft.has(mode.model_id) !== modeBaseOn(mode, scope) && (!lockedFn(mode) || statusOf(mode, draft.has(mode.model_id)).kind === "route_off"));

  const input = el("input", {
    type: "checkbox",
    role: "switch",
    checked: ms === "on" || (ms === "locked" && core.some((mode) => draft.has(mode.model_id))),
    disabled: ms === "locked" || S.modelSaving,
    // 押せない理由は、となりの状態の文字（「サーバー側で無効」「全体でオフ」など）でも見える。読み上げにも添える
    "aria-label": `${single ? `${m.label}：${single.label}` : `${m.label}：まとめて`}${ms === "locked" ? `（${stateText}）` : ""}`,
  });
  input.indeterminate = ms === "mixed";
  input.setAttribute("aria-checked", ms === "mixed" ? "mixed" : String(input.checked));
  input.dataset.focusKey = `master:${m.key ?? m.label}`;
  input.addEventListener("change", () => {
    // オンは参照の行を入れない（明示が要る行は個別に）。オフは参照の行もオフにする（安全側）
    S.drafts[scope] = applyMasterOptIn(modes, draft, lockedFn, optIds); // draft は印のある区分では「今の形」。ここで下書きとして持ち、印を外す
    S.resetNull[scope] = false;
    renderModelsBox();
  });

  // 一部だけオンのとき、閉じていても分かるよう「2 つのうち 1 つ」を添える
  const onCount = free.filter((mode) => draft.has(mode.model_id)).length;
  const multi = modes.length > 1;
  const tstate = el(
    "span",
    { className: `tstate mstate ${multi ? "clickable" : ""} ${stateKind}` },
    stateText,
    changed ? el("span", { className: "changed", text: "（未保存）" }) : null,
    ms === "mixed" ? el("span", { className: "tcount small muted", text: `${free.length} つのうち ${onCount} つ` }) : null,
    free.length < modes.length && ms !== "locked" && multi ? el("span", { className: "tcount small muted", text: "押せないモードは変わりません" }) : null,
  );
  const nameBlock = el("span", { className: "tlabel" }, el("span", { className: "model-name", text: m.label }), sub ? el("span", { className: "small muted ellipsis", text: sub }) : null);
  // スイッチを切り替えるのは、スイッチそのものを押したときだけ（label の範囲はスイッチだけ。名前は aria-label で付けている）
  const switchLabel = (extra = "") => el("label", { className: `toggle master switch-only ${extra} ${ms === "locked" ? "locked" : ""}` }, input);

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
    noteModes.length
      ? el("p", {
        className: "small muted",
        text: (noteModes.length < modes.length ? `「${noteModes.map((mode) => mode.label).join("」「")}」は` : "") +
          (scope === "all"
            ? "全体のタブでオンにして保存したときだけ使えます。"
            : "この区分で使わせるには、全体のタブとこのタブの両方でオンにします。オンにすると、この区分の一覧は全体と同じ（制限なし）には戻らず、これから足すモデルもこのタブでオンにしないと使えません。"),
      })
      : null,
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
    checked: on && mode.collided !== true, // 重なって使えない行は、同じ ID の行の状態を映さない（チェックなし）。使えない行でも、保存済みの一覧に残っていればチェックのまま（文言で「一覧には残っています」と示し、オフにはできる）
    disabled: st.locked || S.modelSaving,
    "aria-label": `${m.label}：${mode.label}${st.locked ? `（${st.text}）` : ""}`,
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
    { className: `toggle sub ${st.locked ? "locked" : ""}` },
    el("span", { className: "tlabel" }, el("span", { className: "mode-name", text: mode.label })),
    el("span", { className: `tstate ${st.kind}` }, st.text, on !== modeBaseOn(mode, scope) && (!st.locked || st.kind === "route_off") ? el("span", { className: "changed", text: "（未保存）" }) : null),
    input,
  );
}

/** モデルの保存：自前の確かめ（変えた区分とモデルは同じダイアログの内訳に）→ 直前の読み直しで競合を見る → 送る。送っている間は重ねない */
async function saveModels() {
  clearNotice();
  const S = state.settings;
  if (S.busy || S.modelSaving) return;
  const roles = rolesOn();
  const plan = buildModelSave(S.models, effectiveDrafts(S.models, S.drafts, S.resetNull), roles, S.resetNull);
  if (!plan.entries.length) return;
  const labelOfModel = modelLabeler(S.models.models);
  const lines = saveConfirmLines(plan, labelOfModel);
  const ok = await ask({
    title: lines[0],
    lines: ["変えた区分とモデルは、下の内訳のとおりです。", "次の生成から、すぐに効きます。"],
    detail: lines.slice(1, -1),
    note: saveConfirmNote(plan),
    buttons: [{ label: "やめる", value: false }, { label: "保存する", value: true, kind: "primary" }],
  });
  if (!ok || appClosed) return;
  for (const warning of emptyScopeWarnings(plan)) {
    const sure = await ask({
      title: "生成できなくなる区分があります。保存しますか？",
      lines: [warning.replace(/本当に保存しますか？$/, "").trim()],
      buttons: [{ label: "やめる", value: false }, { label: "それでも保存する", value: true, kind: "danger" }],
    });
    if (!sure || appClosed) return;
  }
  S.busy = true;
  S.modelSaving = true;
  renderModelsBox();
  let saved = false;
  try {
    // 保存の直前に読み直す（確認のダイアログの間に、ほかの管理者が変えていないか）。3 つの一覧のどれかが変わっていたら保存しない
    const fresh = await supabase.rpc("admin_get_settings");
    if (appClosed) return;
    if (fresh.error) {
      notify(`保存できませんでした。${explainError(fresh.error)}（変更は残してあります）`, "error");
      return;
    }
    const drift = changedScopes(fresh.data?.settings, S.models, roles);
    if (drift.length) {
      notify(`読み込んだあとに、ほかの管理者がモデルの設定（${drift.join("・")}）を変えたため、保存しませんでした。最新の設定を読み込み直しました。`, "error");
      S.busy = false;
      S.modelSaving = false;
      await loadSettingsAll();
      return;
    }
    for (const g of [gates.info, gates.models, gates.history]) g.invalidate();
    const { error } = await supabase.rpc("admin_update_settings", { p_changes: plan.changes });
    for (const g of [gates.info, gates.models, gates.history]) g.invalidate();
    if (appClosed) return;
    if (error) {
      notify(`保存できませんでした。${explainError(error)}（変更は残してあります）`, "error");
      S.busy = false;
      S.modelSaving = false;
      await loadSettingsAll();
      return;
    }
    saved = true;
    const on = plan.entries.reduce((n, e) => n + e.on.length, 0);
    const off = plan.entries.reduce((n, e) => n + e.off.length, 0);
    const where = roles ? `${plan.entries.map((e) => e.label).join("・")}：` : "";
    const read = await loadSettingsAll({ resetDraft: true });
    if (appClosed) return;
    S.modelsEditing = false;
    if (!read.models) notify(`モデルの設定を保存しました（${where}オン ${on} 件・オフ ${off} 件）。ただし、最新の一覧を読み直せませんでした。同じ変更を送り直す必要はありません。`, "warn");
    else notify(`モデルの設定を保存しました（${where}オン ${on} 件・オフ ${off} 件）。`, "ok", [], { label: "変更履歴を見る", onClick: openHistory });
  } finally {
    S.busy = false;
    S.modelSaving = false;
    if (!appClosed) {
      renderSettings();
      focusKey(saved ? "models-edit" : "models-save");
    }
  }
}

// ---- 設定：変更履歴（初めは閉じる。読むだけ） ----

function historySection() {
  const S = state.settings;
  let content;
  if (S.historyStatus === "ok") {
    const labelOfModel = S.models ? modelLabeler(S.models.models) : (id) => id;
    const shown = S.history.slice(0, S.historyShown);
    const rest = S.history.length - shown.length;
    content = [
      S.historyError ? staleLine(S.historyError, S.historyAt, retryHistory) : null,
      S.history.length
        ? el(
          "ol",
          { className: "history", "aria-label": "変更履歴" },
          ...shown.map((h) =>
            el(
              "li",
              {},
              el("span", { className: "hmeta num", text: `${formatDateTime(h.changed_at)} · ${h.changed_by_email ?? "変更した人は不明"}` }),
              el("ul", {}, ...settingsDiff(h.before_values, h.after_values, labelOfModel).map((t) => el("li", { text: t }))),
            )
          ),
        )
        : el("p", { className: "muted", text: "まだ変更はありません。" }),
      rest > 0
        ? el("button", {
          type: "button",
          className: "link-btn",
          text: `さらに表示（残り ${rest} 件）`,
          "data-focus-key": "history-more",
          onclick: () => {
            S.historyShown += 10;
            renderSettings();
          },
        })
        : null,
    ];
  } else if (S.historyStatus === "error") {
    content = [errorBox(S.historyError, retryHistory)];
  } else {
    content = [el("p", { className: "muted", text: "読み込み中…" })];
  }
  const d = el(
    "details",
    { className: "plain-fold", id: "history-fold", open: S.historyOpen || S.sub === "history" },
    el("summary", { "data-focus-key": "history" }, el("span", { text: "変更履歴" }), el("span", { className: "meta", text: "新しい順・直近 50 件" })),
    el("div", { className: "fold-in" }, ...content),
  );
  d.addEventListener("toggle", () => {
    S.historyOpen = d.open;
  });
  return el("section", { className: "box tight", "aria-label": "変更履歴" }, d);
}

/** 保存のお知らせの［変更履歴を見る］：設定の変更履歴を開いて、そこへ移る */
async function openHistory() {
  if (state.tab !== "settings" && !(await switchTab("settings"))) return;
  if (!(await switchSubtab("history"))) return;
  state.settings.historyOpen = true;
  renderSettings();
  $("history-fold")?.scrollIntoView({ block: "start" });
  focusKey("history");
}

// ---- 段階（016：セミナーの段階）----
// 回の枠を、Day ごとではなく「ワークショップごとの段階」にする。テンプレートを回に当て、講師を担当にする。
// 段階を進める・戻すのは講師の画面（instructor.html）。ここの書き込みはすべて DB の RPC（守りは DB が入れる）。
// DB が 016 を当てていない間（state.stages.available が false）は、このブロックの欄・操作を出さない。

function emptyStageState() {
  return {
    available: false,
    loaded: false,
    /** テンプレートの一覧（名前と段階）を最後に読めた時刻（ms）と、最後の読み込みの失敗 */
    templatesAt: null,
    templatesError: "",
    /** cohorts の新しい列：id → { id, credit_mode, stage_template_id, stages_applied_at } */
    cohortInfo: new Map(),
    stages: [],
    templates: [],
    templateItems: [],
    /** 回の講師の担当：{ cohort_id, email } */
    instructors: [],
    /** 回・受講者を開いたときに確かめた、削除できない理由の元（回の id → { hasEntries, hasGrants }・email → 段階の回の追加があるか） */
    cohortFlags: new Map(),
    memberFlags: new Map(),
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
  return state.stages.cohortFlags.get(id) ?? { hasEntries: false, hasGrants: false };
}

/** その回に、段階を動かした記録・段階の回の追加があるかを、その回だけ確かめる（全体を読まない）。読めなければ前の値のまま */
async function loadCohortFlags(id) {
  if (!stagesAvailable()) return;
  const ids = stagesOfCohort(id).map((s) => s.id);
  const [en, gr] = await Promise.all([
    supabase.from("cohort_stage_entries").select("cohort_id").eq("cohort_id", id).limit(1),
    ids.length ? supabase.from("credit_grants").select("id").in("stage_id", ids).limit(1) : { data: [] },
  ]);
  if (en.error || gr.error) return;
  state.stages.cohortFlags.set(id, { hasEntries: (en.data ?? []).length > 0, hasGrants: (gr.data ?? []).length > 0 });
}

/** その人に、段階の回の追加があるかを、その人だけ確かめる */
async function loadMemberFlag(email) {
  if (!stagesAvailable()) return false;
  const { data, error } = await supabase.from("credit_grants").select("id").eq("email", email).not("stage_id", "is", null).limit(1);
  if (!error) state.stages.memberFlags.set(email, (data ?? []).length > 0);
  return state.stages.memberFlags.get(email) ?? false;
}
const memberHasStageGrants = (email) => state.stages.memberFlags.get(email) ?? false;

/**
 * 段階の情報を読む。cohorts に新しい列（credit_mode など）が無ければ 016 の前の DB：available を false にして、何も出さない。
 * 読めなかった（通信の失敗など）ときは、前の値のまま
 */
async function loadStageInfo() {
  const S = state.stages;
  if (appClosed) return false;
  const ticket = gates.stages.begin();
  // 回の段階の情報と、ほかの 5 つ（段階・テンプレート・担当の講師・設定）は互いの答えを待たないので、まとめて並べて読む（ページを開く速さ 2026-10-23）。
  // 回の読み込みが失敗したときは、今までどおりほかの 5 つの答えは使わない
  const [c, st, tp, ti, ins, set] = await Promise.all([
    supabase.from("cohorts").select("id, credit_mode, stage_template_id, stages_applied_at"),
    supabase.from("cohort_stages").select("id, cohort_id, day_kind, seq, label, title, credits").order("seq"),
    supabase.from("stage_templates").select("id, name, note, active, updated_at").order("name"),
    supabase.from("stage_template_items").select("id, template_id, day_kind, seq, label, title, credits").order("seq"),
    supabase.from("cohort_instructors").select("cohort_id, email"),
    supabase.rpc("admin_get_settings"),
  ]);
  if (appClosed) return false;
  if (c.error) {
    if (!gates.stages.accept(ticket)) return true;
    if (isMissingSchemaError(c.error)) {
      Object.assign(S, emptyStageState(), { loaded: true });
      setStageDbReady(false);
      state.fresh.stages = { at: Date.now(), stale: false };
    } else {
      state.fresh.stages.stale = true;
    }
    return false;
  }
  if (!gates.stages.accept(ticket)) return true;
  S.available = true;
  S.loaded = true;
  setStageDbReady(true);
  S.cohortInfo = new Map((c.data ?? []).map((x) => [x.id, x]));
  if (!st.error) S.stages = st.data ?? [];
  if (!tp.error) S.templates = tp.data ?? [];
  if (!ti.error) S.templateItems = ti.data ?? [];
  // テンプレート（名前と段階）の読み込みの成功は、段階の情報全体とは別に持つ（一度も読めていないのに「前に読んだ値」「まだありません」と出さない）
  if (!tp.error && !ti.error) S.templatesAt = Date.now();
  S.templatesError = tp.error || ti.error ? explainError(tp.error || ti.error) : "";
  if (!ins.error) S.instructors = ins.data ?? [];
  if (!set.error) {
    S.limitT = set.data?.settings?.stage_grant_total_limit ?? 10000;
    // 円の目安のドル円（227）。起動・更新のたびにここで読む（設定の画面を開かなくても名簿・回の目安に効く）
    applyFxRate(set.data?.fx_usd_jpy);
  }
  const partial = [st, tp, ti, ins, set].some((x) => x.error);
  state.fresh.stages = partial ? { at: state.fresh.stages.at ?? null, stale: true } : { at: Date.now(), stale: false };
  return true;
}

/** 回の今の段階など（cohort_stage_status）を読む。読めなければ null（段階の欄に今の段階を出さないだけ） */
async function loadCohortStageStatus(id) {
  const { data, error } = await supabase.rpc("cohort_stage_status", { p_cohort_id: id });
  state.stages.status.set(id, error ? null : normalizeStageStatus(data));
}

/** 回の詳細に足す箱（016 が当たっているときだけ） */
function stageBoxes(c) {
  // 段階ごとの受け付けの終わり（提出。本体は admin-submissions.js）は、段階の設定が使えない回にも出す
  if (!stagesAvailable() || !cohortInfoOf(c.id)) return [submissionDeadlinesBox(c)];
  return [stagesSection(c), instructorsSection(c), submissionDeadlinesBox(c)];
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
      el("a", { className: "link-btn", href: "instructor", target: "_blank", rel: "noopener", text: "講師の画面を開く（別のタブ）" }),
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
      out.push(el("p", { className: "hint", text: "テンプレートがありません。［設定］→［テンプレート］で作ります。" }));
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

// ---- テンプレート（設定の画面。一覧 → 選ぶと読む欄（［変更］［削除］）→ 編集のシート） ----

/** テンプレートの編集のシートに、保存していない入力があるか（開いている間だけ関数が入る） */
let templateDirty = null;

function templateCounts(id) {
  const its = templateItemsOf(id);
  const count = (k) => its.filter((i) => i.day_kind === k).length;
  return `Day1 ${count("day1")} 段階・ブリッジワーク ${count("bridge")} 段階・Day2 ${count("day2")} 段階`;
}

function templatesSection() {
  const S = state.stages;
  const sel = state.settings.sel;
  const items = S.templates.map((t) => {
    const selected = sel?.kind === "template" && sel.id === t.id;
    return el(
      "li",
      { className: `set-li ${selected ? "is-selected" : ""}` },
      el(
        "button",
        {
          type: "button",
          className: "set-item",
          "aria-current": selected ? "true" : null,
          "data-focus-key": `tpl:${t.id}`,
          onclick: () => selectSetting({ kind: "template", id: t.id }),
        },
        el("span", { className: "set-name", text: t.name }),
        el(
          "span",
          { className: "set-line" },
          el("span", { className: "set-val num", text: templateCounts(t.id) }),
          el("span", { className: "set-target", text: t.active ? "回の候補に出す" : "回の候補に出さない" }),
        ),
      ),
    );
  });
  return el(
    "section",
    { className: "box", "aria-labelledby": "templates-h" },
    el(
      "div",
      { className: "box-head" },
      el("h3", { id: "templates-h", text: "段階テンプレート" }),
      el(
        "div",
        { className: "head-side" },
        el("button", { type: "button", className: "btn", text: "新しく作る", "data-focus-key": "tpl-new", disabled: state.settings.busy, onclick: () => openTemplateEditor(null) }),
      ),
    ),
    ...templatesBody(items),
  );
}

/** テンプレートの一覧の中身：一度も読めていない失敗は「読み込めませんでした」＋再試行、前に読めていれば「前に読んだ値」＋再試行 */
function templatesBody(items) {
  const S = state.stages;
  if (S.templatesAt === null) {
    if (S.templatesError || state.fresh.stages.stale) return [errorBox(`テンプレートの一覧を読み込めませんでした。${S.templatesError}`, retryStages)];
    return [el("p", { className: "muted", text: "読み込み中…" })];
  }
  return [
    S.templatesError || state.fresh.stages.stale ? staleLine(S.templatesError || "段階の情報を読めませんでした（通信の失敗など）。", S.templatesAt, retryStages) : null,
    items.length ? el("ul", { className: "set-rows", "aria-label": "段階テンプレート" }, ...items) : el("p", { className: "muted", text: "テンプレートがまだありません。" }),
  ];
}

/** 選んだテンプレートの読む欄：候補に出すか・メモ・各日の段階と合計・［変更］、一番下に分けて［削除］ */
function templatePanel(id) {
  const t = state.stages.templates.find((x) => x.id === id);
  if (!t) return { title: "テンプレート", body: [el("p", { className: "muted", text: "このテンプレートは見つかりません（削除された可能性があります）。" })], foot: [] };
  const items = templateItemsOf(id);
  const g = groupStagesByDay(items);
  const totals = dayTotals(items);
  const busy = state.settings.busy;
  return {
    title: t.name,
    body: [
      el("p", {}, el("span", { className: `badge ${t.active ? "ok" : "default"}`, text: t.active ? "回の候補に出す" : "回の候補に出さない" })),
      t.note ? el("p", { text: t.note }) : null,
      el(
        "ul",
        { className: "tpl-days" },
        ...DAY_KINDS.map((kind) =>
          el(
            "li",
            {},
            el("span", { className: "strong", text: DAY_KIND_LABELS[kind] }),
            el("span", { className: "credits", text: g[kind].length ? `合計 ${formatCredits(totals[kind])} クレジット` : "段階なし" }),
            g[kind].length
              ? el("ol", {}, ...g[kind].map((s) => el("li", {}, stageName(s), el("span", { className: "credits", text: `${formatCredits(s.credits)} クレジット` }))))
              : null,
          )
        ),
      ),
      el("p", { className: "hint", text: "テンプレートは、回の「段階」から当てます。変えても削除しても、すでに当てた回の段階は変わりません。" }),
      el(
        "details",
        { className: "plain-fold minor" },
        el("summary", {}, "詳しい情報"),
        el(
          "div",
          { className: "fold-in" },
          el("p", { className: "tech" }, "テンプレートの ID：", el("code", { text: t.id })),
          el("p", { className: "tech num", text: `最終更新：${formatShortDateTime(t.updated_at)}` }),
        ),
      ),
    ],
    foot: [
      el("button", { type: "button", className: "btn primary", text: "変更", "aria-label": `${t.name}を変更`, "data-focus-key": "panel-change", disabled: busy, onclick: () => openTemplateEditor(t) }),
    ],
    // 取り消せない操作は、欄の一番下に分けて置く
    after: [
      el(
        "div",
        { className: "danger-zone" },
        el("p", { className: "hint", text: "削除は取り消せません。すでに当てた回は変わりません。" }),
        el("button", { type: "button", className: "btn danger", text: "このテンプレートを削除", disabled: busy, onclick: () => deleteTemplate(t) }),
      ),
    ],
  };
}

/** テンプレートの編集（全部の幅でシート。段階の行の入力が右の欄には入りきらないため） */
function openTemplateEditor(t) {
  if (state.settings.busy) return;
  const items = t ? templateItemsOf(t.id) : [];
  const name = textInput({ maxlength: "60", placeholder: "例：標準（Day1 に 3 つ・Day2 に 2 つ）" });
  name.value = t?.name ?? "";
  const note = textInput({ placeholder: "例：2 日間の標準の型" });
  note.value = t?.note ?? "";
  const active = el("input", { type: "checkbox", checked: t ? t.active : true });
  const g = groupStagesByDay(items);
  const editors = Object.fromEntries(DAY_KINDS.map((k) => [k, rowsEditor(k, g[k], { canStructure: true })]));
  const snapshot = () => JSON.stringify([name.value, note.value, active.checked, DAY_KINDS.map((k) => editors[k].read())]);
  const first = snapshot();
  let saving = false;
  const saveBtn = el("button", {
    type: "button",
    className: "btn primary big",
    text: "保存",
    onclick: async () => {
      if (saving) return;
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        await saveTemplate(t, { name, note, active, editors });
      } finally {
        saving = false;
        if (saveBtn.isConnected) {
          saveBtn.disabled = false;
          saveBtn.textContent = "保存";
        }
      }
    },
  });
  openSheet("template-editor", () =>
    setSheet({
      title: t ? "テンプレートを変更" : "テンプレートを作る",
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
        el("p", { className: "hint", text: "1 つの段階の上限は 0〜10,000、1 日の合計は 10,000 までです。保存しても、すでに当てた回は変わりません。" }),
      ],
      foot: [saveBtn, cancelButton("やめる")],
    })
  );
  templateDirty = () => snapshot() !== first;
  // 閉じる・Esc・背景：保存していない入力があれば、編集を続けるか破棄するかを選んでもらう
  sheetGuard = async () => {
    if (saving) return false;
    if (templateDirty?.() && !(await askDiscard("テンプレートの入力"))) return false;
    return true;
  };
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
  state.settings.busy = true;
  gates.stages.invalidate();
  const { error } = await supabase.rpc("admin_save_stage_template", {
    p_template_id: t?.id ?? null,
    p_name: value.name,
    p_note: value.note,
    p_active: value.active,
    p_items: value.items,
  });
  gates.stages.invalidate();
  state.settings.busy = false;
  if (appClosed) return;
  if (error) {
    // シートは閉じず、入力を残す。捨てた段階の読み込みの代わりを読み直す（読み込み中のまま止めない）
    notify(`保存できませんでした。${explainError(error)}（入力は残してあります）`, "error");
    await loadStageInfo();
    if (!appClosed) renderSettings();
    return;
  }
  notify(`テンプレート「${value.name}」を保存しました。`);
  closeSheet();
  await refresh();
  focusKey(t ? `tpl:${t.id}` : "tpl-new");
}

async function deleteTemplate(t) {
  if (state.settings.busy) return;
  const ok = await ask({
    title: `テンプレート「${t.name}」を削除しますか？`,
    lines: ["削除は取り消せません。", "すでに当てた回は、段階の内容を持っているので変わりません。"],
    buttons: [{ label: "やめる", value: false }, { label: "削除する", value: true, kind: "danger" }],
  });
  if (!ok || appClosed) return;
  state.settings.busy = true;
  renderSettings();
  gates.stages.invalidate();
  const { error } = await supabase.rpc("admin_delete_stage_template", { p_template_id: t.id });
  gates.stages.invalidate();
  state.settings.busy = false;
  if (appClosed) return;
  if (error) {
    notify(`削除できませんでした。${explainError(error)}`, "error");
    await loadStageInfo();
    if (!appClosed) renderSettings();
    return;
  }
  notify(`テンプレート「${t.name}」を削除しました。`);
  // 消した対象の欄は閉じて、安全な入口（［新しく作る］）へ
  if (state.settings.sel?.kind === "template" && state.settings.sel.id === t.id) state.settings.sel = null;
  if (sheet.open) closeSheet();
  await refresh();
  focusKey("tpl-new");
}

// ---- アカウント（スマホは ☰、広い幅は右上の本人のボタンから。メール・部分ごとの確認の時刻・更新・ログアウト） ----

function openAccount() {
  openSheet("account", () => {
    // 部分ごとの時刻は、描くたびに読み直す（シートの中で更新したあとも新しい時刻を出す。Codex TASK-0092 F3）
    const parts = [
      ["名簿", tabParts("roster")],
      ["回", tabParts("cohorts")],
      ...(state.settings.status !== "idle" ? [["設定", tabParts("settings")]] : []),
    ];
    setSheet({
      title: "アカウント",
      body: [
        el(
          "dl",
          { className: "kv boxed num" },
          el("dt", { text: "ログイン中" }),
          el("dd", { text: myEmail }),
          ...parts.flatMap(([label, p]) => {
            const v = freshnessView(p);
            return [
              el("dt", { text: label }),
              el("dd", { text: `${v.text ?? (v.failed ? "読み込めていません" : "読み込み中…")}${v.stale ? "（一部は前に読んだ値）" : ""}` }),
            ];
          }),
        ),
      ],
      foot: [
        el("button", {
          type: "button",
          className: "btn primary big",
          text: "最新の状態を読み込む",
          "data-reload": "",
          onclick: async () => {
            if (refreshing > 0) return;
            clearNotice();
            await refresh();
            notify("最新の状態にしました。");
          },
        }),
        el("button", { type: "button", className: "btn big", text: "ログアウト", onclick: signOut }),
      ],
    });
  });
}

// ---- 起動 ----

async function main() {
  if (loginReturn.failed) {
    // 文言は誰でも書き換えられるので、URL の内容は表示しない
    try {
      sessionStore?.removeItem(ADMIN_LOGIN_FLOW_KEY);
    } catch {
      // 無視
    }
    fatal("ログインできませんでした。管理者の Google アカウントでログインし直してください。");
    $("status").append(
      el("button", { type: "button", className: "gsi-btn", onclick: signIn }, el("span", { className: "gsi-g", "aria-hidden": "true" }), el("span", { className: "gsi-label", text: "Google でログイン" })),
    );
    return;
  }
  if (loginReturn.code) {
    // Google から戻った：admin-api でサーバーが交換・登録する（登録できたときだけトークンが来る）
    $("status").replaceChildren(el("p", { className: "muted", text: "ログインしています…" }));
    show("status");
    const done = await finishSignIn(loginReturn.code);
    if (done.error) {
      showLoginNote(done.error);
      show("login");
      return;
    }
    setConsoleExpiry(done.expiresAt);
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
  // 開くたびに、サーバーの登録（管理コンソールのログインの流れで作ったセッションか・12 時間の内か）を読む。登録のやり直しの口は無い
  // （開き直し・トークンの更新で 12 時間は延びない）。管理コンソールのセッションでなければログアウトして、ログインからやり直す
  const st = await consoleStatus();
  if (st.error) {
    fatal(`ログインの状態を確認できませんでした。${explainError(st.error)}`);
    return;
  }
  if (st.stale) {
    // 確かめている間に、ほかのタブでログインし直した：今の保存先で、開き直す
    location.replace(returnUrl());
    return;
  }
  if (!st.admin || st.expiresAt === null) {
    await closeConsole(
      loginReturn.code
        ? "ログインを確かめられませんでした。もう一度ログインしてください。"
        : `管理コンソールのログインが終わっているか、ログインしてから ${ADMIN_SESSION_LIMIT_MS / 3600000} 時間たちました。もう一度ログインしてください。`,
      st.identity,
    );
    return;
  }
  setConsoleExpiry(st.expiresAt, st.identity);
  if (await logoutIfExpired()) return;
  startExpireWatch(session.user?.id ?? null);

  // 起動の途中でも期限監視は動く。await のたびに、閉じていないか・起動時のセッションのままかを確かめ、だめなら表示も読み込みもせずやめる
  // （閉じたあとに遅い応答が戻って、閉じた画面を開き直したり、読み込みを始めたりしない。F185-01）
  const bootAborted = () => {
    if (appClosed) return true;
    if (!sameIdentity(currentIdentity(), st.identity)) {
      // 起動の間に、ほかのタブでログインし直した：今の保存先で、開き直す
      location.replace(returnUrl());
      return true;
    }
    return false;
  };
  if (bootAborted()) return;

  // 「自分」の判定は DB と同じく Google の ID 連携の email で行う（auth.users の email とは異なる場合がある）。
  // メールと管理者の確かめは互いの答えを待たないので、並べて読む（どちらも読むだけ。答えを使うのは両方がそろって bootAborted を照らしたあと。
  // 管理コンソールのセッションの確かめ〔consoleStatus〕と期限の確かめは、今どおりこの前に済ませる。ページを開く速さ 2026-10-23）
  const [{ data: googleEmail }, { data: isAdmin, error: adminError }] = await Promise.all([
    supabase.rpc("current_google_email"),
    supabase.rpc("is_admin"),
  ]);
  if (bootAborted()) return;
  const email = normalizeEmail(googleEmail ?? session.user.email ?? "");
  myEmail = email;
  if (adminError) {
    fatal(`権限を確認できませんでした。${explainError(adminError)}`);
    return;
  }
  if (!isAdmin) {
    $("denied-email").textContent = session.user.email ?? "";
    show("denied");
    return;
  }

  // 画面の間の移動：is_admin() が true のときだけここに来るので、管理者の並び（案内だけ）
  renderSiteNav($("site-nav"), "admin", "admin");
  // ［ワークショップの案内］（docs/design-workshop-guide.md 4.6。束 K の K3。G の独立の差分）：左のメニューに［案内］を足す。
  // 動的な import にして待たないので、読み込めない・失敗しても［案内］が出ないだけで、admin.js のほかの画面は止まらない。
  // 管理コンソールを閉じたら（clearAppView の appClosed）、部品が自分で窓とボタンと読んだ中身を消す
  import("./admin-workshop.js")
    .then(({ mountWorkshopGuide }) => mountWorkshopGuide({ supabase, menu: $("side-menu"), isClosed: () => appClosed }))
    .catch((e) => console.error("ワークショップの案内を読み込めませんでした", e));
  // ヘッダーにメールは出さない（2026-10-23 田口さん：説明の文字は消す）。アカウントのボタンの読み上げの名前とシートにある
  $("account-btn").setAttribute("aria-label", `アカウントと更新（${myEmail}）`);
  show("app");
  renderAll();
  // ［fal の確かめ］（docs/design-fal-price-watch.md 3.7。P の独立の差分）：管理者の確認のあとに、画面の上に常設の 1 行と帯を差し込む。
  // 動的な import にして待たないので、読み込めない・失敗しても fal の画面が出ないだけで、admin.js のほかの画面は止まらない。
  // 管理コンソールを閉じたら（clearAppView の appClosed）、部品が自分で窓と読んだ中身を消す
  import("./admin-fal-watch.js")
    .then(({ mountFalWatch }) =>
      mountFalWatch({ supabase, host: document.querySelector("main.content"), isClosed: () => appClosed })
    )
    .catch((e) => console.error("fal の確かめを読み込めませんでした", e));
  await Promise.all([loadUsage(), loadCohorts(), loadStageInfo()]);
  if (appClosed) return;
  renderAll();
}

// アカウントのボタン・左のメニューのアイコン（形は site-nav.js）
fillIcons();
$("login-btn").addEventListener("click", signIn);
$("denied-logout-btn").addEventListener("click", signOut);
$("reload-btn").setAttribute("data-reload", "");
$("reload-btn").addEventListener("click", onReload);
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
// 設定の右の欄（1,100px 以上）とシートの切り替え。選択と編集の下書きは state にあるので、閉じても消えない
for (const t of SETTINGS_SUBTABS) {
  const b = $(`subtab-${t.key}`);
  b.addEventListener("click", () => switchSubtab(t.key));
  b.addEventListener("keydown", (e) => {
    const to = subtabByKey(state.settings.sub, e.key);
    if (!to) return;
    e.preventDefault();
    switchSubtab(to, { focusTab: true });
  });
}
wideMq.addEventListener("change", () => {
  if (sheet.open && sheetKind === "setting" && isWide()) closeSheet();
  renderSettings();
});
// 設定の Esc（シート・ダイアログが無いとき）：上から 1 つずつ（編集をやめる → 右の欄を閉じる・選択を外す）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  if (sheet.open || askEl.open || state.tab !== "settings" || appClosed) return;
  const S = state.settings;
  if (S.busy) return;
  if (S.edit && isWide()) {
    e.preventDefault();
    cancelEdit();
  } else if (S.sel) {
    e.preventDefault();
    closeSelection();
  }
});
/**
 * 帯（site-nav）の同じタブのリンク（マイページ・講師ページ）：保存していない設定の変更があれば、ブラウザの移動を止めて、
 * タブを替えるときと同じ画面内の確かめ（confirmLeaveSettings）を通す。［破棄して移る］なら下書きを捨ててから移る。
 * iPhone の Safari は beforeunload を出さないので、これが無いと黙って消える。別のタブで開くもの（Canvas）・修飾キー付きの押し方
 * （新しいタブ・ウィンドウで開く）は、この画面が残るので止めない
 */
async function onSiteNavClick(e) {
  const a = e.target?.closest?.("a[href]");
  if (!a || a.target === "_blank") return;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (appClosed) return;
  // 設定の保存の結果を待っている間は、保存していない変更の有無より先に止める（送った保存は破棄できない。下書きのないリセットも。
  // タブを替えるとき〔switchTab〕と同じ。Codex TASK-0189 F189-01）
  if (state.settings.busy) {
    e.preventDefault();
    notify("設定の保存の結果を待っています。終わってから移ってください。");
    return;
  }
  if (!unsavedSettings().length) return;
  e.preventDefault();
  if (!(await confirmLeaveSettings())) return;
  location.assign(a.href);
}
$("site-nav").addEventListener("click", onSiteNavClick);

// 保存していない設定の変更があるまま、ページを離れる・閉じるときは知らせる（ブラウザの確かめ）
window.addEventListener("beforeunload", (e) => {
  if (appClosed || !unsavedSettings().length) return;
  e.preventDefault();
  e.returnValue = "";
});

main().catch((e) => fatal(`エラーが発生しました：${e?.message || e}`));
