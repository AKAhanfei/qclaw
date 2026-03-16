/**
 * QClaw Command Processor — openclaw 命令系统
 * 支持 /status /reset /think /verbose /new /session /help /clear /export
 */

const memoryEngine = require('./memory-engine')
const enginePool   = require('./engine-pool')

// ── 思考级别全局设置 ──────────────────────────────────────────────────────────
const thinkLevels = { low: 2048, medium: 4096, high: 8192, max: 32768 }
const sessionConfig = new Map() // sessionId → { verbose, thinkLevel, sandbox }

function getSessionConfig(sessionId) {
  if (!sessionId) return { verbose: false, thinkLevel: 'medium', sandbox: false }
  if (!sessionConfig.has(sessionId)) {
    sessionConfig.set(sessionId, { verbose: false, thinkLevel: 'medium', sandbox: false })
  }
  return sessionConfig.get(sessionId)
}

// ── 解析命令 ──────────────────────────────────────────────────────────────────
function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null
  const parts = text.trim().split(/\s+/)
  return { cmd: parts[0].toLowerCase(), args: parts.slice(1) }
}

// ── 执行命令 ──────────────────────────────────────────────────────────────────
async function processCommand(text, sessionId, extra = {}) {
  const parsed = parseCommand(text)
  if (!parsed) return null

  const cfg = getSessionConfig(sessionId)
  const { cmd, args } = parsed

  switch (cmd) {
    // ── /help ────────────────────────────────────────────────────────────────
    case '/help': {
      return {
        type:    'command_result',
        command: '/help',
        content: `**QClaw 命令系统** (openclaw-compatible)

| 命令 | 说明 |
|------|------|
| \`/new\` | 新建对话会话 |
| \`/reset\` | 重置当前会话（清空上下文）|
| \`/clear\` | 清空当前对话消息 |
| \`/status\` | 查看当前会话状态 |
| \`/think <level>\` | 设置思考深度 low/medium/high/max |
| \`/verbose on/off\` | 切换详细模式（显示工具调用） |
| \`/agent on/off\` | 切换 Agent 模式（自动执行工具）|
| \`/tools\` | 列出所有可用工具 |
| \`/date\` | 显示当前时间和时区 |
| \`/memory\` | 查看记忆系统状态 |
| \`/sandbox on/off\` | 切换沙箱模式 |
| \`/export md/json\` | 导出当前对话 |
| \`/help\` | 显示此帮助 |

> 💡 **提示**：在输入框输入 \`/\` 后继续输入触发技能选择器`,
      }
    }

    // ── /status ──────────────────────────────────────────────────────────────
    case '/status': {
      let status
      try {
        status = memoryEngine.getStatus()
      } catch { status = {} }

      let pool
      try {
        pool = enginePool.getSummary()
      } catch { pool = {} }

      const sessionCount = sessionConfig.size

      return {
        type:    'command_result',
        command: '/status',
        content: `**会话状态** \`${sessionId || 'no-session'}\`

- **思考级别**: ${cfg.thinkLevel} (最大 ${thinkLevels[cfg.thinkLevel] || 4096} tokens)
- **详细模式**: ${cfg.verbose ? '开启' : '关闭'}
- **沙箱模式**: ${cfg.sandbox ? '开启' : '关闭'}
- **活跃会话数**: ${sessionCount}
- **情绪状态**: ${status.emotion ? JSON.stringify(status.emotion) : '未知'}
- **记忆条目**: ${status.factCount ?? '—'}
- **EnginePool**: ${pool.totalEngines ?? '—'} 个引擎`,
        data: { sessionId, cfg, status, pool },
      }
    }

    // ── /new ─────────────────────────────────────────────────────────────────
    case '/new': {
      return {
        type:    'command_result',
        command: '/new',
        action:  'new_session',
        content: '✓ 已创建新对话，开始新的旅程吧！',
      }
    }

    // ── /reset ───────────────────────────────────────────────────────────────
    case '/reset': {
      return {
        type:    'command_result',
        command: '/reset',
        action:  'reset_session',
        content: '✓ 会话已重置，上下文已清空。',
      }
    }

    // ── /clear ───────────────────────────────────────────────────────────────
    case '/clear': {
      return {
        type:    'command_result',
        command: '/clear',
        action:  'clear_messages',
        content: '✓ 已清空当前对话消息。',
      }
    }

    // ── /think <level> ───────────────────────────────────────────────────────
    case '/think': {
      const level = args[0]?.toLowerCase()
      if (!thinkLevels[level]) {
        return {
          type:    'command_result',
          command: '/think',
          content: `无效思考级别。可选: \`low\` (2k) / \`medium\` (4k) / \`high\` (8k) / \`max\` (32k)\n当前: **${cfg.thinkLevel}**`,
        }
      }
      cfg.thinkLevel = level
      return {
        type:    'command_result',
        command: '/think',
        action:  'set_think',
        value:   thinkLevels[level],
        content: `✓ 思考深度已设置为 **${level}** (${thinkLevels[level]} tokens)`,
      }
    }

    // ── /verbose ─────────────────────────────────────────────────────────────
    case '/verbose': {
      const val = args[0]?.toLowerCase()
      if (val === 'on')  cfg.verbose = true
      else if (val === 'off') cfg.verbose = false
      else cfg.verbose = !cfg.verbose

      return {
        type:    'command_result',
        command: '/verbose',
        action:  'set_verbose',
        value:   cfg.verbose,
        content: `✓ 详细模式已${cfg.verbose ? '**开启**' : '**关闭**'}`,
      }
    }

    // ── /sandbox ─────────────────────────────────────────────────────────────
    case '/sandbox': {
      const val = args[0]?.toLowerCase()
      if (val === 'on')  cfg.sandbox = true
      else if (val === 'off') cfg.sandbox = false
      else cfg.sandbox = !cfg.sandbox

      return {
        type:    'command_result',
        command: '/sandbox',
        action:  'set_sandbox',
        value:   cfg.sandbox,
        content: `✓ 沙箱模式已${cfg.sandbox ? '**开启**（工具调用将受限）' : '**关闭**（完整主机权限）'}`,
      }
    }

    // ── /memory ──────────────────────────────────────────────────────────────
    case '/memory': {
      try {
        const ms = memoryEngine.getStatus()
        return {
          type:    'command_result',
          command: '/memory',
          content: `**记忆系统状态**

- **长期记忆条目**: ${ms.factCount ?? 0}
- **行为模式**: ${ms.patternCount ?? 0}
- **情绪状态**: 警觉=${(ms.emotion?.arousal ?? 0).toFixed(2)}, 效价=${(ms.emotion?.valence ?? 0).toFixed(2)}, 好奇=${(ms.emotion?.curiosity ?? 0).toFixed(2)}
- **探索建议**: ${ms.explorationHint || '暂无'}`,
          data: ms,
        }
      } catch {
        return { type: 'command_result', command: '/memory', content: '记忆引擎未初始化' }
      }
    }

    // ── /agent ────────────────────────────────────────────────────────────────
    case '/agent': {
      const val = args[0]?.toLowerCase()
      if (val === 'on')  cfg.agentMode = true
      else if (val === 'off') cfg.agentMode = false
      else cfg.agentMode = !cfg.agentMode

      return {
        type:    'command_result',
        command: '/agent',
        action:  'set_agent',
        value:   cfg.agentMode,
        content: `✓ Agent 模式已${cfg.agentMode ? '**开启**（AI 将自动执行工具调用）' : '**关闭**（仅对话，不执行工具）'}`,
      }
    }

    // ── /tools ────────────────────────────────────────────────────────────────
    case '/tools': {
      return {
        type:    'command_result',
        command: '/tools',
        content: `**可用工具列表**

**📁 文件系统（Electron IPC）**
- \`<tool:fs_read>\` 读取文件
- \`<tool:fs_write>\` 写入文件（第一行路径，其余内容）
- \`<tool:fs_list>\` 列出目录
- \`<tool:fs_mkdir>\` 创建目录
- \`<tool:fs_delete>\` 删除文件/目录
- \`<tool:desktop_mkdir>\` 在桌面创建文件夹

**🖥️ 系统（Electron IPC）**
- \`<tool:shell>\` 执行任意命令（第二行可指定 cwd）
- \`<tool:open>\` 打开文件或网址

**🌐 网络（多引擎回退，无需 API Key）**
- \`<tool:websearch>\` 网页搜索（Bing/DDG 多引擎回退）
- \`<tool:fetch_url>\` 读取网页内容

**⚙️ 计算 & 系统**
- \`<tool:js_exec>\` JavaScript 沙箱执行
- \`<tool:sysinfo>\` 系统信息查询
- \`<tool:kb_search>\` 知识库 RAG 检索`,
      }
    }

    // ── /date ─────────────────────────────────────────────────────────────────
    case '/date': {
      const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone
      const now = new Date()
      return {
        type:    'command_result',
        command: '/date',
        content: `**当前时间**\n- 本地：${now.toLocaleString('zh-CN')}\n- UTC：${now.toUTCString()}\n- 时区：${tz}`,
      }
    }

    // ── /export ──────────────────────────────────────────────────────────────
    case '/export': {
      const fmt = args[0]?.toLowerCase() || 'md'
      return {
        type:    'command_result',
        command: '/export',
        action:  'export_session',
        value:   fmt,
        content: `✓ 正在导出当前对话（格式: ${fmt === 'json' ? 'JSON' : 'Markdown'}）...`,
      }
    }

    // ── 未知命令 ──────────────────────────────────────────────────────────────
    default: {
      return {
        type:    'command_result',
        command: cmd,
        content: `未知命令 \`${cmd}\`，输入 \`/help\` 查看可用命令。`,
      }
    }
  }
}

module.exports = {
  parseCommand,
  processCommand,
  getSessionConfig,
  thinkLevels,
}
