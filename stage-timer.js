// 講師ページの制作時間のタイマー（KT）の札。設計 docs/design-workshop-guide.md 第 1.3.1 版 4.5・約束 .orchestration/wt/d2/kt-contract.md。
// instructor.js からは「作る・読む・札を描く・消す」の 4 か所だけで使う（講師ページの持ち物を増やさない。分割を外しても当て直せる）。
// 壊れても既存の操作を止めない：読み込み・描画・1 秒ごとの書き換えは全部 try/catch で囲み、失敗したら札を出さない（コンソールに 1 行）。
// 書き込み（始める・延ばす・取り消す）は、講師ページの withBusy を通す（二重に押させない・操作のページの回だけに送る）。
// 30 秒ごとの読み直しは、札が画面にある間だけ（ほかの人の延長・取り消し・管理コンソールからの段階の移動を拾う）。
// 一時的な失敗（通信など）で読めなくても札は消さず、前に読んだ表示を残す。続けて読めないときだけ「つながりません」と［最新にする］を出す。
// 読み直しで段階が変わったと分かったら、講師ページ全体を読み直す（reload。「今」の行と札を同じ段階にそろえる）。
import {
  extendDoneText,
  extendLabel,
  isTransientTimerError,
  normalizeTimerStatus,
  parseTimerMinutes,
  startDoneText,
  TIMER_PRESETS,
  timerErrorText,
  timerView,
} from "./stage-timer-lib.js";

const TICK_MS = 1000;
const POLL_TICKS = 30;
/** 続けてこの回数だけ読めなかったら「つながりません」を出す（30 秒ごとなので、およそ 1 分） */
const FAILS_TO_WARN = 2;

/**
 * deps：{ rpc(name, args), el(tag, props, ...children), getCohortId(), getClient(), isClosed(), isBusy(), withBusy(fn),
 *         confirm({ title, lines, okText }), notify(message, kind), render(), reload(), byId(id), setInterval, clearInterval, now() }
 * reload：講師ページの［最新にする］と同じ読み直し（段階・クローズ・札を並べて読み、描き直す）
 */
export function createStageTimer(deps) {
  const now = deps.now ?? (() => Date.now());
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? ((id) => clearInterval(id));
  let status = null; // normalizeTimerStatus の答え。null は「読めていない・使えない」（札を隠す）
  let seq = 0;
  let minutesText = "";
  let tick = null;
  let lastState = "";
  let failures = 0; // 続けて読めなかった回数（一時的な失敗だけ数える）

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
    lastState = "";
    failures = 0;
    stopTick();
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
          stopTick();
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
            deps.render();
            return;
          }
        }
        const v = view();
        if (!v.visible || buttonsOf(v.state) !== buttonsOf(lastState)) {
          deps.render();
          return;
        }
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
        lastState = v.state;
      } catch (error) {
        warn("書き換え", error);
      }
    }, TICK_MS);
  }

  async function send(name, args, done) {
    const cohortId = deps.getCohortId();
    if (!cohortId) return;
    await deps.withBusy(async () => {
      try {
        const { data, error } = await deps.rpc(name, { p_cohort_id: cohortId, ...args });
        if (error) {
          deps.notify(timerErrorText(error), "error");
        } else {
          deps.notify(typeof done === "function" ? done(data) : done);
          if (name === "stage_timer_start") minutesText = "";
        }
      } catch (error) {
        deps.notify(timerErrorText(error), "error");
      }
      await load();
    });
  }

  const start = (minutes) => send("stage_timer_start", { p_minutes: minutes }, (data) => startDoneText(minutes, data?.replaced));
  // 終わったあとは「今から」延ばす（DB が greatest(ends_at, now()) ＋ 分にする）。知らせの終わりの時刻は応答の ends_at から作る
  const extend = (minutes) => send("stage_timer_extend", { p_minutes: minutes }, (data) => extendDoneText(minutes, data));

  async function cancel() {
    const ok = await deps.confirm({
      title: "制作時間を取り消しますか？",
      lines: ["受講者の AI は、段階の時間の目安（無ければ残り時間を言わない）に戻ります。段階はそのままです。"],
      okText: "取り消す",
    });
    if (!ok) return;
    await send("stage_timer_cancel", {}, "制作時間を取り消しました。");
  }

  /** 札（ワークショップの札の中、［前へ戻す］［次へ進める］の下）。出さないときは null */
  function card() {
    try {
      const v = view();
      lastState = v.visible ? v.state : "";
      if (!v.visible) {
        stopTick();
        return null;
      }
      const { el } = deps;
      const busy = deps.isBusy();
      const parts = [
        el("h3", { id: "timer-h", text: "制作時間" }),
        el("p", { id: "timer-stage", className: "hint timer-stage", text: v.stageLine }),
        el("p", { id: "timer-line", className: `timer-line ${v.state}`, "aria-live": "polite", text: v.line }),
      ];
      if (unreachable()) {
        parts.push(
          el(
            "div",
            { className: "timer-row" },
            el("p", { id: "timer-warn", className: "error-text timer-warn", text: "制作時間の状態を読み込めません（つながりません）。表示は前に読んだときのものです。" }),
            el("button", { type: "button", className: "btn", id: "timer-refresh", text: "最新にする", disabled: busy, onclick: () => refresh() }),
          ),
        );
      }
      if (v.state === "idle") {
        const input = el("input", {
          id: "timer-minutes",
          className: "input tabular",
          type: "text",
          inputmode: "numeric",
          "aria-label": "制作時間（分。5〜180）",
          placeholder: "分",
          value: minutesText,
          disabled: busy,
        });
        input.addEventListener("input", () => {
          minutesText = input.value;
          const go = deps.byId("timer-start");
          if (go) go.disabled = busy || parseTimerMinutes(minutesText) === null;
        });
        parts.push(
          el(
            "div",
            { className: "timer-row", role: "group", "aria-label": "制作時間を始める" },
            ...TIMER_PRESETS.map((m) =>
              el("button", { type: "button", className: "btn", text: `${m} 分`, disabled: busy, onclick: () => start(m) })
            ),
          ),
          el(
            "div",
            { className: "timer-row" },
            input,
            el("button", {
              type: "button",
              className: "btn primary",
              id: "timer-start",
              text: "始める",
              disabled: busy || parseTimerMinutes(minutesText) === null,
              onclick: () => {
                const m = parseTimerMinutes(minutesText);
                if (m !== null) start(m);
              },
            }),
          ),
        );
      } else {
        parts.push(
          el(
            "div",
            { className: "timer-row" },
            ...v.extendable.map((m) =>
              el("button", { type: "button", className: "btn", id: `timer-extend-${m}`, text: extendLabel(m, v.state), disabled: busy, onclick: () => extend(m) })
            ),
            el("button", { type: "button", className: "btn", id: "timer-cancel", text: "取り消す…", disabled: busy, onclick: () => cancel() }),
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

  return {
    load,
    reset,
    card,
    /** 試験用：今の状態 */
    get status() {
      return status;
    },
  };
}
