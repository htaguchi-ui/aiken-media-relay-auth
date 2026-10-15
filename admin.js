// 管理コンソール。名簿（members）の管理と使用量の確認を、管理者本人のログインで行う（権限は DB の RLS で判定）。
// 表示はすべて textContent / createElement で組み立てる（データを innerHTML に入れない）。
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import {
  emailProblem,
  explainError,
  formatDateTime,
  formatUsd,
  normalizeEmail,
  parseBulk,
  ROLE_LABELS,
  sortByLastUsed,
  STATUS_LABELS,
  sumUsage,
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

function renderRow(r) {
  const isMe = r.email === myEmail;

  const statusBtn = el("button", {
    className: r.status === "active" ? "danger" : "",
    text: r.status === "active" ? "停止する" : "有効にする",
    onclick: () => changeStatus(r, r.status === "active" ? "disabled" : "active"),
  });

  const roleSelect = el(
    "select",
    { "aria-label": `${r.email} の役割` },
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

  return el(
    "tr",
    {},
    el("td", { text: r.email + (isMe ? "（自分）" : "") }),
    el("td", { text: r.display_name ?? "" }),
    el("td", {}, roleSelect),
    el(
      "td",
      {},
      el("span", { className: `badge ${r.status === "active" ? "" : "disabled"}`, text: STATUS_LABELS[r.status] ?? r.status }),
    ),
    el("td", { className: "num", text: countCost(r.today_count, r.today_cost_usd) }),
    el("td", { className: "num", text: countCost(r.day_count, r.day_cost_usd) }),
    el("td", { className: "num", text: countCost(r.total_count, r.total_cost_usd) }),
    el("td", { text: formatDateTime(r.last_used_at) }),
    el("td", { className: "note", text: r.note ?? "" }),
    el("td", {}, el("div", { className: "actions" }, statusBtn, deleteBtn)),
  );
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
    renderTotals(rows);
    $("rows").replaceChildren(...rows.map(renderRow));
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
  if (!confirm(`${r.email} の役割を「${ROLE_LABELS[role]}」に変更しますか？`)) {
    select.value = r.role;
    return;
  }
  if (r.role === "admin" && role !== "admin" && !confirmSelfLockout(r)) {
    select.value = r.role;
    return;
  }
  await updateMember(r.email, { role }, `${r.email} の役割を「${ROLE_LABELS[role]}」に変更しました。`);
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
  $("add-btn").disabled = true;
  try {
    const result = await insertMembers([{ email, display_name: name || null, role: $("add-role").value }]);
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
  $("bulk-btn").disabled = true;
  try {
    const result = await insertMembers(valid.map((v) => ({ ...v, role })));
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

main().catch((e) => fatal(`エラーが発生しました：${e?.message || e}`));
