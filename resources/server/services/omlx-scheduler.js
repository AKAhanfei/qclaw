/**
 * oMLX ContinuousBatchScheduler — Node.js 移植版 (QClaw v1.1.0)
 *
 * 原版 oMLX（Apple Silicon Python/MLX）核心调度架构：
 *   - Continuous Batching：不等待整个 batch 完成，新请求随时插入
 *   - Paged KV cache：固定大小 block 管理，前缀共享 + Copy-on-Write
 *   - Priority Queue：按请求优先级（fastMode > normal > background）调度
 *   - Preemption：高优先级请求可抢占低优先级
 *
 * QClaw Node.js 移植策略：
 *   GPU KV Tensor → 对话上下文 token 预算（context budget）
 *   MLX Stream    → Node.js AsyncQueue + EventEmitter
 *   Block Manager → Token-budget 分块（每块 512 tokens）
 *   Scheduler     → 请求队列 + 优先级排序 + 并发限制
 *
 * 核心效果：
 *   1. 并发多请求时按优先级有序调度（不是随机 FIFO）
 *   2. 快速请求（fastMode）优先于普通请求
 *   3. 超出并发限制时排队，不丢弃，按序执行
 *   4. 超时/取消请求自动从队列移除
 *   5. 实时统计：队列长度、等待时间、吞吐量
 */

const { EventEmitter } = require('events')

// ── 请求优先级 ──────────────────────────────────────────────────────────────
const Priority = Object.freeze({
  HIGH:   3,   // fastMode 或者短对话（< 4 轮）
  NORMAL: 2,   // 普通对话
  LOW:    1,   // 后台任务（title 生成、记忆提取等）
})

// ── 请求状态机 ──────────────────────────────────────────────────────────────
const ReqState = Object.freeze({
  QUEUED:    'queued',
  RUNNING:   'running',
  DONE:      'done',
  CANCELLED: 'cancelled',
  TIMEOUT:   'timeout',
})

