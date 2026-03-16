/**
 * QClaw Self-Evolution Engine v1.0
 * 自我进化引擎 — AI 集合体的核心生命力
 *
 * 能力：
 *   1. 自我扫描    - 分析自身所有 JS 文件，发现潜在问题、性能瓶颈、缺失功能
 *   2. 能力学习    - 从互联网获取最新技术趋势，生成改进计划
 *   3. 安全热替换  - 备份 → 写入 → 语法验证 → 自动回滚（失败保护）
 *   4. 定期进化    - 不定期自动扫描自身，达到阈值时触发升级
 *   5. 版本管理    - 自动递增版本号，维护进化历史
 *   6. AI 驱动补丁 - 调用内置 AI Provider 生成代码改进建议
 *
 * 安全原则（不会误伤自身）：
 *   - 任何文件修改前强制备份
 *   - 语法验证失败立刻回滚
 *   - 仅修改 server/ 目录下的 JS，不触及 Electron 主进程
 *   - 所有操作写入进化日志，可追溯
 *   - 有最大修改行数限制（防止失控）
 */

const fs      = require('fs')
const path    = require('path')
const os      = require('os')
const https   = require('https')
const http    = require('http')
const { execSync, spawn } = require('child_process')

// ── 路径常量 ─────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(os.homedir(), '.qclaw')
const EVO_LOG_FILE  = path.join(DATA_DIR, 'evolution.json')
const EVO_PLAN_FILE = path.join(DATA_DIR, 'evolution-plan.json')
const BACKUP_DIR    = path.join(DATA_DIR, 'evolution-backups')

// Server 根目录（进化引擎只操作这里）
const SERVER_ROOT   = path.join(__dirname, '..')
// 应用根目录（用于读取 config.json）
const APP_ROOT      = path.join(SERVER_ROOT, '..', '..')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// ── 进化日志 ─────────────────────────────────────────────────────────────────
class EvolutionLog {
  constructor() {
    ensureDir(DATA_DIR)
    this.entries = this._load()
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(EVO_LOG_FILE, 'utf8')) } catch { return [] }
  }

  push(type, action, detail, level = 'info') {
    const entry = { ts: Date.now(), iso: new Date().toISOString(), type, action, detail, level }
    this.entries.push(entry)
    console.log(`[SelfEvolution][${level.toUpperCase()}] [${type}] ${action}: ${detail}`)
    this._save()
    return entry
  }

  getLast(n = 100) { return this.entries.slice(-n).reverse() }

  _save() {
    try {
      if (this.entries.length > 500) this.entries = this.entries.slice(-500)
      fs.writeFileSync(EVO_LOG_FILE, JSON.stringify(this.entries, null, 2))
    } catch {}
  }
}

// ── 代码扫描器 ───────────────────────────────────────────────────────────────
class CodeScanner {
  /**
   * 扫描整个 server/ 目录，分析所有 JS 文件
   * 返回：问题列表、统计信息、优化建议
   */
  scanAll() {
    const results = {
      files: [],
      issues: [],
      stats: { totalFiles: 0, totalLines: 0, totalBytes: 0, issues: 0 },
      timestamp: Date.now(),
    }

    const jsFiles = this._findJsFiles(SERVER_ROOT)
    results.stats.totalFiles = jsFiles.length

    for (const filePath of jsFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const lines   = content.split('\n')
        const rel     = path.relative(SERVER_ROOT, filePath)

        results.stats.totalLines += lines.length
        results.stats.totalBytes += Buffer.byteLength(content, 'utf8')

        const fileIssues = this._analyzeFile(filePath, content, lines)
        results.files.push({
          path:   rel,
          lines:  lines.length,
          bytes:  Buffer.byteLength(content, 'utf8'),
          issues: fileIssues.length,
          mtime:  fs.statSync(filePath).mtime.toISOString(),
        })

        for (const issue of fileIssues) {
          results.issues.push({ file: rel, ...issue })
          results.stats.issues++
        }
      } catch {}
    }

