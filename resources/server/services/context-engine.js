/**
 * ContextEngine v3.0 - 智能上下文管理（QClaw 核心模块）
 *
 * v3.0 新增（参考 openclaw context-compressor + oMLX 架构）：
 *   ① SlidingSummary  - 超长对话滑动摘要：旧消息压缩成一段摘要 token 节省 50%+
 *   ② DedupeFilter    - 去重过滤：相似内容不重复发送
 *   ③ PriorityPruning - 优先级裁剪：保留最近 + 重要（含工具结果）消息
 *   ④ PrefixCache     - 前缀指纹缓存，跳过重复 system prompt prefill
 *   ⑤ TieredKVCache   - Hot(RAM) + Cold(SSD) 双层持久化缓存
 *   ⑥ EnginePool      - 多模型 LRU Slot 管理 + 请求计量
 *
 * token 节省目标：长对话节省 40~70% token，响应更快，内存更少
 */

const prefixCache  = require('./prefix-cache')
const kvCache      = require('./tiered-kv-cache')
const enginePool   = require('./engine-pool')

// ── 摘要缓存（sessionId → { summary, summarizedUpTo, createdAt }）─────────────
const summaryCache = new Map()

/**
 * 简单文本相似度（Jaccard on trigrams）
 * 用于去重过滤，避免将过于相似的相邻消息都发送给模型
 */
function textSimilarity(a, b) {
  if (!a || !b) return 0
  const trigrams = (s) => {
    const t = new Set()
    const str = s.slice(0, 400)
    for (let i = 0; i <= str.length - 3; i++) t.add(str.slice(i, i + 3))
    return t
  }
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const g of ta) if (tb.has(g)) inter++
  return inter / (ta.size + tb.size - inter)
}

/**
 * 生成对话摘要（在本地不调用 AI，用规则快速生成）
 * 策略：提取每条消息的前 N 字 + 关键词，拼成一段摘要
 */
function buildLocalSummary(messages) {
  if (!messages.length) return ''
  const lines = []
  for (const m of messages) {
    const role    = m.role === 'user' ? '用户' : 'AI'
    const content = (m.content || '').trim()
    if (!content) continue
    // 只保留前 80 字
    const snippet = content.length > 80 ? content.slice(0, 80) + '...' : content
    lines.push(`${role}: ${snippet}`)
  }
  return `[早期对话摘要]\n${lines.join('\n')}\n[摘要结束，以下为近期完整对话]`
}

class ContextEngine {
  constructor(options = {}) {
    this.maxTokens     = options.maxTokens     || 8000
    this.reserveTokens = options.reserveTokens || 2000
    this.minMessages   = options.minMessages   || 4
    this._plugins      = []

    // 可通过 options 覆盖单例（单测用）
    this._prefixCache = options._prefixCache || prefixCache
    this._kvCache     = options._kvCache     || kvCache
    this._enginePool  = options._enginePool  || enginePool
  }

  // ── Plugin 机制 ────────────────────────────────────────────────────────────
  registerPlugin(plugin) { this._plugins.push(plugin) }

