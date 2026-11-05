/**
 * 素材投放跟踪（全屏视图，与画廊 / Agent 同级）。
 *
 * 之所以从弹窗提上来：台账要看几十个素材的缩略图，还要同时挂日期范围和
 * 业务线→产品→方向三层筛选，弹窗那点宽度塞不下。
 *
 * 打开时把四张表读进内存（素材量级在几万以内），所有筛选和聚合都在前端算 ——
 * 存储层刻意做成 id + JSON，就是为了不在这里写第二套 SQL。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { ensureImageCached, ensureImageThumbnailCached } from '../../lib/imageCache'
import { recordLineage } from '../../lib/trackDb'
import { buildDemoBundle, isDemoId, type DemoImageRef } from '../../lib/demoData'
import { useSopStore } from '../../lib/sopStore'
import {
  buildProductTree,
  filterSpendByAssets,
  filterSpendByRange,
  presetRange,
  rangeLabel,
  scopeAssetsForNode,
  type DateRange,
  type RangePreset,
  type TreeNode,
} from '../../lib/trackerFilter'
import { countSimulated, planRestoreMatches, planSimulateMatches } from '../../lib/simulateMatch'
import SopSupplementModal from '../SopSupplementModal'
import type { TaskRecord } from '../../types'
import {
  STAGE_LABEL,
  aggregateByAsset,
  aggregateByCard,
  aggregateByDate,
  assetDailySeries,
  assetImageId,
  buildAssetsFromTasks,
  buildLineageMap,
  descendantCards,
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
  trackDelete,
  trackGetAll,
  trackPut,
  trackPutMany,
  type AssetRecord,
  type ImportRecord,
  type LineageRecord,
  type SpendRecord,
} from '../../lib/trackDb'

type Tab = 'assets' | 'unmatched' | 'import' | 'stats'

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
  ['previewUrl', '预览地址', false],
]

function fmtMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function TrackerWorkspace() {
  const tasks = useStore((state) => state.tasks)
  const [tab, setTab] = useState<Tab>('assets')
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [spend, setSpend] = useState<SpendRecord[]>([])
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [lineage, setLineage] = useState<LineageRecord[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  // 双击预览的大图（null 表示不显示）
  const [viewingImageId, setViewingImageId] = useState<string | null>(null)
  // 从素材详情点「以此为基础再生成」时，把对应任务卡交给补充生成弹窗
  const [derivingTask, setDerivingTask] = useState<TaskRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // 顶层筛选：产品树节点 + 日期范围。两者都是纯展示层筛选，不改库里的数据
  const directions = useSopStore((state) => state.directions)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [range, setRange] = useState<DateRange>(() => presetRange('all'))

  /**
   * 没有对应任务卡的素材数（演示数据、任务卡已删的老数据）。
   *
   * 它们挂不到任何方向上，但确实占着台账和消耗 —— 必须计入「未归属」，
   * 否则用户点任何方向都会发现数字对不上。
   */
  const orphanAssetCount = useMemo(() => {
    const known = new Set((tasks as TaskRecord[]).map((task) => task.id))
    return assets.filter((asset) => !asset.taskId || !known.has(asset.taskId)).length
  }, [tasks, assets])

  const tree = useMemo(
    () => buildProductTree(directions, tasks as TaskRecord[], orphanAssetCount),
    [directions, tasks, orphanAssetCount],
  )
  const scopedAssets = useMemo(
    () => scopeAssetsForNode(assets, tasks as TaskRecord[], directions, tree, selectedNodeId),
    [assets, tasks, directions, tree, selectedNodeId],
  )
  // 先按日期裁流水，再裁成「只属于当前素材」—— 未匹配流水不该混进筛选后的合计
  const rangedSpend = useMemo(() => filterSpendByRange(spend, range), [spend, range])
  const scopedSpend = useMemo(() => filterSpendByAssets(rangedSpend, scopedAssets), [rangedSpend, scopedAssets])

  const byAsset = useMemo(() => aggregateByAsset(scopedSpend), [scopedSpend])
  const byDate = useMemo(() => aggregateByDate(scopedSpend), [scopedSpend])
  const byCard = useMemo(() => aggregateByCard(scopedAssets, byAsset), [scopedAssets, byAsset])
  const lineageMap = useMemo(() => buildLineageMap(lineage), [lineage])
  const selectedAsset = selectedAssetId ? scopedAssets.find((item) => item.id === selectedAssetId) ?? null : null

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, s, i, l] = await Promise.all([
        trackGetAll<AssetRecord>('assets'),
        trackGetAll<SpendRecord>('spend'),
        trackGetAll<ImportRecord>('imports'),
        trackGetAll<LineageRecord>('lineage'),
      ])
      setAssets(a)
      setSpend(s)
      setImports(i)
      setLineage(l)
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

  /**
   * 本地已有的真实图片，供演示数据挂载。
   *
   * 只收已出图、非回收站、非占位卡 —— 占位卡的 outputImages 是空的，
   * 回收站里的图可能已被清理，挂上去只会变成灰块。
   */
  const realImagePool = useMemo<DemoImageRef[]>(() => {
    const pool: DemoImageRef[] = []
    for (const task of tasks as TaskRecord[]) {
      if (task.deletedAt || task.sopPlaceholder) continue
      for (const imageId of task.outputImages ?? []) pool.push({ imageId, taskId: task.id })
    }
    return pool
  }, [tasks])

  /**
   * 填充演示数据。
   *
   * track 版是独立数据目录，新装上是空的 —— 没导入过报表就看不到台账/统计/血缘的效果。
   * 演示数据的 id 全部以 demo- 开头，清除时按前缀删，不会碰到真实数据。
   * 本地有图就挂到真实图上（缩略图能显示），没有才退回编造哈希。
   */
  const fillDemo = async () => {
    setBusy('正在生成演示数据…')
    setError('')
    try {
      const today = new Date().toISOString().slice(0, 10)
      const bundle = buildDemoBundle(today, realImagePool)
      await trackPutMany('assets', bundle.assets.map((item) => ({ id: item.id, data: item })))
      await trackPutMany('spend', bundle.spend.map((item) => ({ id: item.id, data: item })))
      await trackPutMany('lineage', bundle.lineage.map((item) => ({ id: item.id, data: item })))
      await trackPutMany('imports', bundle.imports.map((item) => ({ id: item.id, data: item })))
      await load()
      const picture = bundle.withRealImage > 0
        ? `，其中 ${bundle.withRealImage} 个挂了本地真实图片`
        : '（本地还没有图片，缩略图会显示灰块）'
      setBusy(`已填充 ${bundle.assets.length} 个演示素材${picture}、${bundle.spend.length} 条流水。右上角可一键清除。`)
    } catch (err) {
      setError(`填充演示数据失败：${String(err)}`)
      setBusy('')
    }
  }

  const clearDemo = async () => {
    setBusy('正在清除演示数据…')
    setError('')
    try {
      const kinds: Array<['assets' | 'spend' | 'lineage' | 'imports', string[]]> = [
        ['spend', spend.map((item) => item.id)],
        ['assets', assets.map((item) => item.id)],
        ['lineage', lineage.map((item) => item.id)],
        ['imports', imports.map((item) => item.id)],
      ]
      let removed = 0
      for (const [kind, ids] of kinds) {
        for (const id of ids) {
          if (!isDemoId(id)) continue
          await trackDelete(kind, id)
          removed += 1
        }
      }
      await load()
      setBusy(`已清除 ${removed} 条演示记录`)
    } catch (err) {
      setError(`清除失败：${String(err)}`)
      setBusy('')
    }
  }

  const simulatedCount = useMemo(() => countSimulated(spend), [spend])

  /**
   * 一键模拟关联（调试用）。
   *
   * 导入的报表常常大批对不上本地图，台账里消耗几乎是 0，界面效果没法看。
   * 这里把未匹配的流水轮流挂到本地素材上，全部打上 simulated 标记，可一键还原。
   * 只挂真实素材 —— 演示素材会被清除，真流水挂上去就成了悬空记录。
   */
  const simulateMatches = async () => {
    setBusy('正在模拟关联…')
    setError('')
    try {
      const plan = planSimulateMatches(spend, assets)
      if (!plan.linkedRecords) {
        // 三种情况要分清，否则用户会以为「导入成功但什么都没发生」
        const pending = spend.filter((item) => !item.assetId).length
        if (!assets.length) {
          setBusy('本地还没有素材可挂 —— 先点「扫描任务卡建台账」，或先出几张图')
        } else if (pending) {
          setBusy(`有 ${pending} 条流水认不到本地图，但都没有可挂的素材，先建台账再来`)
        } else {
          setBusy('没有未匹配的流水，全部都已经匹配上了')
        }
        return
      }
      await trackPutMany('spend', plan.spend.map((item) => ({ id: item.id, data: item })))
      await trackPutMany('assets', plan.assets.map((item) => ({ id: item.id, data: item })))
      await load()
      setBusy(
        `已模拟关联 ${plan.linkedPlatforms} 个平台素材、${plan.linkedRecords} 条流水，` +
        `落到 ${plan.usedAssets} 个本地素材上。这是调试数据，可随时还原。`,
      )
    } catch (err) {
      setError(`模拟关联失败：${String(err)}`)
      setBusy('')
    }
  }

  const restoreMatches = async () => {
    setBusy('正在还原模拟关联…')
    setError('')
    try {
      const plan = planRestoreMatches(spend, assets)
      if (!plan.spend.length) {
        setBusy('没有模拟关联需要还原')
        return
      }
      await trackPutMany('spend', plan.spend.map((item) => ({ id: item.id, data: item })))
      await trackPutMany('assets', plan.assets.map((item) => ({ id: item.id, data: item })))
      await load()
      setBusy(`已还原 ${plan.linkedRecords} 条模拟关联，它们回到「待认领」`)
    } catch (err) {
      setError(`还原失败：${String(err)}`)
      setBusy('')
    }
  }

  const demoCount = assets.filter((item) => isDemoId(item.id)).length

  return (
    <main data-home-main className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：页签 + 日期范围 + 调试动作。全屏后不再需要关闭按钮 */}
      <div className="shrink-0 border-b border-gray-100 bg-white/70 px-4 py-2 backdrop-blur dark:border-white/10 dark:bg-gray-950/60">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex gap-1">
            {([['assets', '素材台账'], ['unmatched', '待认领'], ['import', '导入报表'], ['stats', '消耗统计']] as Array<[Tab, string]>).map(([key, label]) => (
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

          {/* 日期范围：起止各一个日期控件，右侧是常用快捷项 */}
          <div className="flex items-center gap-1.5 rounded-lg bg-black/[0.04] px-2 py-1 dark:bg-white/[0.06]">
            <input
              type="date"
              value={range.from}
              onChange={(event) => setRange((prev) => ({ ...prev, from: event.target.value }))}
              className="rounded bg-transparent px-1 py-0.5 text-[11px] text-gray-700 outline-none dark:text-gray-200 dark:[color-scheme:dark]"
              aria-label="开始日期"
            />
            <span className="text-[11px] text-gray-400">至</span>
            <input
              type="date"
              value={range.to}
              onChange={(event) => setRange((prev) => ({ ...prev, to: event.target.value }))}
              className="rounded bg-transparent px-1 py-0.5 text-[11px] text-gray-700 outline-none dark:text-gray-200 dark:[color-scheme:dark]"
              aria-label="结束日期"
            />
            <div className="ml-1 flex gap-0.5">
              {([['today', '今天'], ['7d', '近7天'], ['30d', '近30天'], ['all', '全部']] as Array<[RangePreset, string]>).map(([key, label]) => {
                const preset = presetRange(key)
                const active = preset.from === range.from && preset.to === range.to
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setRange(preset)}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                      active
                        ? 'bg-white text-gray-800 shadow-sm dark:bg-white/15 dark:text-white'
                        : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          <span className="text-[11px] text-gray-400">统计范围：{rangeLabel(range)}</span>

          <div className="ml-auto flex items-center gap-1.5">
            {simulatedCount > 0 ? (
              <button
                type="button"
                onClick={() => void restoreMatches()}
                className="rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-600 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300"
                title="把模拟关联的流水退回未匹配状态，真匹配的记录不受影响"
              >
                还原模拟关联（{simulatedCount}）
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void simulateMatches()}
                className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300"
                title="调试用：把认不到本地图的报表流水临时挂到本地素材上，可一键还原"
              >
                模拟关联
              </button>
            )}
            {demoCount > 0 ? (
              <button
                type="button"
                onClick={() => void clearDemo()}
                className="rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-600 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300"
                title="删掉所有 id 以 demo- 开头的记录，不影响真实数据"
              >
                清除演示数据（{demoCount}）
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void fillDemo()}
                className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300"
                title="生成一批假素材和假消耗，用来看界面效果；id 以 demo- 开头，可一键清除"
              >
                填充演示数据
              </button>
            )}
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
              title="重新读取本地数据"
            >
              刷新
            </button>
          </div>
        </div>

        {(busy || error) && (
          <p className={`mt-1.5 text-[11px] ${error ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>
            {error || busy}
          </p>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* 左侧产品树：业务线 → 产品 → 方向 */}
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-gray-100 px-2 py-3 dark:border-white/10">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">业务线 / 产品 / 方向</span>
            {selectedNodeId && (
              <button
                type="button"
                onClick={() => setSelectedNodeId(null)}
                className="text-[10px] text-blue-500 hover:underline"
              >
                清除
              </button>
            )}
          </div>
          {!tree.length ? (
            <p className="px-1 py-3 text-[11px] leading-relaxed text-gray-400">
              还没有方向。到画廊左侧建好「业务线 → 产品 → 方向」之后，这里就能按层级筛选素材。
            </p>
          ) : (
            <TreeBranch nodes={tree} depth={0} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
          )}
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="py-16 text-center text-xs text-gray-400">正在读取本地数据…</p>
          ) : tab === 'assets' ? (
            <AssetsTab
              assets={scopedAssets}
              byAsset={byAsset}
              byCard={byCard}
              onRebuild={rebuildLedger}
              onSelect={setSelectedAssetId}
              onView={setViewingImageId}
            />
          ) : tab === 'unmatched' ? (
            <UnmatchedTab spend={spend} assets={assets} onDone={load} setBusy={setBusy} setError={setError} />
          ) : tab === 'import' ? (
            <ImportTab
              tasks={tasks as TaskRecord[]}
              assets={assets}
              onDone={load}
              setBusy={setBusy}
              setError={setError}
            />
          ) : (
            <StatsTab
              totalSpend={scopedSpend.reduce((sum, item) => sum + item.spend, 0)}
              byDate={byDate}
              imports={imports}
              byCard={byCard}
              assets={scopedAssets}
            />
          )}
        </div>

        {selectedAsset && (
          <AssetDetail
            asset={selectedAsset}
            tasks={tasks as TaskRecord[]}
            spend={scopedSpend}
            byAsset={byAsset}
            byCard={byCard}
            lineageMap={lineageMap}
            allCards={byCard}
            onDerive={setDerivingTask}
            onRefresh={load}
            onView={setViewingImageId}
            onClose={() => setSelectedAssetId(null)}
          />
        )}
      </div>

      {viewingImageId && (
        <ImageViewer imageId={viewingImageId} onClose={() => setViewingImageId(null)} />
      )}

      {derivingTask && (
        <SopSupplementModal
          task={derivingTask}
          existingCount={derivingTask.outputImages?.length ?? 0}
          onClose={() => setDerivingTask(null)}
        />
      )}
    </main>
  )
}

/** 产品树的一个分支：递归渲染「业务线 → 产品 → 方向」 */
function TreeBranch({
  nodes,
  depth,
  selectedId,
  onSelect,
}: {
  nodes: TreeNode[]
  depth: number
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        const active = selectedId === node.id
        return (
          <div key={node.id}>
            <button
              type="button"
              onClick={() => onSelect(active ? null : node.id)}
              className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] transition ${
                active
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                  : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'
              }`}
              style={{ paddingLeft: 6 + depth * 12 }}
              title={`${node.name}（${node.taskCount} 张卡）`}
            >
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="shrink-0 text-[10px] text-gray-400">{node.taskCount}</span>
            </button>
            {node.children.length > 0 && (
              <TreeBranch nodes={node.children} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
            )}
          </div>
        )
      })}
    </>
  )
}

