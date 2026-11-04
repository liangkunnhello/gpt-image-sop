/**
 * 素材投放跟踪面板：台账 / 导入 / 统计。
 *
 * 打开时把四张表读进内存（素材量级在几万以内），所有筛选和聚合都在前端算 ——
 * 存储层刻意做成 id + JSON，就是为了不在这里写第二套 SQL。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import type { TaskRecord } from '../../types'
import {
  STAGE_LABEL,
  aggregateByAsset,
  aggregateByCard,
  aggregateByDate,
  buildAssetsFromTasks,
  mergeAssets,
} from '../../lib/assetLedger'
import {
  buildNameIndex,
  buildSpendRecords,
  detectMapping,
  parseCsv,
  parseXlsx,
  type ColumnMapping,
  type SheetTable,
} from '../../lib/reportImport'
import {
  trackGetAll,
  trackPut,
  trackPutMany,
  type AssetRecord,
  type ImportRecord,
  type SpendRecord,
} from '../../lib/trackDb'

type Tab = 'assets' | 'import' | 'stats'

const FIELD_LABEL: Array<[keyof ColumnMapping, string, boolean]> = [
  ['date', '投放日期', true],
  ['spend', '消耗', true],
  ['platformId', '平台素材ID', true],
  ['assetKey', '素材名称', true],
  ['media', '媒体', false],
  ['productName', '产品名称', false],
  ['designer', '设计', false],
  ['optimizer', '优化师', false],
  ['abnormal', '是否异常', false],
]

function fmtMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function TrackerModal({ onClose }: { onClose: () => void }) {
  const tasks = useStore((state) => state.tasks)
  const [tab, setTab] = useState<Tab>('assets')
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [spend, setSpend] = useState<SpendRecord[]>([])
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const byAsset = useMemo(() => aggregateByAsset(spend), [spend])
  const byDate = useMemo(() => aggregateByDate(spend), [spend])
  const byCard = useMemo(() => aggregateByCard(assets, byAsset), [assets, byAsset])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, s, i] = await Promise.all([
        trackGetAll<AssetRecord>('assets'),
        trackGetAll<SpendRecord>('spend'),
        trackGetAll<ImportRecord>('imports'),
      ])
      setAssets(a)
      setSpend(s)
      setImports(i)
    } catch (err) {
      setError(`读取本地数据失败：${String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** 重新扫任务卡建台账。已有记录的投放数据会保留（mergeAssets 负责） */
  const rebuildLedger = async () => {
    setBusy('正在扫描任务卡…')
    setError('')
    try {
      const scanned = buildAssetsFromTasks(tasks as TaskRecord[])
      const merged = mergeAssets(assets, scanned)
      const changed = merged.filter((item) => !assets.some((old) => old.id === item.id))
      await trackPutMany('assets', changed.map((item) => ({ id: item.id, data: item })))
      setAssets(merged)
      setBusy(`已建档 ${merged.length} 个素材（新增 ${changed.length} 个）`)
    } catch (err) {
      setError(`建档失败：${String(err)}`)
      setBusy('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 dark:border-white/10">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">素材投放跟踪</h2>
            <div className="flex gap-1">
              {([['assets', '素材台账'], ['import', '导入报表'], ['stats', '消耗统计']] as Array<[Tab, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${
                    tab === key
                      ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                      : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-white/5'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10">
            关闭
          </button>
        </div>

        {error && <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        {busy && <div className="mx-5 mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">{busy}</div>}

        <div className="flex-1 overflow-auto px-5 py-4">
          {loading ? (
            <p className="text-xs text-gray-400">读取中…</p>
          ) : tab === 'assets' ? (
            <AssetsTab
              assets={assets}
              byAsset={byAsset}
              byCard={byCard}
              onRebuild={rebuildLedger}
            />
          ) : tab === 'import' ? (
            <ImportTab
              tasks={tasks as TaskRecord[]}
              assets={assets}
              onDone={load}
              setBusy={setBusy}
              setError={setError}
            />
          ) : (
            <StatsTab totalSpend={spend.reduce((sum, item) => sum + item.spend, 0)} byDate={byDate} imports={imports} byCard={byCard} assets={assets} />
          )}
        </div>
      </div>
    </div>
  )
}

function AssetsTab({
  assets,
  byAsset,
  byCard,
  onRebuild,
}: {
  assets: AssetRecord[]
  byAsset: ReturnType<typeof aggregateByAsset>
  byCard: ReturnType<typeof aggregateByCard>
  onRebuild: () => void
}) {
  const [stageFilter, setStageFilter] = useState<'all' | 'running' | 'declining' | 'created' | 'stale'>('all')
  const deployed = assets.filter((item) => byAsset.has(item.id))
  const totalSpend = [...byAsset.values()].reduce((sum, item) => sum + item.totalSpend, 0)

  const rows = useMemo(() => {
    return assets
      .map((asset) => ({ asset, stat: byAsset.get(asset.id) }))
      .filter((row) => {
        if (stageFilter === 'all') return true
        const stage = row.stat?.stage ?? 'created'
        return stage === stageFilter
      })
      .sort((a, b) => (b.stat?.totalSpend ?? 0) - (a.stat?.totalSpend ?? 0))
  }, [assets, byAsset, stageFilter])

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-3">
        <Metric label="素材总数" value={String(assets.length)} />
        <Metric label="已投放" value={String(deployed.length)} />
        <Metric label="累计消耗" value={`¥${fmtMoney(totalSpend)}`} />
        <Metric label="任务卡" value={String(byCard.size)} />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['all', 'running', 'declining', 'stale', 'created'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setStageFilter(key)}
              className={`rounded-lg px-2 py-1 text-xs ${
                stageFilter === key ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'
              }`}
            >
              {key === 'all' ? '全部' : STAGE_LABEL[key]}
            </button>
          ))}
        </div>
        <button type="button" onClick={onRebuild} className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600">
          扫描任务卡建台账
        </button>
      </div>

      {!assets.length ? (
        <p className="py-10 text-center text-xs text-gray-400">
          还没有素材记录。点右上角「扫描任务卡建台账」，把已生成的图片收进来。
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-gray-400">
            <tr className="border-b border-gray-100 dark:border-white/10">
              <th className="py-1.5 text-left font-normal">素材（哈希前 8 位）</th>
              <th className="py-1.5 text-right font-normal">累计消耗</th>
              <th className="py-1.5 text-right font-normal">投放天数</th>
              <th className="py-1.5 text-right font-normal">日均</th>
              <th className="py-1.5 text-right font-normal">最后投放</th>
              <th className="py-1.5 text-right font-normal">阶段</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map(({ asset, stat }) => (
              <tr key={asset.id} className="border-b border-gray-50 dark:border-white/5">
                <td className="py-1.5 font-mono text-gray-700 dark:text-gray-200">
                  {asset.id.slice(0, 8)}
                  {asset.platformIds.length > 0 && (
                    <span className="ml-2 text-[10px] text-gray-400">平台ID {asset.platformIds.length} 个</span>
                  )}
                </td>
                <td className="py-1.5 text-right text-gray-700 dark:text-gray-200">{stat ? `¥${fmtMoney(stat.totalSpend)}` : '-'}</td>
                <td className="py-1.5 text-right text-gray-500">{stat?.activeDays ?? '-'}</td>
                <td className="py-1.5 text-right text-gray-500">{stat ? `¥${fmtMoney(stat.dailyAverage)}` : '-'}</td>
                <td className="py-1.5 text-right text-gray-500">{stat?.lastDate ?? '-'}</td>
                <td className="py-1.5 text-right">
                  <StageBadge stage={stat?.stage ?? 'created'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 200 && <p className="text-[11px] text-gray-400">只显示前 200 条（按消耗降序），共 {rows.length} 条</p>}
    </div>
  )
}

function StageBadge({ stage }: { stage: keyof typeof STAGE_LABEL }) {
  const color: Record<string, string> = {
    created: 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400',
    running: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    declining: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    stale: 'bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-gray-500',
  }
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${color[stage] ?? color.created}`}>{STAGE_LABEL[stage]}</span>
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 px-3 py-2 dark:border-white/10">
      <p className="text-[11px] text-gray-400">{label}</p>
      <p className="mt-0.5 text-base font-semibold text-gray-800 dark:text-gray-100">{value}</p>
    </div>
  )
}

function ImportTab({
  tasks,
  assets,
  onDone,
  setBusy,
  setError,
}: {
  tasks: TaskRecord[]
  assets: AssetRecord[]
  onDone: () => Promise<void>
  setBusy: (value: string) => void
  setError: (value: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [table, setTable] = useState<SheetTable | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [fileName, setFileName] = useState('')

  const nameIndex = useMemo(() => buildNameIndex(tasks), [tasks])
  const preview = useMemo(() => {
    if (!table || !mapping) return null
    if (mapping.date < 0 || mapping.spend < 0) return null
    return buildSpendRecords(table, mapping, nameIndex, `preview-${Date.now()}`)
  }, [table, mapping, nameIndex])

  const pickFile = async (file: File) => {
    setError('')
    setBusy('正在解析文件…')
    setTable(null)
    setMapping(null)
    try {
      const buffer = await file.arrayBuffer()
      const parsed = /\.csv$/i.test(file.name) ? parseCsv(new TextDecoder('utf-8').decode(buffer)) : parseXlsx(buffer)
      setTable(parsed)
      setMapping(detectMapping(parsed.headers))
      setFileName(file.name)
      setBusy('')
    } catch (err) {
      setError(`解析失败：${err instanceof Error ? err.message : String(err)}`)
      setBusy('')
    }
  }

  const confirmImport = async () => {
    if (!preview || !table) return
    setBusy('正在写入…')
    const importId = `imp-${Date.now().toString(36)}`
    try {
      const result = buildSpendRecords(table, mapping!, nameIndex, importId)
      await trackPutMany('spend', result.records.map((item) => ({ id: item.id, data: item })))

      // 回填台账：平台 ID、最后消耗日
      const touched = new Map<string, AssetRecord>()
      for (const record of result.records) {
        if (!record.assetId) continue
        const asset = touched.get(record.assetId) ?? assets.find((item) => item.id === record.assetId)
        if (!asset) continue
        const next: AssetRecord = {
          ...asset,
          platformIds: asset.platformIds.includes(record.platformId)
            ? asset.platformIds
            : [...asset.platformIds, record.platformId],
          lastSpendDate: !asset.lastSpendDate || record.date > asset.lastSpendDate ? record.date : asset.lastSpendDate,
        }
        touched.set(asset.id, next)
      }
      await trackPutMany('assets', [...touched.values()].map((item) => ({ id: item.id, data: item })))

      const record: ImportRecord = {
        id: importId,
        fileName,
        importedAt: Date.now(),
        rowCount: table.rows.length,
        totalSpend: result.totalSpend,
        matchedCount: result.matchedCount,
        unmatchedCount: result.unmatchedCount,
      }
      await trackPut('imports', record.id, record)

      setBusy(`导入完成：${result.records.length} 条流水，合计 ¥${fmtMoney(result.totalSpend)}，匹配 ${result.matchedCount} / 未匹配 ${result.unmatchedCount}`)
      setTable(null)
      setMapping(null)
      await onDone()
    } catch (err) {
      setError(`导入失败：${String(err)}`)
      setBusy('')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void pickFile(file)
            event.target.value = ''
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600">
          选择报表文件（.xlsx / .csv）
        </button>
        {fileName && <span className="text-xs text-gray-500">{fileName}</span>}
      </div>

      {!table && (
        <p className="text-xs text-gray-400">
          导入后按「平台素材ID」认素材，同一素材同一天重复导入会覆盖而不是叠加，可以放心反复导。
        </p>
      )}

      {table && mapping && (
        <>
          <div className="rounded-xl border border-gray-100 p-3 dark:border-white/10">
            <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">列对应（识别错了就在这里改）</p>
            <div className="grid grid-cols-3 gap-2">
              {FIELD_LABEL.map(([field, label, required]) => (
                <label key={field} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <span className="w-20 shrink-0">
                    {label}
                    {required && <span className="text-red-400">*</span>}
                  </span>
                  <select
                    value={mapping[field]}
                    onChange={(event) => setMapping({ ...mapping, [field]: Number(event.target.value) })}
                    className="min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-1 py-1 text-[11px] dark:border-white/15"
                  >
                    <option value={-1}>（不用）</option>
                    {table.headers.map((header, index) => (
                      <option key={index} value={index}>{header || `第 ${index + 1} 列`}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          {!preview ? (
            <p className="text-xs text-amber-600">「投放日期」和「消耗」是必填，先在上面选好。</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-4 gap-3">
                <Metric label="报表行数" value={String(table.rows.length)} />
                <Metric label="消耗合计" value={`¥${fmtMoney(preview.totalSpend)}`} />
                <Metric label="匹配到素材" value={String(preview.matchedCount)} />
                <Metric label="未匹配" value={String(preview.unmatchedCount)} />
              </div>
              {preview.skipped.length > 0 && (
                <p className="text-[11px] text-amber-600">有 {preview.skipped.length} 行被跳过（多为例行缺失日期），首条原因：{preview.skipped[0].reason}</p>
              )}
              {preview.unmatchedCount > 0 && (
                <p className="text-[11px] text-gray-400">
                  未匹配的会入「待认领」，不影响其他数据。未匹配多说明任务卡里没有对应的交付文件名。
                </p>
              )}
              <button type="button" onClick={confirmImport} className="self-start rounded-lg bg-blue-500 px-4 py-1.5 text-xs text-white hover:bg-blue-600">
                确认导入 {preview.records.length} 条
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StatsTab({
  totalSpend,
  byDate,
  imports,
  byCard,
  assets,
}: {
  totalSpend: number
  byDate: ReturnType<typeof aggregateByDate>
  imports: ImportRecord[]
  byCard: ReturnType<typeof aggregateByCard>
  assets: AssetRecord[]
}) {
  const maxDay = Math.max(1, ...byDate.map((item) => item.spend))
  const cards = [...byCard.values()].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 20)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Metric label="汇总消耗" value={`¥${fmtMoney(totalSpend)}`} />
        <Metric label="投放天数" value={String(byDate.length)} />
        <Metric label="导入批次" value={String(imports.length)} />
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">单日消耗</p>
        {!byDate.length ? (
          <p className="text-xs text-gray-400">还没有数据，先去「导入报表」。</p>
        ) : (
          <div className="flex flex-col gap-1">
            {byDate.slice(-30).map((item) => (
              <div key={item.date} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 shrink-0 font-mono text-gray-500">{item.date}</span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-white/10">
                  <div className="h-full rounded bg-blue-400" style={{ width: `${(item.spend / maxDay) * 100}%` }} />
                </div>
                <span className="w-24 shrink-0 text-right text-gray-600 dark:text-gray-300">¥{fmtMoney(item.spend)}</span>
                <span className="w-16 shrink-0 text-right text-gray-400">{item.assetCount} 素材</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {cards.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">任务卡消耗（前 20）</p>
          <table className="w-full text-[11px]">
            <thead className="text-gray-400">
              <tr className="border-b border-gray-100 dark:border-white/10">
                <th className="py-1 text-left font-normal">任务卡</th>
                <th className="py-1 text-right font-normal">素材数</th>
                <th className="py-1 text-right font-normal">已投放</th>
                <th className="py-1 text-right font-normal">累计消耗</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.cardId} className="border-b border-gray-50 dark:border-white/5">
                  <td className="py-1 font-mono text-gray-600 dark:text-gray-300">{card.cardId}</td>
                  <td className="py-1 text-right text-gray-500">{card.assetCount}</td>
                  <td className="py-1 text-right text-gray-500">{card.activeAssetCount}</td>
                  <td className="py-1 text-right text-gray-700 dark:text-gray-200">¥{fmtMoney(card.totalSpend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-gray-400">共 {assets.length} 个素材</p>
        </div>
      )}

      {imports.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">导入记录</p>
          <div className="flex flex-col gap-1 text-[11px] text-gray-500">
            {[...imports].sort((a, b) => b.importedAt - a.importedAt).slice(0, 10).map((item) => (
              <div key={item.id} className="flex justify-between">
                <span className="truncate">{item.fileName}</span>
                <span>¥{fmtMoney(item.totalSpend)} · 匹配 {item.matchedCount}/{item.rowCount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
