/**
 * 消耗金额的展示格式。
 *
 * 报表里的消耗动辄五位数，带两位小数满屏 `.47 / .99`，反而看不清量级；
 * 真正需要精度的只有几毛钱的零星流水。规则：
 * - 绝对值 ≥ 1：四舍五入到整元，带千分位；
 * - 0 < 绝对值 < 1：保留两位小数（否则一个 0.4 元的测试流水会显示成 0）；
 * - 正好 0 / 非数值：`0`。
 */
export function formatSpend(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs > 0 && abs < 1) {
    return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return Math.round(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}
