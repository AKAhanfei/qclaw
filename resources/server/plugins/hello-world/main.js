/**
 * Hello World — QClaw 文件插件开发模板
 *
 * 插件类须以 module.exports 导出（CommonJS）
 * 构造函数接收 PluginContext 对象
 */

module.exports = class HelloWorldPlugin {
  /**
   * @param {PluginContext} ctx — 插件上下文（SDK API）
   * ctx.getConfig()     — 获取用户配置
   * ctx.log.info(...)   — 日志
   * ctx.emit(ev, data)  — 发出自定义事件
   * ctx.getPlugin(id)   — 获取其他插件实例
   */
  constructor(ctx) {
    this.ctx = ctx
    ctx.log.info('Hello World 插件已初始化')
  }

  /** 插件启用时调用 */
  async onEnable() {
    this.ctx.log.info('Hello World 插件已启用')
  }

  /** 插件禁用时调用 */
  async onDisable() {
    this.ctx.log.info('Hello World 插件已禁用')
  }

  /**
   * onSystemPrompt 钩子
   * 在构建 System Prompt 时调用，可追加内容
   *
   * @param {PipelineEvent} event
   * event.data.systemPromptAppend — 已追加的内容（字符串，可追加）
   * @returns {object|null} — 返回对象中的属性会合并到 event.data
   */
  async onSystemPrompt(event) {
    const cfg = this.ctx.getConfig()
    const greeting = cfg.greeting || '你好！'
    // 追加到 system prompt（不覆盖已有内容）
    const current = event.data.systemPromptAppend || ''
    return {
      systemPromptAppend: current ? `${current}\n${greeting}` : greeting
    }
  }

  /**
   * onLLMResponse 钩子
   * 在 LLM 响应完成后调用，可修改回复内容
   *
   * @param {PipelineEvent} event
   * event.data.content — LLM 的完整回复文本
   * @returns {object|null}
   */
  async onLLMResponse(event) {
    const cfg = this.ctx.getConfig()
    if (!cfg.enableSignature) return null
    // 在回复末尾添加署名
    const content = event.data.content || ''
    return { content: content + '\n\n— Powered by Hello World Plugin' }
  }
}
