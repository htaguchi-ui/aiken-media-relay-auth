// 管理コンソールの Storage 表示。実測が不明な容量を 0 として隠さない。
const integer = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const validDate = (s) => s === null || (typeof s === "string" && Number.isFinite(Date.parse(s)));
const countText = (n) => n.toLocaleString("ja-JP");

/** GB は 10^9 バイト。0 より大きい微小なファイルも 0.000 GB と表示しない。 */
export function formatStorageBytes(bytes) {
  if (!integer(bytes)) return "不明";
  if (bytes > 0 && bytes < 1_000_000) return "0.001 GB 未満";
  return `${(bytes / 1_000_000_000).toLocaleString("ja-JP", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} GB`;
}

function validCount(row) {
  return row && integer(row.object_count) && integer(row.bytes) && integer(row.unknown_size_count) && row.unknown_size_count <= row.object_count;
}

function capacityText(row) {
  const known = formatStorageBytes(row.bytes);
  return row.unknown_size_count ? `${known} ＋ 容量不明 ${countText(row.unknown_size_count)} 件` : known;
}

/** API 未導入・不正な応答を空の集計にしない。描画側は返された文を textContent でのみ扱う。 */
export function storageUsageView(value, dateText = (s) => s) {
  if (!value || !Array.isArray(value.buckets) || !validCount(value.total)) return null;
  const ids = new Set();
  for (const row of value.buckets) {
    if (!validCount(row) || typeof row.bucket_id !== "string" || !row.bucket_id || ids.has(row.bucket_id)) return null;
    ids.add(row.bucket_id);
  }
  for (const key of ["object_count", "bytes", "unknown_size_count"]) {
    const sum = value.buckets.reduce((n, row) => n + row[key], 0);
    if (!Number.isSafeInteger(sum) || value.total[key] !== sum) return null;
  }
  const r = value.retention;
  if (!r || !integer(r.days) || r.days < 1 || !integer(r.pending_students) || !validDate(r.earliest_purge_at)) return null;
  const c = value.last_cleanup;
  if (c !== null && (!c || !validDate(c.started_at) || c.started_at === null || !validDate(c.finished_at) || typeof c.dry_run !== "boolean" || ![c.deleted_objects, c.purged_students, c.failed_objects, c.skipped_busy, c.errors].every(integer))) return null;
  const labels = {
    outputs: "生成物（outputs）",
    inputs: "取り込んだ素材（inputs）",
    "uploads-staging": "アップロード中（uploads-staging）",
    "template-assets": "共通テンプレート（template-assets）",
  };
  return {
    buckets: value.buckets.map((row) => ({ label: Object.hasOwn(labels, row.bucket_id) ? labels[row.bucket_id] : row.bucket_id, count: `${countText(row.object_count)} 件`, capacity: capacityText(row) })),
    total: `合計 ${countText(value.total.object_count)} 件 · ${capacityText(value.total)}`,
    retention: `利用できなくなってから削除までの日数：${countText(r.days)} 日`,
    pending: `削除予定の受講者：${countText(r.pending_students)} 人`,
    earliest: r.earliest_purge_at ? `一番早い削除予定：${dateText(r.earliest_purge_at)}` : "削除予定日はありません。",
    cleanup: c ? [
      `${c.dry_run ? "最後の試しの実行" : "最後の掃除"}：${dateText(c.started_at)}${c.finished_at === null ? "（実行中）" : `（終了 ${dateText(c.finished_at)}）`}`,
      `${c.dry_run ? "試しの実行。ファイルは削除していません。" : `削除したファイル ${countText(c.deleted_objects)} 件・Canvas などの内容を削除したアカウント ${countText(c.purged_students)} 件。`} 削除失敗 ${countText(c.failed_objects)} 件。`,
      `生成中・状態確認待ちで保留 ${countText(c.skipped_busy)} 人 · エラー ${countText(c.errors)} 件。`,
    ] : ["掃除の実行記録はまだありません。"],
  };
}
