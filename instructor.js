// 講師の画面。担当する回の「段階」を進める・戻す、受講者の使用量を見る、一時追加と自分の追加の取り消しを、本人のログインで行う。
// 書き込みはすべて DB の RPC（cohort_stage_move・instructor_grant・revoke_stage_grant。権限・上限・段階の判定は DB が決める）。
// ログインはマイページ（mypage.js）・Canvas と共有する（決定 70。localStorage の共有の鍵・最長 14 日）。ページを離れても、
// 操作しなくてもログアウトしない。ほかのタブでログアウトしたら、この画面も中身を消して読み込み直す。
// 管理者は、同じブラウザの管理コンソールの有効なセッション（管理コンソールの鍵）で動く（設計書 docs/design-canvas-login-link.md 5.3.1。
// 1932 のあと is_admin() は管理コンソールのセッションだけ）。講師の区分の人は、今までどおり共有のログインで動く。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// supabase-js は instructor.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
// ページは 2 つ：回の一覧（/instructor）と、ある回の操作（/instructor/c/<回の ID>）。同じ instructor.html・instructor.js が、道（ROUTE）を見て描き分ける
// （設計書 docs/design-instructor-split.md）。ログイン・ログアウト・管理者として使う部分は道に関わらず同じ
import { backToListLink, cohortListView, cohortMissingView } from "./instructor-list.js";
import { extraTargets, groupCohorts, instructorRoute } from "./instructor-list-lib.js";
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
  formatMonthDay,
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
  stageStateLabel,
  stageTimeline,
  undoView,
} from "./stage-lib.js";
import { fillIcons, renderSiteNav } from "./site-nav.js";
import {
  cohortCloseCanAct,
  cohortCloseError,
  cohortCloseLines,
  cohortCloseSameIdentity,
  cohortCloseSlotVisible,
  createCohortCloseAction,
  normalizeCohortCloseStatus,
} from "./cohort-close-lib.js";

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

// 講師の画面は 016 の DB でだけ働く（016 の前は「まだ使えません」）。DB の日本語の hint をそのまま出す
setStageDbReady(true);

/** このページの道：一覧（/instructor）か、ある回の操作（/instructor/c/<回の ID>）か。ページを移るたびにこの画面は作り直されるので、開いたときに 1 回だけ読む */
const ROUTE = instructorRoute(location.pathname);

/**
 * 一覧のページだけが使う画面の状態（描き直しても保つ。回の操作のページは使わない）。
 * endedOpen：「終わった回」の折りたたみを開いているか（最初は閉じる）／closed：クローズ済みと分かった回の ID／stages：回ごとの { studentCount, stageLabel }
 * （どちらもあとから届く追加の情報。読めなかった回は入れない）／seq：追加の情報の読み込みの通し番号（古い応答を捨てる）
 */
const listUi = { endedOpen: false, closed: new Set(), stages: new Map(), seq: 0 };

/** 回の操作のページで、URL の回が自分の一覧に無いとき true（その回の RPC を 1 つも呼ばない。pinRouteCohort が決める） */
let routeMissing = false;

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
  /** cohort_close_status を読んだもの（normalizeCohortCloseStatus）。null は未読込・読めなかった（221。決定 96） */
  closeStatus: null,
  closeStatusError: "",
  /** 操作の通信中（二重に押させない） */
  busy: false,
  /** 追加の相手に選んだ受講者の email */
  selected: new Set(),
  /** 追加の入力欄の値（描き直しても残す） */
  creditsText: "",
  noteText: "",
};

/**
 * 画面だけの開閉の状態（描き直しても、講師が開いた・閉じた所を保つ。state には入れない。hideContent が空にするので、その前に置く）。
 * openDays：回ごとの { base（最初に開く日＝今日の日）, manual（講師が手で開け閉めした日 → 開けた true／閉じた false） }。
 *   開いている日 = 今日の日 ＋ 手で開けた日 − 手で閉じた日。日が替わったら、前の今日の日は手で開けていなければ閉じ、
 *   新しい今日の日は開く（前に手で閉じていても。「今」の行を隠さない）。
 * folds：クレジットの追加の欄で開いている折りたたみ（"limits" | "mine" | "revoked"）
 */
const ui = { openDays: new Map(), folds: new Set() };

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
  $("me-role").title = "";
  renderSiteNav($("site-nav"), null, "instructor");
  $("denied-email").textContent = "";
  $("view").replaceChildren();
  $("notice").replaceChildren();
  $("confirm").close?.();
  $("confirm").replaceChildren();
  stopUndoTimer();
  state.status = null;
  state.closeStatus = null;
  state.closeStatusError = "";
  closeStatusSeq++;
  state.cohorts = [];
  state.cohortId = null;
  state.selected.clear();
  state.creditsText = "";
  state.noteText = "";
  ui.openDays.clear();
  ui.folds.clear();
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

