/**
 * 一次能写多少条提示词。
 *
 * 这个上限只是防误填的兜底（比如手滑多按两个 0），不是出图能力的边界：
 * 条数再多也是分批写，每批受单次模型输出上限约束，所以理论值可以给得很大。
 */
export const MAX_PROMPTS_PER_RUN = 500

/**
 * 单批写几条。
 *
 * 写提示词是一次 `chat` 调用，输出上限 `MAX_OUTPUT_TOKENS = 16000`、
 * 每条预算 `TOKENS_PER_PROMPT = 500`，也就是一次最多约 32 条。
 * 取 12 是留足余量：模型偶尔会把一条写得偏长，批太满会被截断成半条。
 */
export const PROMPTS_PER_BATCH = 12

/** 把用户填的条数收进合法范围：1 ~ MAX_PROMPTS_PER_RUN */
export function clampPromptCount(value: number): number {
  return Math.max(1, Math.min(MAX_PROMPTS_PER_RUN, Math.round(value) || 1))
}
