// 管理コンソールの、画面に依存しない処理（入力の検査・集計・表示用の整形・エラーの日本語化）。
// admin.js から使う。テストは aiken-media-relay/scripts/admin_lib_test.ts。

/** 名簿に登録できるドメイン（DB の check 制約・Edge Function の ALLOWED_EMAIL_DOMAINS と揃える） */
export const ALLOWED_DOMAINS = ["a-i-ken.jp", "a-i-ken.com"];
export const EMAIL_RE = /^[^@\s]+@(a-i-ken\.jp|a-i-ken\.com)$/;

export const ROLE_LABELS = { student: "受講者", member: "AIKENメンバー", admin: "管理者" };
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
  if (message.includes("grant_outside_window")) {
    return "今の枠が無いため、クレジットを追加できません（受講者は Day1〜Day2 の期間内でクレジットが設定されているとき、AIKENメンバーは月額が設定されているときだけ追加できます）。";
  }
  if (message.includes("grant_immutable")) return "追加したクレジットは変更できません。削除して追加し直してください。";
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "この操作をする権限がありません（管理者だけが操作できます）。";
  }
  if (code === "23514" && /course_dates_order/.test(message)) return "Day2 は Day1 より後の日付にしてください。";
  if (code === "23514" && /credits/.test(message)) {
    return `クレジットは 0〜${formatCredits(MAX_CREDITS)} の整数で入力してください（追加は 1 以上）。`;
  }
  if (code === "23514") {
    return `メールアドレスの形式・ドメイン、または区分・状態の値が正しくありません（${
      ALLOWED_DOMAINS.map((d) => "@" + d).join(" / ")
    } の小文字のアドレスのみ）。`;
  }
  if (code === "23505") return "このメールアドレスは既に登録されています。";
  if (/JWT|session|token/i.test(message)) return "ログインの有効期限が切れました。ページを開き直してください。";
  if (/fetch|network/i.test(message)) return "サーバーに接続できませんでした。通信状態を確認してください。";
  return `エラーが発生しました（${message || code || "不明"}）。`;
}

// ---- クレジットの枠（DB：20261015000007_credit_periods.sql と同じ境界・換算） ----
// 受講者：期間ごと（Day1・ブリッジワーク期間・Day2）、AIKENメンバー：日本時間の暦月ごと。上限は基本枠＋一時追加

/** 期間の表示名（一覧では短い名前を使う） */
export const PERIOD_LABELS = {
  before: "期間前",
  day1: "Day1",
  bridge: "ブリッジワーク期間",
  day2: "Day2",
  after: "終了",
};
export const PERIOD_SHORT_LABELS = { ...PERIOD_LABELS, bridge: "ブリッジ" };

/** クレジットの上限（DB の check 制約と揃える） */
export const MAX_CREDITS = 1000000;

/** AIKENメンバーを追加するときの月額の初期値（約 5,000 円） */
export const DEFAULT_MONTHLY_CREDITS = 3300;

/** 円の目安の換算（1 ドル＝150 円で固定。表示の参考だけに使う） */
export const YEN_PER_USD = 150;

/** クレジット → 円の目安（1 クレジット＝$0.01） */
export function creditsToYen(credits) {
  return Math.round(Number(credits ?? 0) * 0.01 * YEN_PER_USD);
}

/** 「約 4,950 円」 */
export function formatYen(credits) {
  return `約 ${creditsToYen(credits).toLocaleString("en-US")} 円`;
}

/** 受講者の期間クレジットの列（members） */
export const CREDIT_FIELDS = ["day1_date", "day2_date", "day1_credits", "bridge_credits", "day2_credits"];
/** AIKENメンバーの月額の列（members） */
export const MONTHLY_FIELDS = ["monthly_credits"];

