/** 从其他产品导入提示词库时的命名：重名就带上来源产品，再不行补序号 */
export function uniqueImportName(
  existing: Iterable<string>,
  preferred: string,
  sourceProductName = '',
): string {
  const taken = new Set(existing)
  const base = preferred.trim() || '未命名'
  if (!taken.has(base)) return base
  const withSource = sourceProductName ? `${base}（${sourceProductName}）` : base
  if (!taken.has(withSource)) return withSource
  let seq = 2
  while (taken.has(`${withSource} ${seq}`)) seq += 1
  return `${withSource} ${seq}`
}
