// 管理コンソール。名簿（members）の管理と使用量の確認を、管理者本人のログインで行う（権限は DB の RLS で判定）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import {
  canGrant,
  courseDatesText,
  CREDIT_FIELDS,
  currentPeriodSummary,
  DEFAULT_MONTHLY_CREDITS,
  emailProblem,
  explainError,
  formatCredits,
  formatDateTime,
  formatMonthDay,
  formatShortDateTime,
  formatUsd,
  formatYen,
  grantText,
  MAX_CREDITS,
  mergedDatesProblem,
  MONTHLY_FIELDS,
  normalizeEmail,
  parseBulk,
  parseCreditForm,
  parseCredits,
  parseGrantCredits,
  readInputValue,
  ROLE_LABELS,
  sortByLastUsed,
  STATUS_LABELS,
  sumUsage,
  windowLastDayText,
  YEN_PER_USD,
} from "./admin-lib.js";

// 他のサイトに埋め込まれて操作させられるのを防ぐ（GitHub Pages では frame-ancestors を指定できないため）
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("管理コンソールは埋め込みでは使えません");
}

const SUPABASE_URL = "https://tnzwhwitgnzoehbjrmoy.supabase.co";
// 公開用のキー（ブラウザに置く前提のもの）。秘密鍵ではない。consent.html と同じ値
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KRY7iSTi9d_z9EwW0KuDwg_ooUqGvDN";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

const $ = (id) => document.getElementById(id);
const SECTIONS = ["status", "login", "denied", "app"];
let myEmail = "";
/** 一覧の最新の行（まとめて設定で使う） */
let currentRows = [];
/** まとめて設定のために選んだ受講者の email */
const selected = new Set();

function show(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

function fatal(message) {
  $("status").replaceChildren(el("p", { className: "error", text: message }));
  show("status");
}

/** 画面上部のお知らせ。kind は "ok" か "error" */
function notify(message, kind = "ok", details = []) {
  const box = $("message");
  const children = [el("p", { className: kind === "error" ? "error" : "ok", text: message, style: "margin:0" })];
  if (details.length) children.push(el("ul", { className: "problems" }, ...details.map((d) => el("li", { text: d }))));
  box.replaceChildren(...children);
}

function clearNotice() {
  $("message").replaceChildren();
}

// ---- ログイン ----

function returnUrl() {
  return location.origin + location.pathname;
}

async function signIn() {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: returnUrl(), queryParams: { prompt: "select_account" } },
  });
}

async function signOut() {
  await supabase.auth.signOut();
  location.replace(returnUrl());
}

// ---- 期間・月額・クレジットの入力欄 ----

const CREDIT_INPUTS = {
  day1_date: { label: "Day1（日付）", type: "date" },
  day2_date: { label: "Day2（日付）", type: "date" },
  day1_credits: { label: "Day1 のクレジット", type: "text" },
  bridge_credits: { label: "ブリッジワーク期間のクレジット", type: "text" },
  day2_credits: { label: "Day2 のクレジット", type: "text" },
  monthly_credits: { label: "AIKENメンバーの月額クレジット", type: "text" },
};

/** 入力欄を作って container に入れ、値を読む関数を返す（keys は作る項目、values は初期値） */
function creditInputs(container, prefix, keys, values = {}) {
  const inputs = {};
  container.replaceChildren(
    ...keys.map((key) => {
      const { label, type } = CREDIT_INPUTS[key];
      const input = el("input", {
        id: `${prefix}-${key}`,
        type,
        inputmode: type === "text" ? "numeric" : null,
        placeholder: type === "text" ? "例：3000" : null,
        autocomplete: "off",
      });
      const v = values[key];
      input.value = v === null || v === undefined ? "" : String(v);
      inputs[key] = input;
      const children = [label, input];
      // 月額は円の目安を併記する（1 ドル＝150 円の固定換算）
      if (key === "monthly_credits") {
        const yen = el("span", { className: "muted" });
        const update = () => {
          const n = parseCredits(input.value);
          yen.textContent = n === null || n === undefined ? "" : `${formatYen(n)}（1 ドル＝${YEN_PER_USD} 円で換算）`;
        };
        input.addEventListener("input", update);
        update();
        children.push(yen);
      }
      return el("label", { for: input.id }, ...children);
    }),
  );
  return {
    read: () =>
      Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, readInputValue(i.value, i.validity?.badInput)])),
    clear: () =>
      Object.values(inputs).forEach((i) => {
        i.value = "";
        i.dispatchEvent(new Event("input"));
      }),
  };
}

