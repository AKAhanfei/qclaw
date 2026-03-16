/**
 * TieredKVCache - 分层 KV 缓存（oMLX 核心架构移植）
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │                    Tiered KV Cache                       │
 * │                                                         │
 * │  ┌──────────────────┐      ┌──────────────────────┐    │
 * │  │   Hot Tier (RAM) │  ──▶ │   Cold Tier (SSD)    │    │
 * │  │  最近 N 个会话    │      │  持久化，服务重启保留 │    │
 * │  │  LRU 淘汰        │      │  JSON/safetensors     │    │
 * │  └──────────────────┘      └──────────────────────┘    │
 * └─────────────────────────────────────────────────────────┘
 *
 * 存储内容（KV 不是 GPU KV Cache，而是「对话上下文摘要缓存」）：
 *   - session 对话历史摘要（压缩后的 messages）
 *   - 关联 token 数、provider、模型 ID
 *   - 命中后可直接恢复为下一轮 ContextEngine 输入
 *
 * 读取策略（三级降级）：
 *   1. Hot  命中 → 直接返回，O(1)
 *   2. Cold 命中 → 读文件，提升到 Hot
 *   3. 未命中  → 正常请求，结束后写入 Hot + Cold
 *
 * Windows 说明：
 *   Cold Tier 路径默认 %APPDATA%/.qclaw/kv-cache/
 *   写入使用 async fs，不阻塞请求链路
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// ── 路径解析（跨平台）──────────────────────────────────────────────────────
function getDefaultCacheDir() {
  // Windows: C:\Users\<user>\AppData\Roaming\.qclaw\kv-cache
  // macOS/Linux: ~/.qclaw/kv-cache
  const base = process.env.APPDATA || os.homedir()
  return path.join(base, '.qclaw', 'kv-cache')
}

// ── Hot Tier（内存 LRU）────────────────────────────────────────────────────

class HotTier {
  /**
   * @param {number} maxEntries  - 最大 session 数（默认 100）
   * @param {number} ttlMs       - TTL 毫秒（默认 60 分钟）
   */
  constructor(maxEntries = 100, ttlMs = 60 * 60 * 1000) {
    this.maxEntries = maxEntries
    this.ttlMs      = ttlMs
    /** @type {Map<string, HotEntry>} */
    this._map       = new Map()
    this.stats      = { hits: 0, misses: 0, evictions: 0 }
  }

  get(key) {
    const entry = this._map.get(key)
    if (!entry) { this.stats.misses++; return null }

    if (Date.now() - entry.ts > this.ttlMs) {
      this._map.delete(key)
      this.stats.misses++
      return null
    }

    // LRU：重新插入到 Map 尾部（Map 保持插入顺序）
    this._map.delete(key)
    entry.ts       = Date.now()
    entry.accessed = (entry.accessed || 0) + 1
    this._map.set(key, entry)

    this.stats.hits++
    return entry.value
  }

  set(key, value) {
    if (this._map.size >= this.maxEntries) {
      // 淘汰最旧的（Map 第一个条目）
      const firstKey = this._map.keys().next().value
      this._map.delete(firstKey)
      this.stats.evictions++
    }
    this._map.set(key, { value, ts: Date.now(), accessed: 0 })
  }

  delete(key) { this._map.delete(key) }

  /** 删除所有以 prefix 开头的 key */
  deleteByPrefix(prefix) {
    let removed = 0
    for (const key of this._map.keys()) {
      if (key.startsWith(prefix)) { this._map.delete(key); removed++ }
    }
    return removed
  }

  clear() { this._map.clear() }

  size() { return this._map.size }

  /** 清除过期条目 */
  gc() {
    const now = Date.now()
    let removed = 0
    for (const [k, v] of this._map) {
      if (now - v.ts > this.ttlMs) { this._map.delete(k); removed++ }
    }
    return removed
  }

  getStats() {
    return {
      ...this.stats,
      size: this._map.size,
      maxEntries: this.maxEntries,
      hitRate: (() => {
        const t = this.stats.hits + this.stats.misses
        return t > 0 ? `${((this.stats.hits / t) * 100).toFixed(1)}%` : '0.0%'
      })(),
    }
  }
}

