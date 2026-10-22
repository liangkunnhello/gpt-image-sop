#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, maskKey, HOME_DIR } from './config.mjs';
import { resolveSize } from './size.mjs';
import { generate, edit, respond, extractImages, extractText, fetchToBuffer } from './client.mjs';
import { record, readHistory, historyPath } from './history.mjs';

const VERSION = '0.1.0';
const ARRAY_KEYS = new Set(['image', 'ref', 'i']);
const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = join(HERE, '..', 'tools', 'sync_to_playground.py');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        assign(out, a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          assign(out, key, next);
          i++;
        } else {
          out[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1 && a !== '-') {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        assign(out, key, next);
        i++;
      } else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function assign(obj, key, val) {
  if (ARRAY_KEYS.has(key)) {
    if (!Array.isArray(obj[key])) obj[key] = [];
    obj[key].push(val);
  } else if (obj[key] === undefined) {
    obj[key] = val;
  } else {
    obj[key] = Array.isArray(obj[key]) ? [...obj[key], val] : [obj[key], val];
  }
}

const HELP = `gpt-image-cli v${VERSION} — GPT Image 2 命令行生图

用法:
  gpt-image gen "<提示词>" [选项]              文生图
  gpt-image edit "<提示词>" -i a.png [选项]    参考图改图（多图重复 -i）
  gpt-image list [--limit 20] [--json]         查看本地生成历史
  gpt-image config [--json]                    查看当前生效配置（Key 脱敏）
  gpt-image sync [选项]                         把历史导入 GPT Image Playground 桌面客户端

同步选项:
      --dry-run              只列计划，不写库
      --app-data <dir>       客户端数据目录，默认 %LOCALAPPDATA%\\GPT Image Playground\\data
      --source <dir>         额外导入某个目录下的图片（无提示词元数据）
      --limit <n>            只同步最近 n 个任务
      --skip-thumb           跳过缩略图生成
      --json                 机器可读输出

通用选项:
  -p, --prompt <text>        提示词（也可用位置参数）
      --prompt-file <file>   批量：空行分隔多条提示词
      --model <id>           模型，默认 gpt-image-2
      --size <WxH|1k|2k|4k>  尺寸，默认 1024x1024
      --ratio <16:9>         按比例出图（配合 --res）
      --res <1k|2k|4k>       比例基准，默认 2k
  -q, --quality <low|medium|high>   默认 high
      --n <1-4>              单次出图数量，默认 1
      --background <auto|transparent|opaque>
      --format <png|jpeg|webp>          输出格式，默认 png
  -o, --out <dir>            输出目录，默认 ./out
      --name <prefix>        文件名前缀，默认时间戳
      --api-mode <images|responses>     默认 images
      --base-url <url>       覆盖 API 地址（需含 /v1）
      --api-key <key>        覆盖 API Key
      --profile <name>       使用 ~/.gpt-image-cli/config.json 中的配置档案
      --timeout <sec>        单次请求超时，默认 300
      --concurrency <n>      批量并发出图数，默认 1
      --skip-existing        批量时跳过已生成的文件，用于失败后续跑
      --dry-run              只打印请求，不发网络
      --json                  机器可读输出

改图专用:
  -i, --image <file>         参考图，可重复（最多 16 张）
      --mask <file>          遮罩 PNG（透明区为可编辑区）

示例:
  gpt-image gen "一只戴耳机的橘猫，扁平插画风" --ratio 16:9 --res 2k
  gpt-image edit "改成水彩风格" -i ./photo.png --quality high
  gpt-image gen --prompt-file ./prompts.txt --n 2 --out ./batch
`;

const EXT_BY_FORMAT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp' };

function ts() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function resolveSizes(args, cfg, forEdit) {
  const explicit = args.size || args.ratio || args.res;
  if (!explicit) {
    return forEdit ? { size: undefined, warn: [] } : resolveSize({ size: cfg.size });
  }
  return resolveSize({ size: args.size, ratio: args.ratio, res: args.res });
}

async function saveImages(items, { outDir, prefix, format }) {
  ensureDir(outDir);
  const files = [];
  let idx = 0;
  for (const item of items) {
    idx++;
    const ext = EXT_BY_FORMAT[String(format || '').toLowerCase()] || 'png';
    const file = join(outDir, `${prefix}-${String(idx).padStart(2, '0')}.${ext}`);
    if (item.b64) {
      writeFileSync(file, Buffer.from(item.b64, 'base64'));
    } else if (item.url) {
      writeFileSync(file, await fetchToBuffer(item.url));
    } else continue;
    files.push(file);
  }
  return files;
}

async function runSingle(prompt, args, cfg, { forEdit }) {
  const mode = String(args['api-mode'] || cfg.apiMode || 'images').toLowerCase();
  const images = (args.image || args.i || []).map((p) => resolve(process.cwd(), String(p)));
  const mask = args.mask ? resolve(process.cwd(), String(args.mask)) : undefined;
  const format = String(args.format || args['output-format'] || 'png').toLowerCase();
  const sizeInfo = resolveSizes(args, cfg, forEdit);
  const outDir = resolve(process.cwd(), String(args.out || cfg.outDir));
  const prefix = String(args.name || ts());
  const timeoutMs = Number(args.timeout || 300) * 1000;
  const n = Number(args.n || 1);

  const common = {
    prompt,
    size: sizeInfo.size,
    quality: String(args.quality || args.q || cfg.quality),
    n,
    background: args.background,
    outputFormat: format,
    moderation: args.moderation,
    images,
    mask,
    timeoutMs,
    dryRun: Boolean(args['dry-run']),
  };

  for (const w of sizeInfo.warn) console.error(`⚠ ${w}`);

  let result;
  if (mode === 'responses') result = await respond(cfg, common);
  else if (forEdit || images.length) result = await edit(cfg, common);
  else result = await generate(cfg, common);

  if (result.dryRun) {
    const info = {
      ok: true,
      dryRun: true,
      request: { url: result.url, payload: result.payload, files: result.files, mask: result.mask },
    };
    if (args.json) console.log(JSON.stringify(info, null, 2));
    else {
      console.log(`[dry-run] POST ${result.url}`);
      console.log(JSON.stringify(result.payload, null, 2));
      if (result.files) console.log(`files: ${result.files.join(', ')}`);
      if (result.mask) console.log(`mask: ${result.mask}`);
    }
    return info;
  }

  const items = extractImages(result.json);
  if (!items.length) {
    const text = extractText(result.json);
    throw new Error(`响应中没有图片${text ? `，返回文本：${text.slice(0, 300)}` : ''}`);
  }
  const files = await saveImages(items, { outDir, prefix, format });
  const elapsed = result.elapsed;

  record({
    mode: forEdit || images.length ? 'edit' : 'gen',
    apiMode: mode,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    size: sizeInfo.size,
    quality: common.quality,
    prompt,
    files,
    inputs: images,
    elapsedMs: elapsed,
    status: 'ok',
  });

  if (args.json) {
    console.log(
      JSON.stringify({ ok: true, files, count: files.length, model: cfg.model, size: sizeInfo.size, elapsedMs: elapsed }, null, 2)
    );
  } else {
    console.log(`✔ ${files.length} 张已保存（model=${cfg.model}, size=${sizeInfo.size || 'auto'}, ${(elapsed / 1000).toFixed(1)}s）`);
    for (const f of files) console.log(`  ${f}`);
  }
  return { ok: true, files };
}

async function cmdGen(args, cfg, { forEdit }) {
  const prompts = [];
  const positional = args._.join(' ').trim();
  if (args.prompt) prompts.push(String(args.prompt));
  else if (positional) prompts.push(positional);

  if (args['prompt-file']) {
    const file = resolve(process.cwd(), String(args['prompt-file']));
    const text = readFileSync(file, 'utf8');
    const parts = text
      .split(/\r?\n\s*\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    prompts.push(...parts);
  }

  if (!prompts.length) throw new Error('缺少提示词：用位置参数或 -p/--prompt 提供');

  const concurrency = Math.max(1, Number(args.concurrency || 1));
  const baseName = String(args.name || ts());
  const outDir = resolve(process.cwd(), String(args.out || cfg.outDir));
  let saved = 0;
  const failures = [];
  const run = async (p, i) => {
    // 批量时给每条提示词独立文件名后缀，避免同名覆盖
    const perName = `${baseName}-${String(i + 1).padStart(2, '0')}`;
    if (args['skip-existing'] && existsSync(join(outDir, `${perName}-01.png`))) {
      if (!args.json) console.log(`  [${i + 1}/${prompts.length}] 已存在，跳过`);
      return { files: [] };
    }
    const perArgs = prompts.length > 1 ? { ...args, name: perName } : { ...args, name: baseName };
    try {
      const res = await runSingle(p, perArgs, cfg, { forEdit });
      saved += res.files?.length || 0;
      if (!args.json && prompts.length > 1) console.log(`  [${i + 1}/${prompts.length}] done`);
      return res;
    } catch (e) {
      failures.push({ index: i + 1, prompt: p.slice(0, 60), error: e.message });
      if (!args.json) console.error(`✘ [${i + 1}/${prompts.length}] ${e.message}`);
      return { files: [], error: e.message };
    }
  };

  if (concurrency === 1 || prompts.length === 1) {
    for (let i = 0; i < prompts.length; i++) await run(prompts[i], i);
  } else {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, prompts.length) }, async () => {
      while (cursor < prompts.length) {
        const i = cursor++;
        await run(prompts[i], i);
      }
    });
    await Promise.all(workers);
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: failures.length === 0, saved, failed: failures.length, outDir, failures }, null, 2));
  } else {
    console.log(`\n共 ${saved} 张，输出目录：${outDir}`);
    if (failures.length) {
      console.error(`\n有 ${failures.length} 条失败（可用 --skip-existing 续跑）：`);
      for (const f of failures) console.error(`  #${f.index} ${f.error}`);
    }
  }
  if (failures.length) process.exitCode = 1;
}

