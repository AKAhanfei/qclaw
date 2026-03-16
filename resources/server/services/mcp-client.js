/**
 * QClaw MCP Client - Model Context Protocol 客户端
 * 基于 electron-ai-chatbot / Open WebUI 的 MCP 集成经验
 *
 * 架构：
 * - 通过子进程 stdio 启动 MCP server（npx @modelcontextprotocol/server-xxx）
 * - JSON-RPC 2.0 协议收发消息
 * - 支持 tools/list、tools/call 等核心方法
 * - 每个 server 维护独立子进程，按需启停
 */

const { spawn } = require('child_process')
const EventEmitter = require('events')
const os = require('os')

// Windows 下 spawn npx/npm 等 .cmd 脚本必须用 shell:true
const IS_WIN = os.platform() === 'win32'

class MCPServerProcess extends EventEmitter {
  constructor(config) {
    super()
    this.id       = config.id
    this.name     = config.name
    this.command  = config.command  // e.g. 'npx'
    this.args     = config.args     // e.g. ['-y', '@modelcontextprotocol/server-filesystem', './']
    this.env      = config.env || {}

    this.proc     = null
    this.status   = 'stopped'   // stopped | starting | running | error
    this.tools    = []          // 注册的工具列表
    this.error    = null

    this._pending   = new Map()  // requestId → { resolve, reject }
    this._buffer    = ''
    this._msgId     = 0
  }

  // ── 启动进程 ─────────────────────────────────────────────────────────────
  async start() {
    if (this.status === 'running' || this.status === 'starting') return
    this.status = 'starting'
    this.error  = null
    this.emit('statusChange', this.status)

    return new Promise((resolve, reject) => {
      try {
        const cmd = this.command
        // 合并 env，过滤掉空值，避免空字符串覆盖系统变量
        const filteredEnv = Object.fromEntries(
          Object.entries(this.env || {}).filter(([, v]) => v && String(v).trim() !== '')
        )
        this.proc = spawn(cmd, this.args, {
          env:   { ...process.env, ...filteredEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: IS_WIN,   // Windows 下 .cmd 脚本必须借助 shell
        })
      } catch (e) {
        this.status = 'error'
        this.error  = e.message
        this.emit('statusChange', this.status)
        return reject(e)
      }

      // 读取 stdout（行缓冲 JSON-RPC 消息）
      this.proc.stdout.setEncoding('utf8')
      this.proc.stdout.on('data', (chunk) => {
        this._buffer += chunk
        const lines = this._buffer.split('\n')
        this._buffer = lines.pop() // 保留不完整行
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const msg = JSON.parse(trimmed)
            this._handleMessage(msg)
          } catch {
            // 非 JSON 行（日志等）忽略
          }
        }
      })

      this.proc.stderr.setEncoding('utf8')
      this.proc.stderr.on('data', (data) => {
        // MCP server 常在 stderr 输出启动日志，不当作错误
        console.log(`[MCP:${this.name}] ${data.trim()}`)
      })

      this.proc.on('error', (e) => {
        this.status = 'error'
        this.error  = e.message
        this.emit('statusChange', this.status)
        // reject 所有 pending
        for (const [, { reject: rej }] of this._pending) rej(e)
        this._pending.clear()
      })

      this.proc.on('exit', (code) => {
        if (this.status !== 'stopped') {
          this.status = code === 0 ? 'stopped' : 'error'
          if (code !== 0) this.error = `进程退出，code=${code}`
        }
        this.emit('statusChange', this.status)
        for (const [, { reject: rej }] of this._pending)
          rej(new Error(`MCP server ${this.name} 已退出`))
        this._pending.clear()
      })

      // 初始化握手：发送 initialize 请求
      const initTimeout = setTimeout(() => {
        reject(new Error(`MCP server ${this.name} 初始化超时`))
        this.stop()
      }, 15000)

      this._call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        clientInfo:      { name: 'QClaw', version: '2.3.0' },
      }).then(async (result) => {
        clearTimeout(initTimeout)
        // 发送 initialized 通知
        this._notify('notifications/initialized', {})
        this.status = 'running'
        this.emit('statusChange', this.status)

        // 获取工具列表
        try {
          const toolsResult = await this._call('tools/list', {})
          this.tools = toolsResult.tools || []
          this.emit('toolsLoaded', this.tools)
        } catch (e) {
          console.warn(`[MCP:${this.name}] 获取工具列表失败:`, e.message)
        }

        resolve(result)
      }).catch((e) => {
        clearTimeout(initTimeout)
        this.status = 'error'
        this.error  = e.message
        this.emit('statusChange', this.status)
        reject(e)
      })
    })
  }

  // ── 停止进程 ─────────────────────────────────────────────────────────────
  stop() {
    this.status = 'stopped'
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
    this.emit('statusChange', this.status)
  }

  // ── 调用工具 ─────────────────────────────────────────────────────────────
  async callTool(toolName, toolArgs = {}) {
    if (this.status !== 'running') throw new Error(`MCP server ${this.name} 未运行`)
    const result = await this._call('tools/call', { name: toolName, arguments: toolArgs })
    // 提取文本内容
    const content = result.content || []
    const text = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')
    return { text, raw: result }
  }

  // ── JSON-RPC 发送请求（有回调） ───────────────────────────────────────────
  _call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._msgId
      this._pending.set(id, { resolve, reject })
      this._send({ jsonrpc: '2.0', id, method, params })
      // 30s 超时
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error(`MCP ${method} 请求超时`))
        }
      }, 30000)
      // 在 resolve/reject 时清除 timer
      const origResolve = resolve
      const origReject  = reject
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v) },
        reject:  (e) => { clearTimeout(timer); origReject(e) },
      })
    })
  }

  // ── JSON-RPC 通知（无回调） ──────────────────────────────────────────────
  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params })
  }

  _send(msg) {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else           resolve(msg.result)
    }
    // 处理服务端推送通知（暂忽略）
  }

  toJSON() {
    return {
      id:     this.id,
      name:   this.name,
      status: this.status,
      error:  this.error,
      tools:  this.tools.map(t => ({
        name:        t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }
  }
}

// ─── MCP Manager（管理所有 server 实例）──────────────────────────────────────
class MCPManager {
  constructor() {
    this.servers = new Map() // id → MCPServerProcess
  }

  // 注册并启动一个 server
  async startServer(config) {
    if (this.servers.has(config.id)) {
      const existing = this.servers.get(config.id)
      if (existing.status === 'running') return existing.toJSON()
    }
    const srv = new MCPServerProcess(config)
    this.servers.set(config.id, srv)
    await srv.start()
    return srv.toJSON()
  }

  // 停止 server
  stopServer(id) {
    const srv = this.servers.get(id)
    if (srv) { srv.stop(); this.servers.delete(id) }
  }

  // 调用某个 server 的工具
  async callTool(serverId, toolName, toolArgs) {
    const srv = this.servers.get(serverId)
    if (!srv) throw new Error(`MCP server ${serverId} 不存在`)
    return srv.callTool(toolName, toolArgs)
  }

  // 获取所有 server 的工具（扁平列表，用于 AI context）
  getAllTools() {
    const tools = []
    for (const [serverId, srv] of this.servers) {
      if (srv.status !== 'running') continue
      for (const t of srv.tools) {
        tools.push({
          serverId,
          serverName: srv.name,
          name:        t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })
      }
    }
    return tools
  }

  // 获取所有 server 状态
  getStatus() {
    return [...this.servers.values()].map(s => s.toJSON())
  }
}

const manager = new MCPManager()
module.exports = manager
