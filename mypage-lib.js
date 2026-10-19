// マイページの、画面に依存しない処理（user-api の応答の読み取り・表示用の整形）。mypage.js から使う。
// テストは aiken-media-relay/scripts/mypage_lib_test.ts。
// 画面にドルや換算の割合は出さない（user-api の応答にも含まれない）。クレジットの数字と文言は user-api の応答をそのまま使う。

import { idleExpired } from "./auth-storage.js";

/** 有限の数か（null・""・NaN・文字列は false） */
function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** 3,000 のような桁区切り（値が無いときは「—」） */
export function formatCredits(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/**
 * ヘッダーに出すほかの画面へのボタン（/me の区分 role だけで決める）。講師は講師の画面、管理者は講師の画面と管理コンソールの両方
 * （管理者は講師の画面も使えるため）。ボタンを出すかどうかだけに使い、守りには使わない（各画面が自分で権限を確かめる）
 */
export function headerTools(role) {
  return { instructor: role === "instructor" || role === "admin", admin: role === "admin" };
}

/** 「使えるモデル」を並べる種類の順（list_models の順とは別に、動画を先頭にする） */
export const KIND_ORDER = ["video", "image", "speech", "music", "lipsync"];

/** 区分（role）ごとのバッジの class（admin.html と同じ配色） */
export function roleBadgeClass(role) {
  return role === "student" || role === "member" || role === "instructor" || role === "admin" ? role : "";
}

/** 枠の対象外（管理者以外）で、案内の文も無いときの 1 行 */
export const MSG_NO_WINDOW = "クレジットの枠はありません";

/** 残りがこの割合以下なら、色を変えて知らせる */
export const LOW_RATIO = 0.2;

/**
 * 「残りクレジット」の見せ方。credits は user-api の応答の credits（画面に出す値だけ）、role は応答の role。
 * mode：number（数字を大きく出す）／unlimited（管理者。「上限なし」）／notice（枠の外・未設定。数字は出さず 1 行の案内）／none
 * value：大きく出す文字／limitText：数字の横に小さく出す「/ 上限 3,000」／slotLine：枠の説明 1 行（「ブリッジワーク期間・10/22 まで」）／
 * notice：案内の 1 行（user-api が get_credits と同じ文言から作ったもの。ここでは文言を解析しない）／
 * ratio：残り÷上限（0〜1。出せないときは null）／low：残りが少ないか
 */
export function creditsView(credits, role) {
  const c = credits && typeof credits === "object" ? credits : {};
  const base = { value: "—", limitText: null, slotLine: null, notice: null, ratio: null, low: false, stageName: null, stages: [], stageNote: null };
  if (c.applies !== true) {
    if (role === "admin") return { ...base, mode: "unlimited", value: "上限なし" };
    // 管理者以外で枠の対象外：見出しだけの空にならないよう、1 行の案内を出す
    return { ...base, mode: "notice", notice: typeof c.notice === "string" && c.notice ? c.notice : MSG_NO_WINDOW };
  }
  if (typeof c.remaining !== "number") {
    return { ...base, mode: "notice", notice: typeof c.notice === "string" ? c.notice : null };
  }
  const limit = typeof c.limit === "number" ? c.limit : null;
  const ratio = limit !== null && limit > 0 ? Math.min(1, Math.max(0, c.remaining / limit)) : null;
  const slot = typeof c.slot === "string" && c.slot ? c.slot : null;
  const until = typeof c.until === "string" && c.until ? c.until : null;
  const stage = stageView(c);
  return {
    ...stage,
    mode: "number",
    value: formatCredits(c.remaining),
    limitText: limit === null ? null : `/ 上限 ${formatCredits(limit)}`,
    slotLine: slot ? (until ? `${slot}・${until} まで` : slot) : null,
    notice: null,
    ratio,
    low: ratio !== null && ratio <= LOW_RATIO,
  };
}

/** 残りが少ない・無いときの 1 行（色だけで伝えないための文。どちらでもないときは null） */
export const MSG_LOW = "残りが少なくなっています";
export const MSG_EMPTY = "残りがありません";

/**
 * 残りの主カードに添える注意の 1 行。view は creditsView の結果、credits は user-api の credits。
 * 数字を出す分岐（mode が number）だけで判断する：残りが 0 なら「残りがありません」、少ない（view.low）なら「残りが少なくなっています」。
 * 案内・上限なしの分岐では出さない（数が無いのに「少ない」と言わない）
 */
export function lowNotice(view, credits) {
  if (!view || view.mode !== "number") return null;
  if (credits && typeof credits === "object" && credits.remaining === 0) return MSG_EMPTY;
  return view.low ? MSG_LOW : null;
}

/** 主カードに添える段階の決まりの要約（今日の段階の一覧があるときだけ。全文は折りたたみの中の MSG_STAGE_NO_CARRY） */
export const MSG_STAGE_SUMMARY = "段階ごとの枠・持ち越しなし";

/**
 * 最後に読み込みに成功した時刻の表示（日本時間の「確認 13:42」）。ms はミリ秒の時刻。
 * 値が無い・不正なら null（表示しない。失敗や読み込み中を成功の時刻として出さないため、呼び出し側は成功したときだけ時刻を渡す）
 */
export function checkedAtText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `確認 ${parts.hour}:${parts.minute}`;
}