/** 一時追加のクレジット数の入力を解釈する。1〜1,000,000 の整数でなければ undefined */
export function parseGrantCredits(value) {
  const n = parseCredits(value);
  return n === null || n === undefined || n < 1 ? undefined : n;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 実在する日付の YYYY-MM-DD か */
export function isValidDate(value) {
  const m = String(value ?? "").match(DATE_RE);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** 日本時間のその日の 0:00（ミリ秒） */
export function jstDayStart(date, addDays = 0) {
  return Date.parse(`${date}T00:00:00+09:00`) + addDays * DAY_MS;
}

/**
 * 時刻 at が属する期間（SQL の credit_period と同じ）。'before' | 'day1' | 'bridge' | 'day2' | 'after'。
 * 日付が欠けている・前後が逆なら null
 */
export function creditPeriodAt(day1, day2, at = new Date()) {
  if (!isValidDate(day1) || !isValidDate(day2) || day2 <= day1) return null;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  if (t < jstDayStart(day1)) return "before";
  if (t < jstDayStart(day1, 1)) return "day1";
  if (t < jstDayStart(day2)) return "bridge";
  if (t < jstDayStart(day2, 1)) return "day2";
  return "after";
}

/** 見積額（USD）→ 消費クレジット：ceil(round(usd × 100, 6))（SQL の credits_of と同じ） */
export function creditsOf(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(Math.round(n * 100 * 1e6) / 1e6);
}

/** 3,000 のような桁区切り（null は「—」） */
export function formatCredits(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/** "2026-10-09" → "10/9"（不正・空は「—」） */
export function formatMonthDay(date) {
  const m = String(date ?? "").match(DATE_RE);
  return m ? `${Number(m[2])}/${Number(m[3])}` : "—";
}

/** 日本時間の「10/15 20:31」（空・不正は「—」） */
export function formatShortDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 入力欄の値を読む。ブラウザが解釈できない入力（日付の入力途中・2/30 など。validity.badInput）は
 * value が "" になり「空欄」と区別できないため、"invalid" を返して検査で止める
 */
export function readInputValue(value, badInput = false) {
  return badInput ? "invalid" : String(value ?? "");
}

/** 時間枠の終了（timestamptz）→ 枠の最終日の「M/D」（日本時間。終了の直前の日）。不正なら「—」 */
export function windowLastDayText(windowEnd) {
  const t = Date.parse(windowEnd ?? "");
  if (!Number.isFinite(t)) return "—";
  const jst = new Date(t - 1 + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
}

/** クレジットの入力値を解釈する。空は null、不正は undefined（3,000 のような桁区切りも可） */
export function parseCredits(value) {
  const s = String(value ?? "").trim().replace(/[,，]/g, "");
  if (s === "") return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n <= MAX_CREDITS ? n : undefined;
}

/**
 * 期間・クレジットの入力（文字列）を検査して、members に送る値にする。
 * partial = true（まとめて設定）のときは、空欄の項目を patch に含めない（変更しない）。
 * partial = false（1 人ずつ）のときは、空欄は null（未設定に戻す）。
 * 返り値：{ patch, problems }（problems は日本語の理由の配列）
 */
export function parseCreditForm(raw, { partial = false, fields = CREDIT_FIELDS } = {}) {
  const patch = {};
  const problems = [];
  for (const key of ["day1_date", "day2_date"].filter((k) => fields.includes(k))) {
    const v = String(raw?.[key] ?? "").trim();
    if (v === "") {
      if (!partial) patch[key] = null;
    } else if (!isValidDate(v)) {
      problems.push(`${key === "day1_date" ? "Day1" : "Day2"} の日付が正しくありません`);
    } else {
      patch[key] = v;
    }
  }
  const labels = { day1_credits: "Day1", bridge_credits: "ブリッジワーク期間", day2_credits: "Day2", monthly_credits: "月額" };
  for (const key of ["day1_credits", "bridge_credits", "day2_credits", "monthly_credits"].filter((k) => fields.includes(k))) {
    const v = String(raw?.[key] ?? "").trim();
    const n = parseCredits(v);
    if (n === undefined) {
      problems.push(`${labels[key]}のクレジットは 0〜${formatCredits(MAX_CREDITS)} の整数で入力してください`);
    } else if (n !== null || !partial) {
      patch[key] = n;
    }
  }
  const order = datesProblem(patch.day1_date, patch.day2_date);
  if (order) problems.push(order);
  return { patch, problems };
}

/** Day2 は Day1 より後（両方あるときだけ確認する）。問題があれば理由、なければ null */
export function datesProblem(day1, day2) {
  if (day1 && day2 && day2 <= day1) return "Day2 は Day1 より後の日付にしてください";
  return null;
}

/** 既存の行に変更を重ねた結果の、日付の前後の問題（まとめて設定で片方の日付だけ変えるとき） */
export function mergedDatesProblem(row, patch) {
  const day1 = "day1_date" in patch ? patch.day1_date : row.day1_date;
  const day2 = "day2_date" in patch ? patch.day2_date : row.day2_date;
  return datesProblem(day1, day2);
}

/** 「420 / 3,500（3,000＋500）」。追加が無ければ「420 / 3,000」 */
function usedOfLimit(used, limit, base, granted) {
  const breakdown = Number(granted ?? 0) > 0 && base !== null && base !== undefined
    ? `（${formatCredits(base)}＋${formatCredits(granted)}）`
    : "";
  return `${formatCredits(used ?? 0)} / ${formatCredits(limit)}${breakdown}`;
}

/**
 * 一覧の「今の枠」の表示。管理者は null。
 * admin_usage の current_*（DB が credit_window で求めた値）を使う。
 * 返り値：{ period, text, warn, yen }（warn = true は生成できない・使い切った状態として目立たせる。yen は円の目安）
 */
export function currentPeriodSummary(row, now = new Date()) {
  if (row.role === "member") {
    const limit = row.current_limit_credits ?? null;
    if (limit === null) return { period: "month", text: "今月：未設定（生成できません）", warn: true, yen: null };
    const used = Number(row.current_used_credits ?? 0);
    return {
      period: "month",
      text: `今月 ${usedOfLimit(used, limit, row.current_base_credits, row.current_granted_credits)}`,
      warn: used >= Number(limit),
      yen: `上限 ${formatYen(limit)}`,
    };
  }
  if (row.role !== "student") return null;
  const period = row.current_period ?? creditPeriodAt(row.day1_date, row.day2_date, now);
  if (!period) return { period: null, text: "未設定（生成できません）", warn: true, yen: null };
  if (period === "before") {
    return { period, text: `期間前（Day1 ${formatMonthDay(row.day1_date)} から）`, warn: false, yen: null };
  }
  if (period === "after") return { period, text: "終了（生成できません）", warn: false, yen: null };
  const limit = row.current_limit_credits !== undefined ? row.current_limit_credits : row[`${period}_credits`];
  if (limit === null || limit === undefined) {
    return { period, text: `${PERIOD_SHORT_LABELS[period]}：未設定（生成できません）`, warn: true, yen: null };
  }
  const used = Number(row.current_used_credits ?? row[`${period}_used_credits`] ?? 0);
  return {
    period,
    text: `${PERIOD_SHORT_LABELS[period]} ${
      usedOfLimit(used, limit, row.current_base_credits, row.current_granted_credits)
    }`,
    warn: used >= Number(limit),
    yen: null,
  };
}

/** 今の枠に一時追加できるか（受講者は期間内で基本枠あり、メンバーは月額あり。DB でも検査する） */
export function canGrant(row) {
  return (row.role === "student" || row.role === "member") && row.current_base_credits !== null &&
    row.current_base_credits !== undefined && !!row.current_window_start;
}

/** 一時追加の一覧の 1 行「10/15 20:31 ・ +500 ・「メモ」 ・ 付与：h.taguchi@…」 */
export function grantText(g) {
  const parts = [formatShortDateTime(g.created_at), `+${formatCredits(g.credits)}`];
  if (g.note) parts.push(`「${g.note}」`);
  parts.push(`付与：${g.created_by_email ?? "不明"}`);
  return parts.join(" ・ ");
}

/** 一覧の「Day1 / Day2」の表示（AIKENメンバーは月額制、管理者は対象外） */
export function courseDatesText(row) {
  if (row.role === "member") return "月額制";
  if (row.role !== "student") return "対象外";
  if (!row.day1_date && !row.day2_date) return "未設定";
  return `${formatMonthDay(row.day1_date)} / ${formatMonthDay(row.day2_date)}`;
}
