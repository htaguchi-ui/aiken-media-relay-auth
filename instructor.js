// 講師の画面。担当する回の「段階」を進める・戻す、受講者の使用量を見る、一時追加と自分の追加の取り消しを、本人のログインで行う。
// 書き込みはすべて DB の RPC（cohort_stage_move・instructor_grant・revoke_stage_grant。権限・上限・段階の判定は DB が決める）。
// ログインの守りはマイページ（mypage.js）と同じ作り：保存はこのタブの間だけ（sessionStorage）・30 分操作しなければログアウト・
// 画面を離れたらログアウト（再読み込みだけは自動でログインし直す）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// supabase-js は instructor.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
import {
  browserStorage,
  clearStoredSession,
  idleExpired,
  INSTRUCTOR_ACTIVITY_KEY,
  INSTRUCTOR_IDLE_LIMIT_MS,
  INSTRUCTOR_RELOAD_GRACE_MS,
  INSTRUCTOR_RELOAD_HINT_KEY,
  INSTRUCTOR_STORAGE_KEY,
  LEGACY_STORAGE_PREFIX,
  storedAccessToken,
} from "./auth-storage.js";
import {
  clearStaleSession,
  decideOnOpen,
  hadActiveSession,
  MSG_CODE_FAILED,
  parseReloadHint,
} from "./mypage-lib.js";
import {
  cohortStatus,
  explainError,
  formatCredits,
  formatShortDateTime,
  isStageSchemaMissing,
  MSG_STAGE_NOT_READY,
  setStageDbReady,
  normalizeEmail,
  rejectionName,
  usagePct,
  isLow,
} from "./admin-lib.js";
import {
  grantAvailability,
  grantConfirmText,
  instructorCohortLabel,
  instructorGrantPlan,
  moveConfirmText,
  normalizeInstructorCohorts,
  normalizeStageStatus,
  parseStageGrantCredits,
  revocableGrants,
  revokedGrants,
  REVOKE_CONFIRM_TEXT,
  stageMoveView,
  stageName,
  undoView,
} from "./stage-lib.js";

// 他のサイトに埋め込まれて操作させられるのを防ぐ（マイページ・管理コンソールと同じ）
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("講師の画面は埋め込みでは使えません");
}

const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
// 公開用のキー（ブラウザに置く前提のもの）。秘密鍵ではない。consent.html・admin.js・mypage.js と同じ値
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN";

const $ = (id) => document.getElementById(id);
const SECTIONS = ["status", "login", "denied", "failed", "app"];

function show(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

// 研修用の Mac にログインを残さない：保存はこのタブの間だけ（sessionStorage）、ほかの画面とは別の鍵。
// 以前の版が localStorage に残したセッションは、開いた時点で消す
const sessionStore = browserStorage("session");
clearStoredSession(browserStorage("local"), LEGACY_STORAGE_PREFIX);

/** この端末のセッションだけをサーバーで無効にする（keepalive。失敗しても先へ進む。global だと本人の ChatGPT・Codex・Claude Code の接続まで切れる） */
function sendLocalLogout(token) {
  if (!token) return;
  try {
    fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: "POST",
      keepalive: true,
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  } catch {
    // 送れなくても、タブの保存先は呼び出し側で消す
  }
}

// ページを開いた時点（マイページと同じ手順）：保存先に残っているセッションがあれば、この端末だけのログアウトを送って消す
// （?code 付きのときは、Google の往復に要る code verifier と操作時刻だけ残す）。再読み込みの手がかりと開き方から、
// "code"（Google から戻った）・"relogin"（再読み込み。Google のログインを自動でやり直す）・"login"（ログイン前の画面）を決める
const openDecision = (() => {
  const hasCode = !!new URLSearchParams(location.search).get("code");
  sendLocalLogout(storedAccessToken(sessionStore, INSTRUCTOR_STORAGE_KEY));
  clearStaleSession(sessionStore, INSTRUCTOR_STORAGE_KEY, INSTRUCTOR_ACTIVITY_KEY, hasCode);
  let raw = null;
  try {
    raw = sessionStore?.getItem(INSTRUCTOR_RELOAD_HINT_KEY) ?? null;
    sessionStore?.removeItem(INSTRUCTOR_RELOAD_HINT_KEY);
  } catch {
    // 読めなければ、手がかりが無い扱い（ログイン前の画面）
  }
  const nav = typeof performance?.getEntriesByType === "function" ? performance.getEntriesByType("navigation")[0] : null;
  return decideOnOpen({
    hasCode,
    navType: nav?.type ?? null,
    hint: parseReloadHint(raw),
    now: Date.now(),
    graceMs: INSTRUCTOR_RELOAD_GRACE_MS,
  });
})();

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない（自動のログインもしない）
if (typeof window.supabase?.createClient !== "function") {
  $("status").textContent = "画面の部品を読み込めませんでした。通信状態を確認して、ページを開き直してください。";
  throw new Error("supabase-js を読み込めませんでした");
}

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    storageKey: INSTRUCTOR_STORAGE_KEY,
    ...(sessionStore ? { storage: sessionStore } : {}),
  },
});

