// マイページの［スマホに保存する］（QR の欄。docs/design-submissions.md 4.9「発行」「スマホでの保存の案内」・段 1D）。
// 出した作品の ZIP を、スマホで保存するための QR を出す。QR はこのページの中で作る（qr-code.js。外のサービスに URL を送らない）。
// mypage.js から使う：createMyShare({...}) を 1 つ作り、本人の画面を出すたびに refresh()、画面の中身を消すときに clear() を呼ぶ（mypage-submissions.js と同じ約束）。
// 文・値の読み取りは share-lib.js（試験は scripts/share_lib_test.mjs・scripts/mypage_share_nodetest.mjs・scripts/qr_code_nodetest.mjs）。
// 鍵つきの URL は、QR と［この端末で開く］・［この端末で保存する］にだけ使う。文字では出さず、**この部品は**画面の外へ保存しない（sessionStorage・localStorage・履歴・ログに入れない）。
// ただし［この端末で開く］・［この端末で保存する］は同じタブで /dl#k=… へ移り、/dl の側が鍵を**このタブの sessionStorage に一時に置く**（dl.js の頭の注記）。
// その鍵は mypage.js が、マイページを開いた時点・ログアウト・別のアカウントでのログインで消す（share-lib.js の discardDlKey）。
// ［閉じる］・ログアウト・ほかの人への切り替えで、QR の画像（data URL）と URL をこの部品の中から捨てる。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。QR は <img> の src に入れる。
import { qrMatrix, qrSvgDataUrl } from "./qr-code.js";
import {
  linkSizeLine,
  linkStateLines,
  missingLine,
  MSG_SHARE_BAD_REPLY,
  MSG_SHARE_FAILED_LOAD,
  MSG_SHARE_NOTHING_TO_STOP,
  MSG_SHARE_PREPARING_LONG,
  MSG_SHARE_STOPPED,
  normalizeShareIssue,
  normalizeShareStatus,
  SHARE_CLOCK_NOTE,
  SHARE_CLOSE_LABEL,
  SHARE_DETAILS_SUMMARY,
  SHARE_GONE_LINE,
  SHARE_HERE_CONFIRM,
  SHARE_HERE_LABEL,
  SHARE_HERE_TITLE,
  SHARE_ISSUE_CONFIRM,
  SHARE_ISSUE_TITLE,
  SHARE_NO_WORKS,
  SHARE_OPEN_LABEL,
  SHARE_PATHS,
  SHARE_QR_ALT,
  SHARE_STOP_CONFIRM,
  SHARE_STOP_LABEL,
  SHARE_STOP_TITLE,
  SHARE_THIS_DEVICE,
  saveGuide,
  shareErrorText,
  sharePeriodLine,
  zipPhase,
  zipStateLine,
} from "./share-lib.js";

/** 準備中の状態を読み直す間隔と回数（10 秒ごと・最大 90 回＝15 分。2 GB の ZIP でふつう約 4 分） */
const POLL_MS = 10_000;
const POLL_MAX = 90;
/** 準備ができたあと（QR が有効な間）は 1 分ごとに読み直し、「あと何分」と「開かれた」を新しくする（最大 240 回＝4 時間） */
const SLOW_POLL_MS = 60_000;
const SLOW_POLL_MAX = 240;

/**
 * @param {object} o
 * @param {HTMLElement} o.group 区切りの枠全体（受講者でないとき・まだ読めていないときは隠す）
 * @param {HTMLElement} o.host 中身を入れる所
 * @param {HTMLElement} o.statusEl 結果の知らせ（role=status）
 * @param {HTMLDialogElement} o.dialog 確認に使う <dialog>
 * @param {string} o.apiBase `submissions` 関数の基点（…/functions/v1/submissions）
 * @param {string} o.apiKey 公開用のキー
 * @param {() => Promise<{accountId: string, token: string} | null>} o.getSession 現在の本人IDとトークン（通知を待たず共有保存先を読み直す）
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(url: string) => void} [o.navigate] ［この端末で開く］の移動（既定：同じタブで移る）
 * @param {{ set: typeof setTimeout, clear: typeof clearTimeout }} [o.timers] 読み直しの時計（試験で差し替える）
 * @param {boolean} [o.closedMode] 回が終わったあとの画面（設計 4.10）：［この端末で保存する］も出す
 * @param {() => number} [o.now] 今の時刻（ミリ秒。「あと何分」・押せる期間の文に使う。試験で差し替える）
 */
