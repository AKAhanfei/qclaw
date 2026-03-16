/**
 * QClaw Backend Server - v2.0.1
 * Provider Plugin 架构 + ContextEngine v3.0 + ACE 记忆引擎 + Tool Guard + 定时技能任务 + MCP 支持
 * v1.1.0 新增：oMLX ContinuousBatch 调度器 + 推测解码 Hint + Web Heartbeat 自学习优化
 * v1.2.0 新增：OpenClaw-bot-review 功能集成（会话/技能/告警/Gateway/像素办公室）
 * v2.0.0 新增：Self-Evolution Engine（自我进化引擎）+ WorkBuddy 风格任务列表 UI 全面升级
 */

const express   = require('express')
const cors      = require('cors')
const http      = require('http')
const registry    = require('./providers/registry')
const ctxEngine   = require('./services/context-engine')
const memEngine   = require('./services/memory-engine')
const toolGuard   = require('./services/tool-guard')
const scheduler   = require('./services/scheduled-skills')
const mcpManager  = require('./services/mcp-client')
const optimizer   = require('./services/auto-optimizer')
const { scheduler: omlxScheduler } = require('./services/omlx-scheduler')
const selfEvolution = require('./services/self-evolution-engine')

const app  = express()
const PORT = process.env.PORT || 3001

// ── 安全：限制 CORS 只允许本地 ──────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    const allowed = !origin ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin === 'null' // Electron file://
    cb(null, allowed ? true : new Error('CORS 拒绝'))
  },
  credentials: true,
}))

app.use(express.json({ limit: '10mb' }))

// ── 请求日志（开发模式）──────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    if (req.path !== '/health') {
      console.log(`[${new Date().toISOString().slice(11,19)}] ${req.method} ${req.path}`)
    }
    next()
  })
}

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  // 快速路径：不等待 cache stats（避免首次 cold start 时 health check 超时）
  const cacheStats = await Promise.race([
    ctxEngine.getCacheStats().catch(() => null),
    new Promise(r => setTimeout(() => r(null), 500)), // 500ms 超时
  ])
  const memStatus  = memEngine.getStatus()
  const optStatus  = optimizer.getStatus()
  res.json({
    status:    'ok',
    version:   '2.0.1',
    provider:  registry.activeProvider,
    time:      Date.now(),
    uptime:    process.uptime(),
    cacheStats,
    memory: {
      facts:    memStatus.memoryFacts,
      mode:     memStatus.mode,
      emotion:  memStatus.emotion,
    },
    scheduler: {
      running: scheduler.running,
      jobs:    scheduler.getJobs().length,
    },
    optimizer: {
      running:       optStatus.running,
      totalChecks:   optStatus.stats.totalChecks,
      totalFixes:    optStatus.stats.totalFixes,
      avgResponseMs: optStatus.stats.avgResponseMs,
      errorRate:     optStatus.stats.errorRate,
    },
    omlxScheduler:  omlxScheduler.getStatus(),
    evolution: (() => {
      try {
        const s = selfEvolution.getStatus()
        return {
          running:       s.running,
          version:       s.version,
          totalScans:    s.state.totalScans,
          totalPatches:  s.state.totalPatches,
          pendingIssues: s.state.pendingIssues,
          lastScanAt:    s.state.lastScanAt,
          backupCount:   s.backupCount,
        }
      } catch { return null }
    })(),
  })
})

// ── Auto-Optimizer API ───────────────────────────────────────────────────────
app.get('/api/optimizer/status', (req, res) => {
  res.json(optimizer.getStatus())
})

app.get('/api/optimizer/log', (req, res) => {
  const n = parseInt(req.query.n) || 50
  res.json({ log: optimizer.getLog(n) })
})

