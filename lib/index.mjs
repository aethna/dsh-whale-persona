/**
 * dsh-whale-persona · Node half（host 侧）—— 通用技术版
 * ============================================================================
 * 做什么：把「角色设定 + 长期人格沉淀 + 跨会话记忆」拼成一段 system prompt
 *         注入当前会话，并提供 4 个读写工具让模型自己维护这本账。
 *
 * 结构（三段，全部可缺省，读不到就降级为空，绝不因缺文件而挂掉）：
 *   1. coreText    —— 一句话级的人格内核（设置项，默认空，留给你自己填）
 *   2. soulPath    —— 角色设定 Markdown 文件（设置项，默认空 = 不注入）
 *   3. sharedRoot  —— 数据目录，里面放：
 *                       shared-memory.json  记忆账本（items + 可选 tiers）
 *                       persona/current.md  长期人格沉淀（手写或脚本生成）
 *                       persona/ledger.json 人格账本（whale_grow 写的）
 *
 * 工具：whale_remember / whale_recall / whale_grow / whale_status
 *
 * 工程约束：
 *   - 所有文件按 mtime+size 缓存，没变就不重读（省磁盘、省 token）。
 *   - 每 30 秒轮询一次 stat，文件变了自动重建提示词段，不用重启。
 *   - 记忆写入 = 先严格读、再合并、再原子替换；读失败就拒绝写入，
 *     宁可这条没记上，也不能拿空数组覆盖整本账。
 * ============================================================================
 */
