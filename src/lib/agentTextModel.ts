import type { ApiProfile } from '../types'
import { splitModelList } from './apiProfiles'

/**
 * 把选中的文本模型写到配置上。
 *
 * 只改 selectedModel 不够：agent 解析模型时会先确认该值在 model 列表里，
 * 不在列表就会回退到第一个。所以遇到新模型要顺手追加进列表。
 */
export function applyAgentTextModel(profile: ApiProfile, model: string): ApiProfile {
  const target = model.trim()
  if (!target) return profile
  const models = splitModelList(profile.model)
  const nextModels = models.includes(target) ? models : [...models, target]
  if (models.includes(target) && profile.selectedModel === target) return profile
  return {
    ...profile,
    model: nextModels.join(', '),
    selectedModel: target,
  }
}
