/**
 * EnginePool - 多模型 LRU 管理（oMLX EnginePool 移植）
 *
 * oMLX 原版：在 Apple Silicon 上管理多个 MLX 模型实例，LRU 淘汰，
 *           支持模型固定（pin）、TTL、内存限制。
 *
 * QClaw 版本：管理多个 Provider 实例的「活跃会话 / 配置快照」，
 *           实现：
 *             1. 活跃会话按 Provider+Model 粒度分组
 *             2. 超出 maxSlots 时 LRU 淘汰「空闲」会话的缓存
 *             3. 支持 pin（固定常用模型，不被 LRU 淘汰）
 *             4. 提供实时状态：各 Provider 的活跃请求数 + 累计调用
 *             5. 与 TieredKVCache 协作：淘汰时将 session 数据 flush 到 Cold
 *
 * 架构：
 *
 *   EnginePool
 *     │
 *     ├── Slot { providerId, modelId, pinned, lastUsed, activeReqs, stats }
 *     ├── Slot ...
 *     └── Slot ...（最多 maxSlots 个）
 *
 *  Registry.streamChat() 调用时：
 *    1. enginePool.acquire(providerId, modelId) → 获得 slot，activeReqs++
 *    2. 请求完成 → enginePool.release(slot)，activeReqs--，更新 lastUsed
 *    3. 超出容量时 enginePool.evict() 淘汰最久未用的非 pinned slot
 */

const kvCache = require('./tiered-kv-cache')

class EngineSlot {
  constructor(providerId, modelId, pinned = false) {
    this.id         = `${providerId}::${modelId}`
    this.providerId = providerId
    this.modelId    = modelId
    this.pinned     = pinned
    this.lastUsed   = Date.now()
    this.activeReqs = 0
    this.stats      = {
      totalRequests:  0,
      totalTokensIn:  0,
      totalTokensOut: 0,
      errors:         0,
    }
  }

  toJSON() {
    return {
      id:         this.id,
      providerId: this.providerId,
      modelId:    this.modelId,
      pinned:     this.pinned,
      lastUsed:   new Date(this.lastUsed).toISOString(),
      activeReqs: this.activeReqs,
      stats:      this.stats,
    }
  }
}

class EnginePool {
  /**
   * @param {object} opts
   * @param {number}   opts.maxSlots     - 最大活跃 Slot 数（默认 8）
   * @param {number}   opts.ttlMs        - Slot 空闲超时（默认 30min）
   * @param {string[]} opts.pinnedModels - 启动时固定的模型 ["providerId::modelId", ...]
   */
  constructor(opts = {}) {
    this.maxSlots     = opts.maxSlots     ?? 8
    this.ttlMs        = opts.ttlMs        ?? 30 * 60 * 1000
    this.pinnedModels = new Set(opts.pinnedModels || [])

    /** @type {Map<string, EngineSlot>} */
    this._slots = new Map()

    // 定期清理 TTL 过期的空闲 slot
    this._gcTimer = setInterval(() => this._gcIdle(), 10 * 60 * 1000)
    if (this._gcTimer.unref) this._gcTimer.unref()
  }

  // ── Slot 管理 ──────────────────────────────────────────────────────────────

  /**
   * 获取（或创建）一个 Slot，activeReqs++
   * @param {string} providerId
   * @param {string} modelId
   * @returns {EngineSlot}
   */
  acquire(providerId, modelId) {
    const key  = `${providerId}::${modelId}`
    let   slot = this._slots.get(key)

    if (!slot) {
      // 检查容量，必要时淘汰
      if (this._slots.size >= this.maxSlots) {
        this._evictLRU()
      }
      slot = new EngineSlot(providerId, modelId, this.pinnedModels.has(key))
      this._slots.set(key, slot)
    }

    slot.activeReqs++
    slot.lastUsed = Date.now()
    slot.stats.totalRequests++
    return slot
  }