import z from 'schemastery'
import { statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'whale-persona'
export const inject = ['settings', 'tools']

/** 数据目录默认值：~/.dsh/persona-data（目录不存在会自动创建） */
const DEFAULT_SHARED_ROOT = join(homedir(), '.dsh', 'persona-data')

/* ─────────────── 文件读取（带 mtime 缓存）─────────────── */

const cache = new Map()

function readCached(file) {
  if (!file) return ''
  try {
    const st = statSync(file)
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    const text = readFileSync(file, 'utf8')
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  } catch {
    cache.delete(file)
    return ''
  }
}

function readJsonCached(file) {
  const raw = readCached(file)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/* ─────────────── 记忆账本 → 提示词段落 ─────────────── */

/**
 * 把 shared-memory.json 渲染成一段提示词。
 * items 是随手记的收件箱；tiers（可选）是分过层的长期记忆，
 * 字段约定：important[{who,what}] / long[{topic,summary}] / outline[{oneLine}]。
 */
function renderMemory(sharedRoot, limit, cap = 1400) {
  const file = join(sharedRoot, 'shared-memory.json')
  const doc = readJsonCached(file)
  const items = Array.isArray(doc?.items)
    ? doc.items.filter((i) => i && typeof i.text === 'string' && i.text.trim())
    : []

  const tiers = doc?.tiers && typeof doc.tiers === 'object' ? doc.tiers : null
  const tierLines = []
  if (tiers) {
    const imp = Array.isArray(tiers.important) ? tiers.important.slice(-8) : []
    const lng = Array.isArray(tiers.long) ? tiers.long.slice(-6) : []
    const out = Array.isArray(tiers.outline) ? tiers.outline.slice(-8) : []
    if (imp.length) {
      tierLines.push('■ 重要')
      for (const x of imp) tierLines.push(`- ${x?.who || '相关'}：${String(x?.what || '').slice(0, 120)}`)
    }
    if (lng.length) {
      tierLines.push('■ 近期')
      for (const x of lng) tierLines.push(`- ${x?.topic || '话题'}：${String(x?.summary || '').slice(0, 110)}`)
    }
    if (out.length) {
      tierLines.push('■ 永久大纲')
      for (const x of out) tierLines.push(`- ${String(x?.oneLine || '')}`)
    }
  }

  if (!items.length && !tierLines.length) return ''

  // 钉住的条目（名字、称呼、关系这类）永远排最前，且不占「最近 N 条」的额度。
  const pinned = items.filter((i) => i.pinned)
  const rest = items
    .filter((i) => !i.pinned)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
  const budget = pinned.length + limit

  const srcOf = (from) => (String(from || '').trim() ? `（来源：${String(from).slice(0, 24)}）` : '')

  const lines = []
  for (const it of [...pinned, ...rest]) {
    if (lines.length >= budget) break
    const mark = it.pinned ? '📌 ' : ''
    if (it.kind === 'impression') lines.push(`- ${mark}${it.target || '某人'}：${it.text}${srcOf(it.from)}`)
    else lines.push(`- ${mark}${it.text}${srcOf(it.from)}`)
  }
  if (!lines.length && !tierLines.length) return ''

  const blocks = []
  if (tierLines.length) blocks.push(tierLines.join('\n'))
  if (lines.length) blocks.push('■ 最近攒的\n' + lines.join('\n'))
  let body = blocks.join('\n\n')
  if (body.length > cap) body = `${body.slice(0, cap)}\n…`

  return `【共享记忆 · 跨会话累积的那本账】
${body}

（📌 是钉住的条目——名字、称呼、关系这类，永远排最前。「重要 → 近期 → 永久大纲」是分过层的，越往下记得越淡；其余是最近攒的。这些都是你自己记下的事，可以当成自己知道的东西自然提起。）`
}

/* ─────────────── 提示词段拼装 ─────────────── */

function buildSection(cfg) {
  const parts = []

  const core = String(cfg.coreText || '').trim()
  if (core) parts.push(core)

  const soul = readCached(cfg.soulPath)
  if (soul.trim()) parts.push(`===== 角色设定（soulPath）=====\n${soul.trim()}`)

  const current = readCached(join(cfg.sharedRoot, 'persona', 'current.md'))
  if (current.trim()) parts.push(`===== 长期人格沉淀（persona/current.md）=====\n${current.trim()}`)

  const mem = renderMemory(cfg.sharedRoot, cfg.memoryItems)
  if (mem) parts.push(mem)

  return parts.join('\n\n')
}

/* ─────────────── 状态：给工具和设置页看 ─────────────── */

function snapshotState(cfg) {
  const memoryFile = join(cfg.sharedRoot, 'shared-memory.json')
  const doc = readJsonCached(memoryFile)
  const items = Array.isArray(doc?.items) ? doc.items : []
  const cur = readCached(join(cfg.sharedRoot, 'persona', 'current.md'))
  // current.md 的版本标记形如 `<!-- persona-auto ver=5 at=... -->`
  const m = cur.match(/persona-auto[^>]*?ver\s*=\s*(\d+)/i) || cur.match(/ver\s*=\s*(\d+)/i)
  const ledger = readLedger(cfg.sharedRoot)
  return {
    sharedRoot: cfg.sharedRoot,
    soulPath: cfg.soulPath || null,
    soulBytes: (() => { try { return statSync(cfg.soulPath).size } catch { return 0 } })(),
    memoryCount: items.length,
    memoryLatestAt: items.length ? Math.max(...items.map((i) => Number(i.at) || 0)) : 0,
    personaVersion: m ? Number(m[1]) : null,
    personaChars: cur.length,
    ledgerCount: ledger.entries.length,
    ledgerPromoted: ledger.entries.filter((e) => e.promoted).length,
  }
}

/* ─────────────── 原子写入 ─────────────── */

const SHARED_MAX_ITEMS = 200
const LEDGER_MAX_ENTRIES = 500
const PROMOTE_AT = 3

function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/**
 * 严格读取记忆账本：区分「文件还没有」和「文件坏了 / 正被别的进程原子替换」。
 * 读失败一律拒绝写入 —— 用空数组兜底再写回会一次清空整本账。
 */
function readSharedStrict(file) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return { missing: true } }
  if (!raw.trim()) return { missing: true }
  try {
    const doc = JSON.parse(raw)
    if (!doc || !Array.isArray(doc.items)) return { broken: true }
    return { doc }
  } catch { return { broken: true } }
}

