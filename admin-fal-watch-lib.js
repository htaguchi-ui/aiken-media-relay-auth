// 管理コンソールの［fal の確かめ］（docs/design-fal-price-watch.md 第 1.4.1 版 2.6・3.7）の、画面に依存しない純粋な関数。
// admin-fal-watch.js が使う。入力は DB の admin_fal_watch_summary の返り（jsonb）。DOM には触らない（試験は scripts/admin_fal_watch_lib_test.ts）。
// 約束：
// - 警告が 0 件でも、未確認・未着・照合できない生成・照合できない請求（付け替え待ちを含む）・保留・期間を過ぎた未確認・一度も確かめていない・
//   取り切れなかった回・途中で止まった回・止まっている（36 時間）が 1 つでもあれば「全部確かめ済み」とは出さない。
// - 帯に出すのは警告と注意だけ（lower・under_list・使っていない経路は出さない）。
// - 「引いたクレジット」は mcp/models.ts の creditsOf と同じ式（ceil(round(usd × 100, 6))）。「実費のクレジット換算」は切り上げない。円は出さない。

/** 見積額（USD）→ 引いたクレジット：ceil(round(usd × 100, 6))。0 以下・数でなければ 0（mcp/models.ts の creditsOf と同じ式） */
export function creditsOf(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(Math.round(n * 100 * 1e6) / 1e6);
}

