// 提出の画面（講師・管理者）。担当する回の「段階」ごとに、提出された作品の一覧と再生・上映の画面を、本人のログインで見る（設計書 docs/design-submissions.md 4.8）。
// 講師ページ v2（instructor.js）は触らない（設計 2.10）ので、別のページにした。ログイン・ログアウト・管理者として使う部分（ログインの関数 signIn・signOut・chooseClient・管理コンソールの 12 時間の見張りなど。試験が関数の名前で照らす）は
// instructor.js から**同じ文字で**写してある（研修の前は共通の部品に切り出さない。研修のあとに切り出す）。同じ文字であることは
// scripts/submissions_auth_same_nodetest.mjs で確かめる。instructor.js のその部分を直したら、ここも同じ直しをする（試験が知らせる）。
// 読むだけの画面：書き込みは無い。RPC は submission_stage_overview・submission_stage_works（利用者の JWT のまま。権限は DB が決める）。
// 再生は `submissions` 関数の POST /playback（置き場は画面が知らない）。表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// supabase-js は submissions.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
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
import { explainError, isStageSchemaMissing, MSG_STAGE_NOT_READY, normalizeEmail, rejectionName } from "./admin-lib.js";
import { instructorCohortLabel, normalizeInstructorCohorts } from "./stage-lib.js";
import { fillIcons, renderSiteNav } from "./site-nav.js";
import { discardDlKey } from "./share-lib.js";
import {
  foldTitle,
  instructorAcceptLabel,
  LIST_POLL_MS,
  needsManualPlay,
  neighborInQueue,
  normalizeStageOverview,
  normalizeStageWorks,
  playbackQueue,
  playerCaption,
  PRIVATE_BANNER,
  scopeBadge,
  screeningQueue,
  stageCountsLabel,
  submissionStageName,
  submissionsPauseText,
  SUBMISSION_RPC,
  workRow,
} from "./submissions-lib.js";

// 他のサイトに埋め込まれて操作させられるのを防ぐ（マイページ・管理コンソール・講師ページと同じ）
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("提出の画面は埋め込みでは使えません");
}

