// dsh-plugin-ocr — DSH 本地 OCR 插件
//
// DeepSeek 模型无视觉模块（dsh-llm-deepseek 对 image content block 直接抛
// UNSUPPORTED_CONTENT），所以用户在会话里发图片目前会直接失败。本插件在
// agent/pre-step（用户消息写入 session 之前）拦截 image block，把图片字节
// 送本地 PaddleOCR-json 引擎识别成文本，再替换为 text block，让模型"读懂
// 图片"。
//
// 引擎：PaddleOCR-json v1.4.1（hiroi-sora/PaddleOCR-json），离线、中文优先。
//   安装位置：~/.dsh/ocr/PaddleOCR-json_v1.4.1/（可被 DSH_OCR_ENGINE 覆盖）
//   通信协议：stdin 逐行 JSON 指令，stdout 逐行 JSON 结果。
//
// 参考经验（autoks 答题助手沉淀）：
//   - 置信度过滤：低分文本行丢弃，避免把误识别内容喂给模型
//   - 保留换行结构（end 字段），保持版式可读性

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const name = 'dsh-plugin-ocr'
const inject = []

// ---------------------------------------------------------------- engine

const MIN_SCORE = 0.5        // 低于此置信度的文本行丢弃
const OCR_TIMEOUT_MS = 60000 // 单张图片 OCR 超时（首次启动模型加载可能较慢）
const MAX_B64 = 15 * 1024 * 1024 // 单张图片 base64 上限，防止大图卡死
const ATTACHMENT_ROOT = join(homedir(), '.dsh', 'attachments', 'v1') // durable 附件根

let engine = null      // { proc, idle, lineBuffer }
let enginePathCache = null

function resolveEnginePath() {
  if (enginePathCache) return enginePathCache
  const cands = [
    process.env.DSH_OCR_ENGINE,
    join(homedir(), '.dsh', 'ocr', 'PaddleOCR-json_v1.4.1', 'PaddleOCR-json.exe'),
  ].filter(Boolean)
  enginePathCache = cands.find((p) => existsSync(p)) || null
  return enginePathCache
}

function startEngine() {
  const exe = resolveEnginePath()
  if (!exe) throw new Error('未找到 PaddleOCR-json.exe（请安装到 ~/.dsh/ocr/ 或设置 DSH_OCR_ENGINE）')
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const proc = spawn(exe, [], {
    cwd: dirname(exe),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const engineObj = {
    proc,
    idle: Promise.resolve(),
    lineBuffer: '',
    queue: [],
    ready,
    _resolveReady: resolveReady,
    _rejectReady: rejectReady,
  }
  proc.stdout.on('data', (d) => {
    engineObj.lineBuffer += d.toString('utf8')
    let idx
    while ((idx = engineObj.lineBuffer.indexOf('\n')) >= 0) {
      const line = engineObj.lineBuffer.slice(0, idx).trim()
      engineObj.lineBuffer = engineObj.lineBuffer.slice(idx + 1)
      if (!line) continue
      if (line.includes('OCR init completed')) {
        engineObj._resolveReady?.(true)
      } else if (engineObj.queue.length) {
        engineObj.queue.shift()(line)
      }
    }
  })
  proc.on('error', (e) => {
    engineObj._rejectReady?.(e)
    rejectQueue(engineObj, '引擎进程错误: ' + e.message)
  })
  proc.on('exit', (code) => {
    engineObj._rejectReady?.(new Error('引擎进程退出 code=' + code))
    rejectQueue(engineObj, '引擎进程退出 code=' + code)
    if (engine === engineObj) engine = null
  })
  return engineObj
}

function rejectQueue(engineObj, msg) {
  while (engineObj.queue.length) engineObj.queue.shift()({ __error: msg })
}

function getEngine() {
  if (!engine) engine = startEngine()
  return engine
}

/** 发送一条指令，串行排队，返回解析后的结果对象。 */
function sendOnce(engineObj, obj) {
  const p = new Promise((resolve) => {
    engineObj.queue.push((line) => {
      try { resolve(JSON.parse(line)) }
      catch (e) { resolve({ code: 904, data: '结果解析失败: ' + e.message }) }
    })
  })
  engineObj.proc.stdin.write(JSON.stringify(obj) + '\n')
  return p
}

/** 对一张图片的 base64 做 OCR，返回识别文本（多行）。 */
async function ocrBase64(b64) {
  const eng = getEngine()
  await eng.ready
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('OCR 超时')), OCR_TIMEOUT_MS)
  })
  const result = await Promise.race([sendOnce(eng, { image_base64: b64 }), timeout])
  if (result.__error) throw new Error(result.__error)
  if (result.code !== 100) {
    if (result.code === 101) return '' // 未识别到文字
    throw new Error('OCR code=' + result.code + ': ' + JSON.stringify(result.data).slice(0, 200))
  }
  const lines = Array.isArray(result.data) ? result.data : []
  const parts = []
  for (const it of lines) {
    const text = String(it.text || '').trim()
    const score = Number(it.score)
    if (!text || score < MIN_SCORE) continue
    parts.push(text)
  }
  return parts.join('\n')
}

