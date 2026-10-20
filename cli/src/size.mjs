/**
 * 尺寸解析：
 *   --size 1024x1024 | 1536x1024 | 1k | 2k | 4k
 *   --ratio 16:9 --res 2k     （按比例以 res 为基准面积换算）
 * 输出统一规整为 16 的整数倍，并夹取到 [512, 4096]。
 */
const RES_BASE = { '1k': 1024, '2k': 2048, '4k': 3840 };

const round16 = (n) => Math.max(16, Math.round(n / 16) * 16);
const clamp = (n) => Math.min(4096, Math.max(512, n));

export function resolveSize({ size, ratio, res } = {}) {
  const warn = [];

  let base = null;
  if (res) {
    base = RES_BASE[String(res).toLowerCase()];
    if (!base) throw new Error(`--res 只支持 1k / 2k / 4k，收到：${res}`);
  }

  if (ratio) {
    const m = String(ratio).match(/^(\d+(?:\.\d+)?)[:：x/](\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`--ratio 格式应为 16:9 / 3:2 / 1:1，收到：${ratio}`);
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!a || !b) throw new Error(`--ratio 不能包含 0：${ratio}`);
    const areaBase = base || 2048;
    const w = round16(clamp(areaBase * Math.sqrt(a / b)));
    const h = round16(clamp(areaBase * Math.sqrt(b / a)));
    if (w >= 4096 || h >= 4096) warn.push('像素尺寸已触及 4096 上限，服务端可能自动调整');
    return { size: `${w}x${h}`, warn };
  }

  if (!size) return { size: '1024x1024', warn };

  const raw = String(size).trim().toLowerCase();
  if (RES_BASE[raw]) {
    const n = RES_BASE[raw];
    return { size: `${n}x${n}`, warn };
  }

  const m = raw.match(/^(\d+)\s*[x×*]\s*(\d+)$/);
  if (!m) throw new Error(`--size 格式应为 1024x1024，收到：${size}`);
  const w = round16(clamp(Number(m[1])));
  const h = round16(clamp(Number(m[2])));
  if (String(w) !== m[1] || String(h) !== m[2]) {
    warn.push(`尺寸已规整为 16 的倍数并限制在 512~4096：${w}x${h}`);
  }
  return { size: `${w}x${h}`, warn };
}
