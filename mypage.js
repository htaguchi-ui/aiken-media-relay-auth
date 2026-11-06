// マイページ（トップ / ・/mypage・/mypage.html。ファイルは index.html）。ログイン中の本人の「残りクレジット」と「使えるモデル（目安単価）」を、
// Edge Function user-api（GET /me）から読んで表示する。Canvas・講師ページ・管理ページへは、ヘッダーの上の帯（site-nav.js）の普通のリンク（Canvas だけ別のタブ。この画面からは何も送らない）。
// 読み取り専用（書き込みは一切しない）。ドルの金額・換算は出さない。メールアドレスは画面に出さない（2026-10-19 田口さんの決定）。
// ただし「登録されていない」画面だけは、違うアカウントで入ったと気づけるよう、ログインしたメールアドレスを出す（同日 main の決定）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// 読み直しは、初回・再試行・手動（⟳）と、約 10 秒ごと（組 11 の (3)。部品は poll-lib.js の createPoller。見えている間だけ・本人の画面のまま・
// 失敗が続くと間隔を延ばす）。タブがまた見えたとき（前回の成功から 5 秒以上）は、その読み直しを早める。setInterval は使わない。
// supabase-js は index.html で版を固定し、integrity（SRI）を付けて読み込む（window.supabase）
import {
  authEventKind,
  browserStorage,
  clearStoredSession,
  discardOldTabSessions,
  LEGACY_STORAGE_PREFIX,
  sessionChangeKind,
  STUDIO_STORAGE_KEY,
} from "./auth-storage.js";
import {
  checkedAtText,
  createRequestCounter,
  creditsView,
  decideApiOutcome,
  deniedMessage,
  groupModels,
  COPY_OK_CLEAR_MS,
  copyTextOf,
  createLatestGate,
  MSG_COPY_FALLBACK,
  MSG_COPY_OK,
  lowNotice,
  MSG_CODE_FAILED,
  MSG_DENIED,
  MSG_DENIED_CODE,
  MSG_DENIED_TIP,
  oauthOptions,
  priceText,
  roleBadgeClass,
  shouldReloadOnReturn,
} from "./mypage-lib.js";
import { fillIcons, renderSiteNav } from "./site-nav.js";
import { createMySubmissions } from "./mypage-submissions.js";
import { createMyUpload } from "./mypage-upload.js";
import { createPoller, staleAfterThisFailure } from "./poll-lib.js";
import { createMyShare } from "./mypage-share.js";
import { closedNote, discardDlKey } from "./share-lib.js";
import { errorCodeLabel } from "./submissions-lib.js";

// 他のサイトに埋め込まれて操作させられるのを防ぐ（GitHub Pages では frame-ancestors を指定できないため。admin.js と同じ）
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("マイページは埋め込みでは使えません");
}

const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
// 公開用のキー（ブラウザに置く前提のもの）。秘密鍵ではない。consent.html・admin.js と同じ値
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN";
const USER_API_URL = `${SUPABASE_URL}/functions/v1/user-api`;
const SUBMISSIONS_API_URL = `${SUPABASE_URL}/functions/v1/submissions`;

const $ = (id) => document.getElementById(id);
const SECTIONS = ["status", "login", "denied", "closed", "failed", "app"];
/** 今出している画面（SECTIONS のどれか） */
let current = "status";

