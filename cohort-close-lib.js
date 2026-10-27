// 回のクローズの表示と確認。対象者・権限・期限・冪等性の最終判定は DB の RPC が行う。
import { formatShortDateTime } from "./admin-lib.js";

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
  not_stage_cohort: "段階ごとの枠の回だけクローズできます。",
  day2_not_reached: "Day2 の最後のワークショップが終わってからクローズしてください。",
  final_stage_not_reached: "Day2 の最後の段階に進み、最後のワークショップを終えてからクローズしてください。",
  already_closed: "この回はクローズ済みです。",
  reopen_expired: "開き直せる期限を過ぎました。削除した内容は戻りません。",
  content_deleted: "内容の削除が始まったため、この回は開き直せません。",
  retention_unavailable: "内容の保存と削除の設定を確認できません。管理者に確認してください。",
};
export function cohortCloseReason(reason) {
  return REASONS[reason] ?? "現在はこの操作をできません。最新の状態を確認してください。";
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

export function cohortCloseLines(status, now = Date.now()) {
  if (!status) return ["クローズの状態をまだ確認できていません。"];
  if (status.state === "closed") {
    return [
      `クローズ：${formatShortDateTime(status.closedAt)}${status.closedBy ? `（${status.closedBy}）` : ""}`,
      `有効に戻せる候補：${status.targetCount} 人。個別変更などで戻さない人：${status.reopenExcludedCount} 人。`,
      status.purgeAt ? `最短の削除予定：${formatShortDateTime(status.purgeAt)}以降。失効からの保存期間は ${status.retentionDays} 日です。` : "有効に戻せる候補については、削除予定の内容はありません。戻さない人の保存期限は変更されません。",
      cohortCloseCanAct(status, "reopen", now)
        ? `${formatShortDateTime(status.reopenUntil)}まで、削除が始まる前に開き直せます。`
        : cohortCloseReason(status.reason ?? "reopen_expired"),
    ];
  }
  if (!status.canClose) return [cohortCloseReason(status.reason)];
  return [
    `クローズすると、この回の受講者 ${status.targetCount} 人のアカウントを止めます。`,
    status.purgeAt ? `Canvas と生成物の最短の削除予定：${formatShortDateTime(status.purgeAt)}以降（失効から ${status.retentionDays} 日間保持）。` : "この操作による削除予定はありません。",
    "最後の段階に入っただけでは終了したと判断しません。最後のワークショップが終わったことを確かめてから押してください。",
  ];
}

export function cohortCloseConfirmation(status, kind) {
  if (kind === "reopen") return {
    title: "回を開き直しますか？",
    okText: "開き直す",
    lines: [
      `${status.cohortId} を開き直します。このクローズで停止し、その後に個別変更されていない受講者 ${status.targetCount} 人が有効に戻せる候補です。戻さない人は ${status.reopenExcludedCount} 人です。`,
      "以前から停止中だった人や、別の回へ移った人など、変更されていた人は戻しません。有効に戻した人の、未確定の削除予定だけを取り消します。",
      "すでに削除が始まった場合や期限を過ぎた場合は、開き直せません。",
    ],
  };
  return {
    title: "最後のワークショップを終えて、回をクローズしますか？",
    okText: "終了を確認してクローズ",
    lines: [
      `${status.cohortId} の受講者 ${status.targetCount} 人のアカウントを止めます。失効からの保存期間は ${status.retentionDays} 日です。${status.purgeAt ? `Canvas と生成物の最短の削除予定は ${formatShortDateTime(status.purgeAt)}以降です。` : "この操作による削除予定はありません。"}`,
      `以前から停止中の ${status.alreadyDisabledCount} 人は変更しません。講師・管理者・別の回の受講者も対象外です。`,
      "Day2 の最後のワークショップが終わったことを確認して確定してください。開き直せるのはクローズから最長14日以内、かつ削除が始まる前です。以前の失効や保存期間の設定によって期限が短くなる場合があります。",
    ],
  };
}

const ERRORS = {
  cohort_close_changed: "対象者や回の状態が変わりました。最新の人数と状態を確認して、もう一度操作してください。",
  cohort_close_busy: "ほかの操作と重なりました。少し待って、最新の状態を確認してからもう一度お試しください。",
  cohort_finish_unconfirmed: "最後のワークショップが終わったことを確認してください。",
  cohort_reopen_expired: REASONS.reopen_expired,
  cohort_content_deleted: REASONS.content_deleted,
  cohort_closed: "この回はクローズ済みです。最新の状態を確認してください。",
  cohort_closed_identity_locked: "クローズ済みの回の会場・Day1・IDは変えられません。先に回を開き直してください。",
  cohort_close_not_ready: "まだクローズできません。Day2 の最後の段階と、最後のワークショップの終了を確認してください。",
  retention_settings_missing: REASONS.retention_unavailable,
  cohort_retention_unavailable: REASONS.retention_unavailable,
  cohort_close_state_invalid: "クローズの記録を確認できませんでした。管理者に確認してください。",
  instructor_only: "この回の講師または管理者だけが操作できます。",
  admin_only: "管理者だけが操作できます。",
  cohort_close_invalid_response: "クローズの状態を確認できませんでした。人数や期限が不明なため操作しません。",
};
export function cohortCloseError(error) {
  if (["PGRST202", "42883", "42703"].includes(String(error?.code))) return "回のクローズ機能は、まだ使えません。管理者に確認してください。";
  return ERRORS[error?.message] ?? ERRORS[error?.code] ?? "クローズの操作を完了できませんでした。最新の状態を読み直して確認してください。";
}

/**
 * 一度の操作は一つの回・本人・プレビューに固定する。確認の前に必ず再取得し、
 * 確認中の回/本人の変更は isCurrent で失効。対象が変わったDB拒否を自動再送しない。
 */
export function createCohortCloseAction({ rpc, confirm, onStatus, onSuccess, onError, onBusy, canStart = () => true }) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(kind, cohortId, isCurrent) {
      if (busy || !["close", "reopen"].includes(kind) || !isCurrent() || !canStart()) return false;
      busy = true;
      onBusy(true);
      try {
        const preview = await rpc("cohort_close_status", { p_cohort_id: cohortId });
        if (!isCurrent()) return false;
        if (preview?.error) throw preview.error;
        const status = normalizeCohortCloseStatus(preview?.data, cohortId);
        if (!status) throw { message: "cohort_close_invalid_response" };
        onStatus(status);
        if (!cohortCloseCanAct(status, kind)) throw { message: status.reason === "content_deleted" ? "cohort_content_deleted" : kind === "reopen" ? "cohort_reopen_expired" : "cohort_close_changed" };
        const approved = await confirm(cohortCloseConfirmation(status, kind));
        if (!approved || !isCurrent()) return false;
        if (!cohortCloseCanAct(status, kind)) throw { message: "cohort_reopen_expired" };
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
        if (isCurrent()) await onError(cohortCloseError(error), error);
        return false;
      } finally {
        busy = false;
        onBusy(false);
      }
    },
  };
}
