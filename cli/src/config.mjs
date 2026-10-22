import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_MODEL = 'gpt-image-2';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const HOME_DIR = process.env.GPT_IMAGE_HOME || join(homedir(), '.gpt-image-cli');

/** 极简 dotenv 解析：支持 KEY=VALUE、# 注释、单双引号包裹 */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readEnvFile(p) {
  try {
    if (!existsSync(p)) return {};
    return parseDotenv(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function readJson(p) {
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

/**
 * 配置优先级：CLI 参数 > 进程环境变量 > 当前目录 .env > HOME/.env > config.json 的 profile > 默认值
 */
export function loadConfig(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const homeEnv = readEnvFile(join(HOME_DIR, '.env'));
  const cwdEnv = readEnvFile(join(cwd, '.env'));
  const fileEnv = { ...homeEnv, ...cwdEnv };

  const cfgFile = readJson(join(HOME_DIR, 'config.json'));
  const profiles = cfgFile.profiles || {};
  const profileName = pick(opts.profile, fileEnv.GPT_IMAGE_PROFILE, process.env.GPT_IMAGE_PROFILE, cfgFile.default, 'default');
  const profile = profiles[profileName] || {};
  const p = process.env;

  const baseUrl = pick(
    opts.baseUrl,
    p.GPT_IMAGE_BASE_URL,
    p.OPENAI_API_BASE,
    p.OPENAI_BASE_URL,
    fileEnv.GPT_IMAGE_BASE_URL,
    fileEnv.OPENAI_API_BASE,
    fileEnv.OPENAI_BASE_URL,
    profile.baseUrl,
    DEFAULT_BASE_URL
  );

  const apiKey = pick(
    opts.apiKey,
    p.GPT_IMAGE_API_KEY,
    p.OPENAI_API_KEY,
    fileEnv.GPT_IMAGE_API_KEY,
    fileEnv.OPENAI_API_KEY,
    profile.apiKey,
    ''
  );

  const model = pick(opts.model, p.GPT_IMAGE_MODEL, fileEnv.GPT_IMAGE_MODEL, profile.model, DEFAULT_MODEL);
  const apiMode = pick(opts.apiMode, p.GPT_IMAGE_API_MODE, fileEnv.GPT_IMAGE_API_MODE, profile.apiMode, 'images');
  const size = pick(opts.size, p.GPT_IMAGE_SIZE, fileEnv.GPT_IMAGE_SIZE, profile.size, '1024x1024');
  const quality = pick(opts.quality, p.GPT_IMAGE_QUALITY, fileEnv.GPT_IMAGE_QUALITY, profile.quality, 'high');
  const outDir = resolve(cwd, pick(opts.out, p.GPT_IMAGE_OUT, fileEnv.GPT_IMAGE_OUT, profile.out, './out'));

  const source = {
    baseUrl: opts.baseUrl ? 'flag' : p.GPT_IMAGE_BASE_URL || p.OPENAI_API_BASE || p.OPENAI_BASE_URL ? 'process.env' : fileEnv.GPT_IMAGE_BASE_URL || fileEnv.OPENAI_API_BASE || fileEnv.OPENAI_BASE_URL ? '.env' : profile.baseUrl ? 'config.json' : 'default',
    apiKey: opts.apiKey ? 'flag' : p.GPT_IMAGE_API_KEY || p.OPENAI_API_KEY ? 'process.env' : fileEnv.GPT_IMAGE_API_KEY || fileEnv.OPENAI_API_KEY ? '.env' : profile.apiKey ? 'config.json' : 'missing',
    model: opts.model ? 'flag' : p.GPT_IMAGE_MODEL ? 'process.env' : fileEnv.GPT_IMAGE_MODEL ? '.env' : profile.model ? 'config.json' : 'default',
  };

  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    apiKey,
    model,
    apiMode,
    size,
    quality,
    outDir,
    profileName,
    source,
    home: HOME_DIR,
  };
}

export function maskKey(key) {
  if (!key) return '(未配置)';
  if (key.length <= 10) return key.slice(0, 2) + '***';
  return `${key.slice(0, 6)}...${key.slice(-4)} (len=${key.length})`;
}
