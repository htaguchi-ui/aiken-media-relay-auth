// 画面の間の移動（Canvas・マイページ・講師ページ・管理ページ）。マイページ（mypage.js）・講師ページ（instructor.js）・管理ページ（admin.js）の
// ヘッダーの 1 段の右側（題名の右・ログアウトなどの左）に、同じ並びで出す（2026-10-23 田口さん）。見た目は site-nav.css。
// ページの切り替えは文字のリンク。狭い幅では右側の開閉ボタンにまとめる。ヘッダーのボタン・管理コンソールの左のメニューのアイコンも、
// ここの形（SITE_ICONS）を fillIcons で入れる（形と出典の表示を 1 か所にまとめる）。
// どのリンクを出すかは、各画面がすでにサーバーから受け取っている区分（role）だけで決める。新しい問い合わせはしない。
// これは案内だけで、守りではない（各画面と DB が、開いた先で自分で権限を確かめる）。
// 今いる画面は aria-current="page" の印にして、リンクにしない。Canvas は別のタブで開く。
// マイページ・講師ページ・管理ページは同じタブで移る（2026-10-23 田口さんの決定）。
// 見た目（2026-10-26 田口さんの依頼）：ロゴの右に文字だけの案内、狭い幅はハンバーガー。
// 表示は createElement / createElementNS / textContent で組み立てる（innerHTML を使わない）。

/** 並びの順。href は同じサイトの中だけ。newTab：別のタブで開く。旧 primary/iconOnly は項目の互換用。 */
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
 * log-out：ヘッダーの［ログアウト］（スマホの幅ではアイコンだけ）／circle-user-round：管理コンソールのアカウントのボタン（Canvas のアカウントの印と同じ）／users・calendar-days・sliders-horizontal：管理コンソールの左のメニューの
 * ［名簿］［回］［設定］（歯車は管理ページの印に使っているので、設定は Canvas の設定と同じ sliders-horizontal）。
 * log-out だけは Lucide の LICENSE の「Feather から派生したアイコン」の一覧にあるので、下の MIT License も掛かる。ほかは ISC License だけ。
 * 許諾の文（lucide-react 1.59.0 の LICENSE から）：
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
  "circle-user-round": [
    ["path", { d: "M17.925 20.056a6 6 0 0 0-11.851.001" }],
    ["circle", { cx: "12", cy: "11", r: "4" }],
    ["circle", { cx: "12", cy: "12", r: "10" }],
  ],
  "log-out": [
    ["path", { d: "m16 17 5-5-5-5" }],
    ["path", { d: "M21 12H9" }],
    ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }],
  ],
  users: [
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
    ["path", { d: "M16 3.128a4 4 0 0 1 0 7.744" }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }],
    ["circle", { cx: "9", cy: "7", r: "4" }],
  ],
  "calendar-days": [
    ["path", { d: "M8 2v3" }],
    ["path", { d: "M16 2v3" }],
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
    ["path", { d: "M3 9h18" }],
    ["path", { d: "M8 13h.01" }],
    ["path", { d: "M12 13h.01" }],
    ["path", { d: "M16 13h.01" }],
    ["path", { d: "M8 17h.01" }],
    ["path", { d: "M12 17h.01" }],
    ["path", { d: "M16 17h.01" }],
  ],
  "sliders-horizontal": [
    ["path", { d: "M10 5H3" }],
    ["path", { d: "M12 19H3" }],
    ["path", { d: "M14 3v4" }],
    ["path", { d: "M16 17v4" }],
    ["path", { d: "M21 12h-9" }],
    ["path", { d: "M21 19h-5" }],
    ["path", { d: "M21 5h-7" }],
    ["path", { d: "M8 10v4" }],
    ["path", { d: "M8 12H3" }],
  ],
};

/*
 * log-out に掛かる MIT License（lucide-react 1.59.0 の LICENSE から。log-out は "The following Lucide icons are derived from the Feather project" の一覧にある）：
 *
 * The MIT License (MIT) (for the icons listed above)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** アイコンの svg（飾り。読み上げない・フォーカスしない）。size は表示の大きさ（px） */
