// ログインの保存先（許可の画面 consent.html と管理コンソール admin.html が使う）。
// 研修用の Mac を何人もで使うため、ログインを端末に残さない（監査 docs/security-audit-credits-20261016.md の H1・M3）。
// - 2 つの画面はセッションを共有しない（storageKey を分ける）
// - 保存先は sessionStorage（タブを閉じれば消える。Google のログインから同じタブに戻るまでは残る）

/** 許可の画面のセッションの鍵（sessionStorage） */
export const CONSENT_STORAGE_KEY = "aiken-consent-auth";
/** 管理コンソールのセッションの鍵（sessionStorage） */
export const ADMIN_STORAGE_KEY = "aiken-admin-auth";
/** 以前の版が localStorage に残したセッション（supabase-js の既定の鍵 sb-<ref>-auth-token。2 つの画面で共有していた） */
export const LEGACY_STORAGE_PREFIX = "sb-tnzwhwitgnzoehbjrmoy-auth-token";

/** 管理コンソールを操作しないまま、この時間が過ぎたらログアウトする */
export const ADMIN_IDLE_LIMIT_MS = 30 * 60 * 1000;
/** 管理コンソールの最後の操作の時刻（sessionStorage・ミリ秒） */
export const ADMIN_ACTIVITY_KEY = `${ADMIN_STORAGE_KEY}-last-active`;

/** 許可の画面のログインの時間切れ（ログインを始めてから・許可の画面を出してから、この時間でログアウトする） */
export const CONSENT_TIME_LIMIT_MS = 5 * 60 * 1000;
/** 許可の画面の時刻の記録（sessionStorage・ミリ秒。ログインを始めたとき・許可の画面を出したときに書く） */
export const CONSENT_ACTIVITY_KEY = `${CONSENT_STORAGE_KEY}-last-active`;

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
 * 最後の操作から limitMs を過ぎたか。記録が無い・読めない・未来の時刻のときは、過ぎた扱い（安全側）。
 * セッションがあるときだけ使う（ログインを始めるときに記録を書くので、正しい流れなら記録は必ずある）
 */
export function idleExpired(lastActive, now, limitMs = ADMIN_IDLE_LIMIT_MS) {
  const t = Number(lastActive);
  if (lastActive === null || lastActive === undefined || lastActive === "" || !Number.isFinite(t)) return true;
  if (t > now + 60 * 1000) return true;
  return now - t >= limitMs;
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
