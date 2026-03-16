const OpenAI = require('openai')
const BaseProvider = require('./base-provider')

/**
 * OpenAI 兼容 Provider
 * 覆盖：OpenAI / DeepSeek / 通义千问 / Moonshot 等所有兼容 OpenAI 协议的服务
 */
class OpenAIProvider extends BaseProvider {
  constructor(config = {}) {
    super(config)
    this._client = null
  }

  _getClient() {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: this.config.apiKey || 'placeholder',
        baseURL: this.config.baseUrl || undefined,
        timeout: 60000,
      })
    }
    return this._client
  }

  isConfigured() {
    // 自定义 provider（没有 baseUrl 就没法使用）
    if (this.id === 'custom') return !!(this.config.apiKey && this.config.baseUrl)
    // 其余 OpenAI 兼容服务：有 apiKey 即可
    return !!this.config.apiKey
  }

  _buildParams(messages, options = {}) {
    const maxTok = options.max_tokens || options.maxTokens || 4096
    const params = {
      model:       options.model || this.currentModel,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens:  maxTok,
    }
    if (options.fastMode) {
      // OpenAI 官方 API：使用 service_tier=auto 加速
      if (!this.config.baseUrl || this.config.baseUrl.includes('openai.com')) {
        params.service_tier = 'auto'
      }
      // fastMode 时主动限制回复长度（只在用户未显式设置 max_tokens 时才限制）
      if (!options.max_tokens && !options.maxTokens) {
        params.max_tokens = Math.min(maxTok, 2048)
      }
    }
    return params
  }

  async chat(messages, options = {}) {
    const client = this._getClient()
    try {
      const response = await client.chat.completions.create({
        ...this._buildParams(messages, options),
        stream: false,
      })
      return {
        content: response.choices[0].message.content,
        usage: response.usage,
        finishReason: response.choices[0].finish_reason,
      }
    } catch (error) {
      throw new Error(`[${this.id}] API 错误: ${error.message}`)
    }
  }

  async streamChat(messages, onChunk, options = {}) {
    const client = this._getClient()
    try {
      const stream = await client.chat.completions.create({
        ...this._buildParams(messages, options),
        stream: true,
      })
      let fullContent = ''
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || ''
        if (content) {
          fullContent += content
          onChunk(content)
        }
      }
      return fullContent
    } catch (error) {
      throw new Error(`[${this.id}] 流式 API 错误: ${error.message}`)
    }
  }

  async _doHealthCheck() {
    const client = this._getClient()
    await client.chat.completions.create({
      model: this.currentModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    })
  }
}

module.exports = OpenAIProvider
