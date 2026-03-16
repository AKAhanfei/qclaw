/**
 * /api/files - File system operations
 *
 * 安全策略：
 *   - 所有路径操作都限制在 allowedRoots 白名单内
 *   - 使用 path.resolve() 规范化后做前缀校验，防路径穿越（../）
 *   - allowedRoots 由前端首次设置工作区时通过 /api/files/setRoot 注册
 *   - 未注册工作区前，只允许读取用户 home 目录
 */

const express = require('express')
const router  = express.Router()
const fs      = require('fs')
const path    = require('path')
const os      = require('os')

// ── 允许的根目录集合（运行时由 setRoot 注册）─────────────────────────────────
const allowedRoots = new Set([
  os.homedir(),              // 始终允许 home 目录
])

/**
 * 校验路径是否在白名单内
 * @returns {string} 规范化后的绝对路径，校验失败则抛出 Error
 */
function validatePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') throw new Error('路径不能为空')
  const resolved = path.resolve(rawPath)
  for (const root of allowedRoots) {
    const normalRoot = path.resolve(root)
    // 必须以白名单根目录 + 分隔符开头（防止 /homeuser2/ 匹配 /home/user/）
    if (resolved === normalRoot || resolved.startsWith(normalRoot + path.sep)) {
      return resolved
    }
  }
  throw new Error(`访问被拒绝：路径不在工作区内 (${resolved})`)
}

// ── POST /api/files/setRoot（注册工作区根目录）──────────────────────────────
router.post('/setRoot', (req, res) => {
  const { dir } = req.body
  if (!dir) return res.status(400).json({ ok: false, error: '缺少 dir 参数' })
  const resolved = path.resolve(dir)
  if (!fs.existsSync(resolved)) return res.status(400).json({ ok: false, error: '目录不存在' })
  allowedRoots.add(resolved)
  res.json({ ok: true, root: resolved })
})

// ── GET /api/files/allowedRoots（查看当前白名单）────────────────────────────
router.get('/allowedRoots', (req, res) => {
  res.json({ roots: Array.from(allowedRoots) })
})

// ── GET /api/files/list?dir=... ──────────────────────────────────────────────
router.get('/list', (req, res) => {
  const { dir } = req.query
  if (!dir) return res.json({ items: [] })
  try {
    const safe  = validatePath(dir)
    const items = fs.readdirSync(safe, { withFileTypes: true }).map(i => ({
      name:  i.name,
      isDir: i.isDirectory(),
      path:  path.join(safe, i.name),
    }))
    res.json({ items })
  } catch (e) {
    res.status(e.message.startsWith('访问被拒绝') ? 403 : 500)
       .json({ items: [], error: e.message })
  }
})

// ── GET /api/files/read?path=... ─────────────────────────────────────────────
router.get('/read', (req, res) => {
  const { path: fp } = req.query
  try {
    const safe    = validatePath(fp)
    const content = fs.readFileSync(safe, 'utf8')
    res.json({ ok: true, content })
  } catch (e) {
    const status = e.message.startsWith('访问被拒绝') ? 403 : 500
    res.status(status).json({ ok: false, error: e.message })
  }
})

// ── POST /api/files/write ────────────────────────────────────────────────────
router.post('/write', (req, res) => {
  const { path: fp, content } = req.body
  try {
    const safe = validatePath(fp)
    fs.mkdirSync(path.dirname(safe), { recursive: true })
    fs.writeFileSync(safe, content || '', 'utf8')
    res.json({ ok: true })
  } catch (e) {
    const status = e.message.startsWith('访问被拒绝') ? 403 : 500
    res.status(status).json({ ok: false, error: e.message })
  }
})

module.exports = router
