// 講師ページの「回の一覧」と、回の操作のページの「← 回の一覧」「この回は開けません」の画面の部品（設計 docs/design-instructor-split.md 4.2）。
// 表示はすべて createElement（el は instructor.js から受け取る）と textContent だけ（データを innerHTML に入れない）。
// リンクの href は cohortPath()・LIST_PATH の定数だけで作る（回の ID は符号化する）。書き込みの RPC は 1 つも呼ばない。
import { cohortPath, cohortRowView, LIST_PATH } from "./instructor-list-lib.js";

/** 提出の講師の画面の道（site-nav.js の「提出ページ」と同じ） */
const SUBMISSIONS_PATH = "/submissions";

/** 一覧の 1 行（1 つの回が 1 つのリンク。新しいタブで開くこともできる） */
function cohortRow(el, c, extras) {
  const closed = extras?.closed?.has?.(c.id) === true;
  const v = cohortRowView(c, { closed, stage: extras?.stages?.get?.(c.id) ?? null });
  return el(
    "li",
    {},
    el(
      "a",
      { className: "cohort-row", href: cohortPath(c.id), "data-cohort-id": c.id },
      el("span", { className: "cohort-row-head" }, el("strong", { className: "cohort-row-title", text: v.title }), v.badge ? el("span", { className: `badge ${v.badge.kind}`, text: v.badge.label }) : null),
      v.meta ? el("span", { className: "cohort-row-meta tabular", text: v.meta }) : null,
      v.extra ? el("span", { className: "cohort-row-extra tabular", text: v.extra }) : null,
    ),
  );
}

/**
 * 回の一覧のページの本体（1 つの枠）。groups は groupCohorts の答え、extras は { closed: Set, stages: Map }（あとから届く追加の情報）。
 * 上の段（実施中とこれから）は必ず出す。終わった回は折りたたみ（最初は endedOpen の値。開け閉めは onToggleEnded に知らせる）
 */
export function cohortListView({ el, groups, extras, endedOpen = false, onRefresh, onToggleEnded, busy = false }) {
  const ended = groups?.ended ?? [];
  const current = groups?.current ?? [];
  let fold = null;
  if (ended.length) {
    fold = el(
      "details",
      { className: "plain-fold cohort-ended", id: "cohort-ended", open: endedOpen },
      el("summary", { id: "cohort-ended-summary", text: `終わった回（${ended.length}）` }),
      el("ul", { className: "cohort-rows", "aria-label": "終わった回" }, ...ended.map((c) => cohortRow(el, c, extras))),
    );
    fold.addEventListener("toggle", () => {
      // 描き直しで画面から外れた折りたたみの toggle は使わない
      if (!fold.isConnected) return;
      onToggleEnded?.(fold.open);
    });
  }
  return el(
    "section",
    { className: "card", "aria-labelledby": "cohort-list-h" },
    el(
      "div",
      { className: "card-head" },
      el("h2", { id: "cohort-list-h", text: "回の一覧" }),
      el("button", { type: "button", className: "btn compact", id: "list-refresh", text: "最新にする", disabled: busy, onclick: () => onRefresh?.() }),
    ),
    current.length
      ? el("ul", { className: "cohort-rows", id: "cohort-rows-current", "aria-label": "実施中とこれからの回" }, ...current.map((c) => cohortRow(el, c, extras)))
      : el("p", { className: "muted", id: "cohort-none-current", text: "実施中とこれからの回はありません。" }),
    fold,
  );
}

/**
 * 回の操作のページで、URL の回が自分の一覧に無いときの札（その回の RPC は 1 つも呼ばない）。
 * cohortId は形が正しいときだけ渡す（null なら、文に ID を出さない）
 */
export function cohortMissingView({ el, cohortId = null, onRefresh }) {
  const which = cohortId ? `この回（${cohortId}）` : "この回";
  return el(
    "section",
    { className: "card", id: "cohort-missing", "aria-labelledby": "cohort-missing-h" },
    el("h2", { id: "cohort-missing-h", text: "この回は開けません" }),
    el("p", { text: `あなたが開ける回の一覧に、${which}がありません。担当から外れた、回が消えた、会場か Day1 の日付が変わって回の ID が変わった、のどれかです。` }),
    el(
      "div",
      { className: "row-actions" },
      el("a", { className: "btn primary", id: "missing-to-list", href: LIST_PATH, text: "回の一覧へ" }),
      el("button", { type: "button", className: "btn", id: "missing-refresh", text: "最新にする", onclick: () => onRefresh?.() }),
    ),
  );
}

/**
 * 操作のページの「提出された作品（別のページ）」へのリンク（提出の講師の画面 /submissions へ。設計 docs/design-instructor-split.md の M-SP4）。
 * 提出の画面（submissions.html）と同じ公開にだけ入れる（提出が出ていない間にこのリンクだけ出すと、行き先が無い）。
 * 分割を外すときは、分割の一部としてこのリンクも一緒に消える。href は定数だけ
 */
export function submissionsLink({ el }) {
  return el("nav", { className: "back-row", id: "submissions-row", "aria-label": "提出された作品" }, el("a", { className: "back-link", id: "to-submissions", href: SUBMISSIONS_PATH, text: "提出された作品（別のページ）" }));
}

/** 操作のページの先頭の「← 回の一覧」 */
export function backToListLink({ el }) {
  return el("nav", { className: "back-row", id: "back-row", "aria-label": "回の一覧へ戻る" }, el("a", { className: "back-link", id: "back-to-list", href: LIST_PATH, text: "← 回の一覧" }));
}
