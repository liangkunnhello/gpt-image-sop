import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function mimeOf(file) {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream';
}

function joinUrl(base, path) {
  const b = String(base).replace(/\/+$/, '');
  return `${b}/${String(path).replace(/^\/+/, '')}`;
}

function stripUndef(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

async function request(url, { apiKey, body, headers = {}, timeoutMs = 180000, method = 'POST' }) {
  const started = Date.now();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ac.signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...headers },
        body,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!res.ok) {
        // 429 / 5xx 视为可重试，指数退避
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          const wait = 1500 * attempt;
          console.error(`↻ HTTP ${res.status}，${wait}ms 后重试（${attempt}/${maxAttempts - 1}）`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const msg = json?.error?.message || json?.message || text.slice(0, 600);
        const err = new Error(`HTTP ${res.status} ${res.statusText} → ${msg}`);
        err.status = res.status;
        err.detail = json || text.slice(0, 600);
        err.elapsed = Date.now() - started;
        throw err;
      }
      if (!json) throw new Error(`响应不是合法 JSON：${text.slice(0, 200)}`);
      return { json, elapsed: Date.now() - started };
    } catch (e) {
      if (e.status !== undefined) throw e;
      if (e.name === 'AbortError') {
        const err = new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
        err.status = 'timeout';
        throw err;
      }
      if (attempt < maxAttempts) {
        console.error(`↻ 网络错误 ${e.message}，重试（${attempt}/${maxAttempts - 1}）`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 文生图：POST {base}/images/generations */
export async function generate(cfg, opts) {
  const url = joinUrl(cfg.baseUrl, '/images/generations');
  const payload = stripUndef({
    model: cfg.model,
    prompt: opts.prompt,
    n: opts.n,
    size: opts.size,
    quality: opts.quality,
    background: opts.background,
    output_format: opts.outputFormat,
    moderation: opts.moderation,
  });
  if (opts.dryRun) return { dryRun: true, url, payload };
  const { json, elapsed } = await request(url, {
    apiKey: cfg.apiKey,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: opts.timeoutMs,
  });
  return { json, elapsed, url, payload };
}

/** 改图 / 图生图：POST {base}/images/edits（multipart） */
export async function edit(cfg, opts) {
  const url = joinUrl(cfg.baseUrl, '/images/edits');
  const images = opts.images || [];
  if (!images.length) throw new Error('改图模式至少需要一张 --image');

  const payload = stripUndef({
    model: cfg.model,
    prompt: opts.prompt,
    n: opts.n,
    size: opts.size,
    quality: opts.quality,
    output_format: opts.outputFormat,
    background: opts.background,
  });
  if (opts.dryRun) {
    return { dryRun: true, url, payload, files: images, mask: opts.mask || null };
  }

  const fd = new FormData();
  for (const [k, v] of Object.entries(payload)) fd.append(k, String(v));

  const field = images.length > 1 ? 'image[]' : 'image';
  for (const file of images) {
    const buf = readFileSync(file);
    fd.append(field, new Blob([buf], { type: mimeOf(file) }), basename(file));
  }
  if (opts.mask) {
    const buf = readFileSync(opts.mask);
    fd.append('mask', new Blob([buf], { type: mimeOf(opts.mask) }), basename(opts.mask));
  }

  const { json, elapsed } = await request(url, {
    apiKey: cfg.apiKey,
    body: fd,
    timeoutMs: opts.timeoutMs,
  });
  return { json, elapsed, url, payload, files: images, mask: opts.mask || null };
}

/** Responses API 模式：POST {base}/responses，通过 image_generation 工具出图 */
export async function respond(cfg, opts) {
  const url = joinUrl(cfg.baseUrl, '/responses');
  const content = [{ type: 'input_text', text: opts.prompt }];
  for (const file of opts.images || []) {
    const b64 = readFileSync(file).toString('base64');
    content.push({ type: 'input_image', image_url: `data:${mimeOf(file)};base64,${b64}` });
  }
  const payload = stripUndef({
    model: cfg.model,
    input: [{ role: 'user', content }],
    tools: [
      stripUndef({
        type: 'image_generation',
        size: opts.size,
        quality: opts.quality,
        background: opts.background,
        output_format: opts.outputFormat,
      }),
    ],
    store: false,
  });
  if (opts.dryRun) return { dryRun: true, url, payload };
  const { json, elapsed } = await request(url, {
    apiKey: cfg.apiKey,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: opts.timeoutMs,
  });
  return { json, elapsed, url, payload };
}

/** 从多种响应结构中抽取图片（b64 或 url） */
export function extractImages(json) {
  const out = [];
  const push = (item) => {
    if (!item) return;
    if (item.b64_json) out.push({ b64: item.b64_json });
    else if (item.url) out.push({ url: item.url });
    else if (item.result) out.push({ b64: item.result });
  };

  if (Array.isArray(json?.data)) json.data.forEach(push);

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.type === 'image_generation_call' && node.result) out.push({ b64: node.result });
    if (typeof node.image_base64 === 'string') out.push({ b64: node.image_base64 });
    if (typeof node.image_url === 'string') out.push({ url: node.image_url });
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  if (json?.output) walk(json.output);
  return out;
}

/** 文本输出（Responses 模式常同时返回改写后的提示词或说明） */
export function extractText(json) {
  if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  const chunks = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.type === 'output_text' && typeof node.text === 'string') chunks.push(node.text);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  if (json?.output) walk(json.output);
  return chunks.join('\n').trim();
}

export async function fetchToBuffer(url, timeoutMs = 120000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
