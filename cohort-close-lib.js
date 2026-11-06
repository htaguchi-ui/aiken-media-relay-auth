// 回のクローズの表示と確認。対象者・権限・期限・冪等性の最終判定は DB の RPC が行う。
import { formatShortDateTime, isNetworkFailure, MSG_NETWORK_FAILURE } from "./admin-lib.js";
import { MSG_UPDATE_RESULT_UNKNOWN } from "./stage-lib.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v) => typeof v === "string" && v.trim() ? v : null;
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const timestamp = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
const nullable = (v, check) => v === null || check(v) !== null;

/** 回の停止は同じ本人の同じログインだけ。SID欠損を同一ログインと推定しない。 */
export function cohortCloseSameIdentity(a, b) {
  return !!(text(a?.userId) && text(a?.sessionId) && text(b?.userId) && text(b?.sessionId)
    && a.userId === b.userId && a.sessionId === b.sessionId);
}

/** 欠損・不正を0人や14日で補わない。unknownは操作不可。 */
export function normalizeCohortCloseStatus(raw, expectedId, receivedAt = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !text(raw.cohort_id) || raw.cohort_id !== expectedId) return null;
  if (!["open", "closed"].includes(raw.state) || typeof raw.can_close !== "boolean" || typeof raw.can_reopen !== "boolean") return null;
  if (count(raw.target_count) === null || count(raw.already_disabled_count) === null) return null;
  if (count(raw.irreversible_count) === null || count(raw.reopen_excluded_count) === null) return null;
  if (!Number.isInteger(raw.retention_days) || raw.retention_days < 1 || raw.retention_days > 3650 || !timestamp(raw.server_now)) return null;
  if (!nullable(raw.closed_at, timestamp) || !nullable(raw.closed_by_email, text) || !nullable(raw.reopen_until, timestamp) || !nullable(raw.purge_at, timestamp)) return null;
  if (!(raw.cycle_id === null || typeof raw.cycle_id === "string" && UUID.test(raw.cycle_id))) return null;
  if (!(raw.reason === null || text(raw.reason)) || !text(raw.preview_token) || raw.preview_token.length > 4096) return null;
  if (raw.state === "closed" && (!raw.closed_at || !raw.cycle_id || !raw.reopen_until)) return null;
  // Closed candidates may have no deletion clock (never-login only, or all
  // excluded). A nonzero roster count does not imply stored content. Open
  // previews still promise a projected clock for a nonempty stopping set.
  if (raw.purge_at === null && raw.state === "open" && raw.target_count > 0) return null;
  if (raw.can_close && (raw.state !== "open" || !raw.last_stage || !text(raw.last_stage.id))) return null;
  if (raw.can_reopen && raw.state !== "closed" || raw.can_close && raw.can_reopen) return null;
  return {
    cohortId: raw.cohort_id,
    state: raw.state,
    canClose: raw.can_close,
    canReopen: raw.can_reopen,
    reason: raw.reason,
    targetCount: raw.target_count,
    alreadyDisabledCount: raw.already_disabled_count,
    irreversibleCount: raw.irreversible_count,
    reopenExcludedCount: raw.reopen_excluded_count,
    closedAt: raw.closed_at,
    closedBy: raw.closed_by_email,
    cycleId: raw.cycle_id,
    reopenUntil: raw.reopen_until,
    purgeAt: raw.purge_at,
    retentionDays: raw.retention_days,
    serverNow: raw.server_now,
    clockOffset: Date.parse(raw.server_now) - receivedAt,
    lastStage: raw.last_stage && typeof raw.last_stage === "object" ? {
      id: text(raw.last_stage.id), label: text(raw.last_stage.label), title: text(raw.last_stage.title),
    } : null,
    previewToken: raw.preview_token,
  };
}