/** cohort_stage_status の読み込みの通し番号。古い応答（あとから始めた読み込み・操作のあとに返ってきたもの）は捨てる */
let statusSeq = 0;
/** cohort_close_status の読み込みの通し番号（段階の読み込みとは別に数える） */
let closeStatusSeq = 0;

/** 回のクローズの状態は段階とは別に読む。未導入・欠損を 0 人や操作できるとは扱わない（0179） */
async function loadCloseStatus() {
  const requested = state.cohortId;
  const client = activeClient();
  const identity = closeIdentity();
  const seq = ++closeStatusSeq;
  if (!requested) {
    state.closeStatus = null;
    state.closeStatusError = "";
    return false;
  }
  let response;
  try {
    response = await rpc("cohort_close_status", { p_cohort_id: requested });
  } catch (error) {
    response = { data: null, error };
  }
  if (ending || requested !== state.cohortId || client !== activeClient() || seq !== closeStatusSeq || !cohortCloseSameIdentity(closeIdentity(), identity)) return false;
  const { data, error } = response ?? {};
  const status = error ? null : normalizeCohortCloseStatus(data, requested);
  state.closeStatus = status;
  state.closeStatusError = status ? "" : cohortCloseError(error ?? { message: "cohort_close_invalid_response" });
  return !!status;
}

/** 段階とクローズの状態を並べて読む（［最新にする］・操作のあと・回の切り替え）。返り値は段階の読み込みの成否 */
async function loadStatusAndClose() {
  const [ok] = await Promise.all([loadStatus(), loadCloseStatus()]);
  return ok;
}

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

/**
 * 回を道（ROUTE）に固定する。共有の loadCohorts は、選んでいる回が一覧に無いと最初の回を黙って選ぶので、そのすぐあとで呼ぶ
 * （操作のページで URL と違う回に化けさせない）。
 * 操作のページ：URL の回が自分の一覧にあれば、その回に固定する。無ければ（形が正しくない・担当から外れた・回が消えた）回を持たず、
 * 「開けない回」の印を立てて、前の回の段階・クローズの状態・選んだ受講者を消す（その回の RPC は 1 つも呼ばない）。
 * 一覧のページ：回を持たない（段階の読み込みは呼ばれない）
 */
function pinRouteCohort() {
  routeMissing = false;
  if (ROUTE.kind !== "cohort") {
    state.cohortId = null;
    return;
  }
  if (ROUTE.cohortId !== null && state.cohorts.some((c) => c.id === ROUTE.cohortId)) {
    state.cohortId = ROUTE.cohortId;
    return;
  }
  routeMissing = true;
  state.cohortId = null;
  state.status = null;
  state.statusError = "";
  state.closeStatus = null;
  state.closeStatusError = "";
  statusSeq++;
  closeStatusSeq++;
  state.selected.clear();
}

/** 操作のページで、書き込みを送ってよいか：URL の回と、この画面が持っている回が同じで、開けない回の印が立っていないとき */
function operableCohort() {
  return ROUTE.kind === "cohort" && !routeMissing && state.cohortId !== null && state.cohortId === ROUTE.cohortId;
}

/**
 * 一覧のページの追加の情報（読むだけ。待たない。失敗しても知らせず、その行を空けておく）。
 * Day2 の回は cohort_close_status でクローズ済みかを聞き（並べ方に要る）、上の段の先頭の数件は cohort_stage_status で受講者の数と今の段階を聞く。
 * 古い応答（ログアウトの途中・もう 1 回の読み込み・部品やログインの切り替わり）は入れない。届いたら一覧を描き直す
 */
async function loadListExtras() {
  if (ROUTE.kind !== "list" || ending) return;
  const seq = ++listUi.seq;
  const client = activeClient();
  const identity = closeIdentity();
  const { closeIds, stageIds } = extraTargets(groupCohorts(state.cohorts));
  for (const id of [...listUi.stages.keys()]) if (!stageIds.includes(id)) listUi.stages.delete(id);
  const live = () => !ending && ROUTE.kind === "list" && seq === listUi.seq && client === activeClient() && cohortCloseSameIdentity(closeIdentity(), identity);
  const changed = [];
  const read = async (name, id, use) => {
    let response;
    try {
      response = await rpc(name, { p_cohort_id: id });
    } catch {
      return;
    }
    if (!live() || response?.error || !state.cohorts.some((c) => c.id === id)) return;
    try {
      if (use(response.data) !== false) changed.push(id);
    } catch {
      // 形が違う応答は、その行を空けておく
    }
  };
  await Promise.all([
    ...closeIds.map((id) =>
      read("cohort_close_status", id, (data) => {
        const status = normalizeCohortCloseStatus(data, id);
        if (!status) return false; // 読めなかった：クローズ済みとも、そうでないとも決めない
        if (status.state === "closed") listUi.closed.add(id);
        else listUi.closed.delete(id);
      })
    ),
    ...stageIds.map((id) =>
      read("cohort_stage_status", id, (data) => {
        const s = normalizeStageStatus(data);
        // Day ごとの枠の回は段階も受講者の数も出さない
        if (s.creditMode !== "stage") return false;
        listUi.stages.set(id, { studentCount: s.students.length, stageLabel: s.current ? stageName(s.current) : "" });
      })
    ),
  ]);
  if (changed.length && live()) render();
}

