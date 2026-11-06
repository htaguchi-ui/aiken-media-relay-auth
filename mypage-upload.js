// マイページから手元の動画（MP4・MOV）を直接提出する（組 11 の (8)。設計 kumi11-mypage-upload.md 2.4・2.7・4.2・4.5）。
// mypage.js から使う：createMyUpload({...}) を 1 つ作り、本人の画面を出したとき（poll ではない）に refresh()、画面の中身を消すときに clear()。
// refresh() は関数 submissions の GET /targets を読み、答えに「マイページから出せる」の印（upload.enabled）があるときだけ［動画を提出する］を出す。
// 印が無い（前の版の関数）・403・not_stage_student のときは隠す（関数を前の版に戻すことが、そのまま止めるスイッチになる。設計 2.6）。
// 押すと専用の <dialog>（Canvas の提出と同じ 2 段）：段 1 ファイルと提出先 → 段 2 公開の範囲（何も選ばれていない状態から）→ begin → TUS → complete。
// 入れた内容（段 2 にいる・タイトルか説明が空でない）があるときに Esc で閉じようとしたら、同じ窓の中で「入力内容を破棄しますか？」と聞く（組 13 の U-11）。
// 段 2 の［提出する］で、同じ提出先に同じファイル（同じ bytes）の動画があれば、同じ窓の中で「再度提出しますか？」と聞く（止めない。
// 設計 dup-confirm-20261105/DESIGN.md・D-1105-183x・191x）。作品の一覧（GET /my/works）は /targets と別に読み、遅れ・失敗は「作品なし」（確かめずに送る）。
// 手元のファイルは、名前・型・大きさ・先頭 12 バイト・ブラウザでの読み（<video> で縦横・長さ・最初の 1 コマ。probeVideo）を確かめてから送らせる。
// 判定と流れは upload-lib.js（純粋な部品）。試験は scripts/mypage_upload_nodetest.mjs（偽の fetch・TUS・probe）と、
// 本物の index.html（CSP つき）をヘッドレスのブラウザで開く scripts/mypage_upload_browser_check.mjs。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
// 断りの文のエラーコード（uploadErrorCode）は文の後ろに小さく薄く、ホバーの補足（uploadTip）は title に出す（組 13 の文言の表）。
import {
  acceptText,
  allowedScopes,
  checkFileName,
  checkHead,
  checkSize,
  createUploadFlow,
  defaultStageId,
  doneText,
  dupConfirmBody,
  errorCodeOf,
  initialScopeStep,
  isBridge,
  judgeProbe,
  PROBE_FRAME_TIMEOUT_MS,
  PROBE_META_TIMEOUT_MS,
  sameFileWorkNos,
  SCOPE_ORDER,
  scopeStepReducer,
  scopeStepView,
  stageOptions,
  stageRoomText,
  TEXT,
  UPLOAD_ACCEPT,
  UPLOAD_MAX_BYTES,
  uploadCaps,
  UploadApiError,
  uploadErrorCode,
  uploadTip,
  validateForm,
  validateSend,
} from "./upload-lib.js";
import { tusDelete } from "./tus-lib.js";
import { errorCodeLabel, formatBytes, formatDurationSec, normalizeMyWorks } from "./submissions-lib.js";

/**
 * 段 4（設計 2.4）：手元の動画を <video> で読む。画面には出さない。音は出さない（muted）。
 * 4a：preload="metadata" で loadedmetadata を待つ（既定 20 秒）。縦横と長さを読む。
 * 4b：readyState が 2 以上ならそこで通す。でなければ play()（muted）→ 決まったらすぐ pause() → loadeddata を待つ（既定 10 秒）。
 * どの結果でも、終わったら src を外し、URL.revokeObjectURL を必ず 1 回呼ぶ。
 * 返り値は upload-lib.js の judgeProbe に渡す形：{ meta: "loaded"|"error"|"timeout", duration, width, height, frame: "ok"|"error"|"timeout"|"refused"|null }。
 * play() の断り（NotAllowedError など）は握りつぶさず refused（＝確認）に写す。error の知らせが来ていれば error。
 */