function returnUrl() {
  return location.origin + location.pathname;
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

// 講師の画面は 016 の DB でだけ働く（016 の前は「まだ使えません」）。DB の日本語の hint をそのまま出す
setStageDbReady(true);

/** 画面の状態 */
const state = {
  myEmail: "",
  isAdmin: false,
  /** 担当する回の一覧（normalizeInstructorCohorts） */
  cohorts: [],
  cohortId: null,
  /** cohort_stage_status を読んだもの（normalizeStageStatus）。null は未読込 */
  status: null,
  statusError: "",
  /** 操作の通信中（二重に押させない） */
  busy: false,
  /** 追加の相手に選んだ受講者の email */
  selected: new Set(),
  /** 追加の入力欄の値（描き直しても残す） */
  creditsText: "",
  noteText: "",
};

// ---- ログイン・ログアウト ----

let leavingForLogin = false;

async function signIn() {
  // Google のログインへ移るときは、戻ったときに要る PKCE の code_verifier と時刻の記録を残す（pagehide で消さない）
  leavingForLogin = true;
  markActive(true);
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: returnUrl(), queryParams: { prompt: "select_account" } },
  });
}

/** ログアウトして、タブに残る分（セッション・最後の操作の時刻）も消す（通信できなくても消す） */
async function endSession() {
  try {
    // この端末のセッションだけを切る（global だと、本人の ChatGPT・Codex・Claude Code の接続まで切れる）
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // 下で消す
  }
  clearStoredSession(sessionStore, INSTRUCTOR_STORAGE_KEY);
}

/** 本人のデータを画面から消して、読み込み中の表示にする（ログアウトの通信を待つ間・画面を離れるときに、前の人の画面を残さない） */
function hideContent(message = "ログアウトしています…") {
  $("me-email").textContent = "";
  $("me-email").removeAttribute("title");
  $("me-role").textContent = "";
  $("denied-email").textContent = "";
  $("view").replaceChildren();
  $("notice").replaceChildren();
  $("confirm").close?.();
  $("confirm").replaceChildren();
  stopUndoTimer();
  state.status = null;
  state.cohorts = [];
  state.cohortId = null;
  state.selected.clear();
  state.creditsText = "";
  state.noteText = "";
  $("status").replaceChildren(el("p", { className: "muted", text: message }));
  show("status");
}

async function signOut() {
  stopIdleWatch();
  hideContent();
  await endSession();
  location.replace(returnUrl());
}

function showLoginNote(text) {
  $("login-note").textContent = text;
  $("login-note").hidden = !text;
}

// ---- 操作が無いときのログアウト（30 分。マイページ・管理コンソールと同じ） ----

let lastActiveWrite = 0;
let idleTimer = null;
let idleListening = false;

/** 操作したことを記録する（書き込みは 15 秒に 1 回まで） */
function markActive(force = false) {
  const now = Date.now();
  if (!force && now - lastActiveWrite < 15000) return;
  lastActiveWrite = now;
  try {
    sessionStore?.setItem(INSTRUCTOR_ACTIVITY_KEY, String(now));
  } catch {
    // 記録できなくても続ける
  }
}

function lastActive() {
  try {
    return sessionStore?.getItem(INSTRUCTOR_ACTIVITY_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 30 分操作が無ければログアウトして、ログインの画面に戻す。ログアウトしたら true */
async function logoutIfIdle() {
  const last = lastActive();
  if (!idleExpired(last, Date.now(), INSTRUCTOR_IDLE_LIMIT_MS)) return false;
  stopIdleWatch();
  hideContent();
  await endSession();
  showLoginNote(
    last === null
      ? "ログインの記録を確かめられなかったため、ログアウトしました。もう一度ログインしてください。"
      : `${INSTRUCTOR_IDLE_LIMIT_MS / 60000} 分間操作が無かったため、ログアウトしました。`,
  );
  show("login");
  return true;
}

function startIdleWatch() {
  markActive(true);
  if (!idleListening) {
    idleListening = true;
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "input"]) {
      document.addEventListener(type, () => markActive(), { capture: true, passive: true });
    }
    // スリープ・背面のタブではタイマーが遅れるので、前に出たときにも確かめる
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && idleTimer) logoutIfIdle();
    });
  }
  if (!idleTimer) idleTimer = setInterval(logoutIfIdle, 30000);
}

function stopIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

// ---- お知らせ ----

const NOTICE_MAX = 3;

