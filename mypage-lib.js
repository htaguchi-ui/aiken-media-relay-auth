// マイページの、画面に依存しない処理（user-api の応答の読み取り・表示用の整形）。mypage.js から使う。
// テストは aiken-media-relay/scripts/mypage_lib_test.ts。
// 画面にドルや換算の割合は出さない（user-api の応答にも含まれない）。クレジットの数字と文言は user-api の応答をそのまま使う。

/** 3,000 のような桁区切り（値が無いときは「—」） */
export function formatCredits(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/** 「使えるモデル」を並べる種類の順（list_models の順とは別に、動画を先頭にする） */
export const KIND_ORDER = ["video", "image", "speech", "music"];

/** 区分（role）ごとのバッジの class（admin.html と同じ配色） */
export function roleBadgeClass(role) {
  return role === "student" || role === "member" || role === "admin" ? role : "";
}

/** 残りがこの割合以下なら、色を変えて知らせる */
export const LOW_RATIO = 0.2;

/**
 * 「残りクレジット」の見せ方。credits は user-api の応答の credits（画面に出す値だけ）、role は応答の role。
 * slot：今の枠の名前（「ブリッジワーク期間の残り」「今月の残り」。無ければ null）／value：大きく出す文字／
 * unit：単位（数字のときだけ）／ratio：残り÷上限（0〜1。出せないときは null）／low：残りが少ないか／
 * lines：今の枠の説明の行（user-api が get_credits と同じ文言から作ったもの。ここでは文言を解析しない）
 */
export function creditsView(credits, role) {
  const c = credits && typeof credits === "object" ? credits : {};
  const lines = Array.isArray(c.summary) ? c.summary.map(String) : [];
  if (c.applies !== true) {
    // 管理者は期間ごとの上限なし。それ以外（枠の対象外）は数字を出さない
    return {
      slot: null,
      value: role === "admin" ? "期間ごとの上限なし" : "—",
      valueIsText: true,
      unit: null,
      ratio: null,
      low: false,
      lines,
    };
  }
  const remaining = typeof c.remaining === "number" ? c.remaining : null;
  const limit = typeof c.limit === "number" ? c.limit : null;
  const ratio = remaining !== null && limit !== null && limit > 0 ? Math.min(1, Math.max(0, remaining / limit)) : null;
  return {
    slot: typeof c.slot_label === "string" && c.slot_label ? c.slot_label : null,
    value: formatCredits(remaining),
    valueIsText: remaining === null,
    unit: remaining === null ? null : "クレジット",
    ratio,
    low: ratio !== null && ratio <= LOW_RATIO,
    lines,
  };
}

/** モデルを種類ごとにまとめる（KIND_ORDER の順。知らない種類は最後に、出てきた順） */
export function groupModels(models) {
  const list = Array.isArray(models) ? models : [];
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.kind)) groups.set(m.kind, { kind: m.kind, label: m.kind_label || m.kind, models: [] });
    groups.get(m.kind).models.push(m);
  }
  const rank = (k) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** 使い方の表示（「テキストから動画・画像から動画」。1 つだけなら「のみ」を添える） */
export function modesText(modes) {
  const list = Array.isArray(modes) ? modes : [];
  return list.length ? `${list.join("・")}${list.length === 1 ? "のみ" : ""}` : "—";
}

export const MSG_DENIED = "利用登録が確認できません。管理者にお問い合わせください。";
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
