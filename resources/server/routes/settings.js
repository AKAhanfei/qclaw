/**
 * /api/settings - 设置持久化路由
 * QClaw v2.0 - 支持前端保存 API Key、Provider 配置到后端运行时
 */

const express  = require('express')
const router   = express.Router()
const registry = require('../providers/registry')

// ── GET /api/settings/providers ─────────────────────────────────────────────
// 返回当前所有 Provider 的配置（脱敏，不含 apiKey 明文）
router.get('/providers', (req, res) => {
  const providers = registry.list().map(p => {
    const r = { ...p }
    if (r.apiKey) r.apiKey = r.apiKey.replace(/.(?=.{4})/g, '*')
    return r
  })
  res.json({ providers, active: registry.activeProvider })
})

// ── POST /api/settings/provider ─────────────────────────────────────────────
// 更新 Provider 配置（API Key、模型等）
router.post('/provider', (req, res) => {
  const { id, apiKey, baseUrl, model, setActive } = req.body
  if (!id) return res.status(400).json({ error: '缺少 id' })

  try {
    // 只传入非 undefined 的字段，避免覆盖已有配置
    const config = {}
    if (apiKey  !== undefined) config.apiKey  = apiKey
    if (baseUrl !== undefined) config.baseUrl = baseUrl
    if (model   !== undefined) config.model   = model
    registry.updateConfig(id, config)
    if (setActive) registry.setActive(id)
    res.json({ ok: true, active: registry.activeProvider })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── POST /api/settings/active ────────────────────────────────────────────────
// 切换激活 Provider
router.post('/active', (req, res) => {
  const { provider } = req.body
  if (!provider) return res.status(400).json({ error: '缺少 provider 参数' })
  try {
    registry.setActive(provider)
    res.json({ ok: true, active: registry.activeProvider })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

module.exports = router
