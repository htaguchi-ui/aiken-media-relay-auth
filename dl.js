// 保存のページ（/dl/。docs/design-submissions.md 4.9「スマホで開く」・段 1D）。マイページで出した QR（または［この端末で開く］）の行き先。ログインは要らず、URL の断片（#k=）の鍵だけで開く。
// 動き：(1) 鍵を URL の断片から取り出し、すぐ history.replaceState で URL から消す。鍵はこのページの中の変数に置き、**読み直し（再読み込み）で戻れるよう、このタブの sessionStorage にだけ一時に置く**（下の「鍵の置き場」）
//       (2) POST /dl/open { key }。準備中は 10 秒ごとに、ready の間は 1 分ごとに読み直す（時計は始まらない・仕事は進まない）。ready なら［ZIP を保存］と作品ごとの［保存］（D11）。最初の通信が失敗したら［もう一度読み込む］
//       (3) 保存の URL は POST /dl/url { key, file? } で取り、そのとき初めて保存を始める（期限の短い署名つき URL。1 本のリンクで 30 回まで）
//       (4) 使えない理由は区別せず「このリンクは使えません」（設計 4.9）。使えないと分かったら鍵を捨てる（変数・sessionStorage の両方）
// 鍵の置き場（Codex TASK-0244 F244-01：鍵を URL から消すと、通信が一瞬失敗したあとの再読み込みで鍵が無く、まだ有効なリンクが「使えません」になる）：
//   - 置くのは sessionStorage の 1 つの名前（DL_KEY_STORE）だけ。このタブの中だけで、タブを閉じると消える。localStorage・cookie・URL・履歴・ログ・画面の文字には置かない。
//   - 消すとき：使えないと分かったとき（404）・使える時間が終わったとき（サーバーの時計で過ぎた。通信が途切れたままでも、描き直すたびに確かめる）・新しい QR を開いたとき（上書き）・壊れた断片を開いたとき・
//     **マイページを開いた時点／ログアウト／別のアカウントでのログイン（mypage.js が share-lib.js の discardDlKey で消す。verifier のレビュー P2：ログアウトのあとに同じタブで［進む］や /dl を開くと前の人の作品が出た）**。保存を始めただけでは消さない（途中で止まった保存をやり直せるように）。
//   - 置き場の鍵が消えたのに変数の鍵が残る場合（verifier の 3 回目の反例）：戻る・進むの bfcache から戻った（pageshow の persisted。Safari の既定）・保存や読み直しの直前・ほかのタブで共有のログインが消えた（storage の知らせ）とき、
//     置き場の鍵と比べ、消えていれば変数の鍵も捨てて「使えません」にする（置き場に書けない環境では比べない）。
//     ただし共有のログインが消えたときは、置き場の有無にかかわらず変数と置き場の鍵を無条件で捨てる（ログアウト・storage.clear()）。
//   - 危険（受け入れる理由）：同じ origin のスクリプトは読める（XSS があれば取られる。このサイトは外部のスクリプトを読まず、CSP の script-src は 'self' だけ）。ブラウザの「閉じたタブを復元」でタブの
//     sessionStorage が戻ることがある。共用の端末で、同じタブを次の人が使うと、その鍵で保存のページを開ける。鍵でできるのは、本人の作品を保存することだけ（セッションは作らない・取り下げや再生はできない）で、
//     使える時間は最長 1 時間（開く前は 24 時間。いずれも全体の保存期限まで）。QR を出し直せば古い鍵は止まる。
// 文・値の読み取りは dl-lib.js（試験は scripts/dl_lib_test.mjs・scripts/dl_page_nodetest.mjs）。表示はすべて textContent / createElement で組み立てる。
// dl.html から読み込む。ブラウザでは自分で起動する（dl-app が無い環境〔試験〕では起動しない）。外部のスクリプトは読まない。
import {
  DL_PATHS,
  DL_POLL_MAX,
  DL_POLL_MS,
  DL_PREPARING_WAIT,
  DL_FILES_HEADING,
  DL_KEY_STORE,
  DL_RETRY_LABEL,
  DL_READY,
  DL_SAVE_ONE,
  DL_SAVE_ZIP,
  DL_TITLE,
  DL_UNAVAILABLE,
  dlFileLabel,
  dlGuide,
  dlLoadErrorText,
  dlMissingLine,
  dlPhase,
  dlPreparingLine,
  dlRemainingLine,
  dlSizeLine,
  dlUrlErrorText,
  downloadUrlOf,
  keyFromHash,
  MSG_DL_RESCAN,
  serverOffsetMs,
  MSG_DL_EXPIRED,
  MSG_DL_NOT_READY,
  MSG_DL_PREPARING_LONG,
  MSG_DL_STARTED,
  normalizeDlOpen,
} from "./dl-lib.js";
import { STUDIO_STORAGE_KEY, storedUserId } from "./auth-storage.js";

