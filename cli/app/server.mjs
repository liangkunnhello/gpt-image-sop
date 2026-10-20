#!/usr/bin/env node
/**
 * 本地 Web 控制台（测试版）
 *   - 批次列表 / 批次详情 / 一键跑批 / 一键质检 / 一键算相似度
 *   - 图库直接读 GPT Image Playground 客户端的 data.db（只读，共用同一数据源）
 *   - 一键启动：双击 启动.bat；一键停止：界面右上角"停止服务"或 停止.bat
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { csvToObjects } from '../src/batch/run.mjs';
import { qcImage } from '../src/batch/qc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const BAT = path.join(ROOT, 'batches');
const PORT = Number(process.env.PORT || 7799);
const CLIENT_DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GPT Image Playground', 'data');
const CLIENT_DB = path.join(CLIENT_DATA, 'data.db');
const HI = 0.92;

const readJsonl = (p) => {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
};
const writeJsonl = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const readCsv = (p) => (fs.existsSync(p) ? csvToObjects(fs.readFileSync(p, 'utf8')) : []);
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

let job = null;

function pushLog(j, chunk) {
  const text = String(chunk).replace(/\r/g, '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    j.log.push(line);
    if (j.log.length > 400) j.log.shift();
  }
}

function startProcJob(kind, cmd, args, onDone) {
  if (job && job.status === 'running') throw new Error('已有任务在跑，等它结束再开新的');
  const j = { id: crypto.randomUUID().slice(0, 8), kind, status: 'running', log: [], startedAt: Date.now() };
  job = j;
  const proc = spawn(cmd, args, { cwd: ROOT, env: process.env, windowsHide: true });
  proc.stdout.on('data', (d) => pushLog(j, d));
  proc.stderr.on('data', (d) => pushLog(j, d));
  proc.on('error', (e) => { pushLog(j, `✘ 启动失败：${e.message}`); j.status = 'failed'; });
  proc.on('close', async (code) => {
    j.exitCode = code;
    j.endedAt = Date.now();
    try { if (onDone) await onDone(j); } catch (e) { pushLog(j, `✘ 收尾失败：${e.message}`); }
    j.status = code === 0 ? 'done' : 'failed';
    if (job === j) job = j;
  });
  return j;
}

function startInlineJob(kind, runner) {
  if (job && job.status === 'running') throw new Error('已有任务在跑，等它结束再开新的');
  const j = { id: crypto.randomUUID().slice(0, 8), kind, status: 'running', log: [], startedAt: Date.now() };
  job = j;
  (async () => {
    try {
      await runner(j);
      j.status = 'done';
    } catch (e) {
      pushLog(j, `✘ ${e.message}`);
      j.status = 'failed';
    } finally {
      j.endedAt = Date.now();
    }
  })();
  return j;
}

function listBatches() {
  if (!fs.existsSync(BAT)) return [];
  return fs.readdirSync(BAT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(BAT, d.name);
      const rows = readCsv(path.join(dir, 'batch.csv'));
      const results = readJsonl(path.join(dir, 'results.jsonl'));
      const qc = readJsonl(path.join(dir, 'qc.jsonl'));
      const simFile = path.join(dir, 'similarity.json');
      const ok = results.filter((r) => r.status === 'ok');
      return {
        id: d.name,
        rows: rows.length,
        generated: ok.length,
        failed: results.filter((r) => r.status === 'failed').length,
        checked: qc.length,
        hasSim: fs.existsSync(simFile),
        mtime: fs.statSync(dir).mtimeMs
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function loadBatch(id) {
  const dir = path.join(BAT, id);
  if (!fs.existsSync(dir)) throw new Error(`批次不存在：${id}`);
  const rows = readCsv(path.join(dir, 'batch.csv'));
  const results = readJsonl(path.join(dir, 'results.jsonl'));
  const qcRows = readJsonl(path.join(dir, 'qc.jsonl'));
  const simPath = path.join(dir, 'similarity.json');
  const sim = fs.existsSync(simPath) ? JSON.parse(fs.readFileSync(simPath, 'utf8')) : null;

  const bySeq = new Map();
  for (const r of results) bySeq.set(`${r.seq}-${r.idx}`, r);
  const qcByFile = new Map();
  for (const q of qcRows) qcByFile.set(q.file, q);

  const items = rows.map((row) => {
    const key = `${row.seq}-1`;
    const res = bySeq.get(key) || results.find((r) => Number(r.seq) === Number(row.seq)) || null;
    const file = res?.rel || null;
    const q = file ? qcByFile.get(file) : null;
    const simRow = sim?.per_image?.find((p) => p.file === (file ? path.basename(file) : ''));
    return {
      seq: Number(row.seq),
      product: row.product,
      main_title: row.main_title,
      tag1: row.tag1, tag2: row.tag2, tag3: row.tag3,
      brand: row.brand,
      layout: row.layout, scene: row.scene, tone: row.tone,
      size: row.size,
      file,
      status: res?.status || 'pending',
      error: res?.error || null,
      elapsed: res?.elapsed || 0,
      qc: q || null,
      sim: simRow ? { mean: simRow.mean, max: simRow.max, nearest: simRow.nearest } : null
    };
  });

  return {
    id,
    hi: HI,
    items,
    sim: sim ? {
      stats: sim.stats,
      over_list: sim.over_list,
      regen: sim.regen,
      pass_pairs: sim.pass_pairs,
      over_pairs: sim.over_pairs,
      count: sim.count
    } : null
  };
}

function batchDirOf(id) {
  const dir = path.resolve(BAT, id);
  if (!dir.startsWith(path.resolve(BAT) + path.sep)) throw new Error('非法批次');
  return dir;
}

function library() {
  if (!fs.existsSync(CLIENT_DB)) return { ok: false, error: `找不到客户端数据库：${CLIENT_DB}`, items: [] };
  try {
    const db = new DatabaseSync(CLIENT_DB, { readOnly: true });
    const rows = db.prepare('select id, data, updated_at from tasks order by updated_at desc limit 120').all();
    db.close();
    const items = rows.map((r) => {
      let d = {};
      try { d = JSON.parse(r.data); } catch {}
      const first = (d.outputImages || [])[0];
      return {
        id: r.id,
        prompt: String(d.prompt || '').slice(0, 120),
        status: d.status || '',
        model: d.apiModel || '',
        images: (d.outputImages || []).length,
        cover: first ? `images/${first.slice(0, 2)}/${first}.png` : null,
        createdAt: d.createdAt || r.updated_at
      };
    });
    return { ok: true, db: CLIENT_DB, total: items.length, items };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // 开发期允许 playground 的 5173 直接调
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (p === '/api/state') {
      return json(res, 200, { batches: listBatches(), job, port: PORT, root: ROOT });
    }

    if (p === '/api/batch') {
      return json(res, 200, loadBatch(url.searchParams.get('id')));
    }

    if (p === '/api/job') {
      const id = url.searchParams.get('id');
      if (id && job && job.id !== id) return json(res, 200, { job: null });
      return json(res, 200, { job });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.id;
      const dir = batchDirOf(id);
      const args = ['src/batch/run.mjs', dir, '--concurrency', String(body.concurrency || 4)];
      if (body.limit) args.push('--limit', String(body.limit));
      if (body.quality) args.push('--quality', body.quality);
      const j = startProcJob('跑批', process.execPath, args);
      return json(res, 200, { job: j });
    }

    if (p === '/api/qc' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.id;
      const dir = batchDirOf(id);
      const j = startInlineJob('质检', async (jj) => {
        const rows = readCsv(path.join(dir, 'batch.csv'));
        const results = readJsonl(path.join(dir, 'results.jsonl')).filter((r) => r.status === 'ok');
        if (!results.length) throw new Error('这批还没出图，先跑批');
        const qcPath = path.join(dir, 'qc.jsonl');
        const done = new Set(readJsonl(qcPath).map((q) => q.file));
        const todo = results.filter((r) => !done.has(r.rel));
        pushLog(jj, `待质检 ${todo.length} 张（已完成 ${done.size} 张跳过）`);
        const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 3, 6));
        const out = readJsonl(qcPath);
        let cursor = 0;
        let finished = 0;
        const worker = async () => {
          for (;;) {
            const i = cursor++;
            if (i >= todo.length) return;
            const r = todo[i];
            const row = rows.find((x) => Number(x.seq) === Number(r.seq)) || {};
            const expect = {
              mainTitle: row.main_title || '',
              tags: [row.tag1, row.tag2, row.tag3].filter(Boolean),
              brand: row.brand ? String(row.brand).split('/') : [],
              disclaimer: [row.disclaimer1, row.disclaimer2].filter(Boolean)
            };
            try {
              const q = await qcImage(path.join(dir, r.rel), expect, {});
              const rec = {
                seq: r.seq, file: r.rel,
                ok: q.ok,
                verdict: q.result?.verdict || 'error',
                violation: q.result?.violation || null,
                text: q.result?.text || null,
                overlap: q.result?.overlap || null,
                reason: q.result?.reason || '',
                confidence: q.result?.confidence ?? null,
                elapsedMs: q.elapsedMs
              };
              out.push(rec);
              writeJsonl(qcPath, out);
              finished++;
              const tag = rec.verdict === 'pass' ? '✔' : rec.verdict === 'fail' ? '✘' : '?';
              pushLog(jj, `${tag} [${finished}/${todo.length}] s${r.seq} ${rec.verdict} ${rec.reason.slice(0, 40)}`);
            } catch (e) {
              pushLog(jj, `✘ [${finished + 1}/${todo.length}] s${r.seq} ${e.message}`);
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        pushLog(jj, `质检结束：共 ${out.length} 条记录`);
      });
      return json(res, 200, { job: j });
    }

    if (p === '/api/sim' && req.method === 'POST') {
      const body = await readBody(req);
      const dir = batchDirOf(body.id);
      const imgRoot = path.join(dir, 'images');
      if (!fs.existsSync(imgRoot)) return json(res, 400, { error: '这批还没出图，先跑批' });
      const j = startInlineJob('相似度', async (jj) => {
        pushLog(jj, `计算 ${imgRoot} 下所有图的 CLIP 相似度（判定线 ${HI}）`);
        const r = spawnSync('python', [path.join(ROOT, 'tools', 'clip_similarity.py'), imgRoot, '--hi', String(HI), '--json'], { cwd: ROOT, encoding: 'utf8' });
        if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'python 执行失败').slice(0, 500));
        const parsed = JSON.parse(r.stdout);
        fs.writeFileSync(path.join(dir, 'similarity.json'), JSON.stringify(parsed, null, 2), 'utf8');
        pushLog(jj, `完成：${parsed.count} 张 / ${parsed.pairs_total} 对，超线 ${parsed.over_pairs} 对，建议重出 ${parsed.regen.length} 张`);
      });
      return json(res, 200, { job: j });
    }

    if (p === '/api/models' && req.method === 'POST') {
      const body = await readBody(req);
      const base = String(body.baseUrl || '').replace(/\/+$/, '');
      const key = String(body.apiKey || '');
      if (!base) return json(res, 400, { error: '缺少 baseUrl' });
      try {
        const upstream = await fetch(`${base}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(20000)
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(text);
      } catch (e) {
        return json(res, 502, { error: `拉取失败：${e.message}` });
      }
    }

    if (p === '/api/qc-image' && req.method === 'POST') {
      const body = await readBody(req);
      const m = String(body.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return json(res, 400, { error: '需要 data URL' });
      const ext = m[1].includes('png') ? '.png' : m[1].includes('webp') ? '.webp' : '.jpg';
      const tmp = path.join(os.tmpdir(), `qc-up-${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tmp, Buffer.from(m[2], 'base64'));
      try {
        const q = await qcImage(tmp, body.expect || null, {});
        return json(res, 200, {
          ok: q.ok,
          result: q.result,
          elapsedMs: q.elapsedMs,
          error: q.ok ? null : '模型没返回合法 JSON'
        });
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }

    if (p === '/api/sim-batch' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length < 2) return json(res, 400, { error: '至少需要两张图' });
      const tmpDir = path.join(os.tmpdir(), `sim-${crypto.randomUUID()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const nameMap = new Map();
      items.forEach((it, i) => {
        const m = String(it.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return;
        const ext = m[1].includes('png') ? '.png' : m[1].includes('webp') ? '.webp' : '.jpg';
        const name = `i${String(i).padStart(3, '0')}${ext}`;
        fs.writeFileSync(path.join(tmpDir, name), Buffer.from(m[2], 'base64'));
        nameMap.set(name, it.key || it.id || name);
      });
      const r = spawnSync('python', [path.join(ROOT, 'tools', 'clip_similarity.py'), tmpDir, '--hi', String(HI), '--json'], { cwd: ROOT, encoding: 'utf8' });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (r.status !== 0) return json(res, 500, { error: (r.stderr || r.stdout || 'python 执行失败').slice(0, 500) });
      const parsed = JSON.parse(r.stdout);
      for (const p of parsed.per_image || []) p.key = nameMap.get(p.file) || p.file;
      for (const p of parsed.per_image || []) p.nearestKey = nameMap.get(p.nearest) || p.nearest;
      for (const p of parsed.over_list || []) {
        p.aKey = nameMap.get(p.a) || p.a;
        p.bKey = nameMap.get(p.b) || p.b;
      }
      for (const p of parsed.regen || []) {
        p.regenKey = nameMap.get(p.regen) || p.regen;
        p.keepKey = nameMap.get(p.keep) || p.keep;
      }
      return json(res, 200, parsed);
    }

    if (p === '/api/library') {
      return json(res, 200, library());
    }

    if (p === '/api/save-task' && req.method === 'POST') {
      // 网页版每出一张图就顺手写一份到客户端 data.db，浏览器数据丢了也能找回
      const body = await readBody(req).catch(() => ({}));
      const m = String(body?.dataUrl || '').match(/^data:image\/(\w+);base64,(.*)$/);
      if (!m) return json(res, 400, { ok: false, error: 'dataUrl 无效' });
      const buf = Buffer.from(m[2], 'base64');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-task-'));
      try {
        fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
        const rel = `images/${sha}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
        fs.writeFileSync(path.join(dir, rel), buf);
        const row = {
          seq: 1,
          status: 'ok',
          rel,
          sha256: sha,
          product: String(body?.product || 'web'),
          main_title: String(body?.title || '').slice(0, 40),
          prompt: String(body?.prompt || ''),
          size: String(body?.size || 'auto'),
          model: String(body?.model || 'gpt-image-1'),
          quality: String(body?.quality || 'high'),
          elapsed: 0,
        };
        fs.writeFileSync(path.join(dir, 'results.jsonl'), `${JSON.stringify(row)}\n`);
        const r = spawnSync(
          'python',
          [path.join(ROOT, 'tools', 'push_to_client.py'), '--batch', dir, '--no-backup', '--json'],
          { cwd: ROOT, encoding: 'utf8', timeout: 60000 },
        );
        if (r.status !== 0) return json(res, 500, { ok: false, error: (r.stderr || r.stdout || '写入失败').slice(-300) });
        return json(res, 200, { ok: true, sha });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }

    if (p === '/api/clip-similar' && req.method === 'POST') {
      // 网页版把缩略图传过来，这里落到临时目录再跑 CLIP 算两两相似度
      const body = await readBody(req).catch(() => ({}));
      const items = Array.isArray(body?.items) ? body.items : [];
      if (items.length < 2) return json(res, 200, { ok: false, error: '至少需要两张图' });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-sim-'));
      try {
        items.forEach((item, index) => {
          const m = String(item?.dataUrl || '').match(/^data:image\/\w+;base64,(.*)$/);
          if (m) fs.writeFileSync(path.join(dir, `${index}.png`), Buffer.from(m[1], 'base64'));
        });
        const limit = Number(body?.limit) || 0.92;
        const r = spawnSync(
          'python',
          [path.join(ROOT, 'tools', 'clip_similarity.py'), dir, '--json', '--hi', String(limit)],
          { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 },
        );
        if (r.status !== 0) {
          return json(res, 500, { ok: false, error: (r.stderr || r.stdout || 'CLIP 运行失败').slice(-400) });
        }
        const parsed = JSON.parse(r.stdout);
        const perImage = {};
        for (const row of parsed.per_image || []) {
          const index = Number(String(row.file).replace(/\.[a-z]+$/i, ''));
          if (Number.isFinite(index)) perImage[index] = { mean: row.mean, max: row.max, nearest: row.nearest };
        }
        return json(res, 200, { ok: true, model: parsed.model, limit: parsed.limit, stats: parsed.stats, perImage });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }

    if (p === '/api/save-finished' && req.method === 'POST') {
      // 把后处理后的成品图落一份到 data/finished/<日期>/ 下
      const body = await readBody(req).catch(() => ({}));
      const dataUrl = String(body?.dataUrl || '');
      const name = String(body?.name || `finished-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
      const m = dataUrl.match(/^data:image\/(\w+);base64,(.*)$/);
      if (!m) return json(res, 400, { ok: false, error: 'dataUrl 无效' });
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(CLIENT_DATA, 'finished', day);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        return json(res, 200, { ok: true, path: file });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (p === '/api/open-dir' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      // 只允许打开客户端数据目录本身、它的 images 或 finished 子目录
      const target = body?.dir === 'images'
        ? path.join(CLIENT_DATA, 'images')
        : body?.dir === 'finished'
          ? path.join(CLIENT_DATA, 'finished')
          : CLIENT_DATA;
      try {
        fs.mkdirSync(target, { recursive: true });
        const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, path: target });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message, path: target });
      }
    }

    if (p === '/api/stop' && req.method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (p === '/img') {
      const rel = url.searchParams.get('p') || '';
      const id = url.searchParams.get('id') || '';
      const abs = path.resolve(path.join(BAT, id), rel);
      const base = path.resolve(path.join(BAT, id)) + path.sep;
      if (!abs.startsWith(base) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
      return sendFile(res, abs);
    }

    if (p === '/clientimg') {
      const rel = url.searchParams.get('p') || '';
      const abs = path.resolve(path.join(CLIENT_DATA, rel));
      const base = path.resolve(CLIENT_DATA) + path.sep;
      if (!abs.startsWith(base) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
      return sendFile(res, abs);
    }

    const file = p === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, p.replace(/^\/+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function sendFile(res, abs) {
  const ext = path.extname(abs).toLowerCase();
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  批次生图控制台已启动');
  console.log(`  地址：http://127.0.0.1:${PORT}`);
  console.log(`  数据源：${CLIENT_DB}`);
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  }
  console.log('  关闭：界面上点“停止服务”，或直接关掉这个黑窗口');
  console.log('');
});
