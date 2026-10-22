#!/usr/bin/env node
/**
 * 批次跑批：读 batch.csv → 逐张出图 → 按规范命名落盘 → 记流水。
 *
 * 用法：
 *   node src/batch/run.mjs batches/jdb-20261019 --dry-run
 *   node src/batch/run.mjs batches/jdb-20261019 --limit 2 --concurrency 2
 *   node src/batch/run.mjs batches/jdb-20261019 --concurrency 15
 *
 * 每张图单独发一次请求（n=1），失败只影响那一张，且便于逐张算相似度。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { generate, respond, extractImages, fetchToBuffer } from '../client.mjs';

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let cur = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuote = false;
      } else field += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field); field = ''; rows.push(cur); cur = []; }
    else if (c !== '\r') field += c;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim());
}

export function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '').slice(0, 24) || 'untitled';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function targetOf(batchDir, row, idx) {
  const seq = pad(row.seq);
  const dirName = `s${seq}_${clean(row.main_title || row.scene)}`;
  const fileName = `${clean(row.product)}_s${seq}_${pad(idx)}_${row.size || 'auto'}.png`;
  const abs = path.join(batchDir, 'images', clean(row.product), dirName, fileName);
  return { abs, rel: path.relative(batchDir, abs).split(path.sep).join('/') };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const k = cursor++;
      if (k >= items.length) return;
      out[k] = await worker(items[k], k);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 把本轮批次写进 GPT Image Playground 客户端的 data.db。
 * 走 python 脚本（sqlite3 + PIL 都在标准环境里），失败只告警，不影响出图结果。
 */
function pushToClientDb(batchDir) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const script = path.join(root, 'tools', 'push_to_client.py');
  if (!fs.existsSync(script)) return { ok: false, error: '找不到 tools/push_to_client.py' };
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  let lastErr = '';
  for (const bin of candidates) {
    const r = spawnSync(bin, [script, '--batch', batchDir, '--json'], { encoding: 'utf8', timeout: 300000 });
    if (r.error) { lastErr = r.error.message; continue; }
    try {
      return JSON.parse(r.stdout);
    } catch {
      lastErr = (r.stderr || r.stdout || '').trim().slice(0, 200) || '输出无法解析';
    }
  }
  return { ok: false, error: lastErr };
}

