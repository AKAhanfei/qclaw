/**
 * QClaw Round 5 验证脚本
 */
const path = require('path')

const modules = [
  './services/mcp-client',
  './services/memory-engine',
  './services/tool-guard',
  './services/scheduled-skills',
  './services/context-engine',
  './routes/chat',
  './routes/models',
]

let allOk = true
for (const mod of modules) {
  try {
    require(mod)
    console.log(`[OK] ${mod}`)
  } catch (e) {
    console.error(`[FAIL] ${mod}: ${e.message}`)
    allOk = false
  }
}

console.log('\n── MCP Manager 功能验证 ──')
const mcp = require('./services/mcp-client')
console.log('[OK] getStatus():', JSON.stringify(mcp.getStatus()))
console.log('[OK] getAllTools():', JSON.stringify(mcp.getAllTools()))

console.log('\n── 验证结果 ──')
console.log(allOk ? '[ALL PASS] 所有模块加载成功' : '[SOME FAIL] 有模块加载失败')