function show(id) {
  current = id;
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

// ログインはこの端末（ブラウザ）で保つ（決定 70）：保存先は localStorage の共有の鍵（講師の画面・Canvas・許可の画面と同じ）。
// 最長 14 日（サーバーの設定）。ページを離れても、操作しなくてもログアウトしない。
// 以前の版が localStorage（sb-…）・sessionStorage（画面ごとの鍵）に残したセッションは、開いた時点で捨てる（移さない。1 回だけログインし直す）
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

// 前の版の sessionStorage のセッションは、supabase-js が読めるかの確認より前に（fetch と storage だけで）捨てる
discardOldTabSessions(browserStorage("session"), sendLocalLogout);
// 保存のページ（/dl）が、このタブの sessionStorage に一時に置いた鍵：マイページを開いた時点で消す（/dl から戻った＝その鍵の用は済んだ。ログアウトのあとに［進む］で前の人の保存のページに戻らない）
discardDlKey(browserStorage("session"));

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない。
// トップの役目（サービスの説明・方針と規約へのリンク）は残すため、ログイン前の画面をボタンを押せない形で出す
if (typeof window.supabase?.createClient !== "function") {
  $("login-note").textContent = "表示エラー：画面を読み込めません。\nページを再読み込みしてください。";
  $("login-note").hidden = false;
  document.getElementById("login-btn").disabled = true; // 末尾のボタンの登録とは書き方を分ける（試験が末尾の登録の位置で区切って読むため）
  document.getElementById("login-other-btn").disabled = true;
  show("login");
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

/** 子要素つきの要素を作る（文字は textContent で入れる） */
function el(tag, { className, text, attrs } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

/**
 * 断りの文を出す（textContent）。エラーコードがあれば最後の文の後ろに小さく薄く「（E-LOG-99）」（D-1104-130x-b・決まり 3.2 の案 A）、
 * ホバーの補足があれば title に置く（無ければ title を外す）。文の 1 行目と次の手は「\n」で分ける（CSS は white-space: pre-line）
 */
function setMessage(node, text, { code = null, tip = null } = {}) {
  node.textContent = text;
  if (code) node.append(el("span", { className: "err-code muted small", text: errorCodeLabel(code) }));
  if (tip) node.setAttribute("title", tip);
  else node.removeAttribute("title");
}

/** 「登録されていない」画面の文（コードは最後の文の後ろに 1 回だけ。入れないときの連絡先はホバー） */
function setDenied(text) {
  setMessage($("denied-message"), text, { code: MSG_DENIED_CODE, tip: MSG_DENIED_TIP });
}

// ---- ログイン・ログアウト ----

/**
 * Google のログインへ移る。ふつうの［Google でログイン］はアカウントを選ぶ画面を出さない。
 * 「別のアカウントでログイン」（selectAccount）のときだけ選ぶ画面を出す（決定 70）
 */
async function signIn({ selectAccount = false } = {}) {
  discardDlKey(browserStorage("session")); // 別のアカウントで入り直すときも、前の鍵は残さない
  await supabase.auth.signInWithOAuth({ provider: "google", options: oauthOptions(returnUrl(), selectAccount) });
}

/** ログインを終えている途中（このタブのログアウト・401・ほかのタブからの知らせ）。知らせを二重に扱わない */
let ending = false;

/** ログアウトして、この端末の共有のログインを消す（通信できなくても消す。講師の画面・Canvas のタブもログインの画面になる） */
async function endSession() {
  ending = true;
  discardDlKey(browserStorage("session")); // /dl が置いた鍵は、ログアウトで消す（同じタブで［進む］や /dl を開いても、前の人の作品が出ない）
  try {
    // この端末のセッションだけを切る（global だと、本人の ChatGPT・Codex・Claude Code の接続まで切れる）
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // 下で消す
  }
  clearStoredSession(localStore, STUDIO_STORAGE_KEY);
}

/** 最後に読み込みに成功した時刻（ミリ秒）。成功したときだけ進める。ログアウト・画面の中身を消すときに null に戻す */
let lastSuccessAt = null;
/** 要求の番号（古い応答・ログアウトのあとの応答・別のアカウントの応答で画面を上書きしない） */
const requests = createRequestCounter();

/** 本人のデータを画面から消して、読み込み中の表示にする（ログアウトの通信を待つ間・画面を離れるときに、前の人の画面を残さない） */
function hideContent(message = "ログアウト中…") {
  // マイページからの提出のダイアログを閉じる（送っている途中なら送信を止め、cancel を 1 回試す）。ボタンも隠す
  myUpload.clear();
  // 約 10 秒の読み直しを止める（ログアウトのあとに予約の時刻が来ても読まない）
  poller.stop();
  // 出ている要求の応答は、届いても画面に入れない。以後、新しい番号も取れない（ログインし直すときはページを読み直す）
  requests.close();
  lastSuccessAt = null;
  $("me-role").textContent = "";
  $("me-role").hidden = true;
  renderSiteNav($("site-nav"), null, "mypage");
  setDenied(MSG_DENIED);
  $("checked-at").textContent = "";
  $("checked-at").hidden = true;
  $("credits-value").textContent = "—";
  $("credits-value").classList.remove("text");
  $("credits-limit").textContent = "";
  $("credits-limit").hidden = true;
  $("big-number").hidden = false;
  $("big-number").classList.remove("low");
  $("credits-bar").hidden = true;
  $("credits-bar").classList.remove("low");
  $("credits-bar-fill").style.width = "0%";
  $("low-line-text").textContent = "";
  $("low-line").hidden = true;
  $("slot-line").textContent = "";
  $("slot-line").hidden = true;
  $("stage-name").replaceChildren();
  $("stage-name").hidden = true;
  $("hero-body").classList.remove("has-context");
  $("stages").replaceChildren();
  $("stages-meta").textContent = "";
  $("stages-group").hidden = true;
  shownNav = undefined;
  shownModels = undefined;
  $("credits-notice").textContent = "";
  $("credits-notice").hidden = true;
  $("refresh-error-text").textContent = "";
  $("refresh-error").hidden = true;
  $("models").replaceChildren();
  $("models-meta").textContent = "";
  $("models-empty").hidden = true;
  // 提出した作品（出ている要求の応答も捨てる）
  mySubmissions.clear();
  myShare.clear();
  closedShare.clear();
  syncPair();
  $("live").textContent = "";
  // 開閉の状態は保存しない。次に入った人は、どれも閉じた状態から始める
  for (const d of document.querySelectorAll("#app details")) d.open = false;
  $("status").replaceChildren(el("p", { className: "muted", text: message }));
  show("status");
}

async function signOut() {
  hideContent();
  await endSession();
  location.replace(returnUrl());
}

function showLoginNote(text) {
  $("login-note").textContent = text;
  $("login-note").hidden = !text;
}

// ---- ほかのタブでのログアウト・アカウントの切り替え ----

/** このタブが表示している利用者の ID（本人の画面を出す前・ログイン前は null） */
let shownUser = null;

/**
 * ほかのタブでログアウトした（または時間切れでログインが消えた）・別のアカウントに替わったとき：
 * 本人のデータを画面から消し（出ている要求も無効にする）、ページを読み込み直す。読み込み直したページは、
 * ログインが無ければログインの画面、別のアカウントならその人の画面になる
 */
function onSessionChanged(kind) {
  if (!kind || ending) return;
  ending = true;
  hideContent(kind === "signed-out" ? "ログアウトしました。" : "読み込み中…");
  location.replace(returnUrl());
}

let watching = false;

/** ログインの変化とタブの見え方の見張りを始める（本人の画面を出す前に 1 回だけ） */
function startWatch(userId) {
  shownUser = userId;
  if (watching) return;
  watching = true;
  // ほかのタブが共有の鍵を書き換えた・消した（storage の知らせは、書き換えたタブ以外に届く）
  window.addEventListener("storage", (e) => onSessionChanged(sessionChangeKind(e, STUDIO_STORAGE_KEY, shownUser)));
  // supabase-js の知らせ（ほかのタブの BroadcastChannel・このタブのトークンの更新の失敗）。知らせの中では supabase を待たない
  supabase.auth.onAuthStateChange((event, session) => {
    const kind = authEventKind(event, session, shownUser);
    if (kind) setTimeout(() => onSessionChanged(kind), 0);
  });
  // Canvas などから戻ったときは、条件つきで約 10 秒の読み直しを早める
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onVisible();
  });
  // タブが「見えた」知らせが届かない画面（Codex の内蔵ブラウザなど）でも、ウィンドウに戻ったときの focus で、同じ条件で早める（U1-6）。
  // 両方が続けて届いても、読み込み中は読まないので 1 回になる
  window.addEventListener("focus", () => onVisible());
}

/**
 * タブがまた見えたとき・ウィンドウに戻ったとき：条件を満たすときだけ、約 10 秒の読み直しをすぐ 1 回行う（Canvas から戻ったときの残りの確認）。
 * 満たさなくても、読み直しの部品は見えてから 10 秒以内に読む
 */
async function onVisible() {
  if (ending) return;
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getSession();
    signedIn = !!data?.session?.access_token;
  } catch {
    signedIn = false;
  }
  const go = shouldReloadOnReturn({
    visible: document.visibilityState === "visible",
    signedIn,
    showingApp: current === "app",
    loading,
    lastSuccessAt,
    now: Date.now(),
  });
  if (!go) return;
  poller.kick();
  // QR の欄は約 10 秒ごとには読まないので、見えたときに読み直す（受講者だけ）
  if (shownNav === "student") void myShare.refresh();
}

