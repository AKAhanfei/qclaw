/**
 * QClaw Plugin Engine v2.0 — AstrBot 风格插件系统
 *
 * 架构（参考 AstrBot star_manager.py）：
 *  ┌─────────────────────────────────────────────────────┐
 *  │  PluginEngine                                        │
 *  │  ├── PluginLoader    — 扫描/加载磁盘插件             │
 *  │  ├── PluginRegistry  — 注册表（内置 + 文件插件）      │
 *  │  ├── PipelineHooks   — 事件 Pipeline（12 个钩子）    │
 *  │  ├── PluginContext   — 给插件的 SDK API              │
 *  │  └── HotReloader     — 文件监视热重载                │
 *  └─────────────────────────────────────────────────────┘
 *
 * 插件目录结构（参考 AstrBot metadata.yaml）：
 *   server/plugins/<plugin-id>/
 *   ├── main.js          — 插件入口（必须）
 *   ├── metadata.json    — 插件元数据（必须）
 *   └── README.md        — 说明文档（可选）
 *
 * main.js 示例：
 *   module.exports = class MyPlugin {
 *     constructor(ctx) { this.ctx = ctx }
 *     async onEnable()  { ... }
 *     async onDisable() { ... }
 *     // 钩子（可选实现）
 *     async onMessage(event) { return null }
 *     async onLLMRequest(event) { return null }
 *     async onLLMResponse(event) { return null }
 *     async onCommand(event) { return null }
 *     async onSystemPrompt(event) { return null }
 *   }
 *
 * metadata.json 示例：
 *   { "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
 *     "description": "...", "author": "...", "category": "开发工具",
 *     "icon": "🔌", "color": "#4787f0", "tags": ["..."],
 *     "hooks": ["onMessage", "onLLMRequest"] }
 */

const path         = require('path')
const fs           = require('fs')
const EventEmitter = require('events')

// ── 目录 ─────────────────────────────────────────────────────────────────────
const PLUGINS_DIR   = path.join(__dirname, '..', 'plugins')
const CONFIGS_FILE  = path.join(PLUGINS_DIR, 'plugin-configs.json')
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true })

// ── Pipeline 钩子类型（参考 AstrBot filter decorators）────────────────────────
const HOOK_TYPES = [
  'onMessage',       // 消息到来
  'onCommand',       // /命令 触发
  'onLLMRequest',    // LLM 请求发出前（可修改 prompt/messages）
  'onLLMResponse',   // LLM 响应完成后（可修改输出）
  'onSystemPrompt',  // 构建 System Prompt 时（可追加内容）
  'onResponse',      // 发送回复前（可修改最终内容）
  'onInput',         // 用户输入时（前端触发）
  'onTool',          // Tool Call 触发
  'onSessionCreate', // 新会话创建
  'onSessionEnd',    // 会话结束
  'onError',         // 错误发生
  'onLoaded',        // 插件加载完成
]