    return results
  }

  /**
   * 分析单个文件的问题
   */
  _analyzeFile(filePath, content, lines) {
    const issues = []
    const rel    = path.relative(SERVER_ROOT, filePath)

    // ── 规则1：过大的函数（> 100 行的连续代码块）
    let funcStart = -1
    let braceDepth = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/(?:async\s+)?function\s+\w+|(?:async\s*)?\(\s*\)\s*=>|=>\s*{/.test(line)) {
        if (funcStart === -1) funcStart = i
      }
      braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
      if (funcStart !== -1 && braceDepth <= 0) {
        const len = i - funcStart
        if (len > 100) {
          issues.push({
            type: 'large_function',
            severity: 'warn',
            line: funcStart + 1,
            message: `函数过长 (${len} 行)，建议拆分`,
          })
        }
        funcStart  = -1
        braceDepth = 0
      }
    }

    // ── 规则2：裸 catch（catch 块为空或只有注释）
    const emptyCatches = content.match(/catch\s*\([^)]*\)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/g) || []
    if (emptyCatches.length > 0) {
      issues.push({
        type: 'empty_catch',
        severity: 'warn',
        line: null,
        message: `发现 ${emptyCatches.length} 个空 catch 块，建议至少记录错误日志`,
      })
    }

    // ── 规则3：TODO / FIXME / HACK 标记
    for (let i = 0; i < lines.length; i++) {
      if (/TODO|FIXME|HACK|XXX/.test(lines[i])) {
        issues.push({
          type: 'todo_marker',
          severity: 'info',
          line: i + 1,
          message: `发现待处理标记: ${lines[i].trim().slice(0, 80)}`,
        })
      }
    }

    // ── 规则4：硬编码端口/IP
    for (let i = 0; i < lines.length; i++) {
      if (/(?:localhost|127\.0\.0\.1):\d{4,5}/.test(lines[i]) &&
          !lines[i].trim().startsWith('//') && !lines[i].trim().startsWith('*')) {
        issues.push({
          type: 'hardcoded_url',
          severity: 'info',
          line: i + 1,
          message: `硬编码地址: ${lines[i].trim().slice(0, 80)}（建议用配置常量）`,
        })
      }
    }

    // ── 规则5：未使用 const（简单检测 var 关键字）
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*var\s+/.test(lines[i])) {
        issues.push({
          type: 'var_keyword',
          severity: 'info',
          line: i + 1,
          message: '建议将 var 替换为 const/let',
        })
      }
    }

    // ── 规则6：缺少文件头注释
    if (lines.length > 20 && !content.trim().startsWith('/**') && !content.trim().startsWith('//')) {
      issues.push({
        type: 'missing_header',
        severity: 'info',
        line: 1,
        message: '文件缺少头部注释（建议添加功能说明）',
      })
    }

    // ── 规则7：潜在的内存泄漏（setInterval 未存引用）
    const intervals = content.match(/setInterval\s*\(/g) || []
    const cleared   = content.match(/clearInterval\s*\(/g) || []
    if (intervals.length > 0 && cleared.length === 0 && !filePath.includes('scheduled')) {
      issues.push({
        type: 'potential_memory_leak',
        severity: 'warn',
        line: null,
        message: `${intervals.length} 个 setInterval 未见对应 clearInterval，可能泄漏`,
      })
    }

    return issues
  }

  /**
   * 递归找出所有 .js 文件（排除 node_modules、测试文件、进化引擎自身备份）
   */
  _findJsFiles(dir, results = []) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'public'].includes(entry.name)) {
            this._findJsFiles(full, results)
          }
        } else if (
          entry.name.endsWith('.js') &&
          !entry.name.startsWith('_test') &&
          !entry.name.startsWith('check-')
        ) {
          results.push(full)
        }
      }
    } catch {}
    return results
  }
}

// ── 安全热替换器 ─────────────────────────────────────────────────────────────
class SafePatcher {
  constructor(log) {
    this.log = log
    ensureDir(BACKUP_DIR)
  }