/** 带重试地拿一份可写副本；拿不到返回 null（调用方必须拒绝写入） */
function loadForWrite(file, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const r = readSharedStrict(file)
    if (r.doc) return r.doc
    if (r.missing) return { version: 1, items: [] }
    // broken：等一下再试（多半是另一个进程正在原子替换）
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40) } catch { /* 环境不支持就空转 */ }
  }
  return null
}

/** 写一条记忆：同 kind+text 视为同一条，累加 hits 而不是刷屏 */
function appendMemory(cfg, { kind, text, target, from }) {
  const file = join(cfg.sharedRoot, 'shared-memory.json')
  const body = String(text ?? '').trim().slice(0, 300)
  if (!body) return { ok: false, error: 'text 不能为空' }

  const doc = loadForWrite(file)
  if (!doc) {
    return {
      ok: false,
      error: '读取记忆账本失败（文件可能正被另一个进程写入或已损坏），本次不写入 —— 宁可这条没记上，也不能覆盖整本账',
    }
  }

  const items = Array.isArray(doc.items) ? doc.items : []
  const k = ['impression', 'topic', 'fact'].includes(kind) ? kind : 'fact'
  const t = String(target ?? '').trim().slice(0, 40) || undefined
  const src = String(from ?? 'dsh').trim().slice(0, 40)

  const hit = items.find((i) => i && i.kind === k && i.text === body && (i.target ?? '') === (t ?? ''))
  if (hit) {
    hit.at = Date.now()
    hit.hits = (Number(hit.hits) || 0) + 1
    if (src && !hit.from) hit.from = src
  } else {
    items.push({ kind: k, text: body, target: t, from: src, at: Date.now(), hits: 1 })
    if (items.length > SHARED_MAX_ITEMS) items.splice(0, items.length - SHARED_MAX_ITEMS)
  }

  // 保留账本里其它字段（比如外部脚本维护的 tiers），只重写 items
  const out = doc && typeof doc === 'object' ? { ...doc } : { version: 1 }
  out.version = out.version ?? 1
  out.items = items
  writeFileAtomic(file, JSON.stringify(out, null, 2))
  cache.delete(file)
  return { ok: true, kind: k, text: body, total: items.length, mergedIntoExisting: Boolean(hit) }
}

/* ─────────────── 人格账本（本地自带实现，无外部依赖）─────────────── */

function ledgerFile(sharedRoot) {
  return join(sharedRoot, 'persona', 'ledger.json')
}

function readLedger(sharedRoot) {
  const doc = readJsonCached(ledgerFile(sharedRoot))
  if (doc && Array.isArray(doc.entries)) return { version: doc.version ?? 1, entries: doc.entries }
  return { version: 1, entries: [] }
}

/**
 * 记一条人格观察。同一条重复累计到 PROMOTE_AT 次标记 promoted=true，
 * 表示「可以沉淀进 persona/current.md 了」——是否真的写进 current.md 由你决定
 * （插件本身只记账，不代替你做决定）。
 */
function personaLog(sharedRoot, { kind, text, src }) {
  const body = String(text ?? '').trim().slice(0, 120)
  if (!body) return { ok: false, error: 'text 不能为空' }

  const k = ['habit', 'value', 'impression'].includes(kind) ? kind : 'habit'
  const doc = readLedger(sharedRoot)
  const hit = doc.entries.find((e) => e && e.text === body && e.kind === k)

  let entry
  if (hit) {
    hit.count = (Number(hit.count) || 1) + 1
    hit.lastAt = Date.now()
    entry = hit
  } else {
    entry = {
      kind: k,
      text: body,
      count: 1,
      firstAt: Date.now(),
      lastAt: Date.now(),
      from: String(src || 'dsh').trim().slice(0, 40),
    }
    doc.entries.push(entry)
  }
  if (doc.entries.length > LEDGER_MAX_ENTRIES) doc.entries.splice(0, doc.entries.length - LEDGER_MAX_ENTRIES)
  entry.promoted = Number(entry.count) >= PROMOTE_AT

  writeFileAtomic(ledgerFile(sharedRoot), JSON.stringify({ version: doc.version ?? 1, entries: doc.entries }, null, 2))
  cache.delete(ledgerFile(sharedRoot))

  return {
    ok: true,
    kind: k,
    text: body,
    count: entry.count,
    promoteAt: PROMOTE_AT,
    promoted: entry.promoted,
    total: doc.entries.length,
  }
}

