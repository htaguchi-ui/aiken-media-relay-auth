// マイページ（トップ / ・/mypage・/mypage.html。ファイルは index.html）。ログイン中の本人の「残りクレジット」と「使えるモデル（目安単価）」を、
// Edge Function user-api（GET /me）から読んで表示する。Canvas は別のタブで開く普通のリンク（この画面からは何も送らない）。
// 読み取り専用（書き込みは一切しない）。ドルの金額・換算は出さない。メールアドレスは画面に出さない（2026-10-19 田口さんの決定）。
// ただし「登録されていない」画面だけは、違うアカウントで入ったと気づけるよう、ログインしたメールアドレスを出す（同日 main の決定）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// 読み直しは、初回・再試行・手動（⟳）と、タブがまた見えたとき（前回の成功から 30 秒以上・1 回だけ）。一定間隔の自動の読み直しはしない。
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
  headerTools,
  COPY_OK_CLEAR_MS,
  copyTextOf,
  createLatestGate,
  MSG_COPY_FALLBACK,
  MSG_COPY_OK,
  lowNotice,
  MSG_CODE_FAILED,
  MSG_DENIED,
  MSG_STAGE_SUMMARY,
  oauthOptions,
  priceText,
  roleBadgeClass,
  shouldReloadOnReturn,
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

// 読み込めない（通信の失敗・integrity の不一致）ときは先へ進まない。
// トップの役目（サービスの説明・方針と規約へのリンク）は残すため、ログイン前の画面をボタンを押せない形で出す
if (typeof window.supabase?.createClient !== "function") {
  $("login-note").textContent = "画面の部品を読み込めませんでした。通信状態を確認して、ページを開き直してください。";
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

// ---- ログイン・ログアウト ----

/**
 * Google のログインへ移る。ふつうの［Google でログイン］はアカウントを選ぶ画面を出さない。
 * 「別のアカウントでログイン」（selectAccount）のときだけ選ぶ画面を出す（決定 70）
 */
async function signIn({ selectAccount = false } = {}) {
  await supabase.auth.signInWithOAuth({ provider: "google", options: oauthOptions(returnUrl(), selectAccount) });
}

/** ログインを終えている途中（このタブのログアウト・401・ほかのタブからの知らせ）。知らせを二重に扱わない */
let ending = false;

/** ログアウトして、この端末の共有のログインを消す（通信できなくても消す。講師の画面・Canvas のタブもログインの画面になる） */
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

/** 最後に読み込みに成功した時刻（ミリ秒）。成功したときだけ進める。ログアウト・画面の中身を消すときに null に戻す */
let lastSuccessAt = null;
/** 要求の番号（古い応答・ログアウトのあとの応答・別のアカウントの応答で画面を上書きしない） */
const requests = createRequestCounter();

/** 本人のデータを画面から消して、読み込み中の表示にする（ログアウトの通信を待つ間・画面を離れるときに、前の人の画面を残さない） */
function hideContent(message = "ログアウトしています…") {
  // 出ている要求の応答は、届いても画面に入れない。以後、新しい番号も取れない（ログインし直すときはページを読み直す）
  requests.close();
  lastSuccessAt = null;
  $("me-role").textContent = "";
  $("me-role").hidden = true;
  renderTools(null);
  $("denied-message").textContent = MSG_DENIED;
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
  $("stage-summary").textContent = "";
  $("stage-summary").hidden = true;
  $("hero-body").classList.remove("has-context");
  $("stages").replaceChildren();
  $("stage-note").textContent = "";
  $("stages-meta").textContent = "";
  $("stages-group").hidden = true;
  $("folds").classList.remove("has-stages");
  $("credits-notice").textContent = "";
  $("credits-notice").hidden = true;
  $("refresh-error-text").textContent = "";
  $("refresh-error").hidden = true;
  $("models").replaceChildren();
  $("models-meta").textContent = "";
  $("models-empty").hidden = true;
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
  // Canvas などから戻ったときは、条件つきで 1 回だけ読み直す
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onVisible();
  });
}

/** タブがまた見えたとき：条件を満たすときだけ 1 回読み直す（Canvas から戻ったときの残りの確認） */
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
  if (go) load({ mode: "return" });
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

let loading = false;

