// マイページの「提出した作品」（docs/design-submissions.md 4.5・4.11・5.2）。出した作品の一覧・再生・取り下げ・公開範囲の変更・送っている途中の動画の［やめる］。
// mypage.js から使う：createMySubmissions({...}) を 1 つ作り、本人の画面を出すたびに refresh()、画面の中身を消すときに clear() を呼ぶ。
// 値の読み取り・判定は submissions-lib.js（試験は scripts/submissions_lib_test.mjs・scripts/mypage_submissions_nodetest.mjs）。
// 取り下げ・公開範囲の変更の可否はサーバーが返した値（can_withdraw・can_change_scope）だけを使い、画面は締切を解釈しない。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
import {
  MSG_CANCELLED_UPLOAD,
  MSG_MY_WORKS_FAILED,
  MSG_SCOPE_CHANGED,
  MSG_WITHDRAWN,
  MY_WORKS_EMPTY,
  myActionErrorText,
  myPlaybackErrorText,
  myWorkHeading,
  myWorkMeta,
  normalizeMyWorks,
  publicBlockedReason,
  SCOPE_LABELS,
  scopeChangePlan,
  WITHDRAW_CONFIRM_LINE,
  WORKSHOP_SCOPE_NOTE,
  formatShortDateTime,
} from "./submissions-lib.js";

const SCOPE_ORDER = ["public", "lecture", "private"];