/** 可选：接一个外部人格账本模块（导出 personaLog / status 即可）；没有就用本地实现 */
async function loadExternalEvolve(cfg) {
  const p = String(cfg.personaEvolvePath || '').trim()
  if (!p) return null
  try {
    const abs = resolve(p)
    const mod = await import(pathToFileURL(abs).href)
    // 常见形态：具名导出 / default 导出 / 再套一层 .default
    const flat = { ...(mod || {}), ...(mod?.default || {}) }
    return typeof flat.personaLog === 'function' ? flat : null
  } catch {
    return null
  }
}

/* ─────────────── 工具脚手架 ─────────────── */

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

/* ─────────────── 插件主体 ─────────────── */

export function apply(ctx) {
  const scope = ctx.settings.register(
    'whale-persona',
    z.object({
      enabled: z.boolean().default(true),
      coreText: z.string().default(''),
      soulPath: z.string().default(''),
      sharedRoot: z.string().default(DEFAULT_SHARED_ROOT),
      personaEvolvePath: z.string().default(''),
      memoryItems: z.number().default(40),
    }),
  )

  const cfgNow = () => {
    const s = scope.get() ?? {}
    return {
      enabled: s.enabled !== false,
      coreText: typeof s.coreText === 'string' ? s.coreText : '',
      soulPath: typeof s.soulPath === 'string' ? s.soulPath.trim() : '',
      sharedRoot: (typeof s.sharedRoot === 'string' && s.sharedRoot.trim()) || DEFAULT_SHARED_ROOT,
      personaEvolvePath: typeof s.personaEvolvePath === 'string' ? s.personaEvolvePath : '',
      memoryItems: (() => {
        const n = Number(s.memoryItems)
        return Number.isFinite(n) ? Math.max(0, Math.min(n, 40)) : 40
      })(),
    }
  }

  let disposer = null
  let lastKey = ''
  let timer = null

  const applySection = (force = false) => {
    const cfg = cfgNow()
    if (!cfg.enabled) {
      if (disposer) { disposer(); disposer = null }
      lastKey = ''
      return
    }
    const text = buildSection(cfg)
    if (!text.trim()) {
      if (disposer) { disposer(); disposer = null }
      lastKey = ''
      return
    }
    const key = `${cfg.soulPath}|${cfg.sharedRoot}|${cfg.memoryItems}|${text.length}`
    if (!force && key === lastKey && disposer) return
    lastKey = key
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt === undefined) return
    if (disposer) { disposer(); disposer = null }
    disposer = systemPrompt.section({ name: 'whale:persona', order: 10, text })
  }

  applySection(true)

  // 文件变了就重建（30 秒一轮，只做 stat，很便宜）
  timer = setInterval(() => { try { applySection() } catch { /* 单次失败不影响下一轮 */ } }, 30_000)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.effect(() => scope.watch(() => { lastKey = ''; applySection(true) }), 'whale-persona: settings watch')

  ctx.effect(() => () => {
    if (disposer) { disposer(); disposer = null }
    if (timer) { clearInterval(timer); timer = null }
  }, 'whale-persona: section cleanup')

  /* ── 工具 ────────────────────────────────────────────────────────── */

  const tools = ctx.get('tools')
  if (tools === undefined) return

  const tool = (spec) => tools.register({
    ...spec,
    output: textOutput,
    async execute(args = {}) { return safe(await spec.execute(args)) },
  })

  try {
    tool({
      name: 'whale_remember',
      description: '记住一件事，写进跨会话共用的记忆账本；下次会话会被自动读到。\n'
        + 'kind：topic=正在聊/关心的事，fact=事实，impression=对某个人的印象（要填 target）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要记住的事，一句话，尽量短（≤300 字）' },
          kind: { type: 'string', enum: ['topic', 'fact', 'impression'], description: '默认 fact' },
          target: { type: 'string', description: 'impression 时填：这是关于谁的' },
        },
        required: ['text'],
      },
      async execute(args) {
        return appendMemory(cfgNow(), {
          kind: String(args.kind || 'fact'),
          text: args.text,
          target: args.target,
          from: 'dsh',
        })
      },
    })

    tool({
      name: 'whale_recall',
      description: '翻记忆账本。可按关键词/类型过滤，不填就按时间倒序给最近的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '关键词（匹配正文或对象）' },
          kind: { type: 'string', enum: ['topic', 'fact', 'impression'], description: '只看某一类' },
          limit: { type: 'number', description: '返回几条，默认 20，最大 100' },
        },
      },
      async execute(args) {
        const cfg = cfgNow()
        const doc = readJsonCached(join(cfg.sharedRoot, 'shared-memory.json')) ?? { items: [] }
        let items = Array.isArray(doc.items) ? doc.items : []
        const q = String(args.query || '').trim().toLowerCase()
        const kind = String(args.kind || '').trim()
        if (kind) items = items.filter((i) => i.kind === kind)
        if (q) {
          items = items.filter((i) => String(i.text || '').toLowerCase().includes(q)
            || String(i.target || '').toLowerCase().includes(q))
        }
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100))
        const sorted = items.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, limit)
        return {
          ok: true,
          matched: items.length,
          items: sorted.map((i) => ({
            kind: i.kind,
            text: i.text,
            target: i.target,
            from: i.from,
            at: i.at ? new Date(Number(i.at)).toISOString() : null,
            hits: i.hits,
          })),
        }
      },
    })

    tool({
      name: 'whale_grow',
      description: '把「我今天发现自己…」「我跟某人处成了…」这类长期观察写进人格账本。\n'
        + `同一条累计 ${PROMOTE_AT} 次后标记 promoted（可以沉淀进 persona/current.md）。\n`
        + '一条一件事，第一人称短句，最多 120 字。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['habit', 'value', 'impression'], description: 'habit=习惯/口头禅；value=在意的东西；impression=对某人的印象' },
          text: { type: 'string', description: '第一人称短句，最多 120 字' },
        },
        required: ['kind', 'text'],
      },
      async execute(args) {
        const cfg = cfgNow()
        const evolve = await loadExternalEvolve(cfg)
        if (evolve) {
          const r = evolve.personaLog({
            kind: String(args.kind || 'habit'),
            text: String(args.text || ''),
            src: 'dsh',
          })
          return { ok: true, via: 'external', ...(typeof r === 'object' && r ? r : { result: r }) }
        }
        const r = personaLog(cfg.sharedRoot, { kind: String(args.kind || 'habit'), text: args.text, src: 'dsh' })
        return { ...r, via: 'builtin' }
      },
    })

    tool({
      name: 'whale_status',
      description: '看记忆与人格账本的状态：记忆条数、人格沉淀版本、账本计数、各文件大小。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        const cfg = cfgNow()
        const st = snapshotState(cfg)
        const evolve = await loadExternalEvolve(cfg)
        let external = null
        try { external = evolve?.status?.() ?? null } catch { /* 外部模块状态读不到不算错 */ }
        return { ok: true, enabled: cfg.enabled, ...st, external }
      },
    })
  } catch (error) {
    // 工具注册失败不能让整条插件不激活
    ctx.logger?.warn?.(`whale-persona: 工具注册失败 ${error?.message ?? error}`)
  }
}
