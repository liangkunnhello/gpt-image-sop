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
import { recordLineage, trackSpendLatest, trackSpendRange } from '../../lib/trackDb'
import { groupAssetsByContent, planDuplicateHashes, remapSpendAssetIds } from '../../lib/assetDedupe'
import { getImageFile, getImageStats } from '../../lib/dbTauri'
import { isTauri } from '../../lib/platform'
// 消耗展示：整元 + 千分位，不足 1 元才带两位（见 lib/formatMoney.ts）
import { formatSpend as fmtMoney } from '../../lib/formatMoney'
import { buildDemoBundle, isDemoId, type DemoImageRef } from '../../lib/demoData'
import { useSopStore } from '../../lib/sopStore'
import {
  buildProductTree,
  filterSpendByAssets,
  filterSpendByRange,
  presetRange,
  rangeLabel,
  scopeAssetsForNode,
  shiftDate,
  type DateRange,
  type TreeNode,
} from '../../lib/trackerFilter'
import { countSimulated, planRestoreMatches, planSimulateMatches } from '../../lib/simulateMatch'
import { buildAssetFileIndex, matchAssetKeyword, matchReportRowKeyword, normalizeKeyword, type AssetFileInfo } from '../../lib/assetSearch'
import { matchDirectionByPath, planAutoDirections, planMissingNodes } from '../../lib/assetDirection'
import SopSupplementModal from '../SopSupplementModal'
import DateRangePicker from './DateRangePicker'
import type { SopDirectionNode, TaskRecord } from '../../types'
import {
  STAGE_LABEL,
  aggregateByAsset,
  aggregateByCard,
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
  resolveMapping,
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

type Tab = 'assets' | 'unmatched' | 'import'

/**
 * 台账的两种看法：网格看图、列表看数。
 *
 * 素材台账和素材报表本来就是同一份数据（同一批素材 + 同一批流水），
 * 只是网格适合挑图、列表适合对账。拆成两个页签会导致「切过去筛选条件全丢」，
 * 所以并成一页，视图切换放在投放状态旁边。
 */
type LedgerView = 'grid' | 'list'

/** 页签挪到右侧后，左边空着不好看：给每个页签补一句这页在干什么 */
const TAB_HINT: Record<Tab, string> = {
  assets: '',
  unmatched: '报表里有、但认不到本地图的平台素材',
  import: '把平台的素材报表明细导进来（可多选 / 整个文件夹）',
}

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


/**
 * 投放跟踪整页。
 *
 * `hidden` 为 true 时不卸载、只 display:none —— 页签、日期区间、选中的树节点、
 * 素材详情、滚动位置全是组件内 state，切去画廊再回来卸载重挂就全重置了。
 * 首次进入前由 App 决定要不要挂载（避免启动时白查一遍库）。
 */
export default function TrackerWorkspace({ hidden = false }: { hidden?: boolean }) {
  const tasks = useStore((state) => state.tasks)
  /** 交付文件名索引：台账与报表的「按文件名搜索」共用同一份，口径才一致 */
  const fileIndex = useMemo(() => buildAssetFileIndex(tasks as TaskRecord[]), [tasks])
  const [tab, setTab] = useState<Tab>('assets')
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [spend, setSpend] = useState<SpendRecord[]>([])
  const [imports, setImports] = useState<ImportRecord[]>([])
  /**
   * 库里最新一条流水的日期。
   *
   * 界面按区间取数，所以「导入了却看不到」几乎总是这个原因：数据在库里，
   * 但落在当前区间之外（比如手工把范围停在 11-04，导入的是 11-05）。
   * 有这个值就能直接提示，而不是让用户怀疑导入失败。
   */
  const [latestSpendDate, setLatestSpendDate] = useState<string | null>(null)
  /**
   * 批量导入逐文件对账结果。
   *
   * 放在父组件而不是导入页签里：导入完成会调 `reload()`，`loading` 一为真
   * 页签整块就被「正在读取…」替换掉，子组件状态全丢 —— 用户刚导完想看
   * 每个文件的结果，回头发现表没了。
   */
  const [importResults, setImportResults] = useState<FileResult[]>([])
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
  const [ledgerView, setLedgerView] = useState<LedgerView>('grid')
  /**
   * 折叠起来的树节点。
   *
   * 默认全展开（和画廊一致），但一个产品底下几十个方向时太占地方，
   * 所以每个有子级的节点前面都有箭头，顶部还有「全部收起」。
   */
  const [foldedNodes, setFoldedNodes] = useState<Set<string>>(() => new Set())
  const toggleNode = (id: string) => {
    setFoldedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  /*
   * 默认「近 7 天」而不是「全部时间」：每天一份报表，几个月就是几十万条流水，
   * 一进页面就全量读会把 webview 拖住。想看更长区间上面有「近30天 / 全部」。
   */
  const [range, setRange] = useState<DateRange>(() => presetRange('7d'))
  /**
   * 台账的阶段筛选。
   *
   * 提到父组件是因为它渲染在固定头部那行（和页签同一行）—— 那部分不在滚动容器里，
   * 不能由 AssetsTab 自己持有。
   */
  const [stageFilter, setStageFilter] = useState<'all' | 'running' | 'declining' | 'created' | 'stale'>('all')

  /**
   * 素材 → 方向（任务卡优先，其次素材自己的 directionId）。
   *
   * 和 `scopeAssetsForNode` 里的判定保持一致：两边算得不一样，会出现
   * 「树上说未归属、点开又能筛到」这种自相矛盾。
   */
  const directionIdOf = useMemo(() => {
    const taskById = new Map((tasks as TaskRecord[]).map((task) => [task.id, task]))
    const alive = new Set(directions.filter((node) => !node.deletedAt).map((node) => node.id))
    return (asset: AssetRecord): string | undefined => {
      const fromTask = asset.taskId ? taskById.get(asset.taskId)?.sopDirectionId : undefined
      if (fromTask && alive.has(fromTask)) return fromTask
      return asset.directionId && alive.has(asset.directionId) ? asset.directionId : undefined
    }
  }, [tasks, directions])

  /**
   * 没有任务卡、靠 directionId 归属的素材数（方向 id → 数量）。
   *
   * 任务卡已经带了方向的那批会计入节点原本的 taskCount，这里只补「没人算过」的，
   * 否则同一个方向会被算两遍。
   */
  const externalCountByDirection = useMemo(() => {
    const taskById = new Map((tasks as TaskRecord[]).map((task) => [task.id, task]))
    const map = new Map<string, number>()
    for (const asset of assets) {
      if (asset.taskId && taskById.get(asset.taskId)?.sopDirectionId) continue
      if (!asset.directionId) continue
      map.set(asset.directionId, (map.get(asset.directionId) ?? 0) + 1)
    }
    return map
  }, [assets, tasks])

  /**
   * 既没有任务卡、也没有 directionId 的素材（演示数据、任务卡已删的老数据、
   * 分类路径没匹配上的外部素材）。
   *
   * 它们挂不到任何方向上，但确实占着台账和消耗 —— 必须计入「未归属」，
   * 否则用户点任何方向都会发现数字对不上。
   */
  const orphanAssetCount = useMemo(
    () => assets.filter((asset) => !directionIdOf(asset)).length,
    [assets, directionIdOf],
  )

  const tree = useMemo(
    () => buildProductTree(directions, tasks as TaskRecord[], orphanAssetCount, externalCountByDirection),
    [directions, tasks, orphanAssetCount, externalCountByDirection],
  )

  /** 所有「有子级」的节点 id：给「全部收起 / 全部展开」用 */
  const foldableIds = useMemo(() => {
    const ids: string[] = []
    const walk = (list: TreeNode[]) => {
      for (const node of list) {
        if (!node.children.length) continue
        ids.push(node.id)
        walk(node.children)
      }
    }
    walk(tree)
    return ids
  }, [tree])
  const scopedAssets = useMemo(
    () => scopeAssetsForNode(assets, tasks as TaskRecord[], directions, tree, selectedNodeId),
    [assets, tasks, directions, tree, selectedNodeId],
  )
  // 先按日期裁流水，再裁成「只属于当前素材」—— 未匹配流水不该混进筛选后的合计
  const rangedSpend = useMemo(() => filterSpendByRange(spend, range), [spend, range])
  const scopedSpend = useMemo(() => filterSpendByAssets(rangedSpend, scopedAssets), [rangedSpend, scopedAssets])
  /**
   * 素材报表单独用一份流水：**保留未匹配的**。
   *
   * 报表回答的是「钱花在哪个素材上」，认不到本地图的平台素材也是素材；
   * 按 scopedSpend 剔掉它们，导完一批对不上命名的报表，报表页就是空白。
   * 选了具体方向节点时不保留 —— 那时未匹配流水没有任何归属信息，留着会让合计对不上。
   */
  const reportSpend = useMemo(
    () => filterSpendByAssets(rangedSpend, scopedAssets, !selectedNodeId),
    [rangedSpend, scopedAssets, selectedNodeId],
  )

  /**
   * 同图多份的合并：素材 id → 内容哈希。
   *
   * 生成图入库后文件被后处理重写过、id 不变，NAS 再导入同一张成品图就会多一条素材，
   * 消耗也被拆开。这里按文件内容算 sha256，把同一张图归到同一个 key 上。
   * 只处理「字节数相同」的候选，1 万多条素材不至于全读一遍；网页版读不到字节，直接跳过。
   */
  const [hashById, setHashById] = useState<Map<string, string>>(() => new Map())
  const dedupeSignature = useRef('')
  useEffect(() => {
    if (!isTauri || !assets.length) return
    const signature = `${assets.length}:${assets.reduce((sum, asset) => sum + asset.platformIds.length, 0)}`
    if (dedupeSignature.current === signature) return
    dedupeSignature.current = signature
    let cancelled = false
    void (async () => {
      try {
        const stats = await getImageStats()
        const bytesById = new Map(stats.map((item) => [item.id, item.bytes]))
        const plan = await planDuplicateHashes(assets, bytesById, async (imageId) => {
          const file = await getImageFile(imageId)
          if (!file) return undefined
          // 先取出独立的 ArrayBuffer：bytes 是共享底层缓冲的视图，直接传给 digest 类型不兼容
          const buffer = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer
          const digest = await crypto.subtle.digest('SHA-256', buffer)
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        })
        if (cancelled) return
        setHashById(plan.hashById)
        if (!plan.updates.length) return
        const patch = new Map(plan.updates.map((item) => [item.assetId, item.contentHash]))
        const patched = assets.filter((asset) => patch.has(asset.id)).map((asset) => ({ ...asset, contentHash: patch.get(asset.id)! }))
        await trackPutMany('assets', patched.map((item) => ({ id: item.id, data: item })))
        if (!cancelled) setAssets((prev) => prev.map((asset) => (patch.has(asset.id) ? { ...asset, contentHash: patch.get(asset.id)! } : asset)))
      } catch (err) {
        // 去重失败不能拖垮台账：照旧按素材 id 展示
        console.warn('按内容去重失败（不影响其它功能）：', err)
      }
    })()
    return () => { cancelled = true }
  }, [assets, setAssets])

  const contentScopedSpend = useMemo(() => remapSpendAssetIds(scopedSpend, hashById), [scopedSpend, hashById])
  const contentReportSpend = useMemo(() => remapSpendAssetIds(reportSpend, hashById), [reportSpend, hashById])

  const byAsset = useMemo(() => aggregateByAsset(contentScopedSpend), [contentScopedSpend])
  const byCard = useMemo(() => aggregateByCard(scopedAssets, byAsset), [scopedAssets, byAsset])
  const lineageMap = useMemo(() => buildLineageMap(lineage), [lineage])
  const selectedAsset = selectedAssetId ? scopedAssets.find((item) => item.id === selectedAssetId) ?? null : null

  /** 顶部指标算在父组件：那一行在固定头部，不跟着卡片区滚 */
  const deployedCount = useMemo(
    () => scopedAssets.filter((asset) => byAsset.has(asset.id)).length,
    [scopedAssets, byAsset],
  )
  const rangeSpend = useMemo(
    () => [...byAsset.values()].reduce((sum, item) => sum + item.totalSpend, 0),
    [byAsset],
  )

  /**
   * 只读当前日期区间的消耗流水。
   *
   * 以前是 `trackGetAll('spend')` 全表拉：几百万行会被拼成一个几 GB 的字符串传进 webview，
   * 直接 OOM。改成按区间查之后走 `track_spend_date` 索引，日常只加载看的那几十天。
   */
  /**
   * 读库。
   *
   * `silent` 用于「切回投放跟踪」时的补刷：不把整页换成「正在读取…」，
   * 否则页签内容会被替换掉、素材详情跟着卸载，等于又把状态重置了一次。
   */
  const load = useCallback(async (from: string, to: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true
    if (!silent) setLoading(true)
    try {
      const [a, s, i, l, latest] = await Promise.all([
        trackGetAll<AssetRecord>('assets'),
        trackSpendRange<SpendRecord>(from, to),
        trackGetAll<ImportRecord>('imports'),
        trackGetAll<LineageRecord>('lineage'),
        // 多一次轻量查询（走索引），换「有没有新数据没进区间」的判断
        trackSpendLatest().catch(() => null),
      ])
      setLatestSpendDate(latest)
      /*
       * 读出来之后顺手补一次「外部素材的方向归属」。
       *
       * NAS 接进来的素材没有任务卡，方向只能靠分类路径算（`planAutoDirections`）。
       * 放在加载阶段而不是按钮里：用户点什么都不用做，打开就是归好类的。
       * 没配方向 / 人工改过的都不会被覆盖，所以这一步可以每次都跑。
       */
      const sopDirs = useSopStore.getState().directions
      const assigned = planAutoDirections(a, sopDirs)
      if (assigned.length) {
        try {
          await trackPutMany('assets', assigned.map((item) => ({ id: item.id, data: item })))
          const byId = new Map(assigned.map((item) => [item.id, item]))
          setAssets(a.map((item) => byId.get(item.id) ?? item))
        } catch (err) {
          console.warn('自动归属方向失败（不影响其它数据）：', err)
          setAssets(a)
        }
      } else {
        setAssets(a)
      }
      setSpend(s)
      setImports(i)
      setLineage(l)
    } catch (err) {
      setError(`读取本地数据失败：${String(err)}`)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  /** 供子组件回调用的无参版本：固定按当前区间重读 */
  const reload = useCallback(() => load(range.from, range.to), [load, range.from, range.to])

  useEffect(() => { void reload() }, [reload])

  /**
   * 从画廊切回来时静默补一次数据。
   *
   * 组件常驻之后不会再重挂，不补刷的话看到的是上次加载时的库：
   * 期间新生成、新关联的素材不会出现。静默刷只更新数据，页签、筛选、
   * 选中的素材和滚动位置都不动。
   */
  const wasHidden = useRef(hidden)
  useEffect(() => {
    if (wasHidden.current && !hidden) void load(range.from, range.to, { silent: true })
    wasHidden.current = hidden
  }, [hidden, load, range.from, range.to])

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
      await reload()
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
      await reload()
      setBusy(`已清除 ${removed} 条演示记录`)
    } catch (err) {
      setError(`清除失败：${String(err)}`)
      setBusy('')
    }
  }

  /** 还能自动归属多少张（人工设定过、路径匹配不上的不算） */
  const autoAssignPending = useMemo(() => planAutoDirections(assets, directions).length, [assets, directions])

  /**
   * 按 NAS 分类路径重新算一遍归属。
   *
   * 加载时会自动跑一次，这个按钮是给「刚在左边树里新建/改名了产品方向」用的：
   * 树一变，原来匹配不上的路径可能就对上了。
   */
  const runAutoAssign = async () => {
    setBusy('正在按分类路径归属…')
    setError('')
    try {
      const updates = planAutoDirections(assets, directions)
      if (!updates.length) {
        setBusy('没有需要自动归属的素材（人工设定过的、分类路径匹配不上的都会跳过）')
        return
      }
      await trackPutMany('assets', updates.map((item) => ({ id: item.id, data: item })))
      const byId = new Map(updates.map((item) => [item.id, item]))
      setAssets(assets.map((item) => byId.get(item.id) ?? item))
      setBusy(`已按分类路径归属 ${updates.length} 个素材`)
    } catch (err) {
      setError(`自动归属失败：${String(err)}`)
    }
  }

  /**
   * 分类目录里有、方向树里没有的产品/方向。
   *
   * 采集工具的目录比手建的树细得多（卡券/QQ阅读-25元/插画、淘宝联盟/购物…），
   * 这些素材有报表名、有消耗，就是没地方挂。算出来让用户一键补建。
   */
  const missingPlan = useMemo(() => planMissingNodes(assets, directions), [assets, directions])

  /** 按计划补建业务线/产品/方向，建完立刻按路径归属（加载时会自动跑一遍） */
  const createMissingNodes = async () => {
    const plan = missingPlan
    const total = plan.categories.length + plan.products.length + plan.directions.length
    if (!total) {
      setBusy('没有缺失的产品/方向（未知、_待确认 这类目录不会建）')
      return
    }
    const samples = [
      ...plan.categories.map((name) => `业务线「${name}」`),
      ...plan.products.map((item) => `产品「${item.category}/${item.name}」`),
      ...plan.directions.map((item) => `方向「${item.product}/${item.name}」`),
    ]
    const preview = `${samples.slice(0, 6).join('、')}${samples.length > 6 ? ` 等 ${samples.length} 个` : ''}`
    const ok = window.confirm(
      `将补建 ${plan.categories.length} 个业务线、${plan.products.length} 个产品、${plan.directions.length} 个方向，`
      + `涉及 ${plan.assetCount} 张素材：\n\n${preview}\n\n建完可以随时在左边树里改名或移动。确定？`,
    )
    if (!ok) return
    setBusy('正在补建方向树节点…')
    setError('')
    try {
      const store = useSopStore.getState()
      /** 现查现建：addNode 之后 store 已经更新，按名字能立刻拿到新节点 */
      const findId = (kind: 'category' | 'product' | 'direction', name: string, parentId?: string) =>
        useSopStore.getState().directions.find((node) => (
          node.kind === kind
          && !node.deletedAt
          && node.name.trim() === name.trim()
          // 只有方向是按「挂在哪个产品下」区分的；业务线和产品按名字唯一
          && (kind !== 'direction' || (node.parentId ?? '') === (parentId ?? ''))
        ))?.id

      for (const name of plan.categories) {
        if (!findId('category', name)) store.addNode(null, name, 'category')
      }
      for (const item of plan.products) {
        if (findId('product', item.name)) continue
        const categoryId = findId('category', item.category)
        store.addNode(categoryId ?? null, item.name, 'product')
      }
      for (const item of plan.directions) {
        const productId = findId('product', item.product)
        if (!productId) continue
        if (findId('direction', item.name, productId)) continue
        store.addNode(productId, item.name, 'direction')
      }
      await reload()
      setBusy(`已补建方向树节点，并按分类路径归属了 ${plan.assetCount} 张素材`)
    } catch (err) {
      setError(`补建节点失败：${String(err)}`)
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
      await reload()
      setBusy(
        `已模拟关联 ${plan.linkedPlatforms} 个平台素材、${plan.linkedRecords} 条流水，` +
        `落到 ${plan.usedAssets} 个本地素材上（仅当前日期范围）。这是调试数据，可随时还原。`,
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
      await reload()
      setBusy(`已还原 ${plan.linkedRecords} 条模拟关联（仅当前日期范围），它们回到「待认领」`)
    } catch (err) {
      setError(`还原失败：${String(err)}`)
      setBusy('')
    }
  }

  /**
   * 改区间。
   *
   * 「全部时间」会把库里所有流水读进内存（33 天就是 29 万条、113MB 的 JSON），
   * 当前已经加载了很多行时先问一句 —— 用户知道自己在干什么就继续。
   */
  const changeRange = (next: DateRange) => {
    const toAll = !next.from && !next.to && Boolean(range.from || range.to)
    if (toAll && spend.length > 20000 && !window.confirm(
      `「全部时间」会把库里所有消耗流水读进内存（当前已加载 ${spend.length.toLocaleString('zh-CN')} 条），可能要等几秒。确定吗？`,
    )) return
    setRange(next)
  }

  const demoCount = assets.filter((item) => isDemoId(item.id)).length

  return (
    <main data-home-main className={hidden ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
      {/*
       * 固定区（截图里的「蓝框」）：日期 + 台账指标 + 筛选/页签，全部不随内容滚动。
       *
       * 原来指标和阶段筛选是放在滚动容器里的，往下翻卡片时它们会一起滚走 ——
       * 「现在看的是哪个区间、筛了哪一类」这种随时要看的信息不该跟着滚。
       * 现在只有下面的卡片区滚动。
       */}
      <div className="relative z-30 shrink-0 border-b border-gray-100 bg-white/70 px-4 py-2 backdrop-blur dark:border-white/10 dark:bg-gray-950/60">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* 日期区间收进面板：快捷项（今天/近7天/近30天/全部）挪到面板左侧，工具条只留一个按钮 */}
          <DateRangePicker value={range} onChange={changeRange} />

          <span className="text-[11px] text-gray-400">
            统计范围：{rangeLabel(range)}
            <span className="ml-1.5 text-gray-300 dark:text-gray-600">|</span>
            <span className="ml-1.5">{spend.length.toLocaleString('zh-CN')} 条流水</span>
            {latestSpendDate && (
              <>
                <span className="ml-1.5 text-gray-300 dark:text-gray-600">|</span>
                <span className="ml-1.5">库里最新 {latestSpendDate.slice(5)}</span>
              </>
            )}
          </span>

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
              onClick={() => void reload()}
              className="rounded-lg px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
              title="重新读取本地数据"
            >
              刷新
            </button>
          </div>
        </div>

        {/*
          「导入成功了，怎么数字没变」——九成是数据落在当前区间之外。
          导入口子有三个（界面、命令行、采集工具钩子），后两个不会经过界面的
          切区间逻辑，所以这里统一兜住：只要库里有比区间上限更新的流水就提示。
        */}
        {latestSpendDate && range.to && latestSpendDate > range.to && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            <span>
              库里已有 <b className="font-mono font-medium">{latestSpendDate}</b> 的流水，当前区间只到{' '}
              <b className="font-mono font-medium">{range.to}</b>
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setRange({ from: latestSpendDate, to: latestSpendDate })}
                className="rounded bg-amber-500 px-1.5 py-0.5 text-white hover:bg-amber-600"
              >
                只看这天
              </button>
              <button
                type="button"
                onClick={() => setRange(presetRange('7d'))}
                className="rounded border border-amber-300 px-1.5 py-0.5 hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15"
              >
                切到近 7 天
              </button>
            </span>
          </div>
        )}

        {(busy || error) && (
          <p className={`mt-1.5 text-[11px] ${error ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>
            {error || busy}
          </p>
        )}

        {tab === 'assets' && (
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="素材总数" value={String(scopedAssets.length)} />
            <Metric label="已投放" value={String(deployedCount)} />
            <Metric label="区间消耗" value={`¥${fmtMoney(rangeSpend)}`} />
            <Metric label="任务卡" value={String(byCard.size)} />
          </div>
        )}

        {/* 左侧是本页的操作/说明，右侧是页签 —— 页签原来占着日期那一行，挪下来以后工具条只放日期 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {tab !== 'assets' && (
            <p className="text-[11px] text-gray-400">{TAB_HINT[tab]}</p>
          )}
          {tab === 'assets' && (
            <>
              {/* 投放状态：五个按钮平铺太占地方，改成下拉；网格和列表共用同一个筛选值 */}
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                投放状态
                <select
                  value={stageFilter}
                  onChange={(event) => setStageFilter(event.target.value as typeof stageFilter)}
                  className="rounded-lg border border-gray-200 bg-transparent px-1.5 py-1 text-[11px] text-gray-700 outline-none dark:border-white/15 dark:text-gray-200"
                >
                  <option value="all">全部</option>
                  {(['running', 'declining', 'stale', 'created'] as const).map((key) => (
                    <option key={key} value={key}>{STAGE_LABEL[key]}</option>
                  ))}
                </select>
              </label>

              {/* 视图切换：网格挑图 / 列表对账 */}
              <div className="flex rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
                {([['grid', '网格'], ['list', '列表']] as Array<[LedgerView, string]>).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setLedgerView(key)}
                    className={`rounded-md px-2 py-0.5 text-[11px] transition ${
                      ledgerView === key
                        ? 'bg-white text-gray-800 shadow-sm dark:bg-white/15 dark:text-white'
                        : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="flex gap-1">
              {([['assets', '素材台账'], ['unmatched', '待认领'], ['import', '导入报表']] as Array<[Tab, string]>).map(([key, label]) => (
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

            {tab === 'assets' && (
              <>
                <button
                  type="button"
                  onClick={() => void runAutoAssign()}
                  className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/5"
                  title="按 NAS 分类路径（产品/方向目录名）把外部素材归到方向；人工设定过的不会动"
                >
                  按路径归属{autoAssignPending > 0 ? `（${autoAssignPending}）` : ''}
                </button>
                {(missingPlan.categories.length + missingPlan.products.length + missingPlan.directions.length) > 0 && (
                  <button
                    type="button"
                    onClick={() => void createMissingNodes()}
                    className="rounded-lg border border-amber-300 px-2.5 py-1 text-xs text-amber-600 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10"
                    title="分类目录里有、方向树里还没有的产品/方向，一键补建后自动归属"
                  >
                    补建节点（{missingPlan.products.length + missingPlan.directions.length}）
                  </button>
                )}
                <button
                  type="button"
                  onClick={rebuildLedger}
                  className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
                >
                  扫描任务卡建台账
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* 左侧产品树：业务线 → 产品 → 方向 */}
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-gray-100 px-2 py-3 dark:border-white/10">
          <div className="mb-1.5 flex items-center justify-between gap-1 px-1">
            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">业务线 / 产品 / 方向</span>
            <div className="flex shrink-0 items-center gap-1.5">
              {foldableIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFoldedNodes(foldedNodes.size ? new Set() : new Set(foldableIds))}
                  className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  title={foldedNodes.size ? '展开所有节点' : '只留业务线和产品，收起所有方向'}
                >
                  {foldedNodes.size ? '全部展开' : '全部收起'}
                </button>
              )}
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
          </div>
          {!tree.length ? (
            <p className="px-1 py-3 text-[11px] leading-relaxed text-gray-400">
              还没有方向。到画廊左侧建好「业务线 → 产品 → 方向」之后，这里就能按层级筛选素材。
            </p>
          ) : (
            <TreeBranch
              nodes={tree}
              depth={0}
              selectedId={selectedNodeId}
              onSelect={setSelectedNodeId}
              folded={foldedNodes}
              onToggle={toggleNode}
            />
          )}
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="py-16 text-center text-xs text-gray-400">正在读取本地数据…</p>
          ) : tab === 'assets' ? (
            ledgerView === 'grid' ? (
              <AssetsTab
                assets={scopedAssets}
                byAsset={byAsset}
                hashById={hashById}
                stageFilter={stageFilter}
                fileIndex={fileIndex}
                onSelect={setSelectedAssetId}
                onView={setViewingImageId}
              />
            ) : (
              <AssetReportTab
                spend={contentReportSpend}
                imports={imports}
                assets={scopedAssets}
                hashById={hashById}
                fileIndex={fileIndex}
                byAsset={byAsset}
                stageFilter={stageFilter}
                onOpenAsset={setSelectedAssetId}
              />
            )
          ) : tab === 'unmatched' ? (
            <UnmatchedTab spend={spend} assets={assets} onDone={reload} setBusy={setBusy} setError={setError} />
          ) : (
            <ImportTab
              tasks={tasks as TaskRecord[]}
              assets={assets}
              results={importResults}
              setResults={setImportResults}
              onDone={reload}
              onImported={(next) => {
                // 当前区间已经覆盖这批数据就不用动；不覆盖才切，避免把用户正在看的范围缩成一天
                const covered = (!range.from || next.from >= range.from) && (!range.to || next.to <= range.to)
                if (!covered) setRange(next)
              }}
              setBusy={setBusy}
              setError={setError}
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
            directions={directions}
            onDerive={setDerivingTask}
            onRefresh={reload}
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
/** 树的展开箭头。和画廊侧栏同一个形状，收起时朝右 */
function TreeChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`h-3 w-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  )
}

function TreeBranch({
  nodes,
  depth,
  selectedId,
  onSelect,
  folded,
  onToggle,
}: {
  nodes: TreeNode[]
  depth: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** 收起的节点 id：收起的节点不渲染子树，但计数本来就含子孙，数字不会变 */
  folded: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        const active = selectedId === node.id
        const hasChildren = node.children.length > 0
        const isFolded = folded.has(node.id)
        return (
          <div key={node.id}>
            <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
              {hasChildren ? (
                <button
                  type="button"
                  onClick={(event) => {
                    // 箭头只负责折叠，不改变当前筛选
                    event.stopPropagation()
                    onToggle(node.id)
                  }}
                  className="flex h-6 w-4 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
                  title={isFolded ? '展开' : '收起'}
                  aria-label={`${isFolded ? '展开' : '收起'} ${node.name}`}
                >
                  <TreeChevron open={!isFolded} />
                </button>
              ) : (
                <span className="h-6 w-4 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onSelect(active ? null : node.id)}
                className={`flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] transition ${
                  active
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'
                }`}
                title={`${node.name}（${node.taskCount} 张卡）`}
              >
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className="shrink-0 text-[10px] text-gray-400">{node.taskCount}</span>
              </button>
            </div>
            {hasChildren && !isFolded && (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                folded={folded}
                onToggle={onToggle}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * 日消耗折线。
 *
 * 用折线而不是一排横条：要看的是「哪天起量、哪天掉」，折线更容易看出拐点。
 *
 * **交互为什么这么做**：原来只在每个点上挂了 SVG `<title>`，命中区只有 2.2px 半径的
 * 圆点，鼠标几乎点不中，实际用起来就是「移上去什么都不显示」。现在改成整块图都能悬停，
 * 按横坐标吸附到最近的一天，画一条竖虚线 + 放大该点 + 浮层显示日期与金额，
 * 顶部那行也同步显示当前悬停的点（浮层贴边时也不怕被裁）。
 */
function SpendTrend({ series }: { series: Array<{ date: string; spend: number }> }) {
  const width = 300
  const height = 96
  const pad = 6
  const [hover, setHover] = useState<number | null>(null)

  const max = Math.max(1, ...series.map((item) => item.spend))
  const step = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0
  const points = series.map((item, index) => ({
    // 只有一天时 step 为 0，点会全叠在左边，居中画更好看
    x: series.length > 1 ? pad + index * step : width / 2,
    y: height - pad - (item.spend / max) * (height - pad * 2),
    date: item.date,
    spend: item.spend,
  }))
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const baseline = (height - pad).toFixed(1)
  const area = `${pad.toFixed(1)},${baseline} ${line} ${(pad + (series.length - 1) * step).toFixed(1)},${baseline}`
  const active = hover === null ? null : points[hover]
  const total = series.reduce((sum, item) => sum + item.spend, 0)
  const peak = points.reduce((best, point) => (point.spend > best.spend ? point : best), points[0])

  /** 按横坐标找最近的一天：整条竖线范围都算命中，不用瞄准圆点 */
  const trackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !points.length) return
    const x = ((event.clientX - rect.left) / rect.width) * width
    let nearest = 0
    for (let i = 1; i < points.length; i += 1) {
      if (Math.abs(points[i].x - x) < Math.abs(points[nearest].x - x)) nearest = i
    }
    setHover(nearest)
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[10px]">
        <span className="truncate text-gray-400">
          合计 ¥{fmtMoney(total)} · 峰值 ¥{fmtMoney(peak.spend)}（{peak.date.slice(5)}）
        </span>
        {active && (
          <span className="shrink-0 font-mono font-medium text-blue-500">
            {active.date.slice(5)} ¥{fmtMoney(active.spend)}
          </span>
        )}
      </div>
      <div
        className="relative touch-none"
        onPointerMove={trackPointer}
        onPointerDown={trackPointer}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="日消耗趋势">
          {/* 三条淡横线当刻度，读高低有个参照，不画坐标轴省空间 */}
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1={pad}
              x2={width - pad}
              y1={pad + ratio * (height - pad * 2)}
              y2={pad + ratio * (height - pad * 2)}
              stroke="currentColor"
              className="text-gray-200 dark:text-white/10"
              strokeWidth={0.6}
            />
          ))}
          <polygon points={area} fill="rgba(96,165,250,0.16)" />
          <polyline points={line} fill="none" stroke="#60a5fa" strokeWidth={1.6} strokeLinejoin="round" />
          {active && (
            <line
              x1={active.x}
              x2={active.x}
              y1={pad}
              y2={height - pad}
              stroke="#60a5fa"
              strokeWidth={0.8}
              strokeDasharray="2 2"
            />
          )}
          {points.map((point, index) => (
            <circle
              key={point.date}
              cx={point.x}
              cy={point.y}
              r={hover === index ? 3.4 : 2.2}
              fill={hover === index ? '#1d4ed8' : '#3b82f6'}
              stroke={hover === index ? '#ffffff' : 'none'}
              strokeWidth={1}
            />
          ))}
        </svg>
        {active && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[130%] whitespace-nowrap rounded bg-gray-900/95 px-1.5 py-0.5 text-[10px] text-white shadow-lg dark:bg-white dark:text-gray-900"
            // clamp 让浮层贴左右边缘时也不出界
            style={{
              left: `clamp(2.6rem, ${(active.x / width) * 100}%, calc(100% - 2.6rem))`,
              top: `${(active.y / height) * 100}%`,
            }}
          >
            <span className="font-mono">{active.date}</span> ¥{fmtMoney(active.spend)}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-gray-400">
        <span className="font-mono">{series[0].date}</span>
        <span className="font-mono">{series[series.length - 1].date}</span>
      </div>
    </div>
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
  directions,
  onDerive,
  onRefresh,
  onView,
  onClose,
}: {
  asset: AssetRecord
  tasks: TaskRecord[]
  spend: SpendRecord[]
  /** 方向树：给「归属方向」下拉用（外部素材没有任务卡，只能手选） */
  directions: SopDirectionNode[]
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
  /**
   * 平台素材 ID 是否展开。
   *
   * 一个素材被平台重复上传、或被「模拟关联」一次性挂上一大批 ID 时，
   * 这串 ID 能有几百个，`break-all` 铺下来直接把抽屉撑到两屏，
   * 下面的消耗、血缘全被挤走。默认只露前 3 个。
   */
  const [idsOpen, setIdsOpen] = useState(false)
  const [idsCopied, setIdsCopied] = useState(false)
  /**
   * 来源任务卡的提示词默认只露 4 行（长提示词能把抽屉撑爆），
   * 但「看不全又没法展开」等于没写全 —— 给展开/收起 + 一键复制。
   * `promptOverflow` 是实测出来的：只有真被截断时才显示「展开全文」，
   * 短提示词底下不会多一行没用的按钮。
   */
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptOverflow, setPromptOverflow] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const promptRef = useRef<HTMLParagraphElement>(null)
  /** 「作为参考图去画廊」的结果：读不到原图时得说一句，不能点了没反应 */
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'failed'>('idle')
  const linkAssetToGallery = useStore((state) => state.linkAssetToGallery)
  const stat = byAsset.get(asset.id)
  const series = useMemo(() => assetDailySeries(spend, asset.id), [spend, asset.id])
  const task = tasks.find((item) => item.id === asset.taskId)
  const cardId = asset.rootCardId ?? asset.taskId ?? ''
  const node = lineageMap.get(cardId)
  // 家族消耗：这张卡 + 它所有后代卡的消耗，才是一套创意的真实投入
  const familyCards = useMemo(() => descendantCards(cardId, lineageMap), [cardId, lineageMap])
  const familySpend = familyCards.reduce((sum, id) => sum + (byCard.get(id)?.totalSpend ?? 0), 0)
  /** 这个素材在报表里的最新一条流水，用来展示媒体 / 设计 / 优化师 */
  const latestSpend = useMemo(() => {
    let latest: SpendRecord | undefined
    for (const record of spend) {
      if (record.assetId !== asset.id) continue
      if (!latest || record.date > latest.date) latest = record
    }
    return latest
  }, [spend, asset.id])
  // 模拟关联的条数：让用户知道这个素材的消耗里有多少是调试数据
  const simulatedHere = spend.reduce(
    (count, record) => count + (record.assetId === asset.id && record.simulated ? 1 : 0), 0)

  // 演示素材的 id 是 demo- 开头，真实图片哈希在 imageId 里，必须走 assetImageId
  const previewImageId = assetImageId(asset)

  /**
   * 把这张图放进画廊输入框当参考图。
   *
   * 带上出处（`rootCardId ?? taskId`）一起送过去，画廊生成的卡就会记成它的衍生：
   * 从台账挑图 → 画廊改图 → 新卡回到台账，血缘是一条连续的链，而不是断在这里。
   * 外部素材（NAS 接进来的）没有任务卡，只当参考图，不挂血缘。
   */
  const sendToGallery = async () => {
    if (!previewImageId || sendState === 'sending') return
    setSendState('sending')
    const dataUrl = await ensureImageCached(previewImageId)
    if (!dataUrl) {
      setSendState('failed')
      return
    }
    linkAssetToGallery({ id: previewImageId, dataUrl }, cardId)
  }

  /**
   * 「归属方向」下拉：按产品分组。
   *
   * 外部素材（NAS 接进来的）没有任务卡，方向只能手选或按分类路径自动算；
   * 树里没有的产品（卡券、淘宝联盟…）自然也就没有选项，用户要先去建节点。
   */
  const directionGroups = useMemo(() => {
    const alive = directions.filter((node) => !node.deletedAt)
    return alive
      .filter((node) => node.kind === 'product')
      .map((product) => ({
        product,
        items: alive.filter((node) => node.kind === 'direction' && node.parentId === product.id),
      }))
      .filter((group) => group.items.length > 0)
  }, [directions])

  /** 当前归属展示：任务卡上的方向优先（那才是这张图生成时定的） */
  const taskDirectionId = task?.sopDirectionId
  const currentDirectionId = taskDirectionId ?? asset.directionId ?? ''
  const autoHit = !taskDirectionId && !asset.directionId ? matchDirectionByPath(asset.dirPath, directions) : null

  const assignDirection = async (directionId: string) => {
    const next: AssetRecord = {
      ...asset,
      directionId: directionId || undefined,
      // 手动选过就锁住，之后自动匹配不再覆盖；清空则回到「可自动」
      directionSource: directionId ? 'manual' : undefined,
    }
    await trackPut('assets', asset.id, next)
    await onRefresh()
  }

  /** 换一张素材要收回去：否则上一张点开的「展开」会带到下一张 */
  useEffect(() => {
    setPromptOpen(false)
    setPromptCopied(false)
  }, [asset.id])

  /** 折叠状态下量一次：内容比 4 行高才需要「展开全文」 */
  useEffect(() => {
    if (promptOpen) return
    const el = promptRef.current
    if (!el) return
    setPromptOverflow(el.scrollHeight > el.clientHeight + 2)
  }, [task?.id, task?.prompt, promptOpen, asset.id])

  const copyPrompt = () => {
    const text = task?.prompt
    if (!text) return
    // 网页版在非安全上下文里没有 clipboard，失败就静默（用户会再点一次或手动选）
    void navigator.clipboard?.writeText(text)
      .then(() => {
        setPromptCopied(true)
        window.setTimeout(() => setPromptCopied(false), 1500)
      })
      .catch(() => setPromptCopied(false))
  }

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
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5 dark:border-white/10">
        {/* 标题用报表里的图片名称；没有就退回哈希前 8 位，至少能对上列表 */}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200" title={asset.id}>
          {asset.reportNames[0] || asset.id.slice(0, 8)}
        </span>
        <button type="button" onClick={onClose} className="shrink-0 text-xs text-gray-400 hover:text-gray-600">关闭</button>
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

        {/* 真实素材的 id 是 64 位哈希，break-all 会铺三行，截断 + title 看全 */}
        <p className="mb-3 truncate font-mono text-[10px] text-gray-400" title={asset.id}>{asset.id}</p>

        <div className="mb-4 grid grid-cols-3 gap-2">
          {/* 口径是「当前日期范围」，不是历史累计 —— 数据按区间加载，改回累计会拿不到全量 */}
          <Metric label="区间消耗" value={stat ? `¥${fmtMoney(stat.totalSpend)}` : '-'} />
          <Metric label="投放天数" value={String(stat?.activeDays ?? 0)} />
          <Metric label="日均" value={stat ? `¥${fmtMoney(stat.dailyAverage)}` : '-'} />
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">日消耗</p>
          {!series.length
            ? <p className="text-[11px] text-gray-400">还没有投放数据</p>
            : <SpendTrend series={series} />}
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">投放信息</p>
          <div className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <p>阶段：<span className="text-gray-800 dark:text-gray-100">{STAGE_LABEL[stat?.stage ?? 'created']}</span></p>
            <p>最后投放：{stat?.lastDate ?? '-'}</p>
            {latestSpend?.media && <p>媒体：{latestSpend.media}</p>}
            {latestSpend?.productName && <p>产品：{latestSpend.productName}</p>}
            {latestSpend?.designer && <p>设计：{latestSpend.designer}</p>}
            {latestSpend?.optimizer && <p>优化师：{latestSpend.optimizer}</p>}
            {simulatedHere > 0 && (
              <p className="text-amber-600 dark:text-amber-400">
                其中 {simulatedHere} 条为模拟关联（调试用，未真实匹配）
              </p>
            )}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-500 dark:text-gray-400">归属方向</p>
            <span className="text-[10px] text-gray-400">
              {taskDirectionId
                ? '随任务卡'
                : asset.directionSource === 'manual'
                  ? '人工设定'
                  : asset.directionSource === 'auto'
                    ? '按分类路径自动'
                    : ''}
            </span>
          </div>
          <select
            value={currentDirectionId}
            disabled={Boolean(taskDirectionId)}
            onChange={(event) => void assignDirection(event.target.value)}
            className="w-full rounded border border-gray-200 bg-transparent px-1.5 py-1 text-[11px] disabled:opacity-60 dark:border-white/15"
            title={taskDirectionId ? '这张图的方向由生成它的任务卡决定，改任务卡上的方向' : '外部素材没有任务卡，可以在这里指定'}
          >
            <option value="">（未归属）</option>
            {directionGroups.map((group) => (
              <optgroup key={group.product.id} label={group.product.name}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          {asset.dirPath?.length ? (
            <p className="mt-1 text-[10px] text-gray-400">
              分类路径：{asset.dirPath.join(' / ')}
              {autoHit ? `（自动匹配到「${autoHit.productName} / ${autoHit.directionName}」）` : ''}
            </p>
          ) : null}
        </div>

        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              平台素材 ID{asset.platformIds.length > 0 && `（${asset.platformIds.length}）`}
            </p>
            {asset.platformIds.length > 0 && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // 复制整串（每行一个），方便拿去平台后台或 Excel 里比对
                    void navigator.clipboard?.writeText(asset.platformIds.join('\n'))
                      .then(() => setIdsCopied(true))
                      .catch(() => setIdsCopied(false))
                  }}
                  className="text-[10px] text-blue-500 hover:underline"
                >
                  {idsCopied ? '已复制' : '复制全部'}
                </button>
                {idsOpen && (
                  <button
                    type="button"
                    onClick={() => setIdsOpen(false)}
                    className="text-[10px] text-gray-500 hover:underline"
                  >
                    收起
                  </button>
                )}
              </div>
            )}
          </div>
          {!asset.platformIds.length ? (
            <p className="text-[11px] text-gray-400">未匹配</p>
          ) : (
            <div
              className={
                idsOpen
                  ? 'flex max-h-28 flex-wrap gap-1 overflow-y-auto overscroll-contain rounded-lg border border-gray-100 p-1.5 dark:border-white/10'
                  : 'flex flex-wrap gap-1'
              }
            >
              {(idsOpen ? asset.platformIds : asset.platformIds.slice(0, 3)).map((platformId) => (
                <span
                  key={platformId}
                  className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300"
                >
                  {platformId}
                </span>
              ))}
              {!idsOpen && asset.platformIds.length > 3 && (
                <button
                  type="button"
                  onClick={() => setIdsOpen(true)}
                  className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300"
                  title={`点开展示全部 ${asset.platformIds.length} 个平台素材 ID`}
                >
                  还有 {asset.platformIds.length - 3} 个
                </button>
              )}
            </div>
          )}
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-[11px] text-gray-500 dark:text-gray-400">来源任务卡</p>
          <p className="break-all font-mono text-[10px] text-gray-500">{cardId || '-'}</p>
          {task && (
            <>
              <p
                ref={promptRef}
                className={`mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-gray-600 dark:text-gray-300 ${
                  promptOpen ? '' : 'line-clamp-4'
                }`}
              >
                {task.prompt}
              </p>
              <div className="mt-1.5 flex items-center gap-3 text-[10px]">
                {(promptOverflow || promptOpen) && (
                  <button
                    type="button"
                    onClick={() => setPromptOpen((prev) => !prev)}
                    className="text-blue-500 hover:underline"
                  >
                    {promptOpen ? '收起' : '展开全文'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={copyPrompt}
                  className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200"
                >
                  {promptCopied ? '已复制' : '复制提示词'}
                </button>
              </div>
            </>
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

          <button
            type="button"
            onClick={() => void sendToGallery()}
            disabled={!previewImageId || sendState === 'sending'}
            title={previewImageId
              ? '把这张图放进画廊的参考图区，生成的新任务卡会自动记为它的衍生'
              : '这个素材没有可用的图片文件（只有报表里的平台 ID）'}
            className="mt-1.5 w-full rounded-lg bg-indigo-50 px-3 py-1.5 text-[11px] text-indigo-600 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
          >
            {sendState === 'sending' ? '正在取图…' : sendState === 'failed' ? '读不到原图，重试' : '作为参考图去画廊'}
          </button>
          <p className="mt-1 text-[10px] text-gray-400">
            {cardId ? '新任务卡会记为这张卡的衍生，血缘接着往下走' : '外部素材没有任务卡，只作为参考图'}
          </p>
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
  hashById,
  stageFilter,
  fileIndex,
  onSelect,
  onView,
}: {
  assets: AssetRecord[]
  byAsset: ReturnType<typeof aggregateByAsset>
  /** 素材 id → 内容哈希，同一张图的多条素材合并成一张卡片 */
  hashById: Map<string, string>
  /** 阶段筛选由父组件持有（渲染在固定头部那行） */
  stageFilter: 'all' | 'running' | 'declining' | 'created' | 'stale'
  /** 任务卡 id → 交付文件名，按文件名搜索用 */
  fileIndex: Map<string, AssetFileInfo>
  onSelect: (assetId: string) => void
  onView: (imageId: string) => void
}) {
  /** 按文件名搜索：交付文件名、文件夹/文件名、报表图片名、平台素材 ID，输入即时过滤 */
  const [keyword, setKeyword] = useState('')
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

  const rows = useMemo(() => {
    // 先按内容合并：同一张图存了多份时只出一张卡，消耗用合并后的统计
    return groupAssetsByContent(assets, hashById)
      .map((group) => ({ asset: group.asset, members: group.members, stat: byAsset.get(group.key) }))
      .filter((row) => {
        if (stageFilter !== 'all') {
          const stage = row.stat?.stage ?? 'created'
          if (stage !== stageFilter) return false
        }
        return matchAssetKeyword(row.asset, fileIndex.get(row.asset.taskId ?? ''), keyword)
      })
      .sort((a, b) => (b.stat?.totalSpend ?? 0) - (a.stat?.totalSpend ?? 0))
  }, [assets, byAsset, hashById, stageFilter, fileIndex, keyword])

  return (
    /* 指标、阶段筛选、页签、扫描按钮都在父组件的固定头部，这里只剩卡片区（截图里的「红框」） */
    <div className="flex flex-col gap-3">
      {assets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索文件名 / 报表图片名 / 平台素材ID"
            className="w-72 rounded-lg border border-gray-200 bg-transparent px-2 py-1 text-[11px] text-gray-600 outline-none placeholder:text-gray-400 dark:border-white/15 dark:text-gray-300"
          />
          <span className="text-[11px] text-gray-400">
            筛出 {rows.length} / 共 {assets.length} 张
          </span>
        </div>
      )}
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
          {rows.slice(0, 300).map(({ asset, members, stat }) => {
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
                    <span className="shrink-0">
                      {members.length > 1 && <span className="mr-1 text-amber-600 dark:text-amber-400">同图{members.length}份</span>}
                      {asset.platformIds.length > 0 && `${asset.platformIds.length} 个ID`}
                    </span>
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
    // 排行里可能拿不到代表素材（演示数据、老数据），空 id 不去查库
    if (!imageId) {
      setSrc('')
      return
    }
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
    const map = new Map<string, { platformId: string; name?: string; spend: number; days: number; dates: string[] }>()
    for (const record of spend) {
      if (record.assetId) continue
      const entry = map.get(record.platformId) ?? { platformId: record.platformId, spend: 0, days: 0, dates: [] }
      entry.spend += record.spend
      entry.dates.push(record.date)
      if (!entry.name && record.assetName) entry.name = record.assetName
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
        报表里的「图片名称」对不上任何交付文件名，只能你手动指定。绑定后同一平台素材以后每天的消耗都会自动归到这张图。
      </p>
      <table className="w-full text-xs">
        <thead className="text-gray-400">
          <tr className="border-b border-gray-100 dark:border-white/10">
            <th className="py-1.5 text-left font-normal">平台素材ID</th>
            <th className="py-1.5 text-left font-normal">报表里的图片名称</th>
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
              <td className="max-w-[20rem] truncate py-1.5 text-gray-600 dark:text-gray-300" title={group.name}>{group.name || '—'}</td>
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

/** 批量导入里单个文件的对账结果 */
interface FileResult {
  name: string
  rows: number
  records: number
  totalSpend: number
  matched: number
  unmatched: number
  skipped: number
  error?: string
}

/** 读一个文件成二维表：xlsx 走 zip 解析，csv 走文本解析 */
async function readSheetFile(file: File): Promise<SheetTable> {
  const buffer = await file.arrayBuffer()
  return /\.csv$/i.test(file.name)
    ? parseCsv(new TextDecoder('utf-8').decode(buffer))
    : parseXlsx(buffer)
}

/** 写得动的大小：单文件一万多条，一次 invoke 要拼几十 MB 字符串 */
const WRITE_CHUNK = 4000

function ImportTab({
  tasks,
  assets,
  results,
  setResults,
  onDone,
  onImported,
  setBusy,
  setError,
}: {
  tasks: TaskRecord[]
  assets: AssetRecord[]
  /** 逐文件对账结果，由父组件持有（见上面 importResults 的注释） */
  results: FileResult[]
  setResults: (next: FileResult[]) => void
  onDone: () => Promise<void>
  /** 导入成功后把本批数据的日期范围报上来，用于「导入的日期不在当前筛选里」时自动切过去 */
  onImported?: (range: { from: string; to: string }) => void
  setBusy: (value: string) => void
  setError: (value: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  /** 待导入的文件队列（按文件名排序，报表名带日期，排完就是按天） */
  const [pending, setPending] = useState<File[]>([])
  /** 列映射只按第一个文件的表头确认，其余文件按表头文字对齐 */
  const [headers, setHeaders] = useState<string[] | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null)

  const nameIndex = useMemo(() => buildNameIndex(tasks), [tasks])

  const pickFiles = async (list: File[]) => {
    setError('')
    setResults([])
    setMapping(null)
    setHeaders(null)
    const usable = list
      .filter((file) => /\.(xlsx|csv)$/i.test(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    if (!usable.length) {
      setPending([])
      setError('没有可导入的文件（只支持 .xlsx / .csv）')
      return
    }
    setPending(usable)
    setBusy(`正在读取表头（共 ${usable.length} 个文件）…`)
    // 只解析第一个文件拿表头：33 个文件全解析一遍要几十秒，而列对应关系只需要一份
    try {
      const parsed = await readSheetFile(usable[0])
      setHeaders(parsed.headers)
      setMapping(detectMapping(parsed.headers))
      setBusy(`已选中 ${usable.length} 个文件。先确认下面的列对应关系，再点「开始导入」。`)
    } catch (err) {
      setPending([])
      setBusy('')
      setError(`读不了 ${usable[0].name}：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 批量导入。
   *
   * 逐文件「解析 → 建流水 → 分批写入 → 记对账」，**不把 33 个文件的结果攒在内存里**：
   * 每个文件一万多条，攒一起就是几十万对象、几百 MB，webview 会直接卡死。
   * 中途失败只影响当前文件，已写入的不会回滚（流水主键是平台素材+日期，重导即覆盖）。
   */
  const importAll = async () => {
    if (!mapping || !headers || !pending.length) return
    setError('')
    const baseId = `imp-${Date.now().toString(36)}`
    const collected: FileResult[] = []
    const assetById = new Map(assets.map((item) => [item.id, item]))
    const touchedAssets = new Map<string, AssetRecord>()
    let newest = ''
    let totalRecords = 0
    let totalSpend = 0
    let okFiles = 0
    let failedFiles = 0

    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]
      setProgress({ done: index, total: pending.length, name: file.name })
      setBusy(`正在导入 ${index + 1}/${pending.length}：${file.name}`)
      const row: FileResult = { name: file.name, rows: 0, records: 0, totalSpend: 0, matched: 0, unmatched: 0, skipped: 0 }
      try {
        const parsed = await readSheetFile(file)
        row.rows = parsed.rows.length
        // 别的文件的列顺序可能不同，按表头文字对齐，缺必需列就跳过这个文件
        const resolved = resolveMapping(parsed.headers, mapping, headers)
        if (resolved.missing.length) {
          row.error = `表头缺少「${resolved.missing.join('、')}」，已跳过`
          failedFiles += 1
        } else {
          const importId = `${baseId}-${String(index + 1).padStart(3, '0')}`
          const result = buildSpendRecords(parsed, resolved.mapping, nameIndex, importId)
          for (let start = 0; start < result.records.length; start += WRITE_CHUNK) {
            const chunk = result.records.slice(start, start + WRITE_CHUNK)
            await trackPutMany('spend', chunk.map((item) => ({ id: item.id, data: item })))
          }

          // 台账回填：平台 ID、最后消耗日（跨文件合并，最后一次性写）
          for (const record of result.records) {
            if (!record.assetId) continue
            const base = touchedAssets.get(record.assetId) ?? assetById.get(record.assetId)
            if (!base) continue
            touchedAssets.set(base.id, {
              ...base,
              platformIds: base.platformIds.includes(record.platformId)
                ? base.platformIds
                : [...base.platformIds, record.platformId],
              lastSpendDate: !base.lastSpendDate || record.date > base.lastSpendDate ? record.date : base.lastSpendDate,
              firstSeenAt: base.firstSeenAt ?? Date.now(),
            })
          }

          const importRecord: ImportRecord = {
            id: importId,
            fileName: file.name,
            importedAt: Date.now(),
            rowCount: parsed.rows.length,
            totalSpend: result.totalSpend,
            matchedCount: result.matchedCount,
            unmatchedCount: result.unmatchedCount,
          }
          await trackPut('imports', importRecord.id, importRecord)

          row.records = result.records.length
          row.totalSpend = result.totalSpend
          row.matched = result.matchedCount
          row.unmatched = result.unmatchedCount
          row.skipped = result.skipped.length
          totalRecords += result.records.length
          totalSpend += result.totalSpend
          okFiles += 1
          for (const item of result.records) if (item.date > newest) newest = item.date
        }
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err)
        failedFiles += 1
      }
      collected.push(row)
      setResults([...collected])
      // 让出一帧，否则几十个文件连着跑，进度条会一直停在 0 不动
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    }

    if (touchedAssets.size) {
      await trackPutMany('assets', [...touchedAssets.values()].map((item) => ({ id: item.id, data: item })))
    }
    setProgress(null)
    setPending([])
    setHeaders(null)
    setMapping(null)
    await onDone()
    /*
     * 只把区间切到「最新一天往前 7 天」，不是整批的跨度：
     * 一次导 33 天，切到 33 天窗口等于把三十多万条流水全读进内存，界面直接卡住。
     */
    if (newest) onImported?.({ from: shiftDate(newest, -6), to: newest })
    const tail = failedFiles ? `，${failedFiles} 个文件跳过` : ''
    setBusy(`批量导入完成：${okFiles} 个文件、${totalRecords} 条流水，合计 ¥${fmtMoney(totalSpend)}${tail}`)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            if (files.length) void pickFiles(files)
            event.target.value = ''
          }}
        />
        {/* webkitdirectory 在 WebView2 和 Chrome 都支持；React 没给它类型，只能这样透传 */}
        <input
          ref={dirRef}
          type="file"
          className="hidden"
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            if (files.length) void pickFiles(files)
            event.target.value = ''
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600">
          选择报表文件（可多选）
        </button>
        <button
          type="button"
          onClick={() => dirRef.current?.click()}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/5"
          title="整个文件夹里的 .xlsx / .csv 一次全导进来"
        >
          选择整个文件夹
        </button>
        {pending.length > 0 && (
          <span className="text-xs text-gray-500">
            已选 {pending.length} 个文件{pending.length > 1 ? `（${pending[0].name} 等）` : ''}
          </span>
        )}
      </div>

      {progress ? (
        <div>
          <div className="h-1 w-full overflow-hidden rounded bg-gray-100 dark:bg-white/10">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            正在处理 {progress.done + 1}/{progress.total}：{progress.name}
          </p>
        </div>
      ) : (
        !pending.length && (
          <p className="text-xs text-gray-400">
            支持一次选多个文件，或直接选一整个文件夹（每天一份报表的常态）。
            导入按「平台素材ID + 日期」落库，同一天重复导入会覆盖而不是叠加，可以放心反复导。
          </p>
        )
      )}

      {pending.length > 0 && mapping && headers && (
        <>
          <div className="rounded-xl border border-gray-100 p-3 dark:border-white/10">
            <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">
              列对应（按 {pending.length > 1 ? '第一个文件' : '所选文件'} 的表头识别，识别错了就在这里改；其余文件按表头文字自动对齐）
            </p>
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
                    {headers.map((header, index) => (
                      <option key={index} value={index}>{header || `第 ${index + 1} 列`}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {mapping.date < 0 || mapping.spend < 0 ? (
              <p className="text-xs text-amber-600">「投放日期」和「消耗」是必填，先在上面选好。</p>
            ) : (
              <button
                type="button"
                onClick={() => void importAll()}
                disabled={Boolean(progress)}
                className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
              >
                开始导入 {pending.length} 个文件
              </button>
            )}
            <button
              type="button"
              onClick={() => { setPending([]); setMapping(null); setHeaders(null) }}
              disabled={Boolean(progress)}
              className="rounded-lg px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-white/10"
            >
              取消
            </button>
          </div>
        </>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-gray-400">
              <tr className="border-b border-gray-100 dark:border-white/10">
                <th className="py-1.5 pr-3 text-left font-normal">文件</th>
                <th className="py-1.5 pr-3 text-right font-normal">行数</th>
                <th className="py-1.5 pr-3 text-right font-normal">流水</th>
                <th className="py-1.5 pr-3 text-right font-normal">消耗</th>
                <th className="py-1.5 pr-3 text-right font-normal">匹配</th>
                <th className="py-1.5 pr-3 text-right font-normal">未匹配</th>
                <th className="py-1.5 text-left font-normal">备注</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.name} className="border-b border-gray-50 dark:border-white/5">
                  <td className="max-w-[22rem] truncate py-1 pr-3 text-gray-600 dark:text-gray-300" title={row.name}>{row.name}</td>
                  <td className="py-1 pr-3 text-right text-gray-500">{row.rows}</td>
                  <td className="py-1 pr-3 text-right text-gray-500">{row.records}</td>
                  <td className="py-1 pr-3 text-right text-gray-700 dark:text-gray-200">¥{fmtMoney(row.totalSpend)}</td>
                  <td className="py-1 pr-3 text-right text-gray-500">{row.matched}</td>
                  <td className="py-1 pr-3 text-right text-gray-500">{row.unmatched}</td>
                  <td className="py-1 text-left">
                    {row.error
                      ? <span className="text-red-500">{row.error}</span>
                      : row.skipped > 0
                        ? <span className="text-amber-600">跳过 {row.skipped} 行（多为缺日期）</span>
                        : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** 报表维度：素材 / 任务卡 / 产品 */
type ReportDimension = 'asset' | 'card' | 'product'

interface ReportRow {
  key: string
  /** 代表素材 id：单击行时打开它的详情（素材维度就是本行，其他维度是代表素材） */
  assetId?: string
  /** 主列文字 */
  label: string
  /** 主列下面的小字 */
  sublabel: string
  /** 第二列（素材维度显示所属任务卡，其余维度显示素材数） */
  secondary: string
  /** 缩略图用的图片哈希 */
  imageId?: string
  /** 双击打开任务卡详情用；素材维度取该素材所属任务，其余维度取代表素材的任务 */
  taskId?: string
  media: string[]
  spend: number
  days: number
  /** 最近 7 天逐日消耗，给趋势迷你图用 */
  series: number[]
  /** 任务卡 / 产品维度下包含多少素材 */
  assetCount: number
}

/**
 * 迷你趋势图：一条折线，不画坐标轴 —— 看的是「往上还是下降」，不是精确读值。
 *
 * 每个点盖一个透明的圆当命中区并挂 `title`：看图能看出走势，想知道具体哪天多少钱
 * 就把鼠标放到那一列上（点在 64px 宽里只有 1px，直接挂 title 是点不中的）。
 */
function Sparkline({ values, dates }: { values: number[]; dates?: string[] }) {
  if (!values.length || values.every((value) => value === 0)) {
    return <span className="text-[10px] text-gray-300 dark:text-gray-600">—</span>
  }
  const width = 64
  const height = 18
  const max = Math.max(...values)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden="true">
      <polyline points={points} fill="none" stroke="#60a5fa" strokeWidth={1.3} strokeLinejoin="round" />
      {values.map((value, index) => (
        <circle
          key={index}
          cx={index * step}
          cy={height - 2 - (value / max) * (height - 4)}
          r={2.6}
          fill="transparent"
        >
          <title>{`${dates?.[index] ?? `第 ${index + 1} 天`} ¥${fmtMoney(value)}`}</title>
        </circle>
      ))}
    </svg>
  )
}

/**
 * 素材报表。
 *
 * 布局参考投放后台的报表页：上面一排筛选（维度 / 媒体 / 产品 / 设计 / 优化师 / 搜索），
 * 下面一张带合计的明细表，每行右侧一条近 7 日趋势。
 *
 * 三个刻意的取舍：
 * 1. **未匹配的流水也进表**：按「平台素材 ID」单独成行，标签用报表里的图片名称。
 *    认不到本地图不等于没花钱，剔掉它们会让报表页在一批对不上命名的数据下变成空白；
 * 2. **趋势轴取「数据里最近 7 个有消耗的日期」**，不是自然日 —— 中间空档会把折线压平，看着像没投；
 * 3. 合计行放表头下面第一行（和投放后台一致），比塞到表格最底部更容易看到。
 */
function AssetReportTab({
  spend,
  imports,
  assets,
  fileIndex,
  hashById,
  byAsset,
  stageFilter,
  onOpenAsset,
}: {
  spend: SpendRecord[]
  imports: ImportRecord[]
  assets: AssetRecord[]
  /** 任务卡 id → 交付文件名，按文件名搜索用 */
  fileIndex: Map<string, AssetFileInfo>
  /** 素材 id → 内容哈希：素材维度按它分组，同一张图的多条素材合成一行 */
  hashById: Map<string, string>
  byAsset: ReturnType<typeof aggregateByAsset>
  /** 投放状态筛选：和网格视图共用同一个值，切视图不会丢条件 */
  stageFilter: 'all' | 'running' | 'declining' | 'created' | 'stale'
  /** 单击行打开素材详情（和素材台账里点卡片是同一个抽屉） */
  onOpenAsset: (assetId: string) => void
}) {
  const tasks = useStore((state) => state.tasks)
  const setDetailTaskId = useStore((state) => state.setDetailTaskId)
  const knownTaskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks])
  const assetById = useMemo(() => new Map(assets.map((item) => [item.id, item])), [assets])

  const [dimension, setDimension] = useState<ReportDimension>('asset')
  const [mediaFilter, setMediaFilter] = useState('')
  const [productFilter, setProductFilter] = useState('')
  const [designerFilter, setDesignerFilter] = useState('')
  const [optimizerFilter, setOptimizerFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  /** 只看未挂接本地图的平台素材（对应「待认领」那批） */
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)

  /**
   * 单击开素材详情、双击开任务卡详情。
   * 双击必然先触发两次 click，所以单击要推后一点；双击时先取消，避免抽屉闪一下。
   */
  const clickTimer = useRef<number | null>(null)
  const openAssetLater = (assetId?: string) => {
    if (!assetId) return
    if (clickTimer.current) window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => onOpenAsset(assetId), 220)
  }
  const cancelOpenAsset = () => {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
  }

  const filtered = useMemo(() => spend.filter((record) => (
    (!mediaFilter || record.media === mediaFilter) &&
    (!productFilter || record.productName === productFilter) &&
    (!designerFilter || record.designer === designerFilter) &&
    (!optimizerFilter || record.optimizer === optimizerFilter)
  )), [spend, mediaFilter, productFilter, designerFilter, optimizerFilter])

  /** 筛选项从全量数据里取，不从当前结果里取 —— 否则选完一项，其余选项会凭空消失 */
  const options = useMemo(() => {
    const collect = (pick: (record: SpendRecord) => string | undefined) =>
      [...new Set(spend.map(pick).filter((value): value is string => Boolean(value)))].sort()
    return {
      media: collect((record) => record.media),
      product: collect((record) => record.productName),
      designer: collect((record) => record.designer),
      optimizer: collect((record) => record.optimizer),
    }
  }, [spend])

  const allDates = useMemo(() => [...new Set(filtered.map((record) => record.date))].sort(), [filtered])
  const trendDates = useMemo(() => allDates.slice(-7), [allDates])

  const rows = useMemo<ReportRow[]>(() => {
    type Bucket = {
      spend: number
      days: Set<string>
      byDate: Map<string, number>
      media: Set<string>
      assetIds: Set<string>
      /** 未匹配行用来当标签的报表图片名称 */
      name?: string
    }
    const buckets = new Map<string, Bucket>()

    for (const record of filtered) {
      const asset = record.assetId ? assetById.get(record.assetId) : undefined
      const key = dimension === 'asset'
        // 未匹配的按平台素材 ID 成行：没有本地图，但钱确实是花在这个素材上的
        ? (record.assetId ? (hashById.get(record.assetId) ?? record.assetId) : `pid:${record.platformId}`)
        : dimension === 'card'
          ? (asset?.rootCardId ?? asset?.taskId ?? '未归属任务卡')
          : (record.productName || '未标注产品')

      const bucket = buckets.get(key) ?? {
        spend: 0, days: new Set<string>(), byDate: new Map<string, number>(),
        media: new Set<string>(), assetIds: new Set<string>(),
      }
      bucket.spend += record.spend
      bucket.days.add(record.date)
      bucket.byDate.set(record.date, (bucket.byDate.get(record.date) ?? 0) + record.spend)
      if (record.media) bucket.media.add(record.media)
      if (record.assetId) bucket.assetIds.add(record.assetId)
      if (!bucket.name && record.assetName) bucket.name = record.assetName
      buckets.set(key, bucket)
    }

    /**
     * 这一行的投放状态：取组里第一个有统计的素材。
     *
     * 未匹配行（只有平台 ID）没有素材记录，按「未投放」算 ——
     * 和网格视图一致：那边只显示有素材记录的卡片。
     */
    const stageOf = (assetIds: Set<string>) => {
      for (const id of assetIds) {
        const stage = byAsset.get(id)?.stage
        if (stage) return stage
      }
      return 'created' as const
    }

    const out: ReportRow[] = []
    for (const [key, bucket] of buckets) {
      if (stageFilter !== 'all' && stageOf(bucket.assetIds) !== stageFilter) continue
      // 代表素材：优先挑有真实图片的，否则缩略图那格会一直是空的
      let sample: AssetRecord | undefined
      for (const assetId of bucket.assetIds) {
        const asset = assetById.get(assetId)
        if (!asset) continue
        if (!sample || (!sample.imageId && asset.imageId)) sample = asset
        if (sample.imageId) break
      }

      const unmatched = key.startsWith('pid:')
      const platformId = unmatched ? key.slice(4) : ''
      const assetCount = bucket.assetIds.size
      out.push({
        key,
        assetId: unmatched ? undefined : dimension === 'asset' ? key : sample?.id,
        label: unmatched ? (bucket.name ?? platformId) : dimension === 'asset' ? key.slice(0, 8) : key,
        sublabel: unmatched
          ? `${platformId} · 未挂接本地图`
          : dimension === 'asset'
            ? `${sample?.platformIds.length ?? 0} 个平台ID`
            : `${assetCount} 个素材`,
        // 素材维度看「这张图属于哪张卡」比再看一遍平台 ID 有用（平台 ID 已经在小字里了）
        secondary: unmatched
          ? '—'
          : dimension === 'asset'
            ? (sample?.rootCardId ?? sample?.taskId ?? '—')
            : `${assetCount} 个`,
        imageId: sample ? assetImageId(sample) : undefined,
        taskId: sample?.taskId,
        media: [...bucket.media],
        spend: Math.round(bucket.spend * 100) / 100,
        days: bucket.days.size,
        series: trendDates.map((date) => Math.round((bucket.byDate.get(date) ?? 0) * 100) / 100),
        assetCount,
      })
    }

    return out.sort((a, b) => b.spend - a.spend)
  }, [filtered, dimension, assetById, trendDates, byAsset, stageFilter])

  const visibleRows = useMemo(() => {
    const text = normalizeKeyword(keyword)
    const matched = rows.filter((row) => {
      // 未匹配行没有本地素材，反过来「仅看未匹配」时把它们留下、其余排掉
      if (onlyUnmatched && row.assetId) return false
      if (!text) return true
      // 先按行本身的标签找（素材名 / 任务卡 / 产品），再按文件名、报表图片名、平台素材 ID
      if (row.label.toLowerCase().includes(text) || row.sublabel.toLowerCase().includes(text)) return true
      const asset = row.assetId ? assetById.get(row.assetId) : undefined
      return matchReportRowKeyword(row, asset, fileIndex.get(asset?.taskId ?? ''), keyword)
    })
    return matched.slice(0, 100)
  }, [rows, keyword, onlyUnmatched, assetById, fileIndex])

  const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0)
  /** 素材维度下一共多少行「素材 / 平台素材」（含未挂接本地图的，否则和表格对不上） */
  const matchedAssetCount = useMemo(() => {
    const set = new Set<string>()
    for (const record of filtered) set.add(record.assetId ?? `pid:${record.platformId}`)
    return set.size
  }, [filtered])

  /** 双击打开任务卡详情：任务列表里没有这条记录就不弹（演示数据、卡已删） */
  const openCardDetail = (taskId?: string) => {
    if (!taskId || !knownTaskIds.has(taskId)) return
    setDetailTaskId(taskId)
  }

  const picks: Array<{ label: string; value: string; onChange: (value: string) => void; options: string[] }> = [
    { label: '媒体', value: mediaFilter, onChange: setMediaFilter, options: options.media },
    { label: '产品', value: productFilter, onChange: setProductFilter, options: options.product },
    { label: '设计', value: designerFilter, onChange: setDesignerFilter, options: options.designer },
    { label: '优化师', value: optimizerFilter, onChange: setOptimizerFilter, options: options.optimizer },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="汇总消耗" value={`¥${fmtMoney(totalSpend)}`} />
        <Metric label="素材 / 平台素材" value={String(matchedAssetCount)} />
        <Metric label="投放天数" value={String(allDates.length)} />
        <Metric label="日均" value={allDates.length ? `¥${fmtMoney(totalSpend / allDates.length)}` : '—'} />
      </div>

      {/* 筛选条：维度切换 + 四个下拉 + 搜索 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 bg-white/60 p-2 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
          {([['asset', '素材'], ['card', '任务卡'], ['product', '产品']] as Array<[ReportDimension, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDimension(key)}
              className={`rounded px-2 py-1 text-[11px] transition ${
                dimension === key
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-white/15 dark:text-white'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {picks.map((pick) => (
          <select
            key={pick.label}
            value={pick.value}
            onChange={(event) => pick.onChange(event.target.value)}
            className="rounded-lg border border-gray-200 bg-transparent px-2 py-1 text-[11px] text-gray-600 outline-none dark:border-white/15 dark:text-gray-300"
            aria-label={pick.label}
          >
            <option value="">{`全部${pick.label}`}</option>
            {pick.options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ))}

        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索素材 / 任务卡 / 产品 / 文件名"
          className="ml-auto w-56 rounded-lg border border-gray-200 bg-transparent px-2 py-1 text-[11px] text-gray-600 outline-none placeholder:text-gray-400 dark:border-white/15 dark:text-gray-300"
        />
        <button
          type="button"
          onClick={() => setOnlyUnmatched((value) => !value)}
          title="只看还没挂接本地图的平台素材（对应「待认领」）"
          className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
            onlyUnmatched
              ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-400/50 dark:bg-amber-500/10 dark:text-amber-300'
              : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/15 dark:text-gray-400 dark:hover:bg-white/[0.06]'
          }`}
        >
          仅未匹配
        </button>
      </div>

      {!rows.length ? (
        <p className="py-14 text-center text-xs text-gray-400">
          {spend.length ? '当前筛选条件下没有数据' : '还没有数据，先去「导入报表」。'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[11px]">
            {/* 定宽表：不定宽时「天数」和「近7日趋势」会挤在一起，消耗列又被推到屏幕最右边 */}
            <colgroup>
              <col />
              <col className="w-[9.5rem]" />
              <col className="w-[10rem]" />
              <col className="w-12" />
              <col className="w-24" />
              <col className="w-24" />
            </colgroup>
            <thead className="text-gray-400">
              <tr className="border-b border-gray-100 dark:border-white/10">
                <th className="py-1.5 pr-3 text-left font-normal">{dimension === 'asset' ? '素材' : dimension === 'card' ? '任务卡' : '产品'}</th>
                <th className="py-1.5 pr-3 text-left font-normal">{dimension === 'asset' ? '任务卡' : '素材数'}</th>
                <th className="py-1.5 pr-3 text-left font-normal">媒体</th>
                <th className="py-1.5 pr-3 text-right font-normal">天数</th>
                <th className="py-1.5 pr-3 text-left font-normal">近7日趋势</th>
                <th className="py-1.5 text-right font-normal">消耗</th>
              </tr>
            </thead>
            <tbody>
              {/* 合计放第一行，和投放后台一致：先看总数再看明细 */}
              <tr className="border-b border-gray-100 bg-gray-50/70 font-medium dark:border-white/10 dark:bg-white/[0.04]">
                <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">合计</td>
                {/* 合计行的第二列跟表头对齐：素材维度那一列是「任务卡」，塞素材数没意义 */}
                <td className="py-1.5 pr-3 text-gray-500">{dimension === 'asset' ? '—' : `${matchedAssetCount} 个`}</td>
                <td className="py-1.5 pr-3 text-gray-400">—</td>
                <td className="py-1.5 pr-3 text-right text-gray-500">{allDates.length}</td>
                <td className="py-1.5 pr-3 text-gray-400">—</td>
                <td className="py-1.5 text-right text-gray-800 dark:text-gray-100">¥{fmtMoney(totalSpend)}</td>
              </tr>

              {visibleRows.map((row) => {
                const openable = Boolean(row.taskId && knownTaskIds.has(row.taskId))
                return (
                  <tr
                    key={row.key}
                    onClick={() => openAssetLater(row.assetId)}
                    onDoubleClick={() => {
                      cancelOpenAsset()
                      openCardDetail(row.taskId)
                    }}
                    title={openable ? '单击看素材详情，双击看任务卡详情' : '单击查看素材详情'}
                    className="cursor-pointer border-b border-gray-50 hover:bg-gray-50 dark:border-white/5 dark:hover:bg-white/5"
                  >
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-2">
                        <AssetThumb
                          imageId={row.imageId ?? ''}
                          className="h-10 w-7 shrink-0 rounded object-contain"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-gray-700 dark:text-gray-200">{row.label}</p>
                          <p className="truncate text-[10px] text-gray-400">{row.sublabel}</p>
                        </div>
                      </div>
                    </td>
                    <td className="truncate py-1.5 pr-3 font-mono text-gray-500" title={row.secondary}>{row.secondary}</td>
                    <td className="truncate py-1.5 pr-3 text-gray-500" title={row.media.join('、')}>
                      {row.media.length ? row.media.join('、') : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-gray-500">{row.days}</td>
                    <td className="py-1.5 pr-3">
                      <Sparkline values={row.series} dates={trendDates} />
                    </td>
                    <td className="py-1.5 text-right text-gray-700 dark:text-gray-200">¥{fmtMoney(row.spend)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length > visibleRows.length && (
            <p className="mt-1 text-[10px] text-gray-400">
              只显示前 {visibleRows.length} 条（按消耗降序），共 {rows.length} 条
            </p>
          )}
        </div>
      )}

      {imports.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">导入记录</p>
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
