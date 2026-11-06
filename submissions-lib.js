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
// upcoming：まだ始まっていない（受け付けない。DB 254）。知らない状態は closed として読む
const ACCEPT_STATES = ["current", "grace", "until", "closed", "upcoming"];

// A の約束 0.7：停止中の理由は、操作や画面が違っても同じ文で伝える。
// 画面の文は「1 行目＋改行＋次の手」の形（組 13 の文言の表・決まり 1）。出す所は white-space: pre-line で 2 行にする
export const MSG_SUBMISSIONS_PAUSED = "提出の受付を停止中です。\n講師の案内をお待ちください。";
export const MSG_SUBMISSIONS_READ_PAUSED = "再生と保存を停止中です。\n講師の案内をお待ちください。";
/**
 * 講師が見る画面（提出作品）の再生と保存の停止の文（組 13 の INS-151）：講師に「講師の案内を」は合わないので 1 行目だけ。
 * 1 行目はマイページの表（MP-040）の 1 行目と同じ文。受講者の文（上の定数）はマイページの表の持ち物なので、ここでは変えない
 */
export const MSG_SUBMISSIONS_READ_PAUSED_INSTRUCTOR = "再生と保存を停止中です。";
/** viewer：見る人（"student"＝受講者〔既定〕・"instructor"＝講師） */
export function submissionsPauseText(code, { viewer = "student" } = {}) {
  if (code === "submissions_paused") return MSG_SUBMISSIONS_PAUSED;
  if (code === "submissions_read_paused") return viewer === "instructor" ? MSG_SUBMISSIONS_READ_PAUSED_INSTRUCTOR : MSG_SUBMISSIONS_READ_PAUSED;
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
/**
 * 公開範囲を選ぶときの名前（組 13 の U-13）。提出のダイアログの 3 つの丸（upload-lib.js の TEXT）と、
 * マイページの一覧の ？ の中（myScopeHelp）で同じ文を使う。Canvas の submit/messages.ts と同じ文。
 * 名前は決定済みなので括弧の説明は付けない。説明は SCOPE_CHOICE_NOTES（選択肢の下の 1 行。D-1104-130x-c）。
 * 一覧の選ぶ欄は短い名前（SCOPE_LABELS）にして、説明は ？ の奥に置く（D-1105-121x）
 */
export const SCOPE_CHOICE_LABELS = {
  lecture: "講義内に限り公開",
  private: "完全非公開",
  public: "公開",
};
/** 公開範囲の 3 つの説明（提出の窓では選択肢の下に常に 1 行ずつ。ホバーにしない。D-1104-130x-c。Canvas・ChatGPT と同じ文） */
export const SCOPE_CHOICE_NOTES = {
  lecture: "この回の受講者と講師だけが見られます。",
  private: "講師だけが見られます。講義では映しません。",
  public: "A.I.KEN が事例紹介・Web サイト・SNS・営業資料に使います。",
};
/**
 * 押して試す操作の通信の失敗（組 13 の U-10 の T-05。通信の失敗は 1 通りの文。文言の表の決まり 5.2 の 1）。
 * 自動で読み直す所には使わない（押すボタンが無いため）
 */
export const MSG_NETWORK_PRESS_AGAIN = "通信エラー：接続できませんでした。\nインターネット接続を確認してください。";
/**
 * エラーコードの出し方（D-1104-130x-b・文言の決まり 3.2 の案 A）：最後の文の後ろに小さく薄く「（E-SUB-04）」。
 * コードは文の定数に入れず別の値で持ち、出す所でこの形にする（文の試験とコードの試験を分ける）。コードが無ければ ""
 */
export function errorCodeLabel(code) {
  return typeof code === "string" && code ? `（${code}）` : "";
}
/** 名簿で停止中のアカウント（member_disabled）の断り。マイページの提出と一覧の操作で同じ文（コードは E-LOG-50） */
export const MSG_MEMBER_DISABLED = "アカウントが停止中です。\n講師・スタッフにお知らせください。";
/** 知らない公開範囲は、社外に出ない側（完全非公開）として読む */
export function normalizeScope(v) {
  return SCOPES.includes(v) ? v : "private";
}

// =====================================================================
// 講師の別ページ（submissions.html。設計 4.8）
// =====================================================================

/** 画面の一覧に出す、完全非公開の帯（設計 4.8） */
export const PRIVATE_BANNER = "完全非公開：画面を映さないでください。";
/** Opus の音の印（設計 4.8。行は「♪?」、ふれると説明） */
export const OPUS_MARK = { text: "♪?", title: "iPhone などで音が出ないことがあります" };
/** 提出作品のページの一覧の読み直しの間隔（ミリ秒。組 11 で 30 秒から約 10 秒に。部品は poll-lib.js） */
export const LIST_POLL_MS = 10000;

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
 * 段階の行の受付の状態（設計 4.8）。サーバーが決めた状態と終わりの時刻から、今の時刻に合わせて書く。
 * 「受付中・このワークショップの間」→「受付中・残り 7 分」→「受付終了」。ブリッジワークは「受付中・11/25 23:59 まで」。
 * まだ始まっていない段階（upcoming）は「受付前」
 */
export function instructorAcceptLabel(stage, nowMs = Date.now()) {
  const { state, until } = stage.accept;
  const untilMs = until ? Date.parse(until) : NaN;
  if (state === "upcoming") return "受付前";
  if (state === "closed") return "受付終了";
  if (state === "current") return "受付中・このワークショップの間";
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return "受付終了";
  if (state === "grace") return `受付中・残り ${Math.max(1, Math.ceil((untilMs - nowMs) / 60000))} 分`;
  // until は「この時刻を含まない終わり」。画面には最後の分（display_until。無ければ 1 分前）を出す（A の約束 0.2 版の 2）
  const shown = stage.accept.displayUntil ?? new Date(untilMs - 60000).toISOString();
  return `受付中・${formatShortDateTime(shown)} まで`;
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
 * 公開範囲のバッジ。種類（ワークショップ・ブリッジワーク）によらず、作品ごとに出す（公開・講義内・完全非公開）。
 * 組 11 から、ワークショップの作品も提出の直後に 3 つから選び、あとからマイページで変えられる（決定 A）（stageKind は呼び出しの形を保つために受け取るだけ）
 */
export function scopeBadge(work, stageKind) {
  return { label: SCOPE_BADGE_LABELS[work.scope], tone: work.scope };
}

/** 完全非公開の作品は、［▶ 再生］を押すまで再生しない（設計 4.8）。帯を出す */
export function needsManualPlay(work) {
  return work.scope === "private";
}

/**
 * ［前］［次］のための並び：分母に入る人（people）の作品を、人の順・作品番号の順に平らにする（止められている人・名簿にいない人は含めない）。
 * personIndex は people の中の人の順（［次の受講者 ▶▶］で人の切れ目を見る）
 */
export function playbackQueue(view) {
  const out = [];
  for (const [personIndex, p] of (view?.people ?? []).entries()) for (const w of p.works) out.push({ person: p.name, identity: p.identity, work: w, personIndex });
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
 * ［次の受講者 ▶▶］の行き先：並びの中で、いまの作品の人の次の人の 1 本目。
 * 未選択・並びに無い → 並びの最初。最後の人 → null。並びが空 → null
 */
export function nextPersonInQueue(queue, workId) {
  const i = workId ? queue.findIndex((q) => q.work.workId === workId) : -1;
  if (i < 0) return queue[0] ?? null;
  const me = queue[i].personIndex;
  for (let j = i + 1; j < queue.length; j++) if (queue[j].personIndex !== me) return queue[j];
  return null;
}

/**
 * 上映の画面に出すもの（設計 4.8）：「公開」と「講義内に限り公開」の、出している作品だけ。完全非公開・止められている人・名簿にいない人の作品は出さない。
 * 出していない人の名前・「まだ」・分母は出さない。人の順、作品番号の順
 */
export function screeningQueue(view) {
  return playbackQueue(view).filter((q) => q.work.scope === "public" || q.work.scope === "lecture");
}

/** 「停止中の人の提出（n）」「名簿にいない人の提出（n）」の見出し。n は作品の本数 */
export function foldTitle(kind, people) {
  const n = people.reduce((sum, p) => sum + p.works.length, 0);
  return kind === "stopped" ? `停止中の人の提出（${n}）` : `名簿にいない人の提出（${n}）`;
}

/** プレーヤーの下の 1 行：「佐藤 花子 · 作品 1 · 13:41」 */
export function playerCaption(entry) {
  const r = workRow(entry.work);
  return `${entry.person} · ${r.label} · ${r.time}`;
}

// =====================================================================
// マイページ（設計 4.5・4.11・5.2・4.9 の短い案内）
// =====================================================================

export const WITHDRAW_CONFIRM_LINE = "動画は削除され、元に戻せません。";
export const MSG_WITHDRAWN = "動画を取り下げました。";
export const MSG_CANCELLED_UPLOAD = "送信をキャンセルしました。";
/** 1 行だけの空の状態なので句点を付けない（文言の決まり 2.2.1） */
export const MY_WORKS_EMPTY = "提出した動画はまだありません";
/** 「公開」を選べない理由。続きはホバー（title）に置く（PUBLIC_BLOCKED_TIPS） */
export const PUBLIC_BLOCKED_LEGAL = "「公開」は準備中です。";
export const PUBLIC_BLOCKED_LINK = "「公開」は Google でログインすると選べます。";
/** 「公開」を選べない理由のホバーの文（理由の文 → 補足） */
export const PUBLIC_BLOCKED_TIPS = {
  [PUBLIC_BLOCKED_LEGAL]: "準備ができたら、アカウントが有効な間にマイページで選べます。",
  [PUBLIC_BLOCKED_LINK]: "アカウントが有効な間だけ選べます。",
};
/** 理由の文のホバー（無ければ null） */
export function publicBlockedTip(reason) {
  return (typeof reason === "string" && PUBLIC_BLOCKED_TIPS[reason]) || null;
}
/** サーバーが変えられないとした作品（can_change_scope が偽）にだけ出す 1 行。種類によらない（組 11） */
export const SCOPE_FIXED_NOTE = "公開範囲は変更できません。";

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

/** 作品の行の題の右に並べる段階の名前：「ワークショップ 2「台本と生成」」（題名が無ければ「ブリッジワーク」のように名前だけ。無ければ ""） */
export function myWorkStage(w) {
  return w.stageTitle ? `${w.stageLabel}「${w.stageTitle}」` : w.stageLabel;
}

/** 「0:28 · 24 MB · 11/20 13:34」のような、作品の行の 2 段目（段階の名前は題の行。組 13 の U-13・D-1105-121x） */
export function myWorkMeta(w) {
  const parts = [formatDurationSec(w.durationSec), w.bytes === null ? null : formatBytes(w.bytes), w.readyAt ? formatShortDateTime(w.readyAt) : null];
  return parts.filter(Boolean).join(" · ");
}

/** 作品の行の題名（ブリッジワークはタイトル。ワークショップは「動画 N」。受講者の文は「動画」。文言の決まり 2.3） */
export function myWorkHeading(w) {
  const no = w.workNo === null ? "動画" : `動画 ${w.workNo}`;
  return w.title ? `${w.title}（${no}）` : no;
}

/**
 * 読み上げの名前の頭（題の行の文と同じ並び）：「動画 1 ワークショップ 1「企画」」「会社紹介（動画 1） ブリッジワーク」。
 * 作品の番号は段階ごとに振るので、段階の名前を入れて WS1 と WS2 の「動画 1」を区別する（組 13 の U-13・確かめの P3-1）
 */
function myWorkNameWith(w, tail) {
  const stage = myWorkStage(w);
  const name = stage ? `${myWorkHeading(w)} ${stage}` : myWorkHeading(w);
  return /[）」]$/.test(name) ? `${name}${tail}` : `${name} ${tail}`;
}

/** 丸の再生のボタンの読み上げの名前：「動画 1 ワークショップ 1「企画」を再生」「会社紹介（動画 1） ブリッジワーク を再生」 */
export function myWorkPlayLabel(w) {
  return myWorkNameWith(w, "を再生");
}

/** 公開範囲を変える欄（select）の読み上げの名前：「動画 1 ワークショップ 1「企画」の公開範囲」 */
export function myWorkScopeLabel(w) {
  return myWorkNameWith(w, "の公開範囲");
}

/** 「公開」を選べない理由（1 行）。選べるなら null */
export function publicBlockedReason({ loginKind, consent }) {
  if (loginKind !== "google") return PUBLIC_BLOCKED_LINK;
  if (!consent || !consent.legalReviewed) return PUBLIC_BLOCKED_LEGAL;
  return null;
}

/** マイページの一覧の ？ の見出し（一覧の上に 1 つだけ。組 13 の U-13・D-1105-121x） */
export const MY_SCOPE_HELP_LABEL = "公開範囲";
/** 法務の確認の前で「公開」を選べないときの、？ の中の短い 1 行（一覧の行には出さない。判定は publicBlockedReason のまま。提出の窓の理由と同じ文） */
export const PUBLIC_NOT_YET = "「公開」は準備中です。";
/**
 * Google でログインしていないときの、？ の中の 1 行。？ の中（details）にはホバーが無いので、理由とホバーの文を続けて出す
 * （提出の窓と一覧の操作の断りは PUBLIC_BLOCKED_LINK とホバーのまま）
 */
export const PUBLIC_BLOCKED_LINK_HELP = `${PUBLIC_BLOCKED_LINK}${PUBLIC_BLOCKED_TIPS[PUBLIC_BLOCKED_LINK]}`;

/**
 * 一覧の ？ の中：3 つの範囲の名前と説明（提出の窓の 3 つの丸と同じ文。並びは一覧の選ぶ欄と同じ）と、「公開」を今は選べないときの理由（選べるなら null）。
 * 一覧の行には説明も理由も出さない（行を詰めるため。D-1105-121x。提出の窓は D-1104-130x-c のまま）
 */
export function myScopeHelp(ctx) {
  const blocked = publicBlockedReason(ctx);
  return {
    lines: ["public", "lecture", "private"].map((s) => `${SCOPE_CHOICE_LABELS[s]}：${SCOPE_CHOICE_NOTES[s]}`),
    note: blocked === PUBLIC_BLOCKED_LEGAL ? PUBLIC_NOT_YET : blocked === PUBLIC_BLOCKED_LINK ? PUBLIC_BLOCKED_LINK_HELP : blocked,
  };
}

const SCOPE_RANK = { private: 0, lecture: 1, public: 2 };

/**
 * 公開範囲を変えるときの流れ（設計 5.2）。種類（ワークショップ・ブリッジワーク）によらない（組 11。決定 A のあとの main の決め）。
 * - サーバーが変えられないとした作品（can_change_scope が偽）は変えられない。
 * - 狭める変更（公開→講義内・完全非公開、講義内→完全非公開）は確認だけ。
 * - 「公開」にする変更は、同意の文の全文とチェックの欄（Google のログインで、法務の確認済みの版があるときだけ）。
 * - 完全非公開→講義内は、社外には出ない変更なので確認だけ。
 * 戻り値：{ ok:false, reason } か { ok:true, kind: "narrow"|"widen"|"public", confirmLines, consent? }
 */
export function scopeChangePlan(work, next, ctx) {
  if (!SCOPES.includes(next) || next === work.scope) return { ok: false, reason: "公開範囲は変更されていません。" };
  if (!work.canChangeScope) return { ok: false, reason: SCOPE_FIXED_NOTE };
  if (next === "public") {
    const blocked = publicBlockedReason(ctx);
    if (blocked) return { ok: false, reason: blocked };
    // 題（「公開範囲を変更しますか？」）が範囲のことを言うので、本文は変更先だけ
    return { ok: true, kind: "public", confirmLines: [`「${SCOPE_LABELS.public}」に変更します。`], consent: ctx.consent };
  }
  const narrow = SCOPE_RANK[next] < SCOPE_RANK[work.scope];
  return { ok: true, kind: narrow ? "narrow" : "widen", confirmLines: [`「${SCOPE_LABELS[next]}」に変更します。`] };
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
  if (gb !== null) lines.push(`${gb} GB 以上の空き容量が必要です。`);
  return lines;
}

export const MSG_SCOPE_CHANGED = "公開範囲を変更しました。";
/** 見出し「提出した動画」の下に出るので「一覧」で通じる */
export const MSG_MY_WORKS_FAILED = "読み込みエラー：一覧を取得できません。";
export const MSG_MY_WORKS_BUSY = "混雑しています。\nしばらくしてから再度お試しください。";
export const MSG_MY_NETWORK = MSG_NETWORK_PRESS_AGAIN;
/** 404 のあとは一覧を読み直す（取り下げ・公開範囲の変更・送信のキャンセルのどれでも。mypage-submissions.js）ので、押し直しは勧めない */
export const MSG_MY_STALE = "動画の状態が更新されました。\n一覧を確認してください。";
/** コードを付ける断り（error-codes.md：E-SUB-50・E-WRK-99） */
export const MSG_MY_NOT_STAGE_STUDENT = "操作エラー：受講者として未登録です。\n講師・スタッフにお知らせください。";
export const MSG_MY_ACTION_FAILED = "操作エラーが発生しました。\nしばらくしてから再度お試しください。";
export const MSG_MY_PLAYBACK_FAILED = "再生エラーが発生しました。\nしばらくしてから再度お試しください。";
/** マイページの一覧の操作・再生の断りのコード（文 → コード。コードは文と別の値で持つ。決まり 3.2） */
const MY_ERROR_CODES = new Map([
  [MSG_MY_NOT_STAGE_STUDENT, "E-SUB-50"],
  [MSG_MEMBER_DISABLED, "E-LOG-50"],
  [MSG_MY_ACTION_FAILED, "E-WRK-99"],
  [MSG_MY_PLAYBACK_FAILED, "E-WRK-99"],
]);
/** myActionErrorText・myPlaybackErrorText の文に付けるコード（無ければ null） */
export function myErrorCode(text) {
  return MY_ERROR_CODES.get(text) ?? null;
}

/** マイページの操作の失敗（サーバーの拒否の名前 → 文。設計 4.11・5.2・A の約束 0.2 版 3 章） */
export function myActionErrorText(code, status) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  switch (code) {
    case "submission_busy":
      return "操作エラー：回の設定が変わりました。\n再度お試しください。";
    case "not_stage_student":
      return MSG_MY_NOT_STAGE_STUDENT;
    case "submission_closed":
      return "受付終了後は取り下げできません。";
    case "scope_fixed":
      return SCOPE_FIXED_NOTE;
    case "public_unavailable":
      return PUBLIC_BLOCKED_LEGAL;
    case "public_needs_google":
      return PUBLIC_BLOCKED_LINK;
    case "consent_outdated":
      return "同意の文が更新されました。\nページを再読み込みしてください。";
    case "member_disabled":
      return MSG_MEMBER_DISABLED;
    case "already_ready":
      return "この動画は提出済みです。";
    default:
      break;
  }
  if (status === 0) return MSG_MY_NETWORK;
  if (status === 404) return MSG_MY_STALE;
  if (status === 429 || status === 503) return MSG_MY_WORKS_BUSY;
  return MSG_MY_ACTION_FAILED;
}

/** 再生の失敗（マイページ） */
export function myPlaybackErrorText(code, status) {
  const paused = submissionsPauseText(code);
  if (paused) return paused;
  if (code === "cold_unavailable") return "この動画は現在再生できません。";
  if (status === 404) return "再生エラー：動画が見つかりません。";
  if (status === 0) return MSG_MY_NETWORK;
  return MSG_MY_PLAYBACK_FAILED;
}

/** 受講者に見える文の一覧（試験で D12 の言葉を確かめる） */
export function studentFacingTexts() {
  return [
    WITHDRAW_CONFIRM_LINE, MSG_WITHDRAWN, MSG_CANCELLED_UPLOAD, MY_WORKS_EMPTY, PUBLIC_BLOCKED_LEGAL, PUBLIC_BLOCKED_LINK, SCOPE_FIXED_NOTE,
    MSG_SCOPE_CHANGED, MSG_MY_WORKS_FAILED, MSG_MY_WORKS_BUSY, MSG_MY_NETWORK, MSG_MY_STALE, MSG_SUBMISSIONS_PAUSED, MSG_SUBMISSIONS_READ_PAUSED,
    ...["submission_busy", "not_stage_student", "submission_closed", "scope_fixed", "public_unavailable", "public_needs_google", "consent_outdated", "member_disabled", "already_ready", "x"].map((c) => myActionErrorText(c, 400)),
    myActionErrorText("x", 0), myActionErrorText("x", 404), myActionErrorText("x", 503), myPlaybackErrorText("cold_unavailable", 409), myPlaybackErrorText("x", 404), myPlaybackErrorText("x", 500),
    ...Object.values(SCOPE_LABELS), ...qrShortNote(1_200_000_000),
    MY_SCOPE_HELP_LABEL, PUBLIC_NOT_YET, PUBLIC_BLOCKED_LINK_HELP, ...Object.values(SCOPE_CHOICE_LABELS), ...Object.values(SCOPE_CHOICE_NOTES), ...Object.values(PUBLIC_BLOCKED_TIPS),
  ];
}

// =====================================================================
// 管理コンソールの「受け付けの終わり」（設計 6.3・2.3）
// =====================================================================

export const NO_DAY2_TEXT = "受付なし（回の日付が未設定）";
export const DEADLINE_RULE_TEXT = {
  workshop: "段階の間と、終了後 10 分",
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

/** 段階の「今の規則」の 1 行。手動の設定があれば「手動で設定：11/25 23:59 まで」。Day2 の日付が無ければ受け付けていない旨 */
export function deadlineRuleLine(stage, day2Date) {
  if (!day2Date) return NO_DAY2_TEXT;
  // 手動の設定はサーバーでは「含まない終わり」。入力・表示は最後の分にそろえる（「23:59」と入れたら、23:59 の間も受け付ける）
  if (stage.manualUntil) return `手動で設定：${formatShortDateTime(lastMinuteIso(stage.manualUntil))} まで`;
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

/** 保存済みの手動の設定（含まない終わり）→ 入力欄の値（最後の分。日本時間）。不正は "" */
export function inputValueFromDeadline(endIso) {
  const last = lastMinuteIso(endIso);
  return last ? jstLocalFromIso(last) : "";
}

export const DEADLINE_INPUT_HELP = "この時刻まで提出できます。";

/**
 * 手動の設定の入力を確かめる（設計 6.3・2.3）。最後に断るのは DB。
 * 入力は「最後の分」（例 23:59）。サーバーは「この時刻より前を受け付ける」（含まない終わり）なので、送る値は入力の 1 分あと
 * （23:59 と入れたら翌 0:00 を送る。日付をまたいでもよい）。これで、入力と表示の「23:59 まで」がそろう。
 * 戻り値：{ error, tip? } ＝ 保存できない（tip は error のホバーの文）／{ iso, confirm } ＝ 保存できる（iso は送る値。confirm があれば、過去の時刻なので確認を出す）
 */
export function deadlineProblem(localValue, { coldDueAt, nowMs = Date.now() }) {
  if (!String(localValue ?? "").trim()) return { error: "日時を入力してください。" };
  const typed = isoFromJstLocal(localValue);
  if (!typed) return { error: "日時の形式が正しくありません。" };
  const ms = Date.parse(typed) + MINUTE_MS;
  const iso = new Date(ms).toISOString();
  const coldMs = coldDueAt ? Date.parse(coldDueAt) : NaN;
  // サーバーは「回の終了から 7 日後（cold_due_at）以降」を断る。送る値で比べ、入力できる最後の日時を文に出す
  if (Number.isFinite(coldMs) && ms >= coldMs) return { error: `日時は ${formatShortDateTime(new Date(coldMs - 2 * MINUTE_MS).toISOString())} までです。`, tip: DEADLINE_COLD_TIP };
  // 確認の窓の題が「過去の日時です」なので、本文は結果だけ
  if (ms <= nowMs) return { iso, confirm: "保存すると、すぐに受付終了になります。" };
  return { iso, confirm: null };
}

export const MSG_DEADLINE_SAVED = "受付終了を保存しました。";
export const MSG_DEADLINE_RESET = "既定の規則に戻しました。";
export const DEADLINE_RESET_CONFIRM = "手動の設定を削除し、既定の規則に戻します。";

/** 変更の履歴の 1 行（from・to はサーバーでは「含まない終わり」。画面には最後の分で出す） */
export function deadlineEventLine(e) {
  const shown = (v) => (v ? formatShortDateTime(lastMinuteIso(v)) : "既定");
  const who = e.byEmail ? ` ${e.byEmail}` : "";
  return `${formatShortDateTime(e.at)}${who}：${shown(e.from)} → ${e.to ? shown(e.to) : "既定に戻した"}${e.note ? `（${e.note}）` : ""}`;
}

/** 日時が回の終了から 7 日後を過ぎたときの断りのホバー（サーバーは cold_due_at 以降を断る） */
export const DEADLINE_COLD_TIP = "回の終了から 7 日後より前の日時だけ保存できます。";
/** コードを付ける断り（error-codes.md：E-LOG-54・E-ADM-99・E-WRK-50・E-ADM-54。管理コンソールの文なので、マイページの文 → コードの表とは分ける） */
export const MSG_DEADLINE_ADMIN_ONLY = "権限エラー：管理者の権限がありません。\n再度ログインしてください。";
export const MSG_DEADLINE_FAILED = "保存エラーが発生しました。\nしばらくしてから再度お試しください。";
/** 提出の RPC が DB に無い（PGRST202・42883。公開前）。読み込みと保存の両方で出るので前置きは付けない（組 13 の文言の表 adm-1561） */
export const MSG_DEADLINE_RPC_MISSING = "サーバーの更新が未適用です。";
/** 読み込みの応答の形が違う・別の回の応答（adm-1564） */
export const MSG_DEADLINE_BAD_RESPONSE = "読み込みエラー：受付終了の応答が不正です。";
const DEADLINE_ERROR_CODES = new Map([
  [MSG_DEADLINE_ADMIN_ONLY, "E-LOG-54"],
  [MSG_DEADLINE_FAILED, "E-ADM-99"],
  [MSG_DEADLINE_RPC_MISSING, "E-WRK-50"],
  [MSG_DEADLINE_BAD_RESPONSE, "E-ADM-54"],
]);
/** deadlineErrorText の文に付けるコード（無ければ null） */
export function deadlineErrorCode(text) {
  return DEADLINE_ERROR_CODES.get(text) ?? null;
}

/** 手動の設定の保存の失敗（サーバーの拒否の名前 → 文） */
export function deadlineErrorText(code, status) {
  switch (code) {
    case "deadline_after_cold_due":
      return "日時は回の終了から 7 日後より前です。";
    case "cohort_dates_missing":
      // 札の文（NO_DAY2_TEXT）ではなく保存の失敗の文。DB は day2_date が無い回を断るので、2 行目は Day2
      return "保存エラー：回の日付が未設定です。\n先に Day2 の日付を入力してください。";
    case "admin_only":
      return MSG_DEADLINE_ADMIN_ONLY;
    default:
      break;
  }
  if (status === 0) return MSG_NETWORK_PRESS_AGAIN;
  return MSG_DEADLINE_FAILED;
}