// ── Cold Tier（SSD 文件）──────────────────────────────────────────────────

class ColdTier {
  /**
   * @param {string} cacheDir  - SSD 缓存目录
   * @param {boolean} enabled  - 开关
   */
  constructor(cacheDir, enabled = true) {
    this.cacheDir = cacheDir || getDefaultCacheDir()
    this.enabled  = enabled
    this.stats    = { hits: 0, misses: 0, writes: 0, errors: 0 }

    if (this.enabled) this._ensureDir()
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    } catch (e) {
      console.warn('[ColdTier] 无法创建缓存目录:', e.message)
      this.enabled = false
    }
  }

  _filePath(key) {
    // 用 key 的前 8 位作二级目录，避免单目录文件过多
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '')
    const sub  = safe.slice(0, 2)
    return path.join(this.cacheDir, sub, `${safe}.json`)
  }

  async get(key) {
    if (!this.enabled) return null
    const file = this._filePath(key)
    try {
      const raw   = await fs.promises.readFile(file, 'utf8')
      const entry = JSON.parse(raw)

      // TTL 检查
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        fs.promises.unlink(file).catch(() => {})
        this.stats.misses++
        return null
      }

      this.stats.hits++
      return entry.value
    } catch {
      this.stats.misses++
      return null
    }
  }

  async set(key, value, ttlMs = 24 * 60 * 60 * 1000) {
    if (!this.enabled) return
    const file = this._filePath(key)
    const dir  = path.dirname(file)
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      const entry = {
        key,
        value,
        createdAt:  Date.now(),
        expiresAt:  Date.now() + ttlMs,
        version:    '1.0',
      }
      await fs.promises.writeFile(file, JSON.stringify(entry), 'utf8')
      this.stats.writes++
    } catch (e) {
      this.stats.errors++
      // 静默失败，不影响主请求链路
    }
  }

  async delete(key) {
    if (!this.enabled) return
    try { await fs.promises.unlink(this._filePath(key)) } catch {}
  }

  /** 清除所有过期文件（定期 GC 用） */
  async gc() {
    if (!this.enabled) return 0
    let removed = 0
    try {
      const entries = await fs.promises.readdir(this.cacheDir, { withFileTypes: true })
      await Promise.allSettled(entries
        .filter(e => e.isDirectory())
        .map(async subDir => {
          const subPath = path.join(this.cacheDir, subDir.name)
          const files   = await fs.promises.readdir(subPath).catch(() => [])
          await Promise.allSettled(files.map(async f => {
            if (!f.endsWith('.json')) return
            const fp = path.join(subPath, f)
            try {
              const raw   = await fs.promises.readFile(fp, 'utf8')
              const entry = JSON.parse(raw)
              if (entry.expiresAt && Date.now() > entry.expiresAt) {
                await fs.promises.unlink(fp)
                removed++
              }
            } catch { await fs.promises.unlink(fp).catch(() => {}); removed++ }
          }))
        })
      )
    } catch {}
    return removed
  }

  async size() {
    if (!this.enabled) return 0
    // 优化：直接用内存计数器，避免扫描文件系统（文件数多时极慢）
    return this.stats.writes
  }

  /** 精确统计磁盘文件数（仅供调试，勿在热路径调用）*/
  async sizeFromDisk() {
    if (!this.enabled) return 0
    let count = 0
    try {
      const entries = await fs.promises.readdir(this.cacheDir, { withFileTypes: true })
      await Promise.allSettled(entries
        .filter(e => e.isDirectory())
        .map(async subDir => {
          const files = await fs.promises.readdir(path.join(this.cacheDir, subDir.name)).catch(() => [])
          count += files.filter(f => f.endsWith('.json')).length
        })
      )
    } catch {}
    return count
  }

  getStats() { return { ...this.stats, cacheDir: this.cacheDir, enabled: this.enabled } }
}

// ── TieredKVCache（门面类）─────────────────────────────────────────────────

