/**
 * /api/models - 模型列表路由
 * QClaw v2.2 - 支持动态 listModels（Gemini/Ollama 实时获取）+ 缓存
 */

const express  = require('express')
const router   = express.Router()
const registry = require('../providers/registry')

// ── GET /api/models ─────────────────────────────────────────────────────────
// 返回所有已注册 Provider 的列表（含模型，支持动态刷新）
router.get('/', async (req, res) => {
  try {
    const providers = registry.list()

    // 并发获取支持动态 listModels 的 Provider
    const enriched = await Promise.all(
      providers.map(async (p) => {
        const provider = registry.get(p.id)
        if (!provider) return p

        // 优先用 listModels（Gemini、Ollama），其次 discover，最后 fallback
        if (typeof provider.listModels === 'function') {
          try {
            const models = await provider.listModels()
            if (models?.length > 0) return { ...p, models }
          } catch { /* fallback */ }
        } else if (typeof provider.discover === 'function') {
          try {
            const models = await provider.discover()
            if (models?.length > 0) {
              return { ...p, models: models.map(m => ({ id: m.id || m.name, name: m.name || m.id })) }
            }
          } catch { /* fallback */ }
        }
        return p
      })
    )

    res.json({ providers: enriched, active: registry.activeProvider })
  } catch (err) {
    res.json({ providers: [], active: null, error: err.message })
  }
})

// ── GET /api/models/:providerId ──────────────────────────────────────────────
// 获取指定 Provider 的模型列表（设置页面"刷新"按钮）
router.get('/:providerId', async (req, res) => {
  const { providerId } = req.params
  const { apiKey, baseUrl } = req.query
  const p = registry.get(providerId)
  if (!p) return res.status(404).json({ models: [], error: `Provider '${providerId}' 不存在` })

  // 临时注入 query 里的 apiKey/baseUrl（不持久化）
  const origKey = p.config.apiKey
  const origUrl = p.config.baseUrl
  if (apiKey)  p.config.apiKey  = apiKey
  if (baseUrl) p.config.baseUrl = baseUrl

  try {
    let models = []
    if (typeof p.listModels === 'function') {
      // 强制刷新：清缓存
      p._cachedModels   = null
      p._lastModelFetch = 0
      models = await p.listModels()
    } else if (typeof p.discover === 'function') {
      models = await p.discover()
    }

    if (models?.length > 0) {
      return res.json({ models: models.map(m => ({ id: m.id || m.name, name: m.name || m.id })) })
    }
    // fallback 静态列表
    res.json({ models: p.config.availableModels || [], fallback: true })
  } catch (err) {
    res.json({ models: p.config.availableModels || [], error: err.message, fallback: true })
  } finally {
    // 恢复原配置（临时覆盖不影响全局）
    if (apiKey)  p.config.apiKey  = origKey
    if (baseUrl) p.config.baseUrl = origUrl
  }
})

// ── POST /api/models/active ──────────────────────────────────────────────────
router.post('/active', (req, res) => {
  const { provider } = req.body
  if (!provider) return res.status(400).json({ error: '缺少 provider 参数' })
  try {
    registry.setActive(provider)
    res.json({ ok: true, active: provider })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── POST /api/models/health ──────────────────────────────────────────────────
router.post('/health', async (req, res) => {
  try {
    const results = await registry.checkHealth()
    res.json({ results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