/** 更新のボタンを「更新中」にする・戻す（disabled にはしない：押したボタンからフォーカスが外れないように aria-disabled で止める） */
function setBusy(busy) {
  const btn = $("reload-btn");
  btn.setAttribute("aria-disabled", busy ? "true" : "false");
  btn.classList.toggle("busy", busy);
  btn.dataset.tip = busy ? "更新中…" : "最新にする";
  $("refresh-retry-btn").setAttribute("aria-disabled", busy ? "true" : "false");
}

/**
 * 読み込んで画面を切り替える。
 * mode："initial"（初回）・"retry"（失敗の画面の［もう一度試す］）：読み込み中の画面を出し、失敗なら失敗の画面。
 *       "manual"（⟳・更新の失敗の［もう一度試す］）・"return"（タブがまた見えたとき）：本人の画面のまま更新する。
 *       失敗しても画面・開いている詳細・フォーカスはそのままにし、主カードに理由と［もう一度試す］を出す（成功の時刻は進めない）
 */
async function load({ mode = "initial" } = {}) {
  if (loading) return;
  // 番号は最初の await より前に取る。ログアウト（hideContent → requests.close()）を始めたあとは、ここで無効な番号しか取れず、
  // 画面を一切変えずに終わる。認証の確認の待ち・GET の待ちの間にログアウトしても、この番号が無効になる
  let ticket = requests.begin();
  if (!requests.isLive(ticket)) return;
  loading = true;
  const inApp = (mode === "manual" || mode === "return") && current === "app";
  if (inApp) {
    setBusy(true);
  } else {
    $("status").replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    show("status");
  }
  try {
    const session = await currentSession();
    // 認証の確認（トークンの更新を待つことがある）から戻った時点で、番号がまだ有効か。有効なら、そのアカウントを結び付ける
    ticket = requests.withAccount(ticket, session?.user?.id ?? null);
    if (!ticket) return;
    const token = session?.access_token ?? null;
    const { status, body } = await fetchMe(token);
    const outcome = decideApiOutcome(status, body);
    // 応答が届いた時点で、同じ要求・同じアカウントのままか（ログアウト・別の要求・別のアカウントなら、この応答では画面を変えない）。
    // トークンが無かったとき（unauthorized になる）も、番号が有効かは必ず照らす
    const now = await currentSession();
    if (!requests.isLive(ticket)) return;
    if (token && !requests.isCurrent(ticket, now?.user?.id ?? null)) return;
    if (outcome.action === "ok") {
      const before = $("credits-value").textContent;
      render(outcome.body);
      lastSuccessAt = Date.now();
      renderCheckedAt();
      hideRefreshError();
      show("app");
      announceUpdate(mode, before);
    } else if (outcome.action === "unauthorized") {
      hideContent();
      await endSession();
      showLoginNote(outcome.message);
      show("login");
    } else if (outcome.action === "denied") {
      // 登録されていないときだけ、ログインしたアカウントのメールアドレスを出す（違うアカウントで入ったと気づけるように。2026-10-19 main の決定）。
      // メールは user-api の応答ではなく、今のセッションのものを使う
      hideContent("読み込み中…");
      $("denied-message").textContent = deniedMessage(now?.user?.email ?? null);
      show("denied");
    } else if (inApp) {
      showRefreshError(outcome.message);
    } else {
      $("failed-message").textContent = outcome.message;
      show("failed");
    }
  } finally {
    loading = false;
    setBusy(false);
  }
}

/** 最後に成功した時刻（「確認 13:42」）を出す。成功したときだけ呼ぶ */
function renderCheckedAt() {
  const text = checkedAtText(lastSuccessAt);
  $("checked-at").textContent = text ?? "";
  $("checked-at").hidden = !text;
}

/** 本人の画面からの更新に失敗したとき：表示は前回の成功の時点のまま、理由と［もう一度試す］を出す（時刻は進めない） */
function showRefreshError(message) {
  const at = checkedAtText(lastSuccessAt);
  const when = at ? `表示は ${at.replace("確認 ", "")} の時点のものです。` : "";
  $("refresh-error-text").textContent = `${message}${when}`;
  $("refresh-error").hidden = false;
}

function hideRefreshError() {
  const box = $("refresh-error");
  if (box.hidden) return;
  // ［もう一度試す］にフォーカスがあったら、消す前に ⟳ へ移す（フォーカスを失わない）
  if (box.contains(document.activeElement)) $("reload-btn").focus();
  box.hidden = true;
  $("refresh-error-text").textContent = "";
}

