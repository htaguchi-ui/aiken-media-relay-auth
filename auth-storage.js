// ログインの保存先（マイページ mypage.js・講師の画面 instructor.js・Canvas・許可の画面 consent.html・管理コンソール admin.html が使う）。
// 田口さんの決定 70（2026-10-19）：研修用の Mac は再起動のたびに初期化され、アカウントも人ごとに別なので、
// ログインは「この端末（このブラウザ）」で保つ。
// - マイページ・講師の画面・Canvas・許可の画面は、1 つのログインを共有する（localStorage の STUDIO_STORAGE_KEY）。
//   最長 14 日（上限はサーバーの設定。Supabase Auth の Time-box user sessions）。ページを離れても、操作しなくてもログアウトしない
// - 管理コンソールはほかと共有しない（localStorage の ADMIN_CONSOLE_STORAGE_KEY）。ログインは admin-api のログインの流れ
//   （/admin-login/start・finish。docs/design-canvas-login-link.md 5.3）でだけ作り、サーバーが登録した時刻から 12 時間
//   （admin_console_sessions の expires_at。admin_console_status() で読む）で切れる。画面の側で時刻を記録して数えない
// - ほかのタブでログアウトしたら、開いているタブも中身を消してログインの画面にする（storage の知らせと onAuthStateChange。sessionChangeKind）
// Canvas（canvas-app/src/auth/）は npm の supabase-js（同じ 2.117.2）で、同じ鍵・同じ形で読み書きする。鍵を変えるときは両方を変える

/** 共有のログインの鍵（localStorage。マイページ・講師の画面・Canvas・許可の画面） */
export const STUDIO_STORAGE_KEY = "aiken-studio-auth";
/**
 * 管理コンソールのログインの鍵（localStorage。決定 74・193 の 1930 の新しい流れ。設計書 5.3）。ここ 1 か所で決め、管理コンソール
 * （admin.js）と講師の画面（管理者として動くとき）が同じ定数を使う。今の鍵・前の版の鍵（ADMIN_STORAGE_KEY・STUDIO_STORAGE_KEY・
 * OLD_TAB_STORAGE_PREFIXES）のどれも接頭辞に持たない名前にする（古い鍵の掃除・古いタブの見張りで、新しいログインを消さない）
 */
export const ADMIN_CONSOLE_STORAGE_KEY = "aiken-console-auth";
/**
 * 管理コンソールのログインの途中の印（sessionStorage。admin-api の /admin-login/start が返した flow_state）。ログインを始めたタブに
 * だけ置き、Google から戻って /admin-login/finish に送ったら消す。ほかのタブ・ほかの人の戻りの認証コードは、この印が無いと使えない
 */
export const ADMIN_LOGIN_FLOW_KEY = "aiken-console-login-flow";
/**
 * 決定 70 の版の管理コンソールのログインの鍵（localStorage）。**新しい管理コンソールは使わない**（開いた時点で掃除する。
 * OLD_ADMIN_STORAGE_PREFIXES）。名前は Canvas の試験（canvas-app/src/auth/session.test.ts）が読むので、この形のまま残す
 */
export const ADMIN_STORAGE_KEY = "aiken-studio-admin-auth";
/** 管理コンソールのログインの長さ（サーバーの admin_console_sessions と同じ 12 時間。画面の文に使う。判定はサーバーの expires_at） */
export const ADMIN_SESSION_LIMIT_MS = 12 * 60 * 60 * 1000;
/**
 * 決定 70 の版の管理コンソールが localStorage に残した鍵（セッションと、その 12 時間の起点の記録 …-signed-in-at）。新しい管理コンソールを
 * 開いた時点で、トークンがあればこの端末だけのログアウトを送ってから消す（discardOldTabSessions に localStorage とこの一覧を渡す）
 */
export const OLD_ADMIN_STORAGE_PREFIXES = [ADMIN_STORAGE_KEY];
/** 以前の版が localStorage に残したセッション（supabase-js の既定の鍵 sb-<ref>-auth-token。2 つの画面で共有していた） */
export const LEGACY_STORAGE_PREFIX = "sb-tnzwhwitgnzoehbjrmoy-auth-token";

/**
 * 決定 70 の前の版が sessionStorage に置いていた鍵（画面ごとのセッション・最後の操作の時刻・再読み込みの手がかり）。
 * 移り方は「新しい保存先へ移さず、開いた時点で捨てる」（1 回だけログインし直してもらう）。セッションのトークンが残っていれば、
 * この端末だけのログアウト（scope=local）を送ってから消す（discardOldTabSessions）
 */
