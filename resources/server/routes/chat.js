/**
 * /api/chat - 流式对话核心路由
 * QClaw v2.1.0 - ACE 自适应上下文 + 记忆系统 + 情绪状态 + Tool Guard + Token 追踪
 *             + 技能 Prompt 注入 + 知识库 RAG + 会话标题生成
 *             + oMLX ContinuousBatch 调度器 + 推测解码 Hint
 *             + Plugin Pipeline（AstrBot 风格钩子：onLLMRequest/onLLMResponse/onSystemPrompt）
 */

const express = require('express')
const router  = express.Router()
const registry      = require('../providers/registry')
const contextEngine = require('../services/context-engine')
const enginePool    = require('../services/engine-pool')
const memoryEngine      = require('../services/memory-engine')
const toolGuard         = require('../services/tool-guard')
const commandProcessor  = require('../services/command-processor')
const optimizer         = require('../services/auto-optimizer')
const { scheduler: omlxScheduler, buildSpeculativeHint, Priority } = require('../services/omlx-scheduler')
const { sseWrite, startHeartbeat, withRetry, classifyError } = require('../utils/stream-utils')
// Plugin Pipeline（v2.1.0 新增：AstrBot 风格钩子）
let pluginEngine = null
try {
  pluginEngine = require('../services/plugin-engine')
} catch(e) { console.warn('[Chat] 插件引擎加载失败（降级运行）:', e.message) }

// 知识库 RAG（直接调用，避免 self-HTTP）
let searchKnowledge = null
try {
  searchKnowledge = require('./knowledge').searchKnowledge
} catch { /* 模块加载失败时降级 */ }

// ── Token 使用量追踪（进程内累计）────────────────────────────────────────────
const tokenStats = {
  totalIn:  0,
  totalOut: 0,
  requests: 0,
  errors:   0,
  sessions: new Map(), // sessionId → { in, out, count }
}

function trackTokens(sessionId, tokIn, tokOut, isError = false) {
  tokenStats.totalIn  += tokIn
  tokenStats.totalOut += tokOut
  tokenStats.requests += 1
  if (isError) tokenStats.errors++
  if (sessionId) {
    const s = tokenStats.sessions.get(sessionId) || { in: 0, out: 0, count: 0 }
    s.in += tokIn; s.out += tokOut; s.count++
    tokenStats.sessions.set(sessionId, s)
  }
}

// ── 请求计时中间件 ────────────────────────────────────────────────────────────
router.use((req, _res, next) => { req._startTs = Date.now(); next() })