app.post('/api/optimizer/run', async (req, res) => {
  try {
    const result = await optimizer.runOnce()
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/optimizer/config', (req, res) => {
  const updated = optimizer.updateConfig(req.body)
  res.json({ ok: true, config: updated })
})

app.post('/api/optimizer/toggle', (req, res) => {
  const { enabled } = req.body
  if (enabled && !optimizer.running) {
    optimizer.start()
    res.json({ ok: true, running: true })
  } else if (!enabled && optimizer.running) {
    optimizer.stop()
    res.json({ ok: true, running: false })
  } else {
    res.json({ ok: true, running: optimizer.running })
  }
})

// ── oMLX Scheduler API（v1.1.0 新增）────────────────────────────────────────
app.get('/api/omlx/scheduler', (req, res) => {
  res.json(omlxScheduler.getStatus())
})

app.post('/api/omlx/scheduler/cancel', (req, res) => {
  const { sessionId, reqId } = req.body
  if (sessionId) {
    const count = omlxScheduler.cancelSession(sessionId)
    return res.json({ ok: true, cancelled: count })
  }
  if (reqId) {
    const ok = omlxScheduler.cancel(reqId)
    return res.json({ ok })
  }
  res.status(400).json({ error: '需要 sessionId 或 reqId' })
})

// ── Tool Guard API ───────────────────────────────────────────────────────────
app.post('/api/tool-guard/check', (req, res) => {
  const { toolType, params } = req.body
  const result = toolGuard.analyze(toolType || 'command', params || {})
  toolGuard.logAudit(toolType, params, result)
  res.json(result)
})

app.get('/api/tool-guard/audit', (req, res) => {
  res.json({ log: toolGuard.getAuditLog(50) })
})

// ── Scheduled Skills API ─────────────────────────────────────────────────────
app.get('/api/skills/jobs', (req, res) => {
  res.json({ jobs: scheduler.getJobs(), log: scheduler.getLog() })
})

app.post('/api/skills/jobs', (req, res) => {
  const job = scheduler.addJob(req.body)
  res.json({ ok: true, job })
})

app.put('/api/skills/jobs/:id', (req, res) => {
  const job = scheduler.updateJob(req.params.id, req.body)
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job })
})

app.delete('/api/skills/jobs/:id', (req, res) => {
  scheduler.deleteJob(req.params.id)
  res.json({ ok: true })
})

