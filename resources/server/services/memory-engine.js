/**
 * QClaw Memory Engine - Inspired by MiniClaw
 * 染色体记忆系统：长期记忆持久化 + 痛觉学习 + 情绪状态 + 主动探索
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// ── 存储路径 ────────────────────────────────────────────────────────────────
const DATA_DIR     = path.join(os.homedir(), '.qclaw')
const MEMORY_FILE  = path.join(DATA_DIR, 'memory.json')
const EMOTION_FILE = path.join(DATA_DIR, 'emotion.json')
const NOCI_FILE    = path.join(DATA_DIR, 'nociception.json')

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

// ─── 默认情绪状态（MiniClaw 四维模型）──────────────────────────────────────
const DEFAULT_EMOTION = {
  alertness:  0.7,   // 警觉度    0~1
  valence:    0.6,   // 情绪效价  0(负) ~ 1(正)
  curiosity:  0.8,   // 好奇驱动  0~1
  confidence: 0.7,   // 行动信心  0~1
  updatedAt:  Date.now(),
}

// ─── 情绪管理器 ─────────────────────────────────────────────────────────────
class EmotionSystem {
  constructor() {
    ensureDir()
    this.state = this._load()
  }

  _load() {
    try {
      const raw = fs.readFileSync(EMOTION_FILE, 'utf8')
      return { ...DEFAULT_EMOTION, ...JSON.parse(raw) }
    } catch {
      return { ...DEFAULT_EMOTION }
    }
  }

  save() {
    try { fs.writeFileSync(EMOTION_FILE, JSON.stringify(this.state, null, 2)) } catch {}
  }

  get() { return { ...this.state } }

  /**
   * 根据对话事件更新情绪
   * @param {'success'|'error'|'user_praise'|'user_frustration'|'new_topic'} event
   */
  update(event) {
    const s = this.state
    switch (event) {
      case 'success':
        s.valence    = Math.min(1, s.valence    + 0.05)
        s.confidence = Math.min(1, s.confidence + 0.03)
        s.alertness  = Math.max(0.3, s.alertness - 0.02) // 成功后稍放松
        break
      case 'error':
        s.valence    = Math.max(0, s.valence    - 0.08)
        s.confidence = Math.max(0, s.confidence - 0.05)
        s.alertness  = Math.min(1, s.alertness  + 0.10) // 出错→警觉提升
        break
      case 'user_praise':
        s.valence    = Math.min(1, s.valence    + 0.10)
        s.confidence = Math.min(1, s.confidence + 0.08)
        s.curiosity  = Math.min(1, s.curiosity  + 0.03)
        break
      case 'user_frustration':
        s.valence    = Math.max(0, s.valence    - 0.12)
        s.alertness  = Math.min(1, s.alertness  + 0.15)
        break
      case 'new_topic':
        s.curiosity  = Math.min(1, s.curiosity  + 0.05)
        s.alertness  = Math.min(1, s.alertness  + 0.03)
        break
    }
    s.updatedAt = Date.now()
    this.save()
    return this.get()
  }

  /**
   * 将情绪状态转换为 System Prompt 附加段
   */
  toPromptHint() {
    const s = this.state
    const hints = []
    if (s.alertness > 0.85)   hints.push('你现在处于高度警觉状态，请格外仔细地检查每个细节')
    if (s.valence < 0.3)      hints.push('最近遇到了一些挫折，请谨慎行事并从中学习')
    if (s.curiosity > 0.85)   hints.push('你现在充满好奇心，可以主动提出探索性的问题')
    if (s.confidence > 0.85)  hints.push('你现在信心充沛，可以给出更具体的建议')
    if (s.confidence < 0.3)   hints.push('对不确定的内容要明确表示不确定')
    return hints.length ? `\n[内部状态提示: ${hints.join('；')}]` : ''
  }

  /**
   * 情绪自然衰减（向中性靠拢）
   */
  decay() {
    const s  = this.state
    const dt = (Date.now() - s.updatedAt) / 3600000 // 小时数
    if (dt < 1) return
    const decay = Math.min(dt * 0.02, 0.1)
    s.alertness  = lerp(s.alertness,  0.7, decay)
    s.valence    = lerp(s.valence,    0.6, decay)
    s.curiosity  = lerp(s.curiosity,  0.8, decay)
    s.confidence = lerp(s.confidence, 0.7, decay)
    s.updatedAt  = Date.now()
    this.save()
  }
}

