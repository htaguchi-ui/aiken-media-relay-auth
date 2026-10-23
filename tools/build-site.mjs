// 公開する中身を dist/ に作る道具（2026-10-23。SEC-03 と同じ日）。依存なし（node だけ）。
//
// しくみ：
//   - Vercel の build（vercel.json の buildCommand）で、asset-versions.mjs の check-build のあとに走る。Vercel は dist/（outputDirectory）だけを公開する。
//   - 公開するのは、直下の名前が PUBLISH_FILE_RE（英小文字・数字・ハイフンだけの .html・.js・.css）に合うファイルと、PUBLISH_DIRS（img/・canvas/）の下だけ。
//     （出力が直下〔"."〕のままだと、vercel.json の rewrites はあるファイルより後にしか効かないので、直下のファイルを 404 にできない）
//   - 公開しない直下のもののうち、黙って出さないのは .md・.json・.mjs・点で始まるもの・PRIVATE_DIRS（tools/）だけ。
//     それ以外（.sh・.txt・決まりに合わない名前の JS・新しいフォルダなど）は、公開するか決まっていないので build を止める（黙って 404 にしない）。
//   - あわせて、直下の HTML を確かめる。食い違えば build を止める：
//       ・CSP の meta（script-src）と、その HTML のインラインのスクリプトの hash が合うか（合わないとその画面のスクリプトが動かない。
//         consent.html なら ChatGPT などの接続が止まる）。正しい hash を知らせる。古い hash が残っていても止める
//       ・見つかったのに読めない CSP の meta（content が無い・空）・閉じていない <script>
//       ・インラインの on 属性（onclick など）・javascript: の URL（CSP の画面では動かない。今の画面には無い）
//   - 最後に、作った dist/ の中身だけで版（asset-versions.mjs の verify）が合うかも確かめる（公開から漏れた JS・CSS があれば止まる）。
//
// 使い方（auth-page の直下で）:
//   node tools/build-site.mjs                     … dist/ を作り直す（前の dist/ は消す）
//   node tools/build-site.mjs <auth-page> <出力先> … 試験用。出力先は、無いか空のフォルダだけ（消さない）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { diskReader, lf, verify } from "./asset-versions.mjs";

/** 直下で公開するファイル（名前の形） */
export const PUBLISH_FILE_RE = /^[a-z0-9-]+\.(html|js|css)$/;
/** 中身を全部公開する直下のフォルダ */
export const PUBLISH_DIRS = ["img", "canvas"];
/** 公開しない直下のフォルダ（黙って出さない） */
export const PRIVATE_DIRS = ["tools"];
export const OUT_DIR = "dist";

/** 公開するファイル（root からの相対の住所。"/" 区切り・名前の順）と、公開しない直下の名前（フォルダは末尾に "/"） */
export function publishPlan(root) {
  const files = [];
  const skipped = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".")) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) files.push(r);
    }
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isFile() && PUBLISH_FILE_RE.test(e.name)) files.push(e.name);
    else if (e.isDirectory() && PUBLISH_DIRS.includes(e.name)) walk(e.name);
    else if (e.name !== ".git" && e.name !== OUT_DIR) skipped.push(e.isDirectory() ? `${e.name}/` : e.name);
  }
  return { files, skipped };
}

/** 公開しない直下の名前のうち、公開するか決まっていないもの（.md・.json・.mjs・点で始まるもの・PRIVATE_DIRS 以外） */
export function unplannedNames(skipped) {
  return skipped.filter((n) => {
    if (n.startsWith(".")) return false;
    if (n.endsWith("/")) return !PRIVATE_DIRS.includes(n.slice(0, -1));
    return !/\.(md|json|mjs)$/.test(n);
  });
}

// ---- HTML を読む（依存なしの小さな読み方。コメント・<script> の中身・タグと属性） ----
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;
const TOKEN = new RegExp(`<!--[\\s\\S]*?-->|<script\\b(${ATTRS})>([\\s\\S]*?)</script\\s*>|<([a-zA-Z][\\w:-]*)(${ATTRS})>`, "gi");
const NAMED = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", colon: ":", tab: "\t", newline: "\n", sol: "/", lpar: "(", rpar: ")" };
/** 属性の値の文字参照を戻す（&#106;・&#x6A;・&colon; など） */
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
/** タグの属性（[小文字の名前, 値（文字参照を戻したもの）か null（= の無い属性）]） */
function attrsOf(src) {
  return [...src.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].map((m) => {
    const v = m[2] ?? m[3] ?? m[4];
    return [m[1].toLowerCase(), v === undefined ? null : decode(v)];
  });
}
/** HTML の中の <script>（属性と中身）と、ほかのタグ（名前と属性）。コメントの中は数えない。改行は LF にそろえる */
export function scanHtml(html) {
  const scripts = [];
  const tags = [];
  for (const m of lf(html).matchAll(TOKEN)) {
    if (m[0].startsWith("<!--")) continue;
    if (m[3] === undefined) scripts.push({ attrs: attrsOf(m[1]), body: m[2] });
    else tags.push({ name: m[3].toLowerCase(), attrs: attrsOf(m[4]) });
  }
  return { scripts, tags };
}