/** 担当の回を読み、読めたら選んでいる回の段階の状態を読む（段階の状態は回が決まってから）。{ c, ok }（c は loadCohorts の答え） */
async function loadCohortsAndStatus(first = null) {
  const c = await loadCohorts(first);
  if (ending || c.stale || c.error) return { c, ok: false };
  pinRouteCohort();
  // 一覧のページ・開けない回：回ごとの読み込み（段階・クローズ・タイマー）は 1 つも呼ばない。一覧は追加の情報だけ、待たずに読み始める
  if (state.cohortId === null) {
    if (ROUTE.kind === "list") void loadListExtras();
    return { c, ok: true };
  }
  return { c, ok: await loadStatusAndClose() };
}

let loading = false;

/**
 * 読み込んで画面を切り替える。初回（読み込み中の画面）と「最新にする」の両方で使う。
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
    // 各 await のあとに、ログアウトの途中（ending）でないかを照らす。途中なら state・ヘッダー・お知らせ・画面を変えずに終わる（F107-04）
    let c;
    let ok;
    if (!fromApp) {
      // 区分（is_admin）・Google のメール・担当の回（と段階の状態）は互いの答えを待たないので、並べて読む（ページを開く速さ。2026-10-23）。
      // どれも読むだけ。答えを使うのは、全部がそろってから ending を照らしたあと（loadCohorts・loadStatus は自分でも照らして state を変えない）
      const [adminRes, emailRes, sessionRes, loaded] = await Promise.all([
        rpc("is_admin"),
        rpc("current_google_email"),
        activeClient().auth.getSession(),
        loadCohortsAndStatus(cohorts),
      ]);
      if (ending) return;
      state.isAdmin = adminRes?.data === true;
      state.myEmail = normalizeEmail(emailRes?.data ?? sessionRes?.data?.session?.user?.email ?? "");
      ({ c, ok } = loaded);
    } else {
      ({ c, ok } = await loadCohortsAndStatus());
    }
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
    if (ending) return;
    if (!ok && fromApp) notify(`最新の状態を読み込めませんでした。${state.statusError}`, "error");
    $("me-email").textContent = adminSession ? adminWho() : state.myEmail;
    $("me-email").title = state.myEmail;
    const role = $("me-role");
    role.textContent = state.isAdmin ? "管理者" : "講師";
    role.className = `badge ${state.isAdmin ? "admin" : "instructor"}`;
    // メール（管理者として動いているときは期限の説明も）は画面に出さず、区分の印の title に置く（2026-10-23 田口さん：説明の文字は消す）
    role.title = $("me-email").textContent;
    // 画面の間の移動：区分の印と同じ is_admin() の答えで決める（管理者として動いているときだけ管理ページも。案内だけ）
    // 回の操作のページだけ、メニューの「講師ページ」を一覧へのリンクにする（ハイライトはそのまま。一覧のページは今までどおりリンクにしない）
    const navArgs = ROUTE.kind === "cohort" ? [document, { linkCurrent: true }] : [];
    renderSiteNav($("site-nav"), state.isAdmin ? "admin" : "instructor", "instructor", ...navArgs);
    render();
    show("app");
  } finally {
    loading = false;
  }
}

/** 操作のあと：段階と受講者の最新を読み直して描き直す */
async function reloadStatus() {
  const ok = await loadStatusAndClose();
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

// ---- 表示 ----
// 上から：回の見出し → ワークショップ（今を強調）と進める・戻す →（0179 の枠）→ 受講者 → クレジットの追加
// （設計 docs/design-instructor-page-v2.md 3 章。見た目は管理コンソールにそろえる。操作の守りは「操作」の部分のまま）

/** 状態の言葉のバッジ（管理コンソールの回の状態と同じ組） */
const STATE_BADGE = { done: "ended", now: "active", next: "upcoming" };

let undoTimer = null;

function stopUndoTimer() {
  if (undoTimer) clearInterval(undoTimer);
  undoTimer = null;
}

/** 回の一覧のページの［最新にする］・「この回は開けません」の［最新にする］ */
async function refreshFromView() {
  clearNotice();
  await load({ fromApp: true });
}

function render() {
  if (ending) return; // ログアウトの途中・ほかのタブでログアウトしたあとは描かない
  const view = $("view");
  if (ROUTE.kind === "cohort" && routeMissing) {
    // URL の回が自分の一覧に無い：操作のボタン・入力欄ごと消して、札だけを出す（書き込みも読み込みもその回では行わない）
    stopUndoTimer();
    document.title = "この回は開けません – A.I.KEN Studio 講師の画面";
    view.replaceChildren(cohortMissingView({ el, cohortId: ROUTE.cohortId, onRefresh: refreshFromView }));
    return;
  }
  if (!state.cohorts.length) {
    stopUndoTimer();
    view.replaceChildren(
      el(
        "section",
        { className: "card", "aria-labelledby": "cohort-h" },
        el("h2", { id: "cohort-h", text: "担当する回がありません。" }),
        el("p", { className: "hint", text: "担当の登録は管理者に頼んでください。" }),
      ),
    );
    return;
  }
  if (ROUTE.kind === "list") {
    // 回の一覧のページ：1 つの回が 1 つのリンク。実施中とこれからは上、終わった回は折りたたみ。操作・時計は持たない
    stopUndoTimer();
    document.title = "回の一覧 – A.I.KEN Studio 講師の画面";
    view.replaceChildren(
      cohortListView({
        el,
        groups: groupCohorts(state.cohorts, listUi.closed),
        extras: listUi,
        endedOpen: listUi.endedOpen,
        onToggleEnded: (open) => (listUi.endedOpen = open),
        onRefresh: refreshFromView,
        busy: state.busy,
      }),
    );
    return;
  }
  const here = state.cohorts.find((x) => x.id === state.cohortId);
  document.title = `${here?.name ?? here?.id ?? "回の操作"} – A.I.KEN Studio 講師の画面`;
  const parts = [backToListLink({ el }), cohortCard()];
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
  } else if (s.creditMode === "stage") {
    parts.push(stageCard(s), closeSlot(), studentsCard(s), grantCard(s));
  }
  view.replaceChildren(...parts.filter(Boolean));
  updateUndoTimer();
  updateGrantButton();
}

