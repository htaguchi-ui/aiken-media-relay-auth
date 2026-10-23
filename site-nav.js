// 画面の間の移動（Canvas・マイページ・講師ページ・管理ページ）。マイページ（mypage.js）・講師ページ（instructor.js）・管理ページ（admin.js）の
// ヘッダーのいちばん上に、同じ並びで出す（2026-10-23 田口さん）。見た目は site-nav.css。
// どのリンクを出すかは、各画面がすでにサーバーから受け取っている区分（role）だけで決める。新しい問い合わせはしない。
// これは案内だけで、守りではない（各画面と DB が、開いた先で自分で権限を確かめる）。
// 今いる画面は aria-current="page" の印にして、リンクにしない。Canvas だけは主ボタンの色で目立たせ、別のタブで開く。
// マイページ・講師ページ・管理ページは同じタブで移る（2026-10-23 田口さんの決定）。
// 表示は createElement / textContent で組み立てる（innerHTML を使わない）。

/** 並びの順（この順で出す）。href は同じサイトの中だけ。primary：主ボタンの色で目立たせる／newTab：別のタブで開く */
export const SITE_PAGES = [
  // Canvas は、ログインしていなければ自動でログインを始める印（autologin=1）を付ける（マイページの今までのリンクと同じ。2026-10-19 田口さん）
  { key: "canvas", label: "Canvas", href: "/canvas?autologin=1", primary: true, newTab: true },
  { key: "mypage", label: "マイページ", href: "/" },
  { key: "instructor", label: "講師ページ", href: "/instructor" },
  { key: "admin", label: "管理ページ", href: "/admin" },
];

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
      }
    }
    node.className = item.primary ? "site-nav-item primary" : "site-nav-item";
    // 文字は中の span に入れる（省略の overflow を中だけに付け、リンクの押せる範囲〔::after〕を切らない）
    const label = doc.createElement("span");
    label.className = "site-nav-label";
    label.textContent = item.label;
    node.append(label);
    li.append(node);
    list.append(li);
  }
  nav.replaceChildren(...(items.length ? [list] : []));
  nav.hidden = items.length === 0;
}