function cmdList(args) {
  const limit = Number(args.limit || 20);
  const rows = readHistory(limit);
  if (args.json) {
    console.log(JSON.stringify({ history: historyPath, count: rows.length, items: rows }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(`暂无历史记录（${historyPath}）`);
    return;
  }
  console.log(`最近 ${rows.length} 条（${historyPath}）\n`);
  for (const r of rows) {
    const t = r.ts ? new Date(r.ts).toLocaleString('sv-SE') : '-';
    console.log(`${t}  ${r.model || '-'}  ${r.size || '-'}  ${r.mode || '-'}`);
    console.log(`  ${(r.prompt || '').slice(0, 70)}`);
    for (const f of r.files || []) console.log(`  → ${f}`);
  }
}

function cmdConfig(args, cfg) {
  const info = {
    baseUrl: cfg.baseUrl,
    apiKey: maskKey(cfg.apiKey),
    model: cfg.model,
    apiMode: cfg.apiMode,
    defaultSize: cfg.size,
    defaultQuality: cfg.quality,
    outDir: cfg.outDir,
    profile: cfg.profileName,
    sources: cfg.source,
    home: HOME_DIR,
    history: historyPath,
    envFile: join(process.cwd(), '.env'),
  };
  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`baseUrl : ${info.baseUrl}   [来源: ${cfg.source.baseUrl}]`);
  console.log(`apiKey  : ${info.apiKey}   [来源: ${cfg.source.apiKey}]`);
  console.log(`model   : ${info.model}   [来源: ${cfg.source.model}]`);
  console.log(`apiMode : ${info.apiMode}`);
  console.log(`size    : ${info.defaultSize}   quality: ${info.defaultQuality}`);
  console.log(`outDir  : ${info.outDir}`);
  console.log(`profile : ${info.profile}`);
  console.log(`home    : ${info.home}`);
  console.log(`history : ${info.history}`);
}

async function cmdSync(args) {
  const pass = [];
  if (args['app-data']) pass.push('--app-data', String(args['app-data']));
  if (args.history) pass.push('--history', String(args.history));
  if (args.source) pass.push('--source', String(args.source));
  if (args.limit) pass.push('--limit', String(args.limit));
  if (args['dry-run']) pass.push('--dry-run');
  if (args.json) pass.push('--json');
  if (args['skip-thumb']) pass.push('--skip-thumb');

  const py = process.env.PYTHON || process.env.PYTHON3 || 'python';
  await new Promise((ok, fail) => {
    const child = spawn(py, [SYNC_SCRIPT, ...pass], { stdio: 'inherit', windowsHide: true });
    child.on('error', (e) => fail(new Error(`无法启动 ${py}：${e.message}（同步功能依赖 Python + Pillow）`)));
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`同步失败，退出码 ${code}`))));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const known = ['gen', 'edit', 'list', 'config', 'sync', 'help'];
  let cmd = 'gen';
  if (args.help || args.h || argv.length === 0) cmd = 'help';
  else if (known.includes(args._[0])) cmd = args._.shift();
  else if (args.version || args.v) cmd = 'version';

  if (cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'version') {
    console.log(VERSION);
    return 0;
  }

  const cfg = loadConfig({
    cwd: process.cwd(),
    baseUrl: args['base-url'] ? String(args['base-url']) : undefined,
    apiKey: args['api-key'] ? String(args['api-key']) : undefined,
    model: args.model ? String(args.model) : undefined,
    apiMode: args['api-mode'] ? String(args['api-mode']) : undefined,
    size: args.size ? String(args.size) : undefined,
    quality: args.quality ? String(args.quality) : args.q ? String(args.q) : undefined,
    out: args.out ? String(args.out) : undefined,
    profile: args.profile ? String(args.profile) : undefined,
  });

  if (cmd === 'list') return cmdList(args), 0;
  if (cmd === 'config') return cmdConfig(args, cfg), 0;
  if (cmd === 'sync') {
    await cmdSync(args);
    return 0;
  }

  if (!cfg.apiKey && !args['dry-run']) {
    throw new Error(
      '未配置 API Key。三种方式任选：\n  1) 在项目目录 .env 写 GPT_IMAGE_API_KEY=...\n  2) 环境变量 OPENAI_API_KEY=...\n  3) 命令行 --api-key ...'
    );
  }

  await cmdGen(args, cfg, { forEdit: cmd === 'edit' });
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, error: e.message, status: e.status ?? null }, null, 2));
    } else {
      console.error(`✘ ${e.message}`);
      if (e.status === 401) console.error('  提示：Key 无效或无该模型权限。');
      if (e.status === 404) console.error('  提示：Base URL 可能缺少 /v1 或该供应商不提供对应接口。');
      if (e.status === 403) console.error('  提示：账号未完成组织验证，gpt-image 系模型通常需要验证。');
    }
    process.exit(1);
  });