// ─── 痛觉记忆（Nociception）─────────────────────────────────────────────────
class NociceptionMemory {
  constructor() {
    ensureDir()
    this.memories = this._load()
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(NOCI_FILE, 'utf8')) } catch { return [] }
  }

  save() {
    try { fs.writeFileSync(NOCI_FILE, JSON.stringify(this.memories, null, 2)) } catch {}
  }

  /**
   * 记录一次负面经历
   * @param {string} pattern  - 触发错误的模式（如 "使用 fs.readFileSync 未加 try-catch"）
   * @param {string} lesson   - 学到的教训
   * @param {number} severity - 严重程度 0~1
   */
  record(pattern, lesson, severity = 0.5) {
    const existing = this.memories.find(m => m.pattern === pattern)
    if (existing) {
      existing.count++
      existing.severity = Math.min(1, existing.severity + 0.1)
      existing.lastAt = Date.now()
    } else {
      this.memories.push({ pattern, lesson, severity, count: 1,
        createdAt: Date.now(), lastAt: Date.now(), weight: severity })
    }
    this._recalcWeights()
    this.save()
  }

  /**
   * 权重随时间衰减（一个月内有效，权重随记录次数增加）
   */
  _recalcWeights() {
    const now = Date.now()
    for (const m of this.memories) {
      const age    = (now - m.lastAt) / (30 * 24 * 3600000) // 月龄
      const decay  = Math.max(0.1, 1 - age * 0.5)
      m.weight = m.severity * Math.log(m.count + 1) * decay
    }
    // 最多保留 50 条，按权重排序
    this.memories.sort((a, b) => b.weight - a.weight)
    if (this.memories.length > 50) this.memories = this.memories.slice(0, 50)
  }

  /**
   * 获取系统提示附加的"踩坑提醒"
   */
  toPromptHint() {
    const topMemories = this.memories.slice(0, 5).filter(m => m.weight > 0.2)
    if (!topMemories.length) return ''
    const lines = topMemories.map(m => `- [重要教训] ${m.lesson}`)
    return `\n[历史踩坑记录]\n${lines.join('\n')}`
  }

  getAll() { return [...this.memories] }
}

// ─── 长期记忆（染色体记忆）──────────────────────────────────────────────────
class LongTermMemory {
  constructor() {
    ensureDir()
    this.data = this._load()
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
    } catch {
      return {
        facts: [],        // 用户显式告诉 AI 的事实
        preferences: {},  // 用户偏好（如代码风格、语言偏好）
        patterns: [],     // 检测到的用户行为模式
        skills: [],       // 已习得的技能/知识点
        userProfile: {    // 用户画像
          name: '',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: 'zh-CN',
          codingStyle: 'unknown',
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    }
  }

  save() {
    try {
      this.data.updatedAt = Date.now()
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2))
    } catch {}
  }

  /** 添加一条事实记忆 */
  addFact(content, source = 'user') {
    if (!content?.trim()) return
    const existing = this.data.facts.find(f => f.content === content)
    if (existing) { existing.count++; existing.updatedAt = Date.now() }
    else this.data.facts.push({ content, source, count: 1,
      createdAt: Date.now(), updatedAt: Date.now() })
    // 最多保留 200 条
    if (this.data.facts.length > 200)
      this.data.facts = this.data.facts.sort((a, b) => b.count - a.count).slice(0, 200)
    this.save()
  }

  /** 更新用户偏好 */
  updatePreference(key, value) {
    this.data.preferences[key] = value
    this.save()
  }

  /** 记录行为模式（主动探索检测） */
  recordPattern(pattern) {
    const existing = this.data.patterns.find(p => p.pattern === pattern)
    if (existing) { existing.count++; existing.lastAt = Date.now() }
    else this.data.patterns.push({ pattern, count: 1, createdAt: Date.now(), lastAt: Date.now() })
    // 模式出现 3 次以上触发"主动探索"建议
    const hot = this.data.patterns.filter(p => p.count >= 3)
    this.save()
    return hot
  }

  /** 更新用户资料 */
  updateProfile(partial) {
    Object.assign(this.data.userProfile, partial)
    this.save()
  }

  /** 获取记忆摘要（用于 System Prompt） */
  toPromptContext() {
    const lines = []
    if (this.data.userProfile.name) {
      lines.push(`[用户信息] 用户名: ${this.data.userProfile.name}`)
    }
    if (Object.keys(this.data.preferences).length) {
      const prefs = Object.entries(this.data.preferences)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
      lines.push(`[用户偏好] ${prefs}`)
    }
    const topFacts = this.data.facts
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
    if (topFacts.length) {
      lines.push(`[长期记忆]\n${topFacts.map(f => `- ${f.content}`).join('\n')}`)
    }
    return lines.length ? `\n${lines.join('\n')}` : ''
  }

  getAll() { return { ...this.data } }
}

