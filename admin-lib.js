// 管理コンソールの、画面に依存しない処理（入力の検査・集計・表示用の整形・期間と回の判定・エラーの日本語化）。
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

/** 関数・テーブル・列が見つからないエラーか（DB の更新〔013・014〕がまだ適用されていない） */
export function isMissingSchemaError(error) {
  return ["PGRST202", "PGRST204", "PGRST205", "42P01", "42883", "42703"].includes(String(error?.code ?? ""));
}

/**
 * 回と会場（013）がまだ DB に無いか。回の読み込みが「見つからない」で失敗した、または
 * 名簿の行（admin_usage）に cohort_id の列が無いとき true（このときは members に cohort_id を送らない）
 */
export function cohortsSchemaMissing(cohortsError, rows) {
  if (cohortsError && isMissingSchemaError(cohortsError)) return true;
  return Array.isArray(rows) && rows.length > 0 && !rows.some((r) => r && "cohort_id" in r);
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
  // 014：1 人・同じ枠への追加の合計の天井（detail は {granted, request, limit}）
  if (message.includes("grant_total_exceeded")) {
    let d = {};
    try {
      d = JSON.parse(error.details ?? error.detail ?? "{}") ?? {};
    } catch {
      d = {};
    }
    const limit = Number.isFinite(Number(d.limit)) && d.limit !== null ? Number(d.limit) : MAX_GRANT_TOTAL;
    const parts = [];
    if (Number.isFinite(Number(d.granted)) && d.granted !== null) parts.push(`追加済み ${formatCredits(d.granted)}`);
    if (Number.isFinite(Number(d.request)) && d.request !== null) parts.push(`今回 ${formatCredits(d.request)}`);
    return `この人の今の枠への追加は、合計で ${formatCredits(limit)} までです${parts.length ? `（${parts.join("、")}）` : ""}。`;
  }
  if (message.includes("cohort_id_mismatch")) {
    return "回の ID が会場番号と Day1 の日付に合いません。読み込み直してからやり直してください。";
  }
  // 設定の誤り（014 の admin_update_settings。message は日本語で、範囲・項目名を含む）
  if (code === "22023" && /[^\x00-\x7F]/.test(message)) return message;
  // DB が日本語の説明を返したとき（天井を超える追加など）は、そのまま出す
  const japanese = [message, error.hint].find((t) => /[^\x00-\x7F]/.test(String(t ?? "")));
  if (japanese && code !== "42501") return String(japanese);
  // DB の更新がまだ適用されていない：関数・テーブル・列が見つからない（設定は 014、回と会場は 013）
  if (isMissingSchemaError(error)) {
    if (/admin_get_settings|admin_update_settings|admin_settings_history|app_settings/.test(message)) {
      return "DB の更新（設定：014）がまだ適用されていないため、この操作はできません。";
    }
    return "DB の更新（回と会場：013）がまだ適用されていないため、この操作はできません。";
  }
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "この操作をする権限がありません（管理者だけが操作できます）。";
  }
  if (code === "23503") {
    const deleting = /update or delete/i.test(message);
    if (/members_cohort_id_fkey/.test(message)) {
      return deleting
        ? "所属している受講者がいるため、この回は削除できません。先に別の回へ移すか、名簿から外してください。"
        : "選んだ回が見つかりません（削除された可能性があります）。読み込み直してください。";
    }
    if (/cohorts_venue_no_fkey/.test(message)) {
      return deleting ? "この会場には回があるため削除できません。" : "選んだ会場が見つかりません。読み込み直してください。";
    }
    return "ほかのデータから参照されているため、この操作はできません。";
  }
  if (code === "23514" && /dates_order/.test(message)) return "Day2 は Day1 より後の日付にしてください。";
  if (code === "23514" && /cohorts_day1_range/.test(message)) return "Day1 は 2000〜2099 年の日付にしてください。";
  if (code === "23514" && /venues_no_check/.test(message)) return "会場番号は 2 桁の数字にしてください（例：06）。";
  if (code === "23514" && /venues_name_check/.test(message)) return "会場名を入力してください。";
  // クレジットの範囲（014 の天井）。制約は NOT VALID なので、天井を超える古い行は、ほかの列を変えるだけでも拒否される
  if (code === "23514" && /credits/.test(message)) {
    return `クレジットの値が上限 ${formatCredits(MAX_CREDITS)} を超えています（0〜${formatCredits(MAX_CREDITS)}、追加は 1〜${formatCredits(MAX_CREDITS)}）。` +
      `入力した値か、保存済みの古い値が ${formatCredits(MAX_CREDITS)} を超えている場合は、まずその値を ${formatCredits(MAX_CREDITS)} 以下に直してください。`;
  }
  if (code === "23514") {
    return `メールアドレスの形式・ドメイン、または区分・状態の値が正しくありません（${
      ALLOWED_DOMAINS.map((d) => "@" + d).join(" / ")
    } の小文字のアドレスのみ）。`;
  }
  if (code === "23505" && /cohorts_pkey/.test(message)) return "同じ会場・同じ Day1 の回が既にあります（回の ID が重なります）。";
  if (code === "23505" && /venues_pkey/.test(message)) return "その会場番号は既に使われています。";
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

