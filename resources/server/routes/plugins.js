/**
 * QClaw Plugin Store API v2.0
 *
 * GET  /api/plugins              — 获取插件列表（category/search/onlyEnabled 过滤）
 * GET  /api/plugins/categories   — 获取所有分类（含数量）
 * GET  /api/plugins/status       — 获取插件系统状态
 * GET  /api/plugins/hooks        — 获取所有钩子类型
 * GET  /api/plugins/:id          — 获取单个插件详情
 * POST /api/plugins/:id/install  — 安装内置插件
 * POST /api/plugins/:id/uninstall— 卸载插件
 * POST /api/plugins/:id/enable   — 启用插件
 * POST /api/plugins/:id/disable  — 禁用插件
 * POST /api/plugins/:id/reload   — 热重载文件插件
 * PUT  /api/plugins/:id/config   — 更新插件配置
 * POST /api/plugins/install/dir  — 从本地目录安装文件插件
 * POST /api/plugins/pipeline/test— 测试 Pipeline 钩子
 */

const router = require('express').Router()
const engine = require('../services/plugin-engine')
const path   = require('path')
const fs     = require('fs')

// ── 获取插件列表 ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { category, search, onlyEnabled } = req.query
    const plugins = engine.list({
      category,
      search,
      onlyEnabled: onlyEnabled === 'true',
    })
    res.json({ ok: true, plugins, total: plugins.length })
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 获取分类列表 ──────────────────────────────────────────────────────────────
router.get('/categories', (req, res) => {
  try {
    const categories = engine.getCategories()
    const all = engine.list()
    const counts = {}
    for (const p of all) counts[p.category] = (counts[p.category] || 0) + 1
    res.json({
      ok: true,
      categories: categories.map(c => ({
        name: c,
        count: c === '全部' ? all.length : (counts[c] || 0),
      }))
    })
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 获取状态 ──────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...engine.getStatus() })
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 社区插件市场（AstrBot 插件集合）─────────────────────────────────────────
// 内存缓存，5分钟有效
let _communityCache = null
let _communityCacheAt = 0
const COMMUNITY_CACHE_TTL = 5 * 60 * 1000

const COMMUNITY_URLS = [
  // 首选：AstrBot 官方 API，稳定可达，数据最新（~1090 个插件）
  'https://api.soulter.top/astrbot/plugins',
  // 备用：GitHub Raw（海外可达，国内一般超时）
  'https://raw.githubusercontent.com/AstrBotDevs/AstrBot_Plugins_Collection/main/plugin_cache_original.json',
]

router.get('/community', async (req, res) => {
  const { search = '', category = '全部' } = req.query

  // 命中缓存
  if (_communityCache && Date.now() - _communityCacheAt < COMMUNITY_CACHE_TTL) {
    return res.json({ ok: true, plugins: filterCommunity(_communityCache, search, category), total: _communityCache.length, cached: true })
  }

  // 逐个尝试数据源
  let lastErr = null
  for (const url of COMMUNITY_URLS) {
    try {
      // Node 18+ 内置 fetch；若不可用则用 https 模块
      const data = await fetchJSON(url)
      const plugins = normalizeCommunityPlugins(data)
      _communityCache = plugins
      _communityCacheAt = Date.now()
      return res.json({ ok: true, plugins: filterCommunity(plugins, search, category), total: plugins.length, cached: false })
    } catch (e) {
      lastErr = e
    }
  }
  res.status(502).json({ ok: false, error: '获取社区插件列表失败：' + (lastErr?.message || '网络错误') })
})

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http')
    const req = mod.get(url, { timeout: 12000, headers: { 'User-Agent': 'QClaw/2.0' } }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return fetchJSON(resp.headers.location).then(resolve).catch(reject)
      }
      if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`))
      let body = ''
      resp.on('data', d => body += d)
      resp.on('end', () => {
        try { resolve(JSON.parse(body)) } catch(e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
  })
}

function normalizeCommunityPlugins(data) {
  if (Array.isArray(data)) return data
  if (typeof data === 'object' && data !== null) {
    return Object.entries(data).map(([name, info]) => ({
      name,
      display_name: info.display_name || info.name || name,
      desc:         info.desc || info.description || '暂无描述',
      repo:         info.repo || info.github || '',
      author:       info.author || '未知',
      category:     info.category || '未分类',
      tags:         Array.isArray(info.tags) ? info.tags : [],
      stars:        typeof info.stars === 'number' ? info.stars : null,
      version:      info.version || '',
      updated_at:   info.updated_at || '',
      logo:         info.logo || '',
    }))
  }
  return []
}

function filterCommunity(plugins, search, category) {
  let list = plugins
  if (category && category !== '全部') {
    list = list.filter(p => p.category === category)
  }
  if (search && search.trim()) {
    const kw = search.trim().toLowerCase()
    list = list.filter(p =>
      (p.display_name || p.name).toLowerCase().includes(kw) ||
      (p.desc || '').toLowerCase().includes(kw) ||
      (p.author || '').toLowerCase().includes(kw) ||
      (p.tags || []).some(t => t.toLowerCase().includes(kw))
    )
  }
  return list
}

// ── 获取钩子类型 ──────────────────────────────────────────────────────────────
router.get('/hooks', (req, res) => {
  const { HOOK_TYPES } = require('../services/plugin-engine')
  res.json({ ok: true, hooks: HOOK_TYPES })
})

// ── 从本地目录安装 ────────────────────────────────────────────────────────────
router.post('/install/dir', (req, res) => {
  try {
    const { srcDir } = req.body
    if (!srcDir) return res.status(400).json({ ok: false, error: '缺少 srcDir 参数' })
    if (!fs.existsSync(srcDir)) return res.status(400).json({ ok: false, error: '目录不存在: ' + srcDir })
    const result = engine.installFromDir(srcDir)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 测试 Pipeline 钩子 ────────────────────────────────────────────────────────
router.post('/pipeline/test', async (req, res) => {
  try {
    const { hook, data = {} } = req.body
    if (!hook) return res.status(400).json({ ok: false, error: '缺少 hook 参数' })
    const result = await engine.pipeline(hook, data)
    res.json({ ok: true, hook, result })
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 获取单个插件详情 ──────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const plugins = engine.list()
    const plugin  = plugins.find(p => p.id === req.params.id)
    if (!plugin) return res.status(404).json({ ok: false, error: '插件不存在' })
    res.json({ ok: true, plugin })
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 安装 ──────────────────────────────────────────────────────────────────────
router.post('/:id/install', (req, res) => {
  try {
    const result = engine.install(req.params.id)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 卸载 ──────────────────────────────────────────────────────────────────────
router.post('/:id/uninstall', (req, res) => {
  try {
    const result = engine.uninstall(req.params.id)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 启用 ──────────────────────────────────────────────────────────────────────
router.post('/:id/enable', async (req, res) => {
  try {
    const result = await engine.enable(req.params.id)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 禁用 ──────────────────────────────────────────────────────────────────────
router.post('/:id/disable', async (req, res) => {
  try {
    const result = await engine.disable(req.params.id)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 热重载 ────────────────────────────────────────────────────────────────────
router.post('/:id/reload', async (req, res) => {
  try {
    const result = await engine.reload(req.params.id)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── 更新配置 ──────────────────────────────────────────────────────────────────
router.put('/:id/config', (req, res) => {
  try {
    const result = engine.updateConfig(req.params.id, req.body)
    res.json(result)
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