/** インラインのスクリプト（src の属性の無い <script>）の中身の SHA-256（CSP の書き方 'sha256-…'）。ブラウザも LF で読む */
export function inlineScriptHashes(html) {
  return scanHtml(html)
    .scripts.filter((s) => !s.attrs.some(([n]) => n === "src"))
    .map((s) => `'sha256-${crypto.createHash("sha256").update(s.body, "utf8").digest("base64")}'`);
}

/** CSP の meta（http-equiv が Content-Security-Policy。大文字小文字・属性の順は問わない）。content が無い・空のものは unreadable に数える */
function cspMetaTags(html) {
  const policies = [];
  let unreadable = 0;
  for (const t of scanHtml(html).tags) {
    if (t.name !== "meta") continue;
    const eq = t.attrs.find(([n]) => n === "http-equiv");
    if (!eq || (eq[1] ?? "").trim().toLowerCase() !== "content-security-policy") continue;
    const c = t.attrs.find(([n]) => n === "content");
    if (!c || c[1] === null || !c[1].trim()) unreadable += 1;
    else policies.push(c[1]);
  }
  return { policies, unreadable };
}

/** HTML の CSP の meta の中身（読めたものの全部） */
export function cspMetas(html) {
  return cspMetaTags(html).policies;
}

/** CSP の文字の中の、ある指示（script-src など）の値の並び（無ければ null） */
export function directive(csp, name) {
  for (const part of csp.split(";")) {
    const [k, ...v] = part.trim().split(/\s+/);
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

/** 1 つの HTML の CSP の meta と、インラインのスクリプトの hash の食い違い（文の配列。空なら合っている） */
export function cspProblems(name, html) {
  const { policies, unreadable } = cspMetaTags(html);
  const problems = [];
  if (unreadable) problems.push(`${name}：読めない CSP の meta が ${unreadable} 個ある（content が無い・空。直すか消す）`);
  if (!policies.length) return problems;
  const hashes = inlineScriptHashes(html);
  for (const csp of policies) {
    const src = directive(csp, "script-src") ?? directive(csp, "default-src") ?? [];
    const allowed = src.filter((s) => /^'sha(256|384|512)-/.test(s));
    for (const h of hashes) if (!src.includes(h)) problems.push(`${name}：インラインのスクリプトの hash ${h} が CSP の script-src に無い（中身を変えたら meta の hash を直す）`);
    for (const a of allowed) if (!hashes.includes(a)) problems.push(`${name}：CSP の script-src の ${a} に当たるインラインのスクリプトが無い（古い hash を消す）`);
  }
  return problems;
}

/** 1 つの HTML の確かめの全部：CSP の meta と hash・閉じていない <script>・インラインの on 属性・javascript: の URL */
export function htmlProblems(name, html) {
  const problems = cspProblems(name, html);
  const { scripts, tags } = scanHtml(html);
  if (tags.some((t) => t.name === "script")) problems.push(`${name}：閉じていない <script> がある`);
  for (const t of [...tags, ...scripts.map((s) => ({ name: "script", attrs: s.attrs }))]) {
    for (const [n, v] of t.attrs) {
      if (/^on./.test(n)) problems.push(`${name}：<${t.name}> にインラインの on 属性（${n}）がある（JS の addEventListener で付ける）`);
      if (v !== null && /^javascript:/i.test(v.replace(/[\u0000- ]/g, ""))) problems.push(`${name}：<${t.name}> の ${n} に javascript: の URL がある`);
    }
  }
  return problems;
}

/** dist を作る。{ files, skipped, problems }（problems があれば何も書かない） */
export function build(root, out) {
  const problems = [];
  for (const n of fs.readdirSync(root).filter((x) => x.endsWith(".html")).sort()) {
    problems.push(...htmlProblems(n, fs.readFileSync(path.join(root, n), "utf8")));
  }
  const plan = publishPlan(root);
  for (const n of unplannedNames(plan.skipped)) {
    problems.push(`公開するか決まっていない直下のもの：${n}（公開するなら名前を PUBLISH_FILE_RE に合わせるか PUBLISH_DIRS に足す。公開しないなら PRIVATE_DIRS に足すか、置かない）`);
  }
  if (problems.length) return { ...plan, problems };
  for (const f of plan.files) {
    const to = path.join(out, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, f), to);
  }
  // 作った中身だけで版が合うか（vercel.json は公開しないので、元の場所のものを読む）
  const disk = diskReader(out);
  const rootDisk = diskReader(root);
  const r = verify({ names: disk.names, read: (n) => (n === "vercel.json" ? rootDisk.read(n) : disk.read(n)) });
  problems.push(...r.problems.map((p) => `${OUT_DIR}/ の中身：${p}`));
  return { ...plan, problems };
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const custom = process.argv[3] !== undefined;
  const out = path.resolve(custom ? process.argv[3] : path.join(root, OUT_DIR));
  if (custom) {
    if (fs.existsSync(out) && fs.readdirSync(out).length) {
      console.error(`出力先 ${out} が空ではありません（試験用の出力先は、無いか空のフォルダだけ）`);
      process.exit(2);
    }
  } else {
    fs.rmSync(out, { recursive: true, force: true });
  }
  const r = build(root, out);
  if (r.problems.length) {
    console.error(`公開の中身を作れません：\n- ${r.problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`${path.basename(out)}/ に ${r.files.length} 個を出しました。出さないもの：${r.skipped.join(", ") || "なし"}`);
}
