// 管理コンソールの［fal の確かめ］（docs/design-fal-price-watch.md 第 1.4.1 版 2.6・3.7）。
// 画面の上（main.content の先頭）に常設の 1 行と帯を差し込み、押すと自分の <dialog> で一覧（5 つのつまみ）を開く。
// admin.js の内部の状態には依存しない。受け取るのは Supabase の client と、差し込む親の要素と、閉じたかを返す関数（isClosed）だけ
// （admin.js の入口は数行の独立の差分）。管理コンソールが閉じたら（isClosed が真・host が外れた・#app が隠れた）、開いている窓を閉じて消し、
// 常設の 1 行と読んだ中身（メールを含む）も消す。閉じたあとに戻った遅い読み込みは描かない（世代の確かめ。Codex TASK-0237 F237-01）。
// 表示はすべて createElement / textContent で組み立てる（データを innerHTML に入れない）。読み込みは DB の admin_fal_watch_summary
// （中で is_admin()）、［確かめた］は admin_fal_watch_ack（知らせを閉じるだけ。突き合わせの表の判定・保留は変えない）。
import {
  actualCreditsText,
  ALERT_KIND_LABELS,
  billingRowStatus,
  breakableEndpoint,
  CHANGE_LABELS,
  creditsOf,
  FOOT_NOTES,
  jstText,
  moreText,
  nanoUsdText,
  OUTCOME_LABELS,
  ratioText,
  RUN_KIND_LABELS,
  summarize,
  VERDICT_LABELS,
} from "./admin-fal-watch-lib.js";

const STYLE_ID = "fal-watch-style";
const CSS = `
.fw-wrap { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; }
.fw-band { border: 1px solid var(--warn-line, #E5D7C5); background: var(--warn-bg, #F5EFE7); color: var(--warn-fg, #74512C);
  border-radius: 12px; padding: 8px 12px; font-size: 13px; }
.fw-band ul { margin: 0; padding-left: 18px; }
.fw-band .fw-warn { font-weight: 600; }
.fw-line { all: unset; cursor: pointer; display: block; padding: 8px 12px; border: 1px solid var(--line, #E3E6EB); border-radius: 12px;
  background: var(--surface, #fff); color: var(--text-2, #4A505B); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.fw-line:focus-visible { outline: 2px solid var(--accent, #26396E); outline-offset: 2px; }
.fw-line .fw-title { font-weight: 700; color: var(--text, #16181D); margin-right: 6px; }
.fw-line.fw-ok .fw-title { color: var(--ok-fg, #3D5B45); }
dialog.fw-dialog { width: min(1100px, 96vw); max-height: 90vh; padding: 0; border: 1px solid var(--line, #E3E6EB);
  border-radius: 16px; background: var(--surface, #fff); color: var(--text, #16181D); }
dialog.fw-dialog::backdrop { background: var(--scrim, rgba(26, 30, 38, 0.62)); }
.fw-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line, #E3E6EB); }
.fw-head h2 { margin: 0; font-size: 16px; flex: 1; }
.fw-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px 0; }
.fw-tabs button { min-height: 34px; padding: 0 12px; border-radius: 17px; border: 1px solid var(--line-2, #DDE1E7);
  background: var(--surface, #fff); font: inherit; font-size: 13px; cursor: pointer; }
.fw-tabs button[aria-selected="true"] { background: var(--accent, #26396E); color: var(--on-accent, #fff); border-color: var(--accent, #26396E); }
.fw-body { padding: 10px 16px 16px; overflow: auto; max-height: 64vh; }
.fw-body table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.fw-body th, .fw-body td { border-bottom: 1px solid var(--line-soft, #EEF0F3); padding: 6px 8px; text-align: left; vertical-align: top;
  overflow-wrap: anywhere; }
.fw-body th { color: var(--muted, #4C525F); font-weight: 600; position: sticky; top: 0; background: var(--surface, #fff); }
.fw-body .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fw-body .fw-more { color: var(--muted, #4C525F); margin: 8px 0 0; }
.fw-body h3 { font-size: 14px; margin: 14px 0 6px; }
.fw-foot { padding: 8px 16px 14px; color: var(--muted, #4C525F); font-size: 12px; border-top: 1px solid var(--line, #E3E6EB); }
.fw-foot p { margin: 2px 0; }
.fw-ack { display: flex; gap: 6px; align-items: center; }
.fw-ack input { min-width: 0; flex: 1; height: 30px; border: 1px solid var(--input-line, #C9CED6); border-radius: 8px; padding: 0 8px; font: inherit; }
.fw-ack button, .fw-head button { min-height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line-2, #DDE1E7);
  background: var(--surface, #fff); font: inherit; font-size: 12.5px; cursor: pointer; }
.fw-err { color: var(--danger, #96413A); }
`;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "className") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

