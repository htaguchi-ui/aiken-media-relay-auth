// 許可画面（consent.html）が使う：認可コードを渡してよい戻り先かどうかの判定。
// 接続アプリは誰でも自動登録できるため、戻り先が許可した相手でなければ許可させない。

/**
 * 認可コードを渡してよい https の戻り先（origin の完全一致。サブドメインは許可しない）。
 * origin ごとに、接続元の種類（kind）と、戻り先の道（パス）を持つ。道が合わない戻り先は許可しない（道を持たない行は何も許可しない）
 * - paths：道が完全に一致するときだけ許可する
 * - idPaths：「その道 + ID 1 つ」のときだけ許可する（ID は英数字・. _ ~ - だけ。空・/ を含む・符号化された文字は許可しない）
 * - どちらも query は許す。fragment は許さない
 * ALLOWED_REDIRECT_ORIGINS と redirectKind は、この表から作る（片方だけに足す誤りを起こさない）。
 * ChatGPT（ウェブ・デスクトップアプリ）は戻り先の道が 2 つだけ（W-CGPT。2026-10-25）：
 * /connector_platform_oauth_redirect（接続の戻り）と /connector/oauth/<ID>（プラグイン・コネクタの戻り）。
 * Claude（claude.ai のウェブ・デスクトップアプリのカスタムコネクタ）。
 * Claude は将来 claude.com に変わる可能性があるため、claude.ai と claude.com の両方を許可する
 */
export const REDIRECT_TARGETS = {
  "https://chatgpt.com": { kind: "chatgpt", paths: ["/connector_platform_oauth_redirect"], idPaths: ["/connector/oauth/"] },
  "https://claude.ai": { kind: "claude", paths: ["/api/mcp/auth_callback"] },
  "https://claude.com": { kind: "claude", paths: ["/api/mcp/auth_callback"] },
};

export const ALLOWED_REDIRECT_ORIGINS = Object.keys(REDIRECT_TARGETS);

/**
 * PC 内で動くアプリ（Codex など）の戻り先。127.0.0.1 などに戻る方式は、
 * 認可コードが利用者自身の PC にしか届かないので許可する（RFC 8252 のループバック）
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

/** idPaths の ID（1 つの区切りだけ。"." と ".." は URL の解析で道から消えるので、下の文字列の照らしで断る） */
const ID_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** 道（URL の解析で整えたあとのパス）が、表の行の paths か idPaths に合うか */
function pathAllowed(target, pathname) {
  if (target.paths?.includes(pathname)) return true;
  return (target.idPaths ?? []).some((p) => pathname.startsWith(p) && ID_SEGMENT.test(pathname.slice(p.length)));
}

/**
 * https の戻り先に合う表の行を返す（無ければ null）。道は完全一致（idPaths は「道 + ID 1 つ」）だけを許す。
 * new URL は ".." や "//" を整えてしまうので、入力の文字列のパスも同じであることを確かめる
 * （"/connector/oauth/.."・"/api/mcp/../mcp/auth_callback"・"%2F" などの符号化・バックスラッシュ・タブや改行の混ぜ込みは許さない）
 */
function matchTarget(url, raw) {
  if (!Object.hasOwn(REDIRECT_TARGETS, url.origin)) return null;
  const target = REDIRECT_TARGETS[url.origin];
  if (!pathAllowed(target, url.pathname) || url.hash) return null;
  const rawPath = raw.replace(/^https:\/\/[^/?#]*/i, "").split(/[?#]/)[0];
  return rawPath === url.pathname && !raw.includes("#") ? target : null;
}

export function isAllowedRedirect(raw) {
  if (typeof raw !== "string" || !raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return matchTarget(url, raw) !== null;
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

/** 許可した戻り先の種類（"chatgpt" / "claude" / "loopback"）。許可しない戻り先は null */
export function redirectKind(raw) {
  if (!isAllowedRedirect(raw)) return null;
  const url = new URL(raw);
  return url.protocol === "https:" ? matchTarget(url, raw).kind : "loopback";
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
