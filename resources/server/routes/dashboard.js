/**
 * Dashboard API Routes
 * 为控制中心前端（DashboardView/UsageView/AgentsView/MemoryView）提供数据
 * 整合本地 QClaw 状态 + OpenClaw 数据（若可达）
 */
const express = require('express')
const fs      = require('fs')
const path    = require('path')
const os      = require('os')
const http    = require('http')

const router = express.Router()

// ── OpenClaw 路径常量 ─────────────────────────────────────────────────────
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw')
const CODEX_HOME    = process.env.CODEX_HOME    || path.join(os.homedir(), '.codex')
const GATEWAY_URL   = process.env.GATEWAY_URL   || 'ws://127.0.0.1:18789'
const GATEWAY_HTTP  = GATEWAY_URL.replace(/^ws/, 'http')

// ── 工具函数 ──────────────────────────────────────────────────────────────
function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// ── 读取 openclaw.json（Agent 配置）─────────────────────────────────────
function loadOpenClawConfig() {
  const candidates = [
    path.join(OPENCLAW_HOME, 'openclaw.json'),
    path.join(OPENCLAW_HOME, 'config.json'),
  ]
  for (const p of candidates) {
    const d = safeReadJson(p)
    if (d) return d
  }
  return null
}

// ── 读取 tasks/projects 快照 ─────────────────────────────────────────────
function loadLocalTasks() {
  const candidates = [
    path.join(OPENCLAW_HOME, 'tasks.json'),
    path.join(OPENCLAW_HOME, 'tasks', 'tasks.json'),
    path.join(process.cwd(), 'runtime', 'tasks.json'),
  ]
  for (const p of candidates) {
    const d = safeReadJson(p)
    if (d) return d
  }
  return null
}

// ── 读取 digest（最新摘要 markdown）────────────────────────────────────
function loadLatestDigest() {
  const digestDir = path.join(process.cwd(), 'runtime', 'digests')
  try {
    if (!fs.existsSync(digestDir)) return null
    const files = fs.readdirSync(digestDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
    if (files.length === 0) return null
    return fs.readFileSync(path.join(digestDir, files[0]), 'utf8').slice(0, 2000)
  } catch { return null }
}

// ── 读取 subscription/billing 快照 ──────────────────────────────────────
function loadSubscription() {
  const candidates = [
    process.env.OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH,
    path.join(OPENCLAW_HOME, 'subscription.json'),
    path.join(OPENCLAW_HOME, 'subscription-snapshot.json'),
    path.join(OPENCLAW_HOME, 'billing', 'subscription.json'),
    path.join(OPENCLAW_HOME, 'billing', 'usage.json'),
    path.join(process.cwd(), 'runtime', 'subscription-snapshot.json'),
  ].filter(Boolean)
  for (const p of candidates) {
    const d = safeReadJson(p)
    if (d) return d
  }
  return null
}

// ── 扫描 agents 目录，获取 Agent 列表 ───────────────────────────────────
function loadAgentList() {
  const agentsDir = path.join(OPENCLAW_HOME, 'agents')
  try {
    if (!fs.existsSync(agentsDir)) return []
    return fs.readdirSync(agentsDir)
      .filter(name => {
        try { return fs.statSync(path.join(agentsDir, name)).isDirectory() } catch { return false }
      })
      .map(name => {
        const configPath = path.join(agentsDir, name, 'config.json')
        const config = safeReadJson(configPath)
        // 判断最近是否有活动（有 sessions 目录且有 jsonl 文件）
        const sessionsDir = path.join(agentsDir, name, 'sessions')
        let lastActivity = null
        try {
          const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))
          if (sessionFiles.length > 0) {
            const newest = sessionFiles.sort().reverse()[0]
            const stat = fs.statSync(path.join(sessionsDir, newest))
            lastActivity = stat.mtime.toISOString()
          }
        } catch {}
        return {
          id: name,
          label: config?.name || name,
          agentId: name,
          state: lastActivity && (Date.now() - new Date(lastActivity) < 5 * 60 * 1000) ? 'running' : 'idle',
          lastActivity,
          model: config?.model,
        }
      })
  } catch { return [] }
}

// ── 扫描 codex sessions 获取 token 使用量 ──────────────────────────────
function loadCodexUsage() {
  const sessionsDir = path.join(CODEX_HOME, 'sessions')
  if (!fs.existsSync(sessionsDir)) return null

  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0
  const byDay = {}
  const today = new Date().toISOString().slice(0, 10)

  try {
    const sessionDirs = fs.readdirSync(sessionsDir)
    let scanned = 0
    for (const dir of sessionDirs.reverse()) {
      if (scanned >= 48) break
      const dirPath = path.join(sessionsDir, dir)
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue
        const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
        for (const jf of jsonlFiles) {
          const lines = fs.readFileSync(path.join(dirPath, jf), 'utf8').split('\n')
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const entry = JSON.parse(line)
              const tokIn  = entry.usage?.input_tokens || entry.tokensIn || 0
              const tokOut = entry.usage?.output_tokens || entry.tokensOut || 0
              const cost   = entry.usage?.cost || 0
              totalTokensIn  += tokIn
              totalTokensOut += tokOut
              totalCost      += cost
              const day = (entry.created_at || entry.timestamp || today).slice(0, 10)
              byDay[day] = (byDay[day] || 0) + tokIn + tokOut
            } catch {}
          }
        }
        scanned++
      } catch {}
    }
    return { totalTokensIn, totalTokensOut, totalCost, byDay }
  } catch { return null }
}