// ─── 主动探索检测（Active Exploration）────────────────────────────────────
class ActiveExploration {
  constructor(memory) {
    this.memory  = memory
    this.queue   = [] // 待建议的主动提示队列
  }

  /**
   * 分析用户消息，检测重复模式 → 触发主动建议
   * @param {string} userMessage
   * @returns {string|null} 主动建议文本，无则 null
   */
  analyze(userMessage) {
    const msg = userMessage.toLowerCase()

    // 检测重复工作流
    const WORKFLOW_PATTERNS = [
      { pattern: 'git commit', label: '频繁 Git 提交' },
      { pattern: 'npm install', label: '频繁包安装' },
      { pattern: 'debug', label: '频繁调试' },
      { pattern: 'fix bug', label: '频繁 Bug 修复' },
      { pattern: '重构', label: '代码重构工作' },
      { pattern: '测试', label: '编写测试' },
    ]

    for (const wp of WORKFLOW_PATTERNS) {
      if (msg.includes(wp.pattern)) {
        const hotPatterns = this.memory.recordPattern(wp.label)
        const thisPattern = hotPatterns.find(p => p.pattern === wp.label)
        if (thisPattern?.count === 3) {
          return `我注意到你经常进行"${wp.label}"，是否需要我帮你创建一个专用技能或工作流模板？`
        }
      }
    }

    // 检测新工具/技术关键词
    const NEW_TECH_KEYWORDS = ['docker', 'kubernetes', 'graphql', 'rust', 'wasm', 'bun', 'deno']
    for (const kw of NEW_TECH_KEYWORDS) {
      if (msg.includes(kw)) {
        const hotPatterns = this.memory.recordPattern(`new_tech_${kw}`)
        const p = hotPatterns.find(hp => hp.pattern === `new_tech_${kw}`)
        if (p?.count === 2) {
          return `我注意到你开始接触 ${kw.toUpperCase()}，需要我记录一些关于它的常用知识点吗？`
        }
      }
    }

    return null
  }
}

// ─── 自适应上下文引擎（ACE）────────────────────────────────────────────────
class AdaptiveContextEngine {
  constructor(emotion, memory, nociception) {
    this.emotion     = emotion
    this.memory      = memory
    this.nociception = nociception
    this.exploration = new ActiveExploration(memory)
  }

  /**
   * 根据时间 + 情绪 + 记忆，动态调整行为模式
   * @returns {'morning_brief'|'night_distill'|'code_focus'|'creative'|'normal'}
   */
  detectMode() {
    const hour = new Date().getHours()
    if (hour >= 6  && hour < 9)  return 'morning_brief'
    if (hour >= 22 || hour < 2)  return 'night_distill'
    const e = this.emotion.get()
    if (e.alertness > 0.85)      return 'code_focus'
    if (e.curiosity > 0.85)      return 'creative'
    return 'normal'
  }