  /**
   * 安全替换文件内容
   * 流程：备份 → 验证新代码语法 → 写入 → 验证成功 → 完成
   *      任何步骤失败 → 回滚
   */
  async patch(filePath, newContent, reason = '') {
    const rel        = path.relative(SERVER_ROOT, filePath)
    const backupName = `${path.basename(filePath)}.${Date.now()}.bak`
    const backupPath = path.join(BACKUP_DIR, backupName)

    if (!filePath.startsWith(SERVER_ROOT)) {
      return { ok: false, error: '安全拒绝：只能修改 server/ 目录内的文件' }
    }

    if (filePath === __filename) {
      return { ok: false, error: '安全拒绝：进化引擎不修改自身' }
    }

    if (!newContent || newContent.trim().length < 10) {
      return { ok: false, error: '安全拒绝：新内容过短，拒绝写入' }
    }

    if (newContent.split('\n').length > 5000) {
      return { ok: false, error: '安全拒绝：内容超过 5000 行限制' }
    }

    try {
      const original = fs.readFileSync(filePath, 'utf8')
      fs.writeFileSync(backupPath, original)
      this.log.push('patch', 'backup_created', `${rel} → ${backupName}`, 'info')

      const syntaxOk = this._validateSyntax(newContent)
      if (!syntaxOk.ok) {
        this.log.push('patch', 'syntax_check_failed', `${rel}: ${syntaxOk.error}`, 'error')
        return { ok: false, error: `语法验证失败: ${syntaxOk.error}`, backupPath }
      }

      fs.writeFileSync(filePath, newContent, 'utf8')

      const written = fs.readFileSync(filePath, 'utf8')
      const verifyOk = this._validateSyntax(written)
      if (!verifyOk.ok) {
        fs.writeFileSync(filePath, original)
        this.log.push('patch', 'rollback', `${rel} 写入后验证失败，已回滚`, 'error')
        return { ok: false, error: '写入后验证失败，已自动回滚', backupPath }
      }

      this.log.push('patch', 'patch_applied', `${rel} 更新成功: ${reason}`, 'fix')
      return { ok: true, backupPath, lines: newContent.split('\n').length }

    } catch (e) {
      try {
        if (fs.existsSync(backupPath)) {
          const original = fs.readFileSync(backupPath, 'utf8')
          fs.writeFileSync(filePath, original)
          this.log.push('patch', 'emergency_rollback', `${rel} 异常回滚: ${e.message}`, 'error')
        }
      } catch {}
      return { ok: false, error: e.message }
    }
  }

  rollback(filePath) {
    const rel     = path.relative(SERVER_ROOT, filePath)
    const base    = path.basename(filePath)
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(base) && f.endsWith('.bak'))
      .sort()
      .reverse()

    if (!backups.length) return { ok: false, error: '没有可用备份' }

    const backupPath = path.join(BACKUP_DIR, backups[0])
    try {
      const content = fs.readFileSync(backupPath, 'utf8')
      fs.writeFileSync(filePath, content)
      this.log.push('patch', 'manual_rollback', `${rel} 已回滚至 ${backups[0]}`, 'fix')
      return { ok: true, backup: backups[0] }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  _validateSyntax(content) {
    try {
      const tmpFile = path.join(os.tmpdir(), `qclaw_syntax_check_${Date.now()}.js`)
      fs.writeFileSync(tmpFile, content)
      try {
        execSync(`node --check "${tmpFile}"`, { timeout: 5000, stdio: 'pipe' })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e.stderr?.toString() || e.message).slice(0, 200) }
      } finally {
        try { fs.unlinkSync(tmpFile) } catch {}
      }
    } catch (e) {
      try {
        new Function(content)
        return { ok: true }
      } catch (e2) {
        return { ok: false, error: e2.message }
      }
    }
  }

  listBackups() {
    try {
      return fs.readdirSync(BACKUP_DIR)
        .map(f => ({
          name: f,
          path: path.join(BACKUP_DIR, f),
          size: fs.statSync(path.join(BACKUP_DIR, f)).size,
          mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.toISOString(),
        }))
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
    } catch { return [] }
  }

  pruneBackups(keep = 50) {
    const backups = this.listBackups()
    if (backups.length <= keep) return 0
    let removed = 0
    for (const b of backups.slice(keep)) {
      try { fs.unlinkSync(b.path); removed++ } catch {}
    }
    return removed
  }
}

