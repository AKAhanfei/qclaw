require('dotenv').config()

const OpenAIProvider    = require('./openai-provider')
const AnthropicProvider = require('./anthropic-provider')
const OllamaProvider    = require('./ollama-provider')
const GeminiProvider    = require('./gemini-provider')

/**
 * Provider 注册表 - QClaw 智慧体核心
 * 基于 OpenClaw v2026.3.12 Provider Plugin Architecture
 * 统一管理所有 AI Provider，支持运行时切换和配置更新
 */
class ProviderRegistry {
  constructor() {
    this._providers = new Map()
    this._activeId  = null
    this._sessionModes = new Map() // sessionId -> { fastMode: bool }
    this._registerBuiltins()
  }

  _registerBuiltins() {
    // ── OpenAI ──────────────────────────────────────────────────
    this.register(new OpenAIProvider({
      id: 'openai', name: 'OpenAI',
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      currentModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      availableModels: [
        { id: 'gpt-4o',       name: 'GPT-4o' },
        { id: 'gpt-4o-mini',  name: 'GPT-4o Mini' },
        { id: 'gpt-4-turbo',  name: 'GPT-4 Turbo' },
        { id: 'o1-mini',      name: 'o1 Mini (推理)' },
      ],
    }))

    // ── Anthropic ───────────────────────────────────────────────
    this.register(new AnthropicProvider({
      id: 'anthropic', name: 'Anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      currentModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      availableModels: [
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-5-haiku-20241022',  name: 'Claude 3.5 Haiku' },
        { id: 'claude-3-opus-20240229',     name: 'Claude 3 Opus' },
      ],
    }))




    // ── 通义千问（OpenAI 兼容）─────────────────────────────────
    this.register(new OpenAIProvider({
      id: 'qwen', name: '通义千问',
      apiKey: process.env.DASHSCOPE_API_KEY || '',
      baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      currentModel: process.env.QWEN_MODEL || 'qwen-plus',
      availableModels: [
        { id: 'qwen-max',                    name: 'Qwen Max' },
        { id: 'qwen-plus',                   name: 'Qwen Plus' },
        { id: 'qwen-turbo',                  name: 'Qwen Turbo' },
        { id: 'qwen2.5-72b-instruct',        name: 'Qwen2.5 72B' },
        { id: 'qwen2.5-coder-32b-instruct',  name: 'Qwen2.5 Coder 32B' },
      ],
    }))

    // ── Ollama（本地）──────────────────────────────────────────
    this.register(new OllamaProvider({
      id: 'ollama', name: 'Ollama（本地）',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      currentModel: process.env.OLLAMA_MODEL || 'qwen3.5:latest',
      availableModels: [
        { id: 'qwen3.5:latest',   name: 'Qwen3.5（内置）⭐' },
        { id: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B' },
        { id: 'qwen2.5:7b',       name: 'Qwen2.5 7B' },
        { id: 'codellama:7b',     name: 'Code Llama 7B' },
        { id: 'llama3.2:3b',      name: 'Llama 3.2 3B' },
        { id: 'mistral:7b',       name: 'Mistral 7B' },
      ],
    }))

    // ── Google Gemini ──────────────────────────────────────────
    this.register(new GeminiProvider({
      id: 'gemini', name: 'Google Gemini',
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      currentModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    }))

    // ── 自定义（OpenAI 兼容）──────────────────────────────────
    this.register(new OpenAIProvider({
      id: 'custom', name: '自定义',
      apiKey: process.env.CUSTOM_API_KEY || '',
      baseUrl: process.env.CUSTOM_BASE_URL || 'https://your-api.com/v1',
      currentModel: process.env.CUSTOM_MODEL || 'custom-model',
      availableModels: [],
    }))

    // 自动选择初始 provider：优先使用本地 Ollama（qwen3.5:latest 内置）
    if (process.env.OLLAMA_FORCE || (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY && !process.env.DASHSCOPE_API_KEY)) {
      this._activeId = 'ollama'
    } else if (process.env.OPENAI_API_KEY)    this._activeId = 'openai'
    else if (process.env.ANTHROPIC_API_KEY) this._activeId = 'anthropic'
    else if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) this._activeId = 'gemini'
    else if (process.env.DASHSCOPE_API_KEY) this._activeId = 'qwen'
    else                                    this._activeId = 'ollama'
  }

  // ── 注册 / 获取 ─────────────────────────────────────────────
  register(provider) { this._providers.set(provider.id, provider) }

  get(id) { return this._providers.get(id) || null }

  getActive() {
    const p = this._providers.get(this._activeId)
    if (!p) throw new Error(`Provider '${this._activeId}' 未注册`)
    return p
  }

  setActive(id) {
    if (!this._providers.has(id)) throw new Error(`不支持的 Provider: ${id}`)
    this._activeId = id
    return this._providers.get(id)
  }

  get activeProvider() { return this._activeId }

  // ── 动态配置更新（前端设置保存后调用）──────────────────────
  updateConfig(id, config = {}) {
    const p = this._providers.get(id)
    if (!p) throw new Error(`Provider '${id}' 未找到`)
    if (config.apiKey  !== undefined) p.config.apiKey  = config.apiKey
    if (config.baseUrl !== undefined) p.config.baseUrl = config.baseUrl
    if (config.model   !== undefined) p.config.currentModel = config.model
    // 重置 SDK 客户端，强制下次请求使用新配置
    if ('_client' in p) p._client = null
    return p
  }

  // ── 列表 ────────────────────────────────────────────────────
  list() {
    return Array.from(this._providers.values()).map(p => ({
      ...p.toJSON(),
      isActive: p.id === this._activeId,
    }))
  }

  isConfigured() { return this.getActive().isConfigured() }

  // ── /fast 会话模式 ──────────────────────────────────────────
  setSessionFastMode(sessionId, enabled) {
    this._sessionModes.set(sessionId, { fastMode: !!enabled })
  }
  getSessionFastMode(sessionId) {
    return this._sessionModes.get(sessionId)?.fastMode || false
  }

  // ── 健康检查 ────────────────────────────────────────────────
  async checkHealth() {
    const results = {}
    await Promise.allSettled(
      Array.from(this._providers.entries()).map(async ([id, p]) => {
        if (!p.isConfigured()) { results[id] = false; return }
        results[id] = await p.healthCheck()
      })
    )
    return results
  }
}

module.exports = new ProviderRegistry()
