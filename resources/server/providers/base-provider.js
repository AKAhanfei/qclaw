/**
 * Provider 插件基类 - QClaw v2.0
 * Provider Plugin Architecture
 */
class BaseProvider {
  constructor(config = {}) {
    this.id = config.id || 'unknown'
    this.name = config.name || 'Unknown'
    this.config = config
    this._healthy = null
    this._healthCheckedAt = 0
  }

  async bootstrap() {}

  async discover() {
    return this.config.availableModels || []
  }

  async chat(messages, options = {}) {
    throw new Error(`${this.id}: chat() not implemented`)
  }

  async streamChat(messages, onChunk, options = {}) {
    throw new Error(`${this.id}: streamChat() not implemented`)
  }

  async healthCheck() {
    const now = Date.now()
    if (this._healthy !== null && now - this._healthCheckedAt < 30000) {
      return this._healthy
    }
    try {
      await this._doHealthCheck()
      this._healthy = true
    } catch {
      this._healthy = false
    }
    this._healthCheckedAt = now
    return this._healthy
  }

  async _doHealthCheck() {}

  isConfigured() {
    return true
  }

  get currentModel() {
    return this.config.currentModel || ''
  }

  set currentModel(val) {
    this.config.currentModel = val
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.isConfigured(),
      currentModel: this.currentModel,
      models: this.config.availableModels || [],
    }
  }
}

module.exports = BaseProvider