export function createMyShare(o) {
  const fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  const navigate = o.navigate ?? ((url) => window.location.assign(url));
  const timers = o.timers ?? { set: (...a) => setTimeout(...a), clear: (...a) => clearTimeout(...a) };
  const now = o.now ?? (() => Date.now());
  /** 世代。clear() だけで進め、進む前に始まった要求の応答は画面に入れない（ログアウト・別の人の画面を残さない） */
  let epoch = 0;
  /** 読み込みの通し番号。新しい読み込みを始めたら、古い読み込みの応答は捨てる */
  let refreshSeq = 0;
  /** { works: number|null, canIssue: boolean|null, issueUntil: string|null, link: 状態 | null } */
  let data = null;
  /** 出したばかりの QR（鍵つきの URL と画像）。閉じる・clear で捨てる */
  let issued = null;
  let busy = false;
  let ownerId = null;
  let pollTimer = null;
  let pollCount = 0;
  let slowCount = 0;

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
    } catch {
      return null;
    }
  }

  async function ticketFor(allowRebind = false) {
    const my = epoch;
    const s = await sessionNow();
    if (my !== epoch) return null;
    if (!s) {
      clear();
      return null;
    }
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
    if (!s || s.accountId !== ticket.accountId || ownerId !== ticket.accountId) {
      clear();
      return null;
    }
    return s;
  }

  async function call(method, path, ticket) {
    const s = await current(ticket);
    if (!s) return null;
    let res;
    try {
      res = await fetchImpl(`${o.apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${s.token}`, apikey: o.apiKey },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        credentials: "omit",
      });
    } catch {
      if (!(await current(ticket))) return null;
      return { ok: false, status: 0, code: "network", body: null };
    }
    const json = await res.json().catch(() => null);
    if (!(await current(ticket))) return null;
    const code = json?.error?.code ?? (typeof json?.error === "string" ? json.error : null) ?? json?.code ?? null;
    return { ok: res.ok, status: res.status, code, body: json };
  }

  function say(text, tone = "ok") {
    o.statusEl.textContent = text;
    o.statusEl.className = tone === "error" ? "error-text" : "muted";
    o.statusEl.hidden = !text;
  }

  // ---- 確認の <dialog>（mypage-submissions.js と同じ作り。やめるが既定） ----

  function ask({ title, lines, okText }) {
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
      d.className = "my-dialog";
      d.replaceChildren(el("div", { className: "my-dialog-body" }, el("h2", { text: title }), ...lines.map((t) => el("p", { text: t })), el("div", { className: "row" }, cancel, ok)));
      d.addEventListener("cancel", (e) => (e.preventDefault(), finish(false)), { signal: ctl.signal });
      d.addEventListener("close", () => finish(false), { signal: ctl.signal });
      d.showModal();
      cancel.focus();
    });
  }

  // ---- 読み込み ----

  async function refresh(expectedTicket = null) {
    const seq = ++refreshSeq;
    const ticket = expectedTicket ? ((await current(expectedTicket)) ? expectedTicket : null) : await ticketFor(true);
    if (!ticket || seq !== refreshSeq) return false;
    const my = ticket.epoch;
    const r = await call("GET", SHARE_PATHS.status, ticket);
    if (!r || my !== epoch || seq !== refreshSeq) return false;
    if (!r.ok) {
      // 受講者として使えない（講師・管理者など）・機能がまだ無い：この枠は出さない
      if (r.status === 403 || r.status === 404) {
        data = null;
        o.group.hidden = true;
        return false;
      }
      if (data === null) o.group.hidden = true;
      else say(MSG_SHARE_FAILED_LOAD, "error");
      return data !== null;
    }
    const d = normalizeShareStatus(r.body);
    if (!d) {
      if (data === null) o.group.hidden = true;
      else say(MSG_SHARE_FAILED_LOAD, "error");
      return data !== null;
    }
    // 別の端末で止めた・期限が切れた QR は、出ている QR も捨てる
    if (!d.link && issued) {
      issued = null;
      say(SHARE_GONE_LINE, "error");
    }
    data = d;
    o.group.hidden = false;
    render();
    schedulePoll(ticket);
    return true;
  }

  /** QR が有効な間、状態を読み直す：準備中は 10 秒ごと（ready・使えない・90 回で止める）、準備ができたあとは 1 分ごと（「あと何分」を新しくする） */
  function schedulePoll(ticket) {
    if (pollTimer !== null) {
      timers.clear(pollTimer);
      pollTimer = null;
    }
    if (!data?.link) return;
    const phase = zipPhase(data.link.zipState);
    if (phase === "failed") return;
    const preparing = phase === "preparing";
    if (preparing ? pollCount >= POLL_MAX : slowCount >= SLOW_POLL_MAX) {
      if (preparing) say(MSG_SHARE_PREPARING_LONG);
      return;
    }
    const my = ticket.epoch;
    pollTimer = timers.set(() => {
      pollTimer = null;
      if (my !== epoch) return;
      if (preparing) pollCount += 1;
      else slowCount += 1;
      void refresh(ticket);
    }, preparing ? POLL_MS : SLOW_POLL_MS);
  }

  function stopPoll() {
    if (pollTimer !== null) timers.clear(pollTimer);
    pollTimer = null;
    pollCount = 0;
    slowCount = 0;
  }

  /** 本人のデータを画面から消す（ログアウト・画面を離れるとき。出ている要求の応答も捨てる。QR と鍵つきの URL も捨てる） */
  function clear() {
    epoch += 1;
    data = null;
    issued = null;
    busy = false;
    ownerId = null;
    stopPoll();
    o.dialog.close?.();
    o.dialog.replaceChildren();
    o.host.replaceChildren();
    o.statusEl.textContent = "";
    o.statusEl.hidden = true;
    o.group.hidden = true;
  }

  // ---- 表示 ----

  function render() {
    if (!data) return;
    const noWorks = data.works === 0;
    const periodOff = !noWorks && data.canIssue === false;
    const parts = [];
    parts.push(
      el(
        "div",
        { className: "share-head" },
        el("button", { type: "button", className: "btn primary", "data-action": "share-issue", text: SHARE_OPEN_LABEL, disabled: busy || noWorks || periodOff, onclick: () => void issue() }),
        o.closedMode ? el("button", { type: "button", className: "btn", "data-action": "share-here", text: SHARE_HERE_LABEL, disabled: busy || noWorks || periodOff, onclick: () => void issue("here") }) : null,
        noWorks ? el("p", { className: "muted small", "data-testid": "share-no-works", text: SHARE_NO_WORKS }) : null,
        periodOff ? el("p", { className: "muted small", "data-testid": "share-period", text: sharePeriodLine(data.issueUntil, now()) }) : null,
      ),
    );
    const link = data.link;
    if (link) parts.push(linkCard(link));
    o.host.replaceChildren(...parts);
  }

  function linkCard(link) {
    const phase = zipPhase(link.zipState);
    const guide = saveGuide(link.zipBytes);
    const size = linkSizeLine(link);
    const missing = missingLine(link);
    const stateLines = linkStateLines(link, now());
    const qrPart = [];
    if (issued) {
      // 狭い幅では［この端末で開く］を上に大きく、QR を下に小さく（CSS の並びと同じ順で DOM に置く）
      qrPart.push(
        el("button", { type: "button", className: "btn primary share-open", "data-action": "share-open", text: SHARE_THIS_DEVICE, onclick: () => navigate(issued.url) }),
        el("div", { className: "share-qr" }, el("img", { src: issued.dataUrl, alt: SHARE_QR_ALT, width: "220", height: "220", referrerpolicy: "no-referrer" })),
      );
    } else if (phase !== "failed") {
      qrPart.push(el("p", { className: "muted small", "data-testid": "share-qr-hidden", text: "QR は、出したときだけ見られます。もう一度見るには、QR を出し直してください（前の QR は使えなくなります）。" }));
    }
    return el(
      "div",
      { className: issued ? "share-card" : "share-card no-qr", "data-state": phase },
      ...qrPart,
      el(
        "div",
        { className: "share-info" },
        el("p", { className: phase === "failed" ? "error-text" : "", "data-testid": "share-zip", role: "status", text: zipStateLine(link.zipState, link.zipBytes, issued !== null) }),
        size ? el("p", { className: "muted small", "data-testid": "share-size", text: size }) : null,
        phase === "preparing" || !link.firstOpenedAt ? el("p", { className: "muted small", text: SHARE_CLOCK_NOTE }) : null,
        missing ? el("p", { className: "warn-text small", "data-testid": "share-missing", text: missing }) : null,
        ...stateLines.map((t) => el("p", { className: "muted small", "data-testid": "share-state", text: t })),
        el("ul", { className: "share-guide small", "data-testid": "share-guide-short" }, ...guide.short.map((t) => el("li", { text: t }))),
        el("details", { className: "share-more small" }, el("summary", {}, el("span", { text: SHARE_DETAILS_SUMMARY })), el("ul", { className: "share-guide small", "data-testid": "share-guide-open" }, ...guide.open.map((t) => el("li", { text: t })))),
        el(
          "div",
          { className: "row" },
          el("button", { type: "button", className: "btn compact", "data-action": "share-stop", text: SHARE_STOP_LABEL, disabled: busy, onclick: () => void stop() }),
          issued ? el("button", { type: "button", className: "btn compact", "data-action": "share-close", text: SHARE_CLOSE_LABEL, onclick: closeQr }) : null,
        ),
      ),
    );
  }

  // ---- 操作 ----

  async function guarded(ticket, fn) {
    if (busy || !(await current(ticket)) || busy) return; // 本人の再確認を待つ間に、ほかの操作が始まることがある
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

  /** mode "qr"：QR を出す。mode "here"：QR は作らず、この端末で保存のページへ移る（回が終わったあとの［この端末で保存する］） */
  async function issue(mode = "qr") {
    const here = mode === "here";
    const ticket = await ticketFor();
    if (!ticket) return;
    const question = here ? { title: SHARE_HERE_TITLE, lines: [SHARE_HERE_CONFIRM], okText: "開く" } : { title: SHARE_ISSUE_TITLE, lines: [SHARE_ISSUE_CONFIRM], okText: "QR を出す" };
    if (!(await ask(question))) return;
    await guarded(ticket, async () => {
      say("");
      const r = await call("POST", SHARE_PATHS.issue, ticket);
      if (!r) return;
      if (!r.ok) {
        say(shareErrorText(r.code, r.status), "error");
        if (r.code === "no_works" || r.code === "submission_busy" || r.code === "share_period_closed") await refresh(ticket);
        return;
      }
      const link = normalizeShareIssue(r.body);
      let dataUrl = null;
      if (link && !here) {
        try {
          dataUrl = qrSvgDataUrl(qrMatrix(link.url, { ecc: "M" }));
        } catch {
          dataUrl = null;
        }
      }
      if (!link || (!here && !dataUrl)) {
        // 発行のあとで QR を作れなかった：前の QR は使えなくなっているので、最新を読み直して知らせる
        say(MSG_SHARE_BAD_REPLY, "error");
        await refresh(ticket);
        return;
      }
      const { url, ...state } = link;
      issued = here ? null : { url, dataUrl };
      data = { works: data?.works ?? null, canIssue: data?.canIssue ?? null, issueUntil: data?.issueUntil ?? null, link: state };
      pollCount = 0;
      slowCount = 0;
      o.group.hidden = false;
      render();
      schedulePoll(ticket);
      if (here) navigate(url);
    });
  }

  async function stop() {
    const ticket = await ticketFor();
    if (!ticket) return;
    if (!(await ask({ title: SHARE_STOP_TITLE, lines: [SHARE_STOP_CONFIRM], okText: "止める" }))) return;
    await guarded(ticket, async () => {
      const r = await call("POST", SHARE_PATHS.stop, ticket);
      if (!r) return;
      if (r.ok) {
        issued = null;
        stopPoll();
        say(r.body?.stopped === false ? MSG_SHARE_NOTHING_TO_STOP : MSG_SHARE_STOPPED);
        await refresh(ticket);
      } else {
        say(shareErrorText(r.code, r.status), "error");
      }
    });
  }

  /** QR を画面から取り除く（リンクは止めない。状態は残す） */
  function closeQr() {
    issued = null;
    render();
  }

  return { refresh, clear, issueUntil: () => data?.issueUntil ?? null, _state: () => ({ epoch, busy, data, hasQr: issued !== null }) };
}