/** 枠のある区分（まとめて設定・クレジット追加の対象） */
function hasWindow(r) {
  return r.role === "student" || r.role === "member";
}

function updateSelectedCount() {
  const targets = currentRows.filter(hasWindow);
  for (const email of [...selected]) if (!targets.some((r) => r.email === email)) selected.delete(email);
  const students = targets.filter((r) => r.role === "student" && selected.has(r.email)).length;
  const members = targets.filter((r) => r.role === "member" && selected.has(r.email)).length;
  $("selected-count").textContent = `${selected.size} 人を選択中（受講者 ${students} 人・AIKENメンバー ${members} 人）`;
  const all = $("select-all");
  all.checked = targets.length > 0 && targets.every((r) => selected.has(r.email));
  all.indeterminate = selected.size > 0 && !all.checked;
}

// ---- 名簿と使用量 ----

function countCost(count, cost) {
  return `${Number(count ?? 0)} 件 / ${formatUsd(cost)}`;
}

function renderTotals(rows) {
  const t = sumUsage(rows);
  const item = (label, count, cost) =>
    el(
      "div",
      { className: "total" },
      el("div", { className: "muted", text: label }),
      el("div", { className: "value", text: `${count} 件` }),
      el("div", { className: "muted", text: formatUsd(cost) }),
    );
  $("totals").replaceChildren(
    item("今日", t.today_count, t.today_cost_usd),
    item("直近 24 時間", t.day_count, t.day_cost_usd),
    item("累計", t.total_count, t.total_cost_usd),
    el(
      "div",
      { className: "total" },
      el("div", { className: "muted", text: "登録者" }),
      el("div", { className: "value", text: `${rows.length} 人` }),
      el("div", { className: "muted", text: `有効 ${rows.filter((r) => r.status === "active").length} 人` }),
    ),
  );
}

/** 編集欄の入力の id を一意にするための連番（email から作ると a.b@ と a-b@ が重なるため） */
let editorSeq = 0;

/** 1 人ずつの編集欄（枠の設定・クレジット追加・今の枠の追加の一覧） */
function renderEditor(r, cell) {
  const isStudent = r.role === "student";
  const fields = el("div", { className: "credit-fields" });
  const keys = isStudent ? CREDIT_FIELDS : MONTHLY_FIELDS;
  const form = creditInputs(fields, `edit-${++editorSeq}`, keys, r);

  // 今の枠へのクレジット追加
  const grantCredits = el("input", { type: "text", inputmode: "numeric", placeholder: "例：500", autocomplete: "off" });
  const grantNote = el("input", { type: "text", placeholder: "メモ（任意。理由など）", autocomplete: "off" });
  const grantList = el("ul", { className: "problems" }, el("li", { className: "muted", text: "読み込み中…" }));
  const canAdd = canGrant(r);
  const windowText = r.current_last_date
    ? `今の枠（${isStudent ? "期間" : "今月"}：${formatMonthDay(r.current_last_date)} まで）`
    : "今の枠";

  cell.replaceChildren(
    el("div", {
      className: "muted",
      text: isStudent
        ? `${r.email} の期間とクレジット（空欄は未設定＝その期間は生成できません）`
        : `${r.email} の月額クレジット（空欄は未設定＝生成できません。日本時間の暦月ごと・繰り越しなし）`,
      style: "margin-bottom:8px",
    }),
    fields,
    el(
      "div",
      { className: "actions" },
      el("button", { className: "primary", text: "保存", onclick: () => saveCredits(r, form.read(), keys) }),
    ),
    el("div", { className: "muted", text: `クレジット追加：${windowText}に一時的に足します`, style: "margin:16px 0 8px" }),
    el(
      "div",
      { className: "form-row" },
      grantCredits,
      grantNote,
      el("button", {
        className: "primary",
        text: "今の枠に追加",
        disabled: !canAdd,
        title: canAdd ? "" : "今の枠が無い（期間外・未設定）ため追加できません",
        onclick: () => addGrant(r, grantCredits.value, grantNote.value),
      }),
    ),
    el("div", { className: "muted", text: `${windowText}の追加` }),
    grantList,
  );
  loadGrants(r, grantList);
}