// ── 内置插件注册表 ────────────────────────────────────────────────────────────
const BUILTIN_PLUGINS = [
  {
    id: 'code-runner',
    name: '代码运行器',
    version: '1.0.0',
    description: '在 AI 对话中直接运行 JavaScript/Node.js 代码片段，实时查看执行结果',
    author: 'QClaw Team',
    category: '开发工具',
    icon: '⚡',
    color: '#e5c07b',
    tags: ['代码', '执行', 'JavaScript'],
    stars: 1250,
    downloads: 8900,
    builtin: true,
    enabled: false,
    config: {
      timeout: { type: 'number', label: '超时时间(ms)', default: 5000 },
      sandbox: { type: 'boolean', label: '启用沙箱', default: true },
    },
    hooks: ['onCommand'],
    command: '/run',
    readme: '使用 `/run` 命令 + 代码块，即可在对话中执行 JavaScript 代码。\n\n**示例：**\n```\n/run\nconsole.log(new Date().toLocaleString())\n```',
  },
  {
    id: 'web-search',
    name: '网络搜索',
    version: '2.1.0',
    description: '为 AI 对话注入实时搜索能力，支持 Bing/DuckDuckGo 多引擎切换',
    author: 'QClaw Team',
    category: 'AI 增强',
    icon: '🔍',
    color: '#4787f0',
    tags: ['搜索', '联网', 'RAG'],
    stars: 3200,
    downloads: 15600,
    builtin: true,
    enabled: false,
    config: {
      engine:  { type: 'select', label: '搜索引擎', options: ['bing', 'duckduckgo'], default: 'duckduckgo' },
      maxResults: { type: 'number', label: '最大结果数', default: 5 },
    },
    hooks: ['onMessage'],
    readme: '自动检测对话中的查询意图，在需要实时信息时自动触发搜索，将结果注入上下文。',
  },
  {
    id: 'image-gen',
    name: '图片生成',
    version: '1.2.0',
    description: '集成 DALL-E / Stable Diffusion，在对话中通过 /image 命令生成图片',
    author: 'QClaw Team',
    category: 'AI 增强',
    icon: '🎨',
    color: '#7c6af7',
    tags: ['图片', 'DALL-E', '创作'],
    stars: 2100,
    downloads: 9800,
    builtin: true,
    enabled: false,
    config: {
      provider: { type: 'select', label: '生成引擎', options: ['dall-e-3', 'stable-diffusion'], default: 'dall-e-3' },
      size:     { type: 'select', label: '图片尺寸', options: ['512x512', '1024x1024'], default: '1024x1024' },
      apiKey:   { type: 'password', label: 'OpenAI API Key', default: '' },
    },
    hooks: ['onCommand'],
    command: '/image',
    readme: '使用 `/image <描述>` 生成图片。支持中英文 prompt，自动翻译为英文后发送给生成引擎。',
  },
  {
    id: 'knowledge-base',
    name: '知识库 RAG',
    version: '1.5.0',
    description: '上传文档（PDF/Word/Markdown），AI 对话时自动检索相关内容增强回答',
    author: 'QClaw Team',
    category: 'AI 增强',
    icon: '📚',
    color: '#28B894',
    tags: ['RAG', '知识库', '文档'],
    stars: 4100,
    downloads: 22000,
    builtin: true,
    enabled: false,
    config: {
      chunkSize:   { type: 'number', label: 'Chunk 大小(字符)', default: 500 },
      topK:        { type: 'number', label: '检索 Top-K', default: 3 },
      threshold:   { type: 'number', label: '相似度阈值', default: 0.7 },
    },
    hooks: ['onMessage'],
    readme: '在插件配置页上传文档，启用后 AI 将自动从文档中检索相关信息来回答问题。',
  },
  {
    id: 'auto-translate',
    name: '自动翻译',
    version: '1.0.3',
    description: '自动检测非中文内容并翻译，或用 /tr 命令手动触发翻译',
    author: 'QClaw Community',
    category: '效率工具',
    icon: '🌐',
    color: '#4ec9b0',
    tags: ['翻译', '多语言', '自动化'],
    stars: 890,
    downloads: 5600,
    builtin: true,
    enabled: false,
    config: {
      autoDetect: { type: 'boolean', label: '自动检测并翻译', default: false },
      targetLang: { type: 'select', label: '目标语言', options: ['zh-CN', 'en', 'ja', 'ko'], default: 'zh-CN' },
    },
    hooks: ['onCommand', 'onMessage'],
    command: '/tr',
    readme: '用 `/tr <内容>` 翻译文字，或开启"自动检测"在 AI 回复非中文时自动翻译。',
  },
  {
    id: 'todo-ai',
    name: 'AI 任务助手',
    version: '1.1.0',
    description: '让 AI 自动提取对话中的任务并添加到 Todo 列表，智能管理你的工作',
    author: 'QClaw Team',
    category: '效率工具',
    icon: '✅',
    color: '#f59e0b',
    tags: ['任务', '效率', '自动化'],
    stars: 1560,
    downloads: 7800,
    builtin: true,
    enabled: false,
    config: {
      autoExtract: { type: 'boolean', label: '自动提取任务', default: true },
      priority:    { type: 'select', label: '默认优先级', options: ['low', 'medium', 'high'], default: 'medium' },
    },
    hooks: ['onMessage'],
    readme: '对话结束后自动扫描 AI 回复，提取 TODO 类条目并写入任务列表。',
  },
  {
    id: 'context-compress',
    name: '上下文压缩',
    version: '2.0.0',
    description: '对话过长时自动摘要压缩历史消息，防止 Token 超限（类 AstrBot 上下文压缩）',
    author: 'QClaw Team',
    category: 'AI 增强',
    icon: '🗜️',
    color: '#9cdcfe',
    tags: ['上下文', 'Token', '压缩'],
    stars: 3800,
    downloads: 18900,
    builtin: true,
    enabled: false,
    config: {
      threshold:   { type: 'number', label: '触发阈值(消息数)', default: 20 },
      keepRecent:  { type: 'number', label: '保留最近N条', default: 5 },
    },
    hooks: ['onLLMRequest'],
    readme: '当对话消息超过阈值时，自动将早期消息摘要压缩为一段文字，避免超出模型上下文长度。',
  },
  {
    id: 'persona-manager',
    name: '人格管理器',
    version: '1.4.0',
    description: '预设多套 AI 人格（角色扮演/助手/专家），一键切换，支持自定义',
    author: 'QClaw Team',
    category: '个性化',
    icon: '🎭',
    color: '#c678dd',
    tags: ['人格', '角色扮演', '个性化'],
    stars: 2900,
    downloads: 14100,
    builtin: true,
    enabled: false,
    config: {
      defaultPersona: { type: 'select', label: '默认人格', options: ['助手', '程序员', '老师', '自定义'], default: '助手' },
      showIndicator:  { type: 'boolean', label: '显示人格标记', default: true },
    },
    hooks: ['onSystemPrompt'],
    readme: '管理多套预设人格，每个人格有独立的 System Prompt，使用 `/persona <名称>` 切换。',
  },
  {
    id: 'emoji-enhancer',
    name: 'Emoji 增强',
    version: '1.0.0',
    description: '为 AI 回复智能添加相关 Emoji，使对话更生动有趣',
    author: 'Community',
    category: '趣味插件',
    icon: '😊',
    color: '#f59e0b',
    tags: ['Emoji', '趣味', '个性化'],
    stars: 450,
    downloads: 3200,
    builtin: true,
    enabled: false,
    config: {
      frequency: { type: 'select', label: 'Emoji 频率', options: ['少量', '适中', '丰富'], default: '适中' },
    },
    hooks: ['onSystemPrompt'],
    readme: '在 AI 的 System Prompt 中注入指令，让 AI 在合适位置使用 Emoji 丰富表达。',
  },
  {
    id: 'voice-input',
    name: '语音输入',
    version: '0.9.0',
    description: '麦克风录音 + Whisper 本地转文字，解放双手对话',
    author: 'QClaw Community',
    category: '输入增强',
    icon: '🎤',
    color: '#f48771',
    tags: ['语音', 'Whisper', 'STT'],
    stars: 2300,
    downloads: 11200,
    builtin: true,
    enabled: false,
    config: {
      model:    { type: 'select', label: 'Whisper 模型', options: ['tiny', 'base', 'small', 'medium'], default: 'base' },
      language: { type: 'select', label: '识别语言', options: ['zh', 'en', 'auto'], default: 'auto' },
    },
    hooks: ['onInput'],
    readme: '点击输入框右侧麦克风图标开始录音，松开后自动识别并填入输入框。需要本地安装 Whisper。',
  },
  {
    id: 'git-assistant',
    name: 'Git 助手',
    version: '1.3.0',
    description: '自动读取当前目录 Git 状态，为 AI 提供代码变更上下文',
    author: 'QClaw Team',
    category: '开发工具',
    icon: '🌿',
    color: '#89e051',
    tags: ['Git', '版本控制', '开发'],
    stars: 1800,
    downloads: 9400,
    builtin: true,
    enabled: false,
    config: {
      autoContext:  { type: 'boolean', label: '自动注入 Git 上下文', default: true },
      includeDiff:  { type: 'boolean', label: '包含 diff 内容', default: false },
    },
    hooks: ['onMessage'],
    readme: '自动将当前目录的 git status、最近 5 次 commit 注入对话上下文。',
  },
  {
    id: 'api-tester',
    name: 'API 测试器',
    version: '1.0.1',
    description: '在对话中测试 REST API，AI 帮你分析响应并给出建议',
    author: 'Community',
    category: '开发工具',
    icon: '🔌',
    color: '#61afef',
    tags: ['API', 'REST', '测试'],
    stars: 720,
    downloads: 4100,
    builtin: true,
    enabled: false,
    config: {
      timeout:    { type: 'number', label: '请求超时(ms)', default: 10000 },
      followRedirect: { type: 'boolean', label: '跟随重定向', default: true },
    },
    hooks: ['onCommand'],
    command: '/api',
    readme: '使用 `/api GET https://api.example.com/data` 发起请求，AI 会自动分析响应结构。',
  },
]