// ── 版本管理器 ───────────────────────────────────────────────────────────────
class VersionManager {
  constructor(log) {
    this.log = log
    this.configPath = path.join(APP_ROOT, 'config.json')
    this.versionPath = path.join(APP_ROOT, '版本号.txt')
  }

  getCurrent() {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      return cfg.version || '1.0.0'
    } catch { return '1.0.0' }
  }

  bump(type = 'patch') {
    try {
      const current = this.getCurrent()
      const parts   = current.split('.').map(Number)
      if (type === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0 }
      else if (type === 'minor') { parts[1]++; parts[2] = 0 }
      else { parts[2]++ }
      const next = parts.join('.')

      const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      cfg.version = next
      cfg.current_version = next
      cfg.last_evolved = new Date().toISOString()
      fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2))

      try { fs.writeFileSync(this.versionPath, next + '\n') } catch {}

      this.log.push('version', 'bumped', `${current} → ${next}`, 'info')
      return { ok: true, from: current, to: next }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  recordEvolution(summary, changes = []) {
    const version = this.getCurrent()
    const planEntry = {
      version,
      ts:        Date.now(),
      iso:       new Date().toISOString(),
      summary,
      changes,
    }
    try {
      const existing = JSON.parse(fs.readFileSync(EVO_PLAN_FILE, 'utf8').replace(/^\s*$/, '[]'))
      existing.unshift(planEntry)
      if (existing.length > 100) existing.splice(100)
      fs.writeFileSync(EVO_PLAN_FILE, JSON.stringify(existing, null, 2))
    } catch {
      fs.writeFileSync(EVO_PLAN_FILE, JSON.stringify([planEntry], null, 2))
    }
    return planEntry
  }

  getHistory(n = 20) {
    try {
      const list = JSON.parse(fs.readFileSync(EVO_PLAN_FILE, 'utf8'))
      return list.slice(0, n)
    } catch { return [] }
  }
}

// ── AI 驱动的代码改进建议生成器 ─────────────────────────────────────────────
class AIAdvisor {
  constructor(log) {
    this.log = log
  }

  async generateAdvice(scanResults) {
    const topIssues = scanResults.issues
      .filter(i => i.severity === 'warn' || i.type === 'potential_memory_leak')
      .slice(0, 10)

    if (topIssues.length === 0) {
      this.log.push('advisor', 'no_issues', '扫描未发现严重问题，跳过 AI 建议', 'info')
      return []
    }

    const prompt = `你是 QClaw AI 系统的进化引擎顾问。
以下是代码扫描发现的问题列表（JSON格式）：
${JSON.stringify(topIssues, null, 2)}

请针对每个问题给出简短的改进建议（不超过2句话），输出JSON数组格式：
[{"file":"文件名","issue_type":"问题类型","advice":"改进建议","priority":"high|medium|low"}]
只输出JSON，不输出其他内容。`

    try {
      const result = await this._callOllama(prompt)
      const parsed = JSON.parse(result.match(/\[[\s\S]*\]/)?.[0] || '[]')
      this.log.push('advisor', 'advice_generated', `生成 ${parsed.length} 条改进建议`, 'info')
      return parsed
    } catch (e) {
      this.log.push('advisor', 'advice_failed', e.message, 'warn')
      return topIssues.slice(0, 5).map(i => ({
        file:     i.file,
        issue_type: i.type,
        advice:   this._ruleBasedAdvice(i),
        priority: i.severity === 'warn' ? 'high' : 'medium',
      }))
    }
  }

  _ruleBasedAdvice(issue) {
    const adviceMap = {
      large_function:         '拆分为多个小函数，每个函数只做一件事',
      empty_catch:            '在 catch 中至少添加 console.warn 记录错误信息',
      potential_memory_leak:  '为 setInterval 存储返回值，并在 stop() 中调用 clearInterval',
      var_keyword:            '将 var 替换为 const（不变）或 let（可变）',
      hardcoded_url:          '提取为顶部常量或从 config 读取',
      missing_header:         '添加 JSDoc 注释说明模块用途',
    }
    return adviceMap[issue.type] || '检查并优化此处代码'
  }

