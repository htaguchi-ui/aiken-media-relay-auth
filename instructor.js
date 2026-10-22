// 講師の画面。担当する回の「段階」を進める・戻す、受講者の使用量を見る、一時追加と自分の追加の取り消しを、本人のログインで行う。
// 書き込みはすべて DB の RPC（cohort_stage_move・instructor_grant・revoke_stage_grant。権限・上限・段階の判定は DB が決める）。
// ログインはマイページ（mypage.js）・Canvas と共有する（決定 70。localStorage の共有の鍵・最長 14 日）。ページを離れても、
// 操作しなくてもログアウトしない。ほかのタブでログアウトしたら、この画面も中身を消して読み込み直す。
// 管理者は、同じブラウザの管理コンソールの有効なセッション（管理コンソールの鍵）で動く（設計書 docs/design-canvas-login-link.md 5.3.1。
// 1932 のあと is_admin() は管理コンソールのセッションだけ）。講師の区分の人は、今までどおり共有のログインで動く。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// supabase-js は instructor.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
import {
  ADMIN_CONSOLE_STORAGE_KEY,
  adminConsoleExpired,
  adminConsoleExpiresAt,
  authEventKind,
  browserStorage,
  clearStoredSession,
  discardOldTabSessions,
  LEGACY_STORAGE_PREFIX,
  sameIdentity,
  sessionChangeKind,
  sessionIdentity,
  storedUserId,
  STUDIO_STORAGE_KEY,
  takeStoredSession,
} from "./auth-storage.js";
import { MSG_CODE_FAILED, oauthOptions } from "./mypage-lib.js";
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

/** ログインを終えている途中（このタブのログアウト・ほかのタブからの知らせ）。この間は本人の画面を描き直さない */
let ending = false;

function show(id) {
  // ログインを終えている途中（ending）は、遅れて届いた応答で本人の画面に戻さない
  if (id === "app" && ending) return;
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

// ログインはこの端末（ブラウザ）で保つ（決定 70）：保存先は localStorage の共有の鍵（マイページ・Canvas・許可の画面と同じ）。
// 以前の版が localStorage（sb-…）・sessionStorage（画面ごとの鍵）に残したセッションは、開いた時点で捨てる（移さない）
const localStore = browserStorage("local");
clearStoredSession(localStore, LEGACY_STORAGE_PREFIX);

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
    // 送れなくても、保存先は呼び出し側で消す
  }
}

discardOldTabSessions(browserStorage("session"), sendLocalLogout);

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない
if (typeof window.supabase?.createClient !== "function") {
  $("status").textContent = "画面の部品を読み込めませんでした。通信状態を確認して、ページを開き直してください。";
  throw new Error("supabase-js を読み込めませんでした");
}

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
    storageKey: STUDIO_STORAGE_KEY,
    ...(localStore ? { storage: localStore } : {}),
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

/** Google のログインへ移る。ふつうはアカウントを選ぶ画面を出さず、「別のアカウントでログイン」のときだけ出す（決定 70） */
async function signIn({ selectAccount = false } = {}) {
  await supabase.auth.signInWithOAuth({ provider: "google", options: oauthOptions(returnUrl(), selectAccount) });
}

/** ログアウトして、この端末の共有のログインを消す（通信できなくても消す。マイページ・Canvas のタブもログインの画面になる） */
async function endSession() {
  ending = true;
  try {
    // この端末のセッションだけを切る（global だと、本人の ChatGPT・Codex・Claude Code の接続まで切れる）
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // 下で消す
  }
  clearStoredSession(localStore, STUDIO_STORAGE_KEY);
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
  if (adminSession) {
    // 管理者として動いている間：管理コンソールのログインを終える（admin_console_end → この端末のログアウト）。共有のログインには触れない
    const { client } = adminSession;
    let target = null;
    try {
      target = sessionIdentity(localStore?.getItem(ADMIN_CONSOLE_STORAGE_KEY) ?? null);
    } catch {
      target = null;
    }
    hideContent();
    ending = true;
    await endAdminConsole(client, target);
    location.replace(returnUrl());
    return;
  }
  hideContent();
  await endSession();
  location.replace(returnUrl());
}