/** 実費（nano USD）→ クレジット換算の文字（A ÷ 10,000,000 を小数 4 桁まで。切り上げない）。読めなければ "—" */
export function actualCreditsText(nano) {
  if (nano === null || nano === undefined || nano === "") return "—";
  const s = String(nano);
  if (!/^\d+$/.test(s)) return "—";
  const v = BigInt(s);
  const whole = v / 10_000_000n;
  const frac = (v % 10_000_000n) / 1000n; // 4 桁（切り捨て）
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

/** 実費（nano USD）→ USD の文字（小数 9 桁までの正確な表記。末尾の 0 は落とす） */
export function nanoUsdText(nano) {
  if (nano === null || nano === undefined || nano === "") return "—";
  const s = String(nano);
  if (!/^\d+$/.test(s)) return "—";
  const v = BigInt(s);
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `$${v / 1_000_000_000n}${frac ? "." + frac : ""}`;
}

/** 比（A ÷ E）。どちらかが無い・E が 0 なら "—" */
export function ratioText(nano, estimateUsd) {
  const a = Number(nano), e = Number(estimateUsd) * 1e9;
  if (nano === null || nano === undefined || !Number.isFinite(a) || !Number.isFinite(e) || e <= 0) return "—";
  return (a / e).toFixed(3);
}

/** 長い endpoint 名を「/」のあとで折り返せるようにする（ゼロ幅の空白を入れる。表示だけ） */
export function breakableEndpoint(id) {
  return String(id ?? "").replace(/\//g, "/​");
}

/** ISO の時刻 → JST の「M/D HH:MM」。読めなければ "—" */
export function jstText(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t + 9 * 3_600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const VERDICT_LABELS = {
  same: "同じ",
  higher: "高い（警告）",
  lower: "低い（情報）",
  unverified: "未確認（条件つき）",
  not_comparable: "比べられない",
  missing: "応答に無い（警告）",
};
export const CHANGE_LABELS = { first: "初回", unchanged: "変化なし", changed: "変わった（警告）" };
export const STATE_LABELS = {
  pending: "未着",
  matched: "照合済み",
  unresolved: "未確認のまま終了",
  no_request_id: "照合できない生成",
  excluded: "対象の外",
};
export const BILLING_VERDICT_LABELS = {
  ok: "見積り以下",
  under_list: "見積り以下（定価では超える：情報）",
  over: "見積りを超えた（警告）",
  review: "金額の保留",
};
export const HOLD_LABELS = { id_changed: "照合の保留（request_id が変わった）", id_shared: "照合の保留（request_id が重なる）" };
export const OUTCOME_LABELS = {
  running: "実行中",
  committed: "反映済み",
  superseded: "追い越された",
  incomplete: "取り切れなかった",
  failed: "失敗",
  abandoned: "途中で止まった",
};
export const RUN_KIND_LABELS = { price: "単価", billing: "請求（定期）", billing_recent: "請求（確かめの日）", billing_recheck: "請求（見直し）" };
export const ALERT_KIND_LABELS = {
  price_higher: "単価が基準より高い",
  price_changed: "単価が変わった",
  price_missing: "単価の応答に無い",
  billing_over: "請求が見積りを超えた",
  billing_on_excluded: "投入していないと記録した生成に請求",
  run_failed: "取り切れなかった・失敗した回",
  run_stale: "止まっている",
  run_abandoned: "途中で止まった回",
  billing_review: "金額の保留",
  billing_hold: "照合の保留",
  billing_orphan: "照合できない請求",
  billing_never_checked: "一度も確かめていない",
  billing_out_of_window: "請求の期間の外の行（使わずに数えた）",
};

/** 一覧の 1 行の状態の文（状態・判定・保留・印を 1 つの文に） */
export function billingRowStatus(r) {
  const parts = [STATE_LABELS[r.state] ?? String(r.state)];
  if (r.state === "excluded" && r.event_count != null) parts.push("請求あり（警告）");
  if (r.verdict) parts.push(BILLING_VERDICT_LABELS[r.verdict] ?? r.verdict);
  if (r.verdict_reason) parts.push(`理由：${r.verdict_reason}`);
  if (r.subtotal_unknown) parts.push("定価は不明");
  if (r.hold_reason) parts.push(HOLD_LABELS[r.hold_reason] ?? r.hold_reason);
  if (r.never_checked) parts.push("一度も確かめていない");
  if (r.past_window) parts.push("期間を過ぎた");
  return parts.join("・");
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 直近 36 時間の、取り切れなかった・失敗・途中で止まった回の数（実行の記録の一覧から） */
export function troubledRuns(summary, now = Date.now()) {
  return (summary?.runs ?? []).filter((r) =>
    ["incomplete", "failed", "abandoned"].includes(r.outcome) && now - Date.parse(r.started_at) <= 36 * 3_600_000
  ).length;
}

/**
 * 常設の 1 行と帯の中身。返り：{ line, allVerified, band: [{level, text}] }
 * level は warn（警告）か notice（注意）
 */
export function summarize(summary, now = Date.now()) {
  const pc = summary?.price?.counts ?? {};
  const b = summary?.billing ?? {};
  const rc = b.recent ?? {};
  const priceVerified = n(pc.same);
  // 1 行を 1 回だけ数えた件数（DB の unverified_rows・warn_rows）を使う。first はほかの判定と重なるので足さない（Codex TASK-0237 F237-07）。
  // 古い形の返り（件数が無い）のときだけ、重ならない範囲の足し算にする
  const priceUnverified = pc.unverified_rows !== undefined
    ? n(pc.unverified_rows)
    : n(pc.unverified) + n(pc.not_comparable) + n(pc.lower);
  const priceWarn = pc.warn_rows !== undefined ? n(pc.warn_rows) : n(pc.higher) + n(pc.missing) + n(pc.changed);
  const orphans = n(summary?.orphans_total);
  const relink = n(summary?.orphans_pending_relink);
  const billingWarn = n(rc.over) + n(rc.billing_on_excluded);
  const hold = n(b.hold_total);
  const review = n(rc.review);
  const pastUnverified = n(b.past_unverified);
  const neverChecked = n(b.never_checked);
  const troubled = troubledRuns(summary, now);
  const priceStale = !!summary?.price?.stale;
  const billingStale = !!summary?.billing?.stale;

  const band = [];
  if (priceStale) band.push({ level: "warn", text: "単価の見張りが止まっています（36 時間より前から反映がありません）" });
  if (billingStale) band.push({ level: "warn", text: "請求の突き合わせが止まっています（36 時間より前から反映がありません）" });
  if (n(pc.higher)) band.push({ level: "warn", text: `単価が基準より高い：${n(pc.higher)}` });
  if (n(pc.missing)) band.push({ level: "warn", text: `単価の応答に無い：${n(pc.missing)}` });
  if (n(pc.changed)) band.push({ level: "warn", text: `単価が変わった：${n(pc.changed)}` });
  if (n(rc.over)) band.push({ level: "warn", text: `請求が見積りを超えた：${n(rc.over)}` });
  if (n(rc.billing_on_excluded)) band.push({ level: "warn", text: `投入していないと記録した生成に請求：${n(rc.billing_on_excluded)}` });
  if (review) band.push({ level: "notice", text: `金額の保留：${review}` });
  if (hold) band.push({ level: "notice", text: `照合の保留：${hold}` });
  if (orphans) band.push({ level: "notice", text: `照合できない請求：${orphans}${relink ? `（うち付け替え待ち ${relink}）` : ""}` });
  if (neverChecked) band.push({ level: "notice", text: `一度も確かめていない：${neverChecked}` });
  if (troubled) band.push({ level: "notice", text: `取り切れなかった・途中で止まった回（直近 36 時間）：${troubled}` });
  // 開いている（確かめていない）「請求の期間の外の行」の知らせ。fal がその回の期間の外の行を返した＝読み方の前提が崩れている疑い
  const outOfWindow = (summary?.alerts ?? []).filter((a) => a?.kind === "billing_out_of_window");
  if (outOfWindow.length) {
    const rows = outOfWindow.reduce((t, a) => t + n(a?.detail?.out_of_window_rows), 0);
    band.push({ level: "notice", text: `請求の期間の外の行（使わずに数えた）：${rows}（知らせ ${outOfWindow.length}）` });
  }

  const allVerified = band.length === 0 && priceUnverified === 0 && n(pc.first) === 0 && n(rc.pending) === 0 && n(rc.no_request_id) === 0 &&
    pastUnverified === 0 && orphans === 0 && n(pc.total) > 0 && !!summary?.price?.last_committed_at &&
    !!summary?.billing?.last_committed_at;

  const line = [
    `単価：確かめ済み ${priceVerified}・未確認 ${priceUnverified}・警告 ${priceWarn}・使っていない経路 ${n(pc.inactive_route)}`,
    `請求（直近 8 日）：一致 ${n(rc.ok) + n(rc.under_list)}・未着 ${n(rc.pending)}・照合できない生成 ${n(rc.no_request_id)}・照合できない請求 ${orphans}・保留 ${hold + review}・警告 ${billingWarn}`,
    `期間を過ぎた未確認 ${pastUnverified}`,
    `最後の反映 ${jstText(summary?.price?.last_committed_at)}・${jstText(summary?.billing?.last_committed_at)}`,
  ].join(" ／ ");
  return { line: allVerified ? `全部確かめ済み ／ ${line}` : line, allVerified, band };
}

/** 画面の下に書く注意（設計 3.7） */
export const FOOT_NOTES = [
  "API の値が変わっていないことは、API に出ない条件の料金が変わっていないことまでは示しません。",
  "未着・照合できない・未確認で終了は、請求が無いという意味ではありません。",
  "見積りより安い請求・単価は、割引の有無が分からないため知らせません。",
  "照合の保留は、今は画面から解けません（［確かめた］はメモを残すだけです）。",
  "付け替え待ちの請求は、その時期を見直すまで照合できない請求に残ります。",
];

/** 一覧が 300 行で切れたときの文（件数は表の全体から） */
export function moreText(total, shown) {
  const rest = n(total) - n(shown);
  return rest > 0 ? `ほかに ${rest} 件（全体 ${n(total)} 件）` : "";
}