function notify(message, kind = "ok", details = []) {
  const box = $("notice");
  const node = el(
    "div",
    { className: `toast ${kind}`, ...(kind === "ok" ? {} : { role: "alert" }) },
    el(
      "div",
      {},
      el("p", { text: message }),
      details.length ? el("ul", {}, ...details.map((d) => el("li", { text: d }))) : null,
    ),
    el("button", { type: "button", className: "btn compact", text: "閉じる", onclick: () => node.remove() }),
  );
  box.append(node);
  while (box.children.length > NOTICE_MAX) box.firstElementChild.remove();
  if (kind === "ok") setTimeout(() => node.remove(), 6000);
}

function clearNotice() {
  $("notice").replaceChildren();
}

// ---- 確認のダイアログ（既定は「やめる」） ----

/**
 * 確認を出す。「やめる」が最初にフォーカスされ、Esc でもやめる。続けるなら true。
 * 押されたボタンで直接決める（close イベントの returnValue は、続けて開き直したときに前のダイアログの分と取り違える）
 */
function confirmDialog({ title, lines, okText }) {
  const dialog = $("confirm");
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const finish = (value) => {
      if (ctl.signal.aborted) return;
      ctl.abort();
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const cancel = el("button", { type: "button", className: "btn big", text: "やめる", autofocus: true, onclick: () => finish(false) });
    const ok = el("button", { type: "button", className: "btn primary big", text: okText, onclick: () => finish(true) });
    dialog.replaceChildren(
      el("div", { className: "confirm-body" }, el("h2", { id: "confirm-title", text: title }), ...lines.map((t) => el("p", { text: t })), el("div", { className: "row" }, cancel, ok)),
    );
    // Esc は、閉じる前に止めて、やめるとして扱う
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    }, { signal: ctl.signal });
    dialog.showModal();
    cancel.focus();
  });
}

// ---- 読み込み ----

/** RPC を呼ぶ。返り値は { data, error } */
function rpc(name, args) {
  return supabase.rpc(name, args);
}

/** 画面に出す失敗（読み込みの失敗）：どの画面にするかを決める */
function loadFailure(error) {
  if (rejectionName(error) === "instructor_only" || String(error?.code) === "42501") return { action: "denied" };
  if (isStageSchemaMissing(error)) return { action: "failed", message: `講師の画面は、まだ使えません。${MSG_STAGE_NOT_READY}` };
  return { action: "failed", message: explainError(error) };
}

async function loadCohorts() {
  const { data, error } = await rpc("instructor_cohorts");
  if (error) return { error };
  state.cohorts = normalizeInstructorCohorts(data);
  if (!state.cohorts.some((c) => c.id === state.cohortId)) state.cohortId = state.cohorts[0]?.id ?? null;
  return {};
}

/** cohort_stage_status の読み込みの通し番号。古い応答（あとから始めた読み込み・操作のあとに返ってきたもの）は捨てる */
let statusSeq = 0;

async function loadStatus() {
  if (!state.cohortId) {
    state.status = null;
    state.statusError = "";
    return true;
  }
  const requested = state.cohortId;
  const seq = ++statusSeq;
  const { data, error } = await rpc("cohort_stage_status", { p_cohort_id: requested });
  if (requested !== state.cohortId) return true; // 読み込み中に回を切り替えた
  if (seq !== statusSeq) return true; // 古い応答（その間に、もっと新しい読み込みか操作があった）
  if (error) {
    state.statusError = explainError(error);
    return false;
  }
  state.status = normalizeStageStatus(data);
  state.statusError = "";
  // 選んだ受講者のうち、もう受講者一覧に無い・停止した人は外す
  const active = new Set(state.status.students.filter((s) => s.active).map((s) => s.email));
  for (const email of [...state.selected]) if (!active.has(email)) state.selected.delete(email);
  return true;
}

let loading = false;

/** 読み込んで画面を切り替える。初回（読み込み中の画面）と「最新にする」の両方で使う */
async function load({ fromApp = false } = {}) {
  if (loading) return;
  loading = true;
  if (!fromApp) {
    $("status").replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    show("status");
  }
  try {
    if (!fromApp) {
      const { data } = await rpc("is_admin");
      state.isAdmin = data === true;
      const { data: googleEmail } = await rpc("current_google_email");
      const { data: sessionData } = await supabase.auth.getSession();
      state.myEmail = normalizeEmail(googleEmail ?? sessionData?.session?.user?.email ?? "");
    }
    const c = await loadCohorts();
    if (c.error) {
      const f = loadFailure(c.error);
      if (f.action === "denied") {
        const { data } = await supabase.auth.getSession();
        $("denied-email").textContent = data?.session?.user?.email ?? "";
        show("denied");
      } else if (!fromApp || !state.cohorts.length) {
        $("failed-message").textContent = f.message;
        show("failed");
      } else {
        notify(`読み込み直せませんでした。${f.message}`, "error");
      }
      return;
    }
    const ok = await loadStatus();
    if (!ok && fromApp) notify(`最新の状態を読み込めませんでした。${state.statusError}`, "error");
    $("me-email").textContent = state.myEmail;
    $("me-email").title = state.myEmail;
    const role = $("me-role");
    role.textContent = state.isAdmin ? "管理者" : "講師";
    role.className = `badge ${state.isAdmin ? "admin" : "instructor"}`;
    render();
    show("app");
  } finally {
    loading = false;
  }
}

