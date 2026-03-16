/**
 * QClaw - qwen3.5:latest 连接测试
 */
const axios = require('axios')

const BASE_URL = 'http://localhost:11434'
const MODEL    = 'qwen3.5:latest'

async function run() {
  console.log('=== QClaw × qwen3.5:latest 连接测试 ===\n')

  // Step 1: 检查 Ollama 服务
  console.log('[1/3] 检查 Ollama 服务...')
  try {
    const r = await axios.get(`${BASE_URL}/api/tags`, { timeout: 5000 })
    const models = r.data.models || []
    console.log(`      ✓ Ollama 运行中，已安装模型:`)
    models.forEach(m => {
      const mark = m.name === MODEL ? ' ← 目标' : ''
      const sizeGB = (m.size / 1e9).toFixed(1)
      console.log(`        • ${m.name}  (${m.details?.parameter_size || '?'}, ${sizeGB}GB)${mark}`)
    })
    const found = models.find(m => m.name === MODEL)
    if (!found) {
      console.log(`\n  ✗ 未找到 ${MODEL}，请先运行: ollama pull ${MODEL}`)
      process.exit(1)
    }
    console.log(`      ✓ ${MODEL} 已就绪\n`)
  } catch (e) {
    console.log(`      ✗ Ollama 服务不可访问: ${e.message}`)
    process.exit(1)
  }

  // Step 2: 发送测试消息
  console.log('[2/3] 发送测试消息...')
  const t0 = Date.now()
  try {
    const res = await axios.post(
      `${BASE_URL}/api/chat`,
      {
        model: MODEL,
        messages: [
          { role: 'system', content: '你是 QClaw 内置的 AI 助手，基于 Qwen3.5 模型。请简洁回答。' },
          { role: 'user',   content: '你好！请用一句话介绍自己，然后说你已成功集成到 QClaw。' },
        ],
        stream: false,
        options: { temperature: 0.7, num_predict: 4096 },
      },
      { timeout: 120000 }
    )
    const elapsed = Date.now() - t0
    // qwen3.5 思考模型：正式回复在 content，思考过程在 thinking
    const msg     = res.data.message || {}
    const reply   = msg.content || msg.thinking || '(无回复)'
    const usage   = res.data
    console.log(`      ✓ 响应时间: ${elapsed}ms`)
    console.log(`      ✓ 模型回复:\n`)
    console.log(`        "${reply}"`)
    if (usage.prompt_eval_count) {
      console.log(`\n        Token 用量: prompt=${usage.prompt_eval_count} / completion=${usage.eval_count}`)
    }
    console.log()
  } catch (e) {
    console.log(`      ✗ 请求失败: ${e.message}`)
    process.exit(1)
  }

  // Step 3: 验证 Provider Registry 配置
  console.log('[3/3] 验证 QClaw Provider Registry...')
  try {
    const registry = require('./providers/registry')
    const active   = registry.getActive()
    console.log(`      ✓ 当前激活 Provider: ${active.id} (${active.config?.name || active.id})`)
    console.log(`      ✓ 当前默认模型: ${active.config?.currentModel}`)
    const models = active.config?.availableModels || []
    const hasQwen35 = models.some(m => m.id === MODEL)
    console.log(`      ✓ qwen3.5:latest 已内置模型列表: ${hasQwen35 ? '是' : '否'}`)
    if (!hasQwen35) process.exit(1)
  } catch (e) {
    console.log(`      ✗ Registry 加载失败: ${e.message}`)
    process.exit(1)
  }

  console.log('\n=== 全部通过 ✓ qwen3.5:latest 已成功内置并连接 QClaw ===\n')
}

run()
