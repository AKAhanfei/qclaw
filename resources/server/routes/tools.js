/**
 * /api/tools - 扩展工具接口
 * 联网搜索（多引擎回退：Bing / Baidu / DuckDuckGo HTML / DuckDuckGo InstantAnswer）
 * + 网页内容抓取（自动编码检测）+ JS 沙箱执行 + 系统信息
 */

const express = require('express')
const router  = express.Router()
const https   = require('https')
const http    = require('http')
const zlib    = require('zlib')

// ── User-Agent 池（轮换使用，降低被封风险）──────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
]
let _uaIdx = 0
function randomUA() {
  const ua = UA_POOL[_uaIdx % UA_POOL.length]
  _uaIdx++
  return ua
}

// ── HTTP 工具函数（支持 gzip 解压 + GBK 编码）─────────────────────────────────
function httpGet(url, headers = {}, timeout = 12000, allowBuffer = false) {
  return new Promise((resolve, reject) => {
    // 最多重定向 5 次
    function doGet(targetUrl, redirectCount) {
      if (redirectCount > 5) return reject(new Error('重定向次数过多'))
      const client = targetUrl.startsWith('https') ? https : http
      const req = client.get(targetUrl, {
        timeout,
        headers: {
          'User-Agent':      randomUA(),
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection':      'keep-alive',
          'Cache-Control':   'no-cache',
          ...headers,
        },
      }, (resp) => {
        // 跟随重定向
        if ((resp.statusCode === 301 || resp.statusCode === 302 || resp.statusCode === 307 || resp.statusCode === 308)
            && resp.headers.location) {
          try {
            const nextUrl = new URL(resp.headers.location, targetUrl).href
            resp.resume()
            return doGet(nextUrl, redirectCount + 1)
          } catch {
            return reject(new Error(`无效重定向: ${resp.headers.location}`))
          }
        }

        // 非 2xx 视为错误
        if (resp.statusCode < 200 || resp.statusCode >= 400) {
          resp.resume()
          return reject(new Error(`HTTP ${resp.statusCode}`))
        }

        // 处理 gzip/brotli 压缩
        const encoding = (resp.headers['content-encoding'] || '').toLowerCase()
        let stream = resp
        if (encoding === 'gzip') {
          stream = resp.pipe(zlib.createGunzip())
        } else if (encoding === 'deflate') {
          stream = resp.pipe(zlib.createInflate())
        } else if (encoding === 'br') {
          try { stream = resp.pipe(zlib.createBrotliDecompress()) } catch { /* br 不支持则忽略 */ }
        }

        const chunks = []
        let totalLen = 0
        const MAX_BYTES = 500000

        stream.on('data', chunk => {
          if (totalLen < MAX_BYTES) {
            chunks.push(chunk)
            totalLen += chunk.length
            if (totalLen >= MAX_BYTES) {
              resp.destroy()
            }
          }
        })
        stream.on('end', () => {
          if (allowBuffer) return resolve(Buffer.concat(chunks))

          const buf = Buffer.concat(chunks)
          // 尝试检测 GBK/GB2312 编码（中文网页常见）
          const rawStr = buf.toString('binary')
          const charsetM = rawStr.match(/charset=["']?(gb2312|gbk|utf-8|utf8)/i)
          if (charsetM && /gbk|gb2312/i.test(charsetM[1])) {
            try {
              // Node.js 18+ 原生支持 TextDecoder gbk
              const decoded = new TextDecoder('gbk').decode(buf)
              return resolve(decoded)
            } catch { /* 回退 utf8 */ }
          }
          resolve(buf.toString('utf8'))
        })
        stream.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    }

    doGet(url, 0)
  })
}

// ── 从 HTML 提取文本（去除脚本/样式/标签）────────────────────────────────────
function extractText(html, maxLen = 2000) {
  if (!html || typeof html !== 'string') return ''
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim()
    .slice(0, maxLen)
}

// ── 从 Bing 搜索结果页解析 ────────────────────────────────────────────────────
function parseBingResults(html, maxResults = 8) {
  const results = []
  // 新版 Bing：<h2><a href="https://...">标题</a></h2>
  const linkRe  = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"#?]+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  const snippRe = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/g

  const links = []
  let m
  while ((m = linkRe.exec(html)) !== null) {
    const url   = m[1]
    const title = extractText(m[2], 120)
    if (url && title && !url.includes('microsoft.com') && !url.includes('bing.com')) {
      links.push({ url, title })
    }
  }

  const snippets = []
  while ((m = snippRe.exec(html)) !== null) {
    snippets.push(extractText(m[1], 300))
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' })
  }
  return results
}

// ── 从百度搜索结果页解析 ────────────────────────────────────────────────────────
function parseBaiduResults(html, maxResults = 8) {
  const results = []
  // 百度结果块：<h3 ...><a ...>标题</a></h3>，摘要在 <span class="content-right_8Zs40">
  const blockRe = /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>([\s\S]*?)<\/h3>([\s\S]{0,800}?)(?=<h3|<\/div>)/g
  let m
  while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
    const titleHtml = m[1]
    const bodyHtml  = m[2]
    const linkM = titleHtml.match(/href="(https?:\/\/[^"]+)"/)
    const title = extractText(titleHtml, 120)
    const snippet = extractText(bodyHtml, 300)
    if (linkM && title) {
      results.push({ url: linkM[1], title, snippet })
    }
  }

  // 备用解析：<a class="result-op" 或 <a class="c-blocka"
  if (results.length === 0) {
    const linkRe2 = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*c-title[^"]*"[^>]*>([\s\S]*?)<\/a>/g
    while ((m = linkRe2.exec(html)) !== null && results.length < maxResults) {
      results.push({ url: m[1], title: extractText(m[2], 120), snippet: '' })
    }
  }

  return results
}

// ── 从 DuckDuckGo HTML 解析结果 ────────────────────────────────────────────────
function parseDDGResults(html, maxResults = 8) {
  const results = []
  const re = /<a class="result__a"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) !== null && results.length < maxResults) {
    results.push({
      url:     m[1],
      title:   extractText(m[2], 120),
      snippet: extractText(m[3], 300),
    })
  }
  return results
}

// ── 搜索策略1：Bing ────────────────────────────────────────────────────────────
async function searchBing(query, maxResults) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&setlang=zh-CN&cc=CN`
  const html = await httpGet(url, { 'Accept-Language': 'zh-CN,zh;q=0.9' }, 12000)
  return parseBingResults(html, maxResults)
}

// ── 搜索策略2：百度 ───────────────────────────────────────────────────────────
async function searchBaidu(query, maxResults) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}&ie=utf-8`
  const html = await httpGet(url, {
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.baidu.com',
  }, 12000)
  return parseBaiduResults(html, maxResults)
}