// ── POST /api/chat/stream ────────────────────────────────────────────────────
router.post('/stream', async (req, res) => {
  const {
    messages      = [],
    provider,
    config        = {},
    systemPrompt  = '',
    temperature,
    maxTokens,
    sessionId,
    fastMode: clientFastMode,
    // ── 新增：技能 + 知识库 RAG ────────────────────────────────
    activeSkill  = null,     // { id, name, prompt } 激活的技能
    activeKBIds  = [],       // 激活的知识库 ID 列表
    customKBs    = [],       // 自定义知识库内容
  } = req.body

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages 必须是数组' })
  }

  // ── 命令拦截（openclaw /cmd 系统）────────────────────────────────
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
  if (lastUserMsg.startsWith('/')) {
    const cmdResult = await commandProcessor.processCommand(lastUserMsg, sessionId)
    if (cmdResult) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.write(`data: ${JSON.stringify({ type: 'command_result', ...cmdResult })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
  }

  // ── SSE 头 ────────────────────────────────────────────────────
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  // 心跳保活（防 Nginx/CDN 60s 超时）
  const heartbeat = startHeartbeat(res)

  // 客户端断开时立即停止心跳
  req.on('close', () => heartbeat.stop())

  let slot      = null
  let retryCount = 0

  try {
    // ── 1. 解析 Provider ─────────────────────────────────────
    const targetProvider = provider || registry.activeProvider
    const p = registry.get(targetProvider)
    if (!p) {
      sseWrite(res, { error: `未知 Provider: ${targetProvider}`, fatal: true })
      return res.write('data: [DONE]\n\n'), res.end()
    }

    // ── 2. 动态更新配置 ───────────────────────────────────────
    if (config.apiKey  !== undefined) p.config.apiKey        = config.apiKey
    if (config.baseUrl !== undefined) p.config.baseUrl       = config.baseUrl
    if (config.model   !== undefined) p.config.currentModel  = config.model
    if (p._client !== undefined && (config.apiKey || config.baseUrl)) p._client = null

    // ── 3. 确定 fastMode ──────────────────────────────────────
    const fastMode = clientFastMode ||
      (sessionId ? registry.getSessionFastMode(sessionId) : false)

    // ── 4. 构建增强 System Prompt（五层叠加，顺序严格固定）────────────────
    //
    // 正确顺序（优先级从高到低）：
    //   1. 角色基础（systemPrompt 用户自定义）
    //   2. 技能覆盖（activeSkill.prompt，追加不覆盖，确保角色先生效）
    //   3. Plugin Pipeline onSystemPrompt（AstrBot 风格：插件注入 system prompt）
    //   4. 知识库 RAG（相关内容注入）
    //   5. 回复质量引导（ClarityGuide，注入清晰/简洁回复规则，v3.0 新增）
    //   6. ACE 引擎（情绪/记忆/时区动态增强）
    //
    // 之前的 bug：技能 prompt 被 prepend 到 systemPrompt 前，导致技能描述把
    // 角色定义"压"在后面，模型优先执行技能规则，忽略用户指令。
    //
    let basePrompt = systemPrompt || ''

    // 层1：技能 Prompt（追加在角色定义后，作为"专项能力"扩展，不覆盖角色）
    if (activeSkill?.prompt) {
      basePrompt = `${basePrompt}\n\n---\n## 当前激活技能：${activeSkill.name}\n${activeSkill.prompt}`
      console.log(`[Chat] 注入技能: ${activeSkill.name}`)
    }

    // 层1.5：Plugin Pipeline — onSystemPrompt（AstrBot 风格：插件追加 System Prompt）
    if (pluginEngine) {
      try {
        const pluginAppend = await pluginEngine.getSystemPromptInjections()
        if (pluginAppend) {
          basePrompt += `\n\n---\n## 插件增强\n${pluginAppend}`
          console.log(`[Chat] Plugin onSystemPrompt 注入`)
        }
      } catch(e) {
        console.warn('[Chat] Plugin onSystemPrompt 失败（不影响对话）:', e.message)
      }
    }

    // 层2：知识库 RAG 内容（关键字匹配，直接调用，高相关性优先）
    if (activeKBIds?.length > 0 && lastUserMsg && searchKnowledge) {
      try {
        const kbResults = searchKnowledge(lastUserMsg, activeKBIds, customKBs)
        if (kbResults.length > 0) {
          const kbContext = kbResults.map(r => `【${r.source}】\n${r.content}`).join('\n\n')
          basePrompt += `\n\n---\n## 📚 知识库参考（优先依据以下内容回答）\n${kbContext}`
          console.log(`[Chat] 注入知识库: ${kbResults.length} 条，来源: ${kbResults.map(r => r.kbId).join(', ')}`)
        }
      } catch (e) {
        console.warn('[Chat] 知识库注入失败（不影响对话）:', e.message)
      }
    }

    // 层3：执行纪律注入（ExecutionDiscipline v2.0）
    // 目标：强制 AI 基于真实工具结果回答，杜绝虚假完成和凭空编造
    // 只在没有技能激活时注入（技能自带规则时不重复注入）
    if (!activeSkill?.prompt) {
      basePrompt += `\n\n---\n## 执行纪律（最高优先级，绝对遵守）\n` +
        `- 收到需要操作的任务（文件/命令/搜索等），必须先调用工具，严禁在未执行工具的情况下说"已完成"\n` +
        `- 工具返回失败（❌）时，必须分析错误并重新调用工具修复，绝对禁止假装成功继续回答\n` +
        `- 回答内容必须基于工具的真实输出，不得凭想象、记忆或推断描述不存在的结果\n` +
        `- 多步骤任务必须逐步用工具执行，不得"一步到位"地假设中间步骤已完成\n` +
        `- 遇到阻碍时思路：看清错误→调整参数重试→换方式达成→确实不行才告知用户\n` +
        `\n## 回复质量要求\n` +
        `- 直接回答，不重复用户的话，不说废话开场白\n` +
        `- 工具成功后给出简洁确认，失败时给出真实错误和下一步计划\n` +
        `- 代码直接给出，不解释每一行\n` +
        `- 避免客套语如"如有问题请继续提问"、"希望以上对您有帮助"`
    }

    // 层3.5：任务列表工具（todo_write）说明 —— 始终注入
    // 让 AI 在执行多步骤任务时主动维护任务列表，展示在输入框上方
    basePrompt += `\n\n---\n## 任务列表管理工具 todo_write\n` +
      `当你需要执行包含多个步骤的复杂任务时，**主动使用 todo_write 工具**来维护任务列表。\n` +
      `任务列表会实时显示在用户的输入框上方，让用户随时了解进度。\n\n` +
      `### 工具调用格式\n` +
      `\`\`\`\n` +
      `<tool:todo_write>{"merge": false, "todos": [{"id": "1", "status": "in_progress", "content": "任务描述"}, {"id": "2", "status": "pending", "content": "任务描述"}]}</tool:todo_write>\n` +
      `\`\`\`\n\n` +
      `### 状态值\n` +
      `- \`pending\`：待处理（尚未开始）\n` +
      `- \`in_progress\`：进行中（当前正在执行，同一时间只有 1 个任务）\n` +
      `- \`completed\`：已完成（执行成功）\n` +
      `- \`cancelled\`：已取消\n\n` +
      `### merge 参数\n` +
      `- \`merge: false\`：整体替换，第一次设置任务列表时使用\n` +
      `- \`merge: true\`：仅更新传入的任务（按 id 匹配），适合更新单个任务状态\n\n` +
      `### 使用规范\n` +
      `1. 开始执行多步骤任务前：用 \`merge: false\` 一次性创建完整任务列表，所有任务初始为 \`pending\`\n` +
      `2. 开始某个任务时：用 \`merge: true\` 将该任务设为 \`in_progress\`\n` +
      `3. 完成某个任务时：用 \`merge: true\` 将该任务设为 \`completed\`，同时将下一个任务设为 \`in_progress\`\n` +
      `4. 全部完成后：所有任务状态均为 \`completed\`\n\n` +
      `**重要**：todo_write 工具调用在同一消息中与其他内容一起发送即可，不需要单独一条消息。`

    // 层4：ACE 自适应上下文引擎：情绪+记忆+时区增强
    const maxTok  = maxTokens || 8192
    const modelId = config.model || p.currentModel

    const { systemPrompt: enhancedPrompt, explorationHint, mode } =
      memoryEngine.buildEnhancedPrompt(basePrompt, lastUserMsg)

    // 如果有主动探索建议，随元数据发给前端
    if (explorationHint) {
      sseWrite(res, { type: 'exploration_hint', hint: explorationHint })
    }

    // 层5：oMLX 推测解码 Hint（v1.1.0 新增）
    // 根据用户意图注入输出格式暗示，减少模型首 token 探索时间（降低 TTFT）
    const speculativeHint = buildSpeculativeHint(lastUserMsg)
    const finalPrompt = speculativeHint
      ? enhancedPrompt + speculativeHint
      : enhancedPrompt

    // ── 5. Plugin Pipeline — onLLMRequest（AstrBot 风格：发送前处理消息）───────
    // 插件可以：压缩上下文、过滤消息、追加系统消息等
    let pipelineMsgs = messages.map(m => ({ role: m.role, content: m.content }))
    if (pluginEngine) {
      try {
        pipelineMsgs = await pluginEngine.processLLMRequest(pipelineMsgs, { sessionId, lastUserMsg })
        if (pipelineMsgs._compressed) {
          console.log('[Chat] Plugin onLLMRequest: 上下文已压缩')
        }
      } catch(e) {
        console.warn('[Chat] Plugin onLLMRequest 失败（不影响对话）:', e.message)
      }
    }

    // ── 6. ContextEngine v3.0：三层缓存 + 滑动摘要 build ────────────────
    const { messages: compressedMessages, meta } = await contextEngine.buildWithCache(
      finalPrompt,
      pipelineMsgs,
      {
        maxTokens:  maxTok,
        fastMode,
        sessionId,
        providerId: targetProvider,
        modelId,
      }
    )

    slot = meta.slot

    // 向前端发送缓存命中元数据
    sseWrite(res, {
      type: 'meta',
      cacheHit:         meta.cacheHit,
      prefixHit:        meta.prefixHit,
      originalTokens:   meta.originalTokens,
      compressedTokens: meta.compressedTokens,
      saved:            meta.saved,
      scheduled:        true,   // 标记已经过 oMLX 调度器
    })

    // ── 6. 流式输出（oMLX 调度器包裹 + 自动重试）──────────────
    const opts = {
      model:       modelId,
      temperature: temperature ?? 0.7,
      max_tokens:  maxTok,
      fastMode,
    }

    let outputChars = 0
    let outputText  = ''   // 收集完整 AI 输出（用于记忆提取）
    let firstChunk  = true

    // oMLX ContinuousBatch 调度器：按优先级排队执行
    // fastMode → Priority.HIGH，普通 → Priority.NORMAL
    await omlxScheduler.submit({
      sessionId,
      providerId:  targetProvider,
      modelId,
      fastMode,
      tokenBudget: meta.compressedTokens || maxTok,
      execute: async () => {
        await withRetry(
          async (attempt) => {
            if (attempt > 0) {
              retryCount = attempt
              sseWrite(res, { type: 'retry', attempt, message: `连接重试中（第 ${attempt} 次）...` })
            }

            await p.streamChat(compressedMessages, (chunk) => {
              outputChars += (chunk || '').length
              outputText  += (chunk || '')
              if (firstChunk) {
                firstChunk = false
                sseWrite(res, { type: 'ttft', ts: Date.now() })
              }
              sseWrite(res, { content: chunk })
            }, opts)
          },
          {
            maxRetries: 2,
            baseDelay: 1000,
            onRetry: (attempt, delay, err) => {
              console.warn(`[chat/stream] retry #${attempt} in ${delay}ms:`, err.message)
            },
          }
        )
      },
    })

    // 请求成功，更新 EnginePool 计量 + Token 追踪 + 情绪正向
    const tokOut = Math.ceil(outputChars / 2.5)
    if (slot) {
      enginePool.release(slot, {
        tokensIn:  meta.compressedTokens,
        tokensOut: tokOut,
      })
      slot = null
    }
    trackTokens(sessionId, meta.compressedTokens, tokOut)
    memoryEngine.updateEmotion('success')
    // 上报响应时间给优化引擎
    optimizer.recordSuccess(Date.now() - (req._startTs || Date.now()))

    // Plugin Pipeline — onLLMResponse（AstrBot 风格：响应后处理）
    // 插件可以修改最终回复内容（如翻译、Emoji 增强等）
    if (pluginEngine && outputText) {
      try {
        const processed = await pluginEngine.processLLMResponse(outputText, { sessionId, lastUserMsg })
        // 如果有插件修改了内容，发送差量通知（不重写整个流，只通知前端）
        if (processed !== outputText) {
          sseWrite(res, { type: 'plugin_response_patch', content: processed })
          outputText = processed
        }
      } catch(e) {
        console.warn('[Chat] Plugin onLLMResponse 失败（不影响对话）:', e.message)
      }
    }

    // 从对话中提取记忆（异步，不阻塞响应）
    setImmediate(() => {
      memoryEngine.extractMemory(lastUserMsg, outputText)
      // 自我学习：自动提炼有价值的知识点到长期记忆
      memoryEngine.learnFromConversation(lastUserMsg, outputText, { sessionId })
    })


    if (retryCount > 0) {
      sseWrite(res, { type: 'info', message: `已在第 ${retryCount} 次重试后成功` })
    }

  } catch (err) {
    console.error('[chat/stream]', err.message)

    // 错误分级：致命错误给出明确提示
    const errClass = classifyError(err)
    const userMsg  = errClass === 'FATAL'
      ? `配置错误：${err.message}（请检查 API Key 和模型设置）`
      : `请求失败：${err.message}`

    sseWrite(res, {
      error: userMsg,
      fatal: errClass === 'FATAL',
      retried: retryCount,
    })

    // 错误 → 情绪负向 + Token 追踪 + 上报给优化引擎
    memoryEngine.updateEmotion('error')
    trackTokens(sessionId, 0, 0, true)
    optimizer.recordError(err.message)

    if (slot) {
      enginePool.release(slot, { error: true })
      slot = null
    }
  } finally {
    heartbeat.stop()
    res.write('data: [DONE]\n\n')
    res.end()
  }
})