/** Canvas から戻ったとき（タブがまた見えたとき）に読み直すまでの最短の間（ミリ秒）。前回の成功からこれ未満なら読み直さない */
export const RETURN_RELOAD_MIN_MS = 30 * 1000;

/**
 * タブがまた見えたときに、1 回だけ読み直すか。次をすべて満たすときだけ true：
 * - タブが見えている（visible）・ログインが有効（signedIn）・本人の画面を出している（showingApp）・読み込み中でない（loading が false）
 * - 前回の成功の時刻（lastSuccessAt）があり、そこから minMs 以上たっている（時計が戻って差が負のときは読み直さない）
 * 一定間隔の自動の読み直しはしない（この判断は、見えたときの 1 回だけに使う）
 */
export function shouldReloadOnReturn({ visible, signedIn, showingApp, loading, lastSuccessAt, now, minMs = RETURN_RELOAD_MIN_MS }) {
  if (visible !== true || signedIn !== true || showingApp !== true || loading === true) return false;
  if (typeof lastSuccessAt !== "number" || !Number.isFinite(lastSuccessAt)) return false;
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
  const elapsed = now - lastSuccessAt;
  return elapsed >= minMs;
}

/**
 * 応答で画面を上書きしてよいか（要求の番号の照合）。ticket は要求を出したときの { seq, account }。
 * latestSeq は今の最新の番号（ログアウトなどで無効にすると増える）、account は応答が届いた時点のログイン中のアカウント（無ければ null）。
 * 古い要求の応答・ログアウトのあとの応答・別のアカウントに替わったあとの応答は false
 */
export function isCurrentResponse({ ticket, latestSeq, account }) {
  if (!ticket || typeof ticket !== "object") return false;
  if (typeof ticket.seq !== "number" || ticket.seq !== latestSeq) return false;
  if (typeof account !== "string" || !account) return false;
  return ticket.account === account;
}

/**
 * 要求の番号を振る小さな係。
 * - begin(account)：新しい番号の ticket を返す（それより前の ticket は古くなる）。読み込みを始めたら、最初の await より前に呼ぶ
 *   （アカウントがまだ分からないときは null で取り、認証の確認のあとで withAccount で結び付ける）
 * - withAccount(ticket, account)：ticket がまだ有効なら、アカウントを結び付けた ticket を返す。無効なら null
 * - isLive(ticket)：ticket がまだ有効か（新しい要求・invalidate・close で無効になる）
 * - isCurrent(ticket, account)：有効で、かつ同じアカウントか（isCurrentResponse の照合）
 * - invalidate()：出ている要求をすべて古くする
 * - close()：出ている要求をすべて古くし、以後の begin も無効な ticket しか返さない（ログアウトを始めたあとに、
 *   新しい番号を取り直して本人の内容を出し直せないようにする。ログインし直すときはページを読み直すので、開き直す必要は無い）
 */
export function createRequestCounter() {
  let seq = 0;
  let closed = false;
  const live = (ticket) => !closed && !!ticket && typeof ticket === "object" && ticket.seq === seq;
  return {
    begin(account) {
      if (closed) return { seq: -1, account: null };
      seq += 1;
      return { seq, account: typeof account === "string" && account ? account : null };
    },
    withAccount(ticket, account) {
      if (!live(ticket)) return null;
      return { seq: ticket.seq, account: typeof account === "string" && account ? account : null };
    },
    isLive(ticket) {
      return live(ticket);
    },
    invalidate() {
      seq += 1;
    },
    close() {
      closed = true;
      seq += 1;
    },
    get closed() {
      return closed;
    },
    isCurrent(ticket, account) {
      return !closed && isCurrentResponse({ ticket, latestSeq: seq, account });
    },
  };
}

/** 段階の回で、段階の使い切らなかった分は次に持ち越せないことの 1 行（段階の回だけに出す） */
export const MSG_STAGE_NO_CARRY = "ワークショップごとに上限があり、使い切らなかった分は次に持ち越せません。";

/**
 * 段階の回（016）の表示。user-api の credits に `stage`（今の段階の名前の文字列）と
 * `stages_today`（[{ name, limit, used, current }]）があるときだけ。Day ごとの回・メンバー・講師にはどちらも無く、空になる。
 * 返り値：{ stageName, stages: [{ name, limitText, usedText, current }], stageNote }
 */
