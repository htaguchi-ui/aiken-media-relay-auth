// マイページの「提出した動画」（docs/design-submissions.md 4.5・4.11・5.2）。出した作品の一覧・再生・取り下げ・公開範囲の変更・送信中の動画の［キャンセル］。
// mypage.js から使う：createMySubmissions({...}) を 1 つ作り、本人の画面を出すたびに refresh()、約 10 秒の読み直しでは refresh({ quiet: true })、
// 画面の中身を消すときに clear() を呼ぶ。refresh の返り値は "ok" | "fail" | "skip"（読み直しの部品 poll-lib.js に渡す）。
// 値の読み取り・判定は submissions-lib.js（試験は scripts/submissions_lib_test.mjs・scripts/mypage_submissions_nodetest.mjs）。
// 取り下げ・公開範囲の変更の可否はサーバーが返した値（can_withdraw・can_change_scope）だけを使い、画面は締切を解釈しない。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
import {
  errorCodeLabel,
  MSG_CANCELLED_UPLOAD,
  MSG_MY_WORKS_FAILED,
  MSG_SCOPE_CHANGED,
  MSG_WITHDRAWN,
  MY_WORKS_EMPTY,
  myActionErrorText,
  myErrorCode,
  myPlaybackErrorText,
  myScopeHelp,
  myWorkHeading,
  myWorkMeta,
  myWorkPlayLabel,
  myWorkScopeLabel,
  myWorkStage,
  normalizeMyWorks,
  publicBlockedReason,
  publicBlockedTip,
  SCOPE_LABELS,
  scopeChangePlan,
  SCOPE_FIXED_NOTE,
  WITHDRAW_CONFIRM_LINE,
  formatShortDateTime,
} from "./submissions-lib.js";

const SCOPE_ORDER = ["public", "lecture", "private"];

