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
 * 这里回到 12：
 * - v1.2.87 一度改成 8，是因为当时的 token 预算是每条 500（12 条只给 6000，
 *   第 11 条就被熔断）。**根因是预算不足，不是批次太大**，预算改成 900 后
 *   12 条能拿到 10800 token，而实测 12 条只需约 8100，余量约 33%；
 * - 改 8 的代价是批次数从 3 变 4，实测每 30 条要多花一点时间
 *   （每批固定开销约 10 秒：重复传 SOP 与规则、重复推理），这是纯损失；
 * - 万一真的又写断了，`checkPromptsIntegrity` 会在发送前把那条拦下来，
 *   不会出废图 —— 所以这里可以放心按速度优先。
 */
export const PROMPTS_PER_BATCH = 12

/** 把用户填的条数收进合法范围：1 ~ MAX_PROMPTS_PER_RUN */
export function clampPromptCount(value: number): number {
  return Math.max(1, Math.min(MAX_PROMPTS_PER_RUN, Math.round(value) || 1))
}