// ── 搜索策略3：DuckDuckGo HTML ────────────────────────────────────────────────
async function searchDDGHtml(query, maxResults) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const html = await httpGet(url, {}, 12000)
  return parseDDGResults(html, maxResults)
}

// ── 搜索策略4：DuckDuckGo InstantAnswer（最低回退，无广告、轻量）─────────────
async function searchDDGInstant(query, maxResults) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const body = await httpGet(url, {}, 10000)
  let data
  try { data = JSON.parse(body) } catch { return [] }

  const results = []
  if (data.Abstract) {
    results.push({ title: data.Heading || query, snippet: data.Abstract, url: data.AbstractURL || '' })
  }
  for (const t of (data.RelatedTopics || []).slice(0, maxResults)) {
    if (t.Text && t.FirstURL) {
      results.push({
        title:   (t.Text.split(' - ')[0] || t.Text).slice(0, 80),
        snippet: t.Text.slice(0, 300),
        url:     t.FirstURL,
      })
    }
  }
  return results.slice(0, maxResults)
}

// ── POST /api/tools/websearch ────────────────────────────────────────────────
// 多引擎回退：Bing → Baidu → DuckDuckGo HTML → DuckDuckGo Instant
// 返回 { results, engine } 成功 或 { results:[], error, tried } 失败
router.post('/websearch', async (req, res) => {
  const { query, maxResults = 8, engine } = req.body
  if (!query) return res.status(400).json({ results: [], error: '查询词为空' })

  // 按指定引擎或默认顺序（国内优先：Bing→Baidu，然后 DDG 兜底）
  const strategies = engine === 'bing'
    ? [searchBing]
    : engine === 'baidu'
      ? [searchBaidu]
      : engine === 'ddg'
        ? [searchDDGHtml, searchDDGInstant]
        : [searchBing, searchBaidu, searchDDGHtml, searchDDGInstant]

  const tried = []
  let lastError = null

  for (const strategy of strategies) {
    tried.push(strategy.name)
    try {
      const results = await strategy(query, maxResults)
      if (results.length > 0) {
        console.log(`[WebSearch] "${query}" → ${results.length} 条结果 (${strategy.name})`)
        return res.json({ results, engine: strategy.name })
      }
      console.warn(`[WebSearch] ${strategy.name} 返回空结果，尝试下一引擎...`)
      lastError = `${strategy.name} 返回空结果`
    } catch (e) {
      lastError = `${strategy.name} 失败: ${e.message}`
      console.warn(`[WebSearch] ${lastError}`)
    }
  }

  // 全部失败 → 返回 503 让前端知道这是真实失败
  console.error(`[WebSearch] 所有引擎均失败，查询: "${query}"`, { tried, lastError })
  res.status(503).json({
    results: [],
    error:   lastError || '所有搜索引擎均无结果',
    tried,
  })
})