/**
 * クレジットの上限（DB の check 制約・トリガと揃える。014 の天井：監査 M3・2026-10-16 田口さん決定）。
 * 回の期間ごと・メンバーの月額・1 回の追加は 0（追加は 1）〜10,000
 */
export const MAX_CREDITS = 10000;

/** 1 人・今の枠（期間・月）への一時追加の合計の上限 */
export const MAX_GRANT_TOTAL = 10000;

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

/** 一時追加のクレジット数の入力を解釈する。1〜10,000 の整数でなければ undefined */
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

/** 今の枠に credits を足せるか。合計の上限（MAX_GRANT_TOTAL）を超えるなら理由（日本語）、足せるなら null */
export function grantTotalProblem(row, credits) {
  const granted = Number(row?.current_granted_credits ?? 0);
  if (granted + Number(credits) <= MAX_GRANT_TOTAL) return null;
  const room = Math.max(0, MAX_GRANT_TOTAL - granted);
  return `今の枠への追加は、1 人あたり合計 ${formatCredits(MAX_GRANT_TOTAL)} クレジットまでです（追加済み ${formatCredits(granted)}。あと ${formatCredits(room)} まで）`;
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

// ---- 名簿の表示（今の枠・要対応・絞り込み） ----

/** 区分の短い表示名（バッジ・絞り込み） */
export const ROLE_SHORT_LABELS = { student: "受講者", member: "メンバー", admin: "管理者" };

/** 残りがこの割合以下なら「残り少ない」として目立たせる */
export const LOW_REMAINING_RATIO = 0.2;

/** 名前（表示名が無ければメールアドレス） */
export function displayName(row) {
  const name = String(row?.display_name ?? "").trim();
  return name || String(row?.email ?? "");
}

/** 使用の割合（0〜100 の整数）。上限 0 で使用があれば 100 */
export function usagePct(used, limit) {
  const u = Number(used ?? 0);
  const l = Number(limit ?? 0);
  if (!(l > 0)) return u > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((u / l) * 100)));
}

/** 残りが少ないか（上限の 2 割以下、または使い切った） */
export function isLow(remaining, limit) {
  const r = Number(remaining ?? 0);
  const l = Number(limit ?? 0);
  if (r <= 0) return true;
  return l > 0 && r <= l * LOW_REMAINING_RATIO;
}

/**
 * 名簿の 1 人の「今の枠」の表示（admin_usage の current_* を使う。DB の credit_window と同じ値）。
 * state：quota（枠あり）／unset（未設定で生成できない）／before（期間前）／after（期間後）／none（管理者は対象外）。
 * noCohort：受講者で回に所属していない。legacy：回に所属していないが、旧い個別の日付で判定されている（013 の移行措置）
 * @returns {{ state: string, noCohort: boolean, legacy: boolean, text?: string, label?: string, shortLabel?: string,
 *   limit?: number, used?: number, remaining?: number, base?: number | null, granted?: number, pct?: number, low?: boolean }}
 */