/** 今の枠の一時追加を一覧にする（RLS で管理者だけが読める） */
async function loadGrants(r, list) {
  if (!r.current_kind || !r.current_window_start || !r.current_window_end) {
    list.replaceChildren(el("li", { className: "muted", text: "今の枠がありません。" }));
    return;
  }
  const { data, error } = await supabase
    .from("credit_grants")
    .select("id, credits, note, created_at, created_by_email")
    .eq("email", r.email)
    // 区分を変えた人の前の区分の付与（受講者の期間 ↔ 月額）は、今の枠に数えないので出さない
    .eq("window_kind", r.current_kind)
    .gte("window_start", r.current_window_start)
    .lte("window_end", r.current_window_end)
    .order("created_at", { ascending: false });
  if (error) {
    list.replaceChildren(el("li", { className: "error", text: explainError(error) }));
    return;
  }
  if (!data?.length) {
    list.replaceChildren(el("li", { className: "muted", text: "追加はありません。" }));
    return;
  }
  list.replaceChildren(
    ...data.map((g) =>
      el(
        "li",
        {},
        grantText(g),
        " ",
        el("button", { className: "danger", text: "削除", onclick: () => removeGrant(r, g) }),
      )
    ),
  );
}

function renderRow(r) {
  const isMe = r.email === myEmail;
  const isStudent = r.role === "student";
  const windowed = hasWindow(r);

  const check = el("input", {
    type: "checkbox",
    "aria-label": `${r.email} を選択`,
    disabled: !windowed,
    title: windowed ? "" : "期間・月額は受講者と AIKENメンバーだけに設定します",
    checked: windowed && selected.has(r.email),
  });
  check.addEventListener("change", () => {
    if (check.checked) selected.add(r.email);
    else selected.delete(r.email);
    updateSelectedCount();
  });

  const period = currentPeriodSummary(r);
  const periodCell = period
    ? el(
      "td",
      {},
      period.warn ? el("span", { className: "badge warn", text: period.text }) : period.text,
      ...(period.yen ? [el("div", { className: "muted", text: period.yen })] : []),
    )
    : el("td", { className: "muted", text: "対象外" });

  // 1 人ずつの編集（行の下に入力欄を開く）
  const editorCell = el("td", { colspan: "15" });
  const editor = el("tr", { className: "editor", hidden: true }, editorCell);
  const toggleEditor = async () => {
    if (!editor.hidden) {
      editor.hidden = true;
      return;
    }
    editorCell.replaceChildren(el("p", { className: "muted", text: "読み込み中…" }));
    editor.hidden = false;
    const fresh = await freshRow(r);
    if (!fresh.ok) {
      editor.hidden = true;
      notify("最新の状態を読めませんでした。一覧を読み込み直してください。", "error");
      return;
    }
    if (!fresh.row || !hasWindow(fresh.row)) {
      // 名簿から外された・管理者に変わった：編集欄は閉じて一覧を最新にする
      editor.hidden = true;
      notify(
        fresh.row
          ? `${r.email} は管理者に変わっていたため、一覧を読み込み直しました。`
          : `${r.email} は名簿に見つからなかったため、一覧を読み込み直しました。`,
        "error",
      );
      await loadUsage();
      return;
    }
    renderEditor(fresh.row, editorCell);
  };
  const editBtn = el("button", { text: isStudent ? "期間・クレジット" : "月額", onclick: toggleEditor });
  const grantBtn = el("button", { text: "クレジット追加", onclick: toggleEditor });

  const statusBtn = el("button", {
    className: r.status === "active" ? "danger" : "",
    text: r.status === "active" ? "停止する" : "有効にする",
    onclick: () => changeStatus(r, r.status === "active" ? "disabled" : "active"),
  });

  const roleSelect = el(
    "select",
    { "aria-label": `${r.email} の区分` },
    ...Object.entries(ROLE_LABELS).map(([value, label]) =>
      el("option", { value, text: label, selected: value === r.role })
    ),
  );
  roleSelect.addEventListener("change", () => changeRole(r, roleSelect));

  const deleteBtn = el("button", {
    className: "danger",
    text: "削除",
    disabled: isMe,
    title: isMe ? "自分自身は削除できません" : "",
    onclick: () => removeMember(r),
  });

  const row = el(
    "tr",
    {},
    el("td", {}, check),
    el("td", { text: r.email + (isMe ? "（自分）" : "") }),
    el("td", { text: r.display_name ?? "" }),
    el("td", {}, roleSelect),
    el(
      "td",
      {},
      el("span", { className: `badge ${r.status === "active" ? "" : "disabled"}`, text: STATUS_LABELS[r.status] ?? r.status }),
    ),
    el("td", { className: isStudent ? "" : "muted", text: courseDatesText(r) }),
    periodCell,
    el("td", { className: "num", text: countCost(r.today_count, r.today_cost_usd) }),
    el("td", { className: "num", text: countCost(r.day_count, r.day_cost_usd) }),
    el("td", { className: "num", text: countCost(r.total_count, r.total_cost_usd) }),
    el("td", { text: formatDateTime(r.last_used_at) }),
    el("td", { text: formatShortDateTime(r.last_access_at) }),
    el("td", { text: r.last_client_name ?? (r.last_access_at ? "不明" : "—") }),
    el("td", { className: "note", text: r.note ?? "" }),
    el("td", {}, el("div", { className: "actions" }, ...(windowed ? [editBtn, grantBtn] : []), statusBtn, deleteBtn)),
  );
  return [row, editor];
}