/** 回の見出し：回の名前・ID と会場と日付・期間のバッジ・今の段階とそのクレジット数・［最新にする］ */
function cohortCard() {
  const s = state.status;
  const c = state.cohorts.find((x) => x.id === state.cohortId) ?? {};
  const cs = s?.period ? cohortStatus(s.period) : null;
  const meta = [
    c.id,
    c.venueName,
    c.day1Date ? `Day1 ${formatMonthDay(c.day1Date)}` : null,
    c.day2Date ? `Day2 ${formatMonthDay(c.day2Date)}` : null,
  ].filter(Boolean).join(" · ");
  const picker = ROUTE.kind !== "cohort" && state.cohorts.length > 1
    ? el(
      "div",
      { className: "cohort-pick" },
      el("label", { className: "field-label", for: "cohort-select", text: "回" }),
      (() => {
        const select = el(
          "select",
          { className: "input tabular", id: "cohort-select", disabled: state.busy },
          ...state.cohorts.map((x) => el("option", { value: x.id, text: instructorCohortLabel(x), selected: x.id === state.cohortId })),
        );
        select.addEventListener("change", () => {
          state.cohortId = select.value;
          state.status = null;
          state.statusError = "";
          state.closeStatus = null;
          state.closeStatusError = "";
          closeStatusSeq++;
          state.selected.clear();
          ui.openDays.delete(select.value); // 切り替えた回は、その回の初期値（今を含む日）から開く
          render();
          loadStatusAndClose().then(render);
        });
        return select;
      })(),
    )
    : null;
  return el(
    "section",
    { className: "card head-card", "aria-labelledby": "cohort-h" },
    el(
      "div",
      { className: "card-head" },
      el("h2", { id: "cohort-h", className: "cohort-name", text: c.name ?? s?.name ?? c.id ?? "—" }),
      el(
        "div",
        { className: "row-actions" },
        cs ? el("span", { className: `badge ${cs.kind}`, text: cs.label }) : null,
        isClosed() ? el("span", { className: "badge ended", id: "cohort-closed-badge", text: "クローズ済み" }) : null,
        el("button", {
          type: "button",
          className: "btn compact",
          text: "最新にする",
          disabled: state.busy,
          onclick: async () => {
            clearNotice();
            await load({ fromApp: true });
          },
        }),
      ),
    ),
    meta ? el("p", { className: "cohort-meta tabular", text: meta }) : null,
    picker,
    nowLine(s),
  );
}