/** admin一括読取は表示専用。操作可否や人数をここから推定しない。 */
export function normalizeCohortCloseSummaries(raw) {
  if (!Array.isArray(raw)) return null;
  const result = new Map();
  for (const r of raw) {
    if (!r || !text(r.cohort_id) || !["open", "closed"].includes(r.state) || result.has(r.cohort_id)) return null;
    if (!nullable(r.closed_at, timestamp) || !nullable(r.closed_by_email, text) || !nullable(r.reopen_until, timestamp)) return null;
    if (!(r.cycle_id === null || typeof r.cycle_id === "string" && UUID.test(r.cycle_id))) return null;
    if (r.state === "closed" && (!r.closed_at || !r.cycle_id || !r.reopen_until)) return null;
    result.set(r.cohort_id, { cohortId: r.cohort_id, state: r.state, closedAt: r.closed_at, closedBy: r.closed_by_email, cycleId: r.cycle_id, reopenUntil: r.reopen_until });
  }
  return result;
}

const REASONS = {
  not_stage_cohort: "段階のない回はクローズできません。",
  day2_not_reached: "Day2 の最後の段階に入ってからクローズしてください。",
  final_stage_not_reached: "最後の段階に進めてからクローズしてください。",
  already_closed: "この回はクローズ済みです。",
  reopen_expired: "再開の期限を過ぎました。削除した内容は戻せません。",
  content_deleted: "削除が始まった回は再開できません。",
  retention_unavailable: "保存設定を取得できません。",
};
/**
 * 最後の段階に進めないまま Day2 が終わった回（final_stage_not_reached で、期間が Day2 のあと）。Day2 のあとは段階を動かせないので、
 * 講師には直せない（E-INS-55）。2 行目は講師の画面だけ（管理コンソールでは出さない：管理者に「管理者に」と言わない）
 */
const MSG_FINAL_AFTER = "最後の段階に進む前に Day2 が終了しました。";
const MSG_FINAL_AFTER_NEXT = "管理者にお知らせください。";
/** 札の理由のエラーコード（決まり 3.2。文と別の値） */
const REASON_CODES = { retention_unavailable: "E-INS-52" };

/**
 * 札の理由（押せない理由。前置きは付けない）。period：回の期間（講師ページは state.status.period、管理コンソールは回の行の current_period）。
 * admin：管理コンソールで出すとき true（講師に向けた 2 行目を出さない）
 */
export function cohortCloseReason(reason, { period = null, admin = false } = {}) {
  if (reason === "final_stage_not_reached" && period === "after") return admin ? MSG_FINAL_AFTER : `${MSG_FINAL_AFTER}\n${MSG_FINAL_AFTER_NEXT}`;
  return REASONS[reason] ?? "今は操作できません。\n［最新にする］を押してください。";
}

/** 札の理由のエラーコード（無ければ null） */
export function cohortCloseReasonCode(reason, { period = null } = {}) {
  if (reason === "final_stage_not_reached" && period === "after") return "E-INS-55";
  return REASON_CODES[reason] ?? null;
}

/**
 * 講師ページ v2 の「回のクローズ」の札を出すか（設計 docs/design-instructor-page-v2.md 2.6）。
 * 出すのは、Day2 の最後の段階が今のとき・Day2 が終わったあと・クローズ済みのとき・Day2 以降でクローズの状態を読めなかったときだけ。
 * stage：normalizeStageStatus の答え（period・current・stagesToday）。close：normalizeCohortCloseStatus の答えか null
 */
export function cohortCloseSlotVisible(stage, close, closeError = "") {
  if (close?.state === "closed") return true;
  const period = stage?.period;
  if (period === "after") return true;
  if (period !== "day2") return false;
  if (closeError) return true;
  const list = Array.isArray(stage?.stagesToday) ? stage.stagesToday : [];
  const last = list.length ? list[list.length - 1] : null;
  return !!(last && stage.current && stage.current.id === last.id);
}

export function cohortCloseCanAct(status, kind, now = Date.now()) {
  if (!status) return false;
  if (kind === "close") return status.state === "open" && status.canClose;
  if (kind !== "reopen" || status.state !== "closed" || !status.canReopen || !status.reopenUntil) return false;
  return Number.isFinite(now) && now + status.clockOffset < Date.parse(status.reopenUntil);
}