function table(headers, rows) {
  const t = el("table");
  const tr = el("tr");
  for (const h of headers) tr.append(el("th", { scope: "col", className: h.num ? "num" : undefined, text: h.label }));
  t.append(el("thead", {}, tr));
  const body = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    for (let i = 0; i < headers.length; i++) {
      const v = r[i];
      const td = el("td", { className: headers[i].num ? "num" : undefined });
      if (v instanceof Node) td.append(v);
      else td.textContent = v === null || v === undefined || v === "" ? "—" : String(v);
      row.append(td);
    }
    body.append(row);
  }
  t.append(body);
  return t;
}

const TABS = [
  { key: "price", label: "単価" },
  { key: "recent", label: "請求（直近 8 日）" },
  { key: "past", label: "期間を過ぎた未確認" },
  { key: "unmatched", label: "照合できない生成・請求" },
  { key: "runs", label: "実行の記録" },
  { key: "alerts", label: "知らせ" },
];

/** 閉じたかを確かめる間隔（ミリ秒） */
const CLOSE_CHECK_MS = 300;

/**
 * 常設の 1 行と帯を host（main.content）の先頭に差し込み、読み込む。返り：{ reload, dispose }
 * 読めなかったときは 1 行に誤りを出す（ほかの画面は止めない）
 * @param {{ supabase: any, host: any, isClosed?: () => boolean }} opts
 */