export function stageView(credits) {
  const c = credits && typeof credits === "object" ? credits : {};
  const stageName = typeof c.stage === "string" && c.stage ? c.stage : null;
  if (!stageName) return { stageName: null, stages: [], stageNote: null };
  const list = Array.isArray(c.stages_today) ? c.stages_today : [];
  const stages = list
    .filter((s) => s && typeof s.name === "string" && s.name)
    .map((s) => ({
      name: s.name,
      limitText: isNumber(s.limit) ? `上限 ${formatCredits(s.limit)}` : "—",
      usedText: isNumber(s.used) ? `使用 ${formatCredits(s.used)}` : "—",
      current: s.current === true,
    }));
  return { stageName, stages, stageNote: MSG_STAGE_NO_CARRY };
}

/** 「使えるモデル」の小見出し（user-api の kind_label ではなく、この画面の呼び方） */
export const KIND_HEADINGS = { video: "動画", image: "画像", speech: "読み上げ", music: "音楽", lipsync: "口パク動画" };

/**
 * モデルを種類ごとにまとめる（KIND_ORDER の順。知らない種類は最後に、出てきた順）。
 * 種類の中は、既定を先頭に、あとは目安の安い順（同じ額は元の順）
 */
export function groupModels(models) {
  const list = Array.isArray(models) ? models : [];
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.kind)) {
      groups.set(m.kind, { kind: m.kind, label: KIND_HEADINGS[m.kind] ?? (m.kind_label || m.kind), models: [] });
    }
    groups.get(m.kind).models.push(m);
  }
  // 数字として表示できない目安（null・文字列・NaN など）は、表示が「—」になる。並べ替えでも末尾
  const credits = (m) => (isNumber(m.price?.credits) ? m.price.credits : Infinity);
  for (const g of groups.values()) {
    g.models = g.models
      .map((m, i) => ({ m, i }))
      .sort((a, b) => (b.m.is_default === true) - (a.m.is_default === true) || credits(a.m) - credits(b.m) || a.i - b.i)
      .map((x) => x.m);
  }
  const rank = (k) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/**
 * 目安の数字：小数は切り上げた整数（見積りは高い側に倒す。120.95 は 121、12.6 は 13）。
 * 浮動小数の誤差（63.00000000000001 など）は切り上げないよう、小数 6 桁で丸めてから切り上げる
 */
export function formatApprox(n) {
  return Number.isFinite(n) ? Math.ceil(Math.round(n * 1e6) / 1e6).toLocaleString("en-US") : "—";
}

/**
 * 目安の表示（単位つき。「クレジット」は画面の見出しに 1 回だけ書く）。既定の解像度の単価から：
 * 動画「5 秒 約 63」・画像「1 枚 8」・読み上げ「1,000 文字 10」・音楽「1 分 80」「1 曲 15」
 */
export function priceText(model) {
  // 数字のときだけ出す（null・"" を 0 として「約 0」と出さない）
  const credits = model?.price?.credits;
  if (!isNumber(credits)) return "—";
  switch (model.price.unit) {
    case "second":
      return `5 秒 約 ${formatApprox(credits * 5)}`;
    case "image":
      return `1 枚 ${formatApprox(credits)}`;
    case "1000_chars":
      return `1,000 文字 ${formatApprox(credits)}`;
    case "minute":
      return `1 分 ${formatApprox(credits)}`;
    case "song":
      return `1 曲 ${formatApprox(credits)}`;
    default:
      return formatApprox(credits);
  }
}

export const MSG_CODE_FAILED = "ログインを完了できませんでした。もう一度ログインしてください。";
export const MSG_DENIED = "利用登録が確認できません。管理者にお問い合わせください。";

/**
 * 「登録されていない」画面の文。ログインしたメールアドレスが分かれば「このアカウント（…）は登録されていません。」の形にする
 * （違うアカウントで入ったと気づけるように。メールを出すのはこの画面だけ）。分からなければ MSG_DENIED
 */
export function deniedMessage(email) {
  if (typeof email !== "string" || !email.trim()) return MSG_DENIED;
  return `このアカウント（${email.trim()}）は登録されていません。管理者にお問い合わせください。`;
}
export const MSG_EXPIRED = "ログインの有効期限が切れました。もう一度ログインしてください。";
export const MSG_FAILED = "読み込めませんでした。通信の状態を確認して、もう一度試してください。";

/**
 * user-api の応答（HTTP の状態と JSON）から、画面の進め方を決める
 * - ok：表示する（body は検査済み）／unauthorized：ログインし直し／denied：名簿に無い・無効／failed：通信の失敗など
 * status が 0 は通信できなかったとき
 */