// ── Routes ────────────────────────────────────────────────────────────────

// 总览快照
router.get('/snapshot', async (req, res) => {
  try {
    const [gatewayData, sessions] = await Promise.all([
      httpGet(`${GATEWAY_HTTP}/api/sessions`).catch(() => null),
      httpGet(`${GATEWAY_HTTP}/api/sessions/list`).catch(() => null),
    ])

    const ocConfig = loadOpenClawConfig()
    const tasks    = loadLocalTasks()
    const digest   = loadLatestDigest()

    // 构造 alert 列表
    const alerts = []
    const sessionsArr = gatewayData?.sessions || sessions?.sessions || []
    const errorSessions = sessionsArr.filter(s => s.state === 'error' || s.status === 'error')
    const blockedSessions = sessionsArr.filter(s => s.state === 'blocked' || s.state === 'waiting_approval')
    if (errorSessions.length > 0)   alerts.push({ level: 'error', message: `${errorSessions.length} 个 OpenClaw Session 处于错误状态` })
    if (blockedSessions.length > 0) alerts.push({ level: 'warn',  message: `${blockedSessions.length} 个 Session 阻塞或等待审批` })

    res.json({
      ok: true,
      sessions: sessionsArr.slice(0, 20),
      alerts,
      digest,
      hasGateway: !!gatewayData,
      ocConfigExists: !!ocConfig,
      tasksExists: !!tasks,
      generatedAt: new Date().toISOString(),
    })
  } catch (e) {
    res.json({ ok: false, error: e.message, sessions: [], alerts: [], generatedAt: new Date().toISOString() })
  }
})

// 用量数据
router.get('/usage', async (req, res) => {
  try {
    const period     = req.query.period || '7d'
    const codex      = loadCodexUsage()
    const sub        = loadSubscription()

    // 生成近7/30天趋势
    const days = period === '30d' ? 30 : period === 'today' ? 1 : 7
    const today = new Date()
    const daily = Array.from({ length: days }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - (days - 1 - i))
      const key = d.toISOString().slice(0, 10)
      return { day: key, tokens: codex?.byDay?.[key] || 0 }
    })

    res.json({
      ok: true,
      totalTokens:    (codex?.totalTokensIn || 0) + (codex?.totalTokensOut || 0),
      totalTokensIn:   codex?.totalTokensIn  || 0,
      totalTokensOut:  codex?.totalTokensOut || 0,
      estimatedCost:   codex?.totalCost || 0,
      todayTokens:     codex?.byDay?.[today.toISOString().slice(0,10)] || 0,
      daily,
      subscriptionConnected: !!sub,
      codexConnected:        !!codex,
      subscription:          sub,
    })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// Agent 列表
router.get('/agents', async (req, res) => {
  try {
    const localAgents = loadAgentList()

    // 尝试从 Gateway 获取实时状态
    const liveData = await httpGet(`${GATEWAY_HTTP}/api/sessions`).catch(() => null)
    const liveSessions = liveData?.sessions || []

    // 合并：本地 agent 配置 + 实时会话状态
    const agents = localAgents.map(a => {
      const liveSession = liveSessions.find(s => s.agentId === a.id || s.agent === a.id)
      if (liveSession) {
        return { ...a, state: liveSession.state || a.state, sessionKey: liveSession.sessionKey }
      }
      return a
    })

    // 把 Gateway 里有但本地没有的 session 也加进来
    liveSessions.forEach(s => {
      if (!agents.find(a => a.id === (s.agentId || s.agent))) {
        agents.push({
          id: s.agentId || s.agent || s.sessionKey,
          label: s.label || s.agentId || s.sessionKey,
          state: s.state || 'idle',
          sessionKey: s.sessionKey,
          isLive: true,
        })
      }
    })

    res.json({ ok: true, agents, hasGateway: !!liveData })
  } catch (e) {
    res.json({ ok: false, error: e.message, agents: [] })
  }
})

// 记忆数据
router.get('/memory', async (req, res) => {
  try {
    // 扫描所有 agent 的 memory.json
    const agentsDir = path.join(OPENCLAW_HOME, 'agents')
    const memories = []

    try {
      if (fs.existsSync(agentsDir)) {
        const agentNames = fs.readdirSync(agentsDir)
        for (const name of agentNames) {
          const memFiles = [
            path.join(agentsDir, name, 'memory.json'),
            path.join(agentsDir, name, 'memory', 'index.json'),
          ]
          for (const mf of memFiles) {
            const d = safeReadJson(mf)
            if (d) {
              const items = Array.isArray(d) ? d : (d.memories || d.facts || [d])
              items.forEach((m, i) => {
                memories.push({
                  id: `${name}_${i}`,
                  agentId: name,
                  key: m.key || m.id || `mem_${i}`,
                  content: m.content || m.value || m.fact || m.text || JSON.stringify(m).slice(0, 100),
                  status: 'available',
                  updatedAt: m.updatedAt || m.timestamp,
                })
              })
            }
          }
        }
      }
    } catch {}

    res.json({
      ok: true,
      memories,
      agentsDir,
      hasOpenClawHome: fs.existsSync(OPENCLAW_HOME),
    })
  } catch (e) {
    res.json({ ok: false, error: e.message, memories: [] })
  }
})

module.exports = router