app.post('/api/skills/jobs/:id/run', async (req, res) => {
  try {
    await scheduler.runNow(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/chat',      require('./routes/chat'))
app.use('/api/models',    require('./routes/models'))
app.use('/api/settings',  require('./routes/settings'))
app.use('/api/files',     require('./routes/files'))
app.use('/api/tools',     require('./routes/tools'))       // 网页搜索 + JS沙箱 + 系统信息
app.use('/api/knowledge', require('./routes/knowledge'))   // 11个内置知识库 RAG
app.use('/api/plugins',   require('./routes/plugins'))     // 插件商店 + 插件管理

// ── MCP API ──────────────────────────────────────────────────────────────────
app.get('/api/mcp/status', (req, res) => {
  res.json({ servers: mcpManager.getStatus(), tools: mcpManager.getAllTools() })
})

app.post('/api/mcp/start', async (req, res) => {
  const { id, name, command, args, env } = req.body
  if (!id || !command) return res.status(400).json({ error: '缺少 id 或 command' })
  try {
    const result = await mcpManager.startServer({ id, name: name || id, command, args: args || [], env: env || {} })
    res.json({ ok: true, server: result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/mcp/stop', (req, res) => {
  const { id } = req.body
  if (!id) return res.status(400).json({ error: '缺少 id' })
  mcpManager.stopServer(id)
  res.json({ ok: true })
})

app.post('/api/mcp/call', async (req, res) => {
  const { serverId, toolName, args: toolArgs } = req.body
  if (!serverId || !toolName) return res.status(400).json({ error: '缺少 serverId 或 toolName' })
  try {
    const result = await mcpManager.callTool(serverId, toolName, toolArgs || {})
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Self-Evolution Engine API ─────────────────────────────────────────────────
app.get('/api/evolution/status', (req, res) => {
  try { res.json(selfEvolution.getStatus()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/evolution/log', (req, res) => {
  const n = parseInt(req.query.n) || 100
  try { res.json({ log: selfEvolution.getLog(n) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/evolution/history', (req, res) => {
  const n = parseInt(req.query.n) || 20
  try { res.json({ history: selfEvolution.getHistory(n) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/evolution/scan-results', (req, res) => {
  try { res.json({ results: selfEvolution.getScanResults() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/evolution/advice', (req, res) => {
  try { res.json({ advice: selfEvolution.getAdvice() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/evolution/backups', (req, res) => {
  try { res.json({ backups: selfEvolution.getBackups() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/evolution/scan', async (req, res) => {
  try {
    const result = await selfEvolution.runScan()
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/evolution/evolve', async (req, res) => {
  try {
    const result = await selfEvolution.runEvolution()
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/evolution/patch', async (req, res) => {
  const { filePath, newContent, reason } = req.body
  if (!filePath || !newContent) return res.status(400).json({ error: '缺少 filePath 或 newContent' })
  try {
    const result = await selfEvolution.patchFile(
      require('path').join(__dirname, filePath),
      newContent,
      reason || '手动补丁'
    )
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/evolution/rollback', (req, res) => {
  const { filePath } = req.body
  if (!filePath) return res.status(400).json({ error: '缺少 filePath' })
  try {
    const result = selfEvolution.rollbackFile(require('path').join(__dirname, filePath))
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/evolution/config', (req, res) => {
  try {
    const updated = selfEvolution.updateConfig(req.body)
    res.json({ ok: true, config: updated })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/evolution/diagnose-and-fix', async (req, res) => {
  try {
    const result = await selfEvolution.diagnoseAndFix()
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/evolution/toggle', (req, res) => {
  try {
    const { enabled } = req.body
    const status = selfEvolution.getStatus()
    if (enabled && !status.running) {
      selfEvolution.start()
      res.json({ ok: true, running: true })
    } else if (!enabled && status.running) {
      selfEvolution.stop()
      res.json({ ok: true, running: false })
    } else {
      res.json({ ok: true, running: status.running })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Dashboard API ─────────────────────────────────────────────────────────────
app.use('/api/dashboard', require('./routes/dashboard'))

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }))

// ── 全局错误处理 ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message)
  res.status(500).json({ error: err.message })
})

// ── 启动 ──────────────────────────────────────────────────────────────────────
const server = http.createServer(app)

// ── 防止连接泄漏：设置 keep-alive 超时 ───────────────────────────────────────
server.keepAliveTimeout = 30000   // 30 秒无活动关闭 keep-alive 连接
server.headersTimeout   = 35000   // 头部读取超时（稍大于 keepAlive）
server.timeout          = 120000  // 普通请求 120s 超时（chat 流式除外）

// ── 未捕获异常保护（防止服务器崩溃）────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[QClaw Server][FATAL] Uncaught exception:', err.message)
  console.error(err.stack)
  // 不退出，记录错误后继续运行
})

process.on('unhandledRejection', (reason) => {
  console.error('[QClaw Server][WARN] Unhandled rejection:', reason)
  // 不退出，仅记录
})

function startListening(port, retries = 0) {
  // 绑定 0.0.0.0（而非 127.0.0.1）以同时响应 IPv4 (127.0.0.1) 和 IPv6 (::1/localhost)
  // Windows 上 localhost 可能解析为 ::1，导致主进程 health check 超时
  server.listen(port, '0.0.0.0', () => {
    console.log(`[QClaw Server v2.0.1] http://localhost:${port}`)
    console.log(`[Provider]   默认: ${registry.activeProvider}`)
    console.log(`[Cache]      PrefixCache + TieredKV + EnginePool 已就绪`)
    console.log(`[Memory]     ACE 记忆引擎已就绪`)
    console.log(`[ToolGuard]  工具防护安全层已就绪`)
    console.log(`[Scheduler]  定时任务调度器已就绪`)
    console.log(`[MCP]        Model Context Protocol 客户端已就绪`)
    console.log(`[Optimizer]  自动修复优化引擎已就绪`)

    // 立即启动核心调度器
    scheduler.start()
    optimizer.start()

    // 延迟 10s 启动进化引擎，避免与服务器冷启动争抢 CPU
    setTimeout(() => {
      selfEvolution.start()
      console.log(`[Evolution]  自我进化引擎已就绪 (扫描间隔 4h / 进化间隔 24h)`)
    }, 10000)
  })
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 端口被占用 —— 检查是否是另一个 QClaw server 实例
    const http2 = require('http')
    const req = http2.get(`http://127.0.0.1:${PORT}/health`, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const health = JSON.parse(data)
          if (health.status === 'ok') {
            // 端口上已有 QClaw server 在运行，直接使用它
            console.log(`[QClaw Server] 端口 ${PORT} 已有服务实例运行，直接复用`)
            console.log(`[QClaw Server] 版本: ${health.version}, Provider: ${health.provider}`)
            // 不再启动调度器（已有实例在管理），但保持进程存活
            // 通过轮询保持进程不退出
            setInterval(() => {}, 60000)
          } else {
            console.error(`[QClaw Server] 端口 ${PORT} 被非 QClaw 服务占用，启动失败`)
            process.exit(1)
          }
        } catch {
          console.error(`[QClaw Server] 端口 ${PORT} 已被占用且无法识别，启动失败`)
          process.exit(1)
        }
      })
    })
    req.on('error', () => {
      console.error(`[QClaw Server] 端口 ${PORT} 被占用但无法连接，启动失败`)
      process.exit(1)
    })
    req.end()
  } else {
    console.error(`[QClaw Server] 启动错误: ${err.message}`)
    process.exit(1)
  }
})

startListening(PORT)

function gracefulShutdown(signal) {
  console.log(`[QClaw Server] ${signal} received, shutting down...`)
  try { scheduler.stop() } catch {}
  try { optimizer.stop() } catch {}
  try { selfEvolution.stop() } catch {}
  // 最多等 3s 关闭现有连接，超时强制退出
  const forceExit = setTimeout(() => process.exit(0), 3000)
  forceExit.unref()
  server.close(() => {
    clearTimeout(forceExit)
    process.exit(0)
  })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))

module.exports = app