/**
 * @param {object} o
 * @param {HTMLElement} o.root 画面を入れる所
 * @param {string} o.apiBase `submissions` 関数の基点（…/functions/v1/submissions）
 * @param {string} o.apiKey 公開用のキー
 * @param {string} o.hash 今の URL の断片（location.hash）
 * @param {() => void} o.dropHash URL から断片を消す（history.replaceState）
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(url: string) => void} [o.download] 署名つき URL で保存を始める（既定：見えないリンクを押す）
 * @param {{ set: typeof setTimeout, clear: typeof clearTimeout }} [o.timers]
 * @param {() => number} [o.now] 端末の今（ミリ秒）
 * @param {{ get: () => string | null, set: (v: string) => void, remove: () => void }} [o.store] 鍵を一時に置く場所（既定：sessionStorage の DL_KEY_STORE。使えない環境では何もしない）
 */
export function createDlPage(o) {
  const fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  const timers = o.timers ?? { set: (...a) => setTimeout(...a), clear: (...a) => clearTimeout(...a) };
  const now = o.now ?? (() => Date.now());
  const store =
    o.store ?? {
      get: () => {
        try {
          return globalThis.sessionStorage?.getItem(DL_KEY_STORE) ?? null;
        } catch {
          return null;
        }
      },
      set: (v) => {
        try {
          globalThis.sessionStorage?.setItem(DL_KEY_STORE, v);
        } catch {
          /* 置けなくても、このページの中では動く（再読み込みで戻れないだけ） */
        }
      },
      remove: () => {
        try {
          globalThis.sessionStorage?.removeItem(DL_KEY_STORE);
        } catch {
          /* 無視 */
        }
      },
    };
  const download =
    o.download ??
    ((url) => {
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener noreferrer";
      a.referrerPolicy = "no-referrer";
      document.body.append(a);
      a.click();
      a.remove();
    });
  /** 鍵。使えないと分かったら null にする */
  let key = null;
  let open = null;
  let busy = false;
  let notice = "";
  let noticeTone = "ok";
  let pollTimer = null;
  let pollCount = 0;
  let slowCount = 0;
  let retryCount = 0;
  let tooLong = false;
  /** 使える時間が終わった（鍵は捨てた。終わりの文を出す） */
  let expired = false;
  /** サーバーの時計との差（/dl/open のたびに数え直す）。server_now が無いときは null（端末の時計だけでは期限を決めない） */
  let serverOffset = null;
  const serverNow = () => (serverOffset === null ? null : now() + serverOffset);
  /** /dl/open を読んでいる間（同じ鍵の読み込みが重ならないようにする） */
  let loading = false;
  /** open の開始番号。保存の 409 より前に始めた応答で、新しい準備中の表示を戻さない */
  let loadSeq = 0;
  let staleLoadThrough = 0;
  /** 鍵の世代。鍵が替わる（hashchange・捨てる）たびに進め、前の鍵の読み込みの応答・時計は捨てる */
  let gen = 0;
  /** 鍵を置き場（sessionStorage）に置けた・読めたか（private モードなどで置けないときは、置き場の鍵との比べをしない） */
  let storedOk = false;
  /** 保存の 409 zip_not_ready で準備中に戻したあと、準備ができるまで「まだ準備ができていません」を残す */
  let notReadyHint = false;

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

  async function call(path, body) {
    let res;
    try {
      res = await fetchImpl(`${o.apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: o.apiKey },
        body: JSON.stringify(body),
        cache: "no-store",
        referrerPolicy: "no-referrer",
        credentials: "omit",
      });
    } catch {
      return { ok: false, status: 0, code: "network", body: null };
    }
    const json = await res.json().catch(() => null);
    const code = json?.error?.code ?? (typeof json?.error === "string" ? json.error : null) ?? json?.code ?? null;
    return { ok: res.ok, status: res.status, code, body: json };
  }

  function stopPoll() {
    if (pollTimer !== null) timers.clear(pollTimer);
    pollTimer = null;
  }

  /** 使える時間が終わっていたら（サーバーの時計で数える）、終わりの画面にして、鍵を捨て、読み直しを止める。描き直すたびに確かめる（通信が途切れたままでも終わらせる） */
  function expireIfDue() {
    if (!key || !open?.expiresAt) return;
    const at = serverNow();
    if (at === null || Date.parse(open.expiresAt) > at) return;
    if (store.get() === key) store.remove();
    key = null;
    open = null;
    expired = true;
    gen += 1;
    loading = false;
    busy = false;
    stopPoll();
  }

  /**
   * この鍵が、まだ置き場（このタブの sessionStorage）にあるか。マイページがログアウトで置き場の鍵を消したあと（bfcache で戻ったページ・取りこぼした pageshow）に、
   * 変数の鍵で通信しないための確かめ。置けない環境では確かめない（true）。消えていれば鍵を捨てて「使えません」にして false を返す
   */
  function stillStored() {
    if (!key || !storedOk || store.get() === key) return true;
    unavailable(false); // 別の /dl が置いた新しい鍵は消さず、このページの変数だけを捨てる
    return false;
  }

  /** 使えないと分かった：鍵を捨て、読み直しも止め、同じ文を出す */
  function unavailable(clearStored = true) {
    key = null;
    open = null;
    gen += 1;
    loading = false;
    busy = false;
    if (clearStored) store.remove();
    stopPoll();
    render();
  }

  async function load() {
    if (!key || loading) return;
    if (!stillStored()) return;
    const myKey = key;
    const myGen = gen;
    const myLoad = ++loadSeq;
    loading = true;
    if (!open && notice) render(); // 最初の失敗の画面：読み込んでいる間は［もう一度読み込む］を押せない
    let r;
    try {
      r = await call(DL_PATHS.open, { key: myKey });
    } finally {
      if (gen === myGen) loading = false; // 鍵が替わっていたら、新しい鍵の読み込みの印を消さない
    }
    if (gen !== myGen || key !== myKey) return; // 待っている間に、別の鍵に替わった・捨てた
    if (!stillStored()) return;
    if (myLoad <= staleLoadThrough) { schedulePoll(); return; } // 409 以前に開始した読み直しの応答は使わない
    if (r.status === 404 || r.status === 410) return unavailable();
    const d = r.ok ? normalizeDlOpen(r.body) : null;
    if (!d) {
      // 通信できない・混み合っている：鍵は残す（もう一度開けば読める）。出ている内容は変えない
      notice = dlLoadErrorText(r.code);
      noticeTone = "error";
      render();
      schedulePoll();
      return;
    }
    retryCount = 0;
    if (dlPhase(d) === "unavailable") return unavailable();
    serverOffset = serverOffsetMs(d, now());
    open = d;
    // 保存の 409 で準備中に戻したあとは、準備ができるまで案内を残す
    if (dlPhase(d) === "ready") notReadyHint = false;
    notice = notReadyHint && dlPhase(d) === "preparing" ? MSG_DL_NOT_READY : "";
    noticeTone = "ok";
    render(); // 使える時間が終わっていれば、render の中で終わりの画面にする（サーバーが 404 にする前でも）
    schedulePoll();
  }

  /**
   * 読み直し：準備中は 10 秒ごと（最大 90 回）／ready の間は 1 分ごと（最大 240 回。「あと何分」を新しくし、時間が終わったら 404 を拾う）／
   * 最初の通信が失敗したままのときは 10 秒ごとに最大 6 回（［もう一度読み込む］も出す）
   */
  function schedulePoll() {
    stopPoll();
    if (!key) return;
    let delay = DL_POLL_MS;
    if (!open) {
      if (retryCount >= 6) return;
    } else if (dlPhase(open) === "preparing") {
      if (pollCount >= DL_POLL_MAX) {
        tooLong = true;
        render();
        return;
      }
    } else {
      if (slowCount >= 240) return;
      delay = 60_000;
    }
    const myGen = gen;
    pollTimer = timers.set(() => {
      pollTimer = null;
      if (gen !== myGen || !stillStored()) return;
      if (!open) retryCount += 1;
      else if (dlPhase(open) === "preparing") pollCount += 1;
      else slowCount += 1;
      void load();
    }, delay);
  }

  /** ［もう一度読み込む］：最初の通信が失敗したあと、鍵を持ったまま /dl/open をやり直す */
  async function retry() {
    if (!key || busy || loading || !stillStored()) return;
    retryCount = 0;
    await load();
  }

  /** ZIP（file なし）か作品 1 本の保存を始める */
  async function save(file = null) {
    if (busy || !key || !stillStored()) return;
    const myKey = key;
    const myGen = gen;
    busy = true;
    notice = "";
    render();
    try {
      const r = await call(DL_PATHS.url, file ? { key: myKey, file } : { key: myKey });
      if (gen !== myGen || key !== myKey) return;
      if (!stillStored()) return;
      if (r.status === 404 || r.status === 410) return unavailable();
      if (r.status === 409 && r.code === "zip_not_ready") {
        // 準備中に戻っていた（ZIP が作り直されたなど）：ここで準備中の表示に戻し（飛んでいる読み直しの応答を待たない）、押し直してほしい旨を、準備ができるまで残す。
        // この時点以前に始めた open の応答は、ready を含めて捨てる。新しい読み直し（10 秒ごと）の応答だけを使う。
        staleLoadThrough = loadSeq;
        notReadyHint = true;
        pollCount = 0;
        tooLong = false;
        if (open) open = { ...open, zipState: "building", files: [] };
        notice = MSG_DL_NOT_READY;
        noticeTone = "ok";
        schedulePoll();
        await load(); // すぐ最新を読む（飛んでいる読み直しがあるときは何もしない。その応答のあとの時計で読み直される）
        return;
      }
      const url = r.ok ? downloadUrlOf(r.body) : null;
      if (!url) {
        notice = dlUrlErrorText(r.ok ? 500 : r.status, r.code);
        noticeTone = "error";
        return;
      }
      download(url);
      notice = MSG_DL_STARTED;
      noticeTone = "ok";
    } finally {
      if (gen === myGen) {
        busy = false;
        render();
      }
    }
  }

  function render() {
    expireIfDue();
    const parts = [el("h1", { text: DL_TITLE })];
    if (!key || !open) {
      if (!key) parts.push(el("p", { className: "error-text", "data-testid": "dl-unavailable", role: "alert", text: expired ? MSG_DL_EXPIRED : DL_UNAVAILABLE }));
      else if (notice) {
        // 最初の通信が失敗した：鍵はこのページが持っている。同じページで読み直せる（再読み込みでも、鍵は sessionStorage から戻る）
        parts.push(
          el("p", { className: "error-text", "data-testid": "dl-load-failed", role: "alert", text: notice }),
          el("button", { type: "button", className: "btn primary big", "data-action": "dl-retry", text: DL_RETRY_LABEL, disabled: loading, onclick: () => void retry() }),
          el("p", { className: "muted small", "data-testid": "dl-rescan", text: MSG_DL_RESCAN }),
        );
      } else parts.push(el("p", { className: "muted", role: "status", text: "読み込み中…" }));
    } else {
      const phase = dlPhase(open);
      if (phase === "preparing") {
        parts.push(el("p", { "data-testid": "dl-preparing", role: "status", text: dlPreparingLine(open.zipBytes) }), el("p", { className: "muted", text: DL_PREPARING_WAIT }));
        if (tooLong) parts.push(el("p", { className: "muted small", text: MSG_DL_PREPARING_LONG }));
      } else {
        const size = dlSizeLine(open);
        const left = dlRemainingLine(open, serverNow());
        const missing = dlMissingLine(open);
        parts.push(
          el("p", { "data-testid": "dl-ready", role: "status", text: DL_READY }),
          size ? el("p", { className: "muted", "data-testid": "dl-size", text: size }) : null,
          left ? el("p", { className: "muted small", "data-testid": "dl-left", text: left }) : null,
          el("ul", { className: "guide", "data-testid": "dl-guide" }, ...dlGuide(open.zipBytes).map((t) => el("li", { text: t }))),
          el("button", { type: "button", className: "btn primary big", "data-action": "dl-zip", text: DL_SAVE_ZIP, disabled: busy, onclick: () => void save() }),
          missing ? el("p", { className: "warn-text small", "data-testid": "dl-missing", text: missing }) : null,
        );
        if (open.files.length) {
          parts.push(
            el("h2", { text: DL_FILES_HEADING }),
            el(
              "ul",
              { className: "files", "data-testid": "dl-files" },
              ...open.files.map((f) =>
                el(
                  "li",
                  { "data-work": f.workId },
                  el("span", { className: "file-name", text: dlFileLabel(f) }),
                  el("button", { type: "button", className: "btn", "data-action": "dl-file", text: DL_SAVE_ONE, "aria-label": `${f.name} を保存`, disabled: busy, onclick: () => void save(f.workId) }),
                ),
              ),
            ),
          );
        }
      }
      if (notice) parts.push(el("p", { className: noticeTone === "error" ? "error-text" : "muted", "data-testid": "dl-notice", role: noticeTone === "error" ? "alert" : "status", text: notice }));
    }
    o.root.replaceChildren(...parts.filter((n) => n !== null));
  }

  /** 起動：鍵を取り出して URL から消し、読み込む */
  async function start() {
    key = keyFromHash(o.hash);
    o.dropHash(); // 鍵が正しくても間違っていても、URL の断片は消す
    if (key) {
      store.set(key); // 新しい QR の鍵は、前の鍵を上書きする
      storedOk = store.get() === key;
    }
    else if (o.hash === "") {
      // URL に断片が全く無い（再読み込み・同じタブで開き直した）：このタブに一時に置いた鍵があれば、それで読む。形が違えば捨てる。
      // 断片はあるが鍵の形が違う（壊れた QR）ときは、前の鍵に切り替えない（別のリンクの中身を見せない）
      const kept = store.get();
      key = typeof kept === "string" ? keyFromHash(`#k=${kept}`) : null;
      if (!key && kept) store.remove();
      storedOk = key !== null;
    } else {
      // 断片はあるが鍵の形が違う（壊れた QR）：前の鍵に切り替えず、置いてある前の鍵も消す（再読み込みで前の人・前のリンクの中身に戻らない）
      store.remove();
    }
    render();
    if (key) await load();
  }

  /**
   * 開いたまま、ページの断片が変わった（hashchange。同じタブで別の QR の URL を開いた・断片を打ち直した）：
   * 新しい鍵なら切り替えて読み込み、URL から消す。壊れた断片なら使えない旨を出して前の鍵も消す。同じ鍵・空の断片（消したあとの通知）は何もしない
   */
  async function onHash(hash) {
    if (typeof hash !== "string" || hash === "") return;
    const next = keyFromHash(hash);
    o.dropHash();
    if (next !== null && next === key) return;
    stopPoll();
    gen += 1; // 前の鍵の読み込み・保存の応答・時計は捨てる
    loading = false;
    notReadyHint = false;
    open = null;
    expired = false;
    notice = "";
    busy = false;
    pollCount = 0;
    slowCount = 0;
    retryCount = 0;
    tooLong = false;
    serverOffset = null;
    key = next;
    if (next === null) {
      store.remove();
      render();
      return;
    }
    store.set(next);
    storedOk = store.get() === next;
    render();
    await load();
  }

  /**
   * ページが（戻る・進むの bfcache から）戻ってきた（pageshow）。persisted のとき：置き場の鍵が消えていれば（マイページがログアウトで消した）鍵を捨てて「使えません」にする。
   * 鍵がまだあれば、時間が経っているので、最新を読み直す。persisted でない表示は何もしない
   */
  async function onShow(persisted) {
    if (!persisted || !key) return;
    if (!stillStored()) return;
    stopPoll();
    await load();
  }

  /**
   * ほかのタブの storage の知らせ。共有のログイン（STUDIO_STORAGE_KEY）が消えた（ログアウト・storage.clear()）ら、鍵を捨てて「使えません」にする。
   * ログインが残る更新（トークンの更新）・ほかの鍵の知らせは何もしない
   */
  async function onStorage(event) {
    if (!key) return;
    const k = event?.key ?? null;
    if (k !== null && k !== STUDIO_STORAGE_KEY) return;
    if (k !== null && storedUserId(event?.newValue ?? null)) return;
    unavailable();
  }

  return { start, onHash, onShow, onStorage, _state: () => ({ hasKey: key !== null, open, busy, loading }) };
}

// ---- ブラウザでの起動（試験では dl-app が無いので起動しない） ----
const root = globalThis.document?.getElementById?.("dl-app");
if (root) {
  const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
  const page = createDlPage({
    root,
    apiBase: `${SUPABASE_URL}/functions/v1/submissions`,
    apiKey: "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN",
    hash: window.location.hash,
    dropHash: () => window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`),
  });
  void page.start();
  // 開いたままで断片が変わったとき（replaceState での消去は hashchange を起こさない）
  window.addEventListener("hashchange", () => void page.onHash(window.location.hash));
  // 戻る・進むで bfcache から戻ったとき（Safari の既定）：マイページのログアウトで置き場の鍵が消えていれば、鍵を捨てる
  window.addEventListener("pageshow", (e) => void page.onShow(e.persisted === true));
  // ほかのタブでログアウトしたとき（共有のログインの storage の知らせ）：鍵を捨てる
  window.addEventListener("storage", (e) => void page.onStorage(e));
}
