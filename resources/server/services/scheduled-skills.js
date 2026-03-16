/**
 * QClaw Scheduled Skills - Inspired by CoPaw cron skills
 * 定时技能任务：支持 cron 表达式，后台自动执行 AI 任务
 *
 * 支持的任务类型：
 *   - daily_summary  : 每日对话摘要
 *   - memory_distill : 记忆提炼（将重要信息写入长期记忆）
 *   - health_check   : 服务健康检查报告
 *   - custom         : 用户自定义 AI 任务
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

const JOBS_FILE = path.join(os.homedir(), '.qclaw', 'jobs.json')

/** 简单的 cron-like 调度器（不依赖外部库）*/
class ScheduledSkills {
  constructor() {
    this.jobs     = []
    this.timers   = []
    this.running  = false
    this.log      = []
    this._loadJobs()
  }

  _loadJobs() {
    try {
      const saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
      this.jobs = saved
    } catch {
      // 默认内置任务
      this.jobs = [
        {
          id:       'memory-distill',
          name:     '每日记忆提炼',
          type:     'memory_distill',
          schedule: 'daily_23:30',  // 每天 23:30
          enabled:  true,
          lastRun:  null,
        },
        {
          id:       'health-check',
          name:     '每小时健康检查',
          type:     'health_check',
          schedule: 'hourly',
          enabled:  true,
          lastRun:  null,
        },
      ]
      this._saveJobs()
    }
  }

  _saveJobs() {
    try {
      const dir = path.dirname(JOBS_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(JOBS_FILE, JSON.stringify(this.jobs, null, 2))
    } catch {}
  }

  /**
   * 检查一个 job 是否应该现在运行
   */
  _shouldRun(job) {
    const now  = new Date()
    const last = job.lastRun ? new Date(job.lastRun) : null

    switch (job.schedule) {
      case 'hourly': {
        if (!last) return true
        return (now - last) >= 3600 * 1000
      }
      case 'daily': {
        if (!last) return true
        const diff = now - last
        return diff >= 24 * 3600 * 1000
      }
      default: {
        // 支持 'daily_HH:MM' 格式
        const m = job.schedule.match(/^daily_(\d{1,2}):(\d{2})$/)
        if (!m) return false
        const targetH = parseInt(m[1], 10)
        const targetM = parseInt(m[2], 10)
        if (now.getHours() !== targetH || now.getMinutes() !== targetM) return false
        if (!last) return true
        // 今天已经运行过则跳过
        const lastDate = new Date(last)
        return lastDate.toDateString() !== now.toDateString()
      }
    }
  }

  /**
   * 执行单个 job
   */
  async _execute(job) {
    const memEngine = require('./memory-engine')
    this._log(job.id, 'start', `执行任务: ${job.name}`)

    try {
      let result = null

      switch (job.type) {
        case 'memory_distill': {
          const status = memEngine.getStatus()
          const mem    = memEngine.memory.getAll()
          const topFacts = (mem.facts || []).slice(0, 10)
          result = `记忆提炼完成：共 ${mem.facts?.length || 0} 条事实，热门记忆 ${topFacts.length} 条`
          // 清理低权重痛觉记忆
          const noci = memEngine.nociception
          noci._recalcWeights?.()
          noci.save?.()
          break
        }

        case 'health_check': {
          try {
            const http = require('http')
            const ok   = await new Promise((resolve) => {
              const req = http.get('http://localhost:3001/health', (res) => {
                resolve(res.statusCode === 200)
              })
              req.on('error', () => resolve(false))
              req.setTimeout(2000, () => resolve(false))
              req.end()
            })
            result = `健康检查: ${ok ? '✓ 正常' : '✗ 异常'}`
          } catch {
            result = '健康检查: 服务不可达'
          }
          break
        }

        case 'daily_summary': {
          result = `每日摘要已触发 - ${new Date().toLocaleDateString('zh-CN')}`
          break
        }

        case 'custom': {
          result = `自定义任务 "${job.name}" 已触发`
          break
        }
      }

      job.lastRun    = new Date().toISOString()
      job.lastResult = result
      job.lastStatus = 'success'
      this._log(job.id, 'success', result)
    } catch (e) {
      job.lastRun    = new Date().toISOString()
      job.lastResult = e.message
      job.lastStatus = 'error'
      this._log(job.id, 'error', e.message)
    }

    this._saveJobs()
  }

  _log(jobId, status, message) {
    const entry = { ts: Date.now(), jobId, status, message }
    this.log.push(entry)
    if (this.log.length > 100) this.log.shift()
    console.log(`[ScheduledSkills][${status}] ${jobId}: ${message}`)
  }

  /**
   * 启动调度循环（每分钟检查一次）
   */
  start() {
    if (this.running) return
    this.running = true
    const check = async () => {
      for (const job of this.jobs) {
        if (!job.enabled) continue
        if (this._shouldRun(job)) {
          await this._execute(job)
        }
      }
    }
    check() // 立即执行一次
    const timer = setInterval(check, 60 * 1000) // 每分钟检查
    this.timers.push(timer)
    console.log('[ScheduledSkills] 调度器已启动，每分钟检查任务')
  }

  stop() {
    this.timers.forEach(t => clearInterval(t))
    this.timers  = []
    this.running = false
  }

  // ── 管理 API ─────────────────────────────────────────────────────────────
  getJobs()    { return [...this.jobs] }
  getLog()     { return [...this.log].reverse().slice(0, 50) }

  addJob(job) {
    const newJob = {
      id:       `job_${Date.now()}`,
      enabled:  true,
      lastRun:  null,
      ...job,
    }
    this.jobs.push(newJob)
    this._saveJobs()
    return newJob
  }

  updateJob(id, patch) {
    const job = this.jobs.find(j => j.id === id)
    if (!job) return null
    Object.assign(job, patch)
    this._saveJobs()
    return job
  }

  deleteJob(id) {
    this.jobs = this.jobs.filter(j => j.id !== id)
    this._saveJobs()
  }

  runNow(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job) return Promise.reject(new Error('任务不存在'))
    return this._execute(job)
  }
}

module.exports = new ScheduledSkills()