async function loadUsage() {
  $("reload-btn").disabled = true;
  try {
    const { data, error } = await supabase.rpc("admin_usage");
    if (error) {
      notify(`一覧を読み込めませんでした。${explainError(error)}`, "error");
      return;
    }
    const rows = sortByLastUsed(data ?? []);
    currentRows = rows;
    renderTotals(rows);
    $("rows").replaceChildren(...rows.flatMap(renderRow));
    updateSelectedCount();
    $("count").textContent = `${rows.length} 件`;
    $("updated-at").textContent = formatDateTime(new Date().toISOString());
  } finally {
    $("reload-btn").disabled = false;
  }
}

// ---- 行ごとの操作 ----

async function updateMember(email, patch, doneMessage) {
  const { data, error } = await supabase.from("members").update(patch).eq("email", email).select("email");
  if (error) {
    notify(explainError(error), "error");
  } else if (!data?.length) {
    notify("変更できませんでした（権限が無いか、対象が見つかりません）。", "error");
  } else {
    notify(doneMessage);
  }
  await loadUsage();
}

/** 自分自身の管理者権限を失う操作は、メールアドレスの入力で強く確認する（誤って全員が締め出されるのを防ぐ） */
function confirmSelfLockout(r) {
  if (r.email !== myEmail) return true;
  const typed = prompt(
    `自分自身（${r.email}）の管理者権限が無くなり、このコンソールを使えなくなります。\n` +
      "ほかに実在する管理者がいることを確認してから進めてください。\n" +
      "続ける場合は、自分のメールアドレスを入力してください。",
  );
  return normalizeEmail(typed ?? "") === myEmail;
}