  // ── Token 估算 ─────────────────────────────────────────────────────────────
  estimateTokens(text) {
    if (!text) return 0
    return Math.ceil((typeof text === 'string' ? text : JSON.stringify(text)).length / 2.5)
  }
  estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + this.estimateTokens(m.content) + 4, 0)
  }

  // ── 核心：compress（v3.0，三策略叠加）──────────────────────────────────────
  compress(messages, opts = {}) {
    if (!messages?.length) return []

    const budget    = (opts.maxTokens || this.maxTokens) - this.reserveTokens
    const fastMode  = opts.fastMode  || false
    const sessionId = opts.sessionId || null

    for (const plugin of this._plugins) {
      if (plugin.compress) {
        const result = plugin.compress(messages, { budget, fastMode })
        if (result) return result
      }
    }

    return this._defaultCompress(messages, budget, fastMode, sessionId)
  }

  _defaultCompress(messages, budget, fastMode, sessionId) {
    const systemMsgs = messages.filter(m => m.role === 'system')
    let   dialogMsgs = messages.filter(m => m.role !== 'system')

    if (!dialogMsgs.length) return systemMsgs

    const systemTokens = this.estimateMessagesTokens(systemMsgs)
    const dialogBudget = budget - systemTokens

    if (dialogBudget <= 0) return this._truncateToFit([...systemMsgs], budget)

    // fastMode：只保留最近 8 条
    if (fastMode) dialogMsgs = dialogMsgs.slice(-8)

    // ── 策略1：已在预算内，只做去重过滤 ────────────────────────────────────
    if (this.estimateMessagesTokens(dialogMsgs) <= dialogBudget) {
      dialogMsgs = this._dedupeFilter(dialogMsgs)
      return [...systemMsgs, ...dialogMsgs]
    }

    // ── 策略2：滑动摘要（对话 > 12 条时，将旧消息压缩成摘要）──────────────
    if (dialogMsgs.length > 12) {
      dialogMsgs = this._slidingSummaryCompress(dialogMsgs, dialogBudget, sessionId)
    }

    // ── 策略3：优先级裁剪（保留最近 N 条 + 含 tool 结果的重要消息）─────────
    if (this.estimateMessagesTokens(dialogMsgs) > dialogBudget) {
      dialogMsgs = this._priorityPrune(dialogMsgs, dialogBudget)
    }

    // ── 兜底：截断最后一条 user 消息 ────────────────────────────────────────
    if (this.estimateMessagesTokens(dialogMsgs) > dialogBudget) {
      dialogMsgs = this._truncateLastUserMessage(dialogMsgs, dialogBudget)
    }

    return [...systemMsgs, ...dialogMsgs]
  }

  /**
   * 去重过滤：相邻消息 Jaccard 相似度 > 0.85 则跳过重复内容
   * 典型场景：用户重复问同一问题、AI 重复输出相似内容
   */
  _dedupeFilter(messages) {
    if (messages.length <= 4) return messages
    const result = [messages[0]]
    for (let i = 1; i < messages.length; i++) {
      const cur  = messages[i]
      const prev = result[result.length - 1]
      // 同 role 相邻且内容高度相似 → 跳过
      if (cur.role === prev.role) {
        const sim = textSimilarity(cur.content, prev.content)
        if (sim > 0.85) continue
      }
      result.push(cur)
    }
    return result
  }

  /**
   * 滑动摘要压缩：
   * 保留最近 RECENT_KEEP 条消息完整，将更早的消息压缩成一条摘要消息
   * 节省 token：对 20 条对话可减少约 50% token
   */
  _slidingSummaryCompress(messages, budget, sessionId) {
    const RECENT_KEEP = Math.max(this.minMessages, 10)

    if (messages.length <= RECENT_KEEP) return messages

    const recentMsgs = messages.slice(-RECENT_KEEP)
    const oldMsgs    = messages.slice(0, -RECENT_KEEP)

    // 检查是否有缓存摘要（同 session + 同消息数量）
    let summaryText = null
    if (sessionId) {
      const cached = summaryCache.get(sessionId)
      if (cached && cached.summarizedCount === oldMsgs.length) {
        summaryText = cached.summary
      }
    }

    if (!summaryText) {
      summaryText = buildLocalSummary(oldMsgs)
      // 写摘要缓存
      if (sessionId) {
        summaryCache.set(sessionId, {
          summary:         summaryText,
          summarizedCount: oldMsgs.length,
          createdAt:       Date.now(),
        })
        // 最多保留 200 个 session 摘要
        if (summaryCache.size > 200) {
          const oldest = summaryCache.keys().next().value
          summaryCache.delete(oldest)
        }
      }
    }

    const summaryMsg = { role: 'system', content: summaryText }
    const compressed = [summaryMsg, ...recentMsgs]

    // 验证压缩后还是否超预算
    if (this.estimateMessagesTokens(compressed) <= budget) {
      return compressed
    }

    // 如果摘要+最近消息还超，缩减 RECENT_KEEP
    const trimmedRecent = recentMsgs.slice(-Math.max(4, Math.floor(RECENT_KEEP / 2)))
    return [summaryMsg, ...trimmedRecent]
  }

  /**
   * 优先级裁剪：
   * 打分规则（越高越重要，越不被裁剪）：
   *   - 最近 6 条：+10
   *   - 含 [工具执行结果] / tool_result：+8
   *   - user 消息：+3（保留问题）
   *   - 消息 token > 500（长消息）：-2（长消息相对低优先级）
   * 从低分开始裁剪，直到预算内
   */
  _priorityPrune(messages, budget) {
    if (messages.length <= this.minMessages) return messages

    const scored = messages.map((m, i) => {
      let score = 0
      const isRecent = i >= messages.length - 6
      if (isRecent)                                   score += 10
      if (m.content?.includes('[工具执行结果]'))       score += 8
      if (m.content?.includes('[自动错误修正]'))       score += 6
      if (m.role === 'user')                          score += 3
      if (m.hidden)                                   score -= 5  // hidden 消息低优先级
      const tok = this.estimateTokens(m.content)
      if (tok > 500)                                  score -= 2
      return { m, score, idx: i }
    })

    // 按分数升序（低分先被裁剪），保留至少 minMessages 条
    const sorted = [...scored].sort((a, b) => a.score - b.score)
    const keep   = new Set(messages.map((_, i) => i))  // 初始全保留

    for (const { idx } of sorted) {
      if (keep.size <= this.minMessages) break
      if (this.estimateMessagesTokens([...keep].map(i => messages[i])) <= budget) break
      keep.delete(idx)
    }

    return [...keep].sort((a, b) => a - b).map(i => messages[i])
  }

  _truncateLastUserMessage(messages, budget) {
    const result = [...messages]
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'user') {
        const otherTokens  = this.estimateMessagesTokens(result.filter((_, idx) => idx !== i))
        const allowedChars = Math.floor(Math.max(0, budget - otherTokens - 20) * 2.5)
        const content      = result[i].content || ''
        if (allowedChars > 0 && content.length > allowedChars) {
          result[i] = { ...result[i], content: content.slice(0, allowedChars) + '\n[...内容已截断以适应 Token 限制]' }
        }
        break
      }
    }
    return result
  }

  _truncateToFit(messages, budget) {
    while (messages.length > 1 && this.estimateMessagesTokens(messages) > budget) {
      messages = messages.slice(1)
    }
    return messages
  }

  // ── 核心：build（整合三层缓存）────────────────────────────────────────────

  /**
   * 构建最终发送给模型的消息列表（带三层缓存）
   *
   * @param {string} systemPrompt
   * @param {Array}  messages       - 对话历史（不含 system）
   * @param {object} opts
   *   @param {number}  opts.maxTokens
   *   @param {boolean} opts.fastMode
   *   @param {string}  opts.sessionId   - 用于 TieredKVCache 键
   *   @param {string}  opts.providerId  - 用于 EnginePool Slot
   *   @param {string}  opts.modelId     - 用于 EnginePool Slot
   *
   * @returns {{ messages: Array, meta: CacheMeta }}
   *   meta.cacheHit        {boolean}
   *   meta.prefixHit       {boolean}
   *   meta.prefixKey       {string}
   *   meta.originalTokens  {number}
   *   meta.compressedTokens{number}
   *   meta.slot            {EngineSlot|null}
   */
  async buildWithCache(systemPrompt, messages, opts = {}) {
    const { maxTokens = this.maxTokens, fastMode = false, sessionId, providerId, modelId } = opts

    // ─ 1. 构造完整消息（含 system）────────────────────────────
    let fullMessages = []
    if (systemPrompt && (!messages[0] || messages[0].role !== 'system')) {
      fullMessages = [{ role: 'system', content: systemPrompt }, ...messages]
    } else {
      fullMessages = [...messages]
    }

    const originalTokens = this.estimateMessagesTokens(fullMessages)

    // ─ 2. PrefixCache 前缀命中检查 ────────────────────────────
    const prefixResult  = this._prefixCache.lookup(fullMessages)
    const prefixHit     = prefixResult.hit

    // ─ 3. TieredKVCache 会话级命中 ───────────────────────────
    let sessionCacheHit    = false
    let compressedMessages = null

    if (sessionId && !fastMode) {
      const cacheKey   = `ctx::${sessionId}::${this._prefixCache.fingerprint(fullMessages)}`
      const cached     = await this._kvCache.get(cacheKey)
      if (cached?.messages) {
        // 验证缓存仍在 token 预算内
        const cachedTokens = this.estimateMessagesTokens(cached.messages)
        if (cachedTokens <= maxTokens - this.reserveTokens) {
          compressedMessages = cached.messages
          sessionCacheHit    = true
        }
      }
    }

    // ─ 4. 执行压缩（缓存未命中时）────────────────────────────
    if (!compressedMessages) {
      compressedMessages = this.compress(fullMessages, { maxTokens, fastMode, sessionId })

      // 异步写缓存（不阻塞）
      if (sessionId && !fastMode) {
        const cacheKey = `ctx::${sessionId}::${this._prefixCache.fingerprint(fullMessages)}`
        const compTokens = this.estimateMessagesTokens(compressedMessages)
        this._kvCache.set(cacheKey, {
          messages:   compressedMessages,
          tokens:     compTokens,
          cachedAt:   Date.now(),
          providerId,
          modelId,
        }).catch(() => {})

        // 写 PrefixCache
        this._prefixCache.store(prefixResult.key, {
          compressedTokens: compTokens,
          originalTokens,
          providerId,
          modelId,
        })
      }
    }

    // ─ 5. EnginePool Slot 计量 ────────────────────────────────
    let slot = null
    if (providerId && modelId) {
      slot = this._enginePool.acquire(providerId, modelId)
    }

    const compressedTokens = this.estimateMessagesTokens(compressedMessages)

    return {
      messages: compressedMessages,
      meta: {
        cacheHit:         sessionCacheHit,
        prefixHit,
        prefixKey:        prefixResult.key,
        originalTokens,
        compressedTokens,
        saved:            originalTokens - compressedTokens,
        slot,
      },
    }
  }

  /**
   * 同步版 build（向后兼容，不使用缓存层）
   */
  build(systemPrompt, messages, opts = {}) {
    let finalMessages = []
    if (systemPrompt && (!messages[0] || messages[0].role !== 'system')) {
      finalMessages = [{ role: 'system', content: systemPrompt }, ...messages]
    } else {
      finalMessages = [...messages]
    }
    return this.compress(finalMessages, opts)
  }

  // ── 缓存管理 API ──────────────────────────────────────────────────────────

  /** 使某个 session 的缓存失效（对话删除时调用） */
  async invalidateSession(sessionId) {
    const prefix = `ctx::${sessionId}::`
    // 使用 HotTier 的公开接口
    this._kvCache.hot.deleteByPrefix(prefix)
  }

  /** 获取所有缓存层统计 */
  async getCacheStats() {
    const [kvStats] = await Promise.all([this._kvCache.getStats()])
    return {
      prefixCache:  this._prefixCache.getStats(),
      kvCache:      kvStats,
      enginePool:   this._enginePool.getSummary(),
    }
  }
}

module.exports = new ContextEngine({
  maxTokens:     8000,
  reserveTokens: 2000,
  minMessages:   4,
})
module.exports.ContextEngine = ContextEngine  // 方便单测
