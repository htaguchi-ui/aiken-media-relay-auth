// canvas-app/src/submit/tus.ts の写し。直すときは両方（kumi11-mypage-upload.md 2.8・6.3）。動きは 1 つも変えていない（型の注釈を外しただけ）。
// 試験は scripts/tus_lib_test.mjs（canvas-app/src/submit/tus.test.ts の写し）。
//
// 再開できる送り方（TUS 1.0.0）の最小の部品。Supabase Storage の署名つき TUS（docs/design-submissions.md 2.4）を、サーバーが発行した
// token で使う。パッケージは足さず、手で書く（作る・6 MiB ずつ送る・位置を取り直す・消す）。
// 段 0 の本番の確かめ（10/23・10/24）で動いた順序と同じ：POST（作る）→ PATCH（6 MiB の塊。Upload-Offset）→ 切れたら HEAD で位置を取り直す。
// 署名つきの口は `…/upload/resumable/sign`。token は x-signature に、公開用のキーは apikey に付ける。

/** Supabase の TUS は 6 MiB の塊を求める（最後の塊だけ小さくてよい） */
export const TUS_CHUNK = 6 * 1024 * 1024;
const TUS_VERSION = "1.0.0";
/** 通信が切れたとき、位置を取り直して続ける回数 */
const NET_RETRIES = 3;

/**
 * kind：
 *   network（通信できなかった。位置を取り直しても続けられなかった）・aborted（画面から止めた）・
 *   token_expired（400・401・403。token の期限の 2 時間を過ぎた。段 0：期限のあとは PATCH も HEAD も 400）・
 *   conflict（409。同じパスにすでに実体がある）・too_large（413）・bad_type（415）・http（ほか。404 など）
 */
export class TusError extends Error {
  constructor(kind, status, message) {
    super(message ?? `TUS ${kind} (${status})`);
    this.name = "TusError";
    this.kind = kind;
    this.status = status;
  }
}

export function tusErrorFromStatus(status) {
  if (status === 409) return new TusError("conflict", status);
  if (status === 413) return new TusError("too_large", status);
  if (status === 415) return new TusError("bad_type", status);
  if (status === 400 || status === 401 || status === 403) return new TusError("token_expired", status);
  return new TusError("http", status);
}

/**
 * 既定の通信（XMLHttpRequest。fetch は送った量を取れないので使わない）。
 * req：{ method, url, headers, body?, onProgress?(loaded), signal? } → { status, headers（名前は小文字） }。
 * 通信の失敗は TusError('network')、止めたら TusError('aborted') を投げる。HTTP の状態の番号は成否にかかわらず返す
 */
export const xhrTransport = (req) =>
  new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new TusError("aborted", 0));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url);
    for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v);
    if (req.onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && req.onProgress?.(e.loaded);
    const onAbort = () => xhr.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => req.signal?.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      done();
      const headers = {};
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: xhr.status, headers });
    };
    xhr.onerror = () => {
      done();
      reject(new TusError("network", 0));
    };
    xhr.onabort = () => {
      done();
      reject(new TusError("aborted", 0));
    };
    xhr.send(req.body ?? null);
  });