/** 操作のあと：段階と受講者の最新を読み直して描き直す */
async function reloadStatus() {
  const ok = await loadStatus();
  if (!ok) notify(`最新の状態を読み込めませんでした。${state.statusError}`, "error");
  render();
}

// ---- 表示 ----

let undoTimer = null;

function stopUndoTimer() {
  if (undoTimer) clearInterval(undoTimer);
  undoTimer = null;
}

function render() {
  const view = $("view");
  if (!state.cohorts.length) {
    stopUndoTimer();
    view.replaceChildren(
      el(
        "section",
        { className: "card" },
        el("h2", { text: "担当する回" }),
        el("p", { text: "担当する回がありません。" }),
        el("p", { className: "hint", text: "担当の登録は、管理者が管理コンソールの回の画面で行います。" }),
      ),
    );
    return;
  }
  const parts = [cohortCard()];
  const s = state.status;
  if (!s) {
    parts.push(
      el(
        "section",
        { className: "card" },
        state.statusError ? el("p", { className: "error-text", text: state.statusError }) : el("p", { className: "muted", text: "読み込み中…" }),
        state.statusError ? el("button", { type: "button", className: "btn", text: "読み込み直す", onclick: () => reloadStatus() }) : null,
      ),
    );
  } else if (s.creditMode !== "stage") {
    parts.push(
      el(
        "section",
        { className: "card" },
        el("h2", { text: "段階" }),
        el("p", { text: "この回は、段階ごとの枠になっていません（Day ごとの枠です）。段階の操作はできません。" }),
        el("p", { className: "hint", text: "テンプレートを当てるのは、管理者が管理コンソールで行います。" }),
      ),
    );
  } else {
    parts.push(stageCard(s), studentsCard(s), grantCard(s));
  }
  view.replaceChildren(...parts);
  updateUndoTimer();
  updateGrantButton();
}

function cohortCard() {
  const s = state.status;
  const cs = s?.period ? cohortStatus(s.period) : null;
  const picker = state.cohorts.length > 1
    ? el(
      "div",
      {},
      el("label", { className: "field-label", for: "cohort-select", text: "回を選ぶ" }),
      (() => {
        const select = el(
          "select",
          { className: "input tabular", id: "cohort-select" },
          ...state.cohorts.map((c) => el("option", { value: c.id, text: instructorCohortLabel(c), selected: c.id === state.cohortId })),
        );
        select.addEventListener("change", () => {
          state.cohortId = select.value;
          state.status = null;
          state.statusError = "";
          state.selected.clear();
          render();
          loadStatus().then(render);
        });
        return select;
      })(),
    )
    : el("p", { className: "tabular", text: instructorCohortLabel(state.cohorts.find((c) => c.id === state.cohortId) ?? {}) });
  return el(
    "section",
    { className: "card", "aria-labelledby": "cohort-h" },
    el(
      "div",
      { className: "card-head" },
      el("h2", { id: "cohort-h", text: "担当する回" }),
      el("div", { className: "row-actions" }, cs ? el("span", { className: `badge ${cs.kind === "active" ? "now" : "off"}`, text: cs.label }) : null,
        el("button", {
          type: "button",
          className: "btn compact",
          text: "最新にする",
          disabled: state.busy,
          onclick: async () => {
            clearNotice();
            await load({ fromApp: true });
          },
        })),
    ),
    picker,
  );
}