// ── POST /api/chat/fast ───────────────────────────────────────────────────────
router.post('/fast', (req, res) => {
  const { sessionId, enabled } = req.body
  if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' })
  registry.setSessionFastMode(sessionId, !!enabled)
  res.json({ ok: true, sessionId, fastMode: !!enabled })
})

// ── POST /api/chat/title — 自动生成会话标题 ──────────────────────────────────
router.post('/title', async (req, res) => {
  const { text, provider, config = {} } = req.body
  if (!text) return res.json({ title: '新对话' })
  try {
    const targetProvider = provider || registry.activeProvider
    const p = registry.get(targetProvider)
    if (!p) return res.json({ title: text.slice(0, 20) })

    if (config.apiKey  !== undefined) p.config.apiKey       = config.apiKey
    if (config.baseUrl !== undefined) p.config.baseUrl      = config.baseUrl
    if (config.model   !== undefined) p.config.currentModel = config.model

    let title = ''
    await p.streamChat(
      [{ role: 'user', content: `请用10个字以内总结这条消息的主题，只输出标题本身，不加任何解释和标点：\n${text.slice(0, 200)}` }],
      c => { title += c },
      { model: config.model, temperature: 0.3, max_tokens: 30, fastMode: true }
    )
    res.json({ title: title.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 30) || text.slice(0, 20) })
  } catch {
    res.json({ title: text.slice(0, 20) })
  }
})