export function windowView(row) {
  if (row?.role !== "student" && row?.role !== "member") {
    return { state: "none", text: "クレジットの枠は対象外（直近 24 時間の上限のみ）", noCohort: false, legacy: false };
  }
  const isStudent = row.role === "student";
  const noCohort = isStudent && !row.cohort_id;
  const period = row.current_period ?? null;
  const until = row.current_last_date ? `・${formatMonthDay(row.current_last_date)}まで` : "";
  const base = { noCohort, legacy: isStudent && noCohort && !!period };
  if (isStudent) {
    if (!period) {
      return {
        ...base,
        state: "unset",
        text: noCohort ? "回が未設定のため、生成できません" : "日付が未設定のため、生成できません",
      };
    }
    if (period === "before") {
      return { ...base, state: "before", text: `期間前（Day1 ${formatMonthDay(row.day1_date)} から使えます）` };
    }
    if (period === "after") return { ...base, state: "after", text: "期間が終わりました（生成できません）" };
  }
  const label = isStudent ? `${PERIOD_LABELS[period] ?? period}${until}` : `今月${until}`;
  const shortLabel = isStudent ? `${PERIOD_SHORT_LABELS[period] ?? period}${until}` : label;
  const limit = row.current_limit_credits;
  if (limit === null || limit === undefined) {
    return {
      ...base,
      state: "unset",
      label,
      shortLabel,
      text: isStudent
        ? `${PERIOD_LABELS[period] ?? period}のクレジットが未設定のため、生成できません`
        : "月額が未設定のため、生成できません",
    };
  }
  const used = Number(row.current_used_credits ?? 0);
  const remaining = row.current_remaining_credits ?? Math.max(Number(limit) - used, 0);
  return {
    ...base,
    state: "quota",
    label,
    shortLabel,
    limit: Number(limit),
    used,
    remaining: Number(remaining),
    base: row.current_base_credits ?? null,
    granted: Number(row.current_granted_credits ?? 0),
    pct: usagePct(used, limit),
    low: isLow(remaining, limit),
  };
}

/** 要対応か（未設定で生成できない・回が未設定・残りが少ない） */
export function needsAttention(row) {
  const v = windowView(row);
  return v.state === "unset" || v.legacy || (v.state === "quota" && v.low);
}

/** 名簿の絞り込み（id と表示名） */
export const ROSTER_FILTERS = [
  { id: "all", label: "すべて" },
  { id: "needs", label: "要対応" },
  { id: "student", label: "受講者" },
  { id: "member", label: "メンバー" },
  { id: "admin", label: "管理者" },
  { id: "stopped", label: "停止中" },
];

export function matchesFilter(row, filter) {
  switch (filter) {
    case "needs":
      return needsAttention(row);
    case "student":
    case "member":
    case "admin":
      return row.role === filter;
    case "stopped":
      return row.status !== "active";
    default:
      return true;
  }
}

/** 検索：名前・メールアドレス・回の ID の部分一致（大文字小文字を区別しない） */
export function matchesQuery(row, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return [row.email, row.display_name, row.cohort_id].some((v) => String(v ?? "").toLowerCase().includes(q));
}

/** 最終アクセスの表示「10/15 20:31 · Codex」（未アクセスは「まだアクセスなし」） */
export function accessText(row) {
  if (!row?.last_access_at) return "まだアクセスなし";
  return `${formatShortDateTime(row.last_access_at)} · ${row.last_client_name ?? "接続元不明"}`;
}

/** 見積額（USD）→「約 160 クレジット」（失敗したジョブも含む使用量の目安） */
export function approxCreditsText(usd) {
  return `約 ${formatCredits(creditsOf(usd))} クレジット`;
}

// ---- 回と会場（DB：20261016000013_cohorts.sql） ----

/** 会場番号（2 桁の数字。DB の check 制約と同じ） */
export const VENUE_NO_RE = /^[0-9]{2}$/;

/** 回の ID「<会場番号>-<Day1 の YYMMDD>」（SQL の cohort_id_of と同じ）。作れなければ null */
export function cohortIdOf(venueNo, day1) {
  const v = String(venueNo ?? "");
  if (!VENUE_NO_RE.test(v) || !isValidDate(day1)) return null;
  return `${v}-${day1.slice(2, 4)}${day1.slice(5, 7)}${day1.slice(8, 10)}`;
}