function stageCard(s) {
  const mv = stageMoveView(s);
  const undo = undoView(s, Date.now());
  const list = el(
    "ol",
    { className: "stage-list", "aria-label": "今日の段階" },
    ...s.stagesToday.map((st) =>
      el(
        "li",
        { className: st.id === s.current?.id ? "current" : "" },
        el("span", { className: "name" }, el("span", { text: stageName(st) }), st.id === s.current?.id ? el("span", { className: "badge now", text: "今" }) : null),
        el("span", { className: "credits tabular", text: st.credits === null ? "—" : `上限 ${formatCredits(st.credits)}` }),
      )
    ),
  );
  const move = (direction) => moveStage(direction, mv, s);
  return el(
    "section",
    { className: "card", "aria-labelledby": "stage-h" },
    el("h2", { id: "stage-h", text: "段階" }),
    el(
      "div",
      { className: "stage-now" },
      el("span", { className: "label", text: "今の段階" }),
      el("span", { className: "name", id: "stage-current", text: mv.current ? stageName(mv.current) : "—" }),
    ),
    s.stagesToday.length ? list : null,
    undo.available
      ? el(
        "div",
        { className: "undo-box", id: "undo-box" },
        el("span", { text: undoText(undo) }),
        el("button", {
          type: "button",
          className: "btn",
          text: "取り消す（前の段階に戻す）",
          disabled: state.busy,
          onclick: () => undoMove(undo, s),
        }),
      )
      : null,
    el(
      "div",
      { className: "move-row" },
      el("button", { type: "button", className: "btn big", id: "move-back", text: "前へ戻す", disabled: state.busy || !mv.canPrev, title: mv.canPrev ? null : mv.prevWhy, onclick: () => move("back") }),
      el("button", { type: "button", className: "btn primary big", id: "move-next", text: "次へ進める", disabled: state.busy || !mv.canNext, title: mv.canNext ? null : mv.nextWhy, onclick: () => move("next") }),
    ),
    !mv.canPrev || !mv.canNext
      ? el("p", { className: "hint", text: mv.whyOff || [mv.canPrev ? "" : mv.prevWhy, mv.canNext ? "" : mv.nextWhy].filter(Boolean).join(" ") })
      : null,
    el("p", { className: "hint", text: "段階を動かすと、この回の受講者全員が、移った先の段階の上限で使います。移れるのは、今日の段階の中だけです。" }),
  );
}

/** 取り消しの案内の文（残りの秒数を含む） */
function undoText(undo) {
  return `段階を移しました。あと ${undo.remainingSec} 秒は、前の段階に戻せます。${
    undo.jobsSince === null ? "" : `この間の生成：${formatCredits(undo.jobsSince)} 件（その分は移った先の段階に残ります）。`
  }`;
}

/** 取り消せる間に、段階と「この間の生成」の件数を読み直す間隔（秒） */
const UNDO_POLL_SEC = 10;

/**
 * 取り消せる間だけ、1 秒ごとに残りの秒数の文を書き換える（入力中の欄を作り直さない）。
 * 時間は、読み込んだときのサーバーとの時刻の差を足した今の時刻で数え（undoView）、60 秒を過ぎたら描き直してボタンを消す。
 * 10 秒ごとに cohort_stage_status を読み直し、「この間の生成」の件数も新しくする
 */
function updateUndoTimer() {
  const s = state.status;
  if (!s || !undoView(s, Date.now()).available) {
    stopUndoTimer();
    return;
  }
  if (undoTimer) return;
  let ticks = 0;
  undoTimer = setInterval(async () => {
    ticks++;
    if (ticks % UNDO_POLL_SEC === 0 && !state.busy) {
      const before = { current: state.status?.current?.id ?? null, selected: state.selected.size };
      await loadStatus();
      // 今の段階が変わった（ほかの人が動かした）・選んだ人が記録から外れたときだけ、画面を描き直す（チェックと人数を合わせる）
      if ((state.status?.current?.id ?? null) !== before.current || state.selected.size !== before.selected) {
        render();
        return;
      }
    }
    const undo = state.status ? undoView(state.status, Date.now()) : { available: false };
    if (!undo.available) {
      // 60 秒が過ぎた：画面全体は描き直さず、取り消しの箱だけを消す（入力中の欄のフォーカスを外さない）
      stopUndoTimer();
      document.getElementById("undo-box")?.remove();
      return;
    }
    const text = document.querySelector("#undo-box > span");
    if (text) text.textContent = undoText(undo);
  }, 1000);
}

function studentsCard(s) {
  const rows = [...s.students].sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity) || (a.name ?? a.email).localeCompare(b.name ?? b.email, "ja"));
  const activeEmails = rows.filter((r) => r.active).map((r) => r.email);
  const allOn = activeEmails.length > 0 && activeEmails.every((e) => state.selected.has(e));
  const items = rows.map((r) => {
    const cb = el("input", { type: "checkbox", checked: r.active && state.selected.has(r.email), disabled: !r.active, "data-email": r.email });
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(r.email);
      else state.selected.delete(r.email);
      updateGrantButton();
    });
    const pct = r.limit !== null && r.used !== null ? usagePct(r.used, r.limit) : 0;
    const low = r.remaining !== null && r.limit !== null && isLow(r.remaining, r.limit);
    return el(
      "li",
      {},
      el(
        "label",
        { className: r.active ? "" : "disabled" },
        cb,
        el(
          "span",
          { className: "who" },
          el("span", { className: "ellipsis", text: r.name ?? r.email }),
          r.name ? el("span", { className: "small muted ellipsis tabular", text: r.email }) : null,
          el("span", { className: "last", text: `最終生成 ${formatShortDateTime(r.lastUsedAt)}${r.active ? "" : "・利用停止中"}` }),
        ),
        el(
          "span",
          { className: "quota tabular" },
          el("span", { className: `rem ${low ? "low" : ""}`, text: r.remaining === null ? "残り —" : `残り ${formatCredits(r.remaining)}` }),
          el("span", { className: "small muted", text: `使用 ${formatCredits(r.used)} / ${formatCredits(r.limit)}` }),
          r.limit !== null ? el("span", { className: `bar ${low ? "low" : ""}`, role: "img", "aria-label": `使用 ${pct}%` }, el("span", { style: `width:${pct}%` })) : null,
        ),
      ),
    );
  });
  return el(
    "section",
    { className: "card", "aria-labelledby": "students-h" },
    el(
      "div",
      { className: "card-head" },
      el("h2", { id: "students-h", text: "受講者" }),
      el("button", {
        type: "button",
        className: "btn compact",
        text: allOn ? "選択を外す" : "全員を選ぶ",
        disabled: !activeEmails.length,
        onclick: () => {
          for (const e of activeEmails) {
            if (allOn) state.selected.delete(e);
            else state.selected.add(e);
          }
          render();
        },
      }),
    ),
    el("p", { className: "hint", text: "今の段階の使用と上限です。クレジットを追加する人にチェックを付けます。" }),
    items.length ? el("ul", { className: "students", "aria-label": "受講者" }, ...items) : el("p", { className: "muted", text: "この回に所属している受講者がいません。" }),
  );
}

