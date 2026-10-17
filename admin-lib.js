// 管理コンソールの、画面に依存しない処理（入力の検査・集計・表示用の整形・期間と回の判定・エラーの日本語化）。
// admin.js から使う。テストは aiken-media-relay/scripts/admin_lib_test.ts。

/** 名簿に登録できるドメイン（DB の check 制約・Edge Function の ALLOWED_EMAIL_DOMAINS と揃える） */
export const ALLOWED_DOMAINS = ["a-i-ken.jp", "a-i-ken.com"];
export const EMAIL_RE = /^[^@\s]+@(a-i-ken\.jp|a-i-ken\.com)$/;

export const ROLE_LABELS = { student: "受講者", member: "AIKENメンバー", admin: "管理者" };
/** 講師の区分（016）。016 が DB に当たるまでは選べないので、ROLE_LABELS には入れず、roleLabelsFor で足す */
export const INSTRUCTOR_ROLE_LABEL = "講師";

/** 画面で選べる区分の表示名。stagesAvailable が false（016 がまだ DB に無い）なら、講師を出さない */
export function roleLabelsFor(stagesAvailable) {
  return stagesAvailable ? { ...ROLE_LABELS, instructor: INSTRUCTOR_ROLE_LABEL } : { ...ROLE_LABELS };
}

/** 月額の枠を持つ区分（AIKENメンバーと講師。講師の月額は 016 でメンバーと同じ扱い） */
export function isMonthlyRole(role) {
  return role === "member" || role === "instructor";
}

/** クレジットの枠を持つ区分（受講者・AIKENメンバー・講師） */
export function isWindowRole(role) {
  return role === "student" || isMonthlyRole(role);
}

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

// ---- 016（セミナーの段階）：DB の拒否の名前と、DB がまだ 016 でないときの判定 ----

/** 016 の DB の物（関数・表・列）の名前。「見つからない」誤りの文にこれが入っていれば、DB の更新（016）がまだ適用されていない */
const STAGE_DB_OBJECTS_RE = new RegExp(
  [
    "cohort_stage_move", "cohort_stage_status", "cohort_stages", "cohort_stage_entries", "cohort_instructors", "instructor_cohorts",
    "instructor_grant", "revoke_stage_grant", "admin_grant_credits", "admin_delete_grant", "admin_update_cohort",
    "admin_save_stage_template", "admin_delete_stage_template", "admin_apply_stage_template", "admin_set_cohort_credit_mode",
    "admin_update_cohort_stage", "admin_replace_day_stages", "admin_set_cohort_instructors", "stage_templates", "stage_template_items",
    "stage_template_id", "stages_applied_at", "credit_mode", "stage_id", "revoked_at", "granted_as", "stage_grant_total_limit",
    "instructor_grant_max_",
  ].join("|"),
);

/** 016 の物が無いための「見つからない」誤りか（関数・表・列が無い、かつ文に 016 の名前が入っている） */
export function isStageSchemaMissing(error) {
  if (!isMissingSchemaError(error)) return false;
  return STAGE_DB_OBJECTS_RE.test([error?.message, error?.details, error?.hint].map((t) => String(t ?? "")).join(" "));
}

/** 名前の関数（RPC）が DB に無い誤りか（PostgREST の PGRST202、または Postgres の 42883） */
export function isMissingFunctionError(error, name) {
  if (!["PGRST202", "42883"].includes(String(error?.code ?? ""))) return false;
  return !name || String(error?.message ?? "").includes(name);
}

/**
 * 016 の DB が当たっているか（画面が知っている判定を、admin.js・instructor.js が入れる）。
 * false の間（016 の前の DB）は、今までの画面の文をそのまま出し、DB の hint に置き換えない
 */
let stageDbReady = false;
export function setStageDbReady(value) {
  stageDbReady = !!value;
}

/** 016 の DB が当たっていないときの文（「まだ使えません」と分かる形） */
export const MSG_STAGE_NOT_READY = "DB の更新（セミナーの段階：016）がまだ適用されていないため、この操作はまだ使えません。";

/**
 * 016 の DB が返す拒否の名前（message が名前だけのとき）と、日本語の hint が無いときに出す文。
 * hint があれば DB の文をそのまま出す（explainError）。名前は message と「完全に同じ」ときだけ拾う
 * （部分一致で拾うと、ほかの誤りの文や将来の名前を取り違える）
 */
