// 画面の間の移動（Canvas・マイページ・講師ページ・管理ページ）。マイページ（mypage.js）・講師ページ（instructor.js）・管理ページ（admin.js）の
// ヘッダーのいちばん上に、同じ並びで出す（2026-10-23 田口さん）。見た目は site-nav.css。
// どのリンクを出すかは、各画面がすでにサーバーから受け取っている区分（role）だけで決める。新しい問い合わせはしない。
// これは案内だけで、守りではない（各画面と DB が、開いた先で自分で権限を確かめる）。
// 今いる画面は aria-current="page" の印にして、リンクにしない。Canvas だけは主ボタンの色で目立たせ、別のタブで開く。
// マイページ・講師ページ・管理ページは同じタブで移る（2026-10-23 田口さんの決定）。
// 見た目（2026-10-23 田口さんの依頼）：マイページ・講師ページ・管理ページはアイコンだけ（名前は aria-label・title と読み上げ用の文字）。
// Canvas は文字の左に、Canvas の画面の印（ノードを線でつないだ形）と同じアイコン。
// 表示は createElement / createElementNS / textContent で組み立てる（innerHTML を使わない）。

/** 並びの順（この順で出す）。href は同じサイトの中だけ。primary：主ボタンの色で目立たせる／newTab：別のタブで開く */
export const SITE_PAGES = [
  // Canvas は、ログインしていなければ自動でログインを始める印（autologin=1）を付ける（マイページの今までのリンクと同じ。2026-10-19 田口さん）
  { key: "canvas", label: "Canvas", href: "/canvas?autologin=1", primary: true, newTab: true, icon: "workflow" },
  { key: "mypage", label: "マイページ", href: "/", iconOnly: true, icon: "house" },
  { key: "instructor", label: "講師ページ", href: "/instructor", iconOnly: true, icon: "graduation-cap" },
  { key: "admin", label: "管理ページ", href: "/admin", iconOnly: true, icon: "settings" },
];

/**
 * アイコンの形（24×24・線だけ・線の太さ 2・端と角は丸め）。Lucide（ISC License。Copyright (c) Lucide Icons and Contributors）の線を
 * そのまま写した（canvas-app/node_modules/lucide-react 1.59.0 の dist/esm/icons から）。
 * workflow：Canvas の画面の印（canvas-app/src/icons.ts の canvas）／house：マイページ（トップ。2026-10-23 田口さん「ホーム（家）の形」）／
 * graduation-cap・settings：2026-10-19 のマイページのヘッダーの講師の画面・管理コンソールのボタンと同じ。
 * 4 つとも Lucide の LICENSE の「Feather から派生したアイコン」の一覧には無いので、ISC License だけが掛かる。許諾の文（lucide-react 1.59.0 の LICENSE から）：
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
export const SITE_ICONS = {
  workflow: [
    ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4" }],
    ["rect", { width: "8", height: "8", x: "13", y: "13", rx: "2" }],
  ],
  house: [
    ["path", { d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" }],
    ["path", { d: "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }],
  ],
  "graduation-cap": [
    ["path", { d: "M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" }],
    ["path", { d: "M22 10v6" }],
    ["path", { d: "M6 12.5V16a6 3 0 0 0 12 0v-3.5" }],
  ],
  settings: [
    [
      "path",
      {
        d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
      },
    ],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** アイコンの svg（飾り。読み上げない・フォーカスしない）。size は表示の大きさ（px） */
function siteIcon(doc, name, size) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const attrs = {
    class: "site-nav-icon", width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, a] of SITE_ICONS[name] ?? []) {
    const part = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) part.setAttribute(k, v);
    svg.append(part);
  }
  return svg;
}

/**
 * 区分ごとに、どの画面へのリンクを出すか。サーバーの守りに合わせる：
 * Canvas・マイページ＝名簿で有効な人（区分を問わない）／講師ページ＝講師の区分か管理者（instructor_cohorts）／管理ページ＝管理者。
 * 区分の答えが無い（null・undefined。ログアウトの途中・まだ読んでいない）ときは、どれも出さない。
 * 答えはあるが知らない区分のとき（/me は成功した＝名簿で有効）は、Canvas とマイページだけ出す（Canvas の入口を消さない）
 */
export function siteNavAccess(role) {
  const member = role !== null && role !== undefined;
  return { canvas: member, mypage: member, instructor: role === "instructor" || role === "admin", admin: role === "admin" };
}

/** 出す項目（並びの順）。current は今いる画面の key。{ key, label, href, current } の配列 */
export function siteNavItems(role, current) {
  const access = siteNavAccess(role);
  return SITE_PAGES.filter((p) => access[p.key]).map((p) => ({ ...p, current: p.key === current }));
}

/**
 * nav（<nav class="site-nav">）の中身を作り直す。出す項目が無いとき（区分が不明・ログアウトの途中）は中身を消して隠す。
 * doc は document（試験では小さな DOM を渡す）
 */
export function renderSiteNav(nav, role, current, doc = document) {
  if (!nav) return;
  const items = siteNavItems(role, current);
  const list = doc.createElement("ul");
  list.className = "site-nav-list";
  for (const item of items) {
    const li = doc.createElement("li");
    let node;
    if (item.current) {
      node = doc.createElement("span");
      node.setAttribute("aria-current", "page");
    } else {
      node = doc.createElement("a");
      node.setAttribute("href", item.href);
      if (item.newTab) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
        node.setAttribute("aria-label", `${item.label}（別のタブ）`);
      } else if (item.iconOnly) {
        // アイコンだけのリンク：読み上げの名前は画面の名前
        node.setAttribute("aria-label", item.label);
      }
    }
    node.className = ["site-nav-item", item.primary ? "primary" : "", item.iconOnly ? "icon-only" : ""].filter(Boolean).join(" ");
    // アイコンだけのものは、マウスを重ねると名前が出る（title）
    if (item.iconOnly) node.setAttribute("title", item.label);
    if (item.icon) node.append(siteIcon(doc, item.icon, item.iconOnly ? 20 : 18));
    // 文字は中の span に入れる（省略の overflow を中だけに付け、リンクの押せる範囲〔::after〕を切らない）。
    // アイコンだけのものは、見えない読み上げ用の文字にする（今いる画面の span は aria-label を持てないので、名前はこの文字で伝える）
    const label = doc.createElement("span");
    label.className = item.iconOnly ? "site-nav-sr" : "site-nav-label";
    label.textContent = item.label;
    node.append(label);
    li.append(node);
    list.append(li);
  }
  nav.replaceChildren(...(items.length ? [list] : []));
  nav.hidden = items.length === 0;
}
