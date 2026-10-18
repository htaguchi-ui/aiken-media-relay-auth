// 固定した上のヘッダーの「実際の高さ」を、CSS の変数 --topbar-h に入れる（管理コンソール・講師の画面・マイページ共通）。
// CSS には幅ごとの実測値を初期値として置いてある。ここは、文字サイズの設定・長いメールアドレスなどで高さが変わったときに合わせ直す。
// 対象：.sticky-top（講師の画面。ヘッダーとお知らせを 1 つの箱にしたもの）があればそれ、なければ .topbar。
// 固定されていない（横向きで static にした・選択モードで隠した・まだ表示していない）ときは、入れずに CSS の値（0 など）に任せる。
const target = document.querySelector(".sticky-top") ?? document.querySelector(".topbar");
if (target) {
  const root = document.documentElement;
  const apply = () => {
    const h = target.getBoundingClientRect().height;
    if (h > 0 && getComputedStyle(target).position === "sticky") {
      root.style.setProperty("--topbar-h", `${Math.round(h * 100) / 100}px`);
    } else {
      root.style.removeProperty("--topbar-h");
    }
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(target);
  // 高さが同じまま固定だけが切り替わる場合（横向きの static）にも合わせる
  addEventListener("resize", apply);
  addEventListener("orientationchange", apply);
  apply();
}