// ── PluginContext — 给插件的 SDK API（类似 AstrBot Context）────────────────────
class PluginContext {
  constructor(pluginId, engine) {
    this._pluginId = pluginId
    this._engine   = engine
    this.log = {
      info:  (...a) => console.log(`[Plugin:${pluginId}]`, ...a),
      warn:  (...a) => console.warn(`[Plugin:${pluginId}]`, ...a),
      error: (...a) => console.error(`[Plugin:${pluginId}]`, ...a),
    }
  }

  /** 获取本插件的用户配置 */
  getConfig() {
    return this._engine.getPluginConfig(this._pluginId)
  }

  /** 发出自定义事件（供其他插件监听） */
  emit(event, data) {
    this._engine.emit(`plugin:${this._pluginId}:${event}`, data)
  }

  /** 监听另一个插件的事件 */
  on(targetPlugin, event, handler) {
    this._engine.on(`plugin:${targetPlugin}:${event}`, handler)
  }

  /** 获取其他已启用插件的引用 */
  getPlugin(id) {
    return this._engine.getPlugin(id)
  }
}

// ── PluginLoader — 文件系统插件加载器 ────────────────────────────────────────
class PluginLoader {
  constructor(pluginsDir) {
    this.dir = pluginsDir
  }

  /**
   * 扫描并加载所有磁盘插件
   * @returns {Array} 插件元数据列表
   */
  scanAll() {
    const results = []
    if (!fs.existsSync(this.dir)) return results

    const entries = fs.readdirSync(this.dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginDir = path.join(this.dir, entry.name)
      const metaPath  = path.join(pluginDir, 'metadata.json')
      const mainPath  = path.join(pluginDir, 'main.js')

      if (!fs.existsSync(metaPath) || !fs.existsSync(mainPath)) continue

      try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        if (!metadata.id || !metadata.name) continue
        results.push({ metadata, dir: pluginDir, mainPath })
      } catch(e) {
        console.warn(`[PluginLoader] 读取元数据失败 ${entry.name}:`, e.message)
      }
    }
    return results
  }

  /**
   * 加载单个插件的 JS 模块（带错误隔离）
   */
  loadModule(mainPath) {
    try {
      // 清除 require 缓存，支持热重载
      delete require.cache[require.resolve(mainPath)]
      const PluginClass = require(mainPath)
      return { ok: true, PluginClass }
    } catch(e) {
      return { ok: false, error: e.message }
    }
  }
}