/**
 * @param {object} o
 * @param {HTMLElement} o.group 区切りの枠全体（受講者でないとき・まだ読めていないときは隠す）
 * @param {HTMLElement} o.listEl 一覧を入れる所
 * @param {HTMLElement} [o.metaEl] 折りたたみの見出しの右の短い数（「2 本」）
 * @param {HTMLDetailsElement} [o.helpEl] 一覧の上の ？（公開の範囲の説明。details.help。作品があるときだけ出す。組 13 の U-13）
 * @param {HTMLElement} [o.helpBodyEl] ？ の中身を入れる所（helpEl の中の .help-body）
 * @param {HTMLElement} o.statusEl 結果の知らせ（role=status）
 * @param {HTMLDialogElement} o.dialog 確認・同意・再生に使う <dialog>
 * @param {string} o.apiBase `submissions` 関数の基点（…/functions/v1/submissions）
 * @param {string} o.apiKey 公開用のキー
 * @param {() => Promise<{accountId: string, token: string} | null>} o.getSession 現在の本人IDとトークン（通知を待たず共有保存先を読み直す）
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => void} [o.onLayout] 枠（group）を出した・隠したときに呼ぶ（マイページの「今日の段階｜提出した作品」の並べ方を合わせる）
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
  /** 前回描いた中身（JSON）。約 10 秒の読み直しで同じなら描き直さない */
  let shownJson = null;
  /**
   * 描き直してもフォーカスを戻すための印：作った操作の部品 → 「作品の id|操作」。focusTargets は最後に描いた分の「印 → 部品」。
   * 公開範囲の select は「…|select」（選んでいる途中なので、静かな読み直しでは描き直さない）
   */
  const focusKeys = new WeakMap();
  let focusTargets = new Map();
  /** 公開範囲の select → 描いたときの範囲（選びかけかどうかを、描き直す前に見分ける） */
  const shownScopes = new WeakMap();
  /** 公開範囲の select → ［変更する］の押せる・押せないを今の値に合わせる関数（選び直したときだけ押せる。組 13 の U-13） */
  const scopeSyncs = new WeakMap();

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

  /** 枠を出す・隠す（並べ方を合わせるため、変えたら知らせる） */
  function setGroupHidden(hidden) {
    if (o.group.hidden === hidden) return;
    o.group.hidden = hidden;
    o.onLayout?.();
  }

  /** 操作の部品に印を付けて覚える（描き直したあとフォーカスを戻す先） */
  function mark(node, key) {
    focusKeys.set(node, key);
    focusTargets.set(key, node);
    return node;
  }

  /** 今フォーカスのある、一覧の中の操作の部品の印（無ければ null） */
  function focusedKey() {
    const a = globalThis.document?.activeElement;
    return a ? focusKeys.get(a) ?? null : null;
  }

  /** 静かな読み直しで描き直してはいけないとき：操作の途中・確認の窓が開いている・公開範囲を選んでいる途中 */
  function mustNotRedraw() {
    return busy || !!o.dialog.open || !!focusedKey()?.endsWith("|select");
  }

  /**
   * 知らせの 1 行。エラーコードは文の後ろに小さく薄く（決まり 3.2 の案 A。断りの文から myErrorCode で引く）、
   * ホバーの補足（「公開」を選べない理由の続き）は title に置く
   */
  function say(text, tone = "ok") {
    o.statusEl.textContent = text;
    const code = tone === "error" ? myErrorCode(text) : null;
    if (code) o.statusEl.append(codeTail(code));
    const tip = publicBlockedTip(text);
    if (tip) o.statusEl.setAttribute("title", tip);
    else o.statusEl.removeAttribute?.("title");
    o.statusEl.className = tone === "error" ? "error-text" : "muted";
    o.statusEl.hidden = !text;
  }

  /** 文の後ろに付けるエラーコードの部品（小さく薄く） */
  function codeTail(code) {
    return el("span", { className: "err-code muted small", text: errorCodeLabel(code) });
  }

  // ---- 確認・同意・再生の <dialog> ----

  /**
   * 確認。ok なら true。extra：本文の下に足す部品、okEnabled：決定を押せるか（同意のチェックなど）。
   * kind："danger" なら決定を赤で塗る（取り消せない確定。管理コンソールの dialog.ask と同じ .btn.danger-fill。組 13 の U-12）
   */
  function ask({ title, lines, okText, extra = null, okDisabledUntil = null, kind = "primary" }) {
    const d = o.dialog;
    return new Promise((resolve) => {
      const ctl = new AbortController();
      const finish = (v) => {
        if (ctl.signal.aborted) return;
        ctl.abort();
        if (d.open) d.close();
        resolve(v);
      };
      const cancel = el("button", { type: "button", className: "btn", text: "キャンセル", autofocus: true, onclick: () => finish(false) });
      const ok = el("button", { type: "button", className: `btn ${kind === "danger" ? "danger-fill" : "primary"}`, text: okText, onclick: () => finish(true) });
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

  /**
   * 一覧を読み直す。ticket：操作のあとの読み直しで、操作を始めたときの本人の印（無ければ今の本人で読む）。
   * quiet：約 10 秒の読み直し。操作の途中・確認の窓が開いている・公開範囲を選んでいる途中なら読まずに "skip"（通し番号を進めない）。
   * 失敗しても一覧と文をそのまま残して "fail"。中身が前回と同じなら描き直さない。描き直すときは、フォーカスのあった操作の部品へ戻す。
   * 返り値は "ok" | "fail" | "skip"
   */
  async function refresh({ ticket: expectedTicket = null, quiet = false } = {}) {
    if (quiet && mustNotRedraw()) return "skip";
    const seq = ++refreshSeq;
    const ticket = expectedTicket ? (await current(expectedTicket) ? expectedTicket : null) : await ticketFor(true);
    if (!ticket || seq !== refreshSeq) return "skip";
    const my = ticket.epoch;
    if (!loadedOnce && !quiet) {
      o.listEl.replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
      setGroupHidden(false);
    }
    const r = await call("GET", "/my/works", undefined, ticket);
    if (!r || my !== epoch || seq !== refreshSeq) return "skip"; // 通知未着の本人変更も、call の前後で照合する
    if (!r.ok) {
      // 受講者として登録されていない（講師・管理者など）：この枠は出さない
      if (r.status === 403 || r.code === "not_stage_student") {
        data = null;
        shownJson = null;
        setHelp(null);
        setGroupHidden(true);
        return "ok";
      }
      if (quiet) return "fail"; // 静かな読み直しの失敗は、一覧と文をそのまま残す（続けて失敗したときの知らせは mypage.js）
      if (!loadedOnce) {
        o.listEl.replaceChildren(el("p", { className: "error-text", text: MSG_MY_WORKS_FAILED }), el("button", { type: "button", className: "btn compact", text: "再試行", onclick: () => void refresh() }));
      } else {
        say(MSG_MY_WORKS_FAILED, "error");
      }
      return "fail";
    }
    const d = normalizeMyWorks(r.body);
    if (!d) {
      if (!quiet) o.listEl.replaceChildren(el("p", { className: "error-text", text: MSG_MY_WORKS_FAILED }));
      return "fail";
    }
    const json = JSON.stringify(d);
    if (quiet && loadedOnce && json === shownJson) return "ok"; // 変わっていない：描き直さない
    // 待っている間に操作が始まった・窓が開いた・選び始めた：今回は描き直さない（次の読み直しで）
    if (quiet && mustNotRedraw()) return "skip";
    data = d;
    shownJson = json;
    loadedOnce = true;
    setGroupHidden(false);
    const key = focusedKey();
    render();
    if (key) focusTargets.get(key)?.focus?.();
    return "ok";
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
    shownJson = null;
    focusTargets = new Map();
    o.dialog.close?.();
    o.dialog.replaceChildren();
    o.listEl.replaceChildren();
    o.statusEl.textContent = "";
    o.statusEl.hidden = true;
    setHelp(null);
    setGroupHidden(true);
    setMeta("");
  }

  /**
   * 一覧の上の ？（公開の範囲の説明）を出す・隠す。作品が無いとき・画面を消すときは隠して閉じる。
   * 開け閉めは details のまま（描き直しても、開いた ？ は閉じない）
   */
  function setHelp(ctx) {
    if (!o.helpEl) return;
    if (!ctx) {
      o.helpEl.open = false;
      o.helpEl.hidden = true;
      o.helpBodyEl?.replaceChildren();
      return;
    }
    const h = myScopeHelp(ctx);
    const list = el("ul", { className: "my-help-list" }, ...h.lines.map((t) => el("li", { text: t })));
    o.helpBodyEl?.replaceChildren(...(h.note ? [list, el("p", { text: h.note })] : [list]));
    o.helpEl.hidden = false;
  }

  // ---- 表示 ----

  /** 選びかけの公開範囲（select の値が、描いたときの範囲と違う）：作品の id → 選んだ値 */
  function pendingScopes() {
    const out = new Map();
    for (const [key, node] of focusTargets) {
      if (!key.endsWith("|select")) continue;
      const v = node.value;
      if (typeof v === "string" && shownScopes.has(node) && v !== shownScopes.get(node)) out.set(key, v);
    }
    return out;
  }

  /** 描き直したあと、選びかけの値を戻す（その作品の欄がまだあり、その値を選べるときだけ） */
  function restoreScopes(pending) {
    for (const [key, v] of pending) {
      const select = focusTargets.get(key);
      const opt = select ? Array.from(select.children ?? []).find((c) => c.getAttribute?.("value") === v) : null;
      if (opt && !opt.disabled) {
        select.value = v;
        scopeSyncs.get(select)?.();
      }
    }
  }

  function render() {
    if (!data) return;
    // 静かな読み直し・操作の前後で描き直しても、選びかけの公開範囲を元の範囲に戻さない（フォーカスが select から外れていても）
    const pending = pendingScopes();
    focusTargets = new Map();
    setMeta(data.works.length ? `${data.works.length} 本` : "");
    const parts = [];
    if (data.uploading.length) {
      parts.push(
        el(
          "div",
          { className: "my-block" },
          el("h3", { text: "送信中の動画" }),
          ...data.uploading.map((u) =>
            el(
              "div",
              { className: "my-row", "data-upload": u.workId },
              el("div", { className: "my-main" }, el("div", { className: "my-title", text: u.sourceLabel ?? "動画" }), el("div", { className: "muted small", text: `${u.stageLabel}${u.begunAt ? ` · ${formatShortDateTime(u.begunAt)} に開始` : ""}` })),
              mark(el("button", { type: "button", className: "btn compact", "data-action": "cancel-upload", text: "キャンセル", disabled: busy, onclick: () => void cancelUpload(u) }), `${u.workId}|cancel-upload`),
            ),
          ),
        ),
      );
    }
    if (!data.works.length) parts.push(el("p", { className: "muted", text: MY_WORKS_EMPTY }));
    for (const w of data.works) parts.push(workRow(w));
    o.listEl.replaceChildren(...parts);
    setHelp(data.works.length ? { loginKind: data.loginKind, consent: data.consent } : null);
    restoreScopes(pending);
  }

  /**
   * 1 作品の行（組 13 の U-13・D-1105-121x。並べ方は index.html の .my-work）：
   * 1 段目＝丸の再生のボタン・題（「作品 1」と段階の名前）・公開範囲の札／2 段目＝長さ・大きさ・時刻（ブリッジワークはその下に目的）／
   * 3 段目＝公開範囲を変える欄（変えられなければその旨）と［取り下げる］（右端）。範囲の説明と「公開」を選べない理由は一覧の上の ？ の中
   */
  function workRow(w) {
    const stage = myWorkStage(w);
    const ops = [scopeControl(w) ?? el("span", { className: "muted small my-scope-note", text: SCOPE_FIXED_NOTE })];
    // ［取り下げる］は再生のボタンから離して行の右端に置く（押し間違えにくく。組 13 の U-12。CSS は index.html の .my-withdraw）
    if (w.canWithdraw) ops.push(mark(el("button", { type: "button", className: "btn compact my-withdraw", "data-action": "withdraw", text: "取り下げる", disabled: busy, onclick: () => void withdraw(w) }), `${w.workId}|withdraw`));
    const purpose = w.kind === "bridge" && w.purpose ? w.purpose : null;
    return el(
      "div",
      { className: purpose ? "my-row my-work has-purpose" : "my-row my-work", "data-work": w.workId },
      // 再生の印は CSS（index.html の .my-play::before）。読み上げの名前は aria-label
      mark(el("button", { type: "button", className: "my-play", "data-action": "play", "aria-label": myWorkPlayLabel(w), onclick: () => void play(w) }), `${w.workId}|play`),
      el("div", { className: "my-main" }, el("span", { className: "my-title", text: myWorkHeading(w) }), stage ? " " : null, stage ? el("span", { className: "my-stage", text: stage }) : null),
      el("span", { className: `scope-badge ${w.scope}`, text: SCOPE_LABELS[w.scope] }),
      el("div", { className: "my-meta muted small", text: myWorkMeta(w) }),
      // ブリッジワークの目的は 2 段目の下に、行の幅いっぱいで（狭い幅で札の横に細く折り返さない）
      purpose ? el("div", { className: "my-purpose small", text: purpose }) : null,
      // 公開範囲を変える欄は、種類（ワークショップ・ブリッジワーク）によらず、サーバーの can_change_scope だけで出す（組 11）
      el("div", { className: "my-ops" }, ...ops),
    );
  }

  /**
   * 公開範囲を変える欄（変えられないときは出さない。サーバーの can_change_scope に従う）。
   * 選択肢は札と同じ短い名前（SCOPE_LABELS。説明は一覧の上の ？ の中。D-1105-121x）。［変更する］は、今と違う値を選んだときだけ押せる（組 13 の U-13。欄のすぐ横なので名詞を省く）
   */
  function scopeControl(w) {
    if (!w.canChangeScope) return null;
    const ctx = { loginKind: data.loginKind, consent: data.consent };
    const blocked = publicBlockedReason(ctx);
    const select = mark(el(
      "select",
      { className: "input compact-select", "aria-label": myWorkScopeLabel(w) },
      ...SCOPE_ORDER.map((s) => el("option", { value: s, text: SCOPE_LABELS[s], ...(s === w.scope ? { selected: true } : {}), ...(s === "public" && blocked ? { disabled: true } : {}) })),
    ), `${w.workId}|select`);
    shownScopes.set(select, w.scope);
    /** 選んでいる値（まだ値が無い間は今の範囲） */
    const picked = () => (typeof select.value === "string" && select.value ? select.value : w.scope);
    const btn = mark(el("button", { type: "button", className: "btn compact", "data-action": "scope", text: "変更する", disabled: busy || picked() === w.scope, onclick: () => void changeScope(w, picked()) }), `${w.workId}|scope`);
    const sync = () => {
      btn.disabled = busy || picked() === w.scope;
    };
    scopeSyncs.set(select, sync);
    select.addEventListener("change", sync);
    select.addEventListener("input", sync);
    return el("div", { className: "my-scope" }, select, btn);
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
    if (!(await ask({ title: "この動画を取り下げますか？", lines: [WITHDRAW_CONFIRM_LINE], okText: "取り下げる", kind: "danger" }))) return;
    await guarded(ticket, async () => {
      const r = await call("POST", `/my/works/${encodeURIComponent(w.workId)}/withdraw`, {}, ticket);
      if (!r) return;
      if (r.ok) {
        say(MSG_WITHDRAWN);
        await refresh({ ticket });
      } else {
        say(myActionErrorText(r.code, r.status), "error");
        // 状態が変わっていた（受け付けが終わった・すでに取り下げた）ときは、最新を読み直す
        if (r.status === 404 || r.code === "submission_closed") await refresh({ ticket });
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
    const yes = await ask({ title: "公開範囲を変更しますか？", lines: plan.confirmLines, okText: "変更する", extra, okDisabledUntil: gate });
    if (!yes) return;
    await guarded(ticket, async () => {
      const r = await call("POST", `/my/works/${encodeURIComponent(w.workId)}/scope`, { scope: next, ...(plan.kind === "public" ? { consent_text_id: plan.consent.id } : {}) }, ticket);
      if (!r) return;
      if (r.ok) {
        say(MSG_SCOPE_CHANGED);
        await refresh({ ticket });
      } else {
        say(myActionErrorText(r.code, r.status), "error");
        if (r.status === 404 || r.code === "consent_outdated") await refresh({ ticket });
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
        await refresh({ ticket });
      } else {
        say(myActionErrorText(r.code, r.status), "error");
        // 状態が変わっていた（404。MSG_MY_STALE は「一覧を確認してください」）ときは、取り下げ・公開範囲の変更と同じく最新を読み直す
        if (r.status === 404) await refresh({ ticket });
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
        showPlayError(msg, e instanceof Error ? e.message : myPlaybackErrorText(null, 500));
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
          showPlayError(msg, e instanceof Error ? e.message : myPlaybackErrorText(null, 500));
        });
    });
  }

  /** 再生の窓の赤い文（エラーコードがあれば文の後ろに小さく薄く） */
  function showPlayError(msg, text) {
    msg.textContent = text;
    const code = myErrorCode(text);
    if (code) msg.append(codeTail(code));
    msg.hidden = false;
  }

  return { refresh, clear, _state: () => ({ epoch, busy, data }) };
}