  /**
   * 构建增强的 System Prompt
   * @param {string} basePrompt     - 基础系统提示
   * @param {string} userMessage    - 当前用户消息
   * @returns {{ systemPrompt, activeExplorationHint }}
   */
  buildEnhancedPrompt(basePrompt, userMessage = '') {
    // 自然衰减情绪
    this.emotion.decay()

    const mode    = this.detectMode()
    const modeHint = {
      morning_brief: '\n[早晨模式] 简洁高效，优先给出可执行的行动建议。',
      night_distill: '\n[夜晚模式] 适合深度思考，可以进行知识梳理和总结。',
      code_focus:    '\n[专注模式] 用户处于高强度工作状态，直接、精准、无废话。',
      creative:      '\n[探索模式] 用户充满好奇，欢迎提出新想法和创意方案。',
      normal:        '',
    }[mode]

    // ── 时区注入（openclaw 官方对齐：仅注入时区名，保持 prompt cache 稳定）
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const tzHint = `\n\n[环境信息]\n- 时区：${tz}\n- 平台：${process.platform}\n- 日期：${new Date().toLocaleDateString('zh-CN', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })}`

    const emotionHint     = this.emotion.toPromptHint()
    const memoryContext   = this.memory.toPromptContext()
    const nociHint        = this.nociception.toPromptHint()
    const explorationHint = userMessage ? this.exploration.analyze(userMessage) : null

    const systemPrompt = basePrompt + tzHint + modeHint + emotionHint + memoryContext + nociHint

    return { systemPrompt, explorationHint, mode }
  }

  /**
   * 从对话中提取记忆片段
   * @param {string} userMessage
   * @param {string} assistantResponse
   */
  extractMemory(userMessage, assistantResponse) {
    if (!userMessage) return

    // 检测用户表达的偏好（修复：cb 中 memory → this.memory）
    const PREFS = [
      { re: /(?:我|我喜欢|我习惯|我偏好)用\s*(\w+)\s*(?:风格|格式|方式)/i, key: 'style' },
      { re: /(?:我叫|我的名字是|叫我)\s*(\S{1,12})/,
        cb: (v) => this.memory.updateProfile({ name: v }) },
      { re: /(?:我在|我用|我使用)\s*(windows|mac|linux|ubuntu)/i,          key: 'os' },
      { re: /(?:我的主要语言|我用)\s*(python|javascript|typescript|go|rust|java|c\+\+)/i, key: 'lang' },
    ]
    for (const p of PREFS) {
      const m = userMessage.match(p.re)
      if (m) {
        if (p.cb) p.cb(m[1])
        else this.memory.updatePreference(p.key, m[1])
      }
    }

    // 检测用户主动说"记住..."→ 长期记忆
    const rememberMatch = userMessage.match(/(?:记住|记一下|帮我记|please remember)[：:，,\s]+(.+)/i)
    if (rememberMatch) {
      this.memory.addFact(rememberMatch[1].trim(), 'user_explicit')
    }

    // 检测错误/失败模式 → 痛觉记忆
    if (assistantResponse && /error|exception|failed|失败|报错|崩溃/i.test(assistantResponse)) {
      const snippet = userMessage.slice(0, 80)
      this.nociception.record(snippet,
        `处理"${snippet.slice(0, 40)}..."时出现错误，需要更谨慎`, 0.4)
    }

    // 检测用户称赞 → 情绪正向
    if (/谢谢|感谢|太好了|完美|厉害|牛|棒|nice|great|perfect|awesome/i.test(userMessage)) {
      this.emotion.update('user_praise')
    }

    // 检测用户不满 → 情绪负向
    if (/不对|错了|不是这个意思|你理解错|重新来|不要这样|garbage|wrong|不懂/i.test(userMessage)) {
      this.emotion.update('user_frustration')
    }

    // 检测新话题（短消息通常是话题切换）
    if (userMessage.length < 30 && !userMessage.includes('?') && !userMessage.includes('？')) {
      this.emotion.update('new_topic')
    }
  }