// ---- 読み込み ----

/** user-api の GET /me を呼ぶ。返り値は { status, body }（通信できなければ status 0） */
async function fetchMe(token) {
  try {
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

/** 今のセッション（無ければ null） */
async function currentSession() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session ?? null;
  } catch {
    return null;
  }
}

/** 提出した作品（受講者だけ。docs/design-submissions.md 4.5・4.11）。本体は mypage-submissions.js。ログアウトで clear() し、出ている要求の応答は捨てる */
const mySubmissions = createMySubmissions({
  group: $("submissions-group"),
  listEl: $("submissions-list"),
  statusEl: $("submissions-status"),
  metaEl: $("submissions-meta"),
  helpEl: $("submissions-help"),
  helpBodyEl: $("submissions-help-body"),
  dialog: $("my-dialog"),
  apiBase: SUBMISSIONS_API_URL,
  apiKey: SUPABASE_PUBLISHABLE_KEY,
  getSession: async () => {
    const s = await currentSession();
    return s?.user?.id && s.access_token ? { accountId: s.user.id, token: s.access_token } : null;
  },
  // 枠を出した・隠したら「今日の段階｜提出した作品」の並べ方を合わせる
  onLayout: () => syncPair(),
});

/**
 * マイページからの動画の提出（組 11 の (8)。設計 kumi11-mypage-upload.md。本体は mypage-upload.js）。
 * ［動画を提出する］は「提出した作品」の見出しの横。関数 submissions の GET /targets が印（upload.enabled）を返したときだけ出す。
 * 本人の画面を出したとき（poll ではない）に refresh、ログアウトで clear。提出が済んだら、一覧をすぐ読み直す。
 * （mypage_logout_race_nodetest.mjs は import を外した決まったファイルだけを同じ vm で動かすため、部品が無いときは何もしない物に替える）
 */