/**
 * 札の行（{ text, tip, code }）。tip はその行のホバーの文（無ければ null）、code はエラーコード（無ければ null。決まり 3.2）。
 * opts：cohortCloseReason と同じ（period・admin）
 */
export function cohortCloseLineItems(status, now = Date.now(), opts = {}) {
  const item = (text, tip = null, code = null) => ({ text, tip, code });
  if (!status) return [item("読み込み中…")];
  if (status.state === "closed") {
    const reason = status.reason ?? "reopen_expired";
    return [
      item(`クローズ：${formatShortDateTime(status.closedAt)}${status.closedBy ? `（${status.closedBy}）` : ""}`),
      item(
        `再開で戻せる受講者：${status.targetCount} 人（対象外 ${status.reopenExcludedCount} 人）`,
        "クローズのあとに個別に設定を変えた人などは、再開しても戻しません。",
      ),
      status.purgeAt
        ? item(`削除予定：${formatShortDateTime(status.purgeAt)} 以降（停止から ${status.retentionDays} 日後）`)
        : item("再開で戻せる受講者の削除予定はありません。", "対象外の人の保存期限は変わりません。"),
      cohortCloseCanAct(status, "reopen", now)
        ? item(`${formatShortDateTime(status.reopenUntil)} まで再開できます。`, "削除が始まると、期限の前でも再開できません。")
        : item(cohortCloseReason(reason, opts), null, cohortCloseReasonCode(reason, opts)),
    ];
  }
  if (!status.canClose) return [item(cohortCloseReason(status.reason, opts), null, cohortCloseReasonCode(status.reason, opts))];
  return [item(`クローズすると受講者 ${status.targetCount} 人の利用を停止します。`)];
}

/** 札の行の文だけ（管理コンソールの札・試験が使う） */
export function cohortCloseLines(status, now = Date.now(), opts = {}) {
  return cohortCloseLineItems(status, now, opts).map((i) => i.text);
}

/** 確認の窓の文：{ title, okText, lines（本文は結果だけ）, help（窓の ？ の中の文。無ければ省く）, danger } */
export function cohortCloseConfirmation(status, kind) {
  if (kind === "reopen") return {
    title: `${status.cohortId} を再開しますか？`,
    okText: "再開する",
    lines: [`受講者 ${status.targetCount} 人を有効に戻します（対象外 ${status.reopenExcludedCount} 人）。`],
    help: "以前から停止中だった人や、別の回へ移った人などは戻しません。有効に戻した人の、未確定の削除予定だけを取り消します。",
  };
  return {
    title: `${status.cohortId} をクローズしますか？`,
    okText: "クローズする",
    danger: true, // 受講者全員の利用を止める重い操作。確定のボタンを危険の色にする（U3-9。講師の画面の confirmDialog が使う）
    lines: [
      `受講者 ${status.targetCount} 人が Canvas と生成を使えなくなります。`,
      "最後のワークショップの終了後に押してください。",
    ],
    help:
      `提出した作品は 7 日間マイページから保存できます。${
        status.purgeAt ? `Canvas と生成物は ${formatShortDateTime(status.purgeAt)} 以降に削除します。` : "削除予定はありません。"
      }以前から停止中の ${status.alreadyDisabledCount} 人は対象外です。再開はクローズから最長 14 日、削除が始まるまでです。`,
  };
}

/**
 * 操作の断りの文。関数（op を受け取る）は「${op}エラー：」を前に付ける（決まり 2.2.1 の「1 つの関数を通る複数の操作」。op が無いときは付けない）。
 * 50 番台のコードの 2 行目「管理者にお知らせください。」は文に入れず、講師ページの側で足す（管理者に「管理者に」と言わない）
 */