export const STAGE_REJECTIONS = {
  instructor_only: "講師または管理者の権限がありません。担当する回の講師として登録されているか、管理者に確かめてください。",
  stage_changed: "ほかの人が先に段階を動かしていました。最新の状態を読み込み直したので、確かめてからもう一度操作してください。",
  stage_not_today: "移れるのは、今日の段階だけです。別の日の段階へは移せません。",
  stage_outside_course: "Day1 より前、または Day2 が終わったあとは、段階を動かせません。",
  stage_mode_off: "この回は、段階ごとの枠になっていません（Day ごとの枠です）。",
  stage_cohort_locked: "この日の段階は、もう始まっているため、順番や数を変えられません（名前・題名・クレジットは変えられます）。",
  stage_cohort_dates_via_rpc:
    "テンプレートを当てた回の日付は、この画面では変えられません。新しい管理コンソールの回の画面で変えてください（Day1 が始まったあとは、Day1 と枠の種類は変えられません）。",
  stage_grant_via_rpc:
    "段階の回の受講者への一時追加は、この画面からはできません。新しい管理コンソール（または講師の画面）から追加してください。",
  stage_grant_not_deletable:
    "段階の回の一時追加は記録として残すため、削除できません。追加を無効にするときは新しい管理コンソールの「取り消す」を、受講者を外すときは名簿の「停止」を使ってください。",
  grant_target_not_in_cohort: "追加できるのは、担当する回の有効な受講者だけです。",
  grant_instructor_limit_exceeded: "講師が追加できる上限を超えています。",
  job_transition_not_allowed: "ジョブの状態を、この向きには変えられません。",
  stage_input_invalid: "入力の内容を受け付けられませんでした。値を確かめてください。",
};

/** 講師の追加の上限を超えたときの、どの上限かの呼び名（detail の scope。DB の値の名前が違っても、文は崩れない） */
const INSTRUCTOR_LIMIT_SCOPES = {
  per_grant: "1 回の追加",
  grant: "1 回の追加",
  per_student_stage: "1 人・1 段階への追加の合計",
  student_stage: "1 人・1 段階への追加の合計",
  per_cohort_day: "1 回の授業（回・1 日）への追加の合計",
  cohort_day: "1 回の授業（回・1 日）への追加の合計",
};

/** 拒否の名前（message が小文字・数字・下線だけの名前そのもののとき）。そうでなければ "" */
export function rejectionName(error) {
  const m = String(error?.message ?? "").trim();
  return /^[a-z][a-z0-9_]*$/.test(m) ? m : "";
}

