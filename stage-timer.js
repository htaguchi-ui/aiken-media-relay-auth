// 講師ページの制作時間のタイマー（KT）の札。設計 docs/design-workshop-guide.md 第 1.3.1 版 4.5・約束 .orchestration/wt/d2/kt-contract.md。
// instructor.js からは「作る・読む・札を描く・消す」の 4 か所だけで使う（講師ページの持ち物を増やさない。分割を外しても当て直せる）。
// 壊れても既存の操作を止めない：読み込み・描画・1 秒ごとの書き換えは全部 try/catch で囲み、失敗したら札を出さない（コンソールに 1 行）。
// 書き込み（始める・延ばす・取り消す）は、講師ページの withBusy を通す（二重に押させない・操作のページの回だけに送る）。
// 30 秒ごとの読み直しは、札が画面にある間だけ（ほかの人の延長・取り消し・管理コンソールからの段階の移動を拾う）。
// 一時的な失敗（通信など）で読めなくても札は消さず、前に読んだ表示を残す。続けて読めないときだけ「つながりません」と［最新にする］を出す。
// 読み直しで段階が変わったと分かったら、講師ページ全体を読み直す（reload。「今」の行と札を同じ段階にそろえる）。
// 組 11 の (6)：WS のカードの右上に残りを分：秒で出す（clock。1 秒ごとに書き換える）。始める分の既定は回の WS の分（5〜180 に切り詰め）。
// 組 13：回の WS の分があるときは主ボタン［▶ 45 分で始める］を 1 つにし、プリセットと分の欄は「分を指定」に畳む（U-07）。
// 段階の名前の行は「今」の行と重なるので出さない（U-07）。［取り消す…］は「タイマーを消す…」（U-10 の T-08）。
// 残りの横の［大きく表示］で、全画面に段階の名前・大きな残り・終わる時刻を出す（U-09。#timer-screen。1 秒ごとの書き換えに乗る）。
import {
  defaultMinutesNote,
  defaultTimerMinutes,
  extendDoneText,
  formatClock,
  extendLabel,
  isTransientTimerError,
  normalizeTimerStatus,
  parseTimerMinutes,
  startDoneText,
  TIMER_PRESETS,
  timerErrorCode,
  timerErrorText,
  timerView,
} from "./stage-timer-lib.js";
import { stageName } from "./stage-lib.js";

const TICK_MS = 1000;
const POLL_TICKS = 30;
/** 続けてこの回数だけ読めなかったら「つながりません」を出す（30 秒ごとなので、およそ 1 分） */
const FAILS_TO_WARN = 2;
/** 右上の残りの札の class（終わったら警告の色） */
const clockClass = (state) => `wk-clock tabular${state === "ended" ? " ended" : ""}`;

/**
 * deps：{ rpc(name, args), el(tag, props, ...children), getCohortId(), getClient(), isClosed(), isBusy(), withBusy(fn),
 *         confirm({ title, lines, okText }), notify(message, kind, code), render(), reload(), byId(id), setInterval, clearInterval, now(),
 *         getStageMinutes(stageId) }
 * reload：講師ページの［最新にする］と同じ読み直し（段階・クローズ・札を並べて読み、描き直す）
 * getStageMinutes：その段階の回の WS の分（cohort_stage_minutes。未設定・読めないときは null）。始める分の既定に使う
 */