  _callOllama(prompt, model = 'qwen3.5:latest') {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 800 },
      })
      const req = http.request({
        hostname: 'localhost',
        port:     11434,
        path:     '/api/generate',
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  30000,
      }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            resolve(parsed.response || data)
          } catch { resolve(data) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama 请求超时')) })
      req.write(body)
      req.end()
    })
  }
}

// ── 主进化引擎 ───────────────────────────────────────────────────────────────
class SelfEvolutionEngine {
  constructor() {
    this.log        = new EvolutionLog()
    this.scanner    = new CodeScanner()
    this.patcher    = new SafePatcher(this.log)
    this.versions   = new VersionManager(this.log)
    this.advisor    = new AIAdvisor(this.log)

    this.running      = false
    this._scanTimer   = null
    this._evolTimer   = null

    this._state = {
      lastScanAt:       null,
      lastEvolveAt:     null,
      totalScans:       0,
      totalPatches:     0,
      totalRollbacks:   0,
      pendingIssues:    0,
      pendingAdvice:    [],
      lastScanResults:  null,
    }

    this.config = {
      enabled:           true,
      scanIntervalMs:    4 * 60 * 60 * 1000,
      evolveIntervalMs:  24 * 60 * 60 * 1000,
      autoPatchEnabled:  false,
      maxIssuesForPatch: 3,
      backupKeepCount:   50,
    }
  }

  start() {
    if (this.running) return
    this.running = true

    this.log.push('engine', 'started', '自我进化引擎已启动，立即开始扫描...', 'info')

    // 立即执行扫描（30s 延迟等服务器初始化完成，但不等 2 分钟）
    const initDelay = setTimeout(() => {
      this._runScan().then(results => {
        if (results.stats.issues > 0) {
          this.log.push('engine', 'scan_notice',
            `⚠️ 发现 ${results.stats.issues} 个潜在问题，运行进化周期可自动修复`, 'warn')
        } else {
          this.log.push('engine', 'scan_notice', '✅ 代码质量良好，未发现严重问题', 'info')
        }
      }).catch(() => {})
    }, 30 * 1000)
    if (initDelay.unref) initDelay.unref()

    this._scanTimer = setInterval(() => {
      this._runScan().catch((e) => this.log.push('engine', 'scan_error', e.message, 'error'))
    }, this.config.scanIntervalMs)
    if (this._scanTimer.unref) this._scanTimer.unref()

    this._evolTimer = setInterval(() => {
      this._runEvolution().catch((e) => this.log.push('engine', 'evolve_error', e.message, 'error'))
    }, this.config.evolveIntervalMs)
    if (this._evolTimer.unref) this._evolTimer.unref()
  }

  stop() {
    if (this._scanTimer)  clearInterval(this._scanTimer)
    if (this._evolTimer)  clearInterval(this._evolTimer)
    this._scanTimer = null
    this._evolTimer = null
    this.running    = false
    this.log.push('engine', 'stopped', '自我进化引擎已停止', 'info')
  }

  async _runScan() {
    this.log.push('scan', 'started', '开始扫描自身代码...', 'info')
    this._state.totalScans++
    this._state.lastScanAt = Date.now()

    const results = this.scanner.scanAll()
    this._state.lastScanResults = results
    this._state.pendingIssues   = results.stats.issues

    this.log.push('scan', 'completed',
      `扫描完成: ${results.stats.totalFiles} 个文件, ${results.stats.totalLines} 行, ${results.stats.issues} 个问题`,
      'info')

    if (results.stats.issues > 0) {
      const advice = await this.advisor.generateAdvice(results)
      this._state.pendingAdvice = advice
    }

    return results
  }