/** 回の見出しの「今」の行（今の段階が無いときは期間の 1 行。Day ごとの回は 2 行の案内） */
function nowLine(s) {
  if (!s) return null;
  if (s.creditMode !== "stage") {
    return el("div", { className: "stack" }, el("p", { text: "この回は Day ごとの枠です。" }), el("p", { className: "hint", text: "段階の操作はありません。" }));
  }
  if (s.current) {
    return el(
      "div",
      { className: "now-line" },
      el("span", { className: "badge active", text: "今" }),
      el("span", { className: "now-name", id: "stage-current", text: stageName(s.current) }),
      s.current.credits === null ? null : el("span", { className: "now-credits tabular", text: `${formatCredits(s.current.credits)} クレジット` }),
    );
  }
  const text = s.period === "before" ? "Day1 の 0:00 に始まります。" : s.period === "after" ? "Day2 は終わりました。" : "今の段階はありません。";
  return el("p", { className: "now-line quiet", text });
}

/** ワークショップ：日ごとのリスト（今日の日だけ開く）・60 秒の取り消し・［前へ戻す］［次へ進める］・押せない理由 */
function stageCard(s) {
  const mv = stageMoveView(s);
  const undo = undoView(s, Date.now());
  const tl = stageTimeline(s);
  const cohortId = state.cohortId; // 描いたときの回（toggle が遅れて届いても、この回の記録にだけ書く）
  const opened = openDaysOf(tl, cohortId);
  const move = (direction) => moveStage(direction, mv, s);
  const closed = isClosed();
  const why = closed ? MSG_CLOSED_NO_MOVE : moveWhy(mv);
  return el(
    "section",
    { className: "card", "aria-labelledby": "wk-h" },
    el("h2", { id: "wk-h", text: "ワークショップ" }),
    tl.groups.length ? el("div", { className: "wk-list", role: "group", "aria-label": "ワークショップの一覧" }, ...tl.groups.map((g) => dayFold(g, opened, cohortId))) : null,
    undo.available && !closed
      ? el(
        "div",
        { className: "undo-box", id: "undo-box" },
        el(
          "div",
          { className: "undo-lines" },
          el("p", { id: "undo-text", text: undoText(undo) }),
          el("p", { id: "undo-jobs", className: "small", text: undoJobsText(undo), hidden: undo.jobsSince === null }),
        ),
        el("button", {
          type: "button",
          className: "btn",
          text: "前の段階に戻す",
          disabled: state.busy,
          onclick: () => undoMove(undo, s),
        }),
      )
      : null,
    el(
      "div",
      { className: "move-row" },
      el("button", { type: "button", className: "btn big", id: "move-back", text: "前へ戻す", disabled: state.busy || closed || !mv.canPrev, title: closed ? MSG_CLOSED_NO_MOVE : mv.canPrev ? null : mv.prevWhy, onclick: () => move("back") }),
      el("button", { type: "button", className: "btn primary big", id: "move-next", text: "次へ進める", disabled: state.busy || closed || !mv.canNext, title: closed ? MSG_CLOSED_NO_MOVE : mv.canNext ? null : mv.nextWhy, onclick: () => move("next") }),
    ),
    why ? el("p", { className: "hint", id: "move-why", text: why }) : null,
  );
}

/** 押せない理由の 1 行（前も次も無い日は「1 つだけ」にまとめる） */
function moveWhy(mv) {
  if (mv.canPrev && mv.canNext) return "";
  if (mv.whyOff) return mv.whyOff;
  if (!mv.prev && !mv.next) return "今日の段階は 1 つだけです。";
  return [mv.canPrev ? "" : mv.prevWhy, mv.canNext ? "" : mv.nextWhy].filter(Boolean).join(" ");
}

/** その日が開いているか（手で開け閉めした日はその値、ほかは今日の日だけ） */
function dayIsOpen(rec, key) {
  return rec.manual.has(key) ? rec.manual.get(key) : key === rec.base;
}

/**
 * その回の開いている日（ui に覚えたもの）。開いている日 = 今日の日 ＋ 手で開けた日 − 手で閉じた日。
 * 日が替わったら（最初に開く日が変わったら）、新しい今日の日の手の記録だけを消して開く。前の今日の日は、手で開けていなければ閉じる
 */
function openDaysOf(tl, cohortId) {
  const base = tl.groups.find((g) => g.open)?.dayKind ?? "";
  let rec = ui.openDays.get(cohortId);
  if (!rec) {
    rec = { base, manual: new Map() };
    ui.openDays.set(cohortId, rec);
  } else if (rec.base !== base) {
    rec.base = base;
    rec.manual.delete(base);
  }
  return new Set(tl.groups.map((g) => g.dayKind ?? "").filter((key) => dayIsOpen(rec, key)));
}