// ── POST /api/tools/fetch ────────────────────────────────────────────────────
// 抓取任意 URL 的文本内容（自动 GBK 解码、支持 gzip）
router.post('/fetch', async (req, res) => {
  const { url, maxLen = 5000 } = req.body
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: '无效 URL，请提供完整的 http(s):// 地址' })
  }
  try {
    const html    = await httpGet(url, {}, 20000)
    const titleM  = html.match(/<title[^>]*>([\s\S]{0,300})<\/title>/i)
    const title   = titleM ? extractText(titleM[1]) : url
    const content = extractText(html, maxLen)

    if (!content || content.length < 20) {
      return res.json({
        ok:      false,
        error:   '页面内容为空或无法解析（可能是动态渲染页面或需要登录）',
        title,
        url,
      })
    }

    res.json({ ok: true, title, content, url, length: html.length })
  } catch (e) {
    let errMsg = e.message
    // 友好化常见错误
    if (/timeout/i.test(errMsg))       errMsg = `请求超时（目标服务器响应过慢）：${url}`
    else if (/ENOTFOUND/i.test(errMsg)) errMsg = `域名解析失败，请检查 URL 是否正确：${url}`
    else if (/ECONNREFUSED/i.test(errMsg)) errMsg = `连接被拒绝，目标服务器可能不可用：${url}`
    else if (/HTTP 4/i.test(errMsg))    errMsg = `${errMsg}（页面不存在或需要授权）`
    else if (/HTTP 5/i.test(errMsg))    errMsg = `${errMsg}（目标服务器内部错误）`

    res.status(503).json({ ok: false, error: errMsg, url })
  }
})

// ── POST /api/tools/execute ──────────────────────────────────────────────────
// JavaScript 沙箱执行（vm.runInContext，5s 超时）
router.post('/execute', (req, res) => {
  const { code = '', language = 'javascript' } = req.body
  if (!code.trim()) return res.json({ ok: false, error: '代码为空', output: '' })

  // 安全过滤
  const dangerous = [
    /require\s*\(\s*['"]child_process['"]/,
    /process\.exit/,
    /fs\.(rm|unlink|delete)/,
    /eval\s*\(/,
    /__proto__/,
    /prototype\[/,
    /constructor\[/,
  ]
  for (const p of dangerous) {
    if (p.test(code)) {
      return res.json({ ok: false, error: '代码包含危险操作，已被安全沙箱拦截', output: '' })
    }
  }

  if (language === 'javascript' || language === 'js') {
    try {
      const vm   = require('vm')
      const logs = []
      const ctx  = vm.createContext({
        console: {
          log:   (...a) => logs.push(a.map(String).join(' ')),
          error: (...a) => logs.push('[ERR] ' + a.map(String).join(' ')),
          warn:  (...a) => logs.push('[WARN] ' + a.map(String).join(' ')),
          info:  (...a) => logs.push('[INFO] ' + a.map(String).join(' ')),
        },
        Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Set, Map, Promise,
        setTimeout: () => {}, clearTimeout: () => {},
        parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      })
      const result = vm.runInContext(code, ctx, { timeout: 5000 })
      const output = [
        ...logs,
        ...(result !== undefined ? [`=> ${JSON.stringify(result)}`] : [])
      ].join('\n')
      res.json({ ok: true, output })
    } catch (e) {
      res.json({ ok: false, output: '', error: e.message })
    }
  } else {
    res.json({ ok: false, error: `暂不支持直接执行 ${language}，请使用 <tool:shell> 执行系统命令` })
  }
})

// ── GET /api/tools/sysinfo ───────────────────────────────────────────────────
router.get('/sysinfo', (req, res) => {
  const os = require('os')
  const mem = os.totalmem()
  const free = os.freemem()
  res.json({
    platform:  os.platform(),
    arch:      os.arch(),
    release:   os.release(),
    cpus:      os.cpus().length,
    cpuModel:  os.cpus()[0]?.model || 'Unknown',
    memory: {
      total:      mem,
      free,
      used:       mem - free,
      totalGB:    (mem  / 1073741824).toFixed(1),
      freeGB:     (free / 1073741824).toFixed(1),
      usedPercent: Math.round((1 - free / mem) * 100),
    },
    hostname:  os.hostname(),
    homedir:   os.homedir(),
    tmpdir:    os.tmpdir(),
    node:      process.version,
    uptime:    Math.round(os.uptime()),
  })
})

module.exports = router