/**
 * @param {object} o
 * @param {HTMLElement} o.group 区切りの枠全体（受講者でないとき・まだ読めていないときは隠す）
 * @param {HTMLElement} o.listEl 一覧を入れる所
 * @param {HTMLElement} [o.metaEl] 折りたたみの見出しの右の短い数（「2 本」）
 * @param {HTMLElement} o.statusEl 結果の知らせ（role=status）
 * @param {HTMLDialogElement} o.dialog 確認・同意・再生に使う <dialog>
 * @param {string} o.apiBase `submissions` 関数の基点（…/functions/v1/submissions）
 * @param {string} o.apiKey 公開用のキー
 * @param {() => Promise<{accountId: string, token: string} | null>} o.getSession 現在の本人IDとトークン（通知を待たず共有保存先を読み直す）
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createMySubmissions(o) {
  const fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  /** 世代。clear() だけで進め、進む前に始まった要求の応答は画面に入れない（ログアウト・別の人の画面を残さない） */
  let epoch = 0;
  /** 読み込みの通し番号。新しい読み込みを始めたら、古い読み込みの応答は捨てる（世代とは別。操作の途中で読み直しても、操作の世代は変わらない） */
  let refreshSeq = 0;
  let data = null;
  let busy = false;
  let loadedOnce = false;
  let ownerId = null;

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  };

  async function sessionNow() {
    try {
      const s = await o.getSession();
      return typeof s?.accountId === "string" && s.accountId && typeof s.token === "string" && s.token ? s : null;
    } catch { return null; }
  }

  async function ticketFor(allowRebind = false) {
    const my = epoch;
    const s = await sessionNow();
    if (my !== epoch) return null;
    if (!s) { clear(); return null; }
    if (ownerId !== s.accountId) {
      if (ownerId !== null || !allowRebind) {
        clear();
        if (!allowRebind) return null;
      }
      ownerId = s.accountId;
    }
    return { epoch, accountId: s.accountId };
  }

  async function current(ticket) {
    if (!ticket || ticket.epoch !== epoch) return null;
    const s = await sessionNow();
    if (ticket.epoch !== epoch) return null;
    if (!s || s.accountId !== ticket.accountId || ownerId !== ticket.accountId) { clear(); return null; }
    return s;
  }

  async function call(method, path, body, ticket) {
    const s = await current(ticket);
    if (!s) return null;
    let res;
    try {
      res = await fetchImpl(`${o.apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${s.token}`, apikey: o.apiKey, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
        referrerPolicy: "no-referrer",
        credentials: "omit",
      });
    } catch {
      if (!await current(ticket)) return null;
      return { ok: false, status: 0, code: "network", body: null };
    }
    const json = await res.json().catch(() => null);
    if (!await current(ticket)) return null;
    const code = json?.error?.code ?? (typeof json?.error === "string" ? json.error : null) ?? json?.code ?? null;
    return { ok: res.ok, status: res.status, code, body: json };
  }

  function say(text, tone = "ok") {
    o.statusEl.textContent = text;
    o.statusEl.className = tone === "error" ? "error-text" : "muted";
    o.statusEl.hidden = !text;
  }

  // ---- 確認・同意・再生の <dialog> ----

  /** 確認。ok なら true。extra：本文の下に足す部品、okEnabled：決定を押せるか（同意のチェックなど） */
  function ask({ title, lines, okText, extra = null, okDisabledUntil = null }) {
    const d = o.dialog;
    return new Promise((resolve) => {
      const ctl = new AbortController();
      const finish = (v) => {
        if (ctl.signal.aborted) return;
        ctl.abort();
        if (d.open) d.close();
        resolve(v);
      };
      const cancel = el("button", { type: "button", className: "btn", text: "やめる", autofocus: true, onclick: () => finish(false) });
      const ok = el("button", { type: "button", className: "btn primary", text: okText, onclick: () => finish(true) });
      if (okDisabledUntil) {
        ok.disabled = true;
        okDisabledUntil(ok);
      }
      d.className = "my-dialog";
      d.replaceChildren(el("div", { className: "my-dialog-body" }, el("h2", { text: title }), ...lines.map((t) => el("p", { text: t })), extra, el("div", { className: "row" }, cancel, ok)));
      d.addEventListener("cancel", (e) => (e.preventDefault(), finish(false)), { signal: ctl.signal });
      d.addEventListener("close", () => finish(false), { signal: ctl.signal });
      d.showModal();
      cancel.focus();
    });
  }

  // ---- 読み込み ----

  async function refresh(expectedTicket = null) {
    const seq = ++refreshSeq;
    const ticket = expectedTicket ? (await current(expectedTicket) ? expectedTicket : null) : await ticketFor(true);
    if (!ticket || seq !== refreshSeq) return;
    const my = ticket.epoch;
    if (!loadedOnce) {
      o.listEl.replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
      o.group.hidden = false;
    }
    const r = await call("GET", "/my/works", undefined, ticket);
    if (!r || my !== epoch || seq !== refreshSeq) return; // 通知未着の本人変更も、call の前後で照合する
    if (!r.ok) {
      // 受講者として登録されていない（講師・管理者など）：この枠は出さない
      if (r.status === 403 || r.code === "not_stage_student") {
        data = null;
        o.group.hidden = true;
        return;
      }
      if (!loadedOnce) {
        o.listEl.replaceChildren(el("p", { className: "error-text", text: MSG_MY_WORKS_FAILED }), el("button", { type: "button", className: "btn compact", text: "もう一度読み込む", onclick: () => void refresh() }));
      } else {
        say(MSG_MY_WORKS_FAILED, "error");
      }
      return;
    }
    const d = normalizeMyWorks(r.body);
    if (!d) {
      o.listEl.replaceChildren(el("p", { className: "error-text", text: MSG_MY_WORKS_FAILED }));
      return;
    }
    data = d;
    loadedOnce = true;
    o.group.hidden = false;
    render();
  }

  function setMeta(text) {
    if (o.metaEl) o.metaEl.textContent = text;
  }

  /** 本人のデータを画面から消す（ログアウト・画面を離れるとき。出ている要求の応答も捨てる） */
  function clear() {
    epoch += 1;
    data = null;
    loadedOnce = false;
    busy = false;
    ownerId = null;
    o.dialog.close?.();
    o.dialog.replaceChildren();
    o.listEl.replaceChildren();
    o.statusEl.textContent = "";
    o.statusEl.hidden = true;
    o.group.hidden = true;
    setMeta("");
  }

  // ---- 表示 ----

  function render() {
    if (!data) return;
    setMeta(data.works.length ? `${data.works.length} 本` : "");
    const parts = [];
    if (data.uploading.length) {
      parts.push(
        el(
          "div",
          { className: "my-block" },
          el("h3", { text: "送っている途中の動画" }),
          ...data.uploading.map((u) =>
            el(
              "div",
              { className: "my-row", "data-upload": u.workId },
              el("div", { className: "my-main" }, el("div", { className: "my-title", text: u.sourceLabel ?? "動画" }), el("div", { className: "muted small", text: `${u.stageLabel}${u.begunAt ? ` · ${formatShortDateTime(u.begunAt)} に開始` : ""}` })),
              el("button", { type: "button", className: "btn compact", "data-action": "cancel-upload", text: "やめる", disabled: busy, onclick: () => void cancelUpload(u) }),
            ),
          ),
        ),
      );
    }
    if (!data.works.length) parts.push(el("p", { className: "muted", text: MY_WORKS_EMPTY }));
    for (const w of data.works) parts.push(workRow(w));
    o.listEl.replaceChildren(...parts);
  }

  function workRow(w) {
    const actions = [el("button", { type: "button", className: "btn compact", "data-action": "play", text: "▶ 見る", onclick: () => void play(w) })];
    if (w.canWithdraw) actions.push(el("button", { type: "button", className: "btn compact", "data-action": "withdraw", text: "取り下げる", disabled: busy, onclick: () => void withdraw(w) }));
    const kids = [
      el("div", { className: "my-main" }, el("div", { className: "my-title", text: myWorkHeading(w) }), el("div", { className: "muted small", text: myWorkMeta(w) }), w.kind === "bridge" && w.purpose ? el("div", { className: "small", text: w.purpose }) : null),
      el("span", { className: `scope-badge ${w.scope}`, text: SCOPE_LABELS[w.scope] }),
      el("div", { className: "my-actions" }, ...actions),
    ];
    const row = el("div", { className: "my-row", "data-work": w.workId }, ...kids);
    if (w.kind === "bridge") {
      const scopeBox = scopeControl(w);
      if (scopeBox) row.append(scopeBox);
    } else {
      row.append(el("div", { className: "muted small my-scope-note", text: WORKSHOP_SCOPE_NOTE }));
    }
    return row;
  }

  /** ブリッジワークの公開範囲を変える欄（変えられないときは出さない。サーバーの can_change_scope に従う） */
  function scopeControl(w) {
    if (!w.canChangeScope) return null;
    const ctx = { loginKind: data.loginKind, consent: data.consent };
    const blocked = publicBlockedReason(ctx);
    const select = el(
      "select",
      { className: "input compact-select", "aria-label": `${myWorkHeading(w)} の公開範囲` },
      ...SCOPE_ORDER.map((s) => el("option", { value: s, text: SCOPE_LABELS[s], ...(s === w.scope ? { selected: true } : {}), ...(s === "public" && blocked ? { disabled: true } : {}) })),
    );
    const btn = el("button", { type: "button", className: "btn compact", "data-action": "scope", text: "公開範囲を変える", disabled: busy, onclick: () => void changeScope(w, select.value) });
    return el("div", { className: "my-scope" }, select, btn, blocked ? el("div", { className: "muted small", text: blocked }) : null);
  }

  // ---- 操作 ----

  async function guarded(ticket, fn) {
    if (busy || !await current(ticket) || busy) return; // 本人の再確認を待つ間に、ほかの操作が始まることがある
    busy = true;
    render();
    try {
      await fn();
    } finally {
      if (await current(ticket)) {
        busy = false;
        render();
      }
    }
  }

  async function withdraw(w) {
    const ticket = await ticketFor();
    if (!ticket) return;
    if (!(await ask({ title: "作品を取り下げます", lines: [WITHDRAW_CONFIRM_LINE], okText: "取り下げる" }))) return;
    await guarded(ticket, async () => {
      const r = await call("POST", `/my/works/${encodeURIComponent(w.workId)}/withdraw`, {}, ticket);
      if (!r) return;
      if (r.ok) {
        say(MSG_WITHDRAWN);
        await refresh(ticket);
      } else {
        say(myActionErrorText(r.code, r.status), "error");
        // 状態が変わっていた（受け付けが終わった・すでに取り下げた）ときは、最新を読み直す
        if (r.status === 404 || r.code === "submission_closed") await refresh(ticket);
      }
    });
  }

  async function changeScope(w, next) {
    const ticket = await ticketFor();
    if (!ticket) return;
    const plan = scopeChangePlan(w, next, { loginKind: data.loginKind, consent: data.consent });
    if (!plan.ok) {
      say(plan.reason, "error");
      return;
    }
    let extra = null;
    let gate = null;
    if (plan.kind === "public") {
      // 「公開」にする変更は、同意の文の全文とチェックの欄（Google のログインで、法務の確認済みの版があるときだけ。設計 5.2）
      const check = el("input", { type: "checkbox", id: "my-consent-check" });
      extra = el("div", { className: "my-consent" }, el("div", { className: "consent-body", text: plan.consent.body }), el("label", { className: "small" }, check, " 同意します"));
      gate = (okBtn) => check.addEventListener("change", () => (okBtn.disabled = !check.checked));
    }
    const yes = await ask({ title: "公開範囲を変えます", lines: plan.confirmLines, okText: "変える", extra, okDisabledUntil: gate });
    if (!yes) return;
    await guarded(ticket, async () => {
      const r = await call("POST", `/my/works/${encodeURIComponent(w.workId)}/scope`, { scope: next, ...(plan.kind === "public" ? { consent_text_id: plan.consent.id } : {}) }, ticket);
      if (!r) return;
      if (r.ok) {
        say(MSG_SCOPE_CHANGED);
        await refresh(ticket);
      } else {
        say(myActionErrorText(r.code, r.status), "error");
        if (r.status === 404 || r.code === "consent_outdated") await refresh(ticket);
      }
    });
  }

  async function cancelUpload(u) {
    const ticket = await ticketFor();
    if (!ticket) return;
    await guarded(ticket, async () => {
      const r = await call("POST", `/uploads/${encodeURIComponent(u.workId)}/cancel`, {}, ticket);
      if (!r) return;
      // すでに確定していた（409 already_ready）も、最新を読み直せば「出した作品」に出る
      if (r.ok || r.code === "already_ready") {
        say(r.ok ? MSG_CANCELLED_UPLOAD : myActionErrorText(r.code, r.status));
        await refresh(ticket);
      } else {
        say(myActionErrorText(r.code, r.status), "error");
      }
    });
  }

  async function play(w) {
    const ticket = await ticketFor();
    if (!ticket) return;
    const my = ticket.epoch;
    const msg = el("p", { className: "error-text small", role: "alert", hidden: true });
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.setAttribute("referrerpolicy", "no-referrer");
    video.className = "my-video";
    const close = el("button", { type: "button", className: "btn", text: "閉じる", onclick: () => o.dialog.close() });
    const d = o.dialog;
    d.className = "my-dialog";
    d.replaceChildren(el("div", { className: "my-dialog-body" }, el("h2", { text: myWorkHeading(w) }), video, msg, el("div", { className: "row" }, close)));
    d.addEventListener(
      "close",
      () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
        d.replaceChildren();
      },
      { once: true },
    );
    d.showModal();
    const get = async () => {
      const r = await call("POST", "/my/playback", { work_id: w.workId }, ticket);
      if (!r) return null;
      if (!r.ok || typeof r.body?.url !== "string") throw new Error(myPlaybackErrorText(r.code, r.status));
      return r.body.url;
    };
    try {
      const url = await get();
      if (!url || my !== epoch || !d.open) return;
      video.src = url;
    } catch (e) {
      if (my === epoch) {
        msg.textContent = e instanceof Error ? e.message : myPlaybackErrorText(null, 500);
        msg.hidden = false;
      }
      return;
    }
    // 再生中に URL が切れたら、取り直して同じ位置から続ける（1 回だけ）
    let retried = false;
    video.addEventListener("error", () => {
      if (retried || !video.currentSrc) return;
      retried = true;
      const at = video.currentTime;
      void get()
        .then((url) => {
          if (!url || my !== epoch || !d.open) return;
          video.src = url;
          video.currentTime = at;
        })
        .catch((e) => {
          if (my !== epoch || !d.open) return;
          msg.textContent = e instanceof Error ? e.message : myPlaybackErrorText(null, 500);
          msg.hidden = false;
        });
    });
  }

  return { refresh, clear, _state: () => ({ epoch, busy, data }) };
}