async function changeStatus(r, status) {
  const label = status === "active" ? "有効に" : "停止";
  if (status === "disabled" && !confirm(`${r.email} の利用を停止しますか？\n（1 分ほどで MCP が使えなくなります）`)) return;
  if (status === "disabled" && r.role === "admin" && !confirmSelfLockout(r)) return;
  await updateMember(r.email, { status }, `${r.email} を${label}しました。`);
}

async function changeRole(r, select) {
  const role = select.value;
  // AIKENメンバーにするとき、月額が未設定なら初期値（3,300）を入れる
  const patch = { role };
  if (role === "member" && (r.monthly_credits === null || r.monthly_credits === undefined)) {
    patch.monthly_credits = DEFAULT_MONTHLY_CREDITS;
  }
  const extra = "monthly_credits" in patch
    ? `\n（月額クレジットは初期値 ${formatCredits(DEFAULT_MONTHLY_CREDITS)}〔${formatYen(DEFAULT_MONTHLY_CREDITS)}〕にします）`
    : "";
  if (!confirm(`${r.email} の区分を「${ROLE_LABELS[role]}」に変更しますか？${extra}`)) {
    select.value = r.role;
    return;
  }
  if (r.role === "admin" && role !== "admin" && !confirmSelfLockout(r)) {
    select.value = r.role;
    return;
  }
  await updateMember(r.email, patch, `${r.email} の区分を「${ROLE_LABELS[role]}」に変更しました。`);
}

async function saveCredits(r, raw, keys) {
  clearNotice();
  const { patch, problems } = parseCreditForm(raw, { partial: false, fields: keys });
  if (problems.length) {
    notify("保存できません。次の項目を確認してください。", "error", problems);
    return;
  }
  await updateMember(
    r.email,
    patch,
    `${r.email} の${r.role === "member" ? "月額クレジット" : "期間とクレジット"}を保存しました。`,
  );
}

