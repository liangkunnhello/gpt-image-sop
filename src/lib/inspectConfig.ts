import { create } from 'zustand'

import { readLocal, writeLocal } from './localRecord'
import type { QcRule } from './visionQc'

/**
 * 质检与重复度检测的配置。
 * 属于本机偏好，不写进设置（不进备份 ZIP），网页版走 localStorage、客户端走 SQLite kv。
 */
export interface InspectConfig {
  /** 出图后自动跑质检 */
  autoQc: boolean
  /** 出图后自动算重复度 */
  autoDuplicate: boolean
  /** 质检模型；留空用内置默认 */
  qcModel: string
  /** 质检逐项开关：违规内容 */
  checkViolation: boolean
  /** 质检逐项开关：文字一致性 */
  checkText: boolean
  /** 质检逐项开关：文字压叠 */
  checkOverlap: boolean
  /**
   * 自定义检查项：内置三项之外的判据，可以随便增删改。
   * 每条都进质检提示词，任何一条不通过整张图判不合格。
   */
  customRules: QcRule[]
  /** 重复度判定线，相似度超过它判为重复 */
  limit: number
  /** 一次性最多送多少张图去比对 */
  maxImages: number
  /** 每张图最多带几张同方向历史图作参照 */
  peerLimit: number
  /** 质检同时调几个模型请求 */
  qcConcurrency: number
}

export const DEFAULT_INSPECT_CONFIG: InspectConfig = {
  autoQc: true,
  autoDuplicate: true,
  qcModel: '',
  checkViolation: true,
  checkText: true,
  checkOverlap: true,
  customRules: [],
  limit: 0.92,
  maxImages: 36,
  peerLimit: 10,
  qcConcurrency: 3,
}

/** 判定线可调范围：低于 70% 几乎不会命中，高于 99% 抓不到重复 */
export const LIMIT_MIN = 0.7
export const LIMIT_MAX = 0.99

/** 自定义检查项上限：条数太多模型会漏判，也把提示词撑长 */
export const MAX_QC_RULES = 12

const STORAGE_KEY = 'gpt-image-playground.inspect-config'

function toBool(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function toNumber(value: unknown, fallback: number, min: number, max: number) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * 自定义检查项：只做裁剪与兜底，不因为「名字还空着」就丢掉 ——
 * 界面里点「新增」先加一条空行再填，丢掉的话按钮看起来没反应。
 * 空名字/空判定标准的那条由 activeQcRules 过滤掉，不会进质检提示词。
 */
function toQcRules(raw: unknown): QcRule[] {
  if (!Array.isArray(raw)) return []
  const out: QcRule[] = []
  for (const item of raw.slice(0, MAX_QC_RULES)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `qc-rule-${out.length + 1}`
    out.push({
      id,
      name: String(record.name ?? '').trim().slice(0, 24),
      detail: String(record.detail ?? '').trim().slice(0, 200),
      enabled: record.enabled !== false,
    })
  }
  return out
}

/** 从本机记录恢复，字段缺失或越界时回到默认值 */
export function normalizeInspectConfig(raw: unknown): InspectConfig {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const d = DEFAULT_INSPECT_CONFIG
  return {
    autoQc: toBool(record.autoQc, d.autoQc),
    autoDuplicate: toBool(record.autoDuplicate, d.autoDuplicate),
    qcModel: typeof record.qcModel === 'string' ? record.qcModel.trim() : d.qcModel,
    checkViolation: toBool(record.checkViolation, d.checkViolation),
    checkText: toBool(record.checkText, d.checkText),
    checkOverlap: toBool(record.checkOverlap, d.checkOverlap),
    customRules: toQcRules(record.customRules),
    limit: toNumber(record.limit, d.limit, LIMIT_MIN, LIMIT_MAX),
    maxImages: Math.round(toNumber(record.maxImages, d.maxImages, 4, 60)),
    peerLimit: Math.round(toNumber(record.peerLimit, d.peerLimit, 1, 20)),
    qcConcurrency: Math.round(toNumber(record.qcConcurrency, d.qcConcurrency, 1, 8)),
  }
}

function loadInspectConfig(): InspectConfig {
  const text = readLocal(STORAGE_KEY)
  if (!text) return DEFAULT_INSPECT_CONFIG
  try {
    return normalizeInspectConfig(JSON.parse(text))
  } catch {
    return DEFAULT_INSPECT_CONFIG
  }
}

interface InspectConfigState {
  config: InspectConfig
  setConfig: (patch: Partial<InspectConfig>) => void
  resetConfig: () => void
}

export const useInspectConfig = create<InspectConfigState>()((set, get) => ({
  config: loadInspectConfig(),

  setConfig: (patch) => {
    const next = normalizeInspectConfig({ ...get().config, ...patch })
    set({ config: next })
    writeLocal(STORAGE_KEY, JSON.stringify(next))
  },

  resetConfig: () => {
    set({ config: DEFAULT_INSPECT_CONFIG })
    writeLocal(STORAGE_KEY, JSON.stringify(DEFAULT_INSPECT_CONFIG))
  },
}))