/** 1 日分の折りたたみ：見出し「Day2（今日）［今］4 つ」と、段階の行 */
function dayFold(g, opened, cohortId) {
  const key = g.dayKind ?? "";
  const name = `${g.label}${g.isToday ? "（今日）" : ""}`;
  const word = stageStateLabel(g.state);
  const count = `${g.rows.length} つ`;
  const node = el(
    "details",
    { className: `plain-fold wk-day${g.state ? ` ${g.state}` : ""}`, open: opened.has(key), "data-day": key },
    el(
      "summary",
      { "aria-label": [name, word, count].filter(Boolean).join("、") },
      el("span", { className: "wk-day-name", text: name }),
      word ? el("span", { className: `badge ${STATE_BADGE[g.state]}`, text: word }) : null,
      el("span", { className: "meta tabular", text: count }),
    ),
    el("ol", { className: "wk-rows" }, ...g.rows.map(wkRow)),
  );
  node.addEventListener("toggle", () => {
    // 描き直しで画面から外れた折りたたみの toggle は使わない。覚えている値と同じ（open の属性で届くもの）は触ったと数えない
    if (!node.isConnected) return;
    const rec = ui.openDays.get(cohortId);
    if (!rec || node.open === dayIsOpen(rec, key)) return;
    rec.manual.set(key, node.open);
  });
  return node;
}

/** 段階の行：状態の言葉・名前・クレジット数（今の行は aria-current） */
function wkRow(r) {
  const word = stageStateLabel(r.state);
  return el(
    "li",
    { className: `wk-row${r.state ? ` ${r.state}` : ""}`, "aria-current": r.state === "now" ? "step" : null },
    el("span", { className: "wk-state" }, word ? el("span", { className: `badge ${STATE_BADGE[r.state]}`, text: word }) : null),
    el("span", { className: "wk-name", text: stageName(r.stage) }),
    el("span", { className: "wk-credits tabular", text: r.stage.credits === null ? "—" : `${formatCredits(r.stage.credits)} クレジット` }),
  );
}

/** クローズ済みか（読めていないときは偽。操作の可否は DB が決める） */
function isClosed() {
  return state.closeStatus?.state === "closed";
}

const MSG_CLOSED_NO_MOVE = "クローズ済みです。先に開き直してください。";

/**
 * 回のクローズ（0179。決定 96）の札。出すのは Day2 の最後の段階が今のとき・Day2 のあと・クローズ済みのとき・
 * Day2 以降でクローズの状態を読めなかったときだけ（設計 2.6。cohortCloseSlotVisible）。それ以外は中身の無い隠した枠。
 * 読み直しは回の見出しの［最新にする］にまとめた（loadStatusAndClose）
 */
function closeSlot() {
  const status = state.closeStatus;
  if (!cohortCloseSlotVisible(state.status, status, state.closeStatusError)) {
    return el("section", { id: "cohort-close-panel", hidden: true, "aria-label": "回のクローズ" });
  }
  const lines = state.closeStatusError ? [state.closeStatusError] : cohortCloseLines(status);
  const kind = status?.state === "closed" ? "reopen" : "close";
  return el(
    "section",
    { className: "card", id: "cohort-close-panel", "aria-labelledby": "cohort-close-h" },
    el("h2", { id: "cohort-close-h", text: "回のクローズ" }),
    ...lines.map((text) => el("p", { className: state.closeStatusError ? "warn-text" : "hint", text })),
    cohortCloseCanAct(status, kind)
      ? el("button", {
        type: "button",
        className: kind === "close" ? "btn danger big" : "btn big",
        id: "cohort-close-action",
        text: kind === "close" ? "この回をクローズ" : "回を開き直す",
        disabled: state.busy,
        onclick: () => changeCohortClose(kind),
      })
      : null,
  );
}

/** 取り消しの案内の文（1 行目。残りの秒数を含む） */
function undoText(undo) {
  return `移しました。あと ${undo.remainingSec} 秒は戻せます。`;
}

/** 取り消しの案内の 2 行目（その間の生成の件数。分からなければ空） */
function undoJobsText(undo) {
  return undo.jobsSince === null ? "" : `この間の生成 ${formatCredits(undo.jobsSince)} 件は、移った先の段階に残ります。`;
}

/** 取り消せる間に、段階と「この間の生成」の件数を読み直す間隔（秒） */
const UNDO_POLL_SEC = 10;

/**
 * 取り消せる間だけ、1 秒ごとに残りの秒数の文を書き換える（入力中の欄を作り直さない）。
 * 時間は、読み込んだときのサーバーとの時刻の差を足した今の時刻で数え（undoView）、60 秒を過ぎたら取り消しの箱だけを消す。
 * 10 秒ごとに cohort_stage_status を読み直し、「この間の生成」の件数も新しくする
 */