/** 選んだ人の区分に合う項目だけを送る（受講者：期間とクレジット、AIKENメンバー：月額）。空欄は変更しない */
async function applyBulkCredits() {
  clearNotice();
  const targets = currentRows.filter((r) => hasWindow(r) && selected.has(r.email));
  if (!targets.length) {
    notify("一覧で受講者・AIKENメンバーにチェックを入れてください。", "error");
    return;
  }
  const raw = bulkCredits.read();
  const studentForm = parseCreditForm(raw, { partial: true, fields: CREDIT_FIELDS });
  const memberForm = parseCreditForm(raw, { partial: true, fields: MONTHLY_FIELDS });
  const problems = [...studentForm.problems, ...memberForm.problems];
  if (problems.length) {
    notify("適用できません。次の項目を確認してください。", "error", problems);
    return;
  }
  const groups = [
    { rows: targets.filter((r) => r.role === "student"), patch: studentForm.patch, label: "受講者" },
    { rows: targets.filter((r) => r.role === "member"), patch: memberForm.patch, label: "AIKENメンバー" },
  ].filter((g) => g.rows.length && Object.keys(g.patch).length);
  if (!groups.length) {
    notify(
      "選んだ人に設定できる項目が入力されていません（受講者は期間とクレジット、AIKENメンバーは月額。空欄の項目は変更しません）。",
      "error",
    );
    return;
  }
  // 片方の日付だけ変えると前後が逆になる受講者は送らない
  const skipped = [];
  for (const g of groups) {
    g.emails = [];
    for (const r of g.rows) {
      const problem = g.label === "受講者" ? mergedDatesProblem(r, g.patch) : null;
      if (problem) skipped.push(`${r.email}：${problem}`);
      else g.emails.push(r.email);
    }
  }
  const sending = groups.filter((g) => g.emails.length);
  if (!sending.length) {
    notify("適用できる人がいません。", "error", skipped);
    return;
  }
  const summary = sending.map((g) => `${g.label} ${g.emails.length} 人`).join("・");
  if (!confirm(`${summary}に、入力した値を設定しますか？（空欄の項目は変更しません）`)) return;
  $("bulk-credit-btn").disabled = true;
  try {
    const done = [];
    // 送った人数より更新された人数が少ない区分（その間に名簿から外された・メールアドレスが変わったなど）
    const shortfalls = [];
    const shortfallText = () =>
      shortfalls.length
        ? `次の区分では、送った人数より更新された人数が少なくなりました（その間に削除・メールアドレスの変更があった可能性があります）：${
          shortfalls.join("・")
        }。`
        : "";
    for (const [i, g] of sending.entries()) {
      const { data, error } = await supabase.from("members").update(g.patch).in("email", g.emails).select("email");
      if (error) {
        // 区分ごとに順に送るので、失敗した区分のあとは送っていない
        const notRun = sending.slice(i + 1).map((x) => `${x.label} ${x.emails.length} 人`);
        const parts = [];
        if (done.length) parts.push(`${done.join("・")}には設定しました。`);
        parts.push(`${g.label} ${g.emails.length} 人には設定できませんでした（${explainError(error)}）。`);
        if (notRun.length) parts.push(`${notRun.join("・")}には、まだ設定していません（もう一度実行してください）。`);
        if (shortfalls.length) parts.push(shortfallText());
        if (skipped.length) parts.push(`次の ${skipped.length} 人は日付の前後が逆になるため除きました。`);
        notify(parts.join(""), "error", skipped);
        await loadUsage();
        return;
      }
      const updated = data?.length ?? 0;
      if (updated > 0) done.push(`${g.label} ${updated} 人`);
      if (updated < g.emails.length) shortfalls.push(`${g.label} ${g.emails.length - updated} 人`);
    }
    const parts = done.length ? [`${done.join("・")}に設定しました。`] : [];
    if (shortfalls.length) parts.push(shortfallText());
    if (skipped.length) parts.push(`次の ${skipped.length} 人は日付の前後が逆になるため除きました。`);
    const clean = !skipped.length && !shortfalls.length;
    notify(parts.join(""), clean ? "ok" : "error", skipped);
    if (clean) bulkCredits.clear();
    await loadUsage();
  } finally {
    $("bulk-credit-btn").disabled = false;
  }
}

/** 今の枠に一時追加する（時間枠は DB のトリガが決め、枠外なら拒否する） */
async function addGrant(r, creditsText, noteText) {
  clearNotice();
  const credits = parseGrantCredits(creditsText);
  if (credits === undefined) {
    notify(`追加するクレジットは 1〜${formatCredits(MAX_CREDITS)} の整数で入力してください。`, "error");
    return;
  }
  const note = String(noteText ?? "").trim();
  if (!confirm(`${r.email} の今の枠に ${formatCredits(credits)} クレジット（${formatYen(credits)}）を追加しますか？`)) {
    return;
  }
  const { data, error } = await supabase
    .from("credit_grants")
    .insert({ email: r.email, credits, note: note || null })
    .select("window_start, window_end")
    .maybeSingle();
  if (error) {
    notify(explainError(error), "error");
  } else {
    // 枠は DB のトリガがその時点の今の枠で決める（一覧が古いまま日付の境目をまたいでも、実際に付いた枠を示す）
    const until = data?.window_end ? `（${windowLastDayText(data.window_end)} までの枠）` : "";
    notify(`${r.email} の今の枠${until}に ${formatCredits(credits)} クレジットを追加しました。`);
  }
  await loadUsage();
}