export async function mountFalWatch({ supabase, host, isClosed }) {
  if (!host || !supabase) return { reload: async () => {}, dispose: () => {} };
  if (!document.getElementById(STYLE_ID)) document.head.append(el("style", { id: STYLE_ID, text: CSS }));
  const wrap = el("section", { className: "fw-wrap", "aria-label": "fal の確かめ" });
  const band = el("div", { className: "fw-band", role: "status", hidden: true });
  const line = el("button", { type: "button", className: "fw-line", "aria-haspopup": "dialog" });
  wrap.append(band, line);
  host.prepend(wrap);

  const dialog = el("dialog", { className: "fw-dialog", "aria-labelledby": "fw-title" });
  const body = el("div", { className: "fw-body" });
  const tabs = el("div", { className: "fw-tabs", role: "tablist", "aria-label": "一覧の分類" });
  const closeBtn = el("button", { type: "button", text: "閉じる", onclick: () => dialog.close() });
  const reloadBtn = el("button", { type: "button", text: "読み直す", onclick: () => reload() });
  dialog.append(
    el("div", { className: "fw-head" }, el("h2", { id: "fw-title", text: "fal の確かめ" }), reloadBtn, closeBtn),
    tabs,
    body,
    el("div", { className: "fw-foot" }, ...FOOT_NOTES.map((t) => el("p", { text: t }))),
  );
  document.body.append(dialog);

  let summary = null;
  let tab = "price";
  const views = {};
  let disposed = false;
  let gen = 0;
  let observer;

  /** 閉じる：窓を閉じて消し、常設の 1 行と読んだ中身も消す。何度呼んでもよい */
  function dispose() {
    if (disposed) return;
    disposed = true;
    gen++;
    clearInterval(timer);
    observer?.disconnect();
    if (dialog.open) dialog.close();
    body.replaceChildren();
    dialog.remove();
    wrap.remove();
    summary = null;
    for (const k of Object.keys(views)) delete views[k];
  }
  /** 管理コンソールが閉じた（isClosed が真）・差し込んだ所が外れた・#app が隠れたら閉じる */
  function checkClosed() {
    if (disposed) return true;
    const app = typeof host.closest === "function" ? host.closest("#app") : null;
    if ((typeof isClosed === "function" && isClosed()) || !host.isConnected || !wrap.isConnected || app?.hidden) dispose();
    return disposed;
  }
  const timer = setInterval(checkClosed, CLOSE_CHECK_MS);
  const app = typeof host.closest === "function" ? host.closest("#app") : null;
  if (app && typeof MutationObserver === "function") {
    observer = new MutationObserver(() => checkClosed());
    observer.observe(app, { attributes: true, attributeFilter: ["hidden"] });
  }

  const load = async (view) => {
    const { data, error } = await supabase.rpc("admin_fal_watch_summary", { p_view: view });
    if (error) throw new Error(error.message || "読み込めませんでした");
    return data;
  };

  function renderLine() {
    if (!summary) return;
    const s = summarize(summary);
    line.replaceChildren(el("span", { className: "fw-title", text: "［fal の確かめ］" }), s.line);
    line.classList.toggle("fw-ok", s.allVerified);
    if (s.band.length) {
      const ul = el("ul");
      for (const b of s.band) ul.append(el("li", { className: b.level === "warn" ? "fw-warn" : undefined, text: b.text }));
      band.replaceChildren(ul);
      band.hidden = false;
    } else {
      band.replaceChildren();
      band.hidden = true;
    }
  }

  function billingTable(data) {
    const rows = (data?.rows ?? []).map((r) => [
      jstText(r.job_created_at),
      r.user_email ?? "消えたジョブ",
      r.model_key,
      billingRowStatus(r),
      r.estimated_cost_usd == null ? "—" : `$${r.estimated_cost_usd}`,
      r.estimated_cost_usd == null ? "—" : creditsOf(r.estimated_cost_usd),
      nanoUsdText(r.billed_nano_usd),
      actualCreditsText(r.billed_nano_usd),
      ratioText(r.billed_nano_usd, r.estimated_cost_usd),
      r.event_count,
    ]);
    const frag = document.createDocumentFragment();
    frag.append(table([
      { label: "日時" },
      { label: "利用者" },
      { label: "モデル" },
      { label: "状態" },
      { label: "見積り", num: true },
      { label: "引いたクレジット", num: true },
      { label: "実費", num: true },
      { label: "実費のクレジット換算", num: true },
      { label: "比", num: true },
      { label: "行の数", num: true },
    ], rows));
    const more = moreText(data?.rows_total, rows.length);
    if (more) frag.append(el("p", { className: "fw-more", text: more }));
    return frag;
  }

  async function renderTab() {
    if (checkClosed()) return;
    const myGen = gen;
    // このときのつまみを固定する。読み込みの控え（views）の鍵にも、描くかの判定にもこれを使う。待っている間にほかのつまみへ
    // 移ったら、戻った応答は控えにだけ入れて、今のつまみは描き換えない（Codex TASK-0238 F238-01）
    const requested = tab;
    const stale = () => disposed || myGen !== gen;
    const moved = () => tab !== requested;
    for (const b of tabs.children) {
      const on = b.dataset.key === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    if (!summary) return;
    if (requested === "price") {
      const rows = (summary.price?.rows ?? []).map((p) => [
        breakableEndpoint(p.endpoint_id),
        `${p.model_key ?? "—"}${p.route_active === false ? "（使っていない経路）" : ""}`,
        p.base_usd == null ? "参照の式" : `${p.base_usd} / ${p.base_unit}${p.base_conditional ? `（条件つき・最大 ${p.base_max_usd}）` : ""}`,
        p.api_unit_price == null ? "—" : `${p.api_unit_price} ${p.api_currency ?? ""} / ${p.api_unit ?? ""}`,
        VERDICT_LABELS[p.verdict] ?? p.verdict,
        `${CHANGE_LABELS[p.change] ?? p.change}${p.change_compared_on ? `（${p.change_compared_on} と比べた）` : ""}`,
        p.reason,
      ]);
      body.replaceChildren(
        el("p", { className: "fw-more", text: `記録の日：${summary.price?.checked_on ?? "まだ無い"}` }),
        table([
          { label: "endpoint" },
          { label: "モデル" },
          { label: "基準" },
          { label: "API の値" },
          { label: "手元の表との照合" },
          { label: "API の値の変化" },
          { label: "理由" },
        ], rows),
      );
      return;
    }
    if (requested === "recent" || requested === "past") {
      if (!views[requested]) {
        body.replaceChildren(el("p", { text: "読み込んでいます…" }));
        try {
          const v = requested === "recent" ? summary : await load("past");
          if (stale()) return;
          views[requested] = v;
        } catch (e) {
          if (stale() || moved()) return;
          body.replaceChildren(el("p", { className: "fw-err", text: `読み込めませんでした：${e.message}` }));
          return;
        }
        if (moved()) return;
      }
      body.replaceChildren(billingTable(views[requested]));
      return;
    }
    if (requested === "unmatched") {
      if (!views.excluded) {
        try {
          const v = await load("excluded");
          if (stale()) return;
          views.excluded = v;
          if (moved()) return;
        } catch (e) {
          if (stale() || moved()) return;
          body.replaceChildren(el("p", { className: "fw-err", text: `読み込めませんでした：${e.message}` }));
          return;
        }
      }
      const orphans = (summary.orphans ?? []).map((o) => [
        o.billed_on,
        breakableEndpoint(o.endpoint_id),
        o.request_id,
        nanoUsdText(o.billed_nano_usd) + (o.nano_problem ? `（${o.nano_problem}）` : ""),
        o.event_count,
        o.same_day_no_request_id,
        o.pending_relink ? "付け替え待ち" : "",
      ]);
      const norid = (summary.no_request_id ?? []).map((r) => [
        jstText(r.job_created_at),
        r.user_email ?? "消えたジョブ",
        breakableEndpoint(r.endpoint_id),
        r.job_status,
        r.submit_outcome,
        r.past_window ? "期間を過ぎた" : "",
      ]);
      body.replaceChildren(
        el("h3", { text: "照合できない請求（どのジョブにも当たらない請求）" }),
        table([
          { label: "日（JST）" },
          { label: "endpoint" },
          { label: "request_id" },
          { label: "実費", num: true },
          { label: "行の数", num: true },
          { label: "同じ日・endpoint の照合できない生成", num: true },
          { label: "印" },
        ], orphans),
        el("p", { className: "fw-more", text: moreText(summary.orphans_total, orphans.length) }),
        el("h3", { text: "照合できない生成（request_id の無い生成）" }),
        table([
          { label: "日時" },
          { label: "利用者" },
          { label: "endpoint" },
          { label: "ジョブの状態" },
          { label: "投入の結果" },
          { label: "印" },
        ], norid),
        el("p", { className: "fw-more", text: moreText(summary.no_request_id_total, norid.length) }),
        el("h3", { text: "対象の外（投入していないと記録した生成）" }),
        billingTable(views.excluded),
      );
      return;
    }
    if (requested === "runs") {
      const rows = (summary.runs ?? []).map((r) => [
        jstText(r.started_at),
        RUN_KIND_LABELS[r.kind] ?? r.kind,
        OUTCOME_LABELS[r.outcome] ?? r.outcome,
        r.job_window_from ? `${jstText(r.job_window_from)}〜${jstText(r.job_window_to)}` : "—",
        r.billing_window_from ? `${jstText(r.billing_window_from)}〜${jstText(r.billing_window_to)}` : "—",
        r.segments,
        r.pages,
        r.detail?.reason ?? "",
      ]);
      body.replaceChildren(table([
        { label: "開始" },
        { label: "種類" },
        { label: "結果" },
        { label: "ジョブの期間" },
        { label: "請求の期間" },
        { label: "区間", num: true },
        { label: "ページ", num: true },
        { label: "理由" },
      ], rows));
      return;
    }
    // 知らせ（確かめていないもの）と［確かめた］
    const rows = (summary.alerts ?? []).map((a) => {
      const note = el("input", { type: "text", maxlength: 200, "aria-label": "メモ（200 字まで）", placeholder: "メモ（任意）" });
      const btn = el("button", { type: "button", text: "確かめた" });
      const msg = el("span", { role: "status" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const { data, error } = await supabase.rpc("admin_fal_watch_ack", { p_alert_id: a.id, p_note: note.value || null });
        if (disposed) return;
        if (error) {
          msg.textContent = `できませんでした：${error.message || ""}`;
          msg.className = "fw-err";
          btn.disabled = false;
          return;
        }
        msg.textContent = data ? "確かめました" : "すでに確かめ済みです";
        await reload();
      });
      return [
        a.severity === "warn" ? "警告" : "注意",
        ALERT_KIND_LABELS[a.kind] ?? a.kind,
        breakableEndpoint(a.subject),
        jstText(a.last_seen_at),
        el("div", { className: "fw-ack" }, note, btn, msg),
      ];
    });
    body.replaceChildren(table([
      { label: "重さ" },
      { label: "種類" },
      { label: "対象" },
      { label: "最後に見た" },
      { label: "［確かめた］（知らせを閉じるだけ。判定・保留は変わりません）" },
    ], rows));
  }

  for (const t of TABS) {
    const b = el("button", { type: "button", role: "tab", text: t.label });
    b.dataset.key = t.key;
    b.addEventListener("click", () => {
      tab = t.key;
      renderTab();
    });
    tabs.append(b);
  }
  line.addEventListener("click", () => {
    if (checkClosed()) return;
    renderTab();
    if (!dialog.open) dialog.showModal();
  });

  async function reload() {
    if (checkClosed()) return;
    const myGen = ++gen;
    try {
      const data = await load("recent");
      // 閉じたあと・新しい読み込みのあとに戻った古い応答は描かない
      if (disposed || myGen !== gen) return;
      summary = data;
      for (const k of Object.keys(views)) delete views[k];
      renderLine();
      if (dialog.open) await renderTab();
    } catch (e) {
      if (disposed || myGen !== gen) return;
      line.replaceChildren(
        el("span", { className: "fw-title", text: "［fal の確かめ］" }),
        el("span", { className: "fw-err", text: `読み込めませんでした：${e.message}` }),
      );
    }
  }
  line.replaceChildren(el("span", { className: "fw-title", text: "［fal の確かめ］" }), "読み込んでいます…");
  await reload();
  return { reload, dispose };
}