class TieredKVCache {
  /**
   * @param {object} opts
   * @param {number}  opts.hotMaxEntries  - Hot Tier 最大条目（默认 100）
   * @param {number}  opts.hotTtlMs       - Hot Tier TTL（默认 60min）
   * @param {string}  opts.coldDir        - Cold Tier 目录（默认 ~/.qclaw/kv-cache）
   * @param {boolean} opts.coldEnabled    - 是否开启 SSD 持久化（默认 true）
   * @param {number}  opts.coldTtlMs      - Cold Tier TTL（默认 24h）
   * @param {number}  opts.gcIntervalMs   - GC 间隔（默认 30min）
   */
  constructor(opts = {}) {
    this.hot  = new HotTier(
      opts.hotMaxEntries ?? 100,
      opts.hotTtlMs      ?? 60 * 60 * 1000
    )
    this.cold = new ColdTier(
      opts.coldDir     || getDefaultCacheDir(),
      opts.coldEnabled ?? true
    )
    this.coldTtlMs = opts.coldTtlMs ?? 24 * 60 * 60 * 1000

    this.stats = { promotions: 0 }  // Cold → Hot 提升次数

    // 定时 GC
    const gcInterval = opts.gcIntervalMs ?? 30 * 60 * 1000
    this._gcTimer = setInterval(() => this._runGC(), gcInterval)
    if (this._gcTimer.unref) this._gcTimer.unref()  // 不阻止进程退出
  }

  // ── 核心接口 ──────────────────────────────────────────────────────────────

  /**
   * 读取（Hot → Cold → miss）
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    // 1. Hot Tier
    const hot = this.hot.get(key)
    if (hot !== null) return hot

    // 2. Cold Tier
    const cold = await this.cold.get(key)
    if (cold !== null) {
      // 提升到 Hot
      this.hot.set(key, cold)
      this.stats.promotions++
      return cold
    }

    return null
  }

  /**
   * 写入（同时写 Hot + 异步写 Cold）
   * @param {string} key
   * @param {any}    value
   */
  async set(key, value) {
    this.hot.set(key, value)
    // Cold 写入异步，不 await，不阻塞请求
    this.cold.set(key, value, this.coldTtlMs).catch(() => {})
  }

  /**
   * 删除（Hot + Cold 同时删除）
   */
  async delete(key) {
    this.hot.delete(key)
    await this.cold.delete(key)
  }

  /**
   * 清空 Hot Tier（Cold 保留，用于重启恢复）
   */
  clearHot() { this.hot.clear() }

  /**
   * 完整清空（Hot + Cold）
   */
  async clearAll() {
    this.hot.clear()
    // 仅删除 Cold 目录内文件
    const dir = this.cold.cacheDir
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      await Promise.allSettled(entries.map(async e => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await fs.promises.rm(p, { recursive: true, force: true })
        else await fs.promises.unlink(p)
      }))
    } catch {}
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    const coldSize = await this.cold.size()
    return {
      hot:  this.hot.getStats(),
      cold: { ...this.cold.getStats(), fileCount: coldSize },
      promotions: this.stats.promotions,
    }
  }

  // ── GC ────────────────────────────────────────────────────────────────────

  async _runGC() {
    const hotRemoved  = this.hot.gc()
    const coldRemoved = await this.cold.gc()
    if (hotRemoved + coldRemoved > 0) {
      console.log(`[TieredKVCache GC] Hot -${hotRemoved}, Cold -${coldRemoved}`)
    }
  }

  destroy() {
    clearInterval(this._gcTimer)
  }
}

// 单例导出
const instance = new TieredKVCache({
  hotMaxEntries: 100,
  hotTtlMs:      60  * 60 * 1000,   // 60min Hot
  coldTtlMs:     24  * 60 * 60 * 1000, // 24h Cold
  coldEnabled:   true,
  gcIntervalMs:  30  * 60 * 1000,   // 30min GC
})

module.exports = instance
module.exports.TieredKVCache = TieredKVCache  // 方便测试
module.exports.HotTier       = HotTier
module.exports.ColdTier      = ColdTier