/** 読み上げへの知らせは必要な分だけ：手動の更新は結果を、戻ったときの読み直しは残りが変わったときだけ */
function announceUpdate(mode, before) {
  const after = $("credits-value").textContent;
  const at = checkedAtText(lastSuccessAt) ?? "";
  if (mode === "manual") {
    $("live").textContent = `最新の状態を読み込みました。残りクレジット ${after}。${at}`;
  } else if (mode === "return" && before !== after) {
    $("live").textContent = `残りクレジットが ${after} になりました。`;
  }
}

// ---- 表示 ----

function render(me) {
  const role = $("me-role");
  role.textContent = me.role_label || "";
  role.className = `badge ${roleBadgeClass(me.role)}`;
  role.hidden = !me.role_label;
  renderTools(me.role);
  renderCredits(me.credits, me.role);
  renderModels(me.models);
}

/** ヘッダーの講師の画面・管理コンソールのボタン（区分で出し分ける。見た目だけ） */
function renderTools(role) {
  const tools = headerTools(role);
  $("instructor-link").hidden = !tools.instructor;
  $("admin-link").hidden = !tools.admin;
  // ボタンが増えると狭い幅で 1 行に収まらないので、そのときはログアウトをアイコンにする（CSS）
  $("account").classList.toggle("with-tools", tools.instructor || tools.admin);
  // 管理者（ボタンが 4 つ）だけ、とても狭い幅では題名の代わりに小さなマークを見せる（CSS）
  $("account").classList.toggle("with-admin", tools.admin);
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
  if (v.stageName) name.append(el("span", { className: "label", text: "今の段階" }), document.createTextNode(v.stageName));
  const hasList = v.stages.length > 0;
  setLine("stage-summary", hasList ? MSG_STAGE_SUMMARY : null);
  // 一覧が無くなるとき、フォーカスがその中にあったら、主カードの見出しへ移して理由を知らせる（行き場の無いフォーカスにしない）
  const group = $("stages-group");
  if (!hasList && !group.hidden && group.contains(document.activeElement)) {
    $("credits-title").focus();
    $("live").textContent = "今日の段階の一覧はなくなりました。";
  }
  group.hidden = !hasList;
  $("folds").classList.toggle("has-stages", hasList);
  if (!hasList) $("stages-fold").open = false;
  $("stages-meta").textContent = hasList ? `${v.stages.length} 段階` : "";
  $("stage-note").textContent = hasList ? v.stageNote ?? "" : "";
  $("stages").replaceChildren(
    ...v.stages.map((s) =>
      el(
        "li",
        { className: s.current ? "current" : "" },
        el(
          "span",
          { className: "name" },
          el("span", { text: s.name }),
          s.current ? el("span", { className: "tag tone-ok", text: "今" }) : null,
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
                m.image_only ? el("span", { className: "tag image-only", text: "画像から" }) : null,
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
    showLoginNote("ログインできませんでした。もう一度ログインしてください。");
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
    $("failed-message").textContent = "ログイン状態を確認できませんでした。もう一度試してください。";
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
$("logout-btn").addEventListener("click", signOut);
$("denied-logout-btn").addEventListener("click", signOut);
$("failed-logout-btn").addEventListener("click", signOut);
// 更新中は aria-disabled（押しても何もしない）。手動の更新と、更新の失敗からの［もう一度試す］は本人の画面のまま読み直す
$("reload-btn").addEventListener("click", () => {
  if (!loading) load({ mode: "manual" });
});
$("refresh-retry-btn").addEventListener("click", () => {
  if (!loading) load({ mode: "manual" });
});
$("retry-btn").addEventListener("click", () => load({ mode: "retry" }));

// ---- つなぎ方の［コピー］ ----
// 枠（code）の文字をそのままクリップボードへ。使えない・断られたときは、枠の文字を選んだ状態にして「選んだ文字をコピーしてください」と出す。
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
  if (ok) {
    status.textContent = MSG_COPY_OK;
    copyTimers.set(status, setTimeout(() => (status.textContent = ""), COPY_OK_CLEAR_MS));
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
  $("failed-message").textContent = "エラーが発生しました。ページを開き直してください。";
  show("failed");
});
