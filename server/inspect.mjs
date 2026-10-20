/**
 * 图片检查：把「质检」和「重复度」合成一次调用。
 * 质检走视觉大模型（cli/src/batch/qc.mjs），重复度走 Python + CLIP（cli/tools/clip_similarity.py）。
 * 两者都要落盘临时文件才能跑，所以必须在这个 Node 侧完成，浏览器做不到。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 必须动态加载：静态 import 会让 esbuild 在打包 vite.config.ts 时把 qc.mjs 一起打进去，
// 而它带 shebang（#!/usr/bin/env node），拼进 bundle 会直接语法报错，dev server 起不来
let qcImageFn = null;
async function getQcImage() {
  if (!qcImageFn) {
    const mod = await import(new URL('../cli/src/batch/qc.mjs', import.meta.url).href);
    qcImageFn = mod.qcImage;
  }
  return qcImageFn;
}
/** cli 目录：python 脚本和批次数据都在它下面 */
export const CLI_ROOT = path.resolve(__dirname, '..', 'cli');
const CLIP_PY = path.join(CLI_ROOT, 'tools', 'clip_similarity.py');

/** 判定为「重复」的相似度门槛，与批次侧保持一致 */
export const DEFAULT_LIMIT = 0.92;
/** 一次最多送多少张去算，太多会很慢 */
const MAX_IMAGES = 36;

function extOf(dataUrl) {
  const mime = String(dataUrl).match(/^data:([^;]+);base64,/)?.[1] || '';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function writeImagesToTempDir(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-'));
  const written = [];
  items.forEach((item, index) => {
    const m = String(item?.dataUrl || '').match(/^data:[^;]+;base64,(.+)$/);
    if (!m) return;
    const name = `${index}${extOf(item.dataUrl)}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(m[1], 'base64'));
    written.push({ index, name, id: item.id ?? String(index) });
  });
  return { dir, written };
}

function runClip(dir, limit) {
  const r = spawnSync('python', [CLIP_PY, dir, '--json', '--hi', String(limit)], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || 'CLIP 运行失败').slice(-500) };
  }
  try {
    return { ok: true, ...JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, error: `CLIP 输出解析失败：${e.message}` };
  }
}

async function runQcOne(file, expect) {
  try {
    const qcImage = await getQcImage();
    const q = await qcImage(file, expect || null, {});
    const result = q.result || {};
    const verdict = ['pass', 'fail', 'unsure'].includes(result.verdict) ? result.verdict : 'unsure';
    return {
      ok: Boolean(q.ok),
      verdict,
      reason: String(result.reason || ''),
      confidence: typeof result.confidence === 'number' ? result.confidence : null,
      elapsedMs: q.elapsedMs ?? null,
    };
  } catch (e) {
    return { ok: false, verdict: 'unsure', reason: e.message || '质检失败', confidence: null };
  }
}

/**
 * 一次跑完质检与重复度。
 * @param {Array<{id?: string, dataUrl: string}>} items 待检查的图（data URL）
 * @param {{expect?: object, limit?: number, qc?: boolean, sim?: boolean}} options
 */
export async function inspect(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_IMAGES);
  const startedAt = Date.now();
  const doQc = options.qc !== false;
  const doSim = options.sim !== false;
  const limit = Number(options.limit) || DEFAULT_LIMIT;

  if (!list.length) return { ok: false, error: '没有图片' };

  const { dir, written } = writeImagesToTempDir(list);
  const out = {
    ok: true,
    limit,
    qc: {},
    similarity: { perImage: {}, stats: null, model: null },
    errors: [],
    elapsedMs: 0,
  };

  try {
    // 重复度：一次 python 调用算完全部两两相似度
    if (doSim && written.length >= 2) {
      const clip = runClip(dir, limit);
      if (!clip.ok) {
        out.errors.push(clip.error);
        out.similarity.ok = false;
      } else {
        out.similarity.ok = true;
        out.similarity.model = clip.model || null;
        out.similarity.stats = clip.stats || null;
        for (const row of clip.per_image || []) {
          const index = Number(String(row.file).replace(/\.[a-z]+$/i, ''));
          if (!Number.isFinite(index)) continue;
          const id = written.find((w) => w.index === index)?.id ?? String(index);
          out.similarity.perImage[id] = { mean: row.mean, max: row.max, nearest: row.nearest ?? null };
        }
      }
    } else if (doSim) {
      out.similarity.ok = false;
      out.errors.push('至少需要两张图才能算重复度');
    }

    // 质检：逐张送视觉模型，并发 3 张，避免把接口打满
    if (doQc) {
      const files = written.map((w) => ({ id: w.id, file: path.join(dir, w.name) }));
      const cursor = { i: 0 };
      const worker = async () => {
        for (;;) {
          const i = cursor.i++;
          if (i >= files.length) return;
          const { id, file } = files[i];
          out.qc[id] = await runQcOne(file, options.expect);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  out.elapsedMs = Date.now() - startedAt;
  return out;
}

/** 读请求体 JSON，失败返回空对象 */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

export function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
