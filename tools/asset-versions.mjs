// JS・CSS の住所の「版」（ページを移るときの読み込みを速くする。2026-10-23）を書く・確かめる道具。依存なし（node だけ）。
//
// しくみ：
//   - 版 = 直下の *.js・*.css（git で管理しているもの）の名前と中身（改行は LF にそろえる）から作る SHA-256 の頭 12 桁。
//   - 版の住所で読む画面（PAGES：index・instructor・admin・about と、試しのページ probe/background.html）は、直下の JS・CSS を /r/<版>/<名前> で読む。モジュールの中の import は
//     相対（"./auth-storage.js"）なので、同じ /r/<版>/ の下を読む。各画面の <head> には、その画面が import でたどるファイルの modulepreload。
//   - vercel.json：/r/<今の版>/<直下の JS・CSS の名前のどれか> だけを直下のファイルに書き換え、1 年・immutable を付ける。
//     ほかの /r/…（前の版・無い名前）は書き換えず（404）、no-cache。版と名前の並びは、この道具が vercel.json に書く。
//   - Vercel の build（vercel.json の buildCommand）で check-build を走らせ、画面・vercel.json の版と、公開する中身が合わなければ
//     build を失敗させる（＝公開されない）。入れ忘れ・commit 忘れ・版の書き忘れは、ここで止まる。
//
// 使い方（auth-page の直下で）:
//   node tools/asset-versions.mjs stamp        … git に入れる中身（index。git add した中身）から版を作り、4 つの画面と vercel.json を書き直す。
//                                                 直下の JS・CSS が git add されていない（新しいファイル・add していない変更）ときは書かずに止まる
//   node tools/asset-versions.mjs check        … 公開の前（commit のあと・push の前）：HEAD の中身で版が合うか・未 commit の変更が無いかを確かめる
//   node tools/asset-versions.mjs check-build  … Vercel の build で走る：置かれたファイル（公開する中身）だけで確かめる
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 版の住所で読む画面（auth-page の直下からの住所。probe/background.html は裏に回った画面の試し〔2026-10-24〕。JS・CSS は直下のものを読む） */
export const PAGES = ["index.html", "instructor.html", "admin.html", "about.html", "probe/background.html"];
const ASSET_RE = /^[a-z0-9-]+\.(js|css)$/;
const TOKEN = "[0-9a-f]{12}";

/** 改行を LF にそろえる（Windows で CRLF に変わっていても、同じ中身なら同じ版） */
export const lf = (text) => String(text).replace(/\r\n/g, "\n");

/** 直下の JS・CSS の名前（並べ替え済み） */
export const assetNamesOf = (names) => names.filter((n) => ASSET_RE.test(n)).sort();

/** 版：names の名前と中身（read(name) の文字列を LF にそろえたもの） */
export function tokenOf(names, read) {
  const h = crypto.createHash("sha256");
  for (const n of names) {
    h.update(n);
    h.update("\0");
    h.update(lf(read(n)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** JS の中の静的な import（相対の "./x.js"）の名前 */
export function importsOf(source) {
  const out = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"\.\/([a-z0-9-]+\.js)"\s*;/gms)) out.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+"\.\/([a-z0-9-]+\.js)"\s*;/gm)) out.push(m[1]);
  return [...new Set(out)];
}

