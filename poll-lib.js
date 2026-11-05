// 約 10 秒の読み直しの部品（組 11 の (3)。設計 kumi11-site.md 2.3.1）。マイページ・講師ページ・提出作品のページが共通に使う。
// 画面は「画面を出したら start()、ログアウト（hideContent）で stop()」だけを守ればよい。部品は stop() のほかでは止まらない：
// 予約の時刻にタブが見えていない・その画面で今は読めない（canRun が偽）ときは、読まずに intervalMs 後に予約し直す
// （隠れていたタブは、見えてから最大 intervalMs で読み直しに戻る。kick() は早く読むための任意の手）。
// 失敗が続くと 20 → 40 → 60 秒に延ばし、成功で 10 秒に戻す。実行中に 2 本目は始めない。setInterval は使わない（予約は setTimeout の 1 つだけ）。
// 時計（setTimeout・clearTimeout）は引数で受け取る（試験は偽の時計で動かす。試験は scripts/poll_lib_nodetest.mjs）。

/** 読み直しの間隔（ミリ秒） */
export const POLL_INTERVAL_MS = 10_000;
/** 続けて失敗した回数 1・2・3 回目以降の、次の読み直しまでの間隔（ミリ秒） */
export const POLL_BACKOFF_MS = [20_000, 40_000, 60_000];
/** 続けて何回失敗したら「更新できていません」を出すか */
export const POLL_STALE_AFTER = 3;

/** 次の予約までの間隔：失敗が続いていなければ intervalMs、続いていれば backoffMs の回数目（最後の値で頭打ち） */
export function pollDelay(failures, intervalMs = POLL_INTERVAL_MS, backoffMs = POLL_BACKOFF_MS) {
  if (!(failures > 0) || !backoffMs.length) return intervalMs;
  return backoffMs[Math.min(failures, backoffMs.length) - 1];
}

/**
 * 今回の失敗で「更新できていません」を出すか（failuresBefore は、今回の失敗を数える前の poller.failures()）。
 * 1・2 回目は出さず、続けて 3 回目から出す
 */
export function staleAfterThisFailure(failuresBefore) {
  return (Number(failuresBefore) || 0) + 1 >= POLL_STALE_AFTER;
}

/**
 * @param {object} o
 * @param {() => Promise<"ok" | "fail" | "skip">} o.run 1 回の読み直し。投げたら "fail" として数える
 * @param {() => boolean} [o.canRun] その画面で今読んでよいか（通信中・ダイアログが開いている・ログアウトの途中は偽）
 * @param {() => boolean} [o.isVisible] タブが見えているか（document.visibilityState === "visible"）
 * @param {number} [o.intervalMs]
 * @param {number[]} [o.backoffMs]
 * @param {(fn: () => void, ms: number) => unknown} o.setTimeout
 * @param {(id: unknown) => void} o.clearTimeout
 * @returns {{ start(): void, stop(): void, kick(): Promise<void> | undefined, failures(): number, running(): boolean }}
 */
export function createPoller(o) {
  const intervalMs = o.intervalMs ?? POLL_INTERVAL_MS;
  const backoffMs = o.backoffMs ?? POLL_BACKOFF_MS;
  const canRun = o.canRun ?? (() => true);
  const isVisible = o.isVisible ?? (() => true);
  const setT = o.setTimeout;
  const clearT = o.clearTimeout;
  /** 動いているか（start から stop まで） */
  let active = false;
  /** 世代。stop() で進め、止める前に始まった読み直しの結果では次を予約しない */
  let gen = 0;
  /** 今の予約（1 つだけ） */
  let timer = null;
  /** 読み直しの最中か（2 本目を始めない） */
  let inFlight = false;
  /** 続けて失敗した数 */
  let failures = 0;

  const truthy = (fn) => {
    try {
      return !!fn();
    } catch {
      return false;
    }
  };

  function unschedule() {
    if (timer === null) return;
    clearT(timer);
    timer = null;
  }

  function schedule(ms) {
    unschedule();
    const my = gen;
    timer = setT(() => {
      timer = null;
      if (my === gen) void tick(my);
    }, ms);
  }

  async function tick(my) {
    if (!active || my !== gen) return;
    // 見えていない・今は読めない・前の読み直しがまだ終わっていない：読まずに、いつもの間隔で予約し直す（止まらない）
    if (inFlight || !truthy(isVisible) || !truthy(canRun)) {
      schedule(intervalMs);
      return;
    }
    inFlight = true;
    let result;
    try {
      result = await o.run();
    } catch {
      result = "fail";
    } finally {
      inFlight = false;
    }
    if (!active || my !== gen) return; // 待つ間に止めた（ログアウト）：次を予約しない
    if (result === "fail") failures += 1;
    else if (result === "ok") failures = 0;
    schedule(result === "fail" ? pollDelay(failures, intervalMs, backoffMs) : intervalMs);
  }

  return {
    /** 読み直しを始める（動いていれば何もしない。何度呼んでもよい。stop() のあとでも再開できる） */
    start() {
      if (active) return;
      active = true;
      failures = 0;
      gen += 1;
      schedule(intervalMs);
    },
    /** 止める（予約を消し、出ている読み直しの結果では次を予約しない） */
    stop() {
      active = false;
      gen += 1;
      unschedule();
    },
    /** すぐ 1 回読む（条件を満たせば）。動いていない・読み直しの最中なら何もしない */
    kick() {
      if (!active || inFlight) return undefined;
      unschedule();
      return tick(gen);
    },
    failures: () => failures,
    running: () => active,
  };
}
