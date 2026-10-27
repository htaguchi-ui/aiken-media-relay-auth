// 講師ページを「回の一覧」と「回の操作」の 2 つのページに分けるための、画面を持たない関数（設計 docs/design-instructor-split.md 4.1）。
// URL の道の読み取り・一覧の並べ方と折りたたみの分け方・一覧の 1 行の文・追加の情報を読む相手。ブラウザにも通信にも触らない（試験は node で直接動かす）。
// 一覧：/instructor 操作：/instructor/c/<回の ID>（どちらも同じ instructor.html・instructor.js が道を見て描き分ける）。
import { cohortStatus, formatDateWithWeekday } from "./admin-lib.js";

/** 一覧のページの道 */
export const LIST_PATH = "/instructor";
/** 操作のページの道の頭（このあとに回の ID が 1 つ付く） */
export const COHORT_PATH_PREFIX = "/instructor/c/";
/**
 * 回の ID の形（緩い確かめ。本当の確かめは「自分の一覧にあるか」。回の ID は「会場番号 2 桁-Day1 の YYMMDD」で、例は 06-261120）。
 * 形が合わない ID は null にして、画面に出さない
 */
export const COHORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 一覧の追加の情報（受講者の数・今の段階）を読む回の数の上限（上の段の先頭から。7 回目からは読まない） */
export const EXTRA_STAGE_LIMIT = 6;

/**
 * 道から、どちらのページかを決める。
 * 一覧（"/instructor"・"/instructor.html"・そのほか）→ { kind: "list" }
 * 操作（"/instructor/c/<1 つの区切り>"）→ { kind: "cohort", cohortId }。cohortId は形が正しい ID だけ。
 * 空・長すぎ・使えない文字・デコードできない・区切りが 2 つ以上のときは null（画面に出さず、「この回は開けません」になる）
 */
export function instructorRoute(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  if (!path.startsWith(COHORT_PATH_PREFIX)) return { kind: "list" };
  const segment = path.slice(COHORT_PATH_PREFIX.length);
  let id = null;
  if (!segment.includes("/")) {
    try {
      id = decodeURIComponent(segment);
    } catch {
      id = null;
    }
  }
  return { kind: "cohort", cohortId: id !== null && COHORT_ID_RE.test(id) ? id : null };
}

/** 回の操作のページの道（ID は符号化する） */
export function cohortPath(id) {
  return COHORT_PATH_PREFIX + encodeURIComponent(String(id));
}

/** 実施中（Day1・ブリッジワーク・Day2）→ これから → 不明、の順位 */
function currentRank(period) {
  if (period === "day1" || period === "bridge" || period === "day2") return 0;
  if (period === "before") return 1;
  return 2;
}

const NO_DATE = "9999-99-99";
const dateOf = (v) => (typeof v === "string" && v ? v : NO_DATE);
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 回を「実施中とこれから（上の段）」と「終わった回（下の折りたたみ）」に分けて並べる。
 * closed：クローズ済みと分かった回の ID の集まり（Set）。
 * 下の段：period が after、または day2 でクローズ済み。並びは Day2 の日付の新しい順・同じなら ID の順。
 * 上の段：それ以外すべて（period が null・知らない値も上。終わった回だけを折りたたみに隠す）。
 *   並びは 実施中（day1・bridge・day2）→ これから（before）→ 不明、それぞれの中は Day1 の日付の早い順・同じなら ID の順
 */
export function groupCohorts(cohorts, closed = new Set()) {
  const list = Array.isArray(cohorts) ? cohorts : [];
  const isEnded = (c) => c.period === "after" || (c.period === "day2" && closed.has(c.id));
  const current = list
    .filter((c) => !isEnded(c))
    .sort((a, b) => currentRank(a.period) - currentRank(b.period) || dateOf(a.day1Date).localeCompare(dateOf(b.day1Date)) || byIdAsc(a, b));
  const ended = list
    .filter(isEnded)
    .sort((a, b) => {
      // Day2 の日付の新しい順（日付の無い回は最後）
      const da = a.day2Date ? a.day2Date : "";
      const db = b.day2Date ? b.day2Date : "";
      return da === db ? byIdAsc(a, b) : da === "" ? 1 : db === "" ? -1 : da < db ? 1 : -1;
    });
  return { current, ended };
}

/**
 * 一覧の 1 行の文。
 * closed：クローズ済みと分かっているか。stage：{ studentCount, stageLabel }（読めたときだけ。無ければ null）
 * 返り値：{ title, badge, meta, extra }。badge は { label, kind } か null（期間が分からない回は出さない）。extra は 1 行の文か空
 */
export function cohortRowView(c, { closed = false, stage = null } = {}) {
  const meta = [
    c.id,
    c.venueName,
    c.day1Date ? `Day1 ${formatDateWithWeekday(c.day1Date)}` : null,
    c.day2Date ? `Day2 ${formatDateWithWeekday(c.day2Date)}` : null,
  ].filter(Boolean).join(" · ");
  const status = c.period ? cohortStatus(c.period) : null;
  const badge = closed ? { label: "クローズ済み", kind: "ended" } : status && status.label !== "—" ? status : null;
  let extra = "";
  if (stage && Number.isInteger(stage.studentCount)) {
    extra = `受講者 ${stage.studentCount} 人${stage.stageLabel ? ` · 今：${stage.stageLabel}` : ""}`;
  }
  return { title: c.name || c.id, badge, meta, extra };
}

/**
 * 追加の情報を読む相手。groups は groupCohorts の答え（クローズが分かる前の分け方）。
 * closeIds：period が day2 の回（クローズ済みかどうかを cohort_close_status で聞く。ふつう 0〜1 回）
 * stageIds：上の段の先頭から EXTRA_STAGE_LIMIT 回まで（受講者の数・今の段階を cohort_stage_status で聞く）
 */
export function extraTargets(groups) {
  const current = Array.isArray(groups?.current) ? groups.current : [];
  return {
    closeIds: current.filter((c) => c.period === "day2").map((c) => c.id),
    stageIds: current.slice(0, EXTRA_STAGE_LIMIT).map((c) => c.id),
  };
}
