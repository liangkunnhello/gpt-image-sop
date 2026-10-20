#!/usr/bin/env node
/**
 * 把纯文本提示词清单解析成「批次表」——带出图上应有的文案（标准答案）。
 * 用法：
 *   node src/batch/parse-prompts.mjs prompts/jdb-20.txt --product jdb --count 2
 *   node src/batch/parse-prompts.mjs prompts/sweet-10.txt --product sweet --count 1 --out batches
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const quoted = (s) => [...s.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim());
const first = (s, re) => {
  const m = s.match(re);
  return m && m[1] !== undefined ? m[1].trim() : '';
};
const whole = (s, re) => {
  const m = s.match(re);
  return m ? m[0].trim() : '';
};

export function parseLine(raw, seq) {
  const line = raw.trim();
  if (!line) return null;

  const brandBlock = whole(line, /标牌[^「]*「[^」]+」[^「]*「[^」]+」/);
  const brand = quoted(brandBlock);

  const disclaimerBlock = first(line, /浅灰小字((?:「[^」]+」)+)/);
  const disclaimer = quoted(disclaimerBlock);

  const mainTitle = first(line, /主标题[^「]*「([^」]+)」/);

  const tagBlock = first(line, /依次为((?:「[^」]+」)+)/);
  const tags = quoted(tagBlock);

  const layout = first(line, /文字区在画面(左|右)侧三分之一/) || first(line, /文字居中偏(右|左)/);
  const scene = first(line, /场景：([^。]+)/);
  const people = first(line, /人物：([^。]+)/);
  const tone = first(line, /([^，。；]{2,12}色调)/);
  const ratio = first(line, /\b(\d{1,2}:\d{1,2})\b/) || '16:9';

  const onImageText = { brand, disclaimer, mainTitle, tags };
  const hasTextCheck = Boolean(mainTitle || tags.length || brand.length);

  return {
    seq,
    ratio,
    layout,
    scene,
    people,
    tone,
    onImageText,
    hasTextCheck,
    prompt: line,
    promptLen: line.length
  };
}

export function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const out = [];
  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    seq += 1;
    const item = parseLine(line, seq);
    if (item) out.push(item);
  }
  return out;
}

const CSV_HEAD = [
  'seq', 'product', 'ratio', 'size', 'count',
  'main_title', 'tag1', 'tag2', 'tag3',
  'brand', 'disclaimer1', 'disclaimer2',
  'layout', 'scene', 'people', 'tone', 'prompt'
];

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(items, product, { count = 1, size = '2048x1152' } = {}) {
  const rows = [CSV_HEAD.join(',')];
  for (const it of items) {
    const t = it.onImageText || {};
    const tags = t.tags || [];
    rows.push([
      it.seq, product, it.ratio, size, count,
      t.mainTitle || '', tags[0] || '', tags[1] || '', tags[2] || '',
      (t.brand || []).join('/'), (t.disclaimer || [])[0] || '', (t.disclaimer || [])[1] || '',
      it.layout || '', it.scene || '', it.people || '', it.tone || '',
      it.prompt
    ].map(esc).join(','));
  }
  return rows.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file) {
    console.error('用法: node src/batch/parse-prompts.mjs <提示词文件> [--product 名称] [--count 张数] [--size 尺寸] [--out 目录]');
    process.exit(1);
  }
  const arg = (name, dft) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dft;
  };
  const product = arg('product', path.basename(file, path.extname(file)));
  const count = Number(arg('count', 1));
  const size = arg('size', '2048x1152');
  const outRoot = arg('out', 'batches');

  const items = parseFile(file);
  const batchId = `${product}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const dir = path.join(outRoot, batchId);
  fs.mkdirSync(dir, { recursive: true });

  const csv = toCsv(items, product, { count, size });
  fs.writeFileSync(path.join(dir, 'batch.csv'), '\ufeff' + csv, 'utf8');
  fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify(items, null, 2), 'utf8');

  const withText = items.filter((x) => x.hasTextCheck).length;
  console.log(`✔ 解析 ${items.length} 条 → ${dir}`);
  console.log(`  带图上文案（可做文字质检）：${withText} 条`);
  console.log(`  无文中文案（只查画面）：${items.length - withText} 条`);
  console.log('');
  for (const it of items.slice(0, 3)) {
    const t = it.onImageText;
    console.log(`  [${it.seq}] 主标题「${t.mainTitle || '-'}」 标签 ${t.tags.map((x) => `「${x}」`).join(' ') || '-'}`);
    console.log(`      品牌 ${t.brand.map((x) => `「${x}」`).join('') || '-'} | 免责 ${t.disclaimer.length} 条 | 版式 ${it.layout || '-'} | ${it.tone || '-'}`);
  }
}
