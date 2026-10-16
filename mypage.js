// マイページ。ログイン中の本人の「残りクレジット」と「使えるモデル（目安単価）」を、Edge Function user-api（GET /me）から読んで表示する。
// 読み取り専用（書き込みは一切しない）。ドルの金額・換算は出さない。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// supabase-js は mypage.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
import {
  browserStorage,
  clearStoredSession,
  idleExpired,
  LEGACY_STORAGE_PREFIX,
  MYPAGE_ACTIVITY_KEY,
  MYPAGE_IDLE_LIMIT_MS,
  MYPAGE_STORAGE_KEY,
  storedAccessToken,
} from "./auth-storage.js";
import {
  clearStaleSession,
  creditsView,
  decideApiOutcome,
  groupModels,
  modesText,
  roleBadgeClass,
} from "./mypage-lib.js";

// 他のサイトに埋め込まれて操作させられるのを防ぐ（GitHub Pages では frame-ancestors を指定できないため。admin.js と同じ）
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("マイページは埋め込みでは使えません");
}

const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
// 公開用のキー（ブラウザに置く前提のもの）。秘密鍵ではない。consent.html・admin.js と同じ値
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN";
const USER_API_URL = `${SUPABASE_URL}/functions/v1/user-api`;

const $ = (id) => document.getElementById(id);
const SECTIONS = ["status", "login", "denied", "failed", "app"];

function show(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない
if (typeof window.supabase?.createClient !== "function") {
  $("status").textContent = "画面の部品を読み込めませんでした。通信状態を確認して、ページを開き直してください。";
  throw new Error("supabase-js を読み込めませんでした");
}

// 研修用の Mac にログインを残さない：保存はこのタブの間だけ（sessionStorage）、許可の画面・管理コンソールとは別の鍵。
// 画面を離れるときにも消す（下の pagehide）。
// 以前の版が localStorage に残したセッションは、開いた時点で消す
const sessionStore = browserStorage("session");
clearStoredSession(browserStorage("local"), LEGACY_STORAGE_PREFIX);
// ページを開いた時点で保存先に残っているログインは、Google から ?code 付きで戻ったとき以外は使わない（すべて消す）。
// 強制終了・クラッシュで pagehide が走らなかったあとのセッション復元で、前の人のログインが戻るのを防ぐ。
// ?code 付きのときは、PKCE の code verifier と signIn で書いた操作時刻だけを残し、保存済みのセッションは消す（createClient の前に行う）
clearStaleSession(
  sessionStore,
  MYPAGE_STORAGE_KEY,
  MYPAGE_ACTIVITY_KEY,
  !!new URLSearchParams(location.search).get("code"),
);
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    storageKey: MYPAGE_STORAGE_KEY,
    ...(sessionStore ? { storage: sessionStore } : {}),
  },
});

function returnUrl() {
  return location.origin + location.pathname;
}

/** 子要素つきの要素を作る（文字は textContent で入れる） */
function el(tag, { className, text, attrs } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

// ---- ログイン・ログアウト ----

async function signIn() {
  // Google のログインへ移るときは、戻ったときに要る PKCE の code_verifier と時刻の記録を残す（下の pagehide で消さない）
  leavingForLogin = true;
  // Google から戻ったときに「記録が無い＝時間切れ」にならないよう、ログインを始めた時刻を書いておく
  markActive(true);
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: returnUrl(), queryParams: { prompt: "select_account" } },
  });
}

/** ログアウトして、タブに残る分（セッション・最後の操作の時刻）も消す（通信できなくても消す） */
async function endSession() {
  try {
    // この端末のセッションだけを切る（global だと、本人の ChatGPT・Codex の接続まで切れる）
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // 下で消す
  }
  clearStoredSession(sessionStore, MYPAGE_STORAGE_KEY);
}

let leavingForLogin = false;