/** 优雅退出引擎（随 dsh web 进程退出）。 */
function shutdownEngine() {
  if (engine) {
    try { engine.proc.kill() } catch (e) {}
    engine = null
  }
}

// ---------------------------------------------------------------- hook

/** 从 image block 提取 base64 图片数据。
 * 两种形态：
 *  - {type:'image', data: base64} —— 客户端原始提交（未落盘）
 *  - {type:'image', attachment:{attachmentId:'sha256:<hex>', ...}} —— apiproxy
 *    durablePromptContent 已落盘，按 attachmentId 从 DSH_HOME/attachments/v1 读取
 */
async function imageBlockToBase64(block) {
  if (typeof block.data === 'string' && block.data) return block.data
  const ref = block.attachment
  if (ref && typeof ref.attachmentId === 'string' && ref.attachmentId.startsWith('sha256:')) {
    const hex = ref.attachmentId.slice('sha256:'.length)
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('attachmentId 格式无效: ' + ref.attachmentId)
    const p = join(ATTACHMENT_ROOT, 'objects', hex.slice(0, 2), hex)
    if (!existsSync(p)) throw new Error('附件文件不存在: ' + p)
    const buf = await readFile(p)
    return buf.toString('base64')
  }
  throw new Error('image block 既无 data 也无有效 attachment')
}

/** 把消息里的 image block 全部替换为 OCR 文本 block。
 * 返回新消息对象（原消息 content 是 frozen 只读，不能原地改）。 */
async function ocrMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : null
  if (!content) return message
  let changed = false
  const newContent = []
  for (const block of content) {
    if (!block || block.type !== 'image') { newContent.push(block); continue }
    try {
      const b64 = await imageBlockToBase64(block)
      if (b64.length > MAX_B64) {
        newContent.push({ type: 'text', text: '[图片跳过：超过 OCR 大小限制]' })
        changed = true
        continue
      }
      const text = await ocrBase64(b64)
      const body = text
        ? `[用户发送了一张图片，其文字内容已由本地 OCR 提取如下。请直接基于这些识别出的文字回答用户的问题，不要尝试查看或解释图片本身，也不要询问图片路径——图片内容就在下面：]\n${text}`
        : '[用户发送了一张图片，但本地 OCR 未识别出任何文字。请礼貌告知用户图片文字无法识别。]'
      newContent.push({ type: 'text', text: body })
      console.log('[dsh-plugin-ocr] image -> ' + text.split('\n').length + ' 行文本')
    } catch (e) {
      console.error('[dsh-plugin-ocr] OCR 失败: ' + e.message)
      newContent.push({ type: 'text', text: '[图片：OCR 识别失败（' + e.message + '）]' })
    }
    changed = true
  }
  return changed ? { ...message, content: newContent } : message
}

async function apply(ctx) {
  console.log('[dsh-plugin-ocr] 插件已加载, engine=' + (resolveEnginePath() || '未找到'))
  ctx.on('agent/pre-step', async (options, next) => {
    const messages = options && Array.isArray(options.messages) ? options.messages : null
    if (messages && messages.some((m) => (m.content || []).some((b) => b && b.type === 'image'))) {
      try {
        // 原 messages 数组元素只读，构造新消息对象后用 splice 原地替换
        // （agent-loop 的 inner 决策闭包引用同一个数组，替换对后续可见）
        const replaced = []
        for (const m of messages) replaced.push(await ocrMessage(m))
        messages.splice(0, messages.length, ...replaced)
      } catch (e) {
        console.error('[dsh-plugin-ocr] agent/pre-step 处理失败: ' + e.message)
      }
    }
    return next()
  })
  // 随进程退出关闭引擎
  process.once('exit', shutdownEngine)
}

export { apply, inject, name }
