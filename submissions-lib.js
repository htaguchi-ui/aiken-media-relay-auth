// 提出（docs/design-submissions.md 第 7.2 版）の、画面に依存しない処理。講師の別ページ（submissions.js）・マイページ・管理コンソールの締切の画面から使う。
// テストは aiken-media-relay/scripts/submissions_lib_test.mjs。
// 境界は DB と `submissions` 関数：ここの判定は「押せるか」「文をどう書くか」の目安で、受け付け・上限・権限・取り下げの可否は、
// サーバーが返した値（accept.state・can_withdraw など）を使い、画面は締切を自分で解釈しない（設計 7.1）。
//
// ---- 画面が約束ごととして置いている、サーバーの返し方（coder A の約束 第 0.2 版 `.orchestration/wt/a/contract.md` と照らした。ここだけを直す）----
// 講師・管理者（利用者の JWT のまま RPC）。名前は SUBMISSION_RPC に 1 か所で置く：
//   submission_stage_overview(p_cohort_id) の jsonb：
//     { cohort_id, server_now, stages: [{ stage_id, label, title, kind: "workshop"|"bridge", day_kind, seq, is_current,
//         accept: { state: "current"|"grace"|"until"|"closed", until: 時刻|null（含まない終わり）, display_until: 時刻|null（最後の分。until の 1 分前） },
//         people_submitted, people_total（ブリッジワークは null）, works_count }] }
//   submission_stage_works(p_cohort_id, p_stage_id) の jsonb：
//     { stage_id, server_now,
//       people:  [{ identity, name, works: [WORK] }],   // 分母に入る人で、出している作品が 1 本以上ある人
//       pending: [{ identity, name }],                  // ワークショップの「まだ」（出している作品が 0 本の人）
//       stopped: [{ identity, name, works: [WORK] }],   // 止められている人の提出
//       unknown: [{ name, works: [WORK] }] }            // 名簿にいない人の提出
//     WORK ＝ { work_id, work_no, ready_at, duration_s, scope: "public"|"lecture"|"private", title, purpose, audio_codec: "aac"|"opus"|null }
//   再生は `submissions` 関数の POST /playback { work_id }（利用者の JWT のまま）→ { url, expires_at }。画面は置き場を知らない。
// 受講者（マイページ。`submissions` 関数。受講者の JWT）：
//   GET /my/works → { login_kind: "google"|"link"|"other", consent: { id, body, legal_reviewed } | null,
//     works: [{ work_id, stage_id, stage_label, stage_title, kind, work_no, title, purpose, scope, ready_at, bytes, duration_s,
//               can_withdraw（受け付け中の段階の作品だけ true）, can_change_scope }],
//     uploading: [{ work_id, stage_label, source_label, begun_at }] }
//   POST /my/works/<id>/withdraw ／ POST /my/works/<id>/scope { scope, consent_text_id? } ／ POST /uploads/<id>/cancel ／ POST /my/playback { work_id }
// 管理コンソールの締切（管理者の JWT のまま RPC）：
//   submission_deadlines(p_cohort_id) の jsonb：{ cohort_id, day2_date: "YYYY-MM-DD"|null, cold_due_at: 時刻|null, server_now,
//     stages: [{ stage_id, label, title, kind, seq, rule_until: 時刻|null（今の規則の終わり。無ければ null）, manual_until: 時刻|null,
//               events: [{ at, by_email, from, to }] }] }
//   submission_deadline_set(p_cohort_id, p_stage_id, p_deadline_at（null で既定に戻す））
// 欠けている項目は「分からない」として扱い、画面は出さない・安全な側（社外に出ない・消さない・押せない）に倒す。