/** 本人のデータを画面から消して、読み込み中の表示にする（ログアウトの通信を待つ間・画面を離れるときに、前の人の画面を残さない） */
function hideContent(message = "ログアウトしています…") {
  $("me-email").textContent = "";
  $("me-email").removeAttribute("title");
  $("me-role").textContent = "";
  $("denied-email").textContent = "";
  $("slot-label").textContent = "";
  $("slot-label").hidden = true;
  $("credits-value").textContent = "—";
  $("credits-value").classList.remove("text");
  $("credits-unit").textContent = "";
  $("big-number").classList.remove("low");
  $("credits-bar").hidden = true;
  $("credits-bar").classList.remove("low");
  $("credits-bar-fill").style.width = "0%";
  $("updated-at").textContent = "—";
  $("credits-explain").replaceChildren();
  $("models").replaceChildren();
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

// ---- 操作が無いときのログアウト（30 分。管理コンソールと同じ） ----

let lastActiveWrite = 0;
let idleTimer = null;
let idleListening = false;

/** 操作したことを記録する（書き込みは 15 秒に 1 回まで） */
function markActive(force = false) {
  const now = Date.now();
  if (!force && now - lastActiveWrite < 15000) return;
  lastActiveWrite = now;
  try {
    sessionStore?.setItem(MYPAGE_ACTIVITY_KEY, String(now));
  } catch {
    // 記録できなくても続ける
  }
}

function lastActive() {
  try {
    return sessionStore?.getItem(MYPAGE_ACTIVITY_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 30 分操作が無ければログアウトして、ログインの画面に戻す。ログアウトしたら true */
async function logoutIfIdle() {
  const last = lastActive();
  if (!idleExpired(last, Date.now(), MYPAGE_IDLE_LIMIT_MS)) return false;
  stopIdleWatch();
  // ログアウトの通信を待つ前に、本人のデータを画面から消す
  hideContent();
  await endSession();
  showLoginNote(
    last === null
      ? "ログインの記録を確かめられなかったため、ログアウトしました。もう一度ログインしてください。"
      : `${MYPAGE_IDLE_LIMIT_MS / 60000} 分間操作が無かったため、ログアウトしました。`,
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

// ---- 読み込み ----

/** user-api の GET /me を呼ぶ。返り値は { status, body }（通信できなければ status 0） */
async function fetchMe() {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return { status: 401, body: null };
    const res = await fetch(`${USER_API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

let loading = false;

/** 読み込んで画面を切り替える。初回（画面が読み込み中）と「最新にする」の両方で使う */
async function load({ fromApp = false } = {}) {
  if (loading) return;
  loading = true;
  const reload = $("reload-btn");
  if (fromApp) {
    reload.disabled = true;
    reload.textContent = "更新中…";
  } else {
    $("status").replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    show("status");
  }
  try {
    const { status, body } = await fetchMe();
    const outcome = decideApiOutcome(status, body);
    if (outcome.action === "ok") {
      render(outcome.body);
      show("app");
    } else if (outcome.action === "unauthorized") {
      stopIdleWatch();
      hideContent();
      await endSession();
      showLoginNote(outcome.message);
      show("login");
    } else if (outcome.action === "denied") {
      const { data } = await supabase.auth.getSession();
      $("denied-message").textContent = outcome.message;
      $("denied-email").textContent = data?.session?.user?.email ?? "";
      show("denied");
    } else {
      $("failed-message").textContent = outcome.message;
      show("failed");
    }
  } finally {
    loading = false;
    reload.disabled = false;
    reload.textContent = "最新にする";
  }
}

// ---- 表示 ----

function render(me) {
  $("me-email").textContent = me.email;
  $("me-email").title = me.email;
  const role = $("me-role");
  role.textContent = me.role_label || "";
  role.className = `badge ${roleBadgeClass(me.role)}`;
  role.hidden = !me.role_label;
  renderCredits(me.credits, me.role);
  renderModels(me.models);
  $("updated-at").textContent = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function renderCredits(credits, role) {
  const v = creditsView(credits, role);
  $("slot-label").textContent = v.slot ?? "";
  $("slot-label").hidden = !v.slot;
  const value = $("credits-value");
  value.textContent = v.value;
  value.classList.toggle("text", v.valueIsText);
  $("credits-unit").textContent = v.unit ?? "";
  $("credits-unit").hidden = !v.unit;
  $("big-number").classList.toggle("low", v.low);
  $("credits-bar").hidden = v.ratio === null;
  $("credits-bar").classList.toggle("low", v.low);
  $("credits-bar-fill").style.width = `${Math.round((v.ratio ?? 0) * 100)}%`;
  $("credits-explain").replaceChildren(...v.lines.map((line) => el("p", { text: line })));
}

function renderModels(models) {
  const groups = groupModels(models);
  if (!groups.length) {
    $("models").replaceChildren(el("p", { className: "muted", text: "現在使えるモデルはありません。" }));
    return;
  }
  $("models").replaceChildren(
    ...groups.map((g) =>
      el(
        "div",
        { className: "kind-group" },
        el("h3", { text: g.label }),
        el(
          "table",
          { className: "models" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              ...["モデル名", "使い方", "目安単価"].map((t) => el("th", { text: t, attrs: { scope: "col" } })),
            ),
          ),
          el(
            "tbody",
            {},
            ...g.models.map((m) =>
              el(
                "tr",
                {},
                el(
                  "td",
                  { attrs: { "data-label": "モデル名" } },
                  el("span", { className: "name", text: m.label }),
                  m.is_default ? el("span", { className: "badge default", text: "既定" }) : null,
                  m.description ? el("span", { className: "desc", text: m.description }) : null,
                ),
                el("td", { text: modesText(m.modes), attrs: { "data-label": "使い方" } }),
                el("td", { className: "tabular", text: m.price?.text ?? "—", attrs: { "data-label": "目安単価" } }),
              )
            ),
          ),
        ),
      )
    ),
  );
}

// ---- 開始 ----

async function main() {
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

// 画面を離れるとき（タブを閉じる・別のページへ移る）はログアウトする。ただし Google のログインへ移るときは除く。
// ブラウザの「閉じたタブを開き直す」・履歴・セッションの復元で sessionStorage が戻り、前の人のログインで開いてしまうのを防ぐ
// （consent.html と同じ）。待てないので、サーバーへの取り消しは keepalive で送り、タブの保存先はその場で消す。
// 画面の中身も消す（戻る・進むでキャッシュから表示されたときに、前の人のデータが見えないように）
window.addEventListener("pagehide", () => {
  if (leavingForLogin) return;
  stopIdleWatch();
  const token = storedAccessToken(sessionStore, MYPAGE_STORAGE_KEY);
  if (token) {
    try {
      fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: "POST",
        keepalive: true,
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      }).catch(() => {});
    } catch {
      // 送れなくても、タブの保存先は下で消す
    }
  }
  try {
    // メモリの分が自動の更新で保存し直されないよう、更新も止める
    supabase.auth.stopAutoRefresh?.();
  } catch {
    // 無視
  }
  clearStoredSession(sessionStore, MYPAGE_STORAGE_KEY);
  hideContent("ログアウトしました。");
});
// 戻る・進むでキャッシュから表示されたとき（ログアウト済み）は、読み込み直してログイン前の表示に戻す
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

$("login-btn").addEventListener("click", signIn);
$("logout-btn").addEventListener("click", signOut);
$("denied-logout-btn").addEventListener("click", signOut);
$("failed-logout-btn").addEventListener("click", signOut);
$("reload-btn").addEventListener("click", () => load({ fromApp: true }));
$("retry-btn").addEventListener("click", () => load());

main().catch(() => {
  $("failed-message").textContent = "エラーが発生しました。ページを開き直してください。";
  show("failed");
});