/** YYYY-MM-DD に日数を足す（不正なら null） */
export function addDaysToDate(date, days) {
  if (!isValidDate(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-10-09" → "10/9（金）"（不正・空は「—」） */
export function formatDateWithWeekday(date) {
  if (!isValidDate(date)) return "—";
  return `${formatMonthDay(date)}（${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}）`;
}

/** 回の状態の表示（admin_cohorts の current_period から）。kind は upcoming / active / ended */
export function cohortStatus(period) {
  switch (period) {
    case "before":
      return { label: "開催前", kind: "upcoming" };
    case "day1":
      return { label: "Day1 当日", kind: "active" };
    case "bridge":
      return { label: "ブリッジワーク中", kind: "active" };
    case "day2":
      return { label: "Day2 当日", kind: "active" };
    case "after":
      return { label: "終了", kind: "ended" };
    default:
      return { label: "—", kind: "ended" };
  }
}

/**
 * 回の 3 期間（Day1・ブリッジワーク・Day2）の表示。c は day1_date・day2_date・*_credits を持つもの。
 * state：done（済）／now（今）／next（これから）。ブリッジワーク期間が無い回（Day2 が Day1 の翌日）は none = true
 */
export function coursePeriods(c, currentPeriod) {
  const day1 = c?.day1_date;
  const day2 = c?.day2_date;
  if (!isValidDate(day1) || !isValidDate(day2) || day2 <= day1) return [];
  const bridgeStart = addDaysToDate(day1, 1);
  const bridgeEnd = addDaysToDate(day2, -1);
  const hasBridge = bridgeStart <= bridgeEnd;
  const order = ["day1", "bridge", "day2"];
  const now = currentPeriod === "after" ? 3 : order.indexOf(currentPeriod ?? "");
  const unset = (v) => v === null || v === undefined;
  const creditsText = (v) => (unset(v) ? "未設定" : formatCredits(v));
  const items = [
    { key: "day1", name: "Day1", dates: formatDateWithWeekday(day1), credits: creditsText(c.day1_credits), unset: unset(c.day1_credits), none: false },
    hasBridge
      ? {
        key: "bridge",
        name: "ブリッジワーク",
        dates: bridgeStart === bridgeEnd
          ? formatDateWithWeekday(bridgeStart)
          : `${formatMonthDay(bridgeStart)} – ${formatMonthDay(bridgeEnd)}`,
        credits: creditsText(c.bridge_credits),
        unset: unset(c.bridge_credits),
        none: false,
      }
      : { key: "bridge", name: "ブリッジワーク", dates: "なし（Day2 が Day1 の翌日）", credits: "—", unset: false, none: true },
    { key: "day2", name: "Day2", dates: formatDateWithWeekday(day2), credits: creditsText(c.day2_credits), unset: unset(c.day2_credits), none: false },
  ];
  // 期間前（before）・期間が分からないときは、すべて「これから」
  return items.map((p, i) => ({ ...p, state: now < 0 ? "next" : i < now ? "done" : i === now ? "now" : "next" }));
}

/** 回の選択肢の表示「06-261120 · 第2回 · 青山オフィス」 */
export function cohortLabel(c) {
  return [c?.id, c?.name, c?.venue_name].filter((v) => String(v ?? "").trim()).join(" · ");
}

/** 受講者を追加するときの既定の回：開催中（Day1〜Day2）のもの、無ければ開催前でいちばん近いもの、どちらも無ければ null */
export function defaultCohortId(cohorts) {
  const list = [...(cohorts ?? [])].sort((a, b) => String(a.day1_date).localeCompare(String(b.day1_date)));
  return list.find((c) => ["day1", "bridge", "day2"].includes(c.current_period))?.id ??
    list.find((c) => c.current_period === "before")?.id ?? null;
}

/**
 * 回の今の期間の合計（所属する受講者の使用の合計 / 1 人あたり × 人数）。期間外は null。
 * 上限は基本枠だけ（一時追加は含まない）。1 人あたりが未設定なら limit は null
 */
export function cohortUsage(c) {
  const period = c?.current_period;
  if (!["day1", "bridge", "day2"].includes(period)) return null;
  const perPerson = c[`${period}_credits`];
  const count = Number(c.member_count ?? 0);
  const used = Number(c.current_used_credits ?? 0);
  const limit = perPerson === null || perPerson === undefined ? null : Number(perPerson) * count;
  return { period, periodLabel: PERIOD_LABELS[period], used, limit, pct: limit === null ? 0 : usagePct(used, limit) };
}

/** 回の受講者を残りの少ない順に（生成できない人を先に、同じなら名前順） */
export function sortByRemaining(rows) {
  const key = (r) => {
    const v = windowView(r);
    return v.state === "quota" ? v.remaining : v.state === "unset" ? -1 : Number.MAX_SAFE_INTEGER;
  };
  return [...rows].sort((a, b) => key(a) - key(b) || displayName(a).localeCompare(displayName(b), "ja"));
}

/**
 * 回の作成・編集の入力（文字列）を検査して、cohorts に送る値にする（id は送らない。DB が会場番号と Day1 から決める）。
 * クレジットの空欄は null（未設定）。返り値：{ patch, problems }
 */
export function parseCohortForm(raw) {
  /** @type {Record<string, string | number | null>} */
  const patch = {};
  const problems = [];
  const venue = String(raw?.venue_no ?? "").trim();
  if (!VENUE_NO_RE.test(venue)) problems.push("会場を選んでください");
  else patch.venue_no = venue;
  for (const [key, label] of [["day1_date", "Day1"], ["day2_date", "Day2"]]) {
    const v = String(raw?.[key] ?? "").trim();
    if (v === "") problems.push(`${label} の日付を入力してください`);
    else if (!isValidDate(v)) problems.push(`${label} の日付が正しくありません`);
    else patch[key] = v;
  }
  if (patch.day1_date && (patch.day1_date < "2000-01-01" || patch.day1_date >= "2100-01-01")) {
    problems.push("Day1 は 2000〜2099 年の日付にしてください");
  }
  const order = datesProblem(patch.day1_date, patch.day2_date);
  if (order) problems.push(order);
  const labels = { day1_credits: "Day1", bridge_credits: "ブリッジワーク期間", day2_credits: "Day2" };
  for (const key of ["day1_credits", "bridge_credits", "day2_credits"]) {
    const n = parseCredits(raw?.[key]);
    if (n === undefined) problems.push(`${labels[key]}のクレジットは 0〜${formatCredits(MAX_CREDITS)} の整数で入力してください`);
    else patch[key] = n;
  }
  for (const key of ["name", "note"]) {
    patch[key] = String(raw?.[key] ?? "").trim() || null;
  }
  return { patch, problems };
}

/** 会場の入力を検査する。番号は 1 桁なら 0 を補う（6 → 06）。返り値：{ patch, problems } */
export function parseVenueForm(raw) {
  /** @type {{ no?: string, name?: string, note?: string | null, active?: boolean }} */
  const patch = {};
  const problems = [];
  let no = String(raw?.no ?? "").trim();
  if (/^[0-9]$/.test(no)) no = `0${no}`;
  if (!VENUE_NO_RE.test(no)) problems.push("会場番号は 2 桁の数字で入力してください（例：06）");
  else patch.no = no;
  const name = String(raw?.name ?? "").trim();
  if (!name) problems.push("会場名を入力してください");
  else patch.name = name;
  patch.note = String(raw?.note ?? "").trim() || null;
  patch.active = raw?.active !== false;
  return { patch, problems };
}

// ---- 設定（DB：20261016000014_app_settings.sql の admin_get_settings・admin_update_settings・admin_settings_history、
//      Edge Function admin-api の GET /models） ----

/** 既定（null）の表示。既定の数値そのものはサーバーの環境変数にあり、コンソールからは読めない */
export const DEFAULT_SETTING_TEXT = "既定（サーバーの設定）";

/** 上限の項目（範囲は DB の CHECK・admin_update_settings と同じ） */
export const SETTING_LIMITS = [
  {
    key: "daily_job_limit",
    label: "1 人の 24 時間の生成回数",
    min: 1,
    max: 1000,
    integer: true,
    usd: false,
    confirm: false,
    desc: "受講者・メンバー・管理者の全員に、1 人ずつ効きます（直近 24 時間）。",
  },
  {
    key: "user_daily_cost_limit_usd",
    label: "管理者 1 人の 24 時間の額",
    min: 1,
    max: 500,
    integer: false,
    usd: true,
    confirm: false,
    desc: "クレジットの枠の無い管理者だけに効きます（見積額。受講者・メンバーはクレジットの枠が代わり）。",
  },
  {
    key: "global_daily_cost_limit_usd",
    label: "全体の 24 時間の額",
    min: 10,
    max: 2000,
    integer: false,
    usd: true,
    confirm: true,
    desc: "全員の合計の見積額。超えると、誰も生成できなくなります。",
  },
];

export function settingSpec(key) {
  return SETTING_LIMITS.find((s) => s.key === key) ?? null;
}

/** ドルの表示「$300」「$12.50」（null・不正は「—」） */
export function formatUsdShort(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n)
    ? `$${n.toLocaleString("en-US")}`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 上限の値の表示（null は既定） */
export function formatSettingValue(key, value) {
  if (value === null || value === undefined) return DEFAULT_SETTING_TEXT;
  return settingSpec(key)?.usd ? formatUsdShort(value) : `${formatCredits(value)} 回`;
}

/** 範囲の表示「1〜1,000 回」「$10〜$5,000」 */
export function settingRangeText(key) {
  const s = settingSpec(key);
  if (!s) return "";
  return s.usd ? `${formatUsdShort(s.min)}〜${formatUsdShort(s.max)}` : `${formatCredits(s.min)}〜${formatCredits(s.max)} 回`;
}

/** 値の出どころ（DB に値があるか、既定〔環境変数〕か） */
export function settingSource(value) {
  return value === null || value === undefined ? { kind: "default", label: "既定" } : { kind: "db", label: "DB の値" };
}

/**
 * 上限の入力（文字列）を検査して、送る数値にする。全角数字・桁区切り・「$」「回」は許す。
 * 返り値：{ value } か { problem }（日本語）。空欄は problem（既定に戻すのは別の操作）
 */
export function parseSettingInput(key, text) {
  const spec = settingSpec(key);
  if (!spec) return { problem: "変更できる項目ではありません" };
  const s = String(text ?? "")
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[,，\s$＄]|回|ドル|USD/gi, "");
  if (s === "") return { problem: `${spec.label}を入力してください（既定に戻すときは「既定に戻す」を押します）` };
  if (!/^\d+(\.\d+)?$/.test(s)) return { problem: `${spec.label}は数値で入力してください` };
  // 小数の末尾の 0 は落とす（1.500 → 1.5）
  const t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  if (spec.integer && t.includes(".")) return { problem: `${spec.label}は整数で入力してください` };
  if (spec.usd && /\.\d{3,}$/.test(t)) return { problem: `${spec.label}は小数 2 桁（セント）までで入力してください` };
  const value = Number(t);
  if (value < spec.min || value > spec.max) {
    return { problem: `${spec.label}は ${settingRangeText(key)} の範囲で入力してください` };
  }
  return { value };
}

/**
 * 上限を変える前の確認（info は admin_get_settings の結果）。返り値：{ confirm, warnings }。
 * 全体の額は常に確認し、新しい値が直近 24 時間の使用額以下なら「すぐに全員が止まる」と警告する。
 * 1 人の回数は、下げるとき（今が既定〔数値が分からない〕のときも含む）に確認し、上位の利用者の回数以下なら警告する
 */
export function limitChangeCheck(key, current, next, info) {
  const warnings = [];
  if (key === "global_daily_cost_limit_usd") {
    const used = Number(info?.global_cost_usd_24h ?? 0);
    if (next <= used) {
      warnings.push(`直近 24 時間の使用額（${formatUsdShort(used)}）以下のため、保存するとすぐに全員が生成できなくなります。`);
    }
    return { confirm: true, warnings };
  }
  if (key === "daily_job_limit") {
    const lowering = current === null || current === undefined || next < Number(current);
    const top = Math.max(0, ...(Array.isArray(info?.top_users) ? info.top_users : []).map((t) => Number(t.count ?? 0)));
    if (top > 0 && next <= top) {
      warnings.push(`直近 24 時間の回数が最も多い利用者（${formatCredits(top)} 回）は、保存するとすぐに生成できなくなります。`);
    }
    return { confirm: lowering || warnings.length > 0, warnings };
  }
  return { confirm: false, warnings };
}

/**
 * 未保存のオン・オフ（draft。oldModels で読んだ値が基準）を、読み直した newModels の値に乗せ直す。
 * 基準からの差分（オンにした・オフにした model_id）だけを、新しい基準に当てる（環境変数の外のものは当てない）
 */
export function rebaseModelDraft(oldModels, newModels, draft) {
  const { on, off } = modelChanges(oldModels, consoleSelection(oldModels), draft);
  const next = consoleSelection(newModels);
  const known = new Set(catalogModes(newModels).filter(({ mode }) => mode.env_allowed).map(({ mode }) => mode.model_id));
  for (const id of on) if (known.has(id)) next.add(id);
  for (const id of off) if (known.has(id)) next.delete(id);
  return next;
}

/** 2 つの値が同じ設定か（null どうし・数値として等しい） */
export function sameSettingValue(a, b) {
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na || nb) return na && nb;
  return Number(a) === Number(b);
}

/**
 * 直近 24 時間の全体の使用（admin_get_settings の結果から）。
 * limit は DB の値（null なら既定で、数値は分からないので pct も null）。low は上限の 8 割以上
 */
export function globalUsageView(info) {
  const cost = Number(info?.global_cost_usd_24h ?? 0);
  const count = Number(info?.global_count_24h ?? 0);
  const raw = info?.settings?.global_daily_cost_limit_usd;
  const limit = raw === null || raw === undefined ? null : Number(raw);
  const pct = limit === null ? null : usagePct(cost, limit);
  return { cost, count, limit, pct, low: pct !== null && pct >= 80 };
}

/** モデルの種類の並びと表示名 */
export const MODEL_KIND_LABELS = { video: "動画", image: "画像", speech: "読み上げ", music: "音楽" };

/** admin-api の models を種類ごとにまとめる（動画・画像・読み上げ・音楽の順。知らない種類は後ろ） */
export function groupModels(models) {
  const order = Object.keys(MODEL_KIND_LABELS);
  const groups = new Map();
  for (const m of models ?? []) {
    if (!groups.has(m.kind)) {
      groups.set(m.kind, { kind: m.kind, label: MODEL_KIND_LABELS[m.kind] ?? m.kind_label ?? m.kind, models: [] });
    }
    groups.get(m.kind).models.push(m);
  }
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** カタログのすべてのモード（model_id の重複は最初だけ。カタログ順） */
export function catalogModes(models) {
  const seen = new Set();
  const out = [];
  for (const m of models ?? []) {
    for (const mode of m.modes ?? []) {
      if (seen.has(mode.model_id)) continue;
      seen.add(mode.model_id);
      out.push({ model: m, mode });
    }
  }
  return out;
}

/** model_id → 表示名「Kling 2.1（テキストから動画）」の関数（カタログに無い ID はそのまま） */
export function modelLabeler(models) {
  const map = new Map(catalogModes(models).map(({ model, mode }) => [mode.model_id, `${model.label}（${mode.label}）`]));
  return (id) => map.get(id) ?? id;
}

/** コンソールで今オンになっている model_id の集合（読み込んだ時点の値） */
export function consoleSelection(models) {
  return new Set(catalogModes(models).filter(({ mode }) => mode.console_enabled).map(({ mode }) => mode.model_id));
}

/**
 * 1 つのモードの状態の表示。on は画面上のオン・オフ（未保存を含む）。
 * kind：on／off／server_off（環境変数の外。押せない）／provider_off（提供元が使えない）
 */
export function modeStatus(model, mode, on) {
  if (!mode.env_allowed) return { kind: "server_off", text: "サーバー側で無効", locked: true };
  if (!model.provider_available) {
    // 理由（提供元が使えない）はモデルの見出しの下に出すので、ここは短く
    return { kind: "provider_off", text: on ? "オン（提供元が使えない）" : "オフ", locked: false };
  }
  return on ? { kind: "on", text: "オン", locked: false } : { kind: "off", text: "オフ", locked: false };
}

/**
 * 保存する enabled_models。カタログのすべての model_id がオンなら null（制限なし＝環境変数の範囲すべて）、
 * それ以外はオンの model_id の配列（カタログ順）。カタログに無い ID（古い ID）は含めない。
 * 環境変数の外のモードは押せないので、selected には読み込んだ時点のコンソールの値が残る
 */
export function enabledModelsPayload(models, selected) {
  const ids = catalogModes(models).map(({ mode }) => mode.model_id);
  const on = ids.filter((id) => selected.has(id));
  return ids.length > 0 && on.length === ids.length ? null : on;
}

/** 画面上の変更（オンにする・オフにする model_id。カタログ順） */
export function modelChanges(models, before, after) {
  const on = [];
  const off = [];
  for (const { mode } of catalogModes(models)) {
    const a = before.has(mode.model_id);
    const b = after.has(mode.model_id);
    if (!a && b) on.push(mode.model_id);
    if (a && !b) off.push(mode.model_id);
  }
  return { on, off, count: on.length + off.length };
}

/** model_id の配列が同じ集合か（null は「制限なし」で、null どうしだけが等しい） */
export function sameIdSet(a, b) {
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na || nb) return na && nb;
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

/** 名前の一覧を「A、B、C、D ほか 2 件」に */
export function listText(items, max = 4) {
  return items.length > max ? `${items.slice(0, max).join("、")} ほか ${items.length - max} 件` : items.join("、");
}

/**
 * 設定の変更の説明（履歴の 1 件の before_values → after_values）。before が null は作成時。
 * labelOf は model_id → 表示名。変わった項目が無ければ ["変更なし（同じ値で保存）"]
 */
export function settingsDiff(before, after, labelOf = (id) => id) {
  const created = before === null || before === undefined;
  const lines = [];
  for (const s of SETTING_LIMITS) {
    const a = after?.[s.key] ?? null;
    if (created) {
      if (a !== null) lines.push(`${s.label}：${formatSettingValue(s.key, a)}`);
    } else if (!sameSettingValue(before[s.key], a)) {
      lines.push(`${s.label}：${formatSettingValue(s.key, before[s.key])} → ${formatSettingValue(s.key, a)}`);
    }
  }
  const bm = created ? null : (before.enabled_models ?? null);
  const am = after?.enabled_models ?? null;
  if (created ? am !== null : !sameIdSet(bm, am)) {
    if (am === null) lines.push("モデル：制限なし（サーバーの範囲すべて）に戻す");
    else if (am.length === 0) lines.push("モデル：すべてオフ");
    else if (bm === null) lines.push(`モデル：${am.length} 件だけを有効に（${listText(am.map(labelOf))}）`);
    else {
      const on = am.filter((id) => !bm.includes(id));
      const off = bm.filter((id) => !am.includes(id));
      if (on.length) lines.push(`モデルをオン：${listText(on.map(labelOf))}`);
      if (off.length) lines.push(`モデルをオフ：${listText(off.map(labelOf))}`);
    }
  }
  if (created) return [lines.length ? `初期値を設定（${lines.join("・")}）` : "初期値を設定（すべて既定）"];
  return lines.length ? lines : ["変更なし（同じ値で保存）"];
}

/** admin-api の失敗（HTTP の状態と本文 {error, message}。通信の失敗は status 0）を日本語にする */
export function explainApiError(status, body) {
  const code = String(body?.error ?? "");
  // 未デプロイ（ゲートウェイの 404 には CORS が無い）・許可されていないオリジン・通信の失敗は、ブラウザからは status 0 に見える
  if (status === 0) {
    return "サーバーに接続できません。通信の問題か、サーバー側の機能 admin-api がまだ用意されていない可能性があります。";
  }
  if (code === "origin_not_allowed") {
    return "サーバーに接続できませんでした（このページの場所からの接続は許可されていません。公開している管理コンソールから開いてください）。";
  }
  if (status === 403) return "管理者の権限がありません。";
  if (status === 401) return "ログインの有効期限が切れました。ページを開き直してください。";
  if (status === 404) return "サーバー側の機能（admin-api）がまだ用意されていません。";
  // 503 などはサーバーの文言（日本語。既知の誤りだけを返す）
  if (status === 503 && typeof body?.message === "string" && /[^\x00-\x7F]/.test(body.message)) return body.message;
  return `モデルの一覧を読み込めませんでした（HTTP ${status}）。`;
}