/** その人の最新の行（今の枠）を読み直す。{ ok: false } は読み直しの失敗、row が無ければ名簿に無い */
async function freshRow(r) {
  const { data, error } = await supabase.rpc("admin_usage");
  if (error) return { ok: false };
  return { ok: true, row: (data ?? []).find((x) => x.email === r.email) ?? null };
}

async function removeGrant(r, g) {
  if (!confirm(`${r.email} への追加（+${formatCredits(g.credits)}）を削除しますか？`)) return;
  const { data, error } = await supabase.from("credit_grants").delete().eq("id", g.id).select("id");
  if (error) notify(explainError(error), "error");
  else if (!data?.length) notify("削除できませんでした（権限が無いか、対象が見つかりません）。", "error");
  else notify(`${r.email} への追加（+${formatCredits(g.credits)}）を削除しました。`);
  await loadUsage();
}

async function removeMember(r) {
  if (r.email === myEmail) {
    notify("自分自身は削除できません。", "error");
    return;
  }
  if (!confirm(`${r.email} を名簿から削除しますか？\n（使用量の記録は残ります。元に戻すには追加し直してください）`)) return;
  const { data, error } = await supabase.from("members").delete().eq("email", r.email).select("email");
  if (error) notify(explainError(error), "error");
  else if (!data?.length) notify("削除できませんでした（権限が無いか、対象が見つかりません）。", "error");
  else notify(`${r.email} を削除しました。`);
  await loadUsage();
}

// ---- 追加 ----

/** 追加フォームの枠の設定（受講者：期間とクレジット〔空欄は入れない〕、AIKENメンバー：月額）。問題があれば notify して null */
function creditsForAdd(role) {
  if (role === "student") {
    const { patch, problems } = parseCreditForm(addCredits.read(), { partial: true, fields: CREDIT_FIELDS });
    if (problems.length) {
      notify("追加できません。期間とクレジットを確認してください。", "error", problems);
      return null;
    }
    return patch;
  }
  if (role === "member") {
    const { patch, problems } = parseCreditForm(addMonthly.read(), { partial: false, fields: MONTHLY_FIELDS });
    if (problems.length) {
      notify("追加できません。月額クレジットを確認してください。", "error", problems);
      return null;
    }
    return patch;
  }
  return {};
}

/** 登録済みは上書きせずにスキップする（on conflict do nothing）。追加できた件数を返す */
async function insertMembers(rows) {
  const { data, error } = await supabase
    .from("members")
    .upsert(rows, { onConflict: "email", ignoreDuplicates: true })
    .select("email");
  if (error) return { error };
  return { added: data?.length ?? 0 };
}

async function addOne() {
  clearNotice();
  const email = normalizeEmail($("add-email").value);
  const problem = emailProblem(email);
  if (problem) {
    notify(`追加できません：${problem}`, "error");
    return;
  }
  const name = $("add-name").value.trim();
  const role = $("add-role").value;
  const credits = creditsForAdd(role);
  if (!credits) return;
  $("add-btn").disabled = true;
  try {
    const result = await insertMembers([{ email, display_name: name || null, role, ...credits }]);
    if (result.error) {
      notify(explainError(result.error), "error");
      return;
    }
    if (result.added === 0) {
      notify(`${email} は既に登録済みのため、スキップしました（上書きはしていません）。`, "error");
    } else {
      notify(`${email} を追加しました。`);
      $("add-email").value = "";
      $("add-name").value = "";
    }
    await loadUsage();
  } finally {
    $("add-btn").disabled = false;
  }
}