export function createStageTimer(deps) {
  const now = deps.now ?? (() => Date.now());
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? ((id) => clearInterval(id));
  let status = null; // normalizeTimerStatus の答え。null は「読めていない・使えない」（札を隠す）
  let seq = 0;
  let minutesText = "";
  // 講師が分の欄に一度でも打ったか（真の間は、空にした場合も含めて講師の値が先。既定の分で上書きしない）。
  // 始めた・回を替えた（reset）・札が見ている段階が変わったときに偽に戻す
  let touched = false;
  /** 札が最後に見た段階の id（段階が変わったら既定の分に戻すため） */
  let seenStageId = null;
  let tick = null;
  let lastState = "";
  let failures = 0; // 続けて読めなかった回数（一時的な失敗だけ数える）
  let moreOpen = false; // 「分を指定」を開いているか（描き直しても保つ。始めた・段階が変わった・reset で閉じる）

  const warn = (where, error) => {
    try {
      console.error(`制作時間の札（${where}）：${error?.message ?? error}`);
    } catch {
      // 何もしない
    }
  };

  function stopTick() {
    if (tick !== null) stopEvery(tick);
    tick = null;
  }

  /** 札を消して読み直しも止める（ログアウト・回の切り替え） */
  function reset() {
    seq++;
    status = null;
    minutesText = "";
    touched = false;
    seenStageId = null;
    lastState = "";
    failures = 0;
    moreOpen = false;
    stopTick();
    closeScreen();
  }

  /**
   * stage_timer_status を読む。返り値は読めたか。ほかの読み込みの成否に関わらない。
   * 一時的でない失敗（関数が無い・権限が無い・DB が断った）と形の違う答えは札を隠す。
   * 一時的な失敗（通信など）は前に読んだ答えを残し、続けて読めなかった回数を数える（読めたら 0 に戻す）
   */
  async function load() {
    const cohortId = deps.getCohortId();
    const client = deps.getClient();
    const mine = ++seq;
    const current = () => mine === seq && cohortId === deps.getCohortId() && client === deps.getClient();
    if (!cohortId) {
      status = null;
      failures = 0;
      return false;
    }
    try {
      const response = await deps.rpc("stage_timer_status", { p_cohort_id: cohortId });
      if (!current()) return false;
      if (response?.error) {
        warn("読み込み", response.error);
        if (isTransientTimerError(response.error)) {
          failures++;
        } else {
          status = null;
          failures = 0;
        }
        return false;
      }
      status = normalizeTimerStatus(response?.data, cohortId, now());
      failures = 0;
      if (status) {
        const stageId = status.stage?.id ?? null;
        if (stageId !== seenStageId) {
          // 段階が変わった：講師が打った値を捨て、新しい段階の既定の分に戻す
          touched = false;
          minutesText = "";
          moreOpen = false;
        }
        seenStageId = stageId;
      }
      return !!status;
    } catch (error) {
      if (current()) failures++;
      warn("読み込み", error);
      return false;
    }
  }

  /** 講師ページ全体を読み直す（無ければ札だけ読み直して描き直す） */
  async function refresh() {
    if (deps.reload) await deps.reload();
    else {
      await load();
      deps.render();
    }
  }

  /** 札の見た目。今の回の答えだけを使う（回を切り替えた直後に、前の回の答えで札を出さない） */
  const view = () => timerView(status && status.cohortId === deps.getCohortId() ? status : null, now(), { closed: deps.isClosed() });
  /** ボタンの組：止まっているとき（始める）と、動いている・終わったとき（延ばす・取り消す。名前だけ違う）の 2 つ */
  const buttonsOf = (state) => (state === "idle" ? "start" : state ? "timer" : "");
  /** 続けて読めていない（「つながりません」を出す） */
  const unreachable = () => failures >= FAILS_TO_WARN;

  /** 描き直しが要る違いだけ（サーバーの時刻・時計の差は毎回変わるので比べない。描き直すと受講者の欄の入力が消えるため） */
  const shape = (s) =>
    (s ? [s.canStart, s.stage?.id ?? "", s.timer?.id ?? "", s.timer?.revision ?? 0, s.timer?.endsAt ?? 0].join("|") : "none") +
    (unreachable() ? "|unreachable" : "");

  /**
   * 1 秒ごと：残りの文だけを書き換える。30 秒ごとに読み直す。札が画面から消えたら止まる。
   * 描き直すのは、札を出さなくなったときと、ボタンの組が変わるとき（読み直しで形が変わったときも）だけ。
   * 終わりの時刻を過ぎたときは文と色だけを替える（描き直すと、入力中のほかの欄のフォーカスが外れるため。取り消しの箱と同じ）
   */
  function ensureTick() {
    if (tick !== null) return;
    let n = 0;
    tick = every(async () => {
      try {
        const box = deps.byId("timer-box");
        if (!box || box.isConnected === false) {
          // 札が画面から消えた（クローズ・段階の移動・ログアウトなど）：大きな表示も閉じる
          stopTick();
          closeScreen();
          return;
        }
        n++;
        if (n % POLL_TICKS === 0 && !deps.isBusy()) {
          const before = shape(status);
          const stageBefore = status?.stage?.id ?? null;
          const ok = await load();
          if (ok && (status?.stage?.id ?? null) !== stageBefore) {
            // 管理コンソール・ほかの講師が段階を動かした：「今」の行・受講者・札をまとめて読み直してそろえる
            await refresh();
            return;
          }
          if (shape(status) !== before) {
            const nv = view();
            if (!nv.visible || nv.state === "idle") closeScreen(); // ほかの講師が消した：大きな表示を閉じる
            deps.render();
            return;
          }
        }
        const v = view();
        if (!v.visible || buttonsOf(v.state) !== buttonsOf(lastState)) {
          if (!v.visible || v.state === "idle") closeScreen(); // 消した・始まっていない：大きな表示を閉じる
          deps.render();
          return;
        }
        updateScreen(v);
        // aria-live の行は文が変わったときだけ書く（毎秒書くと読み上げが繰り返される）
        const line = deps.byId("timer-line");
        if (line) {
          if (line.textContent !== v.line) line.textContent = v.line;
          if (v.state !== lastState) line.className = `timer-line ${v.state}`;
        }
        if (v.state !== lastState) {
          // 走っている → 終わった：延長のボタンの名前だけ替える（［＋5 分］→［今から 5 分］）
          for (const m of v.extendable) {
            const b = deps.byId(`timer-extend-${m}`);
            if (b) b.textContent = extendLabel(m, v.state);
          }
        }
        // WS のカードの右上の残り（分：秒）も同じ 1 秒で書き換える
        const clock = deps.byId("wk-clock");
        if (clock) {
          const time = deps.byId("wk-clock-time");
          if (time && time.textContent !== v.clock) time.textContent = v.clock;
          if (v.state !== lastState) {
            clock.className = clockClass(v.state);
            const end = deps.byId("wk-clock-end");
            if (end) end.hidden = v.state !== "ended";
          }
        }
        lastState = v.state;
      } catch (error) {
        warn("書き換え", error);
      }
    }, TICK_MS);
  }

  async function send(name, args, done) {
    const cohortId = deps.getCohortId();
    if (!cohortId) return;
    // 延長の範囲の断り（workshop_input_invalid）は開始と同じ名前なので、押した操作を渡して文を分ける。
    // 開始・延長・取り消しはどれも更新の RPC（通信の失敗は「結果が不明」。g-close-net-op）
    const op = name === "stage_timer_extend" ? "extend" : name === "stage_timer_start" ? "start" : "cancel";
    await deps.withBusy(async () => {
      try {
        const { data, error } = await deps.rpc(name, { p_cohort_id: cohortId, ...args });
        if (error) {
          deps.notify(timerErrorText(error, op, "update"), "error", timerErrorCode(error));
        } else {
          deps.notify(typeof done === "function" ? done(data) : done);
          if (name === "stage_timer_start") {
            minutesText = "";
            touched = false;
            moreOpen = false;
          }
        }
      } catch (error) {
        deps.notify(timerErrorText(error, op, "update"), "error", timerErrorCode(error));
      }
      await load();
    });
  }

  const start = (minutes) => send("stage_timer_start", { p_minutes: minutes }, (data) => startDoneText(minutes, data?.replaced));
  // 終わったあとは「今から」延ばす（DB が greatest(ends_at, now()) ＋ 分にする）。知らせの終わりの時刻は応答の ends_at から作る
  const extend = (minutes) => send("stage_timer_extend", { p_minutes: minutes }, (data) => extendDoneText(minutes, data));

  // タイマーを消す（U-10 の T-08。段階の取り消しと同じ「取り消す」の語を使わない）
  async function cancel() {
    const ok = await deps.confirm({
      title: "タイマーを消しますか？",
      lines: ["タイマーがないときは、受講者の AI は予定の時間で残りを伝えます。"],
      okText: "消す",
    });
    if (!ok) return;
    await send("stage_timer_cancel", {}, "タイマーを消しました。");
  }

  // ---- 残りを大きく表示（U-09）。#timer-screen（instructor.html の dialog）。中身は timerView と札の答えを読むだけ ----

  /** 大きな表示の中身：{ stage: 段階の名前, clock: 分：秒, until: 「14:30 まで」, ended } */
  function screenView(v) {
    const t = status?.timer ?? null;
    return {
      stage: status?.stage ? stageName(status.stage) : "",
      clock: v.clock,
      until: t ? `${formatClock(t.endsAt)} まで` : "",
      ended: v.state === "ended",
    };
  }

  // Esc 1 回で閉じる：全画面のときの最初の Esc はブラウザが全画面を解くのに使う。全画面が解けたら大きな表示も閉じる
  let screenWatched = null;
  let screenWasFull = false;
  function onScreenClose() {
    try {
      const dialog = deps.byId?.("timer-screen");
      const doc = dialog?.ownerDocument;
      screenWasFull = false;
      // Esc の既定動作など、［閉じる］以外から dialog が閉じた場合も全画面を残さない。
      if (dialog?.contains?.(doc?.fullscreenElement)) doc.exitFullscreen?.()?.catch?.(() => {});
    } catch (error) {
      warn("大きな表示の全画面を解く", error);
    }
  }
  function onScreenFullscreen() {
    try {
      const dialog = deps.byId?.("timer-screen");
      if (!dialog?.open) return;
      if (dialog.ownerDocument?.fullscreenElement === deps.byId("timer-screen-body")) {
        screenWasFull = true;
        const note = deps.byId("timer-screen-note");
        const retry = deps.byId("timer-screen-retry");
        if (note) note.hidden = true;
        if (retry) retry.hidden = true;
        return;
      }
      if (screenWasFull && !dialog.ownerDocument?.fullscreenElement) {
        screenWasFull = false;
        dialog.close?.();
      }
    } catch (error) {
      warn("大きな表示の全画面", error);
    }
  }

  function enterScreenFullscreen(dialog, body, note, retry) {
    const failed = () => {
      if (!dialog.open || deps.byId("timer-screen-body") !== body) return;
      note.textContent = "全画面にできませんでした。\n［全画面にする］で再度お試しください。";
      note.hidden = false;
      retry.hidden = false;
    };
    try {
      if (!body.requestFullscreen) { failed(); return; }
      body.requestFullscreen({ navigationUI: "hide" })?.catch?.(failed);
    } catch {
      failed();
    }
  }

  /** 大きな表示を開く（全画面にしてみる。断られたら画面いっぱいのダイアログのまま）。動いている・終わったときだけ */
  function openScreen() {
    try {
      const dialog = deps.byId("timer-screen");
      const v = view();
      if (!dialog || !v.visible || v.state === "idle") return;
      const { el } = deps;
      const sv = screenView(v);
      const note = el("p", { id: "timer-screen-note", className: "timer-screen-note", role: "status", hidden: true });
      const retry = el("button", { type: "button", className: "btn", id: "timer-screen-retry", text: "全画面にする", onclick: () => enterScreenFullscreen(dialog, body, note, retry) });
      const body = el(
        "div",
        { className: `timer-screen-body${sv.ended ? " ended" : ""}`, id: "timer-screen-body" },
        el("p", { className: "timer-screen-stage", id: "timer-screen-stage", text: sv.stage }),
        el("p", { className: "timer-screen-time tabular", id: "timer-screen-time", text: sv.clock }),
        el("p", { className: "timer-screen-until tabular", id: "timer-screen-until", text: sv.ended ? "終了" : sv.until }),
        note,
        el("div", { className: "row-actions" }, retry, el("button", { type: "button", className: "btn", id: "timer-screen-close", text: "閉じる", onclick: () => closeScreen() })),
      );
      dialog.replaceChildren(
        body,
      );
      if (!dialog.open) {
        screenWasFull = false;
        dialog.showModal?.();
      }
      if (screenWatched !== dialog) {
        // fullscreenchange は全画面に入った・解けた要素に届く（document へも上る）。窓は 1 つなので見張りは 1 回だけ付ける
        dialog.addEventListener?.("fullscreenchange", onScreenFullscreen);
        dialog.addEventListener?.("close", onScreenClose);
        screenWatched = dialog;
      }
      enterScreenFullscreen(dialog, body, note, retry);
    } catch (error) {
      warn("大きな表示", error);
    }
  }

  /** 1 秒ごと：開いていれば文字と終わりの色だけ書き換える */
  function updateScreen(v) {
    const dialog = deps.byId("timer-screen");
    if (!dialog?.open) return;
    const sv = screenView(v);
    const body = deps.byId("timer-screen-body");
    if (body) body.className = `timer-screen-body${sv.ended ? " ended" : ""}`;
    const time = deps.byId("timer-screen-time");
    if (time && time.textContent !== sv.clock) time.textContent = sv.clock;
    const until = deps.byId("timer-screen-until");
    const untilText = sv.ended ? "終了" : sv.until;
    if (until && until.textContent !== untilText) until.textContent = untilText;
    const stage = deps.byId("timer-screen-stage");
    if (stage && stage.textContent !== sv.stage) stage.textContent = sv.stage;
  }

  /** 大きな表示を閉じる（全画面も解く）。開いていなければ何もしない */
  function closeScreen() {
    try {
      const dialog = deps.byId?.("timer-screen");
      if (!dialog?.open) return;
      dialog.close?.();
    } catch (error) {
      warn("大きな表示を閉じる", error);
    }
  }

  /** 札（ワークショップの札の中、［前へ戻す］［次へ進める］の下）。出さないときは null */
  function card() {
    try {
      const v = view();
      lastState = v.visible ? v.state : "";
      if (!v.visible || v.state === "idle") closeScreen(); // 消した・札を出さない：大きな表示を残さない
      if (!v.visible) {
        stopTick();
        return null;
      }
      const { el } = deps;
      const busy = deps.isBusy();
      const parts = [
        el("h3", { id: "timer-h", text: "制作時間" }),
        el("p", { id: "timer-line", className: `timer-line ${v.state}`, "aria-live": "polite", text: v.line }),
      ];
      if (unreachable()) {
        parts.push(
          el(
            "div",
            { className: "timer-row" },
            el("p", { id: "timer-warn", className: "error-text timer-warn", text: "通信エラー：タイマーを更新できません。\n表示は最後に読み込んだ時点のものです。" }),
            el("button", { type: "button", className: "btn", id: "timer-refresh", text: "最新にする", disabled: busy, onclick: () => refresh() }),
          ),
        );
      }
      if (v.state === "idle") {
        // 講師が打っていなければ、回の WS の分（5〜180 に切り詰め）を入れておく
        const preset = defaultTimerMinutes(deps.getStageMinutes?.(status.stage.id) ?? null);
        const shownText = touched ? minutesText : preset.value === null ? "" : String(preset.value);
        const note = touched ? "" : defaultMinutesNote(preset);
        const currentText = () => (touched ? minutesText : shownText);
        const input = el("input", {
          id: "timer-minutes",
          className: "input tabular",
          type: "text",
          inputmode: "numeric",
          "aria-label": "タイマー（分。5〜180）",
          placeholder: "分",
          value: shownText,
          disabled: busy,
        });
        input.addEventListener("input", () => {
          minutesText = input.value;
          touched = true;
          const go = deps.byId("timer-start");
          if (go) go.disabled = busy || parseTimerMinutes(minutesText) === null;
          const noteEl = deps.byId("timer-default-note");
          if (noteEl) noteEl.hidden = true;
        });
        const presetRow = el(
          "div",
          { className: "timer-row", role: "group", "aria-label": "タイマーを始める" },
          ...TIMER_PRESETS.map((m) =>
            el("button", { type: "button", className: "btn", text: `${m} 分`, disabled: busy, onclick: () => start(m) })
          ),
        );
        const quick = preset.value !== null;
        const inputRow = el(
          "div",
          { className: "timer-row" },
          input,
          el("button", {
            type: "button",
            className: quick ? "btn" : "btn primary",
            id: "timer-start",
            text: "始める",
            disabled: busy || parseTimerMinutes(currentText()) === null,
            onclick: () => {
              const m = parseTimerMinutes(currentText());
              if (m !== null) start(m);
            },
          }),
        );
        const noteEl = note ? el("p", { className: "hint", id: "timer-default-note", text: note }) : null;
        if (quick) {
          // 回の WS の分があるとき（U-07）：主ボタンは 1 つ。プリセットと分の欄は「分を指定」に畳む（打ったら開いたまま）
          const more = el(
            "details",
            { className: "plain-fold minor timer-more", id: "timer-more", open: moreOpen || touched },
            el("summary", { text: "分を指定" }),
            el("div", { className: "fold-in" }, presetRow, inputRow),
          );
          more.addEventListener("toggle", () => {
            if (more.isConnected !== false) moreOpen = !!more.open;
          });
          parts.push(
            el(
              "div",
              { className: "timer-row" },
              el("button", { type: "button", className: "btn primary big", id: "timer-quick", text: `▶ ${preset.value} 分で始める`, disabled: busy, onclick: () => start(preset.value) }),
            ),
            noteEl,
            more,
          );
        } else {
          parts.push(presetRow, inputRow, noteEl);
        }
      } else {
        parts.push(
          el(
            "div",
            { className: "timer-row" },
            ...v.extendable.map((m) =>
              el("button", { type: "button", className: "btn", id: `timer-extend-${m}`, text: extendLabel(m, v.state), disabled: busy, onclick: () => extend(m) })
            ),
            el("button", { type: "button", className: "btn", id: "timer-cancel", text: "タイマーを消す…", disabled: busy, onclick: () => cancel() }),
          ),
        );
      }
      const box = el("div", { className: "timer-box", id: "timer-box", role: "group", "aria-labelledby": "timer-h" }, ...parts);
      // 動いている間は 1 秒ごとに残りを書き換える。止まっている・終わったときも 30 秒ごとに読み直す（ほかの人が始めた・段階を移した）
      ensureTick();
      return box;
    } catch (error) {
      warn("描画", error);
      stopTick();
      return null;
    }
  }

  /**
   * 回の見出しの「今」の行の右の残り（分：秒）と［大きく表示］（組 13 の U-07・U-09）。動いている・終わったときだけ出す（始まっていない・札を出さないときは null）。
   * 残りの数字の読み上げは札の中の timer-line に任せる（aria-hidden。毎秒は読ませない）。書き換えは card() が始める 1 秒ごとの tick
   */
  function clock() {
    try {
      const v = view();
      if (!v.visible || v.state === "idle") return null;
      const { el } = deps;
      return el(
        "span",
        { id: "wk-clock-wrap", className: "wk-clock-wrap" },
        el(
          "span",
          { id: "wk-clock", className: clockClass(v.state), "aria-hidden": "true" },
          el("span", { id: "wk-clock-time", text: v.clock }),
          el("small", { id: "wk-clock-end", className: "wk-clock-end", text: "終了", hidden: v.state !== "ended" }),
        ),
        el("button", { type: "button", className: "btn compact", id: "timer-big", text: "大きく表示", onclick: () => openScreen() }),
      );
    } catch (error) {
      warn("右上の残り", error);
      return null;
    }
  }

  return {
    load,
    reset,
    card,
    clock,
    openScreen,
    closeScreen,
    /** 試験用：今の状態 */
    get status() {
      return status;
    },
  };
}
