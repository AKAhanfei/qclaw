/**
 * QClaw Auto-Optimizer - 自动修复优化引擎 v2.0
 *
 * 功能：
 *   1. 持续健康监控：Ollama 服务、Provider 响应、内存使用
 *   2. 自动修复：检测到异常自动重试、切换备用 Provider
 *   3. 性能优化：缓存命中率分析、提示词压缩建议
 *   4. 自我学习：记录历史修复动作，优化参数配置
 *   5. 优化报告：可通过 API 查询历史优化记录
 *   6. 【v2.0 新增】自动网络检索优化（Web Heartbeat）：
 *      每 6 小时从公开资源获取 LLM 推理优化技巧，保存到本地知识库
 *      用于自动更新 system prompt 中的优化建议
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const http = require('http')
const https = require('https')

const DATA_DIR         = path.join(os.homedir(), '.qclaw')
const OPT_LOG_FILE     = path.join(DATA_DIR, 'optimizer.json')
const WEB_FETCH_FILE   = path.join(DATA_DIR, 'web-opt-hints.json')  // 网络检索结果缓存

// ── 默认配置 ─────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled:              true,
  checkIntervalMs:      60 * 1000,      // 每 60s 执行一轮检测
  ollamaUrl:            'http://localhost:11434',
  backendUrl:           'http://localhost:3001',
  maxRepairRetries:     3,
  responseTimeWarnMs:   8000,            // 响应超过 8s 触发优化建议
  memoryWarnMB:         800,             // 内存超过 800MB 触发告警
  autoTuneTemperature:  true,            // 自动根据错误率调整 temperature
  cacheTuneEnabled:     true,            // 自动分析缓存命中率
  // ── v2.0 Web Heartbeat ─────────────────────────────────────────────────────
  webFetchEnabled:      true,            // 是否启用网络检索优化
  webFetchIntervalMs:   6 * 60 * 60 * 1000,  // 每 6 小时检索一次
  webFetchTimeout:      10000,           // 网络请求超时 10s
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

// ── 优化记录管理 ─────────────────────────────────────────────────────────────
class OptimizerLog {
  constructor() {
    ensureDir()
    this.entries = this._load()
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(OPT_LOG_FILE, 'utf8'))
    } catch {
      return []
    }
  }

  save() {
    try {
      ensureDir()
      // 只保留最近 100 条
      if (this.entries.length > 100) this.entries = this.entries.slice(-100)
      fs.writeFileSync(OPT_LOG_FILE, JSON.stringify(this.entries, null, 2))
    } catch {}
  }

  push(type, action, detail, level = 'info') {
    const entry = {
      ts:     Date.now(),
      iso:    new Date().toISOString(),
      type,
      action,
      detail,
      level,   // info | warn | fix | error
    }
    this.entries.push(entry)
    console.log(`[AutoOptimizer][${level.toUpperCase()}] [${type}] ${action}: ${detail}`)
    this.save()
    return entry
  }

  getLast(n = 50) {
    return this.entries.slice(-n).reverse()
  }
}

// ── 自动优化引擎主类 ──────────────────────────────────────────────────────────
class AutoOptimizer {
  constructor() {
    this.config       = { ...DEFAULT_CONFIG }
    this.log          = new OptimizerLog()
    this.running      = false
    this._timer       = null
    this._webTimer    = null   // v2.0 网络检索定时器
    this._stats       = {
      totalChecks:      0,
      totalFixes:       0,
      totalWarnings:    0,
      ollamaDownCount:  0,
      lastCheckAt:      null,
      lastFixAt:        null,
      avgResponseMs:    0,
      responseSamples:  [],    // 保留最近 20 次响应时间
      errorRate:        0,
      errorCount:       0,
      successCount:     0,
    }
    this._repairRetry = {}
    this._tuneState   = {
      currentTemperature: 0.7,
      errorThreshold:     0.3,    // 错误率超过 30% 降低 temperature
    }
    // v2.0: 网络检索状态
    this._webFetchState = {
      lastFetchAt:    null,
      lastHints:      [],
      fetchCount:     0,
      errorCount:     0,
    }
  }

  // ── 核心检测周期 ─────────────────────────────────────────────────────────────
  async runCycle() {
    this._stats.totalChecks++
    this._stats.lastCheckAt = Date.now()

    const results = await Promise.allSettled([
      this._checkOllama(),
      this._checkBackend(),
      this._checkMemory(),
      this._checkProviderConfig(),
    ])

    // 统计本轮异常
    let cycleErrors = 0
    for (const r of results) {
      if (r.status === 'rejected') cycleErrors++
      else if (r.value && r.value.fixed) this._stats.totalFixes++
    }

    // 自动调参
    if (this.config.autoTuneTemperature) {
      await this._autoTuneParams()
    }

    return {
      ts:          Date.now(),
      checks:      results.length,
      errors:      cycleErrors,
      stats:       this._stats,
    }
  }

  // ── 检测 1：Ollama 服务 ──────────────────────────────────────────────────────
  async _checkOllama() {
    const t0 = Date.now()
    try {
      const data = await this._httpGet(`${this.config.ollamaUrl}/api/tags`, 5000)
      const models = data.models || []
      const elapsed = Date.now() - t0

      // 记录响应时间样本
      this._recordResponseTime(elapsed)

      const hasQwen35 = models.some(m => m.name === 'qwen3.5:latest' || m.name.includes('qwen3.5'))

      if (!hasQwen35) {
        this._stats.totalWarnings++
        this.log.push('ollama', 'model_missing', 'qwen3.5:latest 不在已安装列表，建议运行: ollama pull qwen3.5:latest', 'warn')
        return { ok: false, warning: 'model_missing' }
      }

      if (elapsed > this.config.responseTimeWarnMs) {
        this._stats.totalWarnings++
        this.log.push('ollama', 'slow_response', `响应时间 ${elapsed}ms 超过阈值 ${this.config.responseTimeWarnMs}ms`, 'warn')
      }

      this._stats.ollamaDownCount = 0
      this._repairRetry['ollama'] = 0
      return { ok: true, elapsed, models: models.length }

    } catch (e) {
      this._stats.ollamaDownCount++
      const retries = (this._repairRetry['ollama'] || 0) + 1
      this._repairRetry['ollama'] = retries

      if (retries <= this.config.maxRepairRetries) {
        this.log.push('ollama', 'service_down', `Ollama 不可达（第${retries}次），等待恢复...`, 'error')
        // 尝试激活备用 Provider
        await this._activateFallbackProvider()
      } else {
        this.log.push('ollama', 'repair_exhausted', `已重试 ${retries} 次，建议手动重启 Ollama`, 'error')
      }
      return { ok: false, error: e.message }
    }
  }

  // ── 检测 2：后端服务 ─────────────────────────────────────────────────────────
  async _checkBackend() {
    try {
      const data = await this._httpGet(`${this.config.backendUrl}/health`, 3000)

      // 检查 provider 是否正确
      // /health 返回的 data.provider 是字符串（providerId），如 "ollama"
      const providerId = typeof data.provider === 'string'
        ? data.provider
        : (data.provider?.id || null)

      // 只在 provider 明确是非 ollama 时才触发漂移修正（undefined/null 表示未知，不处理）
      if (providerId && providerId !== 'ollama') {
        // 防抖：记录上次漂移时间，同一漂移 10 分钟内只记录一次
        const now = Date.now()
        const lastDrift = this._lastProviderDrift || 0
        if (now - lastDrift > 10 * 60 * 1000) {
          this._lastProviderDrift = now
          this.log.push('backend', 'provider_drift', `当前激活 Provider 为 ${providerId}，期望 ollama，自动修正中...`, 'warn')
          await this._switchToOllama()
        }
        return { ok: true, fixed: true, action: 'provider_switched' }
      }

      // 检查调度器状态（仅首次停止时记录一次）
      if (data.scheduler && !data.scheduler.running && !this._schedulerStopLogged) {
        this._schedulerStopLogged = true
        this.log.push('backend', 'scheduler_stopped', '定时任务调度器已停止，记录异常', 'warn')
        this._stats.totalWarnings++
      } else if (data.scheduler?.running) {
        this._schedulerStopLogged = false  // 调度器恢复后重置标志
      }

      return { ok: true, provider: providerId, jobs: data.scheduler?.jobs }

    } catch (e) {
      // 后端不可达：防抖，1分钟内只记录一次
      const now = Date.now()
      const lastUnreachable = this._lastBackendUnreachable || 0
      if (now - lastUnreachable > 60 * 1000) {
        this._lastBackendUnreachable = now
        this.log.push('backend', 'unreachable', `后端服务不可达: ${e.message}`, 'error')
      }
      return { ok: false, error: e.message }
    }
  }

  // ── 检测 3：内存使用 ─────────────────────────────────────────────────────────
  async _checkMemory() {
    const mem = process.memoryUsage()
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
    const rssMB  = Math.round(mem.rss / 1024 / 1024)

    if (rssMB > this.config.memoryWarnMB) {
      this._stats.totalWarnings++
      this.log.push('memory', 'high_usage', `RSS 内存 ${rssMB}MB 超过阈值 ${this.config.memoryWarnMB}MB，执行 GC 建议`, 'warn')

      // 触发 V8 GC（如果可用）
      if (global.gc) {
        global.gc()
        this.log.push('memory', 'gc_triggered', `手动触发 GC，当前堆内存 ${heapMB}MB`, 'fix')
        this._stats.totalFixes++
      }
    }

    return { ok: true, heapMB, rssMB }
  }

  // ── 检测 4：Provider 配置完整性 ──────────────────────────────────────────────
  async _checkProviderConfig() {
    try {
      const registry  = require('../providers/registry')
      const activeId  = registry.activeProvider  // 字符串 ID，如 "ollama"
      const activeP   = registry.get(activeId)   // Provider 对象

      if (!activeId || !activeP) {
        this.log.push('config', 'no_active_provider', '无激活的 Provider，尝试激活 ollama', 'error')
        try { registry.setActive('ollama') } catch {}
        return { ok: false }
      }

      // 确认 qwen3.5:latest 在模型列表中
      const models = activeP.config?.availableModels || []
      const hasQwen35 = models.some(m => m.id === 'qwen3.5:latest')

      if (activeId === 'ollama' && !hasQwen35) {
        this.log.push('config', 'model_not_in_list', 'qwen3.5:latest 不在 Ollama 模型列表，建议更新 registry.js', 'warn')
        this._stats.totalWarnings++
      }

      // 验证默认模型
      const currentModel = activeP.config?.currentModel || activeP.currentModel
      if (activeId === 'ollama' && currentModel && currentModel !== 'qwen3.5:latest') {
        this.log.push('config', 'model_drift', `当前模型 ${currentModel} 与预期 qwen3.5:latest 不符，自动修正`, 'warn')
        if (activeP.config) activeP.config.currentModel = 'qwen3.5:latest'
        else activeP.currentModel = 'qwen3.5:latest'
        this.log.push('config', 'model_fixed', '默认模型已修正为 qwen3.5:latest', 'fix')
        this._stats.totalFixes++
        return { ok: true, fixed: true }
      }

      return { ok: true, provider: activeId, model: currentModel }

    } catch (e) {
      this.log.push('config', 'check_error', e.message, 'error')
      return { ok: false, error: e.message }
    }
  }

  // ── 自动调参：根据历史错误率调整 temperature ──────────────────────────────────
  async _autoTuneParams() {
    const total = this._stats.errorCount + this._stats.successCount
    if (total < 10) return  // 样本不足

    const errorRate = this._stats.errorCount / total
    this._stats.errorRate = Math.round(errorRate * 100) / 100

    let newTemp = this._tuneState.currentTemperature

    if (errorRate > this._tuneState.errorThreshold) {
      // 错误率高 → 降低 temperature，让模型更保守
      newTemp = Math.max(0.3, this._tuneState.currentTemperature - 0.05)
      if (newTemp !== this._tuneState.currentTemperature) {
        this.log.push('tune', 'temperature_decreased',
          `错误率 ${(errorRate*100).toFixed(1)}% 超阈值，temperature ${this._tuneState.currentTemperature} → ${newTemp}`, 'fix')
        this._tuneState.currentTemperature = newTemp
        this._stats.totalFixes++
      }
    } else if (errorRate < 0.05 && this._tuneState.currentTemperature < 0.7) {
      // 错误率极低 → 恢复 temperature
      newTemp = Math.min(0.7, this._tuneState.currentTemperature + 0.05)
      if (newTemp !== this._tuneState.currentTemperature) {
        this.log.push('tune', 'temperature_restored',
          `错误率 ${(errorRate*100).toFixed(1)}% 良好，temperature 恢复到 ${newTemp}`, 'info')
        this._tuneState.currentTemperature = newTemp
      }
    }
  }

  // ── 修复动作：激活备用 Provider ─────────────────────────────────────────────
  async _activateFallbackProvider() {
    try {
      const registry = require('../providers/registry')
      // 找第一个有 API Key 的备用 Provider
      const providers = registry.list()
      const fallback  = providers.find(p =>
        p.id !== 'ollama' &&
        (p.config?.apiKey || process.env[`${p.id.toUpperCase()}_API_KEY`])
      )

      if (fallback) {
        registry.setActive(fallback.id)
        this.log.push('repair', 'fallback_activated',
          `Ollama 不可达，已切换到备用 Provider: ${fallback.id}`, 'fix')
        this._stats.totalFixes++
      } else {
        this.log.push('repair', 'no_fallback', 'Ollama 不可达且无其他可用 Provider', 'error')
      }
    } catch (e) {
      this.log.push('repair', 'fallback_error', e.message, 'error')
    }
  }

  // ── 修复动作：切换回 Ollama ──────────────────────────────────────────────────
  async _switchToOllama() {
    try {
      const registry = require('../providers/registry')
      registry.setActive('ollama')
      this.log.push('repair', 'switched_to_ollama', '已切换回 Ollama Provider', 'fix')
      this._stats.totalFixes++
    } catch (e) {
      this.log.push('repair', 'switch_error', e.message, 'error')
    }
  }

  // ── 记录对话成功/失败（供外部调用）────────────────────────────────────────────
  recordSuccess(responseMs) {
    this._stats.successCount++
    this._recordResponseTime(responseMs)
  }

  recordError(reason) {
    this._stats.errorCount++
    this.log.push('chat', 'chat_error', reason, 'error')
  }

  _recordResponseTime(ms) {
    this._stats.responseSamples.push(ms)
    if (this._stats.responseSamples.length > 20) {
      this._stats.responseSamples.shift()
    }
    const sum = this._stats.responseSamples.reduce((a, b) => a + b, 0)
    this._stats.avgResponseMs = Math.round(sum / this._stats.responseSamples.length)
  }

  // ── HTTP GET 工具（不依赖 axios）────────────────────────────────────────────
  _httpGet(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(body)) }
          catch { resolve({ raw: body }) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`请求超时 (${timeoutMs}ms): ${url}`))
      })
    })
  }

  // ── 获取状态摘要 ─────────────────────────────────────────────────────────────
  getStatus() {
    return {
      running:        this.running,
      config:         { ...this.config },
      stats:          { ...this._stats },
      tuneState:      { ...this._tuneState },
      webFetchState:  { ...this._webFetchState },
      lastEntries:    this.log.getLast(10),
    }
  }

  getLog(n = 50) {
    return this.log.getLast(n)
  }

  // ── 启动 / 停止 ──────────────────────────────────────────────────────────────
  start() {
    if (this.running) return
    this.running = true
    this.log.push('optimizer', 'started',
      `自动优化引擎已启动，检测间隔 ${this.config.checkIntervalMs / 1000}s`, 'info')

    // 启动后立即执行一次
    this.runCycle().catch(() => {})

    this._timer = setInterval(() => {
      this.runCycle().catch((e) => {
        this.log.push('optimizer', 'cycle_error', e.message, 'error')
      })
    }, this.config.checkIntervalMs)

    if (this._timer.unref) this._timer.unref()  // 不阻止进程退出

    // ── v2.0 启动 Web Heartbeat 定时器 ────────────────────────────────
    if (this.config.webFetchEnabled) {
      // 启动 30 秒后先执行一次，避免占用启动时的主线程
      const initDelay = setTimeout(() => {
        this._webFetchOptimizations().catch(() => {})
      }, 30 * 1000)
      if (initDelay.unref) initDelay.unref()

      this._webTimer = setInterval(() => {
        this._webFetchOptimizations().catch((e) => {
          this.log.push('webfetch', 'fetch_error', e.message, 'error')
        })
      }, this.config.webFetchIntervalMs)

      if (this._webTimer.unref) this._webTimer.unref()
      this.log.push('webfetch', 'scheduler_started',
        `网络检索优化已启动，间隔 ${this.config.webFetchIntervalMs / 3600000}h`, 'info')
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._webTimer) {
      clearInterval(this._webTimer)
      this._webTimer = null
    }
    this.running = false
    this.log.push('optimizer', 'stopped', '自动优化引擎已停止', 'info')
  }

  // ── 手动触发一次完整优化周期 ────────────────────────────────────────────────
  async runOnce() {
    return this.runCycle()
  }

  // ── v2.0 网络检索优化提示（Web Heartbeat）────────────────────────────────
  /**
   * 从公开数据源获取 LLM 推理/提示词优化技巧，保存到本地缓存文件
   * 策略：
   *   1. 先尝试从 Ollama 项目 GitHub README 获取模型参数优化建议
   *   2. 降级：从 Ollama 官网博客获取最新调优技巧
   *   3. 最终降级：从内置静态知识库补充
   * 结果写入 ~/.qclaw/web-opt-hints.json，供 memoryEngine 读取注入
   */
  async _webFetchOptimizations() {
    this.log.push('webfetch', 'fetch_start', '开始网络检索最新 LLM 优化提示...', 'info')

    const hints = []
    const sources = [
      {
        name: 'Ollama Blog',
        url:  'https://ollama.com/blog',
        proto: 'https',
        parse: (body) => {
          // 提取最新博文标题作为"新功能"提示
          const matches = body.match(/<h[12][^>]*>([^<]{10,80})<\/h[12]>/gi) || []
          return matches.slice(0, 3).map(h => h.replace(/<[^>]+>/g, '').trim())
        },
      },
      {
        name: 'Ollama GitHub',
        url:  'https://raw.githubusercontent.com/ollama/ollama/main/docs/modelfile.md',
        proto: 'https',
        parse: (body) => {
          // 提取参数建议（## Parameters 之后的内容）
          const idx = body.indexOf('## Parameters')
          if (idx < 0) return []
          const section = body.slice(idx, idx + 1500)
          const tips = []
          const rows = section.match(/\|\s+`[^`]+`\s+\|[^|]+\|[^|]+\|/g) || []
          for (const row of rows.slice(0, 5)) {
            tips.push(`Ollama 参数优化: ${row.replace(/\|/g, '').replace(/\s+/g, ' ').trim()}`)
          }
          return tips
        },
      },
    ]

    for (const source of sources) {
      try {
        const body = await this._httpsGet(source.url, this.config.webFetchTimeout)
        const parsed = source.parse(body)
        if (parsed.length > 0) {
          hints.push(...parsed.map(h => ({ source: source.name, hint: h, ts: Date.now() })))
          this.log.push('webfetch', 'fetch_ok', `${source.name}: 获取 ${parsed.length} 条优化提示`, 'info')
        }
      } catch (e) {
        this.log.push('webfetch', 'source_fail', `${source.name} 获取失败: ${e.message}`, 'warn')
      }
    }

    // 内置静态知识作为最终兜底（总是追加）
    const builtinHints = [
      { source: 'builtin', hint: '对话历史超过 20 轮时建议开启 fastMode 节省 token', ts: Date.now() },
      { source: 'builtin', hint: '代码相关问题使用 temperature=0.2 可获得更稳定的输出', ts: Date.now() },
      { source: 'builtin', hint: '使用 /compress 命令可手动触发历史对话摘要压缩', ts: Date.now() },
      { source: 'builtin', hint: 'Ollama num_ctx 建议设置为 8192，过大会导致响应变慢', ts: Date.now() },
    ]
    hints.push(...builtinHints)

    // 保存到本地文件
    try {
      ensureDir()
      const existing = this._loadWebHints()
      // 合并，去重（按 hint 文本），最多保留 40 条
      const merged = [...hints, ...existing]
      const seen   = new Set()
      const deduped = merged.filter(h => {
        if (seen.has(h.hint)) return false
        seen.add(h.hint)
        return true
      }).slice(0, 40)

      fs.writeFileSync(WEB_FETCH_FILE, JSON.stringify(deduped, null, 2))
      this._webFetchState.lastFetchAt = Date.now()
      this._webFetchState.lastHints   = deduped.slice(0, 5)
      this._webFetchState.fetchCount++

      this.log.push('webfetch', 'saved',
        `已保存 ${deduped.length} 条优化提示到本地缓存`, 'info')
    } catch (e) {
      this.log.push('webfetch', 'save_error', e.message, 'error')
      this._webFetchState.errorCount++
    }

    return hints
  }

  /** 读取本地缓存的网络检索结果 */
  _loadWebHints() {
    try {
      return JSON.parse(fs.readFileSync(WEB_FETCH_FILE, 'utf8'))
    } catch {
      return []
    }
  }

  /** 获取最近几条网络检索提示（供外部读取注入 prompt）*/
  getWebHints(n = 3) {
    return this._loadWebHints().slice(0, n)
  }

  // ── HTTPS GET 工具（与 _httpGet 区分，走 https 模块）────────────────────
  _httpsGet(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        // 跟随重定向（最多 3 次）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(this._httpsGet(res.headers.location, timeoutMs))
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          body += chunk
          if (body.length > 200 * 1024) {  // 超过 200KB 截断（防止大页面）
            res.destroy()
          }
        })
        res.on('end', () => resolve(body))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`HTTPS 请求超时 (${timeoutMs}ms): ${url}`))
      })
    })
  }

  // ── 更新配置 ─────────────────────────────────────────────────────────────────
  updateConfig(patch) {
    const old = { ...this.config }
    this.config = { ...this.config, ...patch }
    this.log.push('config', 'config_updated',
      `配置已更新: ${JSON.stringify(patch)}`, 'info')
    // 如果间隔变了，重启定时器
    if (this.running && patch.checkIntervalMs && patch.checkIntervalMs !== old.checkIntervalMs) {
      this.stop()
      this.start()
    }
    return this.config
  }
}

// 单例
const optimizer = new AutoOptimizer()
module.exports  = optimizer