function limitItems(s) {
  const l = s.limits;
  const items = [];
  if (!state.isAdmin) {
    if (l.perGrant !== null) items.push(["1 回に追加できる上限", `${formatCredits(l.perGrant)} クレジット`]);
    if (l.perStudentStage !== null) items.push(["1 人・この段階への追加の合計の上限", `${formatCredits(l.perStudentStage)} クレジット`]);
    if (l.perCohortDay !== null) {
      items.push([
        "今日この回に追加できる合計",
        l.cohortDayTotal === null
          ? `上限 ${formatCredits(l.perCohortDay)} クレジット`
          : `${formatCredits(l.cohortDayTotal)} / ${formatCredits(l.perCohortDay)} クレジット（あと ${formatCredits(Math.max(0, l.perCohortDay - l.cohortDayTotal))}）`,
      ]);
    }
  }
  if (l.total !== null) items.push(["1 人あたり、この回の追加の合計の上限", `${formatCredits(l.total)} クレジット（取り消した追加も数えます）`]);
  return items;
}

function grantCard(s) {
  const credits = el("input", { type: "text", inputmode: "numeric", className: "input tabular", id: "grant-credits", autocomplete: "off", placeholder: "例：100" });
  credits.value = state.creditsText;
  credits.addEventListener("input", () => (state.creditsText = credits.value));
  const note = el("input", { type: "text", className: "input", id: "grant-note", autocomplete: "off", placeholder: "例：生成が足りなくなったため" });
  note.value = state.noteText;
  note.addEventListener("input", () => (state.noteText = note.value));
  const limits = limitItems(s);
  const mine = revocableGrants(s, state.myEmail, state.isAdmin);
  const revoked = revokedGrants(s);
  const avail = grantAvailability(s);
  const nameOf = (email) => s.students.find((x) => x.email === email)?.name ?? email;
  return el(
    "section",
    { className: "card", "aria-labelledby": "grant-h" },
    el("h2", { id: "grant-h", text: "クレジットを追加" }),
    el("p", { className: "hint", text: "追加は、今の段階の上限に足されます（次の段階には持ち越されません）。全員分が通るか、1 人でも断られたら全員分とも追加されません。" }),
    limits.length ? el("ul", { className: "limits", "aria-label": "追加の上限" }, ...limits.map(([k, v]) => el("li", {}, el("span", { text: `${k}：` }), el("b", { text: v })))) : null,
    el(
      "div",
      { className: "grant-form" },
      el("div", {}, el("label", { className: "field-label", for: "grant-credits", text: "1 人あたりのクレジット" }), credits),
      el("div", {}, el("label", { className: "field-label", for: "grant-note", text: "メモ（任意。理由など）" }), note),
    ),
    avail.ok ? null : el("p", { className: "note-box", id: "grant-why", text: avail.why }),
    el("button", { type: "button", className: "btn primary big", id: "grant-btn", onclick: () => addGrant(s) }),
    el("h3", { text: state.isAdmin ? "今の段階の追加（取り消せるもの）" : "今の段階のあなたの追加" }),
    mine.length
      ? el(
        "ul",
        { className: "my-grants", "aria-label": "取り消せる追加" },
        ...mine.map((g) =>
          el(
            "li",
            {},
            el("span", { className: "what", text: `${nameOf(g.email)} に +${formatCredits(g.credits)}${g.note ? `「${g.note}」` : ""}・${formatShortDateTime(g.createdAt)}` }),
            el("button", {
              type: "button",
              className: "btn compact",
              text: "取り消す",
              disabled: state.busy,
              "aria-label": `${nameOf(g.email)} への追加（+${formatCredits(g.credits)}）を取り消す`,
              onclick: () => revokeGrant(g, nameOf(g.email), s),
            }),
          )
        ),
      )
      : el("p", { className: "muted", text: "今の段階で、取り消せる追加はありません。" }),
    revoked.length
      ? el(
        "div",
        { className: "stack" },
        el("h3", { text: "今の段階で取り消した追加（回の合計には数えます）" }),
        el(
          "ul",
          { className: "my-grants revoked", "aria-label": "取り消した追加" },
          ...revoked.map((g) =>
            el(
              "li",
              {},
              el("span", {
                className: "what",
                text: `${nameOf(g.email)} への +${formatCredits(g.credits)}${g.note ? `「${g.note}」` : ""}・取り消し済み${g.revokedNote ? `（取り消しのメモ：${g.revokedNote}）` : ""}`,
              }),
            )
          ),
        ),
      )
      : null,
  );
}

