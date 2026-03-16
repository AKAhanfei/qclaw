/**
 * QClaw Tool Guard - Inspired by CoPaw Security Layer
 * 工具防护安全层：五层防护机制
 *
 * 防护级别：
 *   SAFE    - 直接执行
 *   WARN    - 提示用户并等待确认（5s 超时自动拒绝）
 *   DANGER  - 需要明确批准
 *   BLOCK   - 直接拒绝，记录日志
 */

const SECURITY_LEVELS = {
  SAFE:   'safe',
  WARN:   'warn',
  DANGER: 'danger',
  BLOCK:  'block',
}

// ── 命令白名单（SAFE，无需确认）──────────────────────────────────────────────
const SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'echo', 'cat', 'type',
  'git status', 'git log', 'git diff', 'git branch',
  'npm test', 'npm run test', 'yarn test',
  'node --version', 'npm --version', 'python --version',
  'whoami', 'hostname', 'date',
])

// ── 危险命令模式（BLOCK，直接拒绝）──────────────────────────────────────────
const BLOCK_PATTERNS = [
  { re: /rm\s+-rf?\s+\//, reason: '禁止删除根目录' },
  { re: /format\s+[a-z]:/i, reason: '禁止格式化磁盘' },
  { re: /del\s+\/[fs]/i, reason: '禁止强制删除系统文件' },
  { re: /shutdown|reboot|halt/i, reason: '禁止关机/重启命令' },
  { re: /chmod\s+777/, reason: '禁止 chmod 777（权限过高）' },
  { re: /curl.*\|\s*(?:sh|bash)/, reason: '禁止远程脚本执行（curl | sh）' },
  { re: /wget.*\|\s*(?:sh|bash)/, reason: '禁止远程脚本执行（wget | sh）' },
  { re: /DROP\s+(?:TABLE|DATABASE)/i, reason: '禁止 DROP TABLE/DATABASE' },
  { re: /TRUNCATE\s+TABLE/i, reason: '禁止 TRUNCATE TABLE' },
  { re: />\s*\/etc\//i, reason: '禁止写入 /etc/ 系统目录' },
  { re: />\s*\/sys\//i, reason: '禁止写入 /sys/ 目录' },
  { re: /eval\s*\(/,  reason: '禁止 eval() 动态执行' },
  { re: /exec\s*\(/,  reason: '禁止 exec() 系统调用' },
  { re: /\.\.\/\.\.\//, reason: '禁止路径穿越攻击（../..）' },
]

// ── 高风险模式（DANGER，需要明确批准）───────────────────────────────────────
const DANGER_PATTERNS = [
  { re: /rm\s+-rf?/,               reason: '删除文件/目录（递归）' },
  { re: /git\s+push\s+.*--force/,  reason: 'Git 强制推送' },
  { re: /git\s+reset\s+--hard/,    reason: 'Git 强制重置' },
  { re: /npm\s+publish/,           reason: 'NPM 包发布' },
  { re: /kubectl\s+delete/,        reason: 'Kubernetes 删除资源' },
  { re: /docker\s+rm|docker\s+rmi/, reason: '删除 Docker 容器/镜像' },
  { re: /DROP\s+(?:INDEX|VIEW)/i,  reason: '删除数据库索引/视图' },
]

// ── 警告模式（WARN，提示用户）────────────────────────────────────────────────
const WARN_PATTERNS = [
  { re: /git\s+commit/,  reason: 'Git 提交操作' },
  { re: /git\s+merge/,   reason: 'Git 合并操作' },
  { re: /npm\s+install/, reason: 'NPM 安装包' },
  { re: /pip\s+install/, reason: 'Python 包安装' },
  { re: /mkdir\s+-p/,    reason: '创建目录' },
  { re: /mv\s+/,         reason: '移动/重命名文件' },
  { re: /cp\s+-r/,       reason: '递归复制文件' },
]

// ── 敏感路径保护 ─────────────────────────────────────────────────────────────
const SENSITIVE_DIRS = [
  '/etc', '/sys', '/proc', '/boot', '/dev',
  'C:\\Windows', 'C:\\System32', 'C:\\Program Files',
  '.ssh', '.gnupg', '.aws', '.env',
]

// ── Shell 注入检测 ────────────────────────────────────────────────────────────
const SHELL_INJECTION_PATTERNS = [
  /[;&|`$].*[;&|`$]/,     // 多命令链接
  /\$\(.*\)/,              // 命令替换
  /`[^`]+`/,               // 反引号执行
  /\|\||\s&&\s/,           // 条件链
]

/**
 * 分析工具调用请求的安全级别
 * @param {string} toolType  - 工具类型：'command'|'file'|'code'|'web'
 * @param {object} params    - 工具参数
 * @returns {{ level, reason, allowed }}
 */
function analyze(toolType, params = {}) {
  const input = JSON.stringify(params).toLowerCase()
  const command = params.command || params.code || params.path || ''

  // ── 1. Shell 注入检测 ──────────────────────────────────────
  for (const re of SHELL_INJECTION_PATTERNS) {
    if (re.test(command)) {
      return {
        level:   SECURITY_LEVELS.BLOCK,
        reason:  'Shell 注入攻击检测',
        allowed: false,
        details: `命令中包含可疑的 Shell 注入模式：${command.slice(0, 80)}`,
      }
    }
  }

  // ── 2. 敏感目录保护 ────────────────────────────────────────
  for (const dir of SENSITIVE_DIRS) {
    if (input.includes(dir.toLowerCase())) {
      return {
        level:   SECURITY_LEVELS.BLOCK,
        reason:  `敏感目录保护：${dir}`,
        allowed: false,
        details: `禁止访问敏感系统目录 ${dir}`,
      }
    }
  }

  // ── 3. BLOCK 模式 ──────────────────────────────────────────
  for (const { re, reason } of BLOCK_PATTERNS) {
    if (re.test(command)) {
      return {
        level:   SECURITY_LEVELS.BLOCK,
        reason,
        allowed: false,
        details: `高风险命令被阻止：${reason}`,
      }
    }
  }

  // ── 4. DANGER 模式 ─────────────────────────────────────────
  for (const { re, reason } of DANGER_PATTERNS) {
    if (re.test(command)) {
      return {
        level:   SECURITY_LEVELS.DANGER,
        reason,
        allowed: false, // 需要明确批准
        details: `危险操作需要用户确认：${reason}`,
        requireApproval: true,
      }
    }
  }

  // ── 5. WARN 模式 ───────────────────────────────────────────
  for (const { re, reason } of WARN_PATTERNS) {
    if (re.test(command)) {
      return {
        level:   SECURITY_LEVELS.WARN,
        reason,
        allowed: true,  // 默认允许，但给出警告
        details: `建议注意：${reason}`,
        showWarning: true,
      }
    }
  }

  // ── 6. 白名单检测 ──────────────────────────────────────────
  const cmdNorm = command.trim().toLowerCase()
  for (const safe of SAFE_COMMANDS) {
    if (cmdNorm === safe || cmdNorm.startsWith(safe + ' ')) {
      return { level: SECURITY_LEVELS.SAFE, reason: '白名单命令', allowed: true }
    }
  }

  // ── 默认：允许，无特殊风险 ────────────────────────────────
  return {
    level:   SECURITY_LEVELS.SAFE,
    reason:  '未检测到明显风险',
    allowed: true,
  }
}

/**
 * 扫描 AI 生成的消息中是否包含潜在的危险工具调用
 * @param {string} aiResponse
 * @returns {{ hasDanger: boolean, warnings: string[] }}
 */
function scanResponse(aiResponse) {
  const warnings = []

  // 检测代码块中的危险命令
  const codeBlocks = aiResponse.match(/```(?:bash|sh|cmd|powershell)?\n?([\s\S]*?)```/g) || []
  for (const block of codeBlocks) {
    const code = block.replace(/```[a-z]*\n?/, '').replace(/```$/, '').trim()
    const result = analyze('command', { command: code })
    if (result.level === SECURITY_LEVELS.BLOCK || result.level === SECURITY_LEVELS.DANGER) {
      warnings.push(`[工具防护] ${result.details || result.reason}`)
    }
  }

  return { hasDanger: warnings.length > 0, warnings }
}

// ── 审计日志 ─────────────────────────────────────────────────────────────────
const auditLog = []

function logAudit(toolType, params, result) {
  const entry = {
    ts:       Date.now(),
    toolType,
    command:  (params.command || params.path || '').slice(0, 100),
    level:    result.level,
    allowed:  result.allowed,
    reason:   result.reason,
  }
  auditLog.push(entry)
  if (auditLog.length > 200) auditLog.shift()

  if (!result.allowed) {
    console.warn(`[ToolGuard] BLOCKED ${toolType}: ${entry.command} (${result.reason})`)
  }
}

function getAuditLog(limit = 50) {
  return auditLog.slice(-limit)
}

module.exports = {
  analyze,
  scanResponse,
  logAudit,
  getAuditLog,
  SECURITY_LEVELS,
}
