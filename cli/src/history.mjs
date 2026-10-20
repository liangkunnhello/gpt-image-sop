import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from './config.mjs';

const HISTORY = join(HOME_DIR, 'history.jsonl');

export function record(entry) {
  try {
    if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true });
    appendFileSync(HISTORY, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // 历史记录失败不影响出图主流程
  }
}

export function readHistory(limit = 20) {
  try {
    if (!existsSync(HISTORY)) return [];
    const lines = readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const historyPath = HISTORY;