function updateUndoTimer() {
  const s = state.status;
  if (!s || isClosed() || !undoView(s, Date.now()).available) {
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
    const text = document.getElementById("undo-text");
    if (text) text.textContent = undoText(undo);
    const jobs = document.getElementById("undo-jobs");
    if (jobs) {
      jobs.textContent = undoJobsText(undo);
      jobs.hidden = undo.jobsSince === null;
    }
  }, 1000);
}

/** 受講者：1 人 1 行（チェック・名前・残り・今の段階の使用 / 上限と棒・最後の生成）。残りの少ない順 */
function studentsCard(s) {
  const rows = [...s.students].sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity) || (a.name ?? a.email).localeCompare(b.name ?? b.email, "ja"));
  const activeEmails = rows.filter((r) => r.active).map((r) => r.email);
  const allOn = activeEmails.length > 0 && activeEmails.every((e) => state.selected.has(e));
  // 同じ名前の人が 2 人以上いるときだけ、名前の下にメールを出す
  const nameCount = new Map();
  for (const r of rows) if (r.name) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
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
        { className: `st-row${r.active ? "" : " disabled"}`, title: r.email },
        cb,
        el(
          "span",
          { className: "st-who" },
          el("span", { className: "st-name ellipsis", text: r.name ?? r.email }),
          r.active ? null : el("span", { className: "badge stopped", text: "停止中" }),
          r.name && nameCount.get(r.name) > 1 ? el("span", { className: "st-mail small muted ellipsis tabular", text: r.email }) : null,
        ),
        el(
          "span",
          { className: `st-rem tabular${low ? " low" : ""}` },
          el("span", { className: "st-rem-label", text: "残り " }),
          el("b", { text: r.remaining === null ? "—" : formatCredits(r.remaining) }),
        ),
        el(
          "span",
          { className: "st-use tabular" },
          r.limit !== null ? el("span", { className: `bar ${low ? "low" : ""}`, role: "img", "aria-label": `使用 ${pct}%` }, el("span", { style: `width:${pct}%` })) : null,
          el("span", { className: "st-use-num", text: `${formatCredits(r.used)} / ${formatCredits(r.limit)}` }),
        ),
        el("span", { className: "st-last small muted tabular" }, el("span", { className: "st-last-label", text: "最後の生成 " }), el("span", { text: formatShortDateTime(r.lastUsedAt) })),
      ),
    );
  });
  return el(
    "section",
    { className: "card", "aria-labelledby": "students-h" },
    el(
      "div",
      { className: "card-head" },
      el("h2", { id: "students-h", text: `受講者 ${rows.length} 人` }),
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
    items.length
      ? el(
        "div",
        { className: "st-table" },
        el(
          "div",
          { className: "st-head small muted", "aria-hidden": "true" },
          el("span", { className: "h-who", text: "名前" }),
          el("span", { className: "h-rem", text: "残り" }),
          el("span", { className: "h-use", text: "今の段階の使用 / 上限" }),
          el("span", { className: "h-last", text: "最後の生成" }),
        ),
        el("ul", { className: "students", "aria-label": "受講者" }, ...items),
      )
      : el("p", { className: "muted", text: "受講者がいません。" }),
  );
}

/** 追加の上限の行（単位はクレジット。畳んだ中の先頭に書く） */
function limitItems(s) {
  const l = s.limits;
  const items = [];
  if (!state.isAdmin) {
    if (l.perGrant !== null) items.push(`1 回の追加：${formatCredits(l.perGrant)} まで`);
    if (l.perStudentStage !== null) items.push(`1 人・この段階の合計：${formatCredits(l.perStudentStage)} まで`);
    if (l.perCohortDay !== null) {
      items.push(
        l.cohortDayTotal === null
          ? `今日この回の合計：${formatCredits(l.perCohortDay)} まで`
          : `今日この回の合計：${formatCredits(l.cohortDayTotal)} / ${formatCredits(l.perCohortDay)}（あと ${formatCredits(Math.max(0, l.perCohortDay - l.cohortDayTotal))}）`,
      );
    }
  }
  if (l.total !== null) items.push(`1 人・この回の合計：${formatCredits(l.total)} まで（取り消しも数える）`);
  return items;
}

/** 折りたたみ（開閉は ui に覚え、描き直しても閉じない） */
function fold(key, title, ...children) {
  const node = el("details", { className: "plain-fold minor", open: ui.folds.has(key), "data-fold": key }, el("summary", { text: title }), el("div", { className: "fold-in" }, ...children));
  node.addEventListener("toggle", () => {
    if (!node.isConnected) return; // 描き直しで画面から外れた折りたたみの toggle は使わない
    if (node.open) ui.folds.add(key);
    else ui.folds.delete(key);
  });
  return node;
}

