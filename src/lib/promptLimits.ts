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
 * 写提示词是一次 `chat` 调用，输出上限 `MAX_OUTPUT_TOKENS`、
 * 每条预算 `TOKENS_PER_PROMPT = 900`（实测每条 SOP 提示词 380~460 字中文）。
 *
 * 改成 8 而不是原来的 12：实测 12 条一批时，第 11 条就已经被熔断
 * （sop-mw05c4zr-2nol 那批第 11 条断在「赔付总限额6」）。
 * 8 条 × 900 token = 7200，远低于上限，单批被截断的概率大幅下降；
 * 批次变多的代价只是多几次调用，比出废图便宜得多。
 */
export const PROMPTS_PER_BATCH = 8

/** 把用户填的条数收进合法范围：1 ~ MAX_PROMPTS_PER_RUN */
export function clampPromptCount(value: number): number {
  return Math.max(1, Math.min(MAX_PROMPTS_PER_RUN, Math.round(value) || 1))
}