  async _runEvolution() {
    if (!this.config.enabled) return

    this.log.push('evolve', 'cycle_start', '开始进化周期...', 'info')
    this._state.lastEvolveAt = Date.now()

    const results = {
      scanned:    false,
      patches:    0,
      rolled:     0,
      versionBumped: false,
      summary:    '',
    }

    const scan = await this._runScan()
    results.scanned = true

    if (this.config.autoPatchEnabled &&
        scan.stats.issues >= this.config.maxIssuesForPatch &&
        this._state.pendingAdvice.length > 0) {

      const applied = await this._applyAdvice(this._state.pendingAdvice)
      results.patches   = applied.patched
      results.rolled    = applied.rolled
    }

    const pruned = this.patcher.pruneBackups(this.config.backupKeepCount)
    if (pruned > 0) {
      this.log.push('evolve', 'backup_pruned', `清理 ${pruned} 个过旧备份`, 'info')
    }

    if (results.patches > 0) {
      const ver = this.versions.bump('patch')
      results.versionBumped = ver.ok
      if (ver.ok) {
        results.summary = `进化成功: ${results.patches} 个文件已更新, 版本 ${ver.from} → ${ver.to}`
        this.versions.recordEvolution(results.summary, this._state.pendingAdvice)
      }
    } else {
      results.summary = `进化周期完成: 扫描 ${scan.stats.totalFiles} 文件，发现 ${scan.stats.issues} 个问题，无需补丁`
    }

    this.log.push('evolve', 'cycle_done', results.summary, 'info')
    return results
  }

  async _applyAdvice(advice) {
    const result = { patched: 0, rolled: 0, skipped: 0, details: [] }
    const AUTO_FIXABLE = new Set(['var_keyword', 'missing_header', 'potential_memory_leak', 'empty_catch'])

    for (const item of advice) {
      if (!AUTO_FIXABLE.has(item.issue_type)) {
        result.skipped++
        continue
      }

      const filePath = path.join(SERVER_ROOT, item.file)
      if (!fs.existsSync(filePath)) { result.skipped++; continue }

      let content = fs.readFileSync(filePath, 'utf8')
      let modified = false
      let fixDesc = ''

      // 修复1：var → const/let
      if (item.issue_type === 'var_keyword') {
        const varOccurrences = {}
        const matches = content.matchAll(/\bvar\s+(\w+)\s*=/g)
        for (const m of matches) {
          const name = m[1]
          const reassigned = (content.match(new RegExp(`\\b${name}\\s*=(?!=)`, 'g')) || []).length > 1
          varOccurrences[name] = reassigned ? 'let' : 'const'
        }
        const fixed = content.replace(/^(\s*)var\s+(\w+)\s*=/gm, (_, indent, name) => {
          return `${indent}${varOccurrences[name] || 'const'} ${name} =`
        })
        if (fixed !== content) {
          content = fixed
          modified = true
          fixDesc = `var → const/let`
        }
      }

      // 修复2：添加缺失的文件头注释
      if (item.issue_type === 'missing_header') {
        const rel = item.file
        const header = `/**\n * ${path.basename(rel)} — QClaw Server Module\n * Auto-generated header by SelfEvolutionEngine\n */\n\n`
        if (!content.startsWith('/**') && !content.startsWith('//')) {
          content = header + content
          modified = true
          fixDesc = '添加文件头注释'
        }
      }

      // 修复3：空 catch 块 → 添加 console.warn
      if (item.issue_type === 'empty_catch') {
        const fixed = content.replace(
          /catch\s*\((\w+)\)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/g,
          (_, varName) => `catch (${varName}) { console.warn('[QClaw] Caught error:', ${varName}?.message || ${varName}) }`
        )
        if (fixed !== content) {
          content = fixed
          modified = true
          fixDesc = '空catch块补充日志'
        }
      }

      if (modified) {
        const patchResult = await this.patcher.patch(filePath, content, `AutoFix[${item.issue_type}]: ${fixDesc}`)
        if (patchResult.ok) {
          result.patched++
          result.details.push({ file: item.file, fix: fixDesc, ok: true })
          this._state.totalPatches++
          this.log.push('patch', 'auto_fixed', `${item.file}: ${fixDesc}`, 'fix')
        } else {
          result.rolled++
          result.details.push({ file: item.file, fix: fixDesc, ok: false, error: patchResult.error })
          this._state.totalRollbacks++
        }
      }
    }

    return result
  }

