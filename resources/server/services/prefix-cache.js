/**
 * PrefixCache - 前缀缓存（oMLX 核心理念移植）
 *
 * 核心思路：
 *   相同的 system prompt + 对话前缀 → 相同的 hash → 命中缓存
 *   → 跳过重复 token prefill 成本，直接复用上下文标识
 *
 * 实现方式：
 *   - 对消息序列做 SHA-256 fingerprint
 *   - 内存 Map（Hot）缓存最近 N 个前缀 + 其元数据
 *   - LRU 淘汰策略：超出 maxEntries 时清除最久未访问的
 *   - 供 ContextEngine 在 build() 时调用：返回 cacheKey 和 cacheHit
 *
 * 与 ContextEngine 协作：
 *   ContextEngine.build() → PrefixCache.lookup(prefix)
 *     命中 → 记录 cacheHit, 后续可跳过重复压缩 / 告知 Provider
 *     未命中 → 正常压缩，压缩完成后 PrefixCache.store(key, meta)
 */

const crypto = require('crypto')

class PrefixCache {
  /**
   * @param {object} opts
   * @param {number} opts.maxEntries   - Hot 内存最大缓存条目数（默认 200）
   * @param {number} opts.ttlMs        - 缓存 TTL 毫秒（默认 30 分钟）
   * @param {boolean} opts.enabled     - 开关（默认 true）
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 200
    this.ttlMs      = opts.ttlMs      ?? 30 * 60 * 1000   // 30min
    this.enabled    = opts.enabled    ?? true

    /** @type {Map<string, CacheEntry>} */
    this._store = new Map()

    /** 统计 */
    this.stats = { hits: 0, misses: 0, stores: 0, evictions: 0 }
  }

  // ── Hash ───────────────────────────────────────────────────────────────────

  /**
   * 对消息序列（含 system prompt）生成前缀 fingerprint
   * @param {Array} messages  - [{ role, content }, ...]
   * @param {number} depth    - 取前 depth 条消息参与 hash（默认全部）
   * @returns {string}        - hex hash
   */
  fingerprint(messages, depth = messages.length) {
    const slice   = messages.slice(0, depth)
    const payload = slice.map(m => `${m.role}:${m.content}`).join('\x00')
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
  }

  /**
   * 生成多级前缀 hash（增量哈希，O(n) 复杂度）
   *
   * 优化策略：
   *   - 从短到长逐步构建哈希，每步只追加新消息的差量
   *   - 使用 HMAC-like 链式结构：hash[i] = SHA256(hash[i-1] + msg[i])
   *   - 返回从最长到最短的列表（优先命中最长匹配）
   */
  fingerprintChain(messages) {
    if (!messages?.length) return []

    const chain  = []
    let   prev   = ''  // 上一级的 hash（空串代表起始）

    // 从短到长，增量计算
    for (let d = 1; d <= messages.length; d++) {
      const m       = messages[d - 1]
      const segment = `${m.role}:${m.content}`
      // 链式：新 hash = SHA256(前一个 hash + 当前消息段)
      const hash    = crypto
        .createHash('sha256')
        .update(prev + '\x00' + segment)
        .digest('hex')
        .slice(0, 32)
      chain.push({ depth: d, hash })
      prev = hash
    }

    // 翻转：优先尝试最长前缀匹配
    chain.reverse()
    return chain
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  /**
   * 查找最长前缀命中
   * @param {Array} messages
   * @returns {{ hit: boolean, key: string, depth: number, meta: object|null }}
   */
  lookup(messages) {
    if (!this.enabled || !messages?.length) {
      return { hit: false, key: this.fingerprint(messages), depth: 0, meta: null }
    }

    const chain = this.fingerprintChain(messages)
    const now   = Date.now()

    for (const { depth, hash } of chain) {
      const entry = this._store.get(hash)
      if (!entry) continue

      // TTL 检查
      if (now - entry.createdAt > this.ttlMs) {
        this._store.delete(hash)
        continue
      }

      // LRU 更新
      entry.lastAccess = now
      entry.hits++
      this.stats.hits++

      return { hit: true, key: hash, depth, meta: entry.meta }
    }

    this.stats.misses++
    return { hit: false, key: chain[0]?.hash || '', depth: 0, meta: null }
  }

  // ── Store ──────────────────────────────────────────────────────────────────

  /**
   * 存储前缀缓存条目
   * @param {string} key    - fingerprint hash
   * @param {object} meta   - 关联元数据（压缩后 token 数、模型 ID 等）
   */
  store(key, meta = {}) {
    if (!this.enabled) return

    // 已存在则更新
    if (this._store.has(key)) {
      this._store.get(key).meta       = meta
      this._store.get(key).lastAccess = Date.now()
      return
    }

    // 容量检查，LRU 淘汰
    if (this._store.size >= this.maxEntries) {
      this._evictLRU()
    }

    this._store.set(key, {
      meta,
      createdAt:  Date.now(),
      lastAccess: Date.now(),
      hits:       0,
    })
    this.stats.stores++
  }

  // ── Invalidate ─────────────────────────────────────────────────────────────

  /** 删除指定 key */
  invalidate(key) { this._store.delete(key) }

  /** 清空全部缓存 */
  clear() {
    this._store.clear()
    this.stats = { hits: 0, misses: 0, stores: 0, evictions: 0 }
  }

  /** 清除所有过期条目 */
  gc() {
    const now = Date.now()
    let removed = 0
    for (const [k, v] of this._store) {
      if (now - v.createdAt > this.ttlMs) {
        this._store.delete(k)
        removed++
      }
    }
    return removed
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const total    = this.stats.hits + this.stats.misses
    const hitRate  = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : '0.0'
    return {
      ...this.stats,
      total,
      hitRate: `${hitRate}%`,
      cacheSize: this._store.size,
      maxEntries: this.maxEntries,
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _evictLRU() {
    let oldestKey  = null
    let oldestTime = Infinity
    for (const [k, v] of this._store) {
      if (v.lastAccess < oldestTime) {
        oldestTime = v.lastAccess
        oldestKey  = k
      }
    }
    if (oldestKey) {
      this._store.delete(oldestKey)
      this.stats.evictions++
    }
  }
}

module.exports = new PrefixCache({
  maxEntries: 200,
  ttlMs:      30 * 60 * 1000,
  enabled:    true,
})
