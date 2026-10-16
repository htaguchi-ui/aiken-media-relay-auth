// 許可画面（consent.html）が使う：認可コードを渡してよい戻り先かどうかの判定。
// 接続アプリは誰でも自動登録できるため、戻り先が許可した相手でなければ許可させない。

/** ChatGPT（ウェブ・デスクトップアプリ）の戻り先 */
export const ALLOWED_REDIRECT_ORIGINS = ["https://chatgpt.com"];

/**
 * PC 内で動くアプリ（Codex など）の戻り先。127.0.0.1 などに戻る方式は、
 * 認可コードが利用者自身の PC にしか届かないので許可する（RFC 8252 のループバック）
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

export function isAllowedRedirect(raw) {
  if (typeof raw !== "string" || !raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return ALLOWED_REDIRECT_ORIGINS.includes(url.origin);
  if (url.protocol === "http:") return LOOPBACK_HOSTS.includes(url.hostname);
  return false;
}

/** 拒否したときに表示する接続元（ホスト名だけ。読めなければ「不明」） */
export function redirectHost(raw) {
  try {
    return new URL(raw).host || "不明";
  } catch {
    return "不明";
  }
}

/** 許可した戻り先の種類（"chatgpt" / "loopback"）。許可しない戻り先は null */
export function redirectKind(raw) {
  if (!isAllowedRedirect(raw)) return null;
  return new URL(raw).protocol === "https:" ? "chatgpt" : "loopback";
}

/** 表示する接続アプリの名前の長さの上限（文字数）。名前は DCR で誰でも決められるので、長い名前で画面を埋めさせない */
export const CLIENT_NAME_MAX = 40;

/** 表示名を上限で切る（超えたら「…」を付ける）。絵文字などの合成された文字は分けない */
export function truncateClientName(name, max = CLIENT_NAME_MAX) {
  const chars = Array.from(String(name ?? ""));
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
}

/**
 * getAuthorizationDetails の結果から、許可画面の進め方を決める
 * - block：許可しない戻り先（先へ進ませない）
 * - redirect：許可済みで、認可コード付きの戻り先 URL が返ってきた（判定済みの url へ戻す）
 * - consent：許可画面を出す（表示名は相手が自由に決められるので、戻り先の種類とホストも出す）
 * - error：結果の形が想定外
 */
export function decideConsent(data) {
  if (!data || typeof data !== "object") return { action: "error" };
  const autoApproved = "redirect_url" in data && !("authorization_id" in data);
  const target = autoApproved ? data.redirect_url : data.redirect_uri;
  if (!isAllowedRedirect(target)) return { action: "block", host: redirectHost(target) };
  if (autoApproved) return { action: "redirect", url: target };
  // 書式制御文字（ゼロ幅スペース・文字の向きの反転など）は見た目の偽装に使えるので取り除く
  const name = typeof data.client?.name === "string" ? data.client.name.replace(/\p{Cf}/gu, "").trim() : "";
  return {
    action: "consent",
    kind: redirectKind(target),
    host: redirectHost(target),
    clientName: truncateClientName(name) || "不明なアプリ",
  };
}