// ── POST /api/chat/context-stats ─────────────────────────────────────────────
router.post('/context-stats', (req, res) => {
  const { messages = [], systemPrompt = '', maxTokens = 8192, fastMode = false } = req.body
  const compressed       = contextEngine.build(systemPrompt, messages, { maxTokens, fastMode })
  const originalTokens   = contextEngine.estimateMessagesTokens(messages)
  const compressedTokens = contextEngine.estimateMessagesTokens(compressed)
  res.json({
    original:   { count: messages.length,    tokens: originalTokens },
    compressed: { count: compressed.length,  tokens: compressedTokens },
    saved:      originalTokens - compressedTokens,
  })
})

// ── GET /api/chat/cache-stats ─────────────────────────────────────────────────
router.get('/cache-stats', async (req, res) => {
  try {
    const stats = await contextEngine.getCacheStats()
    res.json(stats)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/chat/cache/:sessionId ────────────────────────────────────────
router.delete('/cache/:sessionId', async (req, res) => {
  try {
    await contextEngine.invalidateSession(req.params.sessionId)
    res.json({ ok: true, sessionId: req.params.sessionId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/chat/engine-pool ─────────────────────────────────────────────────
router.get('/engine-pool', (req, res) => {
  res.json(enginePool.getSummary())
})

// ── GET /api/chat/token-stats ─────────────────────────────────────────────────
router.get('/token-stats', (req, res) => {
  res.json({
    totalIn:      tokenStats.totalIn,
    totalOut:     tokenStats.totalOut,
    total:        tokenStats.totalIn + tokenStats.totalOut,
    requests:     tokenStats.requests,
    errors:       tokenStats.errors,
    sessionCount: tokenStats.sessions.size,
  })
})

// ── GET /api/chat/memory-status ───────────────────────────────────────────────
router.get('/memory-status', (req, res) => {
  res.json(memoryEngine.getStatus())
})

// ── POST /api/chat/memory/fact ────────────────────────────────────────────────
router.post('/memory/fact', (req, res) => {
  const { content } = req.body
  if (!content) return res.status(400).json({ error: '缺少 content' })
  memoryEngine.addFact(content, 'manual')
  res.json({ ok: true })
})

// ── DELETE /api/chat/memory ───────────────────────────────────────────────────
router.delete('/memory', (req, res) => {
  try {
    const m = memoryEngine.memory
    m.data.facts = []
    m.data.patterns = []
    m.save()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/chat/command ────────────────────────────────────────────────────
router.post('/command', async (req, res) => {
  const { text, sessionId } = req.body
  if (!text) return res.status(400).json({ error: '缺少 text' })
  try {
    const result = await commandProcessor.processCommand(text, sessionId)
    if (!result) return res.status(400).json({ error: '不是有效命令' })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/chat/session-config/:sessionId ───────────────────────────────────
router.get('/session-config/:sessionId', (req, res) => {
  const cfg = commandProcessor.getSessionConfig(req.params.sessionId)
  res.json(cfg)
})

module.exports = router