function grantCard(s) {
  const credits = el("input", { type: "text", inputmode: "numeric", className: "input tabular", id: "grant-credits", autocomplete: "off", placeholder: "例：100" });
  credits.value = state.creditsText;
  credits.addEventListener("input", () => {
    state.creditsText = credits.value;
    updateGrantButton(); // ボタンの「+X」を変える（描き直さない）
  });
  const note = el("input", { type: "text", className: "input", id: "grant-note", autocomplete: "off", placeholder: "例：生成が足りない" });
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
    el("p", { className: "hint", text: "追加は今の段階だけに効きます。" }),
    el(
      "div",
      { className: "grant-form" },
      el("div", {}, el("label", { className: "field-label", for: "grant-credits", text: "1 人あたりのクレジット" }), credits),
      el("div", {}, el("label", { className: "field-label", for: "grant-note", text: "メモ（任意）" }), note),
    ),
    el("button", { type: "button", className: "btn primary big", id: "grant-btn", onclick: () => addGrant(s) }),
    avail.ok ? null : el("p", { className: "note-box", id: "grant-why", text: avail.why }),
    el(
      "div",
      { className: "folds" },
      limits.length
        ? fold(
          "limits",
          "追加の上限",
          el("p", { className: "small muted", text: "単位はクレジットです。" }),
          el("ul", { className: "limits", "aria-label": "追加の上限" }, ...limits.map((t) => el("li", { className: "tabular", text: t }))),
        )
        : null,
      fold(
        "mine",
        `${state.isAdmin ? "取り消せる追加" : "あなたの追加"}（${mine.length} 件）`,
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
          : el("p", { className: "muted", text: "取り消せる追加はありません。" }),
      ),
      revoked.length
        ? fold(
          "revoked",
          `取り消した追加（${revoked.length} 件）`,
          el("p", { className: "small muted", text: "回の合計には数えます。" }),
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
    ),
  );
}

/** 追加のボタンの文字と押せるか（選んだ人数と、入れた数で変わる） */
function updateGrantButton() {
  const btn = $("grant-btn");
  if (!btn) return;
  const n = state.selected.size;
  const credits = parseStageGrantCredits(state.creditsText);
  btn.textContent = !n ? "受講者を選んでください" : credits === undefined ? `${n} 人に追加` : `${n} 人に +${formatCredits(credits)} を追加`;
  const avail = state.status ? grantAvailability(state.status) : { ok: true };
  btn.disabled = state.busy || n === 0 || !avail.ok;
  if (!avail.ok) btn.title = avail.why;
}

// ---- 操作 ----

const cohortCloseAction = createCohortCloseAction({
  rpc,
  confirm: confirmDialog,
  canStart: () => !state.busy && !ending && operableCohort(),
  onBusy: (busy) => {
    state.busy = busy;
    if (busy) {
      statusSeq++;
      closeStatusSeq++;
    }
    render();
  },
  onStatus: (status) => {
    state.closeStatus = status;
    state.closeStatusError = "";
  },
  onSuccess: async (_status, raw, kind, isCurrent) => {
    if (!isCurrent()) return;
    notify(raw.changed === false
      ? kind === "close" ? "この回はすでにクローズされています。" : "この回はすでに開き直されています。"
      : kind === "close" ? "回をクローズしました。停止した受講者と削除予定を確認してください。"
      : `回を開き直し、${raw.restored_count} 人を有効に戻しました。個別変更などで戻さなかった人は ${raw.skipped_count} 人です。`);
    state.selected.clear();
    await loadStatusAndClose();
  },
  onError: async (message) => {
    notify(message, "error");
    await loadStatusAndClose();
  },
});

/** 回のクローズ・開き直し。確認のあいだに回・部品・ログインが変わったら送らない */
function changeCohortClose(kind) {
  const id = state.cohortId;
  const client = activeClient();
  const identity = closeIdentity();
  return cohortCloseAction.run(kind, id, () => !ending && id === state.cohortId && client === activeClient() && cohortCloseSameIdentity(closeIdentity(), identity));
}

/** 操作の通信中は二重に押せないようにして、終わったら描き直す */
async function withBusy(fn) {
  if (state.busy || !operableCohort()) return; // 操作のページで、URL の回と画面の回が同じときだけ送る（それ以外は 1 つも送らない）
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
  if (isClosed()) return;
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
    await loadStatusAndClose(); // 最後の段階に入るとクローズの札が出る
  });
}

async function undoMove(undo, s) {
  if (isClosed() || !undo.toStage || !s.current) return;
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
    await loadStatusAndClose();
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