  /**
   * 请求完成，释放 Slot（activeReqs--）
   * @param {EngineSlot|string} slotOrKey
   * @param {object} metrics - { tokensIn?, tokensOut?, error? }
   */
  release(slotOrKey, metrics = {}) {
    const key  = typeof slotOrKey === 'string' ? slotOrKey : slotOrKey.id
    const slot = this._slots.get(key)
    if (!slot) return

    slot.activeReqs = Math.max(0, slot.activeReqs - 1)
    slot.lastUsed   = Date.now()

    if (metrics.tokensIn)  slot.stats.totalTokensIn  += metrics.tokensIn
    if (metrics.tokensOut) slot.stats.totalTokensOut += metrics.tokensOut
    if (metrics.error)     slot.stats.errors++
  }

  /**
   * 手动固定模型（不被 LRU 淘汰）
   */
  pin(providerId, modelId) {
    const key = `${providerId}::${modelId}`
    this.pinnedModels.add(key)
    const slot = this._slots.get(key)
    if (slot) slot.pinned = true
  }

  /**
   * 取消固定
   */
  unpin(providerId, modelId) {
    const key = `${providerId}::${modelId}`
    this.pinnedModels.delete(key)
    const slot = this._slots.get(key)
    if (slot) slot.pinned = false
  }

  // ── 状态查询 ──────────────────────────────────────────────────────────────

  /** 获取所有 Slot 状态 */
  list() {
    return Array.from(this._slots.values()).map(s => s.toJSON())
  }

  /** 获取指定 Provider 的状态 */
  getProviderStats(providerId) {
    const slots = Array.from(this._slots.values()).filter(s => s.providerId === providerId)
    return {
      activeSlots:   slots.length,
      activeReqs:    slots.reduce((sum, s) => sum + s.activeReqs, 0),
      totalRequests: slots.reduce((sum, s) => sum + s.stats.totalRequests, 0),
      models:        slots.map(s => s.modelId),
    }
  }

  /** 全局汇总统计 */
  getSummary() {
    const slots = Array.from(this._slots.values())
    return {
      totalSlots:    slots.length,
      maxSlots:      this.maxSlots,
      activeReqs:    slots.reduce((sum, s) => sum + s.activeReqs, 0),
      totalRequests: slots.reduce((sum, s) => sum + s.stats.totalRequests, 0),
      pinnedCount:   slots.filter(s => s.pinned).length,
      slots:         slots.map(s => s.toJSON()),
    }
  }

  // ── 淘汰 / GC ─────────────────────────────────────────────────────────────

  /**
   * LRU 淘汰一个 Slot（不淘汰 pinned / 有活跃请求的）
   */
  _evictLRU() {
    let candidateKey  = null
    let candidateTime = Infinity

    for (const [key, slot] of this._slots) {
      if (slot.pinned || slot.activeReqs > 0) continue
      if (slot.lastUsed < candidateTime) {
        candidateTime = slot.lastUsed
        candidateKey  = key
      }
    }

    if (candidateKey) {
      // 淘汰前异步将该 slot 的统计快照写入 Cold Tier
      const slot    = this._slots.get(candidateKey)
      const cacheKey = `engine-slot::${candidateKey}`
      kvCache.set(cacheKey, slot.toJSON()).catch(() => {})

      this._slots.delete(candidateKey)
      console.log(`[EnginePool] 淘汰 Slot: ${candidateKey}`)
    }
  }

  /** 清理 TTL 超时且无活跃请求的 Slot */
  _gcIdle() {
    const now     = Date.now()
    let   removed = 0
    for (const [key, slot] of this._slots) {
      if (!slot.pinned && slot.activeReqs === 0 && (now - slot.lastUsed) > this.ttlMs) {
        kvCache.set(`engine-slot::${key}`, slot.toJSON()).catch(() => {})
        this._slots.delete(key)
        removed++
      }
    }
    if (removed > 0) console.log(`[EnginePool GC] 清理 ${removed} 个空闲 Slot`)
  }

  destroy() {
    clearInterval(this._gcTimer)
  }
}

module.exports = new EnginePool({
  maxSlots:     8,
  ttlMs:        30 * 60 * 1000,
  pinnedModels: [],
})
module.exports.EnginePool = EnginePool
module.exports.EngineSlot = EngineSlot