export function decideApiOutcome(status, body) {
  if (status === 200) {
    const ok = body && typeof body === "object" && typeof body.email === "string" && typeof body.role === "string" &&
      body.credits && typeof body.credits === "object" && Array.isArray(body.models);
    return ok
      ? { action: "ok", body }
      : { action: "failed", message: "応答の形が正しくありません。もう一度試してください。" };
  }
  if (status === 401) return { action: "unauthorized", message: MSG_EXPIRED };
  // 名簿に無い・停止中・本人確認の不備（user-api の 403 not_registered）。許可していない接続元などの 403 は通信の失敗として扱う
  if (status === 403 && body?.error === "not_registered") return { action: "denied", message: MSG_DENIED };
  if (status === 503) {
    return { action: "failed", message: "ただいま混み合っています。少し待ってから、もう一度試してください。" };
  }
  return { action: "failed", message: MSG_FAILED };
}

/**
 * supabase-js が PKCE のために保存する code verifier の鍵の末尾。2.117.2 は次の 3 種を書き、どれもこの末尾で終わる：
 *   `<storageKey>-code-verifier`（旧来の鍵。sb_flow_id が無いときの交換はこれを読む）
 *   `<storageKey>-flow-<flowId>-code-verifier`（flow ごとの鍵）・`<storageKey>-flows-code-verifier`（flowId の一覧）
 * supabase-js を上げるときは、鍵の名前が変わっていないかを確かめる（変わると Google から戻ってもログインできない）
 */
export const CODE_VERIFIER_SUFFIX = "-code-verifier";

/**
 * ページを開いた時点で、保存先から消す鍵（keys のうち prefix で始まるもの）。
 * Google のログインから「?code 付きで戻ったとき」だけが、このページを開いた時点で正当に残っているものがある場合：
 *   その場合は、PKCE の code verifier と、signIn で書いた操作時刻（activityKey）だけを残し、保存済みのセッションは消す。
 * code が無いとき（普段に開いたとき・強制終了やクラッシュのあとのセッション復元・再読み込み）は、すべて消す。
 * 前の人のログインが、pagehide が走らなかったときに戻るのを防ぐ
 */
export function staleSessionKeys(keys, prefix, activityKey, hasCode) {
  return keys.filter((k) => {
    if (!k.startsWith(prefix)) return false;
    if (hasCode && (k === activityKey || k.endsWith(CODE_VERIFIER_SUFFIX))) return false;
    return true;
  });
}

/**
 * 離れる前に「ログイン中だった」か（再読み込みの手がかりの hadSession）。トークンがあり、かつ 30 分の無操作で時間切れになっていないときだけ true。
 * 時間切れのあと（スリープ復帰直後・背面タブでタイマーが遅れているとき）に再読み込みしても、自動でログインし直さないため。
 * lastActive は最後の操作の時刻（sessionStorage の文字列。無い・不正は時間切れ扱い）
 */
export function hadActiveSession({ token, lastActive, now, limitMs = 30 * 60 * 1000 }) {
  return !!token && !idleExpired(lastActive, now, limitMs);
}

/** sessionStorage の再読み込みの手がかり（JSON の文字列）を読む。{ leftAt, hadSession }。無い・不正なら null */
export function parseReloadHint(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    return { leftAt: v.leftAt, hadSession: v.hadSession === true };
  } catch {
    return null;
  }
}

/**
 * ページを開いた時点で、このあとどうするか。
 *  - "code"：Google から ?code 付きで戻った（今までどおり、ログインを完了させる）
 *  - "relogin"：再読み込み（navType が "reload"）で、手がかり（hint）があり、離れる前にログインしていて（hadSession）、
 *    離れてから graceMs 以内。Google のログインを自動でやり直す
 *  - "login"：それ以外（普段に開いた・タブを閉じて開き直した・強制終了や復元・手がかりが無い／ログインしていなかった／
 *    時刻が不正・未来・古い・navType が取れない・戻る進む）。ログイン前の画面
 * hint は parseReloadHint の結果（または null）。時刻の単位はミリ秒
 */
export function decideOnOpen({ hasCode, navType, hint, now, graceMs = 15000 }) {
  if (hasCode) return "code";
  if (navType !== "reload") return "login";
  if (!hint || hint.hadSession !== true) return "login";
  const t = hint.leftAt;
  if (typeof t !== "number" || !Number.isFinite(t)) return "login";
  const elapsed = now - t;
  // 未来の時刻（時計のずれ・書き換え）は使わない
  return elapsed >= 0 && elapsed <= graceMs ? "relogin" : "login";
}

/** storage から staleSessionKeys の鍵を消す。消した数を返す（storage が無いときは 0） */
export function clearStaleSession(storage, prefix, activityKey, hasCode) {
  if (!storage) return 0;
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }
  const stale = staleSessionKeys(keys, prefix, activityKey, hasCode);
  for (const k of stale) storage.removeItem(k);
  return stale.length;
}