// マイページが重い admin-lib.js を読まずに済むよう、日時の整形はここに持つ（admin-lib.js の formatShortDateTime と同じ出力。試験で照らす）
const SHORT_DT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** 日本時間の「10/15 20:31」（空・不正は「—」） */
export function formatShortDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = Object.fromEntries(SHORT_DT.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/** RPC の名前（A の約束の 1 枚が違ったら、ここだけを直す） */
export const SUBMISSION_RPC = {
  stageOverview: "submission_stage_overview",
  stageWorks: "submission_stage_works",
  deadlines: "submission_deadlines",
  deadlineSet: "submission_deadline_set",
};

/** D12：受講者に見える文では、これらの言葉を使わない（試験で確かめる） */
export const FORBIDDEN_FOR_STUDENTS = ["課題", "宿題", "締切", "評価", "必須", "カリキュラム", "住所"];

const str = (v) => (typeof v === "string" && v ? v : null);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SCOPES = ["public", "lecture", "private"];
const ACCEPT_STATES = ["current", "grace", "until", "closed"];

// A の約束 0.7：停止中の理由は、操作や画面が違っても同じ文で伝える。
export const MSG_SUBMISSIONS_PAUSED = "いま提出の受け付けを止めています。講師の案内を待ってください。";
export const MSG_SUBMISSIONS_READ_PAUSED = "いま作品の再生と保存を止めています。講師の案内を待ってください。";
export function submissionsPauseText(code) {
  if (code === "submissions_paused") return MSG_SUBMISSIONS_PAUSED;
  if (code === "submissions_read_paused") return MSG_SUBMISSIONS_READ_PAUSED;
  return null;
}

// ---- 共通の見せ方 ----

const HM = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** 日本時間の「13:41」（空・不正は「—」） */
export function formatHm(value) {
  const d = new Date(value ?? "");
  if (!value || Number.isNaN(d.getTime())) return "—";
  const p = Object.fromEntries(HM.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

/** 「0:28」（秒。分は 0 埋めしない。不正は null） */
export function formatDurationSec(sec) {
  const n = num(sec);
  if (n === null || n < 0) return null;
  const s = Math.round(n);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 「24 MB」「1.6 GB」（1 MB・1 GB は 1,000,000・1,000,000,000 バイト。上限の数え方と同じ） */
export function formatBytes(bytes) {
  const n = num(bytes);
  if (n === null || n < 0) return "—";
  if (n === 0) return "0 MB";
  if (n >= 1e9) {
    const g = Math.round((n / 1e9) * 10) / 10;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
  }
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export const SCOPE_LABELS = { public: "公開", lecture: "講義内に限り公開", private: "完全非公開" };
/** 知らない公開範囲は、社外に出ない側（完全非公開）として読む */
export function normalizeScope(v) {
  return SCOPES.includes(v) ? v : "private";
}

// =====================================================================
// 講師の別ページ（submissions.html。設計 4.8）
// =====================================================================

/** 画面の一覧に出す、完全非公開の帯（設計 4.8） */
export const PRIVATE_BANNER = "完全非公開：講義では映しません。プロジェクターに映していないか確かめてください。";
/** Opus の音の印（設計 4.8。行は「♪?」、ふれると説明） */
export const OPUS_MARK = { text: "♪?", title: "iPhone などで音が出ないことがあります" };
export const LIST_POLL_MS = 30000;

function normalizeAccept(raw) {
  const a = isObj(raw) ? raw : {};
  const state = ACCEPT_STATES.includes(a.state) ? a.state : "closed";
  return { state, until: str(a.until), displayUntil: str(a.display_until) };
}

/** submission_stage_overview の答えを読む。形が違えば null（画面は「読み込めませんでした」） */
export function normalizeStageOverview(raw) {
  if (!isObj(raw) || !Array.isArray(raw.stages)) return null;
  const stages = [];
  for (const s of raw.stages) {
    if (!isObj(s) || !str(s.stage_id)) continue;
    stages.push({
      stageId: s.stage_id,
      label: str(s.label) ?? "",
      title: str(s.title),
      kind: s.kind === "bridge" ? "bridge" : "workshop",
      dayKind: str(s.day_kind),
      seq: num(s.seq),
      isCurrent: s.is_current === true,
      accept: normalizeAccept(s.accept),
      peopleSubmitted: num(s.people_submitted) ?? 0,
      peopleTotal: num(s.people_total),
      worksCount: num(s.works_count) ?? 0,
    });
  }
  return { cohortId: str(raw.cohort_id), serverNow: str(raw.server_now), stages };
}

/** 段階の名前「ワークショップ 2「台本と生成」」 */
export function submissionStageName(stage) {
  if (!stage) return "—";
  const label = String(stage.label ?? "").trim();
  return stage.title ? `${label}「${stage.title}」` : label || "（名前なし）";
}

/**
 * 段階の行の受け付けの状態（設計 4.8）。サーバーが決めた状態と終わりの時刻から、今の時刻に合わせて書く。
 * 「受け付け中・このワークショップの間」→「あと 7 分受け付けます」→「受け付けは終わりました」。ブリッジワークは「受け付け中・11/25 23:59 まで」
 */
export function instructorAcceptLabel(stage, nowMs = Date.now()) {
  const { state, until } = stage.accept;
  const untilMs = until ? Date.parse(until) : NaN;
  if (state === "closed") return "受け付けは終わりました";
  if (state === "current") return "受け付け中・このワークショップの間";
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return "受け付けは終わりました";
  if (state === "grace") return `あと ${Math.max(1, Math.ceil((untilMs - nowMs) / 60000))} 分受け付けます`;
  // until は「この時刻を含まない終わり」。画面には最後の分（display_until。無ければ 1 分前）を出す（A の約束 0.2 版の 2）
  const shown = stage.accept.displayUntil ?? new Date(untilMs - 60000).toISOString();
  return `受け付け中・${formatShortDateTime(shown)} まで`;
}

/**
 * 段階の行の数（設計 4.8）。ワークショップ「7 / 10 人 · 作品 9 本」、ブリッジワーク「3 人 · 作品 4 本」。
 * ブリッジワークは分母と「まだ」を出さない（自主的な制作の扱い。助成金の注意）。分母が分からないワークショップも分母を作らない
 */
export function stageCountsLabel(stage) {
  const works = `作品 ${stage.worksCount} 本`;
  if (stage.kind === "workshop" && stage.peopleTotal !== null) return `${stage.peopleSubmitted} / ${stage.peopleTotal} 人 · ${works}`;
  return `${stage.peopleSubmitted} 人 · ${works}`;
}

function normalizeWork(raw) {
  if (!isObj(raw) || !str(raw.work_id)) return null;
  const codec = raw.audio_codec === "opus" ? "opus" : raw.audio_codec === "aac" ? "aac" : null;
  return {
    workId: raw.work_id,
    workNo: num(raw.work_no),
    readyAt: str(raw.ready_at),
    durationSec: num(raw.duration_s),
    bytes: num(raw.bytes),
    scope: normalizeScope(raw.scope),
    title: str(raw.title),
    purpose: str(raw.purpose),
    audioCodec: codec,
  };
}

function normalizePersonList(rawList, { withWorks }) {
  const out = [];
  for (const p of arr(rawList)) {
    if (!isObj(p)) continue;
    const works = withWorks ? arr(p.works).map(normalizeWork).filter(Boolean) : [];
    if (withWorks && works.length === 0) continue;
    // 作品番号の順（作品番号が無いものは出した時刻の順）
    works.sort((a, b) => (a.workNo ?? Infinity) - (b.workNo ?? Infinity) || String(a.readyAt).localeCompare(String(b.readyAt)));
    out.push({ identity: str(p.identity), name: str(p.name) ?? "（名前なし）", works });
  }
  return out;
}

/** submission_stage_works の答えを読む。形が違えば null */
export function normalizeStageWorks(raw) {
  if (!isObj(raw)) return null;
  return {
    stageId: str(raw.stage_id),
    serverNow: str(raw.server_now),
    people: normalizePersonList(raw.people, { withWorks: true }),
    pending: normalizePersonList(raw.pending, { withWorks: false }),
    stopped: normalizePersonList(raw.stopped, { withWorks: true }),
    unknown: normalizePersonList(raw.unknown, { withWorks: true }),
  };
}

/** 一覧の 1 作品の行：「作品 2」「0:12」「13:52」、Opus の印 */
export function workRow(work) {
  return {
    label: work.workNo === null ? "作品" : `作品 ${work.workNo}`,
    duration: formatDurationSec(work.durationSec),
    time: formatHm(work.readyAt),
    opus: work.audioCodec === "opus" ? OPUS_MARK : null,
    scope: work.scope,
  };
}

const SCOPE_BADGE_LABELS = { public: "公開", lecture: "講義内", private: "完全非公開" };
/**
 * 公開範囲のバッジ。ブリッジワークは作品ごとに出す（公開・講義内・完全非公開）。ワークショップは「講義内」が前提なので出さないが、
 * 完全非公開が入っていたら（本来は無い）見落とさないよう出す
 */
export function scopeBadge(work, stageKind) {
  if (stageKind !== "bridge" && work.scope !== "private") return null;
  return { label: SCOPE_BADGE_LABELS[work.scope], tone: work.scope };
}

/** 完全非公開の作品は、［▶ 再生］を押すまで再生しない（設計 4.8）。帯を出す */
export function needsManualPlay(work) {
  return work.scope === "private";
}

/** ［前］［次］のための並び：分母に入る人（people）の作品を、人の順・作品番号の順に平らにする（止められている人・名簿にいない人は含めない） */
export function playbackQueue(view) {
  const out = [];
  for (const p of view?.people ?? []) for (const w of p.works) out.push({ person: p.name, identity: p.identity, work: w });
  return out;
}

/** 並びの中の、いまの作品の前・次（同じ人の次の作品、終われば次の人へ。端では null） */
export function neighborInQueue(queue, workId, dir) {
  const i = queue.findIndex((q) => q.work.workId === workId);
  if (i < 0) return null;
  const j = dir === "next" ? i + 1 : i - 1;
  return j >= 0 && j < queue.length ? queue[j] : null;
}

/**
 * 上映の画面に出すもの（設計 4.8）：「公開」と「講義内に限り公開」の、出している作品だけ。完全非公開・止められている人・名簿にいない人の作品は出さない。
 * 出していない人の名前・「まだ」・分母は出さない。人の順、作品番号の順
 */
export function screeningQueue(view) {
  return playbackQueue(view).filter((q) => q.work.scope === "public" || q.work.scope === "lecture");
}

/** 「止められている人の提出（n）」「名簿にいない人の提出（n）」の見出し。n は作品の本数 */
export function foldTitle(kind, people) {
  const n = people.reduce((sum, p) => sum + p.works.length, 0);
  return kind === "stopped" ? `止められている人の提出（${n}）` : `名簿にいない人の提出（${n}）`;
}

/** プレーヤーの下の 1 行：「佐藤 花子 · 作品 1 · 13:41」 */
export function playerCaption(entry) {
  const r = workRow(entry.work);
  return `${entry.person} · ${r.label} · ${r.time}`;
}

// =====================================================================
// マイページ（設計 4.5・4.11・5.2・4.9 の短い案内）
// =====================================================================

export const WITHDRAW_CONFIRM_LINE = "この作品を講師の一覧から外し、保存したファイルを消します。元に戻せません。";
export const MSG_WITHDRAWN = "作品を取り下げました。";
export const MSG_CANCELLED_UPLOAD = "送信をやめました。";
export const MY_WORKS_EMPTY = "提出した作品はまだありません。";
export const PUBLIC_BLOCKED_LEGAL = "公開は準備中です。準備ができたら、アカウントが有効な間にマイページで選べます。";
export const PUBLIC_BLOCKED_LINK = "公開は、アカウントが有効な間に、Google でログインしたマイページで選べます。";
export const WORKSHOP_SCOPE_NOTE = "ワークショップの作品の公開範囲は、変えられません。";

/** GET /my/works を読む。形が違えば null */
export function normalizeMyWorks(raw) {
  if (!isObj(raw)) return null;
  const consent = isObj(raw.consent) && str(raw.consent.id) && str(raw.consent.body) ? { id: raw.consent.id, body: raw.consent.body, legalReviewed: raw.consent.legal_reviewed === true } : null;
  const works = [];
  for (const w of arr(raw.works)) {
    if (!isObj(w) || !str(w.work_id)) continue;
    works.push({
      workId: w.work_id,
      stageId: str(w.stage_id),
      stageLabel: str(w.stage_label) ?? "",
      stageTitle: str(w.stage_title),
      kind: w.kind === "bridge" ? "bridge" : "workshop",
      workNo: num(w.work_no),
      title: str(w.title),
      purpose: str(w.purpose),
      scope: normalizeScope(w.scope),
      readyAt: str(w.ready_at),
      bytes: num(w.bytes),
      durationSec: num(w.duration_s),
      // 取り下げ・公開範囲の変更の可否はサーバーが決める。分からないときは出さない
      canWithdraw: w.can_withdraw === true,
      canChangeScope: w.can_change_scope === true,
    });
  }
  const uploading = arr(raw.uploading)
    .filter((u) => isObj(u) && str(u.work_id))
    .map((u) => ({ workId: u.work_id, stageLabel: str(u.stage_label) ?? "", sourceLabel: str(u.source_label), begunAt: str(u.begun_at) }));
  return { loginKind: raw.login_kind === "google" ? "google" : raw.login_kind === "link" ? "link" : "other", consent, works, uploading };
}

/** 「作品 2 ・ ワークショップ 2「台本と生成」・0:28・24 MB」のような、作品の行の 2 行目 */
export function myWorkMeta(w) {
  const parts = [w.stageTitle ? `${w.stageLabel}「${w.stageTitle}」` : w.stageLabel, formatDurationSec(w.durationSec), w.bytes === null ? null : formatBytes(w.bytes), w.readyAt ? formatShortDateTime(w.readyAt) : null];
  return parts.filter(Boolean).join(" · ");
}

/** 作品の行の題名（ブリッジワークはタイトル。ワークショップは「作品 N」） */
export function myWorkHeading(w) {
  const no = w.workNo === null ? "作品" : `作品 ${w.workNo}`;
  return w.title ? `${w.title}（${no}）` : no;
}

/** 「公開」を選べない理由（1 行）。選べるなら null */
export function publicBlockedReason({ loginKind, consent }) {
  if (loginKind !== "google") return PUBLIC_BLOCKED_LINK;
  if (!consent || !consent.legalReviewed) return PUBLIC_BLOCKED_LEGAL;
  return null;
}

const SCOPE_RANK = { private: 0, lecture: 1, public: 2 };

/**
 * 公開範囲を変えるときの流れ（設計 5.2）。
 * - ワークショップの作品・サーバーが変えられないとした作品は変えられない。
 * - 狭める変更（公開→講義内・完全非公開、講義内→完全非公開）は確認だけ。
 * - 「公開」にする変更は、同意の文の全文とチェックの欄（Google のログインで、法務の確認済みの版があるときだけ）。
 * - 完全非公開→講義内は、社外には出ない変更なので確認だけ。
 * 戻り値：{ ok:false, reason } か { ok:true, kind: "narrow"|"widen"|"public", confirmLines, consent? }
 */
export function scopeChangePlan(work, next, ctx) {
  if (!SCOPES.includes(next) || next === work.scope) return { ok: false, reason: "公開範囲が変わっていません。" };
  if (work.kind === "workshop") return { ok: false, reason: WORKSHOP_SCOPE_NOTE };
  if (!work.canChangeScope) return { ok: false, reason: "この作品の公開範囲は、今は変えられません。" };
  if (next === "public") {
    const blocked = publicBlockedReason(ctx);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, kind: "public", confirmLines: [`公開範囲を「${SCOPE_LABELS.public}」に変えます。`], consent: ctx.consent };
  }
  const narrow = SCOPE_RANK[next] < SCOPE_RANK[work.scope];
  return { ok: true, kind: narrow ? "narrow" : "widen", confirmLines: [`公開範囲を「${SCOPE_LABELS[next]}」に変えます。`] };
}

/** 空き容量の目安（GB）：ZIP の大きさの 2 倍を切り上げた値（保存した ZIP と、展開した動画の両方が入るため。設計 4.9）。例：1.2 GB → 3 */
export function requiredFreeGb(zipBytes) {
  const n = num(zipBytes);
  if (n === null || n <= 0) return null;
  return Math.ceil((n * 2) / 1e9);
}

/** マイページの QR の欄の短い案内（設計 4.9）。ZIP の大きさがまだ分からないときは Wi-Fi の 1 行だけ */
export function qrShortNote(zipBytes) {
  const lines = ["Wi-Fi で保存してください。"];
  const gb = requiredFreeGb(zipBytes);
  if (gb !== null) lines.push(`空き容量は ${gb} GB 以上いります。`);
  return lines;
}

export const MSG_SCOPE_CHANGED = "公開範囲を変えました。";
export const MSG_MY_WORKS_FAILED = "提出した作品を読み込めませんでした。";
export const MSG_MY_WORKS_BUSY = "混み合っています。少し待ってから、もう一度押してください。";
export const MSG_MY_NETWORK = "通信できませんでした。通信状態を確かめてください。";
export const MSG_MY_STALE = "作品の状態が変わっています。最新にしてから、もう一度押してください。";

/** マイページの操作の失敗（サーバーの拒否の名前 → 文。設計 4.11・5.2・A の約束 0.2 版 3 章） */
export function myActionErrorText(code, status) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  switch (code) {
    case "submission_busy":
      return "回の情報が変わりました。もう一度押してください。";
    case "not_stage_student":
      return "この回の受講者として登録されていないため、この操作はできません。";
    case "submission_closed":
      return "この段階の受け付けは終わったため、取り下げられません。";
    case "scope_fixed":
      return WORKSHOP_SCOPE_NOTE;
    case "public_unavailable":
      return PUBLIC_BLOCKED_LEGAL;
    case "public_needs_google":
      return PUBLIC_BLOCKED_LINK;
    case "consent_outdated":
      return "同意の文が新しくなりました。画面を開き直して、もう一度読んでから選んでください。";
    case "member_disabled":
      return "アカウントが止められているため、この操作はできません。";
    case "already_ready":
      return "この作品は、すでに提出が済んでいます。最新にしてください。";
    default:
      break;
  }
  if (status === 0) return MSG_MY_NETWORK;
  if (status === 404) return MSG_MY_STALE;
  if (status === 429 || status === 503) return MSG_MY_WORKS_BUSY;
  return "エラーが起きました。少し待ってから、もう一度押してください。";
}

/** 再生の失敗（マイページ） */
export function myPlaybackErrorText(code, status) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  if (code === "cold_unavailable") return "この作品は保管庫に移っているため、まだ再生できません。";
  if (status === 404) return "この作品は再生できません。最新にしてください。";
  if (status === 0) return MSG_MY_NETWORK;
  return "再生の準備ができませんでした。少し待ってから、もう一度押してください。";
}

/** 受講者に見える文の一覧（試験で D12 の言葉を確かめる） */
export function studentFacingTexts() {
  return [
    WITHDRAW_CONFIRM_LINE, MSG_WITHDRAWN, MSG_CANCELLED_UPLOAD, MY_WORKS_EMPTY, PUBLIC_BLOCKED_LEGAL, PUBLIC_BLOCKED_LINK, WORKSHOP_SCOPE_NOTE,
    MSG_SCOPE_CHANGED, MSG_MY_WORKS_FAILED, MSG_MY_WORKS_BUSY, MSG_MY_NETWORK, MSG_MY_STALE, MSG_SUBMISSIONS_PAUSED, MSG_SUBMISSIONS_READ_PAUSED,
    ...["submission_busy", "not_stage_student", "submission_closed", "scope_fixed", "public_unavailable", "public_needs_google", "consent_outdated", "member_disabled", "already_ready", "x"].map((c) => myActionErrorText(c, 400)),
    myActionErrorText("x", 0), myActionErrorText("x", 404), myActionErrorText("x", 503), myPlaybackErrorText("cold_unavailable", 409), myPlaybackErrorText("x", 404), myPlaybackErrorText("x", 500),
    ...Object.values(SCOPE_LABELS), ...qrShortNote(1_200_000_000),
  ];
}

// =====================================================================
// 管理コンソールの「受け付けの終わり」（設計 6.3・2.3）
// =====================================================================

export const NO_DAY2_TEXT = "回の日付が決まっていないため、受け付けていません";
export const DEADLINE_RULE_TEXT = {
  workshop: "その段階が今の間と、終わってから 10 分",
  bridge: "Day2 の前々日の 23:59 まで",
};

/** submission_deadlines の答えを読む。形が違えば null */
export function normalizeDeadlines(raw) {
  if (!isObj(raw) || !Array.isArray(raw.stages)) return null;
  const stages = [];
  for (const s of raw.stages) {
    if (!isObj(s) || !str(s.stage_id)) continue;
    stages.push({
      stageId: s.stage_id,
      label: str(s.label) ?? "",
      title: str(s.title),
      kind: s.kind === "bridge" ? "bridge" : "workshop",
      seq: num(s.seq),
      ruleUntil: str(s.rule_until),
      manualUntil: str(s.manual_until),
      events: arr(s.events)
        .filter((e) => isObj(e) && str(e.at))
        .map((e) => ({ at: e.at, byEmail: str(e.by_email), from: str(e.from), to: str(e.to), note: str(e.note) })),
    });
  }
  return { cohortId: str(raw.cohort_id), day2Date: str(raw.day2_date), coldDueAt: str(raw.cold_due_at), serverNow: str(raw.server_now), stages };
}

/** 段階の「今の規則」の 1 行。手の設定があれば「手の設定：11/25 23:59 まで」。Day2 の日付が無ければ受け付けていない旨 */
export function deadlineRuleLine(stage, day2Date) {
  if (!day2Date) return NO_DAY2_TEXT;
  // 手の設定はサーバーでは「含まない終わり」。入力・表示は最後の分にそろえる（「23:59」と入れたら、23:59 の間も受け付ける）
  if (stage.manualUntil) return `手の設定：${formatShortDateTime(lastMinuteIso(stage.manualUntil))} まで`;
  const base = DEADLINE_RULE_TEXT[stage.kind];
  // rule_until は「含まない終わり」（11/26 0:00）。画面には最後の分（11/25 23:59）を出す
  const last = stage.ruleUntil && Number.isFinite(Date.parse(stage.ruleUntil)) ? new Date(Date.parse(stage.ruleUntil) - 60000).toISOString() : null;
  return stage.kind === "bridge" && last ? `${base}（${formatShortDateTime(last)}）` : base;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60000;

/** 含まない終わり（サーバーの値）→ 画面に出す最後の分（1 分前）。不正は null */
export function lastMinuteIso(endIso) {
  const ms = Date.parse(endIso ?? "");
  return Number.isFinite(ms) ? new Date(ms - MINUTE_MS).toISOString() : null;
}

/** <input type="datetime-local"> の値（日本時間の "2026-11-25T23:59"。秒は ":00" だけ許す）→ ISO（UTC）。不正は null */
export function isoFromJstLocal(value) {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
  const back = new Date(ms + JST_OFFSET_MS);
  // 2 月 30 日のような存在しない日は、日付が繰り上がるので断る
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  return new Date(ms).toISOString();
}

/** ISO → <input type="datetime-local"> の値（日本時間）。不正は "" */
export function jstLocalFromIso(iso) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** 保存済みの手の設定（含まない終わり）→ 入力欄の値（最後の分。日本時間）。不正は "" */
export function inputValueFromDeadline(endIso) {
  const last = lastMinuteIso(endIso);
  return last ? jstLocalFromIso(last) : "";
}

export const DEADLINE_INPUT_HELP = "この時刻まで受け付けます。";

/**
 * 手の設定の入力を確かめる（設計 6.3・2.3）。最後に断るのは DB。
 * 入力は「最後の分」（例 23:59）。サーバーは「この時刻より前を受け付ける」（含まない終わり）なので、送る値は入力の 1 分あと
 * （23:59 と入れたら翌 0:00 を送る。日付をまたいでもよい）。これで、入力と表示の「23:59 まで」がそろう。
 * 戻り値：{ error } ＝ 保存できない／{ iso, confirm } ＝ 保存できる（iso は送る値。confirm があれば、過去の時刻なので確認を出す）
 */
export function deadlineProblem(localValue, { coldDueAt, nowMs = Date.now() }) {
  if (!String(localValue ?? "").trim()) return { error: "日時を入れてください。" };
  const typed = isoFromJstLocal(localValue);
  if (!typed) return { error: "日時の形が正しくありません。" };
  const ms = Date.parse(typed) + MINUTE_MS;
  const iso = new Date(ms).toISOString();
  const coldMs = coldDueAt ? Date.parse(coldDueAt) : NaN;
  // サーバーは「回の終了から 7 日後（cold_due_at）以降」を断る。送る値で比べ、入力できる最後の日時を文に出す
  if (Number.isFinite(coldMs) && ms >= coldMs) return { error: `${formatShortDateTime(new Date(coldMs - 2 * MINUTE_MS).toISOString())} までの日時にしてください（回の終了から 7 日後の前まで）。` };
  if (ms <= nowMs) return { iso, confirm: "過去の日時です。保存すると、この段階の受け付けは、すぐに終わります。" };
  return { iso, confirm: null };
}

export const MSG_DEADLINE_SAVED = "受け付けの終わりを保存しました。";
export const MSG_DEADLINE_RESET = "既定の規則に戻しました。";
export const DEADLINE_RESET_CONFIRM = "手の設定を消して、既定の規則に戻します。";

/** 変更の履歴の 1 行（from・to はサーバーでは「含まない終わり」。画面には最後の分で出す） */
export function deadlineEventLine(e) {
  const shown = (v) => (v ? formatShortDateTime(lastMinuteIso(v)) : "既定");
  const who = e.byEmail ? ` ${e.byEmail}` : "";
  return `${formatShortDateTime(e.at)}${who}：${shown(e.from)} → ${e.to ? shown(e.to) : "既定に戻した"}${e.note ? `（${e.note}）` : ""}`;
}

/** 手の設定の保存の失敗（サーバーの拒否の名前 → 文） */
export function deadlineErrorText(code, status) {
  switch (code) {
    case "deadline_after_cold_due":
      return "回の終了から 7 日後より前の日時にしてください。";
    case "cohort_dates_missing":
      return NO_DAY2_TEXT;
    case "admin_only":
      return "管理者だけが設定できます。管理コンソールで入り直してください。";
    default:
      break;
  }
  if (status === 0) return "通信できませんでした。通信状態を確かめてください。";
  return "保存できませんでした。少し待ってから、もう一度押してください。";
}