// ── 单个调度请求 ─────────────────────────────────────────────────────────────
class ScheduledRequest {
  constructor({ id, priority, tokenBudget, sessionId, providerId, modelId, execute, timeoutMs }) {
    this.id          = id || `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.priority    = priority    ?? Priority.NORMAL
    this.tokenBudget = tokenBudget ?? 8192
    this.sessionId   = sessionId   || null
    this.providerId  = providerId  || 'unknown'
    this.modelId     = modelId     || 'unknown'
    this.execute     = execute     // async () => void  — 实际执行函数
    this.timeoutMs   = timeoutMs   ?? 120_000  // 2 分钟超时
    this.state       = ReqState.QUEUED
    this.enqueuedAt  = Date.now()
    this.startedAt   = null
    this.doneAt      = null
    this._resolve    = null
    this._reject     = null
    this._timer      = null
    // 等待 promise（外部 await scheduler.submit(...) 时用）
    this.promise     = new Promise((res, rej) => {
      this._resolve = res
      this._reject  = rej
    })
  }

  /** 等待时间（ms） */
  get waitMs()  { return this.startedAt ? this.startedAt - this.enqueuedAt : Date.now() - this.enqueuedAt }
  /** 执行时间（ms） */
  get runMs()   { return (this.doneAt ?? Date.now()) - (this.startedAt ?? Date.now()) }

  startTimeout() {
    this._timer = setTimeout(() => {
      if (this.state !== ReqState.RUNNING && this.state !== ReqState.QUEUED) return
      this.state = ReqState.TIMEOUT
      this._reject(new Error(`[oMLX Scheduler] 请求超时 (${this.timeoutMs}ms): ${this.id}`))
    }, this.timeoutMs)
    if (this._timer.unref) this._timer.unref()
  }

  clearTimeout() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }
}

// ── 主调度器 ─────────────────────────────────────────────────────────────────
class OmlxScheduler extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number}  opts.maxConcurrent  - 最大并发请求数（默认 3）
   * @param {number}  opts.maxQueueSize   - 最大排队数（超出则 backpressure，默认 20）
   * @param {number}  opts.totalTokenBudget - 全局 token 预算（默认 40960）
   * @param {number}  opts.blockSize      - 每个分页 block 的 token 数（默认 512，对齐 oMLX）
   */
  constructor(opts = {}) {
    super()
    this.maxConcurrent   = opts.maxConcurrent   ?? 3
    this.maxQueueSize    = opts.maxQueueSize     ?? 20
    this.totalTokenBudget= opts.totalTokenBudget ?? 40960
    this.blockSize       = opts.blockSize        ?? 512

    /** @type {ScheduledRequest[]} 优先级队列（按 priority 降序，同 priority 按 enqueuedAt 升序）*/
    this._queue    = []
    /** @type {Map<string, ScheduledRequest>} 执行中请求 */
    this._running  = new Map()
    /** 当前已分配 token budget */
    this._allocatedTokens = 0

    this._stats = {
      totalSubmitted:  0,
      totalCompleted:  0,
      totalCancelled:  0,
      totalTimeout:    0,
      totalErrors:     0,
      maxWaitMs:       0,
      avgWaitMs:       0,
      waitSamples:     [],  // 最近 50 次等待时间
      throughput:      0,   // 近 1 分钟完成请求数
      _completedLast:  [],  // 近 1 分钟完成时间戳
    }

    // 定期清理已完成 + 过期的 running（防止泄漏）
    this._gcTimer = setInterval(() => this._gc(), 30_000)
    if (this._gcTimer.unref) this._gcTimer.unref()
  }

  // ── 提交请求（核心入口）────────────────────────────────────────────────────

  /**
   * 提交一个推理请求到调度队列
   * @param {object} opts
   *   opts.execute      {Function}  async 执行函数，调用时传入 (req) => void
   *   opts.priority     {number}    Priority.HIGH / NORMAL / LOW
   *   opts.tokenBudget  {number}    此次请求预估 token 数
   *   opts.sessionId    {string}
   *   opts.providerId   {string}
   *   opts.modelId      {string}
   *   opts.fastMode     {boolean}   自动升为 HIGH 优先级
   *   opts.timeoutMs    {number}
   * @returns {Promise<void>}  请求完成时 resolve，失败时 reject
   */
  async submit(opts) {
    // fastMode 自动提升优先级
    const priority = opts.fastMode ? Priority.HIGH
      : (opts.priority ?? Priority.NORMAL)

    // 背压：队列已满，拒绝低优先级请求
    if (this._queue.length >= this.maxQueueSize && priority === Priority.LOW) {
      throw new Error('[oMLX Scheduler] 队列已满，低优先级请求被拒绝')
    }

    const req = new ScheduledRequest({ ...opts, priority })
    req.startTimeout()

    this._queue.push(req)
    this._sortQueue()
    this._stats.totalSubmitted++

    this.emit('queued', { id: req.id, priority, queueLength: this._queue.length })

    // 尝试立即调度
    this._dispatch()

    return req.promise
  }

  // ── 内部调度循环 ──────────────────────────────────────────────────────────

  _dispatch() {
    while (
      this._queue.length > 0 &&
      this._running.size < this.maxConcurrent
    ) {
      const req = this._queue[0]

      // token budget 检查（分页分配）
      const blocks  = Math.ceil(req.tokenBudget / this.blockSize)
      const needed  = blocks * this.blockSize
      if (this._allocatedTokens + needed > this.totalTokenBudget) {
        // 预算不足：等待当前请求完成后再试
        break
      }

      this._queue.shift()  // 出队

      if (req.state === ReqState.CANCELLED || req.state === ReqState.TIMEOUT) {
        continue  // 跳过已取消/超时
      }

      // 分配 token budget
      this._allocatedTokens += needed
      req._allocatedBlocks   = blocks
      req._allocatedTokens   = needed
      req.state              = ReqState.RUNNING
      req.startedAt          = Date.now()

      this._running.set(req.id, req)
      this.emit('started', { id: req.id, providerId: req.providerId, modelId: req.modelId })

      // 异步执行，不阻塞调度循环
      this._executeRequest(req).catch(() => {})
    }
  }

  async _executeRequest(req) {
    try {
      await req.execute(req)

      req.state  = ReqState.DONE
      req.doneAt = Date.now()
      req.clearTimeout()
      req._resolve()

      this._recordCompletion(req)
      this.emit('done', { id: req.id, waitMs: req.waitMs, runMs: req.runMs })

    } catch (err) {
      if (req.state !== ReqState.TIMEOUT) {
        req.state  = ReqState.DONE
        req.doneAt = Date.now()
        req.clearTimeout()
        req._reject(err)
        this._stats.totalErrors++
        this.emit('error', { id: req.id, error: err.message })
      }
    } finally {
      // 释放 token budget
      this._allocatedTokens = Math.max(0, this._allocatedTokens - (req._allocatedTokens || 0))
      this._running.delete(req.id)
      // 继续调度队列中的下一个请求
      setImmediate(() => this._dispatch())
    }
  }

  // ── 优先级队列排序 ────────────────────────────────────────────────────────

  _sortQueue() {
    this._queue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority  // 高优先级在前
      return a.enqueuedAt - b.enqueuedAt  // 同优先级按 FIFO
    })
  }

  // ── 取消请求 ──────────────────────────────────────────────────────────────

  cancel(reqId) {
    // 从队列取消
    const idx = this._queue.findIndex(r => r.id === reqId)
    if (idx >= 0) {
      const req = this._queue.splice(idx, 1)[0]
      req.state = ReqState.CANCELLED
      req.clearTimeout()
      req._reject(new Error(`[oMLX Scheduler] 请求已取消: ${reqId}`))
      this._stats.totalCancelled++
      return true
    }
    // 运行中的无法取消（已在执行），返回 false
    return false
  }

  /** 取消某个 session 的所有排队请求 */
  cancelSession(sessionId) {
    const toCancel = this._queue.filter(r => r.sessionId === sessionId)
    toCancel.forEach(r => this.cancel(r.id))
    return toCancel.length
  }

  // ── 统计 & 状态 ───────────────────────────────────────────────────────────

  _recordCompletion(req) {
    this._stats.totalCompleted++
    const waitMs = req.waitMs
    this._stats.waitSamples.push(waitMs)
    if (this._stats.waitSamples.length > 50) this._stats.waitSamples.shift()
    this._stats.maxWaitMs = Math.max(this._stats.maxWaitMs, waitMs)
    const sum = this._stats.waitSamples.reduce((a, b) => a + b, 0)
    this._stats.avgWaitMs = Math.round(sum / this._stats.waitSamples.length)

    // 近 1 分钟吞吐
    const now = Date.now()
    this._stats._completedLast.push(now)
    this._stats._completedLast = this._stats._completedLast.filter(t => now - t < 60_000)
    this._stats.throughput = this._stats._completedLast.length
  }

  getStatus() {
    return {
      running:         this._running.size,
      queued:          this._queue.length,
      maxConcurrent:   this.maxConcurrent,
      allocatedTokens: this._allocatedTokens,
      totalTokenBudget:this.totalTokenBudget,
      blockSize:       this.blockSize,
      queueDetails:    this._queue.slice(0, 5).map(r => ({
        id:       r.id,
        priority: r.priority,
        waitMs:   r.waitMs,
        session:  r.sessionId,
      })),
      stats: { ...this._stats, _completedLast: undefined },
    }
  }

  // ── GC 清理 ───────────────────────────────────────────────────────────────

  _gc() {
    // 清理 running 中的僵尸请求（超过 5 分钟还在 running 状态）
    const now = Date.now()
    for (const [id, req] of this._running) {
      if (req.startedAt && now - req.startedAt > 5 * 60_000) {
        req.clearTimeout()
        this._allocatedTokens = Math.max(0, this._allocatedTokens - (req._allocatedTokens || 0))
        this._running.delete(id)
        console.warn(`[oMLX Scheduler] GC 清理僵尸请求: ${id}`)
      }
    }
  }
}

// ── 推测解码 Hint（oMLX speculative decoding 移植）──────────────────────────
/**
 * oMLX 推测解码：用小草稿模型生成候选 token，大模型验证。
 * QClaw 移植：通过在 prompt 末尾注入「续写暗示」来模拟 draft token 效果，
 * 让模型更快进入续写模式，减少 TTFT（首 token 延迟）。
 *
 * 策略：
 *   - 检测用户最后一句话的意图（代码/解释/列表/短答）
 *   - 在 system prompt 末尾注入对应的「输出格式暗示」
 *   - 模型会更快生成符合格式的 token，减少随机探索时间
 */
function buildSpeculativeHint(lastUserMsg) {
  if (!lastUserMsg) return ''
  const msg = lastUserMsg.toLowerCase()

  // 代码相关 → 暗示代码块输出（中英文）
  if (/写|实现|代码|function|class|def |import |const |let |var |fix|bug|error|write|implement|create a|build a/.test(msg)) {
    return '\n\n[输出格式提示: 代码块优先，直接给出实现]'
  }
  // 列表/步骤 → 暗示列表（中英文）
  // 注意："如何" 必须搭配"实现/操作/配置/部署"等动词，避免"今天如何" 误触发
  if (/步骤|流程|怎么做|怎样做|方法有|列举|有哪些|优缺点|对比|如何实现|如何配置|如何部署|如何安装|如何使用|list|steps|how to |how do |ways to |compare/.test(msg)) {
    return '\n\n[输出格式提示: 用有序列表组织回答]'
  }
  // 解释/概念 → 暗示简短解释（中英文）
  if (/什么是|解释|原理|为什么|区别|含义|what is|explain|why |difference|meaning of/.test(msg)) {
    return '\n\n[输出格式提示: 先一句话核心定义，再展开]'
  }
  // 是否/判断 → 暗示直接回答（中英文）
  if (/^(是否|能不能|可以吗|对吗|有没有|是不是|can i|can you|should i|is it|does it|do i)/.test(msg.trim())) {
    return '\n\n[输出格式提示: 先给出是/否判断，再补充说明]'
  }
  return ''
}

// 单例导出
const scheduler = new OmlxScheduler({
  maxConcurrent:    3,
  maxQueueSize:     20,
  totalTokenBudget: 40960,   // 约 5 个并发 8k 请求的预算
  blockSize:        512,
})

module.exports = {
  scheduler,
  OmlxScheduler,
  Priority,
  ReqState,
  buildSpeculativeHint,
}
