#!/usr/bin/env node
/**
 * 图片质检：违规画面 / 文案错漏 / 文案重叠。
 * 模型：deepseek-v4.1-flash，默认非思考模式（thinking.type=disabled）。
 *
 * 单张试跑：
 *   node src/batch/qc.mjs out/jdb20-01-01.png --batch batches/jdb-20261019 --seq 1
 *   node src/batch/qc.mjs out/sweet10-01-01.png --raw
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.mjs';
import { mimeOf } from '../client.mjs';
import { csvToObjects } from './run.mjs';

const SYSTEM = [
  '你是广告投放前的图片质检员，只做判断，不改图。',
  '判断三件事：一，画面是否含违规内容（色情暴露、暴力血腥、政治敏感、未成年人不良形象、医疗功效夸大或承诺治愈）；',
  '二，图上文字与"应出现文案"是否一致，抓出错字、多字、少字、整条缺失；',
  '三，文字之间、文字与人物主体之间是否压叠到读不清。',
  '只依据图上实际可见的内容作答，不推测、不补全。看不清写进 note，不要当成"没有"。',
  '必须输出单个扁平 JSON 对象，字段一个不少，不要嵌套，不要 markdown 代码块，不要任何解释文字。'
].join('');

const SCHEMA = '{"violation_pass":true,"violation_items":[],"text_pass":true,"found":[],"missing":[],"wrong":[],"extra":[],"overlap_pass":true,"overlap_spots":[],"verdict":"pass","confidence":0.9,"reason":"一句话"}';

function buildPrompt(expect, strict = false) {
  const hasText = Boolean(expect && (expect.mainTitle || (expect.tags || []).length));
  const L = [];
  L.push('检查这张图。');
  if (hasText) {
    L.push('');
    L.push('【应出现的文案】');
    if (expect.mainTitle) L.push(`主标题：${expect.mainTitle}`);
    if ((expect.tags || []).length) L.push(`标签：${expect.tags.join(' / ')}`);
    if ((expect.brand || []).length) L.push(`品牌标识：${expect.brand.join(' / ')}`);
    if ((expect.disclaimer || []).length) L.push(`免责小字：${expect.disclaimer.join(' / ')}`);
    L.push('');
    L.push('主标题和标签必须逐字一致。免责小字字号很小，读不出时在 reason 里注明"小字不可辨"，不算错字。');
  } else {
    L.push('本图不要求出现任何文字。若图上有文字，记入 extra。');
  }
  L.push('');
  L.push('found 填图上实际读到的文字；missing 填应有但没找到的；wrong 填"应为X实为Y"；extra 填规范外多出来的；overlap_spots 填压字位置描述。');
  L.push('verdict 取 pass / fail / unsure；拿不准一律 unsure，不要硬判 pass。');
  L.push('');
  if (strict) L.push('上一次输出不是合法 JSON。这次只输出一行 JSON，不要换行，不要代码块。');
  L.push('输出结构：');
  L.push(SCHEMA);
  return L.join('\n');
}

/** 大图先缩，省传输时间（400KB 以下不动） */
function prepImage(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= 400 * 1024) return file;
    const tag = crypto.createHash('md5').update(`${file}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 12);
    const out = path.join(os.tmpdir(), `qc-${tag}.jpg`);
    if (fs.existsSync(out)) return out;
    execFileSync('python', ['-c',
      'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]);im.thumbnail((1400,1400))\nim.convert("RGB").save(sys.argv[2],quality=88)',
      file, out
    ], { stdio: 'ignore', timeout: 30000 });
    return fs.existsSync(out) ? out : file;
  } catch {
    return file;
  }
}

function resilientParse(text) {
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  s = s.slice(start);
  try { return JSON.parse(s); } catch {}
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(0, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 把扁平结果整理成三个检查块 */
export function shape(p) {
  if (!p) return null;
  return {
    violation: { pass: p.violation_pass !== false, items: p.violation_items || [], note: '' },
    text: {
      pass: p.text_pass !== false,
      found: p.found || [],
      missing: p.missing || [],
      wrong: p.wrong || [],
      extra: p.extra || [],
      note: ''
    },
    overlap: { pass: p.overlap_pass !== false, spots: p.overlap_spots || [], note: '' },
    verdict: ['pass', 'fail', 'unsure'].includes(p.verdict) ? p.verdict : 'unsure',
    confidence: typeof p.confidence === 'number' ? p.confidence : null,
    reason: p.reason || ''
  };
}

export async function qcImage(imagePath, expect, opts = {}) {
  const cfg = loadConfig({ cwd: opts.cwd || process.cwd() });
  const model = opts.model || 'deepseek-v4.1-flash';
  const src = opts.noResize ? imagePath : prepImage(imagePath);
  const b64 = fs.readFileSync(src).toString('base64');
  const mime = mimeOf(src);
  const url = `${cfg.baseUrl}/chat/completions`;
  const timeoutMs = opts.timeoutMs || 120000;

  let last = { content: '', status: 0, usage: null };
  const t0 = Date.now();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = {
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(expect, attempt === 2) },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 1000,
      stream: false,
      response_format: { type: 'json_object' }
    };
    if (opts.thinking !== true) body.thinking = { type: 'disabled' };
    if (attempt === 2) delete body.response_format;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 400 && attempt === 1) continue;
        throw new Error(`HTTP ${res.status} → ${text.slice(0, 400)}`);
      }
      const json = JSON.parse(text);
      const content = String(json.choices?.[0]?.message?.content ?? '');
      last = { content, status: res.status, usage: json.usage || null };
      const parsed = resilientParse(content);
      if (parsed) {
        return {
          model,
          ok: true,
          attempts: attempt,
          resized: src !== imagePath,
          elapsedMs: Date.now() - t0,
          usage: last.usage,
          result: shape(parsed),
          raw: content
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,
    ok: false,
    attempts: 2,
    resized: src !== imagePath,
    elapsedMs: Date.now() - t0,
    usage: last.usage,
    result: null,
    raw: last.content
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const img = argv[0];
  if (!img) {
    console.error('用法: node src/batch/qc.mjs <图片> [--batch 批次目录] [--seq 序号] [--model 模型] [--think] [--raw]');
    process.exit(1);
  }
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(`--${n}`);

  let expect = null;
  const batchDir = arg('batch', null);
  const seq = Number(arg('seq', 0));
  if (batchDir && seq) {
    const csvPath = path.join(batchDir, 'batch.csv');
    if (!fs.existsSync(csvPath)) {
      console.error(`✘ 找不到批次表：${csvPath}`);
      process.exit(1);
    }
    const rows = csvToObjects(fs.readFileSync(csvPath, 'utf8'));
    const row = rows.find((r) => Number(r.seq) === seq);
    if (!row) {
      console.error(`✘ 批次表里没有 seq=${seq} 这一行。已停止，不做无标准答案的质检。`);
      process.exit(1);
    }
    const mainTitle = row.main_title || '';
    const tags = [row.tag1, row.tag2, row.tag3].filter(Boolean);
    if (!mainTitle && !tags.length) {
      console.error(`✘ seq=${seq} 这行没有主标题和标签，无法做文字质检。请先补 batch.csv 的标准答案列。`);
      process.exit(1);
    }
    expect = {
      mainTitle,
      tags,
      brand: row.brand ? row.brand.split('/') : [],
      disclaimer: [row.disclaimer1, row.disclaimer2].filter(Boolean)
    };
  }

  qcImage(path.resolve(img), expect, {
    model: arg('model', 'deepseek-v4.1-flash'),
    thinking: flag('think')
  }).then((r) => {
    const u = r.usage || {};
    console.log(`模型 ${r.model} | ${(r.elapsedMs / 1000).toFixed(1)}s | 第${r.attempts}次成功 | 缩图 ${r.resized ? '是' : '否'} | tokens 入${u.prompt_tokens ?? '-'} 出${u.completion_tokens ?? '-'} 思考${u.completion_tokens_details?.reasoning_tokens ?? '-'}`);
    if (r.result) {
      console.log('--- 判定 ---');
      console.log(`违规 ${r.result.violation.pass ? '过' : '不过'} | 文案 ${r.result.text.pass ? '过' : '不过'} | 重叠 ${r.result.overlap.pass ? '过' : '不过'} | 结论 ${r.result.verdict} (置信 ${r.result.confidence})`);
      if (r.result.violation.items?.length) console.log('违规项:', r.result.violation.items.join(' / '));
      if (r.result.text.missing?.length) console.log('缺失:', r.result.text.missing.join(' / '));
      if (r.result.text.wrong?.length) console.log('字错:', r.result.text.wrong.join(' / '));
      if (r.result.text.extra?.length) console.log('多出:', r.result.text.extra.join(' / '));
      if (r.result.overlap.spots?.length) console.log('压字:', r.result.overlap.spots.join(' / '));
      console.log('理由:', r.result.reason);
      if (flag('raw')) console.log('\n原文:', r.raw);
    } else {
      console.log('✘ 两次都没能解析成 JSON，原文：');
      console.log(r.raw.slice(0, 1200));
      process.exitCode = 2;
    }
  }).catch((e) => { console.error('✘', e.message); process.exit(1); });
}