  /**
   * 自我学习：从对话中自动提炼有价值的知识点保存到长期记忆
   * 参考 openclaw learnFromConversation 模式
   *
   * 触发条件：
   *   1. AI 回复给出了"成功的解决方案"（用户后续未抱怨）
   *   2. AI 回复包含代码块（技术知识）
   *   3. AI 回复包含明确的"方法/步骤"说明
   *
   * @param {string} userMessage
   * @param {string} assistantResponse
   * @param {Object} context  { toolResults: Array, sessionId }
   */
  learnFromConversation(userMessage, assistantResponse, context = {}) {
    if (!userMessage || !assistantResponse) return

    const resp = assistantResponse

    // ── 1. 学习代码知识片段（含代码块且回复较长）────────────────────────
    const codeBlockCount = (resp.match(/```[\s\S]*?```/g) || []).length
    if (codeBlockCount >= 1 && resp.length > 300) {
      // 提取第一个代码块之前的说明文字作为 fact 摘要
      const beforeCode = resp.split('```')[0].trim().slice(0, 200)
      const question   = userMessage.trim().slice(0, 80)
      if (beforeCode.length > 20) {
        this.memory.addFact(
          `[技术方案] Q: "${question}" → ${beforeCode}`,
          'auto_learn_code'
        )
      }
    }

    // ── 2. 学习错误修复知识（工具执行失败+修复成功）────────────────────
    const { toolResults } = context
    if (Array.isArray(toolResults)) {
      const failedThen = toolResults.filter(r => !r.result.ok)
      if (failedThen.length > 0 && resp.includes('✅')) {
        // AI 在有工具失败的情况下仍给出了成功答案 → 记录修复路径
        for (const { call, result } of failedThen) {
          const lesson = `执行 ${call.tool} 失败（${(result.error || '').slice(0, 60)}），需要先检查路径/权限或换用其他工具`
          this.nociception.record(
            `${call.tool}_failure`,
            lesson,
            0.5,
          )
        }
      }
    }

    // ── 3. 学习用户的工作模式（频率统计触发主动建议）────────────────────
    const msg = userMessage.toLowerCase()
    const TASK_PATTERNS = [
      { re: /创建|新建|建立|generate|create/,      label: 'file_creation' },
      { re: /搜索|查找|搜一下|search|find/,         label: 'web_search' },
      { re: /修复|fix|debug|调试|出错|报错/,        label: 'debugging' },
      { re: /优化|重构|refactor|improve|optimize/,  label: 'optimization' },
      { re: /解释|说明|是什么|what is|explain/,     label: 'explanation' },
    ]
    for (const tp of TASK_PATTERNS) {
      if (tp.re.test(msg)) {
        this.memory.recordPattern(tp.label)
      }
    }

    // ── 4. 提炼定义类知识（"X 是 Y" 结构）────────────────────────────────
    const defMatch = resp.match(/^([A-Za-z\u4e00-\u9fa5]{2,20})\s*(?:是|指|means|refers to|is)\s*(.{20,150})[。.]/m)
    if (defMatch && !this.memory.data.facts.find(f => f.content.startsWith(`[定义] ${defMatch[1]}`))) {
      this.memory.addFact(
        `[定义] ${defMatch[1]} — ${defMatch[2].trim()}`,
        'auto_learn_def'
      )
    }
  }
}

// ─── 导出单例 ───────────────────────────────────────────────────────────────
const emotion     = new EmotionSystem()
const memory      = new LongTermMemory()
const nociception = new NociceptionMemory()
const ace         = new AdaptiveContextEngine(emotion, memory, nociception)

module.exports = {
  ace,
  emotion,
  memory,
  nociception,

  // 便捷方法
  buildEnhancedPrompt:     (basePrompt, userMsg)            => ace.buildEnhancedPrompt(basePrompt, userMsg),
  extractMemory:           (userMsg, aiResp)                => ace.extractMemory(userMsg, aiResp),
  learnFromConversation:   (userMsg, aiResp, ctx)           => ace.learnFromConversation(userMsg, aiResp, ctx),
  updateEmotion:           (event)                          => emotion.update(event),
  addFact:                 (content)                        => memory.addFact(content),

  // 获取完整状态（用于 Admin 面板）
  getStatus: () => ({
    emotion:     emotion.get(),
    mode:        ace.detectMode(),
    memoryFacts: memory.data.facts.length,
    nociCount:   nociception.memories.length,
    patterns:    memory.data.patterns.filter(p => p.count >= 2).length,
    dataDir:     DATA_DIR,
  }),
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t }