async function addBulk() {
  clearNotice();
  const { valid, invalid, duplicates } = parseBulk($("bulk-text").value);
  const problems = invalid.map((p) => `${p.line} 行目「${p.text}」：${p.reason}`);
  if (!valid.length) {
    notify(
      invalid.length ? "追加できる行がありません。次の行を確認してください。" : "追加する行がありません。",
      "error",
      problems,
    );
    return;
  }
  const role = $("bulk-role").value;
  const credits = creditsForAdd(role);
  if (!credits) return;
  $("bulk-btn").disabled = true;
  try {
    const result = await insertMembers(valid.map((v) => ({ ...v, role, ...credits })));
    if (result.error) {
      notify(explainError(result.error), "error", problems);
      return;
    }
    const skipped = valid.length - result.added;
    const parts = [`${result.added} 件を追加しました。`];
    if (skipped) parts.push(`登録済みのため ${skipped} 件をスキップしました（上書きはしていません）。`);
    if (duplicates) parts.push(`入力内の重複 ${duplicates} 件を除きました。`);
    if (invalid.length) parts.push(`次の ${invalid.length} 行は送らずに除きました。`);
    notify(parts.join(""), invalid.length ? "error" : "ok", problems);
    if (!invalid.length) $("bulk-text").value = "";
    await loadUsage();
  } finally {
    $("bulk-btn").disabled = false;
  }
}

// ---- 起動 ----

async function main() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const params = new URLSearchParams(location.search);
  if (params.get("error_description") || hash.get("error_description")) {
    // 文言は誰でも書き換えられるので、URL の内容は表示しない
    fatal("ログインできませんでした。管理者の Google アカウントでログインし直してください。");
    $("status").append(el("div", { className: "actions" }, el("button", { className: "primary", text: "Google でログイン", onclick: signIn })));
    return;
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) {
    fatal("ログイン状態を確認できませんでした。ページを開き直してください。");
    return;
  }
  if (!session) {
    show("login");
    return;
  }
  // 戻ってきた直後の URL に残る code などを消す
  if (location.search) history.replaceState(null, "", returnUrl());

  // 「自分」の判定は DB と同じく Google の ID 連携の email で行う（auth.users の email とは異なる場合がある）
  const { data: googleEmail } = await supabase.rpc("current_google_email");
  myEmail = normalizeEmail(googleEmail ?? session.user.email ?? "");
  const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");
  if (adminError) {
    fatal(`権限を確認できませんでした。${explainError(adminError)}`);
    return;
  }
  if (!isAdmin) {
    $("denied-email").textContent = session.user.email ?? "";
    show("denied");
    return;
  }

  $("me-email").textContent = myEmail;
  show("app");
  await loadUsage();
}

$("login-btn").addEventListener("click", signIn);
$("logout-btn").addEventListener("click", signOut);
$("denied-logout-btn").addEventListener("click", signOut);
$("reload-btn").addEventListener("click", () => {
  clearNotice();
  loadUsage();
});
$("add-btn").addEventListener("click", addOne);
$("bulk-btn").addEventListener("click", addBulk);
$("bulk-credit-btn").addEventListener("click", applyBulkCredits);
$("select-all").addEventListener("change", () => {
  const targets = currentRows.filter(hasWindow);
  if ($("select-all").checked) targets.forEach((r) => selected.add(r.email));
  else selected.clear();
  $("rows").replaceChildren(...currentRows.flatMap(renderRow));
  updateSelectedCount();
});
// 期間・月額の入力欄（追加フォーム・まとめて設定）。ボタンの処理から使う
const addCredits = creditInputs($("add-credit-fields"), "add", CREDIT_FIELDS);
const addMonthly = creditInputs($("add-monthly-fields"), "add", MONTHLY_FIELDS, {
  monthly_credits: DEFAULT_MONTHLY_CREDITS,
});
const bulkCredits = creditInputs($("bulk-credit-fields"), "bulk", [...CREDIT_FIELDS, ...MONTHLY_FIELDS]);

main().catch((e) => fatal(`エラーが発生しました：${e?.message || e}`));