function b64(s) {
  // Upload-Metadata の値は base64（日本語は入れない設計だが、UTF-8 で安全に変換する）
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** a：{ endpoint, token, apiKey（公開用のキー。秘密鍵ではない）, transport? } */
function signedHeaders(a) {
  return { "Tus-Resumable": TUS_VERSION, apikey: a.apiKey, "x-signature": a.token };
}

/** 相対の Location を、作る口の絶対の URL にそろえる */
function resolveLocation(loc, endpoint) {
  try {
    return new URL(loc, endpoint).toString();
  } catch {
    return loc;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 作る → 6 MiB ずつ送る。成功したらその TUS の URL を返す。失敗は TusError。
 * a：{ endpoint, token, apiKey, transport?, blob, bucket, objectName, contentType,
 *      onProgress?(sent, total)（送り出した合計 0〜blob.size）, onCreated?(uploadUrl)（［やめる］で DELETE を送るために画面が控える）,
 *      signal?, chunkSize?, retryWaitMs?（位置を取り直す前の待ち。試験では 0 にする） }
 */
export async function tusUpload(a) {
  const send = a.transport ?? xhrTransport;
  const total = a.blob.size;
  const chunk = a.chunkSize ?? TUS_CHUNK;
  const meta = [
    ["bucketName", a.bucket],
    ["objectName", a.objectName],
    ["contentType", a.contentType],
    ["cacheControl", "3600"],
  ]
    .map(([k, v]) => `${k} ${b64(v)}`)
    .join(",");
  const created = await send({
    method: "POST",
    url: a.endpoint,
    headers: { ...signedHeaders(a), "Upload-Length": String(total), "Upload-Metadata": meta },
    signal: a.signal,
  });
  if (created.status !== 201) throw tusErrorFromStatus(created.status);
  const loc = created.headers["location"];
  if (!loc) throw new TusError("http", created.status, "TUS の作成の応答に Location がありません");
  const url = resolveLocation(loc, a.endpoint);
  a.onCreated?.(url);
  let offset = 0;
  let netFails = 0;
  a.onProgress?.(0, total);
  while (offset < total) {
    if (a.signal?.aborted) throw new TusError("aborted", 0);
    const end = Math.min(offset + chunk, total);
    try {
      const r = await send({
        method: "PATCH",
        url,
        headers: { ...signedHeaders(a), "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
        body: a.blob.slice(offset, end),
        onProgress: (loaded) => a.onProgress?.(Math.min(total, offset + loaded), total),
        signal: a.signal,
      });
      if (r.status !== 204) throw tusErrorFromStatus(r.status);
      const next = Number(r.headers["upload-offset"]);
      // サーバーの続きの位置は 6 MiB の倍数とは限らない（段 0）。返ってきた位置から続ける
      if (!Number.isSafeInteger(next) || next < offset || next > total) throw new TusError("http", r.status, "Upload-Offset が正しくありません");
      offset = next;
      netFails = 0;
      a.onProgress?.(offset, total);
    } catch (e) {
      if (!(e instanceof TusError) || e.kind !== "network") throw e;
      // 通信が切れた：HEAD で届いた位置を取り直して続ける（PATCH は同じ塊をそのまま送り直さない。届いた分があり得る）
      if (++netFails > NET_RETRIES) throw e;
      await sleep(a.retryWaitMs ?? 2000);
      if (a.signal?.aborted) throw new TusError("aborted", 0);
      const h = await send({ method: "HEAD", url, headers: signedHeaders(a), signal: a.signal }).catch((he) => {
        if (he instanceof TusError && he.kind === "network") return null;
        throw he;
      });
      if (!h) continue;
      if (h.status !== 200) throw tusErrorFromStatus(h.status);
      const pos = Number(h.headers["upload-offset"]);
      if (!Number.isSafeInteger(pos) || pos < 0 || pos > total) throw new TusError("http", h.status, "Upload-Offset が正しくありません");
      offset = pos;
    }
  }
  return url;
}

/**
 * 送っている途中の TUS の送信を止める（［やめる］。main の決定 10-24）。成功・もう無い（204・404・410）なら true。
 * 失敗しても投げない（［やめる］は先へ進める。サーバーの cancel は必ず呼ぶ）。
 * 署名なしの口への送り直し（下の 2 回目）は、本番のゲートウェイが署名つきの DELETE だけを断る場合の保険として 1 回だけ残す（tus.ts と同じ）。
 */
export async function tusDelete(a, uploadUrl) {
  const send = a.transport ?? xhrTransport;
  const ok = (s) => s === 204 || s === 404 || s === 410;
  const targets = [uploadUrl];
  if (uploadUrl.includes("/upload/resumable/sign/")) targets.push(uploadUrl.replace("/upload/resumable/sign/", "/upload/resumable/"));
  for (const url of targets) {
    try {
      const r = await send({ method: "DELETE", url, headers: signedHeaders(a) });
      if (ok(r.status)) return true;
      if (![400, 401, 403, 405].includes(r.status)) return false;
    } catch {
      return false;
    }
  }
  return false;
}
