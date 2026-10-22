import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { getImage } from '../lib/db'
import { expectFromPrompt, simBatch, simBatchLocal, sidecarAlive, type QcOutcome, type SimResponse } from '../lib/batchCheck'
import { DEFAULT_QC_MODEL, qcInBrowser } from '../lib/visionQc'

const MAX_TASKS = 24
const DEFAULT_PICK = 12
const QC_CONCURRENCY = 3

const VERDICT_STYLE: Record<string, string> = {
  pass: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  fail: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  unsure: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  error: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400',
}

const VERDICT_TEXT: Record<string, string> = {
  pass: '过',
  fail: '不过',
  unsure: '待人工',
  error: '出错',
}

export default function BatchCheckModal({ onClose }: { onClose: () => void }) {
  const tasks = useStore((s) => s.tasks)
  const settings = useStore((s) => s.settings)
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  const [alive, setAlive] = useState<boolean | null>(null)
  const [busy, setBusy] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [qc, setQc] = useState<Record<string, QcOutcome>>({})
  const [sim, setSim] = useState<SimResponse | null>(null)
  /** 相似度用的是本地 CLIP 还是浏览器内感知哈希 */
  const [simEngine, setSimEngine] = useState<'clip' | 'phash' | ''>('')

  const candidates = useMemo(
    () => tasks.filter((t) => t.status === 'done' && t.outputImages.length > 0).slice(0, MAX_TASKS),
    [tasks],
  )

  useEffect(() => {
    void sidecarAlive().then(setAlive)
  }, [])

  useEffect(() => {
    if (!candidates.length) return
    setPicked((prev) => (prev.size ? prev : new Set(candidates.slice(0, DEFAULT_PICK).map((t) => t.id))))
  }, [candidates.length])

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const list = () => candidates.filter((t) => picked.has(t.id))

  const runQc = async () => {
    const items = list()
    if (!items.length) return
    setBusy(`质检 0/${items.length}`)
    let done = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < items.length) {
        const task = items[cursor]
        cursor += 1
        const image = await getImage(task.outputImages[0])
        if (image) {
          const outcome = profile
            ? await qcInBrowser(profile, image.dataUrl, expectFromPrompt(task.prompt), DEFAULT_QC_MODEL)
            : { verdict: 'error' as const, violationPass: false, textPass: false, overlapPass: false, missing: [], wrong: [], extra: [], reason: '没有可用的接口配置', confidence: null }
          setQc((prev) => ({ ...prev, [task.id]: outcome }))
        }
        done += 1
        setBusy(`质检 ${done}/${items.length}`)
      }
    }
    await Promise.all(Array.from({ length: QC_CONCURRENCY }, worker))
    setBusy('')
  }

  const runSim = async () => {
    const items = list()
    if (items.length < 2) {
      setBusy('至少选两张')
      setTimeout(() => setBusy(''), 1500)
      return
    }
    setBusy('算相似度中')
    const payload: Array<{ key: string; dataUrl: string }> = []
    for (const task of items) {
      const image = await getImage(task.outputImages[0])
      if (image) payload.push({ key: task.id, dataUrl: image.dataUrl })
    }
    try {
      setSim(await simBatch(payload))
      setSimEngine('clip')
    } catch {
      // 桌面安装版没有本地 CLIP 服务：退到浏览器内算画面近似度
      setSim(await simBatchLocal(payload))
      setSimEngine('phash')
    }
    setBusy('')
  }

  const simOf = (id: string) => sim?.per_image.find((row) => row.key === id)
  const regenIds = new Set((sim?.regen || []).map((row) => row.regenKey))

  const qcCount = (verdict: string) => Object.values(qc).filter((r) => r.verdict === verdict).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">批次验收</h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${alive ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'}`}>
            {alive === null ? '检测中' : alive ? '相似度服务已连接' : '相似度服务未启动'}
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            关闭
          </button>
        </div>

        {!alive && alive !== null && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
            没连上本地相似度服务。质检照常用当前接口配置调视觉模型；相似度会改按「画面近似度」（感知哈希）在浏览器里算，
            能抓出几乎一样的图，但语义层面的重复仍建议用本地 CLIP：在 gpt-image-cli 目录双击「启动.bat」后重开本面板。
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-5 py-2.5 text-sm dark:border-white/[0.08]">
          <span className="text-gray-500 dark:text-gray-400">已选 {picked.size} / 近 {candidates.length} 条完成任务</span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={!profile || Boolean(busy) || !picked.size}
            onClick={() => void runQc()}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            质检
          </button>
          <button
            type="button"
            disabled={!alive || Boolean(busy) || picked.size < 2}
            onClick={() => void runSim()}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            算相似度
          </button>
          {busy && <span className="text-xs text-gray-500 dark:text-gray-400">{busy}</span>}
        </div>

        {(Object.keys(qc).length > 0 || sim) && (
          <div className="flex flex-wrap gap-4 border-b border-gray-200 px-5 py-2 text-xs text-gray-600 dark:border-white/[0.08] dark:text-gray-400">
            {Object.keys(qc).length > 0 && (
              <>
                <span>质检 过 <b className="text-green-600">{qcCount('pass')}</b></span>
                <span>不过 <b className="text-red-600">{qcCount('fail')}</b></span>
                <span>待人工 <b className="text-amber-600">{qcCount('unsure')}</b></span>
              </>
            )}
            {sim && (
              <>
                <span className="text-gray-300 dark:text-gray-600">|</span>
                <span>{sim.count} 张 / {sim.pairs_total} 对</span>
                <span>判定线 {sim.limit}</span>
                <span>超线 <b className="text-red-600">{sim.over_pairs}</b> 对</span>
                <span>建议重出 <b className="text-red-600">{sim.regen.length}</b> 张</span>
                {simEngine === 'phash' && (
                  <span className="text-amber-600 dark:text-amber-400" title="没有本地 CLIP 服务，改按画面结构比对，口径与 CLIP 不同">
                    画面近似度
                  </span>
                )}
              </>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {!candidates.length && (
            <div className="p-10 text-center text-sm text-gray-400">还没有已完成的任务，先在画廊生成几张</div>
          )}
          {candidates.length > 0 && (
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <tr>
                  <th className="w-10 px-3 py-2 text-left">选</th>
                  <th className="px-3 py-2 text-left">提示词</th>
                  <th className="w-24 px-3 py-2 text-left">质检</th>
                  <th className="w-28 px-3 py-2 text-left">最像</th>
                  <th className="px-3 py-2 text-left">说明</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((task) => {
                  const outcome = qc[task.id]
                  const row = simOf(task.id)
                  const over = row ? row.max > (sim?.limit ?? 0.92) : false
                  return (
                    <tr key={task.id} className="border-t border-gray-100 dark:border-white/[0.06]">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={picked.has(task.id)}
                          onChange={() => toggle(task.id)}
                          className="h-4 w-4 accent-gray-800 dark:accent-gray-200"
                        />
                      </td>
                      <td className="max-w-[360px] truncate px-3 py-2 text-gray-700 dark:text-gray-300" title={task.prompt}>
                        {task.prompt}
                      </td>
                      <td className="px-3 py-2">
                        {outcome ? (
                          <span className={`rounded-full px-2 py-0.5 text-[11px] ${VERDICT_STYLE[outcome.verdict]}`}>
                            {VERDICT_TEXT[outcome.verdict]}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300 dark:text-gray-600">未检</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row ? (
                          <span className={`font-mono text-xs ${over ? 'font-semibold text-red-600' : 'text-gray-600 dark:text-gray-400'}`}>
                            {row.max.toFixed(3)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td className="max-w-[300px] px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                        {regenIds.has(task.id) && <span className="mr-1 font-medium text-red-600">建议重出</span>}
                        {outcome?.reason || ''}
                        {outcome?.missing.length ? ` 缺：${outcome.missing.join('、')}` : ''}
                        {outcome?.wrong.length ? ` 错：${outcome.wrong.join('、')}` : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t border-gray-200 px-5 py-2 text-[11px] text-gray-400 dark:border-white/[0.08]">
          标准答案自动取自提示词里「」中的文案；主标题取最长一条，其余当标签。
        </div>
      </div>
    </div>
  )
}