export const OLD_TAB_STORAGE_PREFIXES = [
  "aiken-consent-auth",
  "aiken-admin-auth",
  "aiken-mypage-auth",
  "aiken-instructor-auth",
  "aiken-canvas-auth",
  "aiken-mypage-reload-hint",
  "aiken-instructor-reload-hint",
  "aiken-canvas-reload-hint",
];

/** 許可の画面のログインの時間切れ（許可の画面でログインを始めてから・許可の画面を出してから、この時間で終える） */
export const CONSENT_TIME_LIMIT_MS = 5 * 60 * 1000;
/**
 * 許可の画面で「このタブが」ログインを始めた時刻（sessionStorage・ミリ秒）。この記録があるときだけ、許可の画面は
 * 自分で始めたログインとして扱い、終わったらログアウトする（今までの守り）。記録が無いのは、マイページなどで済ませた共有のログイン
 */
export const CONSENT_STARTED_KEY = "aiken-consent-login-started-at";
/**
 * 許可の画面が自分で始めたログインの記録（sessionStorage・JSON { userId, sessionId, startedAt }）。Google から戻って交換が
 * 成功したときに、そのセッションに結び付けて書く。CONSENT_STARTED_KEY（試しの印）と分け、?code の無い読み込み
 * （強制終了のあとの復元など）でも消さない。今のログインと同じセッションのときだけ「この画面のログイン」として扱う（F107-03）
 */
export const CONSENT_OWNED_KEY = "aiken-consent-login-owned";

/** storage から、prefix で始まる鍵（セッション・PKCE の検証子など）をすべて消す。消した数を返す */
export function clearStoredSession(storage, prefix) {
  if (!storage) return 0;
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null && k.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
  return keys.length;
}

/** ブラウザの storage を使う（使えない環境では null。そのときは supabase-js がメモリに持つ） */
export function browserStorage(kind) {
  try {
    const s = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/**
 * 記録の時刻（lastActive）から limitMs を過ぎたか。記録が無い・読めない・未来の時刻のときは、過ぎた扱い（安全側）。
 * 許可の画面の 5 分に使う（管理コンソールの 12 時間は adminConsoleExpired。サーバーの時刻で決まる）
 */
export function idleExpired(lastActive, now, limitMs = ADMIN_SESSION_LIMIT_MS) {
  const t = Number(lastActive);
  if (lastActive === null || lastActive === undefined || lastActive === "" || !Number.isFinite(t)) return true;
  if (t > now + 60 * 1000) return true;
  return now - t >= limitMs;
}

/** アクセストークン（JWT）の中身を読む。署名は確かめない（画面の上で「どのセッションか」を見分けるだけに使う）。読めなければ null */
function jwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const v = JSON.parse(atob(b64));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * セッション（supabase-js の保存の形のオブジェクト、またはその JSON の文字列）から、{ userId, sessionId } を読む。
 * sessionId は JWT の session_id（トークンを更新しても変わらず、ログインし直すと変わる。読めなければ null）。
 * トークン・利用者が無ければ null
 */
export function sessionIdentity(sessionOrRaw) {
  let v = sessionOrRaw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const token = v?.access_token;
  const userId = v?.user?.id;
  if (typeof token !== "string" || !token || typeof userId !== "string" || !userId) return null;
  const sid = jwtPayload(token)?.session_id;
  return { userId, sessionId: typeof sid === "string" && sid ? sid : null };
}

/** 同じログインか（同じ利用者。セッションの識別子が両方にあれば、それも同じ）。どちらかが無ければ false */
export function sameIdentity(a, b) {
  if (!a || !b || typeof a.userId !== "string" || a.userId !== b.userId) return false;
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId;
  return true;
}

/**
 * サーバーの管理コンソールの期限（admin_expires_at・admin_console_status() の expires_at。ISO の文字列かミリ秒）を、ミリ秒にする。
 * 読めない・登録から 12 時間（＋時計のずれ 10 分）より先の時刻は null（安全側。ローカルの時刻を 12 時間を延ばす証拠に使わない）
 */
export function adminConsoleExpiresAt(value, now) {
  const t = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || t > now + ADMIN_SESSION_LIMIT_MS + 10 * 60 * 1000) return null;
  return t;
}

/**
 * 管理コンソールの 12 時間を過ぎたか（expiresAt はサーバーの期限のミリ秒。adminConsoleExpiresAt で読んだもの）。
 * 期限が分からない（null・数でない）ときも、過ぎた扱い（安全側）。管理コンソールの時刻の判定はこの 1 か所だけ
 * （admin.js の logoutIfExpired が呼ぶ。サーバーの側の判定は admin_console_sessions。docs/design-canvas-login-link.md の 5.3）
 */
export function adminConsoleExpired(expiresAt, now) {
  return typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || now >= expiresAt;
}

/**
 * 決めたセッション（identity）だけを、この端末の保存先から消す（TASK-0112 の F112-02・F112-03）。
 * 今の保存先がそのセッションのままのときだけ、prefix で始まる鍵を「その場で（await の前に）」消し、そのアクセストークンを返す。
 * 呼び出し側は、返したトークンでログアウトの通信を送る。通信を待つ間にほかのタブで入った新しいログインは消さない
 * （supabase-js の signOut は、通信のあとで、そのときの鍵を無条件に消すので使わない）。違うセッションなら何も消さず null
 */
export function takeStoredSession(storage, key, identity) {
  let raw = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (!identity || !sameIdentity(sessionIdentity(raw), identity)) return null;
  let token = null;
  try {
    token = JSON.parse(raw)?.access_token ?? null;
  } catch {
    token = null;
  }
  clearStoredSession(storage, key);
  return typeof token === "string" && token ? token : null;
}

/** storage に保存されたセッション（supabase-js の形 { access_token, ... }）のアクセストークン。無ければ null */
export function storedAccessToken(storage, key) {
  try {
    const v = JSON.parse(storage?.getItem(key) ?? "null");
    return typeof v?.access_token === "string" && v.access_token ? v.access_token : null;
  } catch {
    return null;
  }
}

/** 保存されたセッションの文字列（JSON）から、利用者の ID を読む。無い・壊れている・トークンが無いときは null */
export function storedUserId(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    const id = v?.user?.id;
    return typeof id === "string" && id && typeof v?.access_token === "string" && v.access_token ? id : null;
  } catch {
    return null;
  }
}

