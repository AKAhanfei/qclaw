/**
 * stream-utils.js - QClaw v2.2
 * 流式响应工具：心跳保活 + 指数退避重试 + 错误分级处理
 *
 * 学习来源：
 *   - lobe-chat: 心跳保活防止 Nginx/CDN 60s 超时断连
 *   - open-webui: 分级错误（可重试 vs 致命）
 *   - chatbot-ui: 指数退避 + jitter 防雪崩
 */

/** SSE 帧写入 */
function sseWrite(res, data) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** SSE 注释心跳（不触发前端 onmessage，但重置连接超时） */
function ssePing(res) {
  if (res.writableEnded) return
  res.write(': ping\n\n')
}

/**
 * 错误分级
 *   RETRYABLE  - 网络抖动、限速、临时 5xx，可自动重试
 *   FATAL      - 认证失败、模型不存在、参数错误，无需重试
 */
const ERR_RETRYABLE = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'ECONNREFUSED', 'ERR_SOCKET_CLOSED', 'UND_ERR_SOCKET',
])

const ERR_FATAL_HTTP = new Set([400, 401, 403, 404, 422])

function classifyError(err) {
  if (err.code && ERR_RETRYABLE.has(err.code)) return 'RETRYABLE'
  const status = err.status || err.statusCode || err.response?.status
  if (status && ERR_FATAL_HTTP.has(status))    return 'FATAL'
  if (status && status >= 500)                 return 'RETRYABLE'
  if (err.message?.includes('rate limit'))     return 'RETRYABLE'
  if (err.message?.includes('timeout'))        return 'RETRYABLE'
  if (err.message?.includes('unauthorized'))   return 'FATAL'
  if (err.message?.includes('model not found')) return 'FATAL'
  return 'RETRYABLE'
}

/**
 * 带指数退避的重试包装器
 *
 * @param {Function} fn          - 异步函数，每次调用为一次尝试
 * @param {Object}   opts
 * @param {number}   opts.maxRetries  - 最大重试次数（默认 2）
 * @param {number}   opts.baseDelay  - 初始等待毫秒（默认 800）
 * @param {number}   opts.maxDelay   - 最大等待毫秒（默认 8000）
 * @param {Function} opts.onRetry    - 重试回调 (attempt, delay, err)
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 2,
    baseDelay  = 800,
    maxDelay   = 8000,
    onRetry    = () => {},
  } = opts

  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      const type = classifyError(err)

      // 致命错误直接抛出，不重试
      if (type === 'FATAL') throw err

      // 最后一次也失败，抛出
      if (attempt === maxRetries) throw err

      // 指数退避 + jitter（防止多请求同时重试造成雪崩）
      const base  = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
      const jitter = Math.random() * base * 0.3
      const delay  = Math.round(base + jitter)

      onRetry(attempt + 1, delay, err)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/**
 * 心跳保活定时器
 * 每 25s 发送一个 SSE 注释心跳，防止 Nginx/CDN/Electron 代理 60s 空闲断连
 *
 * @param {Response} res
 * @returns {{ stop: Function }}
 */
function startHeartbeat(res) {
  const timer = setInterval(() => ssePing(res), 25_000)
  return {
    stop: () => clearInterval(timer),
  }
}

module.exports = { sseWrite, ssePing, startHeartbeat, withRetry, classifyError }
