// マイページの、画面に依存しない処理（user-api の応答の読み取り・表示用の整形）。mypage.js から使う。
// テストは aiken-media-relay/scripts/mypage_lib_test.ts。
// 画面にドルや換算の割合は出さない（user-api の応答にも含まれない）。クレジットの数字と文言は user-api の応答をそのまま使う。

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

/** つなぎ方の［コピー］：コピーできたときの知らせ */
export const MSG_COPY_OK = "コピーしました";
/** つなぎ方の［コピー］：クリップボードが使えないとき（枠の文字を選んだ状態にして出す） */
export const MSG_COPY_FALLBACK = "コピーできませんでした。枠の文字を選んだので、選んだ文字をコピーしてください。";
/** コピーの知らせを消すまでの時間（ミリ秒。失敗の知らせは消さない） */
export const COPY_OK_CLEAR_MS = 4000;

/**
 * 「最後に始めたものだけを有効にする」番号の係（つなぎ方の［コピー］で、枠ごとに使う）。
 * begin(key) で key の新しい番号を返し、isLatest(key, n) は n がその key の最新の番号か。
 * 連打して完了の順が入れ替わっても、古い結果（失敗など）で新しい結果の知らせを上書きしない
 */
export function createLatestGate() {
  const latest = new Map();
  return {
    begin(key) {
      const n = (latest.get(key) ?? 0) + 1;
      latest.set(key, n);
      return n;
    },
    isLatest(key, n) {
      return latest.get(key) === n;
    },
  };
}

/**
 * コピーする文字：枠（code）の textContent をそのまま使う。見た目の折り返しは CSS だけなので、ここには改行が入らない。
 * HTML の書き方でまぎれる前後の改行だけを外す（行の中・行の間の空白や改行は変えない。2 行の設定の例は 2 行のまま）
 */
export function copyTextOf(text) {
  return typeof text === "string" ? text.replace(/^\r?\n/, "").replace(/\r?\n$/, "") : "";
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
  const base = { value: "—", limitText: null, slotLine: null, notice: null, ratio: null, low: false, stageName: null, stages: [] };
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
export const MSG_EMPTY = "残りがありません。追加が必要なときは、講師・スタッフに知らせてください。";

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

/**
 * 最後に読み込みに成功した時刻の表示（日本時間の「13:42 時点」）。ms はミリ秒の時刻。
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
  return `${parts.hour}:${parts.minute} 時点`;
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

/**
 * 段階の回（016）の表示。user-api の credits に `stage`（今の段階の名前の文字列）と
 * `stages_today`（[{ name, limit, used, current }]）があるときだけ。Day ごとの回・メンバー・講師にはどちらも無く、空になる。
 * 返り値：{ stageName, stages: [{ name, limitText, usedText, current }] }
 */
export function stageView(credits) {
  const c = credits && typeof credits === "object" ? credits : {};
  const stageName = typeof c.stage === "string" && c.stage ? c.stage : null;
  if (!stageName) return { stageName: null, stages: [] };
  const list = Array.isArray(c.stages_today) ? c.stages_today : [];
  const stages = list
    .filter((s) => s && typeof s.name === "string" && s.name)
    .map((s) => ({
      name: s.name,
      limitText: isNumber(s.limit) ? `上限 ${formatCredits(s.limit)}` : "—",
      usedText: isNumber(s.used) ? `使用 ${formatCredits(s.used)}` : "—",
      current: s.current === true,
    }));
  return { stageName, stages };
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
 * 動画「5 秒で約 63」・画像「1 枚で 8」・読み上げ「1,000 文字で 10」・音楽「1 分で 80」「1 曲で 15」
 */
export function priceText(model) {
  // 数字のときだけ出す（null・"" を 0 として「約 0」と出さない）
  const credits = model?.price?.credits;
  if (!isNumber(credits)) return "—";
  switch (model.price.unit) {
    case "second":
      return `5 秒で約 ${formatApprox(credits * 5)}`;
    case "image":
      return `1 枚で ${formatApprox(credits)}`;
    case "1000_chars":
      return `1,000 文字で ${formatApprox(credits)}`;
    case "minute":
      return `1 分で ${formatApprox(credits)}`;
    case "song":
      return `1 曲で ${formatApprox(credits)}`;
    default:
      return formatApprox(credits);
  }
}

export const MSG_CODE_FAILED = "ログインを完了できませんでした。もう一度ログインしてください。";
/** 「登録されていない」画面の 3 つの文（C-1）。1 文ずつ改行して出す（画面の側は white-space: pre-line）。2 文目は講師の画面の拒否の画面（instructor.html）と同じ */
const MSG_DENIED_FIRST = "利用の登録を確認できませんでした。";
const MSG_DENIED_NEXT = "［ログアウト］を押し、次の画面の「別のアカウントでログイン」で、研修で案内されたアカウントを選んでください。";
const MSG_DENIED_HELP = "入れないときは、講師・スタッフに知らせてください。";
export const MSG_DENIED = [MSG_DENIED_FIRST, MSG_DENIED_NEXT, MSG_DENIED_HELP].join("\n");

/**
 * 「登録されていない」画面の文。ログインしたメールアドレスが分かれば 1 文目を「このアカウント（…）は登録されていません。」の形にする
 * （違うアカウントで入ったと気づけるように。メールを出すのはこの画面だけ）。分からなければ MSG_DENIED
 */
export function deniedMessage(email) {
  if (typeof email !== "string" || !email.trim()) return MSG_DENIED;
  return [`このアカウント（${email.trim()}）は登録されていません。`, MSG_DENIED_NEXT, MSG_DENIED_HELP].join("\n");
}
export const MSG_EXPIRED = "ログインの有効期限が切れました。もう一度ログインしてください。";
export const MSG_FAILED = "読み込めませんでした。インターネットの接続を確かめて、もう一度試してください。";

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
      : { action: "failed", message: "情報を読み込めませんでした。続くときは、講師・スタッフに知らせてください。" };
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
 * Google のログインへ移るときの supabase-js の options（決定 70）。ふつうのログインはアカウントを選ぶ画面を出さない
 * （Google にログインしたままのブラウザなら、そのまま戻ってくる）。「別のアカウントでログイン」（selectAccount）のときだけ
 * prompt=select_account を付けて、選ぶ画面を出す
 */
export function oauthOptions(redirectTo, selectAccount) {
  return selectAccount === true ? { redirectTo, queryParams: { prompt: "select_account" } } : { redirectTo };
}