export async function runBatch(batchDir, opts = {}) {
  const csvPath = path.join(batchDir, 'batch.csv');
  if (!fs.existsSync(csvPath)) throw new Error(`找不到批次表：${csvPath}`);
  const rows = csvToObjects(fs.readFileSync(csvPath, 'utf8'));
  if (!rows.length) throw new Error('批次表没有数据行');

  const cfg = loadConfig({ cwd: opts.cwd || process.cwd() });
  const quality = opts.quality || cfg.quality;

  const tasks = [];
  for (const row of rows) {
    const n = Math.max(1, Number(row.count) || 1);
    for (let i = 1; i <= n; i++) tasks.push({ row, idx: i });
  }
  const limited = opts.limit ? tasks.slice(0, opts.limit) : tasks;

  if (opts.dryRun) {
    const t = limited[0];
    const r = await generate(cfg, {
      prompt: t.row.prompt, n: 1, size: t.row.size, quality, dryRun: true, apiMode: cfg.apiMode
    });
    return {
      dryRun: true,
      totalTasks: limited.length,
      rows: rows.length,
      model: cfg.model,
      endpoint: r.url,
      payloadPreview: { ...r.payload, prompt: `${String(r.payload.prompt).slice(0, 60)}…` },
      firstTarget: targetOf(batchDir, t.row, t.idx).rel
    };
  }

  const started = Date.now();
  const results = await pool(limited, opts.concurrency || 4, async (t, k) => {
    const { row, idx } = t;
    const target = targetOf(batchDir, row, idx);
    const t0 = Date.now();
    const base = {
      seq: Number(row.seq), idx, product: row.product,
      main_title: row.main_title, tags: [row.tag1, row.tag2, row.tag3].filter(Boolean),
      prompt: row.prompt, size: row.size, rel: target.rel
    };
    try {
      const fn = cfg.apiMode === 'responses' ? respond : generate;
      const resp = await fn(cfg, {
        prompt: row.prompt, n: 1, size: row.size, quality,
        timeoutMs: opts.timeoutMs || 300000
      });
      const imgs = extractImages(resp.json).slice(0, 1);
      if (!imgs.length) throw new Error('响应里没有图片（可能被内容审核拦截）');
      const buf = imgs[0].b64 ? Buffer.from(imgs[0].b64, 'base64') : await fetchToBuffer(imgs[0].url);
      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, buf);
      process.stderr.write(`  ✔ [${k + 1}/${limited.length}] ${target.rel}  ${Math.round((Date.now() - t0) / 1000)}s\n`);
      return {
        ...base, status: 'ok', bytes: buf.length, sha256: sha256(buf),
        elapsed: Date.now() - t0, model: cfg.model, quality,
        url: imgs[0].url || null, error: null
      };
    } catch (e) {
      process.stderr.write(`  ✘ [${k + 1}/${limited.length}] s${row.seq}-${idx}  ${e.message}\n`);
      return { ...base, status: 'failed', bytes: 0, sha256: null, elapsed: Date.now() - t0, error: e.message };
    }
  });

  const ok = results.filter((r) => r.status === 'ok');
  const dupes = new Set();
  const seen = new Map();
  for (const r of ok) {
    if (seen.has(r.sha256)) dupes.add(r.sha256); else seen.set(r.sha256, r.rel);
  }

  fs.writeFileSync(path.join(batchDir, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const head = ['seq', 'idx', 'product', 'status', 'main_title', 'tags', 'file', 'bytes', 'elapsed_ms', 'sha256_8', 'note'];
  const lines = [head.join(',')];
  for (const r of results) {
    lines.push([
      r.seq, r.idx, r.product, r.status, r.main_title, (r.tags || []).join(' / '),
      r.rel, r.bytes, r.elapsed, r.sha256 ? r.sha256.slice(0, 8) : '',
      r.error || (r.sha256 && dupes.has(r.sha256) ? '与其他图字节完全相同' : '')
    ].map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  fs.writeFileSync(path.join(batchDir, 'report.csv'), '\ufeff' + lines.join('\n') + '\n', 'utf8');

  // 出完图直接写进客户端库，两个入口共用一本账；失败不影响本轮结果
  const dbResult = opts.skipDb ? null : pushToClientDb(batchDir);

  return {
    batchDir, total: results.length, ok: ok.length,
    failed: results.length - ok.length,
    byteDupes: dupes.size,
    seconds: Math.round((Date.now() - started) / 1000),
    dbResult,
    results
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) {
    console.error('用法: node src/batch/run.mjs <批次目录> [--dry-run] [--limit N] [--concurrency N] [--quality high] [--no-db]');
    process.exit(1);
  }
  const arg = (name, dft) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dft;
  };
  const flag = (name) => argv.includes(`--${name}`);

  runBatch(path.resolve(dir), {
    dryRun: flag('dry-run'),
    limit: Number(arg('limit', 0)) || 0,
    concurrency: Number(arg('concurrency', 4)),
    quality: arg('quality', null),
    skipDb: flag('no-db')
  }).then((r) => {
    if (r.dryRun) {
      console.log('— 试运行（不花钱、不落盘）—');
      console.log(`模型   : ${r.model}`);
      console.log(`接口   : ${r.endpoint}`);
      console.log(`表格   : ${r.rows} 行 → 展开 ${r.totalTasks} 张`);
      console.log(`请求体 : ${JSON.stringify(r.payloadPreview, null, 2)}`);
      console.log(`首张去向: ${r.firstTarget}`);
      return;
    }
    console.log('');
    console.log(`✔ 批次完成：成功 ${r.ok} / 共 ${r.total}，失败 ${r.failed}，耗时 ${r.seconds}s`);
    if (r.byteDupes) console.log(`⚠ 有 ${r.byteDupes} 组图片字节完全相同（疑似重复出图）`);
    console.log(`  明细：${path.join(r.batchDir, 'report.csv')}`);
    if (r.dbResult) {
      if (r.dbResult.ok) {
        console.log(`  客户端库：写入 ${r.dbResult.importedTasks} 个任务（已存在跳过 ${r.dbResult.skipped}）`);
      } else {
        console.log(`  ⚠ 客户端库写入失败：${r.dbResult.error}`);
      }
    }
  }).catch((e) => {
    console.error('✘', e.message);
    process.exit(1);
  });
}