/** 追加のボタンの文字と押せるか（選んだ人数で変わる） */
function updateGrantButton() {
  const btn = $("grant-btn");
  if (!btn) return;
  const n = state.selected.size;
  btn.textContent = n ? `選んだ ${n} 人に追加する` : "追加する人を選んでください";
  const avail = state.status ? grantAvailability(state.status) : { ok: true };
  btn.disabled = state.busy || n === 0 || !avail.ok;
  if (!avail.ok) btn.title = avail.why;
}

// ---- 操作 ----

/** 操作の通信中は二重に押せないようにして、終わったら描き直す */
async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  statusSeq++; // 操作の前に始まった読み込みの応答は、操作のあとの状態を上書きしないよう捨てる
  render();
  try {
    await fn();
  } finally {
    state.busy = false;
    render();
  }
}

/** 失敗を知らせる。ほかの人が先に段階を動かしていた（stage_changed）ときは、最新を読み直す */
async function failWith(error) {
  notify(explainError(error), "error");
  if (rejectionName(error) === "stage_changed") await loadStatus();
}

async function moveStage(direction, mv, s) {
  const to = direction === "back" ? mv.prev : mv.next;
  if (!to || !mv.current) return;
  clearNotice();
  const ok = await confirmDialog({
    title: direction === "back" ? "前の段階へ戻しますか？" : "次の段階へ進めますか？",
    lines: moveConfirmText(direction, mv.current, to),
    okText: direction === "back" ? "戻す" : "進める",
  });
  if (!ok) return;
  await withBusy(async () => {
    const { error } = await rpc("cohort_stage_move", {
      p_cohort_id: state.cohortId,
      p_to_stage_id: to.id,
      p_expected_stage_id: mv.current.id,
      p_note: null,
    });
    if (error) {
      await failWith(error);
      return;
    }
    notify(`「${stageName(to)}」へ${direction === "back" ? "戻しました" : "進めました"}。`);
    await loadStatus();
  });
}

async function undoMove(undo, s) {
  if (!undo.toStage || !s.current) return;
  clearNotice();
  await withBusy(async () => {
    const { error } = await rpc("cohort_stage_move", {
      p_cohort_id: state.cohortId,
      p_to_stage_id: undo.toStage.id,
      p_expected_stage_id: s.current.id,
      p_note: "取り消し（前の段階に戻す）",
    });
    if (error) {
      await failWith(error);
      return;
    }
    notify(`「${stageName(undo.toStage)}」に戻しました。`);
    await loadStatus();
  });
}

async function addGrant(s) {
  clearNotice();
  const emails = [...state.selected];
  const credits = parseStageGrantCredits(state.creditsText);
  if (credits === undefined) {
    notify("追加するクレジットは 1 以上の整数で入力してください。", "error");
    return;
  }
  const plan = instructorGrantPlan({ emails, credits, students: s.students, limits: s.limits, isInstructor: !state.isAdmin, status: s });
  if (!plan.ok) {
    notify("追加できません。", "error", plan.problems);
    return;
  }
  const names = emails.map((e) => s.students.find((x) => x.email === e)?.name ?? e);
  const ok = await confirmDialog({ title: "クレジットを追加しますか？", lines: grantConfirmText(names, credits, s.current), okText: "追加する" });
  if (!ok) return;
  await withBusy(async () => {
    const { error } = await rpc("instructor_grant", {
      p_cohort_id: state.cohortId,
      p_emails: emails,
      p_credits: credits,
      p_note: state.noteText.trim() || null,
    });
    if (error) {
      await failWith(error);
      return;
    }
    notify(`${emails.length} 人に ${formatCredits(credits)} クレジットを追加しました。`);
    state.selected.clear();
    state.creditsText = "";
    state.noteText = "";
    await loadStatus();
  });
}