const myUpload =
  typeof createMyUpload === "function"
    ? createMyUpload({
        openBtn: $("upload-open"),
        dialog: $("upload-dialog"),
        apiBase: SUBMISSIONS_API_URL,
        apiKey: SUPABASE_PUBLISHABLE_KEY,
        getSession: async () => {
          const s = await currentSession();
          return s?.user?.id && s.access_token ? { accountId: s.user.id, token: s.access_token } : null;
        },
        onSubmitted: () => {
          void mySubmissions.refresh();
          poller.kick();
        },
      })
    : { refresh: async () => "skip", clear() {}, busy: () => false, isOpen: () => false };

/** 作品をスマホに保存する QR の欄（受講者だけ。docs/design-submissions.md 4.9・段 1D）。本体は mypage-share.js。ログアウトで clear() し、QR と鍵つきの URL も捨てる */
const myShare = createMyShare({
  group: $("share-group"),
  host: $("share-host"),
  statusEl: $("share-status"),
  dialog: $("my-dialog"),
  apiBase: SUBMISSIONS_API_URL,
  apiKey: SUPABASE_PUBLISHABLE_KEY,
  getSession: async () => {
    const s = await currentSession();
    return s?.user?.id && s.access_token ? { accountId: s.user.id, token: s.access_token } : null;
  },
});

/** 回が終わったあとの限られた利用（設計 4.10）：GET /me が「登録されていない」（403）のときだけ、保存の状態を読み、通れば［この端末で保存する］［スマホに保存する］だけを出す。本体は mypage-share.js（closedMode） */
const closedShare = createMyShare({
  group: $("closed-share-group"),
  host: $("closed-share-host"),
  statusEl: $("closed-share-status"),
  dialog: $("my-dialog"),
  apiBase: SUBMISSIONS_API_URL,
  apiKey: SUPABASE_PUBLISHABLE_KEY,
  closedMode: true,
  getSession: async () => {
    const s = await currentSession();
    return s?.user?.id && s.access_token ? { accountId: s.user.id, token: s.access_token } : null;
  },
});

let loading = false;
/** 約 10 秒の読み直しで 401 が来た（まだログアウトしていない）。続く読み直しでもう一度 401 なら終える。読めたら下ろす */
let poll401 = false;

/** 更新のボタンを「更新中」にする・戻す（disabled にはしない：押したボタンからフォーカスが外れないように aria-disabled で止める） */
function setBusy(busy) {
  const btn = $("reload-btn");
  btn.setAttribute("aria-disabled", busy ? "true" : "false");
  btn.classList.toggle("busy", busy);
  btn.dataset.tip = busy ? "更新中…" : "最新にする";
  $("refresh-retry-btn").setAttribute("aria-disabled", busy ? "true" : "false");
}

/**
 * 約 10 秒の読み直し（組 11 の (3)。設計 kumi11-site.md 2.3.2）。本人の画面を出したら start、hideContent で stop。
 * 読むのは、本人の画面を出していて・読み込み中でなく・ログアウトの途中でなく・確認や再生の窓が開いていないときだけ（タブが隠れている間も読まない）
 */