/** 素材详情抽屉：单张图的日消耗曲线 + 它所属卡的血缘 */
function AssetDetail({
  asset,
  tasks,
  spend,
  byAsset,
  byCard,
  lineageMap,
  allCards,
  onDerive,
  onRefresh,
  onView,
  onClose,
}: {
  asset: AssetRecord
  tasks: TaskRecord[]
  spend: SpendRecord[]
  byAsset: ReturnType<typeof aggregateByAsset>
  byCard: ReturnType<typeof aggregateByCard>
  lineageMap: ReturnType<typeof buildLineageMap>
  allCards: ReturnType<typeof aggregateByCard>
  onDerive: (task: TaskRecord) => void
  onRefresh: () => Promise<void>
  onView: (imageId: string) => void
  onClose: () => void
}) {
  const [src, setSrc] = useState('')
  const [parentPick, setParentPick] = useState('')
  const [linking, setLinking] = useState(false)
  const stat = byAsset.get(asset.id)
  const series = useMemo(() => assetDailySeries(spend, asset.id), [spend, asset.id])
  const maxDay = Math.max(1, ...series.map((item) => item.spend))
  const task = tasks.find((item) => item.id === asset.taskId)
  const cardId = asset.rootCardId ?? asset.taskId ?? ''
  const node = lineageMap.get(cardId)
  // 家族消耗：这张卡 + 它所有后代卡的消耗，才是一套创意的真实投入
  const familyCards = useMemo(() => descendantCards(cardId, lineageMap), [cardId, lineageMap])
  const familySpend = familyCards.reduce((sum, id) => sum + (byCard.get(id)?.totalSpend ?? 0), 0)
  // 模拟关联的条数：让用户知道这个素材的消耗里有多少是调试数据
  const simulatedHere = spend.reduce(
    (count, record) => count + (record.assetId === asset.id && record.simulated ? 1 : 0), 0)

  // 演示素材的 id 是 demo- 开头，真实图片哈希在 imageId 里，必须走 assetImageId
  const previewImageId = assetImageId(asset)

  useEffect(() => {
    let cancelled = false
    ensureImageCached(previewImageId)
      .then((dataUrl) => { if (!cancelled && dataUrl) setSrc(dataUrl) })
      .catch(() => { /* 图被清理了就只显示指标 */ })
    return () => { cancelled = true }
  }, [previewImageId])

  return (
    /*
     * 抽屉不再 absolute 覆盖：它作为 flex 子项把内容区挤窄，
     * 网格的 auto-fill 会自动少一列、卡片等比缩小 ——
     * 覆盖式会把右边那列图片直接盖住，用户看不到也点不到。
     */
    <div className="flex h-full w-[24rem] shrink-0 flex-col border-l border-gray-100 bg-white dark:border-white/10 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5 dark:border-white/10">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">素材详情</span>
        <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/*
          限高是必须的：竖版海报的原始比例接近 1:2，按宽度铺满会占掉整整一屏，
          下面的消耗和血缘全被挤到看不见的地方。contain 保证整张图完整不漏。
        */}
        <button
          type="button"
          onClick={() => onView(previewImageId)}
          className="mb-1.5 flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-gray-50 dark:bg-white/5"
          title="点击查看大图"
        >
          {src
            ? <img src={src} alt="" className="max-h-[38vh] w-full object-contain" />
            : <div className="flex h-28 items-center justify-center text-[11px] text-gray-400">图片已被清理</div>}
        </button>
        {src && <p className="mb-3 text-[10px] text-gray-400">点击图片查看大图</p>}

        <p className="mb-3 break-all font-mono text-[10px] text-gray-400">{asset.id}</p>

        <div className="mb-4 grid grid-cols-3 gap-2">
          <Metric label="累计消耗" value={stat ? `¥${fmtMoney(stat.totalSpend)}` : '-'} />
          <Metric label="投放天数" value={String(stat?.activeDays ?? 0)} />
          <Metric label="日均" value={stat ? `¥${fmtMoney(stat.dailyAverage)}` : '-'} />
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">日消耗</p>
          {!series.length ? (
            <p className="text-[11px] text-gray-400">还没有投放数据</p>
          ) : (
            <div className="flex flex-col gap-1">
              {series.map((item) => (
                <div key={item.date} className="flex items-center gap-2 text-[10px]">
                  <span className="w-16 shrink-0 font-mono text-gray-500">{item.date}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-white/10">
                    <div className="h-full rounded bg-blue-400" style={{ width: `${(item.spend / maxDay) * 100}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right text-gray-600 dark:text-gray-300">¥{fmtMoney(item.spend)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">投放信息</p>
          <div className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <p>阶段：<span className="text-gray-800 dark:text-gray-100">{STAGE_LABEL[stat?.stage ?? 'created']}</span></p>
            <p>最后投放：{stat?.lastDate ?? '-'}</p>
            <p className="break-all">平台素材 ID：{asset.platformIds.length ? asset.platformIds.join('、') : '未匹配'}</p>
            {simulatedHere > 0 && (
              <p className="text-amber-600 dark:text-amber-400">
                其中 {simulatedHere} 条为模拟关联（调试用，未真实匹配）
              </p>
            )}
          </div>
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">来源任务卡</p>
          <p className="break-all font-mono text-[10px] text-gray-500">{cardId || '-'}</p>
          {task && (
            <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-gray-600 dark:text-gray-300">{task.prompt}</p>
          )}
          {task?.sopText ? (
            <button
              type="button"
              onClick={() => onDerive(task)}
              className="mt-2 w-full rounded-lg bg-teal-50 px-3 py-1.5 text-[11px] text-teal-600 hover:bg-teal-100 dark:bg-teal-500/10 dark:text-teal-300"
            >
              以此为基础再生成（自动记为衍生）
            </button>
          ) : (
            <p className="mt-2 text-[10px] text-gray-400">这张卡没有可复用的 SOP，无法直接衍生</p>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">血缘</p>
          {!node ? (
            <p className="text-[11px] text-gray-400">这张卡没有衍生关系</p>
          ) : (
            <div className="flex flex-col gap-1.5 text-[11px]">
              {node.parents.length > 0 && (
                <p className="text-gray-600 dark:text-gray-300">
                  衍生自：
                  {node.parents.map((id) => (
                    <span key={id} className="ml-1 font-mono text-[10px] text-gray-500">
                      {id}（¥{fmtMoney(byCard.get(id)?.totalSpend ?? 0)}）
                    </span>
                  ))}
                </p>
              )}
              {node.children.length > 0 && (
                <p className="text-gray-600 dark:text-gray-300">
                  衍生出 {node.children.length} 张：
                  {node.children.map((id) => (
                    <span key={id} className="ml-1 font-mono text-[10px] text-gray-500">
                      {id}（¥{fmtMoney(byCard.get(id)?.totalSpend ?? 0)}）
                    </span>
                  ))}
                </p>
              )}
              {familyCards.length > 1 && (
                <p className="rounded bg-blue-50 px-2 py-1 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
                  这一套（含衍生）共 {familyCards.length} 张卡，合计 ¥{fmtMoney(familySpend)}
                </p>
              )}
            </div>
          )}

          {/* 手动补挂：历史卡的衍生关系当时没记录，只能人工补 */}
          <div className="mt-2 flex items-center gap-1.5">
            <select
              value={parentPick}
              onChange={(event) => setParentPick(event.target.value)}
              className="min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-1 py-1 text-[10px] dark:border-white/15"
            >
              <option value="">（选母卡，手动补挂）</option>
              {[...allCards.values()]
                .filter((card) => card.cardId !== cardId && !node?.parents.includes(card.cardId))
                .sort((a, b) => b.totalSpend - a.totalSpend)
                .slice(0, 200)
                .map((card) => (
                  <option key={card.cardId} value={card.cardId}>
                    {card.cardId}（¥{fmtMoney(card.totalSpend)}）
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!parentPick || linking}
              onClick={async () => {
                setLinking(true)
                await recordLineage(cardId, parentPick, 'manual')
                await onRefresh()
                setParentPick('')
                setLinking(false)
              }}
              className="shrink-0 rounded bg-gray-900 px-2 py-1 text-[10px] text-white disabled:opacity-40 dark:bg-white dark:text-gray-900"
            >
              挂接
            </button>
          </div>
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
  onSelect,
  onView,
}: {
  assets: AssetRecord[]
  byAsset: ReturnType<typeof aggregateByAsset>
  byCard: ReturnType<typeof aggregateByCard>
  onRebuild: () => void
  onSelect: (assetId: string) => void
  onView: (imageId: string) => void
}) {
  const [stageFilter, setStageFilter] = useState<'all' | 'running' | 'declining' | 'created' | 'stale'>('all')
  /**
   * 单击开详情、双击看大图，两个事件必然一起触发（双击 = 两次 click + 一次 dblclick）。
   * 用一个短延时把单击推后：双击时先取消，就不会出现「详情闪一下再弹大图」。
   */
  const clickTimer = useRef<number | null>(null)
  const selectLater = (assetId: string) => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => onSelect(assetId), 220)
  }
  const cancelSelect = () => {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
  }
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="素材总数" value={String(assets.length)} />
        <Metric label="已投放" value={String(deployed.length)} />
        <Metric label="累计消耗" value={`¥${fmtMoney(totalSpend)}`} />
        <Metric label="任务卡" value={String(byCard.size)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <p className="py-16 text-center text-xs text-gray-400">
          还没有素材记录。点右上角「扫描任务卡建台账」，把已生成的图片收进来。
        </p>
      ) : (
        /*
         * 网格而不是表格：台账最主要的用途是「看图判断这张要不要继续投」，
         * 表格里缩略图只有 44px 宽，根本认不出画面。
         */
        /*
         * auto-fill 而不是固定列数：详情抽屉打开后内容区会变窄，
         * 固定列数会把卡片硬挤扁，auto-fill 会自动少一列、卡片等比缩小。
         */
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
          {rows.slice(0, 300).map(({ asset, stat }) => {
            const stage = stat?.stage ?? 'created'
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => selectLater(asset.id)}
                onDoubleClick={() => {
                  cancelSelect()
                  onView(assetImageId(asset))
                }}
                title="单击看详情，双击看大图"
                className="group flex flex-col overflow-hidden rounded-xl border border-gray-100 bg-white text-left transition hover:border-blue-200 hover:shadow-md dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-blue-500/40"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-gray-50 dark:bg-white/5">
                  {/* contain：海报比例各异，cover 会把竖版两侧的文案裁掉 */}
                  <AssetThumb imageId={assetImageId(asset)} className="h-full w-full object-contain" />
                  <div className="absolute left-1.5 top-1.5">
                    <StageBadge stage={stage} />
                  </div>
                  <div className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
                    {stat ? `¥${fmtMoney(stat.totalSpend)}` : '未投放'}
                  </div>
                </div>
                <div className="flex flex-col gap-1 p-2">
                  <div className="flex items-center justify-between gap-1 text-[10px] text-gray-400">
                    <span className="truncate font-mono">{asset.id.slice(0, 8)}</span>
                    {asset.platformIds.length > 0 && <span className="shrink-0">{asset.platformIds.length} 个ID</span>}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-gray-600 dark:text-gray-300">
                    <span>{stat ? `${stat.activeDays} 天` : '—'}</span>
                    <span>{stat ? `日均 ¥${fmtMoney(stat.dailyAverage)}` : '—'}</span>
                  </div>
                  <p className="truncate text-[10px] text-gray-400">
                    最后投放 {stat?.lastDate ?? '—'}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      )}
      {rows.length > 300 && <p className="text-[11px] text-gray-400">只显示前 300 条（按消耗降序），共 {rows.length} 条</p>}
    </div>
  )
}

/**
 * 素材缩略图。
 *
 * 列表里只显示哈希前 8 位的话，用户根本认不出是哪张图，
 * 所以每行补一个缩略图。逐行自己异步加载、卸载即取消 ——
 * 不用 IntersectionObserver 是因为这里最多渲染 200 行，
 * 缩略图本身有缓存，重复打开不会重复解码。
 */
function AssetThumb({
  imageId,
  className = 'h-8 w-11 rounded object-contain',
}: {
  imageId: string
  /** 尺寸交给调用方：表格里是小方图，网格卡片里要铺满 */
  className?: string
}) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    ensureImageThumbnailCached(imageId)
      .then((thumbnail) => {
        if (!cancelled && thumbnail) setSrc(thumbnail.src)
      })
      .catch(() => { /* 缩略图加载失败不影响台账 */ })
    return () => { cancelled = true }
  }, [imageId])
  return src
    ? <img src={src} alt="" className={className} />
    : (
      <div className={`${className} flex items-center justify-center bg-gray-100 dark:bg-white/10`}>
        <svg className="h-1/3 max-h-6 w-1/3 max-w-6 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M4 16l4.5-4.5a2 2 0 012.8 0L16 16m-2-2l1.5-1.5a2 2 0 012.8 0L20 14M4 6h16v12H4z" />
        </svg>
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

/**
 * 待认领：报表里有、但认不到本地图的平台素材。
 *
 * 为什么必须有这一块：平台报表里常有一批行没有图片名称（这份报表就有 1828 行），
 * 只靠文件名匹配永远认不到。这些数据本身是有效的（消耗合计里有它们），
 * 让用户手动挂到某张图上，比直接丢掉或永远悬着实用。
 *
 * 绑定是按「平台素材ID」整体绑的：同一个平台 ID 在后续每天的报表里还会出现，
 * 绑一次之后，那天的记录也会一起归到这张图上。
 */
function UnmatchedTab({
  spend,
  assets,
  onDone,
  setBusy,
  setError,
}: {
  spend: SpendRecord[]
  assets: AssetRecord[]
  onDone: () => Promise<void>
  setBusy: (value: string) => void
  setError: (value: string) => void
}) {
  const [picked, setPicked] = useState<Record<string, string>>({})

  const groups = useMemo(() => {
    const map = new Map<string, { platformId: string; spend: number; days: number; dates: string[] }>()
    for (const record of spend) {
      if (record.assetId) continue
      const entry = map.get(record.platformId) ?? { platformId: record.platformId, spend: 0, days: 0, dates: [] }
      entry.spend += record.spend
      entry.dates.push(record.date)
      map.set(record.platformId, entry)
    }
    for (const entry of map.values()) {
      entry.spend = Math.round(entry.spend * 100) / 100
      entry.days = new Set(entry.dates).size
    }
    return [...map.values()].sort((a, b) => b.spend - a.spend)
  }, [spend])

  const bind = async (platformId: string) => {
    const assetId = picked[platformId]
    if (!assetId) return
    setBusy('正在绑定…')
    setError('')
    try {
      const targets = spend.filter((item) => item.platformId === platformId && !item.assetId)
      for (const record of targets) {
        await trackPut('spend', record.id, { ...record, assetId })
      }
      const asset = assets.find((item) => item.id === assetId)
      if (asset) {
        const lastDate = targets.reduce<string | undefined>(
          (acc, item) => (!acc || item.date > acc ? item.date : acc), asset.lastSpendDate)
        await trackPut('assets', asset.id, {
          ...asset,
          platformIds: asset.platformIds.includes(platformId) ? asset.platformIds : [...asset.platformIds, platformId],
          lastSpendDate: lastDate,
          firstSeenAt: asset.firstSeenAt ?? Date.now(),
        })
      }
      setBusy(`已把平台素材 ${platformId} 绑到 ${assetId.slice(0, 8)}（${targets.length} 条流水）`)
      await onDone()
    } catch (err) {
      setError(`绑定失败：${String(err)}`)
      setBusy('')
    }
  }

  const totalSpend = groups.reduce((sum, item) => sum + item.spend, 0)

  if (!groups.length) {
    return (
      <div className="py-10 text-center text-xs text-gray-400">
        <p>没有待认领的数据。导入报表后，认不到本地图的素材会出现在这里。</p>
        <p className="mt-2 text-[11px] text-gray-400">
          如果刚导入就一条都没有，可能是报表已经全部匹配上，也可能还没导报表 ——
          想看台账效果可以先点右上角的「模拟关联」（调试用，可一键还原）。
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        这 {groups.length} 个平台素材合计 ¥{fmtMoney(totalSpend)}，认不到对应的本地图片。
        报表里它们没有「图片名称」，只能你手动指定。绑定后同一平台素材以后每天的消耗都会自动归到这张图。
      </p>
      <table className="w-full text-xs">
        <thead className="text-gray-400">
          <tr className="border-b border-gray-100 dark:border-white/10">
            <th className="py-1.5 text-left font-normal">平台素材ID</th>
            <th className="py-1.5 text-right font-normal">累计消耗</th>
            <th className="py-1.5 text-right font-normal">天数</th>
            <th className="py-1.5 text-left font-normal">绑定到</th>
            <th className="py-1.5" />
          </tr>
        </thead>
        <tbody>
          {groups.slice(0, 100).map((group) => (
            <tr key={group.platformId} className="border-b border-gray-50 dark:border-white/5">
              <td className="py-1.5 font-mono text-gray-600 dark:text-gray-300">{group.platformId}</td>
              <td className="py-1.5 text-right text-gray-700 dark:text-gray-200">¥{fmtMoney(group.spend)}</td>
              <td className="py-1.5 text-right text-gray-500">{group.days}</td>
              <td className="py-1.5">
                <select
                  value={picked[group.platformId] ?? ''}
                  onChange={(event) => setPicked({ ...picked, [group.platformId]: event.target.value })}
                  className="w-full max-w-[16rem] rounded border border-gray-200 bg-transparent px-1 py-1 text-[11px] dark:border-white/15"
                >
                  <option value="">（选一个素材）</option>
                  {assets.slice(0, 500).map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.id.slice(0, 8)}</option>
                  ))}
                </select>
              </td>
              <td className="py-1.5 text-right">
                <button
                  type="button"
                  disabled={!picked[group.platformId]}
                  onClick={() => void bind(group.platformId)}
                  className="rounded bg-blue-500 px-2 py-0.5 text-[11px] text-white hover:bg-blue-600 disabled:opacity-40"
                >
                  绑定
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {groups.length > 100 && <p className="text-[11px] text-gray-400">只显示前 100 个（按消耗降序），共 {groups.length} 个</p>}
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

/**
 * 大图查看器。
 *
 * 双击网格卡片、或点详情里的图打开。图片按 contain 铺满可视区，**不裁切** ——
 * 海报文案常常贴着边，裁掉就判断不了这张图能不能用。
 * Esc / 点背景 / 点右上角都能关。
 */
function ImageViewer({ imageId, onClose }: { imageId: string; onClose: () => void }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    ensureImageCached(imageId)
      .then((dataUrl) => {
        if (cancelled) return
        if (dataUrl) setSrc(dataUrl)
        else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [imageId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="max-h-full max-w-full rounded object-contain shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <p className="text-xs text-white/60">
          {failed ? '图片已被清理，或本地没有这张图' : '正在加载…'}
        </p>
      )}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/80 hover:bg-white/20"
      >
        关闭（Esc）
      </button>
      <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[10px] text-white/40">
        {imageId.slice(0, 16)}
      </p>
    </div>
  )
}
