const axios = require('axios')
const BaseProvider = require('./base-provider')

/**
 * Ollama Provider - 本地模型
 * 支持动态 discover 本地已安装模型
 */
class OllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super(config)
  }

  isConfigured() {
    return true // 本地不需要 API Key
  }

  async discover() {
    try {
      const res = await axios.get(`${this.config.baseUrl}/api/tags`, { timeout: 3000 })
      const models = res.data?.models || []
      return models.map(m => ({ id: m.name, name: m.name, size: m.size }))
    } catch {
      return this.config.availableModels || []
    }
  }

  async chat(messages, options = {}) {
    try {
      const response = await axios.post(
        `${this.config.baseUrl}/api/chat`,
        {
          model: options.model || this.currentModel,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: false,
          options: { temperature: options.temperature || 0.7, num_predict: options.max_tokens || 4096 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      )
      // qwen3.5 等思考模型：content 为正式回复，thinking 为思考过程
      const msg = response.data.message || {}
      const content = msg.content || msg.thinking || ''
      return {
        content,
        usage: response.data.eval_count ? { prompt_tokens: response.data.prompt_eval_count, completion_tokens: response.data.eval_count } : null,
        finishReason: response.data.done ? 'stop' : 'length',
      }
    } catch (error) {
      throw new Error(`[ollama] API 错误: ${error.message}`)
    }
  }

  async streamChat(messages, onChunk, options = {}) {
    try {
      const response = await axios.post(
        `${this.config.baseUrl}/api/chat`,
        {
          model: options.model || this.currentModel,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: true,
          options: { temperature: options.temperature || 0.7, num_predict: options.max_tokens || 4096 },
        },
        { responseType: 'stream', headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      )

      let fullContent = ''
      let buffer = ''
      // qwen3.5 等思考模型（Thinking Model）处理逻辑：
      // - 思考阶段：message.thinking 有内容，message.content 为空字符串
      // - 正式回复阶段：message.content 有内容
      // - 旧逻辑 bug：只推送 content，导致纯思考输出时（content 始终为空）用户看到空白
      // 修复：content 有内容时推送 content；全部结束后如果没有任何 content，则推送 thinking
      let thinkingBuffer = ''   // 缓存思考内容备用
      let hasContent = false    // 是否收到过正式 content

      response.data.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            const msg = data.message || {}
            if (msg.content) {
              // 正式回复内容 → 直接推送
              hasContent = true
              fullContent += msg.content
              onChunk(msg.content)
            } else if (msg.thinking) {
              // 思考内容 → 缓存（如果之后没有 content，才推送）
              thinkingBuffer += msg.thinking
            }
          } catch {}
        }
      })

      return new Promise((resolve, reject) => {
        response.data.on('end', () => {
          // 如果整个响应都没有 content（纯思考模型或特殊模式），推送思考内容
          if (!hasContent && thinkingBuffer) {
            onChunk(thinkingBuffer)
            fullContent = thinkingBuffer
          }
          resolve(fullContent)
        })
        response.data.on('error', reject)
      })
    } catch (error) {
      throw new Error(`[ollama] 流式 API 错误: ${error.message}`)
    }
  }

  async _doHealthCheck() {
    await axios.get(`${this.config.baseUrl}/api/tags`, { timeout: 3000 })
  }
}

module.exports = OllamaProvider
