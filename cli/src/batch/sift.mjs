#!/usr/bin/env node
/**
 * 批次结果分拣：把「出图 + 质检 + 相似度」三份结果合成三个抽屉。
 *
 * 用法：
 *   node src/batch/sift.mjs batches/jdb-20261019
 *   node src/batch/sift.mjs batches/jdb-20261019 --dry-run
 *   node src/batch/sift.mjs batches/jdb-20261019 --out 出货
 *
 * 目录结构：
 *   <批次>/sorted/合格/<产品>/<文件名>
 *   <批次>/sorted/待重出/<产品>/<文件名>
 *   <批次>/sorted/不合格/<产品>/<文件名>
 *   <批次>/sorted/未质检/<产品>/<文件名>
 *   <批次>/sorted/清单.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BUCKETS = ['合格', '待重出', '不合格', '未质检'];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const baseName = (p) => path.basename(String(p || ''));

/** 逐张判定：先看质检结论，再看相似度是否越界 */
function decide(qc, simMax, simLimit) {
  const reasons = [];
  if (!qc) return { bucket: '未质检', reasons: ['没有质检记录'] };
  if (qc.verdict === 'fail') {
    if (!qc.violation?.pass) reasons.push(`违规：${(qc.violation.items || []).join('、') || '有风险画面'}`);
    if (!qc.text?.pass) {
      const t = qc.text || {};
      if (t.missing?.length) reasons.push(`漏字：${t.missing.join('、')}`);
      if (t.wrong?.length) reasons.push(`错字：${t.wrong.join('、')}`);
      if (t.extra?.length) reasons.push(`多字：${t.extra.join('、')}`);
    }
    if (!qc.overlap?.pass) reasons.push(`压字：${(qc.overlap.spots || []).join('、') || '文字被遮挡'}`);
    if (!reasons.length) reasons.push(qc.reason || '质检未通过');
    return { bucket: '不合格', reasons };
  }
  if (qc.verdict === 'unsure') return { bucket: '待重出', reasons: ['质检拿不准，需人工看一眼'] };
  if (simMax != null && simLimit != null && simMax > simLimit) {
    return { bucket: '待重出', reasons: [`与同批图重复度 ${simMax}，超过 ${simLimit}`] };
  }
  return { bucket: '合格', reasons: [qc.reason || '通过'] };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function siftBatch(batchDir, opts = {}) {
  const dir = path.resolve(batchDir);
  const outRoot = path.join(dir, opts.out || 'sorted');

  const results = readJsonl(path.join(dir, 'results.jsonl')).filter((r) => r.status === 'ok');
  if (!results.length) throw new Error('results.jsonl 里没有成功的图片，先跑 run.mjs');

  const qcBySeq = new Map();
  for (const row of readJsonl(path.join(dir, 'qc.jsonl'))) qcBySeq.set(Number(row.seq), row);

  const sim = readJson(path.join(dir, 'similarity.json'));
  const simLimit = sim?.limit ?? opts.limit ?? null;
  const simMaxByFile = new Map();
  for (const p of [...(sim?.most_similar || []), ...(sim?.over_list || [])]) {
    for (const name of [p.a, p.b]) {
      const prev = simMaxByFile.get(name);
      if (prev == null || p.sim > prev) simMaxByFile.set(name, p.sim);
    }
  }

  const rows = results.map((r) => {
    const name = baseName(r.rel);
    const qc = qcBySeq.get(Number(r.seq)) || null;
    const simMax = simMaxByFile.get(name) ?? null;
    const { bucket, reasons } = decide(qc, simMax, simLimit);
    return {
      seq: r.seq,
      product: r.product || '',
      title: r.main_title || '',
      file: r.rel,
      name,
      bucket,
      verdict: qc?.verdict || '未质检',
      simMax,
      reason: reasons.filter(Boolean).join('；'),
      target: path.join(outRoot, bucket, r.product || '未分组', name),
    };
  });

  if (!opts.dryRun) {
    for (const b of BUCKETS) fs.mkdirSync(path.join(outRoot, b), { recursive: true });
    for (const row of rows) {
      fs.mkdirSync(path.dirname(row.target), { recursive: true });
      fs.copyFileSync(path.join(dir, row.file), row.target);
    }
    const head = ['seq', 'product', 'main_title', 'bucket', 'verdict', 'similarity', 'reason', 'source', 'sorted'];
    const lines = [head.join(',')];
    for (const row of rows) {
      lines.push([
        row.seq, row.product, row.title, row.bucket, row.verdict,
        row.simMax == null ? '' : row.simMax, row.reason, row.file,
        path.relative(dir, row.target),
      ].map(csvCell).join(','));
    }
    fs.writeFileSync(path.join(outRoot, '清单.csv'), '\ufeff' + lines.join('\n') + '\n', 'utf8');
  }

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]));
  return { batchDir: dir, outRoot, total: rows.length, counts, simLimit, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) {
    console.error('用法: node src/batch/sift.mjs <批次目录> [--out 名称] [--dry-run]');
    process.exit(1);
  }
  const arg = (name, dft) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dft;
  };
  const dryRun = argv.includes('--dry-run');
  try {
    const r = siftBatch(dir, { out: arg('out', 'sorted'), dryRun });
    console.log(dryRun ? '— 试运行（不落盘）—' : '✔ 分拣完成');
    console.log(`  共 ${r.total} 张 · 判定线 ${r.simLimit ?? '未设'}`);
    for (const b of BUCKETS) console.log(`  ${b.padEnd(3, '　')} ${r.counts[b]} 张`);
    if (dryRun) {
      for (const row of r.rows.slice(0, 8)) console.log(`   · s${row.seq} → ${row.bucket}｜${row.reason}`);
    } else {
      console.log(`  目录：${r.outRoot}`);
      console.log(`  清单：${path.join(r.outRoot, '清单.csv')}`);
    }
  } catch (e) {
    console.error('✘', e.message);
    process.exit(1);
  }
}