export function probeVideo(file, opts = {}) {
  const createUrl = opts.createObjectURL ?? ((f) => URL.createObjectURL(f));
  const revokeUrl = opts.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
  const makeVideo = opts.createVideo ?? (() => document.createElement("video"));
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((id) => clearTimeout(id));
  const metaMs = opts.metaTimeoutMs ?? PROBE_META_TIMEOUT_MS;
  const frameMs = opts.frameTimeoutMs ?? PROBE_FRAME_TIMEOUT_MS;
  return new Promise((resolve) => {
    let url = null;
    let v = null;
    try {
      url = createUrl(file);
      v = makeVideo();
    } catch {
      if (url !== null) revokeUrl(url);
      resolve({ meta: "timeout", frame: null }); // 確かめられない（確認にする）
      return;
    }
    let finished = false;
    let timer = null;
    let stage = "meta";
    let meta = null;
    const listeners = [];
    const on = (type, fn) => {
      v.addEventListener(type, fn);
      listeners.push([type, fn]);
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearT(timer);
      for (const [t, f] of listeners) v.removeEventListener?.(t, f);
      try {
        v.pause?.();
      } catch {
        /* 止まっている */
      }
      try {
        v.removeAttribute("src");
        v.load?.();
      } catch {
        /* 外せなくても URL は戻す */
      }
      revokeUrl(url);
      resolve(result);
    };
    const frameOk = () => finish({ ...meta, frame: "ok" });
    const startFrame = () => {
      if (v.readyState >= 2) {
        frameOk();
        return;
      }
      timer = setT(() => finish({ ...meta, frame: "timeout" }), frameMs);
      on("loadeddata", frameOk);
      let p;
      try {
        p = v.play();
      } catch {
        finish({ ...meta, frame: v.error ? "error" : "refused" });
        return;
      }
      Promise.resolve(p).then(
        () => {
          if (finished) return;
          try {
            v.pause();
          } catch {
            /* 止められなくても先へ */
          }
          if (v.readyState >= 2) frameOk();
        },
        () => {
          if (!finished) finish({ ...meta, frame: v.error ? "error" : "refused" });
        },
      );
    };
    on("error", () => finish(stage === "meta" ? { meta: "error", frame: null } : { ...meta, frame: "error" }));
    on("loadedmetadata", () => {
      if (stage !== "meta" || finished) return;
      stage = "frame";
      if (timer !== null) clearT(timer);
      timer = null;
      meta = { meta: "loaded", duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      const okSize = v.videoWidth > 0 && v.videoHeight > 0;
      const okLen = Number.isFinite(v.duration) && v.duration > 0;
      // 映像が無い（縦横が 0）・長さが無い：ここで決まる（1 コマ目は読まない）
      if (!okSize || !okLen) {
        finish({ ...meta, frame: null });
        return;
      }
      startFrame();
    });
    timer = setT(() => finish({ meta: "timeout", frame: null }), metaMs);
    v.preload = "metadata";
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.src = url;
  });
}

const busyPhase = (p) => p.kind === "starting" || p.kind === "uploading" || p.kind === "completing";
/** 送り直しても通らず、選び直しても変わらない送り始めの断り（関数が前の版＝not_found・送り直しが続いた＝too_many_abandoned）。［閉じる］だけにする */
const deadEnd = (p) => p.kind === "failed" && p.workId === null && (p.hideButton === true || p.code === "too_many_abandoned");

/**
 * @param {object} o
 * @param {HTMLButtonElement} o.openBtn ［動画を提出する］（「提出した作品」の見出しの横。初めは hidden）
 * @param {HTMLDialogElement} o.dialog 提出の <dialog>（#upload-dialog）
 * @param {string} o.apiBase `submissions` 関数の基点（…/functions/v1/submissions）
 * @param {string} o.apiKey 公開用のキー
 * @param {() => Promise<{accountId: string, token: string} | null>} o.getSession 現在の本人 ID とトークン
 * @param {() => void} [o.onSubmitted] 提出が済んだとき（1 回の提出で 1 回）。マイページは一覧をすぐ読み直す
 * @param {(file: File) => Promise<object>} [o.probe] 段 4 の確かめ（既定は probeVideo。試験では差し替える）
 * @param {typeof fetch} [o.fetchImpl]
 * @param {Function} [o.transport] TUS の通信（既定は XMLHttpRequest。試験では差し替える）
 */
export function createMyUpload(o) {
  const fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  const probe = o.probe ?? ((file) => probeVideo(file));
  const readHead = o.readHead ?? (async (file) => new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimeout ?? ((id) => clearTimeout(id));
  const now = o.now ?? (() => Date.now());
  const win = o.win ?? globalThis.window ?? null;
  const defaultEndpoint = `${new URL(o.apiBase).origin}/storage/v1/upload/resumable/sign`;

  /** 世代。clear() だけで進め、進む前に始まった要求の応答は画面に入れない（ログアウト・別の人の画面を残さない） */
  let epoch = 0;
  let ownerId = null;
  let refreshSeq = 0;
  /** 関数の印（{ maxBytes, types }）。無ければ null（ボタンを出さない） */
  let caps = null;
  /** 開いているダイアログの 1 回分（閉じたら null） */
  let sess = null;
  /** 最後に使ったトークン（ログアウトで送信を止めるとき、cancel を 1 回試すため） */
  let bearer = null;
  let beforeUnloadOn = false;

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

  /**
   * 文を出す（textContent）。エラーコードがあれば最後の文の後ろに小さく薄く「（E-SUB-04）」（決まり 3.2 の案 A）、
   * ホバーの補足があれば title に置く（無ければ title を外す）
   */
  function setText(node, text, { code = null, tip = null } = {}) {
    node.textContent = text ?? "";
    if (code) node.append(el("span", { className: "err-code muted small", text: errorCodeLabel(code) }));
    if (tip) node.setAttribute("title", tip);
    else node.removeAttribute?.("title");
  }

  // ---- 本人の照らし（mypage-submissions.js の ticketFor・current と同じ形） ----

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

  /** 関数を呼ぶ。本人が替わった・clear() のあとは null（画面を変えない）。返り値：{ ok, status, code, body } */
  async function call(method, path, body, ticket) {
    const s = await current(ticket);
    if (!s) return null;
    bearer = s.token;
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
      if (!(await current(ticket))) return null;
      return { ok: false, status: 0, code: "network", body: null };
    }
    const json = await res.json().catch(() => null);
    if (!(await current(ticket))) return null;
    return { ok: res.ok, status: res.status, code: errorCodeOf(res.status, json), body: json };
  }

  function setAvailable(c) {
    caps = c;
    o.openBtn.hidden = !c;
  }

  // ---- 印を読む ----

  /** GET /targets の印を読み、ボタンを出す・隠す。返り値は "ok" | "fail" | "skip"（通信の失敗では今の出し方のまま） */
  async function refresh() {
    const seq = ++refreshSeq;
    const ticket = await ticketFor(true);
    if (!ticket || seq !== refreshSeq) return "skip";
    const r = await call("GET", "/targets", undefined, ticket);
    if (!r || seq !== refreshSeq || ticket.epoch !== epoch) return "skip";
    if (r.ok) {
      setAvailable(uploadCaps(r.body));
      return "ok";
    }
    // 受講者として登録されていない・関数が無い：ボタンを出さない
    if (r.status === 403 || r.status === 404 || r.code === "not_stage_student") {
      setAvailable(null);
      return "ok";
    }
    return "fail";
  }

  // ---- ダイアログ ----

  const alive = (s) => sess === s && s.ticket.epoch === epoch;

  function apiFor(s) {
    const req = async (method, path, body) => {
      const r = await call(method, path, body, s.ticket);
      if (!r) throw new UploadApiError(0, "stale");
      if (!r.ok) throw new UploadApiError(r.status, r.code, r.body && typeof r.body === "object" ? r.body : {});
      return r.body;
    };
    const enc = encodeURIComponent;
    return {
      begin: (b) => req("POST", "/my/uploads", b),
      complete: (id) => req("POST", `/uploads/${enc(id)}/complete`, {}),
      cancel: (id) => req("POST", `/uploads/${enc(id)}/cancel`, {}),
    };
  }

  const onBeforeUnload = (e) => {
    e.preventDefault();
    e.returnValue = "";
  };
  function syncBeforeUnload(want) {
    if (!win?.addEventListener) return;
    if (want && !beforeUnloadOn) {
      win.addEventListener("beforeunload", onBeforeUnload);
      beforeUnloadOn = true;
    } else if (!want && beforeUnloadOn) {
      win.removeEventListener("beforeunload", onBeforeUnload);
      beforeUnloadOn = false;
    }
  }

  async function open() {
    if (sess) {
      // 送信中に閉じられたまま残っている回（開き直せなかったなど）：新しく作らず、その回を開き直す（入れた内容もそのまま）
      if (!o.dialog.open && alive(sess)) {
        sess.confirmDiscard = false; // 自分で開き直したので、捨てるかは聞かない
        reopen(sess);
      }
      return;
    }
    if (!caps || o.dialog.open) return;
    const ticket = await ticketFor(true);
    if (!ticket || sess || !caps) return;
    const s = {
      ticket,
      load: "loading",
      targets: null,
      offsetMs: 0,
      myWorks: null,
      file: null,
      fileSeq: 0,
      check: { status: "none", message: null, meta: null },
      stageId: null,
      title: "",
      purpose: "",
      st: initialScopeStep(),
      pinned: null,
      phase: { kind: "idle" },
      staleFailure: null,
      confirmStop: false,
      /** 「入れた内容を捨てて閉じますか？」を出しているか（組 13 の U-11） */
      confirmDiscard: false,
      /** 「再度提出しますか？」を出しているか（同じ動画の確かめ。dup-confirm 3.3）と、その本文 */
      confirmDup: false,
      dupBody: "",
      /** 読み込みの番号（［再読み込み］の前に始まった作品の一覧の答えを捨てる） */
      loadSeq: 0,
      notified: false,
      lastStep: "form",
      optionsKey: "",
      tick: null,
      ui: null,
      flow: null,
    };
    s.flow = createUploadFlow({ api: apiFor(s), apiKey: o.apiKey, defaultEndpoint, transport: o.transport, retryWaitMs: o.retryWaitMs }, (p) => {
      if (!alive(s)) return;
      s.phase = p;
      if (p.kind === "failed" && p.hideButton) setAvailable(null);
      syncBeforeUnload(busyPhase(p));
      // 送信が終わったら「送信をやめますか？」の印も消す（次の送信で確かめが勝手に出ない）
      if (!busyPhase(p)) s.confirmStop = false;
      if (p.kind === "done" && !s.notified) {
        s.notified = true;
        o.onSubmitted?.();
      }
      update(s);
      // 保険：送信が終わったのにダイアログが閉じている（開き直せなかった）なら、回を片付けて［動画を提出する］で開けるようにする
      if (!busyPhase(p) && alive(s) && !o.dialog.open) endSession(s);
    });
    sess = s;
    buildDom(s);
    o.dialog.className = "my-dialog upload-dialog";
    o.dialog.showModal();
    s.ui.title.focus?.();
    const loop = () => {
      s.tick = setT(() => {
        if (!alive(s)) return;
        update(s); // 「あと ○ 分」などを書き換える
        loop();
      }, 15_000);
    };
    loop();
    await loadTargets(s);
  }

  async function loadTargets(s) {
    const seq = ++s.loadSeq;
    s.load = "loading";
    s.myWorks = null;
    update(s);
    // 作品の一覧（同じ動画の確かめに使うだけ）は /targets と別に読む。段 1 を待たせない。遅れ・失敗は「作品なし」（dup-confirm 5.2 の 8）
    void call("GET", "/my/works", undefined, s.ticket)
      .then((w) => {
        if (alive(s) && seq === s.loadSeq) s.myWorks = w?.ok ? normalizeMyWorks(w.body) : null;
      })
      .catch(() => {});
    const t = await call("GET", "/targets", undefined, s.ticket);
    if (!alive(s) || !t || seq !== s.loadSeq) return;
    if (!t.ok) {
      if (t.status === 403 || t.status === 404 || t.code === "not_stage_student") {
        setAvailable(null);
        s.load = "unavailable";
      } else s.load = "error";
      update(s);
      return;
    }
    const c = uploadCaps(t.body);
    if (!c) {
      setAvailable(null);
      s.load = "unavailable";
      update(s);
      return;
    }
    setAvailable(c);
    const serverNow = Date.parse(t.body?.server_now ?? "");
    s.targets = t.body;
    s.offsetMs = Number.isFinite(serverNow) ? serverNow - now() : 0;
    s.load = "ready";
    update(s);
  }

  async function pickFile(s, file) {
    const my = ++s.fileSeq;
    const fresh = () => alive(s) && my === s.fileSeq;
    s.file = file ?? null;
    s.check = file ? { status: "checking", message: null, meta: null } : { status: "none", message: null, meta: null };
    update(s);
    if (!file) return;
    // 段 1・2：名前と型・大きさ → 段 3：先頭 12 バイト → 段 4：ブラウザで読む
    let msg = checkFileName(file) ?? checkSize(file.size, caps?.maxBytes ?? UPLOAD_MAX_BYTES);
    if (!msg) {
      let head = null;
      try {
        head = await readHead(file);
      } catch {
        head = null;
      }
      if (!fresh()) return;
      msg = head ? checkHead(head) : TEXT.unreadable;
    }
    if (msg) {
      s.check = { status: "reject", message: msg, meta: null };
      update(s);
      return;
    }
    let ev;
    try {
      ev = await probe(file);
    } catch {
      ev = { meta: "timeout", frame: null };
    }
    if (!fresh()) return;
    const j = judgeProbe(ev);
    s.check = { status: j.verdict, message: j.message, meta: j.meta };
    update(s);
  }

  /**
   * 捨てると困る入力があるか（組 13 の U-11）：まだ入力の形（送っていない）で、段 2 にいるか、タイトル・説明のどちらかが空でない。
   * 送信が済んだ・やめた・送れない断りのあとは聞かない
   */
  function hasDraft(s) {
    if (!alive(s) || s.load !== "ready") return false;
    return draftIn(s, derive(s));
  }
  /** hasDraft の判定（derive の答え d を渡す） */
  const draftIn = (s, d) => d.form && (s.st.step === "scope" || s.title.trim() !== "" || s.purpose.trim() !== "");

  /** 同じ窓の中で「入れた内容を捨てて閉じますか？」を出す（ダイアログを重ねない） */
  function askDiscard(s) {
    s.confirmDiscard = true;
    s.confirmDup = false; // 2 つの確かめを同時に出さない
    update(s);
    s.ui?.discardKeepBtn.focus?.();
  }

  /**
   * 閉じる（［やめる］・［閉じる］・Esc）。送信中は「送信をやめますか？」。確定待ちの失敗は捨ててから閉じる（Canvas と同じ）。
   * esc：Esc で閉じようとした（押し間違えやすい）。入れた内容があれば、閉じずに捨てるかを聞く（組 13 の U-11）。
   * 「再度提出しますか？」を出している間は、［キャンセル］と同じ（段 2 に戻る。破棄の確かめには進まない。dup-confirm 3.3）
   */
  function requestClose(s, { esc = false } = {}) {
    if (!alive(s)) return;
    if (s.phase.kind === "completing") return; // 確かめている最中は閉じない（すぐ終わる）
    if (busyPhase(s.phase)) {
      s.confirmStop = true;
      update(s);
      s.ui.keepBtn.focus?.();
      return;
    }
    if (s.confirmDup) {
      cancelDup(s);
      return;
    }
    if (esc && hasDraft(s)) {
      if (!s.confirmDiscard) askDiscard(s);
      return;
    }
    if (s.phase.kind === "failed" && s.phase.workId) void s.flow.discard();
    endSession(s);
  }

  /** 閉じられたダイアログを同じ回のまま開き直す。送信中（starting・uploading）なら「送信をやめますか？」を出す */
  function reopen(s) {
    try {
      if (!o.dialog.open) o.dialog.showModal();
    } catch {
      return; // 開き直せない：送信の終わりに onChange の保険で片付ける
    }
    update(s);
    if (busyPhase(s.phase)) requestClose(s);
    else s.ui?.title.focus?.();
  }

  function endSession(s) {
    if (s.tick !== null) clearT(s.tick);
    s.tick = null;
    if (sess === s) sess = null;
    s.ui = null;
    syncBeforeUnload(false);
    if (o.dialog.open) o.dialog.close();
    o.dialog.replaceChildren();
    if (!o.openBtn.hidden) o.openBtn.focus?.();
  }

  // 入れ物の <dialog> の知らせは 1 回だけ付ける（開くたびに足さない）
  o.dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (sess) requestClose(sess, { esc: true });
  });
  o.dialog.addEventListener("close", () => {
    const s = sess;
    if (!s) return;
    // 閉じられたら「再度提出しますか？」は下ろす（開き直したときに、破棄の確かめと同時に出さない。確かめの P3-3）
    s.confirmDup = false;
    // 送信中に閉じられた（Esc の 2 回目：close watcher は cancel を止めても、操作の無いまま 2 回目が来ると閉じる）：
    // 送信は裏で続くので、開き直して「送信をやめますか？」を出す（確かめている最中＝completing は開き直すだけ）
    if (busyPhase(s.phase)) {
      reopen(s);
      return;
    }
    // 入れた内容があるのに閉じられた（Esc の 2 回目など）：開き直して「入れた内容を捨てて閉じますか？」を出す（組 13 の U-11）。
    // 開き直せなければ回を残し、［動画を提出する］で同じ回（入れた内容のまま）を開き直す
    if (hasDraft(s)) {
      try {
        o.dialog.showModal();
      } catch {
        return;
      }
      askDiscard(s);
      return;
    }
    // ほかの手で閉じられた（送信中でなければ、閉じたものとして片付ける）
    endSession(s);
  });
  o.openBtn.addEventListener("click", () => void open());

  // ---- ダイアログの中身（開くたびに 1 回作り、update で文字と見え方だけを変える） ----

  function buildDom(s) {
    const u = {};
    const go = (fn) => () => {
      if (alive(s)) fn();
    };
    // 読み込み・使えない
    u.loadMsg = el("p", { role: "status" });
    u.loadReload = el("button", { type: "button", className: "btn primary", text: TEXT.reload, onclick: go(() => void loadTargets(s)) });
    u.loadClose = el("button", { type: "button", className: "btn", text: TEXT.close, onclick: go(() => requestClose(s)) });
    u.loadBox = el("div", { className: "upload-load" }, u.loadMsg, el("div", { className: "row" }, u.loadClose, u.loadReload));

    // 段 1
    u.title = el("h2", { id: "upload-title", tabindex: "-1", text: TEXT.title });
    u.intro = el("p", { className: "small", text: TEXT.bridgeIntro });
    u.fileInput = el("input", { type: "file", id: "upload-file", accept: UPLOAD_ACCEPT, className: "upload-file-input" });
    u.fileInput.addEventListener("change", go(() => void pickFile(s, u.fileInput.files?.[0] ?? null)));
    u.fileInfo = el("div", { className: "small upload-file-info", "data-upload": "file-info" });
    u.check = el("p", { className: "small", "data-upload": "check", role: "status" });
    u.stageSelect = el("select", { id: "upload-stage", className: "input compact-select" });
    u.stageSelect.addEventListener("change", go(() => {
      s.stageId = u.stageSelect.value;
      update(s);
    }));
    u.accept = el("p", { className: "small", "data-upload": "accept" });
    u.room = el("p", { className: "small muted", "data-upload": "room" });
    u.titleInput = el("input", { type: "text", id: "upload-work-title", className: "input", maxlength: "120" });
    u.titleInput.addEventListener("input", go(() => {
      s.title = u.titleInput.value;
      update(s);
    }));
    u.purposeInput = el("textarea", { id: "upload-purpose", className: "input", maxlength: "800", rows: "3" });
    u.purposeInput.addEventListener("input", go(() => {
      s.purpose = u.purposeInput.value;
      update(s);
    }));
    u.bridgeFields = el(
      "div",
      { className: "upload-fields" },
      el("label", { className: "upload-label", for: "upload-work-title", text: TEXT.fieldTitle }),
      u.titleInput,
      el("label", { className: "upload-label", for: "upload-purpose", text: TEXT.fieldPurpose }),
      u.purposeInput,
    );
    u.formWhy = el("p", { className: "small muted", "data-upload": "why-form" });
    u.formCancel = el("button", { type: "button", className: "btn", text: TEXT.cancel, "data-action": "upload-close", onclick: go(() => requestClose(s)) });
    u.nextBtn = el("button", { type: "button", className: "btn primary", text: TEXT.next, "data-action": "upload-next", onclick: go(() => next(s)) });
    u.formBox = el(
      "div",
      { className: "upload-step", "data-step": "form" },
      u.title,
      u.intro,
      el("div", { className: "upload-fields" }, el("label", { className: "upload-label", for: "upload-file", text: TEXT.file }), u.fileInput, u.fileInfo),
      u.check,
      el("div", { className: "upload-fields" }, el("label", { className: "upload-label", for: "upload-stage", text: TEXT.stage }), u.stageSelect, u.accept, u.room),
      u.bridgeFields,
      u.formWhy,
      el("div", { className: "row" }, u.formCancel, u.nextBtn),
    );

    // 段 2
    u.scopeTitle = el("h2", { id: "upload-scope-title", tabindex: "-1", text: TEXT.scopeStepTitle });
    u.stageLine = el("div", { className: "upload-stage-line", "data-upload": "stage-line" });
    u.radios = new Map();
    // 丸は 3 つとも 1 回だけ作り、選べない範囲（ワークショップの完全非公開）は update で項目ごと隠す（D-1106-120x）
    u.scopeItems = new Map();
    const items = SCOPE_ORDER.map((opt) => {
      const r = el("input", { type: "radio", name: "upload-scope", value: opt.value });
      r.addEventListener("change", go(() => {
        s.st = scopeStepReducer(s.st, { type: "pick", scope: opt.value });
        update(s);
      }));
      u.radios.set(opt.value, r);
      // 範囲の説明は、それぞれの丸の下に常に 1 行（D-1104-130x-c）。「公開」を選べないときは、その理由をもう 1 行（続きはホバー）
      const kids = [el("label", { className: "upload-scope-label" }, r, el("span", { text: opt.label })), el("span", { className: "small muted", "data-upload": `scope-note-${opt.value}`, text: opt.note })];
      if (opt.value === "public") {
        u.publicNote = el("span", { className: "small muted", "data-upload": "public-note", hidden: true });
        kids.push(u.publicNote);
      }
      const item = el("div", { className: "upload-scope-item" }, ...kids);
      u.scopeItems.set(opt.value, item);
      return item;
    });
    u.scopeGroup = el("div", { className: "upload-scope", role: "radiogroup", "aria-labelledby": "upload-scope-title" }, ...items);
    u.consentBody = el("div", { className: "consent-body" });
    u.consentCheck = el("input", { type: "checkbox", id: "upload-consent" });
    u.consentCheck.addEventListener("change", go(() => {
      s.st = scopeStepReducer(s.st, { type: "consent", on: !!u.consentCheck.checked });
      update(s);
    }));
    u.consentBox = el("div", { className: "my-consent" }, u.consentBody, el("label", { className: "small", for: "upload-consent" }, u.consentCheck, ` ${TEXT.consentCheck}`));
    u.progress = el("progress", { max: "100", "aria-label": "送信の進み具合" });
    u.stateText = el("div", { className: "small", "data-upload": "state" });
    u.stateBox = el("div", { role: "status" }, u.progress, u.stateText);
    u.errorText = el("p", { className: "error-text small", role: "alert", "data-upload": "error" });
    u.keepBtn = el("button", { type: "button", className: "btn", text: TEXT.keepGoing, "data-action": "upload-keep", onclick: go(() => {
      s.confirmStop = false;
      update(s);
    }) });
    // 送信の中止は取り消せない確定なので、管理コンソールの確認と同じ赤で塗る（組 13 の U-12。CSS は index.html の .btn.danger-fill）
    u.stopBtn = el("button", { type: "button", className: "btn danger-fill", text: TEXT.cancelSend, "data-action": "upload-stop", onclick: go(() => {
      s.confirmStop = false;
      update(s);
      void s.flow.cancel();
    }) });
    u.confirmBox = el("div", { className: "upload-confirm" }, el("p", { text: TEXT.confirmStop }), el("div", { className: "row" }, u.keepBtn, u.stopBtn));
    u.scopeWhy = el("p", { className: "small muted", "data-upload": "why-scope" });
    u.backBtn = el("button", { type: "button", className: "btn", text: TEXT.back, "data-action": "upload-back", onclick: go(() => back(s)) });
    u.submitBtn = el("button", { type: "button", className: "btn primary", text: TEXT.submitWorkshop, "data-action": "upload-submit", onclick: go(() => submit(s)) });
    u.cancelSendBtn = el("button", { type: "button", className: "btn", text: TEXT.cancel, "data-action": "upload-cancel", onclick: go(() => void s.flow.cancel()) });
    u.closeBtn = el("button", { type: "button", className: "btn", text: TEXT.close, "data-action": "upload-close", onclick: go(() => requestClose(s)) });
    u.retryBtn = el("button", { type: "button", className: "btn primary", text: TEXT.retry, "data-action": "upload-retry", onclick: go(() => void s.flow.retry()) });
    u.againBtn = el("button", { type: "button", className: "btn primary", text: TEXT.again, "data-action": "upload-again", onclick: go(() => submit(s)) });
    u.scopeBox = el(
      "div",
      { className: "upload-step", "data-step": "scope" },
      u.scopeTitle,
      u.stageLine,
      u.scopeGroup,
      u.consentBox,
      u.stateBox,
      u.errorText,
      u.confirmBox,
      u.scopeWhy,
      el("div", { className: "row" }, u.backBtn, u.cancelSendBtn, u.closeBtn, u.submitBtn, u.retryBtn, u.againBtn),
    );

    // 入れた内容を捨てて閉じるかの確かめ（組 13 の U-11）。段 1・段 2 のどちらでも、窓のいちばん下に出す。
    // 破棄しないボタンは［キャンセル］（送信の中止の確認の［続ける］とは別の値）
    u.discardKeepBtn = el("button", { type: "button", className: "btn", text: TEXT.discardKeep, "data-action": "upload-discard-keep", onclick: go(() => {
      s.confirmDiscard = false;
      update(s);
      (s.st.step === "scope" ? u.scopeTitle : u.title).focus?.();
    }) });
    u.discardBtn = el("button", { type: "button", className: "btn danger-fill", text: TEXT.discardClose, "data-action": "upload-discard", onclick: go(() => {
      s.confirmDiscard = false;
      endSession(s);
    }) });
    u.discardBox = el("div", { className: "upload-confirm upload-discard", "data-upload": "discard" }, el("p", { text: TEXT.confirmDiscard }), el("div", { className: "row" }, u.discardKeepBtn, u.discardBtn));

    // 同じ動画の確かめ（dup-confirm 3.3）。出している間は段 2 の中身を隠し、題・本文・2 つのボタンだけにする（選んだ範囲と同意は残る）。
    // ［提出する］は消す操作ではないので赤にしない。エラーではないのでコードは付けない
    u.dupCancelBtn = el("button", { type: "button", className: "btn", text: TEXT.cancel, "data-action": "upload-dup-cancel", onclick: go(() => cancelDup(s)) });
    u.dupConfirmBtn = el("button", { type: "button", className: "btn primary", text: TEXT.submitWorkshop, "data-action": "upload-dup-confirm", onclick: go(() => sendAfterDup(s)) });
    u.dupText = el("p", { id: "upload-dup-text" });
    u.dupBox = el(
      "div",
      { className: "upload-confirm upload-dup", "data-upload": "dup", role: "group", "aria-labelledby": "upload-dup-title", "aria-describedby": "upload-dup-text" },
      el("p", { id: "upload-dup-title" }, el("strong", { text: TEXT.dupTitle })),
      u.dupText,
      el("div", { className: "row" }, u.dupCancelBtn, u.dupConfirmBtn),
    );

    s.ui = u;
    o.dialog.replaceChildren(el("div", { className: "my-dialog-body upload-body" }, u.loadBox, u.formBox, u.scopeBox, u.dupBox, u.discardBox));
  }

  /** 今の状態から、見え方を決める（判定は upload-lib.js の関数の答えだけを使う） */
  function derive(s) {
    const ready = s.load === "ready";
    const serverNow = now() + s.offsetMs;
    const options = ready ? stageOptions(s.targets, serverNow) : [];
    const open = options.filter((x) => !x.disabled);
    const picked = (open.find((x) => x.value === s.stageId) ?? open.find((x) => x.value === defaultStageId(options)))?.stage ?? null;
    const inScope = s.st.step === "scope";
    const chosen = inScope ? s.st.stage : picked;
    const phase = s.phase;
    // 送り始めの失敗（送り直しても通らない断り）は、選び直せるよう、入力の形に戻す（段 2 のまま断りの文を出す）
    // 関数が前の版（not_found）・送り直しが続いた（too_many_abandoned）は入力に戻さない（［閉じる］だけ）
    const form = phase.kind === "idle" || (phase.kind === "failed" && phase.workId === null && phase.retryFrom === null && !deadEnd(phase));
    const bridge = !!chosen && isBridge(chosen);
    const consentRaw = s.targets?.consent;
    const consent = consentRaw && typeof consentRaw.id === "string" && typeof consentRaw.body === "string" ? consentRaw : null;
    const loginKind = s.targets?.login_kind === "google" ? "google" : s.targets?.login_kind === "link" ? "link" : "other";
    const view = scopeStepView(s.st, { nowMs: serverNow, loginKind, legalReviewed: consent?.legal_reviewed === true, consent, form });
    const survey = bridge ? { title: s.title, purpose: s.purpose } : undefined;
    const maxBytes = caps?.maxBytes ?? UPLOAD_MAX_BYTES;
    const formInvalid = chosen ? validateForm({ stage: chosen, file: s.file, check: s.check, survey, maxBytes }) : TEXT.noStage;
    const input =
      inScope && chosen && s.pinned
        ? { stage: chosen, file: s.pinned.file, meta: s.pinned.meta, survey, scope: s.st.scope, consentTextId: s.st.scope === "public" ? (consent?.id ?? null) : null, consented: s.st.consented, maxBytes }
        : null;
    const sendBlock = view.reason ?? (input ? validateSend(input) : TEXT.scopeMissing);
    return { ready, serverNow, options, picked, inScope, chosen, form, bridge, consent, view, formInvalid, input, sendBlock };
  }

  function next(s) {
    const d = derive(s);
    if (!d.form || !d.picked || d.formInvalid) return;
    s.staleFailure = s.phase.kind === "failed" ? s.phase : null;
    // 段 2 で送るファイルと読んだ値は、［次へ］を押した時点のものに固定する
    s.pinned = { file: s.file, meta: s.check.meta ?? null };
    s.st = scopeStepReducer(s.st, { type: "next", stage: d.picked });
    update(s);
  }

  function back(s) {
    if (!derive(s).form) return;
    s.pinned = null;
    s.st = scopeStepReducer(s.st, { type: "back" });
    update(s);
  }

  /** 送る（今の入力で flow の start を 1 回）。送れない状態なら何もしない。返り値は送ったか */
  function send(s) {
    const d = derive(s);
    if (!d.input || d.sendBlock || busyPhase(s.phase) || deadEnd(s.phase)) return false;
    s.staleFailure = null;
    void s.flow.start(d.input);
    return true;
  }

  /**
   * 段 2 の［提出する］・［再提出］。同じ提出先に同じファイル（同じ bytes）の動画があれば、送る前に「再度提出しますか？」を出す（dup-confirm 3.1）。
   * 判定は段 2 で固定した提出先とファイルで行う。作品の一覧が読めていなければ確かめずに送る。確かめを出している間は受け付けない（二度押し）
   */
  function submit(s) {
    if (s.confirmDup) return;
    const d = derive(s);
    // 押せるのは、入力の形の［提出する］と、送信をキャンセルしたあとの［再提出］だけ（済んだあとに確かめを出さない）
    if (!(d.form || s.phase.kind === "cancelled")) return;
    if (!d.input || d.sendBlock || busyPhase(s.phase) || deadEnd(s.phase)) return;
    const nos = sameFileWorkNos(s.myWorks, d.input.stage.stage_id, d.input.file.size);
    if (nos.length > 0) {
      s.confirmDup = true;
      s.dupBody = dupConfirmBody(d.input.stage.label, nos);
      update(s);
      s.ui?.dupCancelBtn.focus?.(); // 反射の Enter で 2 本目を作らない
      return;
    }
    send(s);
  }

  /** 確かめの［キャンセル］・Esc：段 2 に戻る（選んだ範囲と同意は残る。送らない）。フォーカスは段 2 の見出し */
  function cancelDup(s) {
    if (!s.confirmDup) return;
    s.confirmDup = false;
    update(s);
    s.ui?.scopeTitle.focus?.();
  }

  /** 確かめの［提出する］：今と同じ提出（新しい動画として数える）。1 回だけ送る。フォーカスは段 2 の見出し */
  function sendAfterDup(s) {
    if (!s.confirmDup) return;
    s.confirmDup = false;
    if (!send(s)) update(s);
    s.ui?.scopeTitle.focus?.();
  }

  function update(s) {
    const u = s.ui;
    if (!u || !alive(s)) return;
    const d = derive(s);
    const phase = s.phase;

    // 読み込み・使えない・提出先が無い
    const noStage = d.ready && !d.chosen;
    u.loadBox.hidden = d.ready && !noStage;
    u.loadMsg.textContent = s.load === "loading" ? TEXT.loading : s.load === "error" ? TEXT.loadFailed : s.load === "unavailable" ? TEXT.unavailable : noStage ? TEXT.noStage : "";
    u.loadMsg.className = s.load === "error" ? "error-text" : "";
    u.loadReload.hidden = s.load !== "error";
    u.loadClose.hidden = s.load === "loading";

    const showForm = d.ready && !!d.chosen && !d.inScope;
    const showScope = d.ready && !!d.chosen && d.inScope;
    // 送り始めた・済んだ・段 2 を離れたら「再度提出しますか？」は下ろす
    if (s.confirmDup && (!showScope || busyPhase(phase) || phase.kind === "done" || deadEnd(phase))) s.confirmDup = false;
    const showDup = showScope && s.confirmDup;
    u.formBox.hidden = !showForm;
    // 確かめを出している間は段 2 の中身（ボタンを含む）を隠す：ボタンが 4 つ並んで取り違えない（dup-confirm 3.3）
    u.scopeBox.hidden = !showScope || showDup;
    u.dupBox.hidden = !showDup;
    u.dupText.textContent = showDup ? s.dupBody : "";
    u.dupConfirmBtn.textContent = d.bridge ? TEXT.submitBridge : TEXT.submitWorkshop;
    o.dialog.setAttribute("aria-label", d.inScope ? TEXT.scopeStepTitle : TEXT.title);

    // 段 1
    u.intro.hidden = !d.bridge;
    const f = s.file;
    if (f) {
      const m = s.check.meta;
      const dur = m ? formatDurationSec(m.duration) : null;
      const size = m && m.width && m.height ? `${Math.round(m.width)}×${Math.round(m.height)}` : null;
      u.fileInfo.textContent = [f.name, formatBytes(f.size), dur, size].filter(Boolean).join(" · ");
    } else u.fileInfo.textContent = "";
    u.check.textContent = s.check.status === "checking" ? TEXT.checking : s.check.status === "reject" || s.check.status === "confirm" ? (s.check.message ?? "") : "";
    u.check.className = s.check.status === "reject" ? "error-text small" : "small";
    u.check.hidden = !u.check.textContent;
    const key = JSON.stringify(d.options.map((x) => [x.value, x.label, x.disabled]));
    if (key !== s.optionsKey) {
      s.optionsKey = key;
      u.stageSelect.replaceChildren(...d.options.map((x) => el("option", { value: x.value, text: x.label, disabled: x.disabled })));
    }
    if (d.picked) u.stageSelect.value = d.picked.stage_id;
    u.stageSelect.disabled = !d.form;
    u.fileInput.disabled = !d.form;
    u.accept.textContent = d.picked ? acceptText(d.picked, d.serverNow) : "";
    u.room.textContent = d.picked ? stageRoomText(d.picked, s.targets?.storage) : "";
    u.bridgeFields.hidden = !d.bridge;
    u.formWhy.textContent = d.formInvalid && d.formInvalid !== u.check.textContent ? d.formInvalid : "";
    u.formWhy.hidden = !u.formWhy.textContent;
    u.nextBtn.disabled = !!d.formInvalid || !d.form;

    // 段 2
    u.stageLine.textContent = d.view.stageLine;
    // 固定した提出先で選べない範囲は、項目（丸と下の説明の 1 行）ごと隠し、チェックも外す（ワークショップは講義内・公開の 2 つ。D-1106-120x）
    const allowed = allowedScopes(d.chosen);
    for (const [value, r] of u.radios) {
      const shown = allowed.includes(value);
      u.scopeItems.get(value).hidden = !shown;
      r.checked = shown && s.st.scope === value;
      r.disabled = !d.form || (value === "public" && !!d.view.publicBlocked);
    }
    if (u.publicNote) {
      setText(u.publicNote, d.view.publicBlocked ?? "", { tip: uploadTip(d.view.publicBlocked) });
      u.publicNote.hidden = !d.view.publicBlocked;
    }
    u.consentBox.hidden = !(d.view.showConsent && d.consent);
    u.consentBody.textContent = d.consent?.body ?? "";
    u.consentCheck.checked = s.st.consented;
    u.consentCheck.disabled = !d.form;

    const pct = phase.kind === "uploading" ? Math.floor((phase.sent / Math.max(1, phase.total)) * 100) : 0;
    u.progress.hidden = phase.kind !== "uploading";
    u.progress.value = pct;
    let state = "";
    if (phase.kind === "starting") state = phase.cancelling ? TEXT.cancelling : TEXT.starting;
    else if (phase.kind === "uploading") state = `${TEXT.uploading} ${pct}%（${formatBytes(phase.sent)} / ${formatBytes(phase.total)}）`;
    else if (phase.kind === "completing") state = TEXT.completing;
    else if (phase.kind === "done") state = doneText(phase.workNo, phase.remaining);
    else if (phase.kind === "cancelled") state = phase.notSent ? TEXT.cancelNotSent : TEXT.cancelled;
    setText(u.stateText, state, { tip: uploadTip(state) });
    u.stateBox.hidden = !state;
    u.stateBox.setAttribute("data-upload-state", phase.kind);
    const failed = phase.kind === "failed" && phase !== s.staleFailure;
    setText(u.errorText, failed ? phase.message : "", failed ? { code: uploadErrorCode(phase.message), tip: uploadTip(phase.message) } : {});
    u.errorText.hidden = !failed;
    u.confirmBox.hidden = !(s.confirmStop && busyPhase(phase));
    // 送り始めたら・入れた内容が無くなったら、捨てるかの確かめは下ろす
    if (s.confirmDiscard && !draftIn(s, d)) s.confirmDiscard = false;
    u.discardBox.hidden = !s.confirmDiscard;
    // 送信をキャンセルしたあとは［戻る］が出ないので、受付が終わった提出先の文は次の手の無い形にする
    const why = (d.form || phase.kind === "cancelled") && d.sendBlock ? (phase.kind === "cancelled" && d.sendBlock === TEXT.stageEnded ? TEXT.stageEndedNoBack : d.sendBlock) : "";
    setText(u.scopeWhy, why, { tip: uploadTip(why) });
    u.scopeWhy.hidden = !why;

    u.backBtn.hidden = !d.form;
    u.submitBtn.hidden = !d.form;
    u.submitBtn.textContent = d.bridge ? TEXT.submitBridge : TEXT.submitWorkshop;
    u.submitBtn.disabled = !!d.sendBlock || deadEnd(phase);
    u.cancelSendBtn.hidden = !((phase.kind === "starting" && !phase.cancelling) || phase.kind === "uploading") || u.confirmBox.hidden === false;
    u.closeBtn.hidden = d.form || !(phase.kind === "done" || phase.kind === "cancelled" || phase.kind === "failed");
    u.retryBtn.hidden = !(phase.kind === "failed" && phase.retryFrom);
    u.againBtn.hidden = phase.kind !== "cancelled";
    u.againBtn.disabled = !!d.sendBlock;

    // 段が変わったら見出しへ、段 1 に戻ったら提出先の選択へ（押したボタンが消えてもフォーカスを失わない）
    if (s.lastStep !== s.st.step) {
      s.lastStep = s.st.step;
      if (s.st.step === "scope") u.scopeTitle.focus?.();
      else u.stageSelect.focus?.();
    }
  }

  // ---- 消す ----

  /** 本人のデータを画面から消す（ログアウト・画面を離れるとき）。送っている途中なら送信を止め、TUS の DELETE とサーバーの cancel を 1 回試す */
  function clear() {
    epoch += 1;
    refreshSeq += 1;
    ownerId = null;
    setAvailable(null);
    const s = sess;
    const token = bearer;
    bearer = null;
    if (s) {
      const h = s.flow.halt();
      if (h) {
        if (h.tusUrl && h.tusArgs) void tusDelete(h.tusArgs, h.tusUrl).catch(() => false);
        if (token) {
          void Promise.resolve()
            .then(() =>
              fetchImpl(`${o.apiBase}/uploads/${encodeURIComponent(h.workId)}/cancel`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, apikey: o.apiKey, "Content-Type": "application/json" },
                body: "{}",
                keepalive: true,
                cache: "no-store",
                referrerPolicy: "no-referrer",
                credentials: "omit",
              }),
            )
            .catch(() => {});
        }
      }
      endSession(s);
    }
    syncBeforeUnload(false);
    if (o.dialog.open) o.dialog.close();
    o.dialog.replaceChildren();
  }

  return {
    refresh,
    clear,
    /** 送っている途中か */
    busy: () => !!sess && busyPhase(sess.phase),
    /** 提出のダイアログが開いているか（約 10 秒の読み直しは、開いている間は読まない） */
    isOpen: () => !!o.dialog.open,
    _state: () => ({ epoch, caps, sess }),
  };
}