const pre = (op) => (op ? `${op}エラー：` : "");
const failed = (op) => (op ? `${op}エラーが発生しました。` : "エラーが発生しました。");
const ERRORS = {
  cohort_close_changed: (op) => `${pre(op)}回の状態が変わりました。\n内容を確認して、再度お試しください。`,
  cohort_close_busy: (op) => `${pre(op)}ほかの操作と重なりました。\nしばらくしてから再度お試しください。`,
  cohort_finish_unconfirmed: "最後のワークショップが終わったことを確認してください。",
  cohort_reopen_expired: REASONS.reopen_expired,
  cohort_content_deleted: REASONS.content_deleted,
  cohort_closed: "この回はクローズ済みです。",
  cohort_closed_identity_locked: "クローズ済みの回の会場番号・Day1 は変更できません。\n再開できるときは、先に回を再開してください。",
  cohort_close_not_ready: (op) => `${pre(op)}まだ最後の段階に入っていません。\n最後の段階に進めてから、再度お試しください。`,
  retention_settings_missing: (op) => `${pre(op)}${REASONS.retention_unavailable}`,
  cohort_retention_unavailable: (op) => `${pre(op)}${REASONS.retention_unavailable}`,
  cohort_close_state_invalid: (op) => `${pre(op)}記録を確認できません。`,
  instructor_only: "権限エラー：この回の担当ではありません。",
  admin_only: "権限エラー：管理者の権限がありません。\n再度ログインしてください。",
  cohort_close_invalid_response: (op) => `${failed(op)}\n［最新にする］を押してください。`,
};
/** cohort_close_not_ready の detail.reason ごとの文（221_cohort_close.sql:307-308 の detail。表に無い理由は ERRORS の文） */
const NOT_READY = {
  not_stage_cohort: (op) => `${pre(op)}段階のない回は対象外です。`,
  day2_not_reached: (op) => `${pre(op)}Day2 の前です。\nDay2 の最後の段階に入ってから、再度お試しください。`,
  retention_unavailable: (op) => `${pre(op)}${REASONS.retention_unavailable}`,
};
/** 断りのエラーコード（決まり 3.2。文と別の値。無ければ null） */
const ERROR_CODES = {
  retention_settings_missing: "E-INS-52",
  cohort_retention_unavailable: "E-INS-52",
  cohort_close_state_invalid: "E-INS-53",
  instructor_only: "E-LOG-53",
  admin_only: "E-LOG-54",
  cohort_close_invalid_response: "E-INS-01",
};
const isRpcMissing = (error) => ["PGRST202", "42883", "42703"].includes(String(error?.code));
function errorDetail(error) {
  try {
    const d = typeof error?.details === "string" ? JSON.parse(error.details) : error?.details ?? error?.detail ?? null;
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}
/** 断りの理由の名前（ERRORS の鍵）。表に無ければ null */
function errorKey(error) {
  if (Object.hasOwn(ERRORS, String(error?.message ?? ""))) return String(error.message);
  if (Object.hasOwn(ERRORS, String(error?.code ?? ""))) return String(error.code);
  return null;
}

/**
 * 断りの文。op：「クローズ」「再開」「読み込み」（run が kind から、状態の読み込みは「読み込み」を渡す）。
 * period：回の期間（final_stage_not_reached で Day2 のあとなら E-INS-55 の文。講師ページは state.status.period）。
 * phase：通信の失敗のとき、更新の RPC（cohort_close・cohort_reopen）を送ったあと（"update"）か、その前の読み込み（"load"。既定）か。
 * 通信の失敗は前置きを付けず単独（決まり 3.7）：読み込みは接続の文、更新は結果が不明の文
 */
export function cohortCloseError(error, op = "", { period = null, admin = false, phase = "load" } = {}) {
  if (isRpcMissing(error)) return `${pre(op)}この機能は、まだ使えません。`;
  if (isNetworkFailure(error)) return phase === "update" ? MSG_UPDATE_RESULT_UNKNOWN : MSG_NETWORK_FAILURE;
  const key = errorKey(error);
  if (key === "cohort_close_not_ready") {
    const reason = errorDetail(error).reason;
    if (reason === "final_stage_not_reached" && period === "after") return cohortCloseReason(reason, { period, admin });
    if (Object.hasOwn(NOT_READY, reason)) return NOT_READY[reason](op);
  }
  if (key) return typeof ERRORS[key] === "function" ? ERRORS[key](op) : ERRORS[key];
  return `${failed(op)}\n［最新にする］を押してください。`;
}

/** cohortCloseError の文に付けるエラーコード（無ければ null。通信の失敗には付けない〔決まり 3.1・11-04g〕。表に無い理由は E-INS-99） */
export function cohortCloseErrorCode(error, { period = null } = {}) {
  if (isRpcMissing(error)) return "E-INS-54";
  const key = errorKey(error);
  if (key === "cohort_close_not_ready") {
    const reason = errorDetail(error).reason;
    if (reason === "final_stage_not_reached" && period === "after") return "E-INS-55";
    if (reason === "retention_unavailable") return "E-INS-52";
  }
  if (key) return ERROR_CODES[key] ?? null;
  return isNetworkFailure(error) ? null : "E-INS-99";
}

/**
 * 一度の操作は一つの回・本人・プレビューに固定する。確認の前に必ず再取得し、
 * 確認中の回/本人の変更は isCurrent で失効。対象が変わったDB拒否を自動再送しない。
 */
/**
 * 確認の前に読み直した状態で、操作できないときの断りの名前（11-04g）。再開で、もう再開済み（closed でない）は cohort_close_changed、
 * 削除が始まった回は cohort_content_deleted、保存設定を確かめられないときは cohort_retention_unavailable、それ以外の再開は期限切れ
 */
function cannotActReason(status, kind) {
  if (status.reason === "content_deleted") return "cohort_content_deleted";
  if (kind !== "reopen" || status.state !== "closed") return "cohort_close_changed";
  if (status.reason === "retention_unavailable") return "cohort_retention_unavailable";
  return "cohort_reopen_expired";
}

/** errorOpts：cohortCloseError に渡す { period, admin }（講師ページは回の期間。省くと {}） */
export function createCohortCloseAction({ rpc, confirm, onStatus, onSuccess, onError, onBusy, canStart = () => true, errorOpts = () => ({}) }) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(kind, cohortId, isCurrent) {
      if (busy || !["close", "reopen"].includes(kind) || !isCurrent() || !canStart()) return false;
      busy = true;
      onBusy(true);
      // 通信の失敗の文を分ける：確認の前の読み込み（cohort_close_status）は load、更新の RPC を送る直前から update
      let phase = "load";
      try {
        const preview = await rpc("cohort_close_status", { p_cohort_id: cohortId });
        if (!isCurrent()) return false;
        if (preview?.error) throw preview.error;
        const status = normalizeCohortCloseStatus(preview?.data, cohortId);
        if (!status) throw { message: "cohort_close_invalid_response" };
        onStatus(status);
        if (!cohortCloseCanAct(status, kind)) throw { message: cannotActReason(status, kind) };
        const approved = await confirm(cohortCloseConfirmation(status, kind));
        if (!approved || !isCurrent()) return false;
        if (!cohortCloseCanAct(status, kind)) throw { message: "cohort_reopen_expired" };
        phase = "update";
        const result = await rpc(kind === "close" ? "cohort_close" : "cohort_reopen", kind === "close"
          ? { p_cohort_id: cohortId, p_expected_token: status.previewToken, p_confirm_finished: true }
          : { p_cohort_id: cohortId, p_cycle_id: status.cycleId });
        if (!isCurrent()) return false;
        if (result?.error) throw result.error;
        const next = normalizeCohortCloseStatus(result?.data, cohortId);
        if (!next || typeof result.data.changed !== "boolean" || next.state !== (kind === "close" ? "closed" : "open")) throw { message: "cohort_close_invalid_response" };
        if (kind === "reopen" && (count(result.data.restored_count) === null || count(result.data.skipped_count) === null)) throw { message: "cohort_close_invalid_response" };
        onStatus(next);
        await onSuccess(next, result.data, kind, isCurrent);
        return true;
      } catch (error) {
        if (isCurrent()) await onError(cohortCloseError(error, kind === "close" ? "クローズ" : "再開", { ...errorOpts(), phase }), error);
        return false;
      } finally {
        busy = false;
        onBusy(false);
      }
    },
  };
}