// ── Pipeline 事件对象 ─────────────────────────────────────────────────────────
class PipelineEvent {
  constructor(type, data) {
    this.type    = type
    this.data    = data
    this._stop   = false    // 是否中断后续插件处理
    this._modified = false  // 是否有数据被修改
  }

  /** 阻止后续插件处理此事件 */
  stopPropagation() { this._stop = true }

  /** 标记数据已修改 */
  markModified() { this._modified = true }
}

// ── 主引擎 ──────────────────────────────────────────────────────────────────
class PluginEngine extends EventEmitter {
  constructor() {
    super()
    this.plugins    = new Map()    // id → pluginRecord
    this.instances  = new Map()    // id → pluginInstance（运行时实例）
    this.configs    = {}           // id → { enabled, userConfig, installedAt }
    this._loader    = new PluginLoader(PLUGINS_DIR)
    this._watchers  = new Map()    // id → FSWatcher

    this._loadConfigs()
    this._initBuiltins()
    this._scanDiskPlugins()
    console.log('[PluginEngine v2.0] 初始化完成, 已加载', this.plugins.size, '个插件')
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────────
  _loadConfigs() {
    try {
      if (fs.existsSync(CONFIGS_FILE))
        this.configs = JSON.parse(fs.readFileSync(CONFIGS_FILE, 'utf8'))
    } catch { this.configs = {} }
  }

  _saveConfigs() {
    try {
      fs.writeFileSync(CONFIGS_FILE, JSON.stringify(this.configs, null, 2), 'utf8')
    } catch(e) { console.error('[PluginEngine] 保存配置失败:', e.message) }
  }

  // ── 初始化内置插件 ──────────────────────────────────────────────────────────
  _initBuiltins() {
    for (const meta of BUILTIN_PLUGINS) {
      const saved = this.configs[meta.id] || {}
      this.plugins.set(meta.id, {
        ...meta,
        enabled:     saved.enabled !== undefined ? saved.enabled : meta.enabled,
        userConfig:  { ...this._defaultConfig(meta), ...(saved.userConfig || {}) },
        installedAt: saved.installedAt || null,
        isBuiltin:   true,
        isFile:      false,
      })
    }
  }

  // ── 扫描磁盘插件 ────────────────────────────────────────────────────────────
  _scanDiskPlugins() {
    const found = this._loader.scanAll()
    for (const { metadata, dir, mainPath } of found) {
      const saved = this.configs[metadata.id] || {}
      const record = {
        ...metadata,
        enabled:     saved.enabled !== undefined ? saved.enabled : false,
        userConfig:  { ...this._defaultConfig(metadata), ...(saved.userConfig || {}) },
        installedAt: saved.installedAt || new Date().toISOString(),
        isBuiltin:   false,
        isFile:      true,
        _dir:        dir,
        _mainPath:   mainPath,
        stars:       metadata.stars || 0,
        downloads:   metadata.downloads || 0,
      }
      this.plugins.set(metadata.id, record)

      // 如果之前是启用状态，自动加载实例
      if (record.enabled) {
        this._loadInstance(record)
      }
    }
  }

  // ── 加载插件实例 ────────────────────────────────────────────────────────────
  _loadInstance(record) {
    if (!record.isFile || !record._mainPath) return
    const { ok, PluginClass, error } = this._loader.loadModule(record._mainPath)
    if (!ok) {
      console.error(`[PluginEngine] 加载插件失败 ${record.id}:`, error)
      return false
    }
    try {
      const ctx      = new PluginContext(record.id, this)
      const instance = new PluginClass(ctx)
      this.instances.set(record.id, instance)
      console.log(`[PluginEngine] 实例化插件: ${record.name} (${record.id})`)
      return true
    } catch(e) {
      console.error(`[PluginEngine] 实例化失败 ${record.id}:`, e.message)
      return false
    }
  }

  // ── 默认配置 ────────────────────────────────────────────────────────────────
  _defaultConfig(meta) {
    if (!meta.config) return {}
    const cfg = {}
    for (const [k, schema] of Object.entries(meta.config)) cfg[k] = schema.default
    return cfg
  }

  // ── 获取插件配置（供 PluginContext 使用）────────────────────────────────────
  getPluginConfig(id) {
    return this.plugins.get(id)?.userConfig || {}
  }

  getPlugin(id) {
    return this.instances.get(id) || null
  }

  // ── CRUD 操作 ────────────────────────────────────────────────────────────────
  list({ category, search, onlyEnabled } = {}) {
    let items = [...this.plugins.values()]
    if (category && category !== '全部')
      items = items.filter(p => p.category === category)
    if (search) {
      const q = search.toLowerCase()
      items = items.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.toLowerCase().includes(q))
      )
    }
    if (onlyEnabled) items = items.filter(p => p.enabled)
    return items.sort((a, b) => (b.stars || 0) - (a.stars || 0))
  }

  getCategories() {
    const cats = new Set(['全部'])
    for (const p of this.plugins.values()) if (p.category) cats.add(p.category)
    return [...cats]
  }

  install(pluginId) {
    const p = this.plugins.get(pluginId)
    if (!p) return { ok: false, error: '插件不存在' }
    if (p.installedAt) return { ok: false, error: '插件已安装' }
    const updated = { ...p, installedAt: new Date().toISOString() }
    this.plugins.set(pluginId, updated)
    this._persistPlugin(pluginId)
    this.emit('installed', updated)
    return { ok: true, plugin: updated }
  }

  uninstall(pluginId) {
    const p = this.plugins.get(pluginId)
    if (!p) return { ok: false, error: '插件不存在' }
    if (p.isBuiltin && !p.installedAt) return { ok: false, error: '内置插件无法卸载（可禁用）' }
    if (p.enabled) this.disable(pluginId)

    if (p.isFile && p._dir) {
      // 文件插件：删除目录
      try {
        fs.rmSync(p._dir, { recursive: true, force: true })
        this.plugins.delete(pluginId)
        delete this.configs[pluginId]
        this._saveConfigs()
        this.emit('uninstalled', { id: pluginId })
        console.log(`[PluginEngine] 卸载并删除文件插件: ${p.name}`)
        return { ok: true }
      } catch(e) {
        return { ok: false, error: '删除插件文件失败: ' + e.message }
      }
    }

    const updated = { ...p, installedAt: null, enabled: false }
    this.plugins.set(pluginId, updated)
    this._persistPlugin(pluginId)
    this.emit('uninstalled', updated)
    return { ok: true }
  }

  async enable(pluginId) {
    const p = this.plugins.get(pluginId)
    if (!p) return { ok: false, error: '插件不存在' }

    // 文件插件：加载实例
    if (p.isFile && !this.instances.has(pluginId)) {
      const loaded = this._loadInstance(p)
      if (!loaded) return { ok: false, error: '插件加载失败，请检查 main.js' }
    }

    // 调用 onEnable 钩子
    const instance = this.instances.get(pluginId)
    if (instance?.onEnable) {
      try { await instance.onEnable() } catch(e) {
        console.error(`[PluginEngine] onEnable 失败 ${pluginId}:`, e.message)
      }
    }

    const updated = { ...p, enabled: true }
    this.plugins.set(pluginId, updated)
    this._persistPlugin(pluginId)

    // 启动文件监视（热重载）
    if (p.isFile) this._watchPlugin(p)

    this.emit('enabled', updated)
    console.log(`[PluginEngine] 启用: ${p.name}`)
    return { ok: true }
  }

  async disable(pluginId) {
    const p = this.plugins.get(pluginId)
    if (!p) return { ok: false, error: '插件不存在' }

    // 调用 onDisable 钩子
    const instance = this.instances.get(pluginId)
    if (instance?.onDisable) {
      try { await instance.onDisable() } catch(e) {
        console.error(`[PluginEngine] onDisable 失败 ${pluginId}:`, e.message)
      }
    }

    // 停止文件监视
    this._unwatchPlugin(pluginId)

    const updated = { ...p, enabled: false }
    this.plugins.set(pluginId, updated)
    this._persistPlugin(pluginId)
    this.emit('disabled', updated)
    console.log(`[PluginEngine] 禁用: ${p.name}`)
    return { ok: true }
  }

  updateConfig(pluginId, newConfig) {
    const p = this.plugins.get(pluginId)
    if (!p) return { ok: false, error: '插件不存在' }
    const updated = { ...p, userConfig: { ...p.userConfig, ...newConfig } }
    this.plugins.set(pluginId, updated)
    this._persistPlugin(pluginId)
    this.emit('configUpdated', updated)
    return { ok: true, config: updated.userConfig }
  }

  // ── 从本地目录安装文件插件（zip/目录复制）───────────────────────────────────
  installFromDir(srcDir) {
    const metaPath = path.join(srcDir, 'metadata.json')
    const mainPath = path.join(srcDir, 'main.js')
    if (!fs.existsSync(metaPath) || !fs.existsSync(mainPath)) {
      return { ok: false, error: '缺少 metadata.json 或 main.js' }
    }
    let metadata
    try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')) }
    catch(e) { return { ok: false, error: 'metadata.json 格式错误: ' + e.message } }

    if (!metadata.id || !metadata.name) {
      return { ok: false, error: 'metadata.json 缺少 id 或 name 字段' }
    }
    if (this.plugins.has(metadata.id)) {
      return { ok: false, error: `插件 ${metadata.id} 已存在，请先卸载` }
    }

    const destDir = path.join(PLUGINS_DIR, metadata.id)
    try {
      fs.cpSync(srcDir, destDir, { recursive: true })
    } catch(e) {
      return { ok: false, error: '复制插件文件失败: ' + e.message }
    }

    const record = {
      ...metadata,
      enabled:     false,
      userConfig:  this._defaultConfig(metadata),
      installedAt: new Date().toISOString(),
      isBuiltin:   false,
      isFile:      true,
      _dir:        destDir,
      _mainPath:   path.join(destDir, 'main.js'),
      stars:       metadata.stars || 0,
      downloads:   metadata.downloads || 0,
    }
    this.plugins.set(metadata.id, record)
    this._persistPlugin(metadata.id)
    this.emit('installed', record)
    console.log(`[PluginEngine] 从目录安装插件: ${metadata.name}`)
    return { ok: true, plugin: record }
  }

  // ── 热重载 ──────────────────────────────────────────────────────────────────
  async reload(pluginId) {
    const p = this.plugins.get(pluginId)
    if (!p || !p.isFile) return { ok: false, error: '只有文件插件支持重载' }

    const wasEnabled = p.enabled
    if (wasEnabled) await this.disable(pluginId)

    // 清除旧实例
    this.instances.delete(pluginId)

    if (wasEnabled) {
      const loaded = this._loadInstance(p)
      if (!loaded) return { ok: false, error: '重载失败，请检查 main.js 语法' }
      await this.enable(pluginId)
    }

    console.log(`[PluginEngine] 热重载: ${p.name}`)
    this.emit('reloaded', p)
    return { ok: true }
  }

  // ── 文件监视（热重载支持）────────────────────────────────────────────────────
  _watchPlugin(record) {
    if (!record.isFile || this._watchers.has(record.id)) return
    try {
      const watcher = fs.watch(record._dir, { recursive: true }, (event, filename) => {
        if (filename?.endsWith('.js')) {
          console.log(`[PluginEngine] 检测到文件变化: ${record.id}/${filename}，触发热重载`)
          setTimeout(() => this.reload(record.id), 200)
        }
      })
      this._watchers.set(record.id, watcher)
    } catch(e) {
      console.warn(`[PluginEngine] 文件监视失败 ${record.id}:`, e.message)
    }
  }

  _unwatchPlugin(pluginId) {
    const watcher = this._watchers.get(pluginId)
    if (watcher) { try { watcher.close() } catch {} }
    this._watchers.delete(pluginId)
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────────
  _persistPlugin(pluginId) {
    const p = this.plugins.get(pluginId)
    if (!p) return
    this.configs[pluginId] = {
      enabled:     p.enabled,
      installedAt: p.installedAt,
      userConfig:  p.userConfig,
    }
    this._saveConfigs()
  }

  // ╔══════════════════════════════════════════════════════════════╗
  // ║               PIPELINE — 核心钩子系统                        ║
  // ║   参考 AstrBot filter.on_llm_request / on_llm_response       ║
  // ╚══════════════════════════════════════════════════════════════╝

  /**
   * 触发 Pipeline 钩子
   * @param {string} hookName  — 钩子名（HOOK_TYPES 之一）
   * @param {object} data      — 事件数据（可被插件修改）
   * @returns {object}         — 处理后的 data
   */
  async pipeline(hookName, data) {
    const event = new PipelineEvent(hookName, data)

    // 获取监听此钩子的已启用插件（按 stars 排序保持稳定执行顺序）
    const enabledPlugins = [...this.plugins.values()]
      .filter(p => p.enabled && (p.hooks || []).includes(hookName))
      .sort((a, b) => (b.stars || 0) - (a.stars || 0))

    for (const plugin of enabledPlugins) {
      if (event._stop) break

      try {
        // 文件插件：调用实例方法
        if (plugin.isFile) {
          const instance = this.instances.get(plugin.id)
          if (instance && typeof instance[hookName] === 'function') {
            const result = await instance[hookName](event)
            if (result !== null && result !== undefined) {
              Object.assign(event.data, result)
              event.markModified()
            }
          }
          continue
        }

        // 内置插件：内置逻辑处理
        const result = await this._runBuiltinHook(plugin, hookName, event)
        if (result !== null && result !== undefined) {
          Object.assign(event.data, result)
          event.markModified()
        }
      } catch(e) {
        console.error(`[PluginEngine] Pipeline 错误 ${plugin.id}@${hookName}:`, e.message)
      }
    }

    return event.data
  }

  // ── 内置插件 Pipeline 逻辑 ────────────────────────────────────────────────
  async _runBuiltinHook(plugin, hookName, event) {
    const cfg = plugin.userConfig || {}

    // ── onSystemPrompt ──────────────────────────────────────────────────────
    if (hookName === 'onSystemPrompt') {
      if (plugin.id === 'persona-manager') {
        const persona  = cfg.defaultPersona || '助手'
        const personas = {
          '助手':  '你是一个友善、专业的 AI 助手，回答简洁、准确。',
          '程序员': '你是经验丰富的程序员，喜欢简洁的代码和最佳实践，直接给出代码，减少废话。',
          '老师':  '你是一个耐心的老师，善于用例子解释复杂概念，循序渐进地引导学习。',
        }
        const inject = personas[persona] || ''
        return inject ? { systemPromptAppend: inject } : null
      }
      if (plugin.id === 'emoji-enhancer') {
        const freq = cfg.frequency || '适中'
        const map  = { '少量': '偶尔', '适中': '适量', '丰富': '大量' }
        return { systemPromptAppend: `请在回复中${map[freq]}使用相关 Emoji 使表达更生动。` }
      }
    }

    // ── onLLMRequest（消息预处理）────────────────────────────────────────────
    if (hookName === 'onLLMRequest') {
      if (plugin.id === 'context-compress') {
        const threshold  = cfg.threshold  || 20
        const keepRecent = cfg.keepRecent || 5
        const msgs = event.data.messages || []
        if (msgs.length > threshold) {
          // 简单实现：截断保留最近 keepRecent 条
          const kept  = msgs.slice(-keepRecent)
          const omitted = msgs.length - keepRecent
          const summary = `[上下文已压缩：省略了 ${omitted} 条早期消息]`
          return {
            messages: [{ role: 'system', content: summary }, ...kept],
            _compressed: true,
          }
        }
      }
    }

    return null
  }

  // ── 便捷方法：获取 SystemPrompt 注入内容 ─────────────────────────────────────
  async getSystemPromptInjections() {
    const data = await this.pipeline('onSystemPrompt', { systemPromptAppend: '' })
    return data.systemPromptAppend || ''
  }

  // ── 便捷方法：处理 LLM 请求前（消息预处理）──────────────────────────────────
  async processLLMRequest(messages, context = {}) {
    const data = await this.pipeline('onLLMRequest', { messages, ...context })
    return data.messages || messages
  }

  // ── 便捷方法：处理 LLM 响应后 ────────────────────────────────────────────────
  async processLLMResponse(content, context = {}) {
    const data = await this.pipeline('onLLMResponse', { content, ...context })
    return data.content || content
  }

  // ── 状态统计 ────────────────────────────────────────────────────────────────
  getStatus() {
    const all     = [...this.plugins.values()]
    const enabled = all.filter(p => p.enabled)
    return {
      total:      all.length,
      enabled:    enabled.length,
      installed:  all.filter(p => p.installedAt).length,
      filePlugins: all.filter(p => p.isFile).length,
      builtins:   all.filter(p => p.isBuiltin).length,
      categories: this.getCategories().filter(c => c !== '全部').length,
      hooks:      HOOK_TYPES,
    }
  }
}

// ── 单例 ──────────────────────────────────────────────────────────────────────
const engine = new PluginEngine()
module.exports = engine
module.exports.HOOK_TYPES = HOOK_TYPES
module.exports.PipelineEvent = PipelineEvent