export function siteIcon(doc, name, size) {
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
 * HTML に置いた data-icon="名前"（data-icon-size="大きさ"。無ければ 20）の要素の先頭に、そのアイコンを入れる（1 回だけ）。
 * ヘッダーの［ログアウト］・管理コンソールの左のメニューなど、静的なボタンのアイコンに使う
 */
export function fillIcons(root = document, doc = document) {
  for (const slot of root.querySelectorAll("[data-icon]")) {
    if (slot.querySelector("svg")) continue;
    slot.prepend(siteIcon(doc, slot.getAttribute("data-icon"), Number(slot.getAttribute("data-icon-size")) || 20));
  }
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
  const items = SITE_PAGES.filter((p) => access[p.key]).map((p) => ({ ...p, current: p.key === current }));
  // B の提出画面にも現在地を出す。ほかの画面・区分に移動先を追加しない。
  if (current === "submissions" && access.instructor) {
    items.push({ key: "submissions", label: "提出ページ", href: "/submissions", current: true });
  }
  return items;
}

// 再描画・ログアウトのたびに前の文書リスナーと監視を外す。
const navCleanup = new WeakMap();
let nextNavId = 0;

/**
 * nav（<nav class="site-nav">）の中身を作り直す。出す項目が無いとき（区分が不明・ログアウトの途中）は中身を消して隠す。
 * doc は document（試験では小さな DOM を渡す）。
 * options.linkCurrent：true のとき、今いる項目もリンクにする（aria-current="page" の印とハイライトはそのまま）。
 * 講師ページの「回の操作」のページが、メニューの「講師ページ」を回の一覧へのリンクにするために渡す（設計 docs/design-instructor-split.md 2.6）。
 * 渡さない（既定）ページの描き方は、この引数を足す前と同じ
 */
export function renderSiteNav(nav, role, current, doc = document, { linkCurrent = false } = {}) {
  if (!nav) return;
  navCleanup.get(nav)?.();
  navCleanup.delete(nav);
  const items = siteNavItems(role, current);
  const list = doc.createElement("ul");
  list.className = "site-nav-list";
  list.id = `site-nav-links-${++nextNavId}`;
  for (const item of items) {
    const li = doc.createElement("li");
    let node;
    if (item.current && !linkCurrent) {
      node = doc.createElement("span");
      node.setAttribute("aria-current", "page");
    } else {
      node = doc.createElement("a");
      node.setAttribute("href", item.href);
      if (item.current) node.setAttribute("aria-current", "page");
      if (item.newTab) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
        node.setAttribute("aria-label", `${item.label}（別のタブ）`);
      }
    }
    node.className = "site-nav-item";
    if (item.newTab) node.setAttribute("title", `${item.label}（別のタブ）`);
    const label = doc.createElement("span");
    label.className = "site-nav-label";
    label.textContent = item.label;
    node.append(label);
    li.append(node);
    list.append(li);
  }
  const toggle = doc.createElement("button");
  toggle.className = "site-nav-toggle";
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-label", "ページのメニューを開く");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", list.id);
  const icon = doc.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "aria-hidden": "true", focusable: "false" })) icon.setAttribute(key, value);
  const lines = doc.createElementNS(SVG_NS, "path");
  lines.setAttribute("d", "M4 6h16M4 12h16M4 18h16");
  icon.append(lines);
  toggle.append(icon);
  nav.replaceChildren(...(items.length ? [toggle, list] : []));
  nav.hidden = items.length === 0;
  if (!items.length) return;

  // 通常の disclosure navigation。リンクは通常の Tab 順のまま（menu ロールを使わない）。
  const view = doc.defaultView;
  const media = view?.matchMedia?.("(max-width: 719.98px)");
  const bar = nav.closest?.(".topbar-inner");
  let compact = !!media?.matches;
  let neededWidth = 0;
  let open = false;
  function setOpen(value, returnFocus = false) {
    open = compact && value;
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "ページのメニューを閉じる" : "ページのメニューを開く");
    list.hidden = compact && !open;
    if (returnFocus) toggle.focus();
  }
  function updateLayout() {
    const wasCompact = compact;
    compact = !!media?.matches;
    if (!compact && bar) {
      // 720px 以上でも文字拡大や長い見出しでは折り返さずにまとめる。
      const available = bar.clientWidth;
      if (wasCompact && neededWidth && available < neededWidth) compact = true;
      else {
        nav.classList.remove("is-compact");
        list.hidden = false;
        const excess = bar.scrollWidth - available;
        if (excess > 1) {
          neededWidth = available + excess + 8;
          compact = true;
        }
      }
    }
    nav.classList.toggle("is-compact", compact);
    // デスクトップへ戻るとき、消えるボタンへフォーカスを残さない。
    if (wasCompact && !compact && doc.activeElement === toggle) list.querySelector("a")?.focus();
    setOpen(false);
  }
  function onToggle() { setOpen(!open); }
  function onKey(event) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false, true);
    } else if (event.target === toggle && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setOpen(true);
      const links = list.querySelectorAll("a");
      (event.key === "ArrowUp" ? links[links.length - 1] : links[0])?.focus();
    }
  }
  function onOutside(event) {
    if (open && !nav.contains(event.target)) setOpen(false);
  }
  function onFocus(event) {
    if (open && !nav.contains(event.target)) setOpen(false);
  }
  function onLink(event) {
    if (event.target.closest?.("a")) setOpen(false);
  }
  toggle.addEventListener("click", onToggle);
  nav.addEventListener("keydown", onKey);
  list.addEventListener("click", onLink);
  doc.addEventListener("pointerdown", onOutside);
  doc.addEventListener("focusin", onFocus);
  media?.addEventListener?.("change", updateLayout);
  const observer = bar && view?.ResizeObserver ? new view.ResizeObserver(updateLayout) : null;
  observer?.observe(bar);
  updateLayout();
  navCleanup.set(nav, () => {
    doc.removeEventListener("pointerdown", onOutside);
    doc.removeEventListener("focusin", onFocus);
    media?.removeEventListener?.("change", updateLayout);
    observer?.disconnect();
    nav.classList.remove("is-compact", "is-open");
  });
}