/** entry から import でたどれるファイル（entry 自身は含めない・名前の順）。read(name) が null なら、そのファイルが無い */
export function transitiveImports(read, entry) {
  const seen = new Set();
  const walk = (name) => {
    const src = read(name);
    if (src === null) return;
    for (const dep of importsOf(src)) {
      if (seen.has(dep) || dep === entry) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(entry);
  return [...seen].sort();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** 画面の中の直下の JS・CSS の住所を /r/<版>/ にそろえ、modulepreload を書き直す */
export function stampHtml(html, token, names, read) {
  const set = new Set(names);
  const ref = new RegExp(`(<link rel="stylesheet" href=|<script type="module" src=)"(?:\\.?/|/r/${TOKEN}/)([a-z0-9-]+\\.(?:js|css))"`, "g");
  let out = html.replace(ref, (all, head, name) => (set.has(name) ? `${head}"/r/${token}/${name}"` : all));
  out = out.replace(/^<link rel="modulepreload" href="[^"]*">\n/gm, "");
  const entries = [...out.matchAll(new RegExp(`<script type="module" src="/r/${token}/([a-z0-9-]+\\.js)"`, "g"))].map((m) => m[1]);
  const deps = [...new Set(entries.flatMap((e) => transitiveImports(read, e)))].filter((d) => !entries.includes(d)).sort();
  if (deps.length) {
    const css = [...out.matchAll(new RegExp(`^<link rel="stylesheet" href="/r/${token}/[a-z0-9-]+\\.css">\n`, "gm"))];
    if (!css.length) throw new Error("modulepreload を書く場所（直下の CSS の <link>）が見つかりません");
    const at = css.at(-1).index + css.at(-1)[0].length;
    out = out.slice(0, at) + deps.map((d) => `<link rel="modulepreload" href="/r/${token}/${d}">\n`).join("") + out.slice(at);
  }
  return out;
}

/** vercel.json の /r/<版>/ の source（今の版・直下の JS・CSS の名前だけ。path-to-regexp の名前付きの引数） */
export const versionedSource = (token, names) => `/r/${token}/:file(${names.map((n) => n.replace(/\./g, "\\.")).join("|")})`;

/** vercel.json の文字の中の /r/<版>/:file(…) の source を、今の版と名前に書き直す（ほかの書式は変えない） */
export function stampVercel(text, token, names) {
  const re = new RegExp(`"source": "/r/${TOKEN}/:file\\((?:[^"\\\\]|\\\\.)*\\)"`, "g");
  return text.replace(re, `"source": ${JSON.stringify(versionedSource(token, names))}`);
}

/** 読み方（どこから中身を読むか） */
export function diskReader(root) {
  return {
    names: () => fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isFile()),
    read: (n) => {
      const f = path.join(root, n);
      return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, "utf8") : null;
    },
  };
}
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
/** rev：":"（index。git add した中身）か "HEAD"。names は直下のファイルだけ、read はフォルダの下（PAGES の probe/…）も読める */
export function gitReader(root, rev) {
  const list = rev === ":" ? git(root, ["ls-files", "-z", "--", "."]) : git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "."]);
  const all = list.split("\0").filter(Boolean);
  const names = all.filter((n) => !n.includes("/"));
  const set = new Set(all);
  return {
    names: () => names,
    read: (n) => (set.has(n) ? git(root, ["show", `${rev === ":" ? ":" : "HEAD:"}./${n}`]) : null),
  };
}

/**
 * src（読み方）の中身だけで、版・4 つの画面・vercel.json が合っているかを確かめる。食い違いの文の配列を返す（空なら合っている）
 */
export function verify(src) {
  const problems = [];
  const names = assetNamesOf(src.names());
  const token = tokenOf(names, src.read);
  for (const page of PAGES) {
    const html = src.read(page);
    if (html === null) {
      problems.push(`${page} が無い`);
      continue;
    }
    if (stampHtml(html, token, names, src.read) !== html) problems.push(`${page}：版（${token}）・modulepreload が中身と合わない（stamp の書き忘れ・JS や CSS の commit 忘れ）`);
    for (const m of html.matchAll(/"\/r\/([^/"]+)\/([^"]+)"/g)) {
      if (m[1] !== token) problems.push(`${page}：違う版の住所 ${m[0]}（今の版は ${token}）`);
      if (src.read(m[2]) === null) problems.push(`${page}：無いファイル ${m[2]}（git への入れ忘れ）`);
    }
  }
  // import の先が全部ある（入れ忘れた新しいファイルを import していないか）
  for (const n of names.filter((x) => x.endsWith(".js"))) {
    for (const dep of importsOf(src.read(n))) if (src.read(dep) === null) problems.push(`${n} が import する ${dep} が無い（git への入れ忘れ）`);
  }
  const vtext = src.read("vercel.json");
  if (vtext === null) {
    problems.push("vercel.json が無い");
    return { token, problems };
  }
  if (stampVercel(vtext, token, names) !== vtext) problems.push(`vercel.json：/r/ の版・名前が中身と合わない（今の版は ${token}）`);
  let v;
  try {
    v = JSON.parse(vtext);
  } catch (e) {
    problems.push(`vercel.json を読めない：${e.message}`);
    return { token, problems };
  }
  const want = versionedSource(token, names);
  const rw = (v.rewrites ?? []).filter((r) => r.source.startsWith("/r/"));
  if (rw.length !== 1 || rw[0].source !== want || rw[0].destination !== "/:file") problems.push("vercel.json：/r/ の rewrite は今の版の 1 つだけ（destination は /:file）");
  const cc = (r) => r.headers.find((h) => h.key === "Cache-Control")?.value;
  const hs = v.headers ?? [];
  const imm = hs.findIndex((r) => r.source === want && cc(r) === "public, max-age=31536000, immutable");
  const other = hs.findIndex((r) => r.source === "/r/(.*)" && cc(r) === "no-cache");
  if (imm < 0) problems.push("vercel.json：今の版の住所に 1 年・immutable の headers が無い");
  if (other < 0 || other > imm) problems.push("vercel.json：/r/(.*) の no-cache が、今の版の immutable より前に無い");
  if (hs.some((r, i) => i !== imm && r.source.startsWith("/r/") && /immutable/.test(cc(r) ?? ""))) problems.push("vercel.json：今の版のほかの /r/ に immutable を付けている");
  return { token, problems };
}