async function revokeGrant(g, name, s) {
  clearNotice();
  const ok = await confirmDialog({
    title: "追加を取り消しますか？",
    lines: [`${name} への追加（+${formatCredits(g.credits)}）を取り消します。`, REVOKE_CONFIRM_TEXT],
    okText: "取り消す",
  });
  if (!ok) return;
  await withBusy(async () => {
    const { error } = await rpc("revoke_stage_grant", { p_grant_id: g.id, p_note: null });
    if (error) {
      await failWith(error);
      return;
    }
    notify(`${name} への追加（+${formatCredits(g.credits)}）を取り消しました。`);
    await loadStatus();
  });
}

// ---- 開始 ----

/**
 * 再読み込みのあとの自動のログインのやり直し（openDecision が "relogin" のときに 1 回だけ呼ぶ）。
 * Google のログインを、アカウントの選択なしで始める。失敗したときはログイン前の画面にして、自動ではやり直さない
 */
async function autoRelogin() {
  $("status").replaceChildren(el("p", { className: "muted", text: "ログインし直しています…" }));
  show("status");
  leavingForLogin = true;
  markActive(true);
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: returnUrl() },
    });
    if (!error) return;
  } catch {
    // 下で、ログイン前の画面にする
  }
  leavingForLogin = false;
  clearStoredSession(sessionStore, INSTRUCTOR_STORAGE_KEY);
  showLoginNote("ログインし直せませんでした。もう一度ログインしてください。");
  show("login");
}

async function main() {
  if (openDecision === "relogin") {
    await autoRelogin();
    return;
  }
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const params = new URLSearchParams(location.search);
  if (params.get("error_description") || hash.get("error_description")) {
    // 文言は誰でも書き換えられるので、URL の内容は表示しない
    history.replaceState(null, "", returnUrl());
    showLoginNote("ログインできませんでした。もう一度ログインしてください。");
    show("login");
    return;
  }
  const { data: { session }, error } = await supabase.auth.getSession();
  // Google から ?code 付きで戻ったのに、ログインを完了できなかった：URL の code と code verifier を消して、ログイン前の画面にする
  if (openDecision === "code" && (error || !session)) {
    history.replaceState(null, "", returnUrl());
    clearStoredSession(sessionStore, INSTRUCTOR_STORAGE_KEY);
    showLoginNote(MSG_CODE_FAILED);
    show("login");
    return;
  }
  if (error) {
    $("failed-message").textContent = "ログイン状態を確認できませんでした。もう一度試してください。";
    show("failed");
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
  if (location.search || location.hash) history.replaceState(null, "", returnUrl());
  await load();
}

// 画面を離れるとき（再読み込み・タブを閉じる・別のページへ移る）はログアウトする。ただし Google のログインへ移るときは除く（マイページと同じ）。
// 待てないので、サーバーへの取り消しは keepalive で送り、タブの保存先はその場で消す。画面の中身も消す。
// そのうえで「再読み込みの手がかり」（離れた時刻と、離れる前にログインしていたか。トークンは含めない）を別の鍵に書く
window.addEventListener("pagehide", () => {
  if (leavingForLogin) return;
  stopIdleWatch();
  const token = storedAccessToken(sessionStore, INSTRUCTOR_STORAGE_KEY);
  const hadSession = hadActiveSession({ token, lastActive: lastActive(), now: Date.now(), limitMs: INSTRUCTOR_IDLE_LIMIT_MS });
  sendLocalLogout(token);
  try {
    // メモリの分が自動の更新で保存し直されないよう、更新も止める
    supabase.auth.stopAutoRefresh?.();
  } catch {
    // 無視
  }
  clearStoredSession(sessionStore, INSTRUCTOR_STORAGE_KEY);
  try {
    sessionStore?.setItem(INSTRUCTOR_RELOAD_HINT_KEY, JSON.stringify({ leftAt: Date.now(), hadSession }));
  } catch {
    // 書けなければ、次に開いたときは手がかりが無い扱い（ログイン前の画面）になる
  }
  hideContent("読み込み中…");
});
// 戻る・進むでキャッシュ（bfcache）から表示されたとき（pagehide でログアウト済み）は、再読み込みではないので自動のログインはしない
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  try {
    sessionStore?.removeItem(INSTRUCTOR_RELOAD_HINT_KEY);
  } catch {
    // 無視
  }
  sendLocalLogout(storedAccessToken(sessionStore, INSTRUCTOR_STORAGE_KEY));
  clearStoredSession(sessionStore, INSTRUCTOR_STORAGE_KEY);
  hideContent("ログアウトしました。");
  location.reload();
});

$("login-btn").addEventListener("click", signIn);
$("logout-btn").addEventListener("click", signOut);
$("denied-logout-btn").addEventListener("click", signOut);
$("failed-logout-btn").addEventListener("click", signOut);
$("retry-btn").addEventListener("click", () => load());

main().catch(() => {
  $("failed-message").textContent = "エラーが発生しました。ページを開き直してください。";
  show("failed");
});