function parseErrorDetail(error) {
  try {
    const d = JSON.parse(error?.details ?? error?.detail ?? "{}");
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

/** 016 の拒否の名前に対する、hint が無いときの文。名前が一致しなければ null */
export function stageRejectionText(error) {
  const name = rejectionName(error);
  if (!name || !Object.hasOwn(STAGE_REJECTIONS, name)) return null;
  if (name === "stage_input_invalid") {
    const field = parseErrorDetail(error).field;
    if (typeof field === "string" && field) return `入力の内容を受け付けられませんでした（${field}）。値を確かめてください。`;
  }
  if (name === "grant_instructor_limit_exceeded") {
    const d = parseErrorDetail(error);
    const known = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
    if (known(d.limit)) {
      const parts = [];
      if (known(d.current)) parts.push(`これまで ${formatCredits(d.current)}`);
      if (known(d.request)) parts.push(`今回 ${formatCredits(d.request)}`);
      const scope = INSTRUCTOR_LIMIT_SCOPES[d.scope] ?? "講師の追加";
      return `${scope}の上限は ${formatCredits(d.limit)} クレジットです${parts.length ? `（${parts.join("、")}）` : ""}。`;
    }
  }
  return STAGE_REJECTIONS[name];
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
    // 016 の DB（画面が 016 を当たっていると知っている、または detail の credit_mode が stage）で、DB が日本語の hint を付けたときは、
    // DB の説明を出す。016 の前の DB では、今までの文のまま（本番の表示を変えない）
    const hint = String(error.hint ?? "");
    const stageMode = parseErrorDetail(error).credit_mode === "stage";
    if ((stageDbReady || stageMode) && /[^\x00-\x7F]/.test(hint)) return hint;
    if (stageMode) {
      return "今の段階が無いため、クレジットを追加できません（段階の回は、Day1〜Day2 の期間内で、その日の段階があるときだけ追加できます）。";
    }
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
    // 段階の回（scope が cohort）：上限は「今の枠」ではなく「この回での合計」。取り消した追加も数える。
    // detail に email があれば（まとめての追加で誰が超えたかが分かる）、その人の名前の代わりに入れる
    if (d.scope === "cohort") {
      const who = typeof d.email === "string" && d.email ? `${d.email} ` : "この人";
      const detail = parts.length ? `${parts.join("、")}（取り消した追加も数えます）。` : "取り消した追加も数えます。";
      return `${who}への追加は、この回の合計で ${formatCredits(limit)} クレジットまでです。${detail}`;
    }
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
  // 42501 の instructor_only は、DB が日本語の hint を付けていれば、それを出す（admin_only は上で今のまま）
  if (rejectionName(error) === "instructor_only" && /[^\x00-\x7F]/.test(String(error.hint ?? ""))) return String(error.hint);
  // 016 の拒否（名前だけの message。42501 の instructor_only は hint が日本語でも上で出さないので、ここで文にする）
  const stageText = stageRejectionText(error);
  if (stageText) return stageText;
  // DB の更新がまだ適用されていない：関数・テーブル・列が見つからない（段階は 016、設定は 014、回と会場は 013）
  if (isStageSchemaMissing(error)) return MSG_STAGE_NOT_READY;
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
  if (isMonthlyRole(row.role)) {
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
  return isWindowRole(row.role) && row.current_base_credits !== null &&
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
  if (isMonthlyRole(row.role)) return "月額制";
  if (row.role !== "student") return "対象外";
  if (!row.day1_date && !row.day2_date) return "未設定";
  return `${formatMonthDay(row.day1_date)} / ${formatMonthDay(row.day2_date)}`;
}

// ---- 名簿の表示（今の枠・要対応・絞り込み） ----

/** 区分の短い表示名（バッジ・絞り込み） */
export const ROLE_SHORT_LABELS = { student: "受講者", member: "メンバー", instructor: "講師", admin: "管理者" };

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
  if (!isWindowRole(row?.role)) {
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

/** 名簿の絞り込みの選択肢。講師がいるときだけ「講師」を足す（016 の前の DB には講師がいない） */
export function rosterFilters(rows) {
  const list = [...ROSTER_FILTERS];
  if ((rows ?? []).some((r) => r?.role === "instructor")) {
    list.splice(list.findIndex((f) => f.id === "admin"), 0, { id: "instructor", label: "講師" });
  }
  return list;
}

export function matchesFilter(row, filter) {
  switch (filter) {
    case "needs":
      return needsAttention(row);
    case "student":
    case "member":
    case "instructor":
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
  {
    // 015（区分ごとのモデルの制限）で足された項目。null は「上限なし」（環境変数の既定は無い）。古いサーバーには列が無いので、行に無ければ出さない
    key: "job_max_credits",
    label: "1 回の生成の上限（クレジット）",
    min: 1,
    max: 10000,
    integer: true,
    usd: false,
    credits: true,
    optional: true,
    emptyIsNull: true,
    nullText: "上限なし",
    resetLabel: "上限なしに戻す",
    confirm: true,
    desc: "すべての人（管理者を含む）の 1 回の生成に効きます。講師・メンバーの通常の生成（例：Seedance 2.0 の 1080p・15 秒は約 1,023 クレジット）が止まらない値にしてください。空欄で保存すると「上限なし」になります。",
  },
  // 016（セミナーの段階）で足された 4 項目。null は既定の値（defaultValue。DB の stage_grant_limits と同じ。講師の 3 つは仮の値）。
  // 古いサーバー（016 の前）には列が無いので、行に無ければ出さない
  ...[
    {
      key: "stage_grant_total_limit",
      label: "段階の回：1 人あたりの追加の合計",
      max: 50000,
      defaultValue: 10000,
      desc: "段階の回の受講者 1 人につき、その回で追加できるクレジットの合計です。講師の追加も含み、取り消した追加も数えます。",
    },
    {
      key: "instructor_grant_max_credits",
      label: "講師：1 回の追加の上限",
      max: 10000,
      defaultValue: 300,
      desc: "講師が 1 回の操作で、1 人に追加できるクレジットです。0 にすると、講師は追加できません。",
    },
    {
      key: "instructor_grant_max_per_student_stage",
      label: "講師：1 人・1 段階への追加の合計",
      max: 50000,
      defaultValue: 600,
      desc: "講師が、1 人に対して 1 つの段階で追加できるクレジットの合計です（取り消した追加も数えます）。",
    },
    {
      key: "instructor_grant_max_per_cohort_day",
      label: "講師：1 回の授業への追加の合計",
      max: 100000,
      defaultValue: 3000,
      desc: "講師が、1 つの回の 1 日（日本時間）で追加できるクレジットの合計です（取り消した追加も数えます）。",
    },
  ].map((s) => ({
    min: 0,
    integer: true,
    usd: false,
    credits: true,
    optional: true,
    confirm: false,
    nullText: `既定（${formatCredits(s.defaultValue)} クレジット）`,
    resetLabel: "既定に戻す",
    ...s,
  })),
  // 017（口パク）で足された項目。null は既定の 60 秒（DB の既定と同じ）。列が無い 017 の前の DB では、行に無いので出さない
  {
    key: "lipsync_max_audio_seconds",
    label: "口パクの音声の長さの上限",
    min: 6,
    max: 900,
    defaultValue: 60,
    integer: true,
    usd: false,
    unit: "秒",
    optional: true,
    emptyIsNull: true,
    nullText: "既定（60 秒）",
    resetLabel: "既定に戻す",
    confirm: false,
    desc: "口パクの動画に使える音声の長さ（秒）です。これより長い音声は、次の生成から断られます。空欄で保存すると既定の 60 秒になります。",
  },
];

/** 画面に出す上限の項目（optional の項目は、サーバーの設定の行にその列があるときだけ） */
export function availableLimits(row) {
  return SETTING_LIMITS.filter((s) => !s.optional || (row && Object.hasOwn(row, s.key)));
}

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
  const spec = settingSpec(key);
  if (value === null || value === undefined) return spec?.nullText ?? DEFAULT_SETTING_TEXT;
  if (spec?.usd) return formatUsdShort(value);
  if (spec?.unit) return `${formatCredits(value)} ${spec.unit}`;
  return spec?.credits ? `${formatCredits(value)} クレジット` : `${formatCredits(value)} 回`;
}

/** 範囲の表示「1〜1,000 回」「$10〜$5,000」 */
export function settingRangeText(key) {
  const s = settingSpec(key);
  if (!s) return "";
  if (s.usd) return `${formatUsdShort(s.min)}〜${formatUsdShort(s.max)}`;
  return `${formatCredits(s.min)}〜${formatCredits(s.max)} ${s.unit ?? (s.credits ? "クレジット" : "回")}`;
}

/** 値の出どころ（DB に値があるか、既定〔環境変数〕か） */
export function settingSource(value, key = "") {
  const nullLabel = settingSpec(key)?.nullText ?? "既定";
  return value === null || value === undefined ? { kind: "default", label: nullLabel } : { kind: "db", label: "DB の値" };
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
    .replace(/[,，\s$＄]|回|秒|ドル|USD|クレジット/gi, "");
  // 空欄が「上限なし」の項目は、空欄をそのまま null（上限なし）にする
  if (s === "" && spec.emptyIsNull) return { value: null };
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
  if (key === "job_max_credits") {
    // 値を入れる・下げるとき、上限をなくすときは確認する（超える依頼が全員で止まる）
    if (next === null || next === undefined) {
      return { confirm: true, warnings, note: "1 回の生成の上限がなくなります（高い生成も受け付けるようになります）。" };
    }
    const lowering = current === null || current === undefined || next < Number(current);
    return {
      confirm: lowering,
      warnings,
      note: `目安が ${formatCredits(next)} クレジットを超える生成（長い動画・高い解像度）は、管理者を含む全員が受け付けられなくなります。`,
    };
  }
  if (key === "lipsync_max_audio_seconds") {
    // 017：下げるとき（今が既定のときは既定の 60 秒と比べる）だけ確認する。保存済みの生成は変わらない
    const effective = current === null || current === undefined ? settingSpec(key).defaultValue : Number(current);
    const lowering = next === null || next === undefined ? settingSpec(key).defaultValue < effective : next < effective;
    return {
      confirm: lowering,
      warnings,
      note: `${next === null || next === undefined ? settingSpec(key).defaultValue : formatCredits(next)} 秒より長い音声の口パクは、次の生成から断られます。`,
    };
  }
  if (settingSpec(key)?.defaultValue !== undefined) {
    // 016 の 4 項目：下げるとき（今が既定のときは既定の値と比べる）だけ確認する。追加済みの分は変わらない
    const effective = current === null || current === undefined ? settingSpec(key).defaultValue : Number(current);
    const lowering = next === null || next === undefined ? false : next < effective;
    return {
      confirm: lowering,
      warnings,
      note: "すでに追加した分は変わりません。下げると、この値を超える追加は、次の操作から断られます。",
    };
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
export function rebaseModelDraft(oldModels, newModels, draft, scope = "all") {
  const { on, off } = modelChanges(oldModels, scopeSelection(oldModels, scope), draft);
  const next = scopeSelection(newModels, scope);
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
export const MODEL_KIND_LABELS = { video: "動画", image: "画像", speech: "読み上げ", music: "音楽", lipsync: "口パク動画" };

/** admin-api の models を種類ごとにまとめる（動画・画像・読み上げ・音楽・口パク動画の順。知らない種類は後ろ） */
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
 * お知らせ（トースト）があふれたとき、消すものの位置（古い順の kinds に対する添字の昇順）。
 * まず成功・お知らせ（"ok"）を古い順に消し、エラー・警告は残す。"ok" が無くなってもあふれるときだけ、古いエラー・警告を消す
 * @param {string[]} kinds 古い順の種類（"ok"・"error"・"warn"）
 * @param {number} max 残す最大の件数
 * @returns {number[]}
 */
export function toastOverflow(kinds, max) {
  const drop = [];
  let over = kinds.length - max;
  for (let i = 0; i < kinds.length && over > 0; i++) {
    if (kinds[i] === "ok") {
      drop.push(i);
      over--;
    }
  }
  for (let i = 0; i < kinds.length && over > 0; i++) {
    if (kinds[i] !== "ok") {
      drop.push(i);
      over--;
    }
  }
  return drop.sort((a, b) => a - b);
}

/**
 * モデルの一括スイッチの状態。lockedFn(mode) が true のモード（サーバー側で無効）は数えない。
 * 切り替えられるモードがすべてオン→"on"、すべてオフ→"off"、一部だけ→"mixed"、切り替えられるモードが無い→"locked"
 * @param {any[] | undefined} modes
 * @param {Set<string>} draft
 * @param {(mode: any) => boolean} [lockedFn]
 */
export function masterState(modes, draft, lockedFn = () => false) {
  const free = (modes ?? []).filter((mode) => !lockedFn(mode));
  if (free.length === 0) return "locked";
  const onCount = free.filter((mode) => draft.has(mode.model_id)).length;
  if (onCount === free.length) return "on";
  return onCount === 0 ? "off" : "mixed";
}

/**
 * 一括スイッチを押したあとの draft（新しい Set。元の draft は変えない）。
 * "on" なら切り替えられるモードをすべてオフ、"off"・"mixed" ならすべてオン。locked のモードと切り替えられるモードが無いときは変えない
 * @param {any[]} modes
 * @param {Set<string>} draft
 * @param {(mode: any) => boolean} [lockedFn]
 */
export function applyMaster(modes, draft, lockedFn = () => false) {
  const next = new Set(draft);
  const state = masterState(modes, draft, lockedFn);
  if (state === "locked") return next;
  for (const mode of modes) {
    if (lockedFn(mode)) continue;
    if (state === "on") next.delete(mode.model_id);
    else next.add(mode.model_id);
  }
  return next;
}

// ---- モデルの設定の区分（全体・受講者・AIKENメンバー。DB の 015 role_models）----

/** 区分のタブ。field は admin_update_settings・admin_get_settings の列名（全体は enabled_models） */
export const MODEL_SCOPES = [
  { key: "all", label: "全体", field: "enabled_models" },
  { key: "student", label: "受講者", field: "enabled_models_student" },
  { key: "member", label: "AIKENメンバー", field: "enabled_models_member" },
];

/** GET /models の応答が区分の一覧（role_enabled_models）を持つか（015 より前の admin-api は持たない） */
export function rolesSupported(body) {
  const r = body?.role_enabled_models;
  return !!r && typeof r === "object" && "student" in r && "member" in r;
}

/** 区分のタブを出せるか：admin-api が区分の一覧を返し、設定の行（admin_get_settings）にも列がある（行がまだ無いときは前者だけで判断） */
export function rolesAvailable(body, row) {
  return rolesSupported(body) && (!row || Object.hasOwn(row, "enabled_models_student"));
}

/** 出す区分（区分のタブが無いときは全体だけ） */
export function activeScopes(roles) {
  return MODEL_SCOPES.filter((s) => s.key === "all" || roles);
}

/** サーバーに保存されている一覧（null は制限なし）。全体は console_enabled_models、区分は role_enabled_models */
export function scopeList(body, scope) {
  return (scope === "all" ? body?.console_enabled_models : body?.role_enabled_models?.[scope]) ?? null;
}

/** 今のカタログに無い ID（効果は無い。次の保存で外す） */
export function unknownList(body, scope) {
  return (scope === "all" ? body?.unknown_console_models : body?.unknown_role_models?.[scope]) ?? [];
}

/** 読み込んだ時点で、その区分の一覧でオンのモード（admin-api の console_enabled・role_enabled。一覧が null なら全部オン） */
export function modeBaseOn(mode, scope) {
  return scope === "all" ? !!mode.console_enabled : mode.role_enabled?.[scope] !== false;
}

/** その区分の、読み込んだ時点のオンの model_id の集合（下書きの基準。区分の一覧が null ならカタログのすべて） */
export function scopeSelection(models, scope = "all") {
  return new Set(catalogModes(models).filter(({ mode }) => modeBaseOn(mode, scope)).map(({ mode }) => mode.model_id));
}

/**
 * 区分のタブでの 1 つのモードの状態（modeStatus に「全体でオフ」を足したもの）。
 * allDraft は全体のタブの下書き。区分のタブでは、サーバー側で無効・全体でオフのモードは押せない
 */
export function scopeModeStatus(model, mode, on, scope, allDraft) {
  const st = modeStatus(model, mode, on);
  if (st.locked || scope === "all") return st;
  if (!allDraft.has(mode.model_id)) return { kind: "global_off", text: "全体でオフ", locked: true };
  return st;
}

/** その区分が今使えるモードの数（環境変数で許可・提供元が使える・その区分でオン・区分のタブでは全体でもオン） */
export function scopeUsable(models, scope, drafts) {
  return catalogModes(models).filter(({ model, mode }) =>
    mode.env_allowed && model.provider_available && drafts[scope].has(mode.model_id) && (scope === "all" || drafts.all.has(mode.model_id))
  ).length;
}

/** 全体のタブに出す 1 行：区分の一覧が設定されている（null でない）ときだけ。なければ null */
export function roleListNotice(body) {
  if (!rolesSupported(body)) return null;
  const set = MODEL_SCOPES.filter((s) => s.key !== "all" && scopeList(body, s.key) !== null).map((s) => s.label);
  if (set.length === 0) return null;
  if (set.length === 1) return `${set[0]}の一覧が設定されています。全体でオンにしても、${set[0]}のタブでオンにしないと${set[0]}は使えません。`;
  return `${set.join("・")}の一覧が設定されています。全体でオンにしても、それぞれのタブでオンにしないとその区分は使えません。`;
}

/**
 * 保存の計画。変えたタブ（未保存の変更がある、または今のカタログに無い ID を外す）の分だけを changes にまとめる。
 * drafts は { all, student, member } の Set。roles が false のときは全体だけ。
 * resets は「制限なしに戻す」を押した区分（{ student: true }）。約束（画面の側で resets を管理するときの前提。テストで固定している）：
 *   ・印がある区分は、下書きの中身に関係なく、payload を null（制限なし）にして保存の対象にする（下書きが今と同じでも、一部オフでも同じ）。
 *   ・印は、保存されている一覧が明示（配列）の区分でだけ効く。保存されている一覧が null の区分には効かない。
 *   ・resets.all も同じ。全体の保存されている一覧（console_enabled_models）が明示のときだけ効き、全体は resets.all で enabled_models を null にできる。
 *   ・roles が false のとき、区分の印は見ない（全体の印だけ見る）。
 *   ・印がある区分の件数は、下書きの変更が無くても 1 件と数える（変更があればその数）。
 * 返り値：{ changes: { 列名: 配列か null }, entries: [{ key, label, field, payload, on, off, count, unknown, empty }], emptied: [{ key, label }], counts: { all, student, member }, count, roles }
 */
export function buildModelSave(body, drafts, roles = true, resets = {}) {
  const models = body?.models ?? [];
  const entries = [];
  const counts = { all: 0, student: 0, member: 0 };
  for (const sc of activeScopes(roles)) {
    const ch = modelChanges(models, scopeSelection(models, sc.key), drafts[sc.key]);
    // 「制限なしに戻す」を押した区分（保存されている一覧が明示のときだけ有効）：下書きが今と同じ（全部オンに見える）でも null で保存する
    const reset = !!resets[sc.key] && Array.isArray(scopeList(body, sc.key));
    counts[sc.key] = reset && ch.count === 0 ? 1 : ch.count;
    const unknown = unknownList(body, sc.key);
    if (ch.count === 0 && unknown.length === 0 && !reset) continue;
    // 今のカタログに無い ID を外すだけ（オン・オフは変えていない）のときは、null にまとめない。
    // 明示の一覧がカタログのすべてを含んでいても、「これから足すモデルも使える」には変えず、外した一覧のまま保存する
    const saved = scopeList(body, sc.key);
    const payload = reset
      ? null
      : ch.count === 0 && Array.isArray(saved)
      ? catalogModes(models).map(({ mode }) => mode.model_id).filter((id) => saved.includes(id))
      : enabledModelsPayload(models, drafts[sc.key]);
    entries.push({
      key: sc.key,
      label: sc.label,
      field: sc.field,
      payload,
      on: ch.on,
      off: ch.off,
      count: ch.count,
      unknown,
      empty: false, // 下の emptied で決める
    });
  }
  // 保存で使えるモデルが 0 になる区分（変えていない区分も含む。全体のタブの変更で受講者・メンバーが 0 になる場合など）。
  // 保存前（読み込んだときの基準）に 1 つ以上使えて、保存後（drafts）に 0 になるものだけ。保存前から 0 の区分は含めない
  const base = { all: scopeSelection(models, "all"), student: scopeSelection(models, "student"), member: scopeSelection(models, "member") };
  const emptied = activeScopes(roles)
    .filter((sc) => scopeUsable(models, sc.key, base) > 0 && scopeUsable(models, sc.key, drafts) === 0)
    .map((sc) => ({ key: sc.key, label: sc.label }));
  for (const e of entries) e.empty = emptied.some((x) => x.key === e.key);
  return {
    emptied,
    changes: Object.fromEntries(entries.map((e) => [e.field, e.payload])),
    entries,
    counts,
    count: counts.all + counts.student + counts.member,
    roles,
  };
}

/**
 * 読み直しのとき、「制限なしに戻す」の印（resets）を残すか消すか。
 * 残す（keep）：その区分の保存されている一覧が、読み直しの前後でどちらも明示（配列）で、同じ ID の集合のとき（押した人の意図は変わっていない）。
 * 消す（lost）：一覧が変わった（ほかの管理者が変えた）・もう明示でない（null になった）とき。消すときは、下書きも基準に戻すこと。
 * 返り値：{ keep: [区分の key], lost: [区分の key] }（印のある区分だけ）
 */
export function resetCarry(prevBody, nextBody, resets = {}) {
  const keep = [];
  const lost = [];
  for (const sc of MODEL_SCOPES) {
    if (!resets?.[sc.key]) continue;
    const a = scopeList(prevBody, sc.key);
    const b = scopeList(nextBody, sc.key);
    if (Array.isArray(a) && Array.isArray(b) && sameIdSet(a, b)) keep.push(sc.key);
    else lost.push(sc.key);
  }
  return { keep, lost };
}

/**
 * 「制限なしに戻す」を押したあとの区分の下書き：読み込んだときの基準（scopeSelection）に、押せるモード
 * （サーバー側で無効でない・全体の下書き allDraft でもオン）をすべてオンにしたもの。押せないモードは基準のまま（件数・確認の文に入れない）。
 * 保存する値は null（制限なし）で、下書きの中身には依らない（buildModelSave の resets）
 */
export function restoreNullDraft(models, scope, allDraft) {
  const next = scopeSelection(models, scope);
  for (const { model, mode } of catalogModes(models)) {
    if (!scopeModeStatus(model, mode, false, scope, allDraft).locked) next.add(mode.model_id);
  }
  return next;
}

/**
 * 画面・件数・確認の文・保存の計画に使う下書き。「制限なしに戻す」の印がある区分（保存されている一覧が明示のとき）は、
 * 保存して持った下書きではなく、使うたびに restoreNullDraft(基準, 区分, 今の全体の下書き) で作る（全体のタブで何を変えても食い違わない）。
 * 印の無い区分は、持っている下書きのまま。返すのは新しいオブジェクト（元の drafts は変えない）
 */
export function effectiveDrafts(body, drafts, resets = {}) {
  const out = { ...drafts };
  for (const sc of MODEL_SCOPES) {
    if (sc.key === "all" || !resets?.[sc.key] || !Array.isArray(scopeList(body, sc.key))) continue;
    out[sc.key] = restoreNullDraft(body.models, sc.key, drafts.all);
  }
  return out;
}

/** 保存の確認の文（タブごとに、オン・オフにするもの）。labelOf は model_id → 表示名 */
export function saveConfirmLines(plan, labelOf = (id) => id) {
  const lines = ["モデルの設定を保存しますか？"];
  for (const e of plan.entries) {
    if (plan.roles) lines.push(`【${e.label}】`); // 区分のタブが無い（古いサーバー）ときは見出しを出さない
    if (e.on.length) lines.push(`・オンにする：${listText(e.on.map(labelOf), 6)}`);
    if (e.off.length) lines.push(`・オフにする：${listText(e.off.map(labelOf), 6)}`);
    if (e.unknown.length) lines.push(`・今のカタログに無い ID ${e.unknown.length} 件を外します。`);
    if (e.payload === null) {
      lines.push(
        e.key === "all"
          ? "・すべてオンのため「制限なし」（サーバーで許可されたモデルすべて）として保存します。"
          : `・${e.label}は制限なし（全体と同じ。これから足すモデルも使える）として保存します。`,
      );
    }
  }
  lines.push("（次の生成から、すぐに効きます）");
  return lines;
}

/** 一覧が空になる（その区分の全員が生成できなくなる）ときの追加の確認の文。なければ [] */
export function emptyScopeWarnings(plan) {
  const emptied = plan.emptied ?? [];
  // 全体で使えるモデルが 0 になるときは、区分も必ず 0 になる。確認は全体の 1 件だけにする（誰も生成できなくなる、で足りる）
  if (emptied.some((e) => e.key === "all")) return ["すべてのモデルがオフになり、誰も生成できなくなります。本当に保存しますか？"];
  return emptied.map((e) => `${e.label}はどのモデルも使えなくなり、生成できなくなります。本当に保存しますか？`);
}

/**
 * 保存の直前に読み直した設定の行（admin_get_settings の settings）が、読み込んだときの一覧と違う区分。
 * 3 つの一覧（roles が false なら全体だけ）のどれかが変わっていたら、その区分の名前の配列を返す（空なら変わっていない）
 */
export function changedScopes(row, body, roles = true) {
  return activeScopes(roles).filter((sc) => !sameIdSet(row?.[sc.field] ?? null, scopeList(body, sc.key))).map((sc) => sc.label);
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
  for (const sc of MODEL_SCOPES) {
    if (sc.key === "all") continue;
    const b = created ? null : (before[sc.field] ?? null);
    const a = after?.[sc.field] ?? null;
    if (sameIdSet(b, a)) continue;
    const name = `${sc.label}のモデル`;
    if (a === null) lines.push(`${name}：制限なし（全体と同じ）に戻す`);
    else if (a.length === 0) lines.push(`${name}：すべてオフ`);
    else if (b === null) lines.push(`${name}：${a.length} 件だけを有効に（${listText(a.map(labelOf))}）`);
    else {
      const on = a.filter((id) => !b.includes(id));
      const off = b.filter((id) => !a.includes(id));
      const parts = [];
      if (on.length) parts.push(`オン ${on.length} 件（${listText(on.map(labelOf))}）`);
      if (off.length) parts.push(`オフ ${off.length} 件（${listText(off.map(labelOf))}）`);
      lines.push(`${name}：${parts.join("・")}`);
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