  /**
   * 诊断 + 自动修复（用户主动调用：「帮我解决问题」）
   * 1. 立即扫描
   * 2. 生成建议
   * 3. 自动修复可修复的问题
   * 4. 返回完整报告
   */
  async diagnoseAndFix() {
    this.log.push('engine', 'diagnose_start', '开始诊断并自动修复...', 'info')

    const scan = await this._runScan()
    const report = {
      scannedFiles: scan.stats.totalFiles,
      totalLines:   scan.stats.totalLines,
      issues:       scan.stats.issues,
      fixed:        0,
      skipped:      0,
      summary:      '',
      issueBreakdown: {},
      fixedDetails:   [],
    }

    // 问题分类统计
    for (const issue of scan.issues) {
      report.issueBreakdown[issue.type] = (report.issueBreakdown[issue.type] || 0) + 1
    }

    if (scan.stats.issues === 0) {
      report.summary = `✅ 代码质量良好！扫描了 ${scan.stats.totalFiles} 个文件，共 ${scan.stats.totalLines} 行，未发现问题。`
      this.log.push('engine', 'diagnose_done', report.summary, 'info')
      return report
    }

    // 生成建议
    const advice = await this.advisor.generateAdvice(scan)
    this._state.pendingAdvice = advice

    // 临时开启自动修复
    const wasEnabled = this.config.autoPatchEnabled
    this.config.autoPatchEnabled = true
    const applied = await this._applyAdvice(advice)
    this.config.autoPatchEnabled = wasEnabled

    report.fixed   = applied.patched
    report.skipped = applied.skipped + applied.rolled
    report.fixedDetails = applied.details || []

    const issueTypeSummary = Object.entries(report.issueBreakdown)
      .map(([k, v]) => `${k}(${v})`)
      .join(', ')

    report.summary = [
      `🔍 扫描完成：${scan.stats.totalFiles} 个文件，${scan.stats.totalLines} 行`,
      `⚠️ 发现问题：${scan.stats.issues} 个 — ${issueTypeSummary}`,
      report.fixed > 0
        ? `✅ 已自动修复：${report.fixed} 处`
        : `ℹ️ 自动修复：0 处（其余问题需人工处理）`,
      report.skipped > 0 ? `⏭️ 跳过（需人工）：${report.skipped} 处` : '',
    ].filter(Boolean).join('\n')

    this.log.push('engine', 'diagnose_done', report.summary.replace(/\n/g, ' | '), 'info')

    if (report.fixed > 0) {
      this.versions.bump('patch')
      this.versions.recordEvolution(
        `诊断修复: ${report.fixed} 处自动修复`,
        report.fixedDetails
      )
    }

    return report
  }

  async runScan() { return this._runScan() }
  async runEvolution() { return this._runEvolution() }

  async patchFile(filePath, newContent, reason) {
    const result = await this.patcher.patch(filePath, newContent, reason)
    if (result.ok) {
      this._state.totalPatches++
      this.versions.bump('patch')
      this.versions.recordEvolution(`手动补丁: ${path.basename(filePath)} - ${reason}`)
    }
    return result
  }

  rollbackFile(filePath) {
    const result = this.patcher.rollback(filePath)
    if (result.ok) this._state.totalRollbacks++
    return result
  }

  getStatus() {
    return {
      running:           this.running,
      config:            { ...this.config },
      state:             { ...this._state, lastScanResults: undefined },
      version:           this.versions.getCurrent(),
      backupCount:       this.patcher.listBackups().length,
      logCount:          this.log.entries.length,
    }
  }

  getLog(n = 100) { return this.log.getLast(n) }
  getHistory(n = 20) { return this.versions.getHistory(n) }
  getScanResults() { return this._state.lastScanResults }
  getAdvice() { return this._state.pendingAdvice }
  getBackups() { return this.patcher.listBackups() }

  updateConfig(patch) {
    const old = { ...this.config }
    this.config = { ...this.config, ...patch }
    if (this.running && patch.scanIntervalMs && patch.scanIntervalMs !== old.scanIntervalMs) {
      this.stop()
      this.start()
    }
    this.log.push('config', 'updated', JSON.stringify(patch), 'info')
    return this.config
  }
}

// 单例
const engine = new SelfEvolutionEngine()
module.exports = engine
module.exports.SelfEvolutionEngine = SelfEvolutionEngine
module.exports.CodeScanner = CodeScanner
module.exports.SafePatcher = SafePatcher
