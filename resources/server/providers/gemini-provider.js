/**
 * GeminiProvider - QClaw v2.2
 * Google Gemini API（原生 REST）适配器
 *
 * 支持模型：
 *   - gemini-2.0-flash         最快，适合快速回答
 *   - gemini-2.0-flash-thinking 推理型
 *   - gemini-1.5-pro            长上下文（100万 tokens）
 *   - gemini-1.5-flash          平衡版
 */

const BaseProvider = require('./base-provider')

class GeminiProvider extends BaseProvider {
  constructor(config = {}) {
    // BaseProvider 构造函数会设置 this.id / this.name / this.config
    // 先用标准方式调用，再覆盖 config（去掉 id/name，避免重复）
    super({ id: config.id || 'gemini', name: config.name || 'Google Gemini' })

    this.config = {
      apiKey:          config.apiKey  || '',
      baseUrl:         config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
      currentModel:    config.currentModel || 'gemini-2.0-flash',
      availableModels: config.availableModels || [
        { id: 'gemini-2.0-flash',              name: 'Gemini 2.0 Flash（最快）' },
        { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking（推理）' },
        { id: 'gemini-1.5-pro',                name: 'Gemini 1.5 Pro（长上下文 100万）' },
        { id: 'gemini-1.5-flash',              name: 'Gemini 1.5 Flash' },
        { id: 'gemini-1.5-flash-8b',           name: 'Gemini 1.5 Flash 8B（轻量）' },
      ],
    }
    this._lastModelFetch = 0
    this._cachedModels   = null
  }

  isConfigured() { return !!this.config.apiKey }

  /** 将 OpenAI messages 格式转换为 Gemini contents 格式 */
  _convertMessages(messages) {
    // 提取 system prompt（Gemini 单独放 systemInstruction）
    let systemInstruction = null
    const filtered = messages.filter(m => {
      if (m.role === 'system') { systemInstruction = m.content; return false }
      return true
    })

    const contents = filtered.map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    }))

    return { contents, systemInstruction }
  }

  async streamChat(messages, onChunk, options = {}) {
    if (!this.isConfigured()) throw new Error('Gemini API Key 未配置')

    const model  = options.model || this.config.currentModel
    const url    = `${this.config.baseUrl}/models/${model}:streamGenerateContent?key=${this.config.apiKey}&alt=sse`

    const { contents, systemInstruction } = this._convertMessages(messages)

    const body = {
      contents,
      generationConfig: {
        temperature:    options.temperature ?? 0.7,
        maxOutputTokens: options.max_tokens || 8192,
        topP:           0.95,
      },
    }
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }

    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      const msg = err.error?.message || `HTTP ${resp.status}`
      const e   = new Error(msg)
      e.status  = resp.status
      throw e
    }

    const reader  = resp.body.getReader()
    const decoder = new TextDecoder()
    let   buf     = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const json  = JSON.parse(raw)
          const text  = json.candidates?.[0]?.content?.parts?.[0]?.text || ''
          if (text) onChunk(text)
        } catch { /* skip malformed */ }
      }
    }
  }

  async listModels() {
    // 模型列表缓存 10 分钟
    if (this._cachedModels && Date.now() - this._lastModelFetch < 600_000) {
      return this._cachedModels
    }
    if (!this.isConfigured()) return this.config.availableModels

    try {
      const url  = `${this.config.baseUrl}/models?key=${this.config.apiKey}&pageSize=50`
      const resp = await fetch(url)
      if (!resp.ok) return this.config.availableModels
      const data = await resp.json()
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({
          id:   m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', ''),
        }))
      if (models.length > 0) {
        this._cachedModels   = models
        this._lastModelFetch = Date.now()
        return models
      }
    } catch { /* fallback */ }

    return this.config.availableModels
  }

  async healthCheck() {
    if (!this.isConfigured()) return false
    try {
      const url  = `${this.config.baseUrl}/models?key=${this.config.apiKey}&pageSize=1`
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return resp.ok
    } catch { return false }
  }

  toJSON() {
    return {
      id:              this.id,
      name:            this.name,
      currentModel:    this.config.currentModel,
      availableModels: this.config.availableModels,
      configured:      this.isConfigured(),
    }
  }
}

module.exports = GeminiProvider