/**
 * ほかのタブで保存先が変わったとき（window の storage の知らせ）に、このタブがどうするか。
 * - "signed-out"：ログインが消えた（ログアウト・時間切れ・storage.clear()）
 * - "user-changed"：別のアカウントのログインに替わった
 * - null：何もしない（ほかの鍵・同じアカウントのトークンの更新・このタブがまだ誰も表示していない）
 * shownUser は、このタブが今表示している利用者の ID（表示していなければ null）。key が null の知らせは storage.clear()
 */
export function sessionChangeKind(event, storageKey, shownUser) {
  if (typeof shownUser !== "string" || !shownUser) return null;
  const key = event?.key ?? null;
  if (key !== null && key !== storageKey) return null;
  const user = key === null ? null : storedUserId(event?.newValue ?? null);
  if (!user) return "signed-out";
  return user === shownUser ? null : "user-changed";
}

/**
 * supabase-js の onAuthStateChange の知らせ（同じタブのトークンの更新の失敗・ほかのタブからの BroadcastChannel）から、
 * このタブがどうするか。返す値は sessionChangeKind と同じ。SIGNED_OUT は "signed-out"、別の利用者のセッションは "user-changed"
 */
export function authEventKind(event, session, shownUser) {
  if (typeof shownUser !== "string" || !shownUser) return null;
  if (event === "SIGNED_OUT") return "signed-out";
  const id = session?.user?.id;
  if (typeof id === "string" && id && id !== shownUser) return "user-changed";
  return null;
}

/**
 * 前の版が残したセッションを捨てる（新しい保存先へは移さない）。トークンがあれば sendLogout(token) でこの端末だけのログアウトを送り、
 * prefixes で始まる鍵を消す。消した数を返す。既定は決定 70 の前の版の sessionStorage の鍵（OLD_TAB_STORAGE_PREFIXES）。
 * 管理コンソールは、決定 70 の版の localStorage の鍵（OLD_ADMIN_STORAGE_PREFIXES）にも使う（storage に localStorage を渡す）
 */
export function discardOldTabSessions(storage, sendLogout, prefixes = OLD_TAB_STORAGE_PREFIXES) {
  if (!storage) return 0;
  let n = 0;
  for (const prefix of prefixes) {
    const token = storedAccessToken(storage, prefix);
    if (token && typeof sendLogout === "function") {
      try {
        sendLogout(token);
      } catch {
        // 送れなくても消す
      }
    }
    n += clearStoredSession(storage, prefix);
  }
  return n;
}