const poller = createPoller({
  run: () => load({ mode: "poll" }),
  canRun: () => current === "app" && !loading && !ending && !$("my-dialog").open && !myUpload.isOpen(),
  isVisible: () => document.visibilityState === "visible",
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

/**
 * 読み込んで画面を切り替える。
 * mode："initial"（初回）・"retry"（失敗の画面の［もう一度試す］）：読み込み中の画面を出し、失敗なら失敗の画面。
 *       "manual"（⟳・更新の失敗の［もう一度試す］）・"return"（タブがまた見えたとき）：本人の画面のまま更新する。
 *       失敗しても画面・開いている詳細・フォーカスはそのままにし、主カードに理由と［もう一度試す］を出す（成功の時刻は進めない）
 *       "poll"（約 10 秒の読み直し）：本人の画面のまま、⟳ の「更新中」も「読み込み中…」も出さず、フォーカスを動かさない。
 *       失敗の枠は続けて 3 回失敗したときに初めて出す。提出した作品も静かに読み直す（同じ中身なら描き直さない）
 * 返り値："ok" | "fail" | "skip"（読み直しの部品に渡す。/me と作品のどちらかが失敗なら "fail"）
 */
async function load({ mode = "initial" } = {}) {
  if (loading) return "skip";
  // 番号は最初の await より前に取る。ログアウト（hideContent → requests.close()）を始めたあとは、ここで無効な番号しか取れず、
  // 画面を一切変えずに終わる。認証の確認の待ち・GET の待ちの間にログアウトしても、この番号が無効になる
  let ticket = requests.begin();
  if (!requests.isLive(ticket)) return "skip";
  loading = true;
  const poll = mode === "poll";
  const inApp = (mode === "manual" || mode === "return" || poll) && current === "app";
  let result = "skip";
  /** 提出した作品の読み直し（poll のときだけ、結果を待って返り値に入れる） */
  let works = null;
  if (inApp) {
    if (!poll) setBusy(true);
  } else {
    $("status").replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    show("status");
  }
  try {
    const session = await currentSession();
    // 認証の確認（トークンの更新を待つことがある）から戻った時点で、番号がまだ有効か。有効なら、そのアカウントを結び付ける
    ticket = requests.withAccount(ticket, session?.user?.id ?? null);
    if (!ticket) return "skip";
    const token = session?.access_token ?? null;
    const { status, body } = await fetchMe(token);
    const outcome = decideApiOutcome(status, body);
    // 応答が届いた時点で、同じ要求・同じアカウントのままか（ログアウト・別の要求・別のアカウントなら、この応答では画面を変えない）。
    // トークンが無かったとき（unauthorized になる）も、番号が有効かは必ず照らす
    const now = await currentSession();
    if (!requests.isLive(ticket)) return "skip";
    if (token && !requests.isCurrent(ticket, now?.user?.id ?? null)) return "skip";
    if (outcome.action === "ok") {
      const before = $("credits-value").textContent;
      const lowBefore = $("low-line-text").textContent;
      works = render(outcome.body, { poll });
      lastSuccessAt = Date.now();
      renderCheckedAt();
      hideRefreshError();
      show("app");
      announceUpdate(mode, before, lowBefore);
      poller.start();
      poll401 = false;
      result = "ok";
    } else if (outcome.action === "unauthorized" && poll && !poll401) {
      // 約 10 秒の読み直しの 401 は 1 回ではログアウトしない（トークンの更新の行き違いなど）。次の読み直しでもう一度だけ確かめる
      poll401 = true;
      result = "fail";
    } else if (outcome.action === "unauthorized") {
      hideContent();
      await endSession();
      showLoginNote(outcome.message);
      show("login");
    } else if (outcome.action === "denied") {
      // 登録されていないときだけ、ログインしたアカウントのメールアドレスを出す（違うアカウントで入ったと気づけるように。2026-10-19 main の決定）。
      // メールは user-api の応答ではなく、今のセッションのものを使う
      hideContent("読み込み中…");
      // 回が終わったあとの 7 日は、名簿が「止まった」受講者でも、提出した作品の保存だけはできる（設計 4.10）。通らなければ、これまでどおり「登録されていない」
      const epochBefore = closedShare._state().epoch;
      const closedOk = await closedShare.refresh();
      if (closedShare._state().epoch !== epochBefore) return; // 待っている間にログアウトした
      if (closedOk) {
        $("closed-message").textContent = closedNote(closedShare.issueUntil());
        show("closed");
      } else {
        setDenied(deniedMessage(now?.user?.email ?? null));
        show("denied");
      }
    } else if (inApp) {
      // 約 10 秒の読み直しの失敗は、続けて 3 回目から出す（1・2 回の一時的な失敗では赤い枠を出さない）
      if (!poll || staleAfterThisFailure(poller.failures())) showRefreshError(outcome.message, outcome.code);
      result = "fail";
    } else {
      setMessage($("failed-message"), outcome.message, { code: outcome.code ?? null });
      show("failed");
      result = "fail";
    }
  } finally {
    loading = false;
    if (!poll) setBusy(false);
  }
  if (!poll || !works) return result;
  // 提出した作品の静かな読み直しの結果も合わせる（どちらかが失敗なら失敗）
  const w = await works;
  return w === "fail" ? "fail" : result;
}

/** 最後に成功した時刻（「確認 13:42」）を出す。成功したときだけ呼ぶ */
function renderCheckedAt() {
  const text = checkedAtText(lastSuccessAt);
  $("checked-at").textContent = text ?? "";
  $("checked-at").hidden = !text;
}

/**
 * 本人の画面からの更新に失敗したとき：表示は前回の成功の時点のまま、理由と［再試行］を出す（時刻は進めない）。
 * いつの時点の表示かは見出しの右の「13:42 時点」（checked-at。失敗では進めない）が言うので、文には足さない
 */
function showRefreshError(message, code = null) {
  setMessage($("refresh-error-text"), message, { code });
  $("refresh-error").hidden = false;
}

function hideRefreshError() {
  const box = $("refresh-error");
  if (box.hidden) return;
  // ［再試行］にフォーカスがあったら、消す前に ⟳ へ移す（フォーカスを失わない）
  if (box.contains(document.activeElement)) $("reload-btn").focus();
  box.hidden = true;
  $("refresh-error-text").textContent = "";
}

/**
 * 読み上げへの知らせは必要な分だけ：手動の更新は結果を、戻ったときの読み直しは残りが変わったときだけ。
 * 約 10 秒の読み直しは、残りが「少ない」「無い」に変わったときだけ（その 1 行を読む）
 */
function announceUpdate(mode, before, lowBefore = "") {
  const after = $("credits-value").textContent;
  const at = checkedAtText(lastSuccessAt) ?? "";
  if (mode === "manual") {
    $("live").textContent = `更新しました。残りクレジット ${after}。${at}`;
  } else if (mode === "return" && before !== after) {
    $("live").textContent = `残りクレジットが ${after} になりました。`;
  } else if (mode === "poll") {
    const low = $("low-line-text").textContent;
    if (low && low !== lowBefore) $("live").textContent = low;
  }
}

// ---- 表示 ----

/** 前回描いた区分（画面の間の移動）と、使えるモデルの中身（JSON）。約 10 秒の読み直しで同じなら描き直さない。hideContent で忘れる */
let shownNav;
let shownModels;

/**
 * 本人の画面を描く。poll（約 10 秒の読み直し）のときは、変わった所だけ描き直す（区分が同じなら移動の帯、中身が同じならモデルの一覧は触らない）。
 * QR の欄は poll では読み直さない（初回・⟳・見えたときだけ）。
 * 返り値：受講者なら提出した作品の読み直しの Promise（"ok" | "fail" | "skip"）、それ以外は null
 */
function render(me, { poll = false } = {}) {
  const role = $("me-role");
  role.textContent = me.role_label || "";
  role.className = `badge ${roleBadgeClass(me.role)}`;
  role.hidden = !me.role_label;
  if (!poll || shownNav !== me.role) renderSiteNav($("site-nav"), me.role, "mypage");
  shownNav = me.role;
  renderCredits(me.credits, me.role);
  const models = JSON.stringify(me.models ?? null);
  if (!poll || shownModels !== models) renderModels(me.models);
  shownModels = models;
  const student = me.role === "student";
  // 提出した作品は受講者だけ（本体は mypage-submissions.js。失敗しても、この画面の残りは変えない）
  let works = null;
  if (student) works = mySubmissions.refresh(poll ? { quiet: true } : {});
  else mySubmissions.clear();
  // 作品をスマホに保存する QR の欄も受講者だけ（本体は mypage-share.js。失敗しても、この画面の残りは変えない）。
  // 約 10 秒の読み直し（poll）では読み直さない（初回・⟳・タブが見えたときだけ）
  if (poll) {
    if (!student) myShare.clear();
  } else if (me.role === "student") void myShare.refresh();
  else myShare.clear();
  // マイページからの提出のボタンも受講者だけ（印を読むのは初回・⟳・戻ったときだけ。約 10 秒の読み直しでは読まない）
  if (!student) myUpload.clear();
  else if (!poll) void myUpload.refresh();
  syncPair();
  return works;
}

/**
 * 主カードのすぐ下の「今日の段階｜提出した作品」（組 11 の (4)）：2 つとも出ていれば横並び（広い幅。狭い幅は縦に積む）、
 * 片方だけなら 1 列（.one）、どちらも無ければ段ごと隠す
 */
function syncPair() {
  const shown = [$("stages-group"), $("submissions-group")].filter((g) => !g.hidden).length;
  $("today-pair").hidden = shown === 0;
  $("today-pair").classList.toggle("one", shown === 1);
}

/** 文字を入れて、空なら隠す */
function setLine(id, text) {
  $(id).textContent = text ?? "";
  $(id).hidden = !text;
}

function renderCredits(credits, role) {
  const v = creditsView(credits, role);
  const hasNumber = v.mode === "number" || v.mode === "unlimited";
  $("big-number").hidden = !hasNumber;
  $("credits-value").textContent = v.value;
  $("credits-value").classList.toggle("text", v.mode === "unlimited");
  setLine("credits-limit", v.limitText);
  $("big-number").classList.toggle("low", v.low);
  $("credits-bar").hidden = v.ratio === null;
  $("credits-bar").classList.toggle("low", v.low);
  $("credits-bar-fill").style.width = `${Math.round((v.ratio ?? 0) * 100)}%`;
  // 残りが少ない・無いときは、色に加えて印と文字でも知らせる
  const low = lowNotice(v, credits);
  $("low-line-text").textContent = low ?? "";
  $("low-line").hidden = !low;
  setLine("slot-line", v.slotLine);
  setLine("credits-notice", v.notice);
  renderStages(v);
  $("hero-body").classList.toggle("has-context", !$("stage-name").hidden || !$("slot-line").hidden);
}

/** 段階の回だけ：今の段階の名前と、今日の段階の一覧（user-api が段階の項目を返さないときは、何も出さない） */
function renderStages(v) {
  const name = $("stage-name");
  name.replaceChildren();
  name.hidden = !v.stageName;
  // 受講者の画面には「段階」を出さない（文言の決まり 2.3）
  if (v.stageName) name.append(el("span", { className: "label", text: "現在" }), document.createTextNode(v.stageName));
  const hasList = v.stages.length > 0;
  // 一覧が無くなるとき、フォーカスがその中にあったら、主カードの見出しへ移して理由を知らせる（行き場の無いフォーカスにしない）
  const group = $("stages-group");
  if (!hasList && !group.hidden && group.contains(document.activeElement)) {
    $("credits-title").focus();
    $("live").textContent = "今日のワークショップはありません。";
  }
  group.hidden = !hasList;
  syncPair();
  $("stages-meta").textContent = hasList ? `${v.stages.length} 件` : "";
  $("stages").replaceChildren(
    ...v.stages.map((s) =>
      el(
        "li",
        { className: s.current ? "current" : "" },
        el(
          "span",
          { className: "name" },
          el("span", { text: s.name }),
          // 「今」はほかの画面（講師ページ・提出作品・管理コンソール）と同じ紺の札（緑は成功・済みの色。組 13 の U-13。CSS は index.html の .tag.now）
          s.current ? el("span", { className: "tag now", text: "今" }) : null,
        ),
        el("span", { className: "num", text: `${s.usedText}・${s.limitText}` }),
      )
    ),
  );
}

function renderModels(models) {
  const groups = groupModels(models);
  const count = groups.reduce((n, g) => n + g.models.length, 0);
  // 0 件のときは、閉じた中へ探しに行かせないよう、見出しの下に 1 行を出したままにする
  $("models-empty").hidden = count > 0;
  $("models-meta").textContent = count > 0 ? `${count} 件` : "";
  if (!groups.length) {
    $("models").replaceChildren(el("p", { className: "muted", text: "使えるモデルはありません。\n講師・スタッフにお知らせください。" }));
    return;
  }
  $("models").replaceChildren(
    ...groups.map((g) =>
      el(
        "div",
        { className: "kind-group" },
        el("h3", { text: g.label }),
        el(
          "ul",
          { className: "models" },
          ...g.models.map((m) =>
            el(
              "li",
              {},
              el(
                "span",
                { className: "name" },
                el("span", { text: m.label }),
                m.is_default ? el("span", { className: "tag tone-ok", text: "既定" }) : null,
                m.image_only ? el("span", { className: "tag image-only", text: "画像が必要" }) : null,
              ),
              el("span", { className: "price", text: priceText(m) }),
            )
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
  const hasCode = !!params.get("code");
  if (params.get("error_description") || hash.get("error_description")) {
    // 文言は誰でも書き換えられるので、URL の内容は表示しない
    history.replaceState(null, "", returnUrl());
    showLoginNote("ログインできませんでした。\n再度ログインしてください。");
    show("login");
    return;
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  // Google から ?code 付きで戻ったのに、ログインを完了できなかった（code の交換の失敗）：URL の code を消して、
  // ログイン前の画面に案内を 1 行出す。自動のログインはしない
  if (hasCode && (error || !session)) {
    history.replaceState(null, "", returnUrl());
    showLoginNote(MSG_CODE_FAILED);
    show("login");
    return;
  }
  if (error) {
    setMessage($("failed-message"), "ログインエラー：状態を確認できません。\n［再試行］を押してください。");
    show("failed");
    return;
  }
  if (!session) {
    show("login");
    return;
  }
  startWatch(session.user?.id ?? null);
  // 戻ってきた直後の URL に残る code などを消す
  if (location.search || location.hash) history.replaceState(null, "", returnUrl());
  await load();
}

// 戻る・進むでキャッシュ（bfcache）から表示されたときは、読み込み直して今のログインの状態から作り直す
// （止まっていた間に、ほかのタブでログアウトしていても、前の画面を出したままにしない）
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
$("closed-logout-btn").addEventListener("click", signOut);
$("failed-logout-btn").addEventListener("click", signOut);
// 更新中は aria-disabled（押しても何もしない）。手動の更新と、更新の失敗からの［もう一度試す］は本人の画面のまま読み直す
$("reload-btn").addEventListener("click", () => {
  if (!loading) load({ mode: "manual" });
});
$("refresh-retry-btn").addEventListener("click", () => {
  if (!loading) load({ mode: "manual" });
});
$("retry-btn").addEventListener("click", () => load({ mode: "retry" }));

// ---- つなぎ方のコピーのボタン（コードの枠の右上のアイコン） ----
// 枠（code）の文字をそのままクリップボードへ。使えない・断られたときは、枠の文字を選んだ状態にして（アイコンはそのまま）「選んだ文字をコピーしてください」と出す。
// 知らせは各枠の下の 1 行（role="status"。見た目と読み上げの両方）。ボタンからフォーカスは動かさない
const copyTimers = new WeakMap();
// 枠ごとに、最後に押した［コピー］の結果だけを出す（連打で完了の順が入れ替わっても、古い結果で上書きしない。Codex TASK-0101 の F101-02）
const copyGate = createLatestGate();
function selectContents(node) {
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // 選べなくても、知らせは出す
  }
}
async function copyFromBox(btn) {
  const box = btn.closest(".copy-box");
  const code = document.getElementById(btn.dataset.copy);
  const status = box?.querySelector(".copy-status");
  if (!code || !status) return;
  const text = copyTextOf(code.textContent);
  const turn = copyGate.begin(status);
  let ok = false;
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  // この間に同じ枠の［コピー］がまた押されていたら、この結果は出さない（新しいほうの結果だけを出す）
  if (!copyGate.isLatest(status, turn)) return;
  clearTimeout(copyTimers.get(status));
  // 同じ文が続いても読み上げられるように、いったん空にしてから入れる
  status.textContent = "";
  status.classList.toggle("warn", !ok);
  delete btn.dataset.state;
  if (ok) {
    status.textContent = MSG_COPY_OK;
    // アイコンを一時的にチェックの印にする（知らせの文と同じ時間）
    btn.dataset.state = "done";
    copyTimers.set(status, setTimeout(() => {
      status.textContent = "";
      delete btn.dataset.state;
    }, COPY_OK_CLEAR_MS));
  } else {
    selectContents(code);
    status.textContent = MSG_COPY_FALLBACK;
  }
}
$("connect-fold").addEventListener("click", (e) => {
  const btn = e.target?.closest?.(".copy-btn");
  if (btn) copyFromBox(btn);
});

main().catch(() => {
  // 原因が分からない起動の失敗（E-LOG-99）。index.html の #failed の初めの文と同じ文・同じコード
  setMessage($("failed-message"), "表示エラーが発生しました。\nページを再読み込みしてください。", { code: "E-LOG-99" });
  show("failed");
});
