const Anthropic = require('@anthropic-ai/sdk')
const BaseProvider = require('./base-provider')

/**
 * Anthropic Provider - Claude 系列
 */
class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super(config)
    this._client = null
  }

  _getClient() {
    if (!this._client) {
      this._client = new Anthropic({ apiKey: this.config.apiKey })
    }
    return this._client
  }

  isConfigured() {
    return !!this.config.apiKey
  }

  _convertMessages(messages) {
    let system = ''
    const converted = []
    for (const m of messages) {
      if (m.role === 'system') {
        system = m.content
      } else {
        converted.push({ role: m.role, content: m.content })
      }
    }
    return { system, messages: converted }
  }

  _buildParams(messages, options = {}) {
    const { system, messages: msgs } = this._convertMessages(messages)
    const params = {
      model: options.model || this.currentModel,
      messages: msgs,
      max_tokens: options.max_tokens || options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
    }
    if (system) params.system = system
    if (options.fastMode) {
      params.service_tier = 'priority'
      if (!options.max_tokens) params.max_tokens = Math.min(params.max_tokens, 2048)
    }
    return params
  }

  async chat(messages, options = {}) {
    const client = this._getClient()
    try {
      const response = await client.messages.create({
        ...this._buildParams(messages, options),
        stream: false,
      })
      return {
        content: response.content[0]?.text || '',
        usage: { prompt_tokens: response.usage?.input_tokens, completion_tokens: response.usage?.output_tokens },
        finishReason: response.stop_reason,
      }
    } catch (error) {
      throw new Error(`[anthropic] API 错误: ${error.message}`)
    }
  }

  async streamChat(messages, onChunk, options = {}) {
    const client = this._getClient()
    try {
      const stream = await client.messages.create({ ...this._buildParams(messages, options), stream: true })
      let fullContent = ''
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text || ''
          if (text) { fullContent += text; onChunk(text) }
        }
      }
      return fullContent
    } catch (error) {
      throw new Error(`[anthropic] 流式 API 错误: ${error.message}`)
    }
  }

  async _doHealthCheck() {
    const client = this._getClient()
    await client.messages.create({
      model: this.currentModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })
  }
}

module.exports = AnthropicProvider