/** stamp：git に入れる中身（index）から版を作り、作業の木の 4 つの画面と vercel.json を書き直す */
export function stamp(root) {
  const disk = diskReader(root);
  const idx = gitReader(root, ":");
  const tracked = new Set(idx.names());
  const refuse = [];
  for (const n of assetNamesOf(disk.names())) {
    if (!tracked.has(n)) refuse.push(`${n} が git に入っていない（git add してから）`);
    else if (lf(disk.read(n)) !== lf(idx.read(n))) refuse.push(`${n} に git add していない変更がある（git add してから）`);
  }
  for (const n of assetNamesOf([...tracked])) if (disk.read(n) === null) refuse.push(`${n} が作業の木に無い（消したなら git rm してから）`);
  if (refuse.length) return { token: null, changed: [], refuse };
  const names = assetNamesOf([...tracked]);
  const token = tokenOf(names, idx.read);
  const changed = [];
  for (const page of PAGES) {
    const f = path.join(root, page);
    const before = fs.readFileSync(f, "utf8");
    const after = stampHtml(before, token, names, idx.read);
    if (after !== before) {
      fs.writeFileSync(f, after);
      changed.push(page);
    }
  }
  const vf = path.join(root, "vercel.json");
  const vb = fs.readFileSync(vf, "utf8");
  const va = stampVercel(vb, token, names);
  if (va !== vb) {
    fs.writeFileSync(vf, va);
    changed.push("vercel.json");
  }
  return { token, changed, refuse: [] };
}

/** check：公開の前。HEAD の中身で確かめ、版に関わるファイル（直下の JS・CSS・4 つの画面・vercel.json）に未 commit の変更が無いことも確かめる */
export function check(root) {
  const problems = [];
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]).split("\0").filter(Boolean);
  for (const line of status) {
    const name = line.slice(3);
    if (PAGES.includes(name) || (!name.includes("/") && (ASSET_RE.test(name) || name === "vercel.json"))) problems.push(`${name}：commit していない変更・git に入っていないファイル（${line.slice(0, 2).trim()}）`);
  }
  const r = verify(gitReader(root, "HEAD"));
  return { token: r.token, problems: [...problems, ...r.problems] };
}

// 直接実行されたときだけ動く（試験が import したときは動かない）。リンク・ジャンクション越しでも見分けられるよう、実際の住所で比べる
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2];
  const root = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  if (cmd === "stamp") {
    const r = stamp(root);
    if (r.refuse.length) {
      console.error(`版を書けません：\n- ${r.refuse.join("\n- ")}`);
      process.exit(1);
    }
    console.log(`版 ${r.token}：${r.changed.length ? `書き直した ${r.changed.join(", ")}` : "書き直しなし（最新）"}`);
  } else if (cmd === "check" || cmd === "check-build") {
    const r = cmd === "check" ? check(root) : verify(diskReader(root));
    if (r.problems.length) {
      console.error(`版の確かめ（${cmd}）に失敗：\n- ${r.problems.join("\n- ")}\n直し方：auth-page の直下で git add → node tools/asset-versions.mjs stamp → 全部を commit`);
      process.exit(1);
    }
    console.log(`版 ${r.token}：${cmd} OK`);
  } else {
    console.error("使い方: node tools/asset-versions.mjs stamp|check|check-build [auth-page のパス]");
    process.exit(2);
  }
}