function showLoginNote(text) {
  $("login-note").textContent = text;
  $("login-note").hidden = !text;
}

// ---- ほかのタブでのログアウト・アカウントの切り替え（マイページと同じ） ----

/** このタブが表示している利用者の ID（ログイン前は null） */
let shownUser = null;

/** ほかのタブでログアウトした・別のアカウントに替わった：中身を消して、ページを読み込み直す */
function onSessionChanged(kind) {
  if (!kind || ending) return;
  ending = true;
  hideContent(kind === "signed-out" ? "ログアウトしました。" : "読み込み中…");
  location.replace(returnUrl());
}

function startWatch(userId) {
  shownUser = userId;
  window.addEventListener("storage", (e) => onSessionChanged(sessionChangeKind(e, STUDIO_STORAGE_KEY, shownUser)));
  // supabase-js の知らせ（ほかのタブの BroadcastChannel・このタブのトークンの更新の失敗）。知らせの中では supabase を待たない
  supabase.auth.onAuthStateChange((event, session) => {
    const kind = authEventKind(event, session, shownUser);
    if (kind) setTimeout(() => onSessionChanged(kind), 0);
  });
}

// ---- お知らせ ----

const NOTICE_MAX = 3;

function notify(message, kind = "ok", details = []) {
  if (ending) return; // ログアウトの途中は、遅れて届いた結果を知らせない
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

/** RPC を呼ぶ。返り値は { data, error }。管理者として動いている間は、管理コンソールの鍵の部品で呼ぶ（5.3.1） */
function rpc(name, args) {
  return activeClient().rpc(name, args);
}

/** 今の部品（管理者として動いている間は管理コンソールの鍵の部品、それ以外は共有のログインの部品） */
function activeClient() {
  return adminSession?.client ?? supabase;
}

/** 画面に出す失敗（読み込みの失敗）：どの画面にするかを決める */
function loadFailure(error) {
  if (rejectionName(error) === "instructor_only" || String(error?.code) === "42501") return { action: "denied" };
  if (isStageSchemaMissing(error)) return { action: "failed", message: `講師の画面は、まだ使えません。${MSG_STAGE_NOT_READY}` };
  return { action: "failed", message: explainError(error) };
}

async function loadCohorts() {
  const { data, error } = await rpc("instructor_cohorts");
  // ログアウトの途中・ほかのタブでのログアウトのあとに届いた応答は、state に入れない（F107-04）
  if (ending) return { stale: true };
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
  if (ending) return true; // ログアウトの途中に届いた応答は使わない（F107-04）
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
    // 各 await のあとに、ログアウトの途中（ending）でないかを照らす。途中なら state・ヘッダー・お知らせ・画面を変えずに終わる（F107-04）
    if (!fromApp) {
      const { data } = await rpc("is_admin");
      if (ending) return;
      state.isAdmin = data === true;
      const { data: googleEmail } = await rpc("current_google_email");
      if (ending) return;
      const { data: sessionData } = await activeClient().auth.getSession();
      if (ending) return;
      state.myEmail = normalizeEmail(googleEmail ?? sessionData?.session?.user?.email ?? "");
    }
    const c = await loadCohorts();
    if (ending || c.stale) return;
    if (c.error) {
      const f = loadFailure(c.error);
      if (f.action === "denied") {
        const { data } = await activeClient().auth.getSession();
        if (ending) return;
        $("denied-email").textContent = data?.session?.user?.email ?? "";
        // 管理者は、管理コンソールでログインしてから開く（5.3.1 の 3）
        if (!adminSession) showAdminHint(adminHint ?? MSG_ADMIN_CONSOLE_NEEDED);
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
    if (ending) return;
    if (!ok && fromApp) notify(`最新の状態を読み込めませんでした。${state.statusError}`, "error");
    $("me-email").textContent = adminSession ? adminWho() : state.myEmail;
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
  if (ending) return;
  if (!ok) notify(`最新の状態を読み込めませんでした。${state.statusError}`, "error");
  render();
}

// ---- 管理者として使う（設計書 5.3.1。管理コンソールのログイン） ----
// 起動の順：共有のログインで instructor_cohorts を呼び、通れば（講師の区分）今どおり。instructor_only（区分が講師でない。管理者は
// ここに来る）か共有のログインが無いときは、管理コンソールの鍵に保存されたセッションで 2 つ目の部品を作り、admin_console_status() が
// admin: true なら、以後の RPC はすべてその部品で呼ぶ。無い・使えないときは案内と［管理コンソールを開く］。どれも「どのセッションで
// 呼ぶか」を選ぶだけで、管理者・講師の判定は DB が決める。この画面は登録を作れず、管理コンソールの Google のログインも始めない。
// 古い管理コンソールの鍵（aiken-studio-admin-auth）は読まない。

const MSG_ADMIN_CONSOLE_NEEDED = "管理者として講師ページを使うには、管理コンソールでログインしてから開いてください。";
// ログインの画面でだけ、管理者向けの案内の前に置く（講師が迷わないように。田口さん 2026-10-23）
const MSG_INSTRUCTOR_LOGIN_FIRST = "講師の方は上の［Google でログイン］から入ってください。";
const MSG_ADMIN_CONSOLE_EXPIRED ="管理コンソールのログインから 12 時間たちました。管理コンソールでもう一度ログインしてから開いてください。";

/** 管理者として動いている間の { client, expiresAt, userId }（講師・ログイン前は null） */
let adminSession = null;
/** 管理コンソールのセッションを試して使えなかったときの案内の文 */
let adminHint = null;
let adminClient = null;
let adminTimer = null;
let checkingAdmin = false;
let watchingConsoleKey = false;

/** 管理コンソールと同じ鍵・同じ保存先・同じ supabase-js の 2 つ目の部品（URL のコードは読まない） */
function adminConsoleClient() {
  adminClient ??= window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: ADMIN_CONSOLE_STORAGE_KEY,
      ...(localStore ? { storage: localStore } : {}),
    },
  });
  return adminClient;
}

