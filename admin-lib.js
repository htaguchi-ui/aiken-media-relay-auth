// 管理コンソールの、画面に依存しない処理（入力の検査・集計・表示用の整形・エラーの日本語化）。
// admin.js から使う。テストは aiken-media-relay/scripts/admin_lib_test.ts。

/** 名簿に登録できるドメイン（DB の check 制約・Edge Function の ALLOWED_EMAIL_DOMAINS と揃える） */
export const ALLOWED_DOMAINS = ["a-i-ken.jp", "a-i-ken.com"];
export const EMAIL_RE = /^[^@\s]+@(a-i-ken\.jp|a-i-ken\.com)$/;

export const ROLE_LABELS = { student: "受講者", admin: "管理者" };
export const STATUS_LABELS = { active: "有効", disabled: "停止中" };

/** 小文字にして前後の空白を取る */
export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** 登録できる email か。できなければ理由（日本語）、できれば null */
export function emailProblem(email) {
  if (!email) return "メールアドレスが空です";
  if ((email.match(/@/g) || []).length !== 1) return "メールアドレスの形式が正しくありません";
  if (!EMAIL_RE.test(email)) {
    return `許可されていないドメインです（${ALLOWED_DOMAINS.map((d) => "@" + d).join(" / ")} のみ）`;
  }
  return null;
}

/**
 * まとめて追加のテキストを解釈する。1 行 1 件、`email` または `email, 氏名`。空行は無視する。
 * 返り値：valid（送る行）、invalid（送らない行と理由）、duplicates（入力内の重複で除いた件数）
 */
export function parseBulk(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const comma = line.search(/[,，、\t]/);
    const email = normalizeEmail(comma >= 0 ? line.slice(0, comma) : line);
    const name = comma >= 0 ? line.slice(comma + 1).trim() : "";
    const problem = emailProblem(email);
    if (problem) {
      invalid.push({ line: i + 1, text: line, reason: problem });
      return;
    }
    if (seen.has(email)) {
      duplicates++;
      return;
    }
    seen.add(email);
    valid.push({ email, display_name: name || null });
  });
  return { valid, invalid, duplicates };
}

/** 最終利用日時の新しい順（未使用は最後、同じならメールアドレス順） */
export function sortByLastUsed(rows) {
  return [...rows].sort((a, b) => {
    const ta = a.last_used_at ? Date.parse(a.last_used_at) : -Infinity;
    const tb = b.last_used_at ? Date.parse(b.last_used_at) : -Infinity;
    if (ta !== tb) return tb - ta;
    return String(a.email).localeCompare(String(b.email));
  });
}

/** 今日・24 時間・累計の、件数と金額の合計 */
export function sumUsage(rows) {
  const total = { today_count: 0, today_cost_usd: 0, day_count: 0, day_cost_usd: 0, total_count: 0, total_cost_usd: 0 };
  for (const r of rows) {
    for (const k of Object.keys(total)) total[k] += Number(r[k] ?? 0);
  }
  return total;
}

export function formatUsd(value) {
  const n = Number(value ?? 0);
  return `$${n.toFixed(2)}`;
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Supabase（PostgREST）のエラーを日本語の説明にする */
export function explainError(error) {
  if (!error) return "";
  const message = String(error.message ?? "");
  const code = String(error.code ?? "");
  if (message.includes("last_admin_protected")) {
    return "最後の有効な管理者は、停止・役割の変更・削除ができません。先に別の管理者を追加してください。";
  }
  if (message.includes("admin_only")) return "管理者の権限がありません。";
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "この操作をする権限がありません（管理者だけが操作できます）。";
  }
  if (code === "23514") {
    return `メールアドレスの形式・ドメイン、または役割・状態の値が正しくありません（${
      ALLOWED_DOMAINS.map((d) => "@" + d).join(" / ")
    } の小文字のアドレスのみ）。`;
  }
  if (code === "23505") return "このメールアドレスは既に登録されています。";
  if (/JWT|session|token/i.test(message)) return "ログインの有効期限が切れました。ページを開き直してください。";
  if (/fetch|network/i.test(message)) return "サーバーに接続できませんでした。通信状態を確認してください。";
  return `エラーが発生しました（${message || code || "不明"}）。`;
}