// ===== 共通の認証・ログアウト・管理者として使う部分（instructor.js と同じ文字。ここから） =====

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
// 保存のページ（/dl）が、このタブの sessionStorage に一時に置いた鍵：開いた時点で消す（前の人の作品が、この画面から［戻る］［進む］で出ないように。docs/design-submissions.md 4.9 の消す条件 (d)）
discardDlKey(browserStorage("session"));

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない
if (typeof window.supabase?.createClient !== "function") {
  $("status").replaceChildren(el("p", { text: "画面を読み込めませんでした。" }), el("p", { text: "通信を確かめて開き直してください。" }));
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

// ---- ログイン・ログアウト ----

/** Google のログインへ移る。ふつうはアカウントを選ぶ画面を出さず、「別のアカウントでログイン」のときだけ出す（決定 70） */
async function signIn({ selectAccount = false } = {}) {
  await supabase.auth.signInWithOAuth({ provider: "google", options: oauthOptions(returnUrl(), selectAccount) });
}

/** ログアウトして、この端末の共有のログインを消す（通信できなくても消す。マイページ・Canvas のタブもログインの画面になる） */
async function endSession() {
  ending = true;
  discardDlKey(browserStorage("session")); // /dl が置いた鍵は、ログアウトで消す（通信できなくても）
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
  $("me-role").title = "";
  renderSiteNav($("site-nav"), null, "submissions");
  $("denied-email").textContent = "";
  stopPlayer();
  $("screen")?.close?.();
  $("screen")?.replaceChildren();
  $("view").replaceChildren();
  $("notice").replaceChildren();
  $("confirm").close?.();
  $("confirm").replaceChildren();
  state.overview = null;
  state.works = null;
  state.cohorts = [];
  state.cohortId = null;
  state.stageId = null;
  state.selectedWorkId = null;
  ui.openFolds.clear();
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

/** RPC を呼ぶ。返り値は { data, error }。管理者として動いている間は、管理コンソールの鍵の部品で呼ぶ（5.3.1） */
function rpc(name, args) {
  return activeClient().rpc(name, args);
}

/** 今の部品（管理者として動いている間は管理コンソールの鍵の部品、それ以外は共有のログインの部品） */
function activeClient() {
  return adminSession?.client ?? supabase;
}

/** 確認中に同じ人がログインし直した場合も、古い確認を引き継がない（回のクローズ。0179） */
function closeIdentity() {
  try {
    return sessionIdentity(localStore?.getItem(adminSession ? ADMIN_CONSOLE_STORAGE_KEY : STUDIO_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** 画面に出す失敗（読み込みの失敗）：どの画面にするかを決める */
function loadFailure(error) {
  if (rejectionName(error) === "instructor_only" || String(error?.code) === "42501") return { action: "denied" };
  if (isStageSchemaMissing(error)) return { action: "failed", message: `講師の画面は、まだ使えません。${MSG_STAGE_NOT_READY}` };
  return { action: "failed", message: explainError(error) };
}

/** first：もう受け取った instructor_cohorts の答え（chooseClient の 1 回目。同じ部品・同じ問い合わせを 2 回送らない）。無ければ読む */
async function loadCohorts(first = null) {
  const { data, error } = first ?? (await rpc("instructor_cohorts"));
  // ログアウトの途中・ほかのタブでのログアウトのあとに届いた応答は、state に入れない（F107-04）
  if (ending) return { stale: true };
  if (error) return { error };
  state.cohorts = normalizeInstructorCohorts(data);
  if (!state.cohorts.some((c) => c.id === state.cohortId)) state.cohortId = state.cohorts[0]?.id ?? null;
  return {};
}

// ---- 管理者として使う（設計書 5.3.1。管理コンソールのログイン） ----
// 起動の順：共有のログインで instructor_cohorts を呼び、通れば（講師の区分）今どおり。instructor_only（区分が講師でない。管理者は
// ここに来る）か共有のログインが無いときは、管理コンソールの鍵に保存されたセッションで 2 つ目の部品を作り、admin_console_status() が
// admin: true なら、以後の RPC はすべてその部品で呼ぶ。無い・使えないときは案内と［管理コンソールを開く］。どれも「どのセッションで
// 呼ぶか」を選ぶだけで、管理者・講師の判定は DB が決める。この画面は登録を作れず、管理コンソールの Google のログインも始めない。
// 古い管理コンソールの鍵（aiken-studio-admin-auth）は読まない。

/** 管理者として動いているときの［ログアウト］の title：管理コンソールのログインだけを終え、共有のログイン（マイページ・Canvas）は残す */
const MSG_END_ADMIN_CONSOLE = "管理コンソールのログインだけを終えます（マイページ・Canvas のログインはそのまま）";
const MSG_ADMIN_CONSOLE_NEEDED = "管理者として講師ページを使うには、管理コンソールでログインしてから開いてください。";
// ログインの画面でだけ、管理者向けの案内の前に置く（講師が迷わないように。田口さん 2026-10-23）
const MSG_TEACHER_LOGIN_FIRST = "講師の方は、上の「Google でログイン」のボタンから入ってください。";
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
    const first = await supabase.rpc("instructor_cohorts");
    if (ending) return { stale: true };
    // 通った（講師の区分）・断り以外の失敗（通信など）は、今どおり共有のログインで読み込みに任せる。
    // 通ったときは、その答えを最初の読み込みでそのまま使う（同じ部品で同じ問い合わせをもう 1 回送らない。2026-10-23）
    if (!first.error) return { shared: true, cohorts: first };
    if (loadFailure(first.error).action !== "denied") return { shared: true };
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
  // ボタンの文字は「ログアウト」のまま（短く。2026-10-23 田口さん）。何が起きるかは title と読み上げの名前で伝える
  $("logout-btn").title = MSG_END_ADMIN_CONSOLE;
  $("logout-btn").setAttribute("aria-label", `ログアウト：${MSG_END_ADMIN_CONSOLE}`);
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
      $("me-role").title = adminWho();
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

// ---- 画面の状態 ----

const state = {
  myEmail: "",
  isAdmin: false,
  /** 担当する回の一覧（normalizeInstructorCohorts） */
  cohorts: [],
  cohortId: null,
  /** submission_stage_overview を読んだもの（normalizeStageOverview）。null は未読込 */
  overview: null,
  overviewError: "",
  stageId: null,
  /** submission_stage_works を読んだもの（normalizeStageWorks）。null は未読込 */
  works: null,
  worksError: "",
  selectedWorkId: null,
};

/** 画面だけの状態（描き直しても残す。hideContent が空にする） */
const ui = { openFolds: new Set(), playerEl: null, timer: null, clock: null, now: Date.now() };

function stageById(id) {
  return state.overview?.stages.find((s) => s.stageId === id) ?? null;
}

/** 開いたときに選ぶ段階：今の段階 → 作品のある最初の段階 → 最初の段階 */
function defaultStageId(ov) {
  return (ov.stages.find((s) => s.isCurrent) ?? ov.stages.find((s) => s.worksCount > 0) ?? ov.stages[0])?.stageId ?? null;
}

// ---- 読み込み ----

/** 読み込みの通し番号。古い応答（あとから始めた読み込み・回や段階を替えたあとのもの）は捨てる */
let overviewSeq = 0;
let worksSeq = 0;

async function loadOverview() {
  const requested = state.cohortId;
  if (!requested) {
    state.overview = null;
    state.overviewError = "";
    return true;
  }
  const seq = ++overviewSeq;
  const { data, error } = await rpc(SUBMISSION_RPC.stageOverview, { p_cohort_id: requested });
  if (ending || requested !== state.cohortId || seq !== overviewSeq) return true; // 古い応答は使わない
  if (error) {
    state.overviewError = loadErrorText(error);
    return false;
  }
  const ov = normalizeStageOverview(data);
  if (!ov) {
    state.overviewError = "提出の状態を読み込めませんでした（応答の形が違います）。";
    return false;
  }
  state.overview = ov;
  state.overviewError = "";
  if (!stageById(state.stageId)) state.stageId = defaultStageId(ov);
  return true;
}

async function loadWorks() {
  const cohort = state.cohortId;
  const stageId = state.stageId;
  if (!cohort || !stageId) {
    state.works = null;
    state.worksError = "";
    return true;
  }
  const seq = ++worksSeq;
  const { data, error } = await rpc(SUBMISSION_RPC.stageWorks, { p_cohort_id: cohort, p_stage_id: stageId });
  if (ending || cohort !== state.cohortId || stageId !== state.stageId || seq !== worksSeq) return true;
  if (error) {
    state.worksError = loadErrorText(error);
    return false;
  }
  const w = normalizeStageWorks(data);
  if (!w) {
    state.worksError = "作品の一覧を読み込めませんでした（応答の形が違います）。";
    return false;
  }
  state.works = w;
  state.worksError = "";
  syncPlayerButtons(); // 定期読込で公開範囲・名簿上の扱いが変わったら、URL の後着より先に止める
  return true;
}

/** 失敗の文。DB の日本語の hint は explainError が拾う。提出の RPC がまだ無い（公開前）ときは、その旨 */
function loadErrorText(error) {
  if (String(error?.code) === "PGRST202" || String(error?.code) === "42883") return "提出の機能は、まだ使えません。";
  return explainError(error);
}

async function loadCohortsAndOverview(first = null) {
  const c = await loadCohorts(first);
  if (ending || c.stale || c.error) return { c, ok: false };
  const ok = await loadOverview();
  if (ending) return { c, ok: false };
  return { c, ok: ok && (await loadWorks()) };
}

let loading = false;

/**
 * 読み込んで画面を切り替える。初回と「最新にする」の両方で使う。
 * cohorts：最初の読み込みで使う instructor_cohorts の答え（chooseClient がもう受け取ったもの。無ければ読む）
 */
async function load({ fromApp = false, cohorts = null } = {}) {
  if (loading) return;
  loading = true;
  if (!fromApp) {
    $("status").replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    show("status");
  }
  try {
    // 各 await のあとに、ログアウトの途中（ending）でないかを照らす。途中なら state・ヘッダー・お知らせ・画面を変えずに終わる（instructor.js の F107-04 と同じ）
    let c;
    let ok;
    if (!fromApp) {
      const [adminRes, emailRes, sessionRes, loaded] = await Promise.all([
        rpc("is_admin"),
        rpc("current_google_email"),
        activeClient().auth.getSession(),
        loadCohortsAndOverview(cohorts),
      ]);
      if (ending) return;
      state.isAdmin = adminRes?.data === true;
      state.myEmail = normalizeEmail(emailRes?.data ?? sessionRes?.data?.session?.user?.email ?? "");
      ({ c, ok } = loaded);
    } else {
      ({ c, ok } = await loadCohortsAndOverview());
    }
    if (ending || c.stale) return;
    if (c.error) {
      const f = loadFailure(c.error);
      if (f.action === "denied") {
        const { data } = await activeClient().auth.getSession();
        if (ending) return;
        $("denied-email").textContent = data?.session?.user?.email ?? "";
        // 管理者は、管理コンソールでログインしてから開く（設計書 5.3.1 の 3）
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
    if (ending) return;
    if (!ok && fromApp) notify(`最新の状態を読み込めませんでした。${state.overviewError || state.worksError}`, "error");
    $("me-email").textContent = adminSession ? adminWho() : state.myEmail;
    $("me-email").title = state.myEmail;
    const role = $("me-role");
    role.textContent = state.isAdmin ? "管理者" : "講師";
    role.className = `badge ${state.isAdmin ? "admin" : "instructor"}`;
    role.title = $("me-email").textContent;
    // 画面の間の移動：講師ページへ戻るリンクも出す（この画面の印は付けない）
    renderSiteNav($("site-nav"), state.isAdmin ? "admin" : "instructor", "submissions");
    render();
    show("app");
    schedulePoll();
  } finally {
    loading = false;
  }
}

/** 回を替えたあと：段階の一覧と作品を読み直す */
async function reloadAfterCohortChange() {
  stopPlayer();
  state.overview = null;
  state.works = null;
  state.stageId = null;
  state.selectedWorkId = null;
  ui.openFolds.clear();
  render();
  const ok = await loadOverview();
  if (ending) return;
  if (ok) await loadWorks();
  if (ending) return;
  render();
}

/** 段階を選び直したあと：その段階の作品を読み直す */
async function reloadWorks() {
  const ok = await loadWorks();
  if (ending) return;
  if (!ok) notify(`作品の一覧を読み込めませんでした。${state.worksError}`, "error");
  renderStages();
  renderWorks();
}

let refreshing = false;

/** 「最新にする」と 30 秒ごとの読み直し（段階の数・作品の一覧）。プレーヤーは描き直さない */
async function refreshAll({ quiet = false } = {}) {
  if (refreshing || ending) return;
  refreshing = true;
  try {
    const a = await loadOverview();
    const b = a ? await loadWorks() : false;
    if (ending) return;
    if (!(a && b) && !quiet) notify(`最新の状態を読み込めませんでした。${state.overviewError || state.worksError}`, "error");
    ui.now = Date.now();
    renderStages();
    renderWorks();
  } finally {
    refreshing = false;
  }
}

function schedulePoll() {
  if (ui.timer) return;
  // 欄が開いている間（画面が前に出ている間）だけ、30 秒ごとに読み直す
  ui.timer = setInterval(() => {
    if (document.visibilityState !== "visible" || !state.stageId || ending) return;
    void refreshAll({ quiet: true });
  }, LIST_POLL_MS);
  // 「あと ○ 分受け付けます」を書き換える
  ui.clock = setInterval(() => {
    if (ending || $("app").hidden) return;
    ui.now = Date.now();
    renderStages();
  }, 30000);
}

// ---- 再生（設計 2.7・4.7。画面は置き場を知らず、サーバーが返した署名つき URL を使う） ----

/** 再生の URL を求める。URL は DB にもログにも残さない。失敗は文つきの Error */
async function fetchPlaybackUrl(workId) {
  const { data } = await activeClient().auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("ログインの期限が切れました。ページを開き直してください。");
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/submissions/playback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ work_id: workId }),
      cache: "no-store",
      referrerPolicy: "no-referrer",
      credentials: "omit",
    });
  } catch {
    throw new Error("通信できませんでした。通信状態を確かめてください。");
  }
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? (typeof body?.error === "string" ? body.error : null) ?? body?.code ?? null;
  if (!res.ok) throw new Error(playbackErrorText(res.status, code));
  if (typeof body?.url !== "string" || !body.url) throw new Error("再生の URL を受け取れませんでした。");
  return body.url;
}

function playbackErrorText(status, code) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  if (code === "cold_unavailable") return "この作品は保管庫に移っているため、まだ再生できません。";
  if (status === 404) return "この作品は再生できません（取り下げられたか、見る権限がありません）。最新にしてください。";
  if (status === 401 || status === 403) return "再生する権限がありません。ページを開き直してください。";
  if (status === 429 || status === 503) return "混み合っています。少し待ってから、もう一度押してください。";
  return "再生の準備ができませんでした。少し待ってから、もう一度押してください。";
}

/**
 * 動画の部品（プレーヤー・上映で共通）。load(workId, { autoplay }) で URL を求めて入れる。
 * 再生中に URL が切れて止まったら（error）、URL を取り直して同じ位置から続ける（1 つの作品で 2 回まで）。
 * 古い要求（別の作品を選んだあとに届いたもの）は捨てる
 */
function createVideoBox(onMessage) {
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("referrerpolicy", "no-referrer");
  video.className = "player-video";
  let token = 0;
  let current = null;
  let retries = 0;
  async function load(workId, { autoplay }) {
    const my = ++token;
    current = workId;
    retries = 0;
    onMessage("");
    try {
      const url = await fetchPlaybackUrl(workId);
      if (my !== token) return;
      video.src = url;
      if (autoplay) await video.play().catch(() => {});
    } catch (e) {
      if (my === token) onMessage(e instanceof Error ? e.message : "再生の準備ができませんでした。");
    }
  }
  video.addEventListener("error", () => {
    if (!current || !video.currentSrc) return;
    if (retries >= 2) {
      onMessage("再生できませんでした。少し待ってから、もう一度押してください。");
      return;
    }
    retries += 1;
    const my = ++token;
    const at = video.currentTime;
    const wasPlaying = !video.paused;
    void fetchPlaybackUrl(current)
      .then((url) => {
        if (my !== token) return;
        video.src = url;
        video.currentTime = at;
        if (wasPlaying) void video.play().catch(() => {});
      })
      .catch((e) => my === token && onMessage(e instanceof Error ? e.message : "再生できませんでした。"));
  });
  function stop() {
    token += 1;
    current = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  return { video, load, stop };
}

// ---- 表示 ----
// 上：回と段階（今の段階を強調して最初に開く）／中：一覧とプレーヤー／［上映の画面を開く］。見た目は講師ページ（instructor.html）と同じ

let player = null;
let screenRefresh = null;
let closeScreening = null;

function stopPlayer() {
  closeScreening?.();
  player?.box.stop();
  player = null;
  ui.playerEl = null;
}

function render() {
  if (ending) return; // ログアウトの途中・ほかのタブでログアウトしたあとは描かない
  const cards = [cohortCard()];
  if (state.overviewError) {
    cards.push(el("section", { className: "card" }, el("p", { className: "error-text", role: "alert", text: state.overviewError })));
  } else if (!state.cohorts.length) {
    cards.push(el("section", { className: "card" }, el("p", { className: "muted", text: "担当の回がありません。担当の登録は管理者に確かめてください。" })));
  } else {
    cards.push(el("section", { className: "card", id: "stages-card" }), el("section", { className: "card", id: "works-card" }));
  }
  $("view").replaceChildren(...cards);
  if ($("stages-card") && state.overview) {
    renderStages();
    renderWorks({ rebuildPlayer: true });
  }
}

function cohortCard() {
  const cohort = state.cohorts.find((c) => c.id === state.cohortId);
  const head = el(
    "div",
    { className: "card-head" },
    el("h2", { className: "cohort-name", text: cohort ? instructorCohortLabel(cohort) : "提出" }),
    el("button", { type: "button", className: "btn compact", id: "reload-btn", text: "最新にする", onclick: () => void refreshAll() }),
  );
  const parts = [head];
  if (state.cohorts.length > 1) {
    parts.push(
      el(
        "select",
        {
          className: "input cohort-pick",
          id: "cohort-pick",
          "aria-label": "回を選ぶ",
          onchange: (e) => {
            state.cohortId = e.target.value;
            void reloadAfterCohortChange();
          },
        },
        ...state.cohorts.map((c) => el("option", { value: c.id, text: instructorCohortLabel(c), ...(c.id === state.cohortId ? { selected: true } : {}) })),
      ),
    );
  }
  return el("section", { className: "card" }, ...parts);
}

/** 段階の一覧（行を押すと、その段階の作品を開く） */
function renderStages() {
  const card = $("stages-card");
  if (!card || !state.overview) return;
  const rows = state.overview.stages.map((s) => {
    const selected = s.stageId === state.stageId;
    return el(
      "li",
      {},
      el(
        "button",
        {
          type: "button",
          className: `stage-row${selected ? " selected" : ""}${s.isCurrent ? " now" : ""}`,
          "aria-pressed": selected ? "true" : "false",
          "data-stage": s.stageId,
          onclick: () => selectStage(s.stageId),
        },
        el("span", { className: "stage-name" }, submissionStageName(s), s.isCurrent ? el("span", { className: "badge active now-badge", text: "今" }) : null),
        el("span", { className: "stage-accept", text: instructorAcceptLabel(s, ui.now) }),
        el("span", { className: "stage-count tabular", text: stageCountsLabel(s) }),
      ),
    );
  });
  card.replaceChildren(el("h2", { text: "段階" }), el("ul", { className: "stage-list" }, ...rows));
}

function selectStage(stageId) {
  if (stageId === state.stageId) return;
  state.stageId = stageId;
  state.selectedWorkId = null;
  state.works = null;
  state.worksError = "";
  ui.openFolds.clear();
  stopPlayer();
  renderStages();
  renderWorks({ rebuildPlayer: true });
  void reloadWorks();
}

function foldNode(key, title, bodyChildren) {
  const details = el("details", { className: "plain-fold minor" }, el("summary", {}, el("span", { text: title })), el("div", { className: "fold-in" }, ...bodyChildren));
  if (ui.openFolds.has(key)) details.open = true;
  details.addEventListener("toggle", () => (details.open ? ui.openFolds.add(key) : ui.openFolds.delete(key)));
  return details;
}

function workButton(work, stage) {
  const r = workRow(work);
  const badge = scopeBadge(work, stage.kind);
  const selected = work.workId === state.selectedWorkId;
  const kids = [
    el("span", { className: "work-label", text: selected ? `▶ ${r.label}` : r.label }),
    el("span", { className: "tabular", text: r.duration ?? "—" }),
    el("span", { className: "tabular muted", text: r.time }),
  ];
  if (r.opus) kids.push(el("span", { className: "opus-mark", title: r.opus.title, "aria-label": r.opus.title, text: r.opus.text }));
  if (badge) kids.push(el("span", { className: `scope-badge ${badge.tone}`, text: badge.label }));
  const btn = el("button", { type: "button", className: `work-row${selected ? " selected" : ""}`, "data-work": work.workId, "aria-pressed": selected ? "true" : "false", onclick: () => selectWork(work.workId) }, ...kids);
  if (stage.kind === "bridge" && (work.title || work.purpose)) {
    return el(
      "div",
      { className: "work-wrap" },
      btn,
      el("div", { className: "work-survey small" }, work.title ? el("div", { className: "work-title", text: work.title }) : null, work.purpose ? el("div", { className: "muted", text: work.purpose }) : null),
    );
  }
  return btn;
}

function personNode(p, stage) {
  return el("div", { className: "person" }, el("div", { className: "person-name", text: p.name }), ...p.works.map((w) => workButton(w, stage)));
}

/** 一覧とプレーヤー。rebuildPlayer：プレーヤーも作り直す（段階を替えた・初回）。30 秒ごとの読み直しでは作り直さず、再生を止めない */
function renderWorks({ rebuildPlayer = false } = {}) {
  const card = $("works-card");
  const stage = stageById(state.stageId);
  if (!card || !stage) return;
  const v = state.works;
  const head = el(
    "div",
    { className: "card-head" },
    el("h2", { text: submissionStageName(stage) }),
    el("span", { className: "muted small", text: `${instructorAcceptLabel(stage, ui.now)} · ${stageCountsLabel(stage)}` }),
  );
  const list = el("div", { className: "works-list", id: "works-list" });
  if (state.worksError) list.append(el("p", { className: "error-text", role: "alert", text: state.worksError }));
  else if (!v) list.append(el("p", { className: "muted", text: "読み込み中…" }));
  else {
    if (!v.people.length && !v.pending.length) list.append(el("p", { className: "muted", text: "まだ提出はありません。" }));
    for (const p of v.people) list.append(personNode(p, stage));
    // 「まだ」：ワークショップだけ。ブリッジワークは分母と「まだ」を出さない（自主的な制作の扱い。助成金の注意）
    if (stage.kind === "workshop") for (const p of v.pending) list.append(el("div", { className: "person" }, el("div", { className: "person-name", text: p.name }), el("span", { className: "muted", text: "まだ" })));
    for (const [key, group] of [["stopped", v.stopped], ["unknown", v.unknown]]) {
      if (group.length) list.append(foldNode(key, foldTitle(key, group), group.map((p) => personNode(p, stage))));
    }
  }
  const screeningBtn = el("button", { type: "button", className: "btn compact", id: "screening-btn", text: "上映の画面を開く", onclick: openScreening });
  if (!v || screeningQueue(v).length === 0) screeningBtn.disabled = true;
  const playerNode = ui.playerEl && !rebuildPlayer ? ui.playerEl : buildPlayer();
  card.replaceChildren(head, el("div", { className: "works-layout" }, list, playerNode), el("div", { className: "row-actions" }, screeningBtn));
  syncPlayerButtons();
}

function buildPlayer() {
  stopPlayer();
  const caption = el("div", { className: "player-caption", id: "player-caption", text: "作品を選んでください。" });
  const msg = el("p", { className: "error-text small", id: "player-msg", role: "alert", hidden: true });
  const banner = el("p", { className: "note-box", id: "private-banner", hidden: true, text: PRIVATE_BANNER });
  const box = createVideoBox((t) => {
    msg.textContent = t;
    msg.hidden = !t;
  });
  const prev = el("button", { type: "button", className: "btn compact", text: "◀ 前", id: "prev-btn", onclick: () => stepWork("prev") });
  const play = el("button", { type: "button", className: "btn compact primary", text: "▶ 再生", id: "play-btn", onclick: () => playSelected() });
  const next = el("button", { type: "button", className: "btn compact", text: "次 ▶", id: "next-btn", onclick: () => stepWork("next") });
  const wrap = el("div", { className: "player" }, banner, box.video, caption, msg, el("div", { className: "row-actions" }, prev, play, next));
  player = { box, caption, msg, banner, prev, play, next, selectedPolicy: null };
  ui.playerEl = wrap;
  return wrap;
}

function selectedEntry() {
  // 単体の手動確認は折り畳みの作品も対象。前後・上映の並びは people だけのまま。
  for (const group of ["people", "stopped", "unknown"]) {
    for (const p of state.works?.[group] ?? []) {
      const work = p.works.find((w) => w.workId === state.selectedWorkId);
      if (work) return { person: p.name, identity: p.identity, work, group };
    }
  }
  return null;
}

function syncPlayerButtons() {
  screenRefresh?.();
  if (!player) return;
  const entry = selectedEntry();
  const q = playbackQueue(state.works);
  player.prev.disabled = !neighborInQueue(q, state.selectedWorkId, "prev");
  player.next.disabled = !neighborInQueue(q, state.selectedWorkId, "next");
  player.play.disabled = !entry;
  // 読み直しで、選んでいた作品が取り下げられて一覧から消えたとき：選びを外し、再生を止める
  if (state.selectedWorkId && !entry) {
    state.selectedWorkId = null;
    player.box.stop();
    player.caption.textContent = "選んでいた作品は、一覧から外れました。";
    player.banner.hidden = true;
    player.selectedPolicy = null;
  } else if (entry) {
    const policy = `${entry.group}:${entry.work.scope}`;
    if (player.selectedPolicy !== null && player.selectedPolicy !== policy && (needsManualPlay(entry.work) || entry.group !== "people")) {
      player.box.stop(); // private化・停止・名簿外への移動は明示的な［再生］へ戻す
    }
    player.selectedPolicy = policy;
    player.banner.hidden = !needsManualPlay(entry.work);
    player.caption.textContent = playerCaption(entry);
  }
}

function selectWork(workId) {
  if (!player) return;
  state.selectedWorkId = workId;
  const e = selectedEntry();
  if (!e) return;
  player.caption.textContent = playerCaption(e);
  const priv = needsManualPlay(e.work);
  player.selectedPolicy = `${e.group}:${e.work.scope}`;
  player.banner.hidden = !priv;
  player.box.stop();
  player.msg.hidden = true;
  // 完全非公開は、［▶ 再生］を押すまで動画の URL も求めない（プロジェクターに映さない。設計 4.8）
  if (!priv && e.group === "people") void player.box.load(workId, { autoplay: false });
  renderWorks();
}

function playSelected() {
  const e = selectedEntry();
  if (!e || !player) return;
  void player.box.load(e.work.workId, { autoplay: true });
}

function stepWork(dir) {
  const n = neighborInQueue(playbackQueue(state.works), state.selectedWorkId, dir);
  if (n) selectWork(n.work.workId);
}

// ---- 上映の画面（全画面。公開と講義内に限り公開の、出している作品だけ。設計 4.8） ----

function openScreening() {
  closeScreening?.();
  const dialog = $("screen");
  let queue = screeningQueue(state.works);
  if (!queue.length || !dialog) return;
  let index = 0;
  let auto = false;
  let currentId = null;
  let closed = false;
  const msg = el("p", { className: "error-text", role: "alert", hidden: true });
  const box = createVideoBox((t) => {
    msg.textContent = t;
    msg.hidden = !t;
  });
  const caption = el("div", { className: "screen-caption" });
  const prev = el("button", { type: "button", className: "btn", text: "前へ", onclick: () => step(-1) });
  const next = el("button", { type: "button", className: "btn", text: "次へ", onclick: () => step(1) });
  const seq = el("button", {
    type: "button",
    className: "btn primary",
    text: "順に再生",
    onclick: () => {
      if (!refreshQueue()) return;
      auto = true;
      go(index);
    },
  });
  const close = el("button", { type: "button", className: "btn", text: "閉じる", onclick: () => dialog.close() });
  function refreshQueue() {
    if (closed || !dialog.open) return false;
    queue = screeningQueue(state.works);
    const at = currentId === null ? 0 : queue.findIndex((e) => e.work.workId === currentId);
    if (!queue.length || at < 0) { auto = false; box.stop(); dialog.close(); return false; }
    index = at;
    caption.textContent = playerCaption(queue[index]);
    prev.disabled = index === 0;
    next.disabled = index === queue.length - 1;
    return true;
  }
  function step(dir) {
    if (refreshQueue()) go(index + dir);
  }
  function go(i) {
    if (!refreshQueue()) return;
    index = Math.max(0, Math.min(queue.length - 1, i));
    currentId = queue[index].work.workId;
    caption.textContent = playerCaption(queue[index]);
    prev.disabled = index === 0;
    next.disabled = index === queue.length - 1;
    void box.load(queue[index].work.workId, { autoplay: auto });
  }
  box.video.addEventListener("ended", () => {
    if (auto && refreshQueue() && index < queue.length - 1) go(index + 1);
    else auto = false;
  });
  dialog.replaceChildren(el("div", { className: "screen-body" }, box.video, caption, msg, el("div", { className: "row-actions" }, prev, next, seq, close)));
  dialog.addEventListener(
    "close",
    () => {
      closed = true;
      auto = false;
      box.stop();
      dialog.replaceChildren();
      if (screenRefresh === refreshQueue) { screenRefresh = null; closeScreening = null; }
    },
    { once: true },
  );
  screenRefresh = refreshQueue;
  closeScreening = () => dialog.close();
  dialog.showModal();
  go(0);
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
      showLoginNote(MSG_TEACHER_LOGIN_FIRST + chosen.guide);
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
  // 講師の区分（共有のログインで通った）なら、確かめに使った担当の回の答えをそのまま使う。管理者として動くときは管理コンソールの部品で読み直す
  await load(chosen.shared ? { cohorts: chosen.cohorts ?? null } : {});
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
// ヘッダーの［ログアウト］のアイコン（スマホの幅で出す。形は site-nav.js）
fillIcons();
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