/** 管理コンソールの鍵に今保存されているセッション（{ userId, sessionId }。無ければ null） */
function consoleIdentity() {
  try {
    return sessionIdentity(localStore?.getItem(ADMIN_CONSOLE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * 管理コンソールのセッションが使えるか（admin_console_status）。{ ok: true, client, expiresAt, userId, identity } か
 * { ok: false, message }（鍵が無い・読めない → 「ログインしてから」、鍵はあるが使えない → 「12 時間たちました」）か
 * { ok: false, stale: true }（照会の間に、ほかのタブで管理コンソールにログインし直した。同じ人の別の SID も含む。古い応答は使わない。
 * TASK-0149 F149-02。管理コンソールの consoleStatus と同じ規則）
 */
async function checkAdminConsole() {
  const identity = consoleIdentity();
  const userId = identity?.userId ?? null;
  if (!userId) return { ok: false, message: MSG_ADMIN_CONSOLE_NEEDED };
  const client = adminConsoleClient();
  const { data, error } = await client.rpc("admin_console_status");
  if (!sameIdentity(consoleIdentity(), identity)) return { ok: false, stale: true };
  if (error) return { ok: false, message: MSG_ADMIN_CONSOLE_NEEDED };
  const now = Date.now();
  const expiresAt = adminConsoleExpiresAt(data?.expires_at ?? null, now);
  if (data?.admin !== true || expiresAt === null || adminConsoleExpired(expiresAt, now)) {
    return { ok: false, message: MSG_ADMIN_CONSOLE_EXPIRED };
  }
  return { ok: true, client, expiresAt, userId, identity };
}

/**
 * どの部品で動くかを決める（5.3.1 の 1〜2）。hasShared は共有のログインがあるか。
 * 返り値：{ shared: true }（講師。今どおり）・{ admin: true }（管理者として動く）・{ guide }（使えない。案内の文）・{ stale: true }
 */
async function chooseClient(hasShared) {
  if (hasShared) {
    const { error } = await supabase.rpc("instructor_cohorts");
    if (ending) return { stale: true };
    // 通った（講師の区分）・断り以外の失敗（通信など）は、今どおり共有のログインで読み込みに任せる
    if (!error || loadFailure(error).action !== "denied") return { shared: true };
  }
  const r = await checkAdminConsole();
  if (ending) return { stale: true };
  if (r.stale) {
    // 確かめている間に管理コンソールのログインが替わった：今の保存先で、この画面を開き直す
    location.replace(returnUrl());
    return { stale: true };
  }
  if (r.ok) {
    enterAdminMode(r);
    return { admin: true };
  }
  adminHint = r.message;
  return { guide: r.message };
}

/** 管理者として動く：以後の RPC は管理コンソールの部品で呼ぶ。12 時間（admin_console_status の expires_at）と、ほかのタブを見張る */
function enterAdminMode(r) {
  adminSession = { client: r.client, expiresAt: r.expiresAt, userId: r.userId };
  adminHint = null;
  $("logout-btn").textContent = "管理コンソールのログインを終える";
  adminTimer = setInterval(checkAdminExpiry, 30000);
  // スリープ・背面のタブではタイマーが遅れるので、前に出たときにも確かめる
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkAdminExpiry();
  });
  // ほかのタブで管理コンソールからログアウトした・別のアカウントに替わった（管理コンソールの鍵だけを見る）
  window.addEventListener("storage", (e) => onSessionChanged(sessionChangeKind(e, ADMIN_CONSOLE_STORAGE_KEY, r.userId)));
  r.client.auth.onAuthStateChange((event, session) => {
    const kind = authEventKind(event, session, r.userId);
    if (kind) setTimeout(() => onSessionChanged(kind), 0);
  });
}

/** 上部の表示：「管理者として操作中（管理コンソールのログイン・〜HH:MM まで）· メール」 */
function adminWho() {
  const until = new Date(adminSession.expiresAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return `管理者として操作中（管理コンソールのログイン・〜${until} まで）· ${state.myEmail}`;
}

/**
 * 12 時間を過ぎたら、管理コンソールの部品の使用をやめて案内に戻す（保存先はこの画面からは消さない）。ほかのタブで管理コンソールに
 * ログインし直していれば（同じ人の新しいセッション）、その期限で続ける
 */
async function checkAdminExpiry() {
  if (!adminSession || ending || checkingAdmin) return false;
  if (!adminConsoleExpired(adminSession.expiresAt, Date.now())) return false;
  checkingAdmin = true;
  try {
    const r = await checkAdminConsole();
    if (ending || !adminSession) return false;
    // 古い応答（照会の間にまたログインし直した）は使わない。次の確かめで、今のセッションを聞き直す
    if (r.stale) return false;
    if (r.ok && r.userId === adminSession.userId) {
      adminSession.expiresAt = r.expiresAt;
      $("me-email").textContent = adminWho();
      return false;
    }
    leaveAdmin(MSG_ADMIN_CONSOLE_EXPIRED);
    return true;
  } finally {
    checkingAdmin = false;
  }
}

/** 管理者として動くのをやめる（本人の値を消し、案内を出す。保存先は消さない） */
function leaveAdmin(message) {
  if (adminTimer) clearInterval(adminTimer);
  adminTimer = null;
  hideContent("");
  ending = true;
  adminSession = null;
  showAdminHint(message);
  show("denied");
}

/** 案内（3.7 の文と［管理コンソールを開く］）を出し、管理コンソールの鍵にログインが入ったら読み込み直す */
function showAdminHint(message) {
  $("admin-guide").textContent = message;
  $("admin-guide").hidden = false;
  $("admin-console-btn").hidden = false;
  watchConsoleKey();
}

/** 管理コンソールの鍵にログインが書き込まれたら（ほかのタブで管理コンソールにログインした）、この画面を読み込み直す */
function watchConsoleKey() {
  if (watchingConsoleKey) return;
  watchingConsoleKey = true;
  window.addEventListener("storage", (e) => {
    if (e.key === ADMIN_CONSOLE_STORAGE_KEY && storedUserId(e.newValue ?? null) && !adminSession) location.replace(returnUrl());
  });
}

/**
 * 管理コンソールのログインを終える。始めたときのセッション（target）が保存先にあるときだけ、通信より前にその場で取り出し（消し）、
 * そのトークンで admin_console_end とこの端末のログアウトを送る（管理コンソールの admin.js と同じ形）。supabase-js の signOut は
 * 通信のあとでそのときの保存先を読んで消すので使わない（待つ間にほかのタブで入った新しい管理コンソールのログインを消さない。
 * TASK-0142 F142-02）。共有のログインには触れない
 */
async function endAdminConsole(client, target) {
  try {
    client.auth.stopAutoRefresh?.();
  } catch {
    // 無視
  }
  const token = target ? takeStoredSession(localStore, ADMIN_CONSOLE_STORAGE_KEY, target) : null;
  if (!token) return;
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

// ---- 表示 ----

let undoTimer = null;

function stopUndoTimer() {
  if (undoTimer) clearInterval(undoTimer);
  undoTimer = null;
}

function render() {
  if (ending) return; // ログアウトの途中・ほかのタブでログアウトしたあとは描かない
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

async function main() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const params = new URLSearchParams(location.search);
  const hasCode = !!params.get("code");
  if (params.get("error_description") || hash.get("error_description")) {
    // 文言は誰でも書き換えられるので、URL の内容は表示しない
    history.replaceState(null, "", returnUrl());
    showLoginNote("ログインできませんでした。もう一度ログインしてください。");
    show("login");
    return;
  }
  const { data: { session }, error } = await supabase.auth.getSession();
  // Google から ?code 付きで戻ったのに、ログインを完了できなかった：URL の code を消して、ログイン前の画面にする
  if (hasCode && (error || !session)) {
    history.replaceState(null, "", returnUrl());
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
    // 共有のログインが無い：管理コンソールの有効なセッションがあれば管理者として動く（5.3.1 の 2）。無ければ今どおりログインの画面
    const chosen = await chooseClient(false);
    if (chosen.stale) return;
    if (chosen.admin) {
      if (location.search || location.hash) history.replaceState(null, "", returnUrl());
      await load();
      return;
    }
    if (chosen.guide) {
      // 共有のログインも管理コンソールのログインも使えない（鍵が無い・12 時間を過ぎた・取り消された）：3.7 の文と［管理コンソールを開く］を出す（5.3.1 の 3）
      showLoginNote(MSG_INSTRUCTOR_LOGIN_FIRST + chosen.guide);
      $("login-console-btn").hidden = false;
    }
    watchConsoleKey();
    show("login");
    return;
  }
  startWatch(session.user?.id ?? null);
  // 戻ってきた直後の URL に残る code などを消す
  if (location.search || location.hash) history.replaceState(null, "", returnUrl());
  // 講師の区分なら今どおり。区分が講師でない（管理者）なら、管理コンソールのセッションを試す（5.3.1 の 1〜2）
  const chosen = await chooseClient(true);
  if (chosen.stale) return;
  await load();
}

/** 管理コンソールを新しいタブで開く（講師の画面からはログインを始めない） */
function openAdminConsole() {
  window.open("/admin.html", "_blank", "noopener");
}

// 戻る・進むでキャッシュ（bfcache）から表示されたときは、読み込み直して今のログインの状態から作り直す
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  hideContent("読み込み中…");
  location.reload();
});

$("login-btn").addEventListener("click", () => signIn());
// 小さな「別のアカウントでログイン」：Google のアカウントを選ぶ画面を出す（ログイン後に替えるときは、ログアウトしてからここ）
$("login-other-btn").addEventListener("click", () => signIn({ selectAccount: true }));
$("logout-btn").addEventListener("click", signOut);
$("denied-logout-btn").addEventListener("click", signOut);
$("failed-logout-btn").addEventListener("click", signOut);
$("retry-btn").addEventListener("click", () => load());
$("admin-console-btn").addEventListener("click", openAdminConsole);
$("login-console-btn").addEventListener("click", openAdminConsole);

main().catch(() => {
  $("failed-message").textContent = "エラーが発生しました。ページを開き直してください。";
  show("failed");
});
