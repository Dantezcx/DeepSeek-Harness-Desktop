# DSH 本地 OCR 读图功能 —— 实现全过程文档

> 项目：DeepSeek-Harness-Desktop
> 版本：兼容 v1.2.1
> 日期：2026-08-18
> 状态：✅ 已完成并端到端验证

---

## 一、背景与动机

**问题**：用户想让 DSH 客户端能"读懂图片"。但选用的 DeepSeek 模型（`deepseek-v4-flash`）**没有视觉模块**，原生不支持图片输入。在资源允许的前提下，把去年在 **autoks 答题辅助工具** 里沉淀的 OCR 经验迁移过来：**用本地 OCR 引擎先把图片转成文字，再把文字喂给模型**，让模型"虽然看不见图，但能读到图里的字"。

**难点**：不是简单接一个 OCR，而是要打通 DSH（DeepSeek Harness）这套 Cordis 插件体系里**消息从 UI 到模型的完整链路**，在正确的时机把图片替换成文本。

---

## 二、autoks OCR 经验的可复用资产（源头）

来源项目：`D:\Claude code\Reasonix\autoks`

| 资产 | 位置 | 状态 |
|---|---|---|
| PaddleOCR-json 引擎 | `autoks\desktop_client\paddleocr\PaddleOCR-json_v1.4.1\`（251MB，离线中文模型） | ✅ 直接复制复用 |
| 调用协议 | `autoks\desktop_client\PPOCR_api.py` —— **纯 JSON 行管道协议** | ✅ 改为 Node 直接 spawn，无需 Python |
| 调教经验 | `autoks\docs\调试经验总结.log` | ✅ 迁移了置信度过滤、换行保留 |

**决策**：`plugins/dsh-plugin-ocr` 不依赖 Python，直接用 Node 的 `child_process.spawn` 拉起 `PaddleOCR-json.exe`，走 stdin/stdout 逐行 JSON 通信（协议与 `PPOCR_api.py` 完全一致）。

---

## 三、关键技术调研：DSH 的图片链路（踩坑核心）

要接入 OCR，必须先摸清 DSH 里一张图片从拖入输入框到发给模型的完整链路。以下是一条一条读 DSH 源码得到的结论（都在全局 dsh 包 `node_modules/@deepseek-ai/...` 里）。

### 3.1 图片在 UI 层怎么表示

文件：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js`

- `sendSession(session, text, imageIds)`（`:133-137`）：把图片序列化成 content block，与文本一起进 `session.prompt(content)`。
- 图片 block 结构（`:271-280`）：
  ```js
  { type: 'image', mediaType: 'image/png', data: <base64>, name?: string }
  ```

### 3.2 服务端入口：两个"能力检查"拦截（第一个坑）

文件：`@deepseek-ai/dsh-host-apiproxy/lib/index.js`

HTTP RPC 入口 `session.prompt`（`:2829`）在消息进 agent loop **之前**就检查模型是否支持图片：

- `prompt` 入口（`:2845`）：若模型 `inputModalities` 不含 `image`，直接返回错误 `MODEL_DOES_NOT_SUPPORT_IMAGES`
  → UI 显示 **"当前模型不支持图片，请切换支持图片的模型"**（`dsh-client-ui-conversation/lib/client.js:5815`）
- `selectModel` 入口（`:2688`）：同样的检查，`model-unavailable`

> 这是用户最初遇到"当前模型不支持图片"的**真正元凶** —— 图片根本进不了 agent loop，更到不了任何后来的 hook。

### 3.3 落盘形态：从 base64 变成 durable attachment（第二个坑）

同一文件 `durablePromptContent`（`:913`）：apiproxy 把网络提交的 base64 图片**落盘保存**，消息里换成引用：

```js
{ type: 'image', attachment: { attachmentId: 'sha256:<64位hex>', mediaType, width, height, bytes } }
```

原始图片字节存到：`~/.dsh/attachments/v1/objects/<hex前2位>/<完整hex>`（规则见 `@deepseek-ai/dsh-attachment-local/lib/index.js:80`）。

> 所以**不能**只写"读 block.data"，真实链路里 `agent/pre-step` 收到的是 `attachment`，必须按 `attachmentId` 从磁盘读字节。

### 3.4 agent loop 的挂载点：`agent/pre-step`（最终选定的注入点）

- 文件：`@deepseek-ai/dsh-agent-loop/lib/index.js:501`
- **关键发现**：`agent/pre-step` 这个 waterfall 在用户消息**写进 session 之前**触发，`options.messages` 就是即将进入会话的消息。
- 对比 `llm/stream`（`@deepseek-ai/dsh-llm/lib/index.js:1389`）：那是"发给模型前"的 hook，但 `agent-loop` 造的请求是 **frozen 只读**（`dsh-agent-loop/lib/invariant.js` 校验 desync），且 cordis 的 `waterfall` `next()` 不接收参数改写 —— **在 `llm/stream` 改消息不可行**。
- 所以正确做法：**在 `agent/pre-step` 阶段就把 image block 替换成 OCR 文本 block**，落盘的就是纯文本，后段（frozen、adapter、DeepSeek 序列化）全部自然通过。

### 3.5 模型适配器：拒绝图片（为什么非转不可）

文件：`@deepseek-ai/dsh-llm-deepseek/lib/index.js:40-42`

```js
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}
```

DeepSeek 适配器只发纯文本。**结论：透明传递图片必然失败，必须在更早环节转成文本。**

### 3.6 为什么 cordis 插件可行 / 怎么挂载

- 插件格式：`export { apply, inject, name }`（参考 `dsh-chat-import`）
- 挂载：在 `~/.dsh/profiles/web/cordis.patch.yml` 加 insert 条目（client-only 插件走 patch，不进 `dsh.profile.bundles`；bundles 会因 `dsh.bundle` 校验崩溃，见 v1.1.10 的 `fixProfileBundles`）
- `ctx.on('agent/pre-step', ...)` 注册 hook，`next()` 令 waterfall 继续

---

## 四、实现（文件 + 关键逻辑）

### 4.1 新增文件

| 文件 | 说明 |
|---|---|
| `plugins/dsh-plugin-ocr/package.json` | 插件清单（name/version/main, ES module） |
| `plugins/dsh-plugin-ocr/index.mjs` | 插件主体：OCR 引擎管理 + agent/pre-step hook |
| `docs/OCR图片识别功能实现文档.md` | 本文档 |

### 4.2 引擎位置与查找

```js
const ATTACHMENT_ROOT = join(homedir(), '.dsh', 'attachments', 'v1')
function resolveEnginePath() {
  const cands = [
    process.env.DSH_OCR_ENGINE,                     // 允许覆盖
    join(homedir(), '.dsh', 'ocr', 'PaddleOCR-json_v1.4.1', 'PaddleOCR-json.exe'),
  ].find(p => existsSync(p))
}
```

引擎复制自 autoks，现安装于 `~/.dsh/ocr/PaddleOCR-json_v1.4.1/`（251MB）。

### 4.3 OCR 引擎封装（Node spawn + JSON 行协议）

与 `PPOCR_api.py` 相同的协议：

1. `spawn(PaddleOCR-json.exe, [], { cwd: exe父目录, windowsHide: true })`
2. 等 stdout 出现 `OCR init completed.` 视为就绪（`ready` Promise）
3. 发指令：`stdin.write(JSON.stringify({ image_base64: b64 }) + "\n")`
4. 读一行 stdout：`{ code: 100, data: [{ text, score, ... }] }`，`code === 100` 表示识别成功
5. 逐行过滤低置信度（`MIN_SCORE = 0.5`）、按 `end` 字段保换行、`parts.join('\n')`

增强项：
- 引擎单例复用（`getEngine()`），进程随 dsh web 退出自动 `kill`（`process.once('exit', shutdownEngine)`）
- 单张超时 60s（首次启动模型加载慢）
- base64 上限 15MB，超限跳过
- 失败降级为文字占位，**绝不阻塞/破坏正常消息流**

### 4.4 图片两种形态的统一读取

```js
async function imageBlockToBase64(block) {
  if (typeof block.data === 'string' && block.data) return block.data   // 原始 base64 提交
  const ref = block.attachment
  if (ref && ref.attachmentId.startsWith('sha256:')) {
    const hex = ref.attachmentId.slice('sha256:'.length)
    const p = join(ATTACHMENT_ROOT, 'objects', hex.slice(0, 2), hex)   // durable 附件
    return (await readFile(p)).toString('base64')
  }
  throw new Error('image block 既无 data 也无有效 attachment')
}
```

### 4.5 消息替换（frozen 安全）

- 原消息 `content` 数组是 **frozen**（不可原地改第 0 项），所以**构造新消息对象**：`{ ...message, content: newContent }`。
- 用 `messages.splice(0, messages.length, ...replaced)` 原地替换 claimed 数组的元素（数组本身可写，agent-loop 的 inner 决策闭包引用同一数组）。

### 4.6 注入的提示文本（关键：让模型不"诉苦看图"）

```js
`[用户发送了一张图片，其文字内容已由本地 OCR 提取如下。请直接基于这些识别出的文字回答用户的问题，不要尝试查看或解释图片本身，也不要询问图片路径——图片内容就在下面：]
${text}`
```

> 最初版本用中性的 `[图片内容（本地 OCR 识别）]`，实测模型仍会"我看不到图片、请给我路径"式诉苦。改为上面这段强指令后，模型直接基于文字作答。

---

## 五、客户端侧持久化补丁

改了全局 dsh 包 `node_modules/.../dsh-host-apiproxy/lib/index.js`（npm 升级 dsh 会被覆盖）。沿用项目已有的 `applyTerminalBashPatch` 模式，写成**幂等启动补丁**，客户端每次启动自动保证。

### 5.1 修改文件

- `D:\Claude code\DSH\DeepSeek-Harness-Desktop\src\main.js`：
  - 新增 `applyOcrImagePatch()`：用两段正则把 `dsh-host-apiproxy` 里两处能力检查改为 `if (false)` 放行并用 `/* [dsh-plugin-ocr patch] */` 标记（标记存在即幂等跳过）
  - `bootWeb()` 启动时调用，若 `changed` 则杀端口重启服务
- 已同步进已安装客户端 `D:\Apps\dsh\dsh-client\resources\app.asar`（解包→换 main.js→重打包）

### 5.2 补丁逻辑（幂等）

```js
if (s.includes('[dsh-plugin-ocr patch]')) return { ok: true, changed: false, ... } // 已打，跳过
// 否则两处 replace，写回
```

---

## 六、完整数据流（最终态）

```
用户在 GUI 拖入图片 + 文字
  → dsh-client-ui-conversation sendSession → content=[{image,data:base64},{text}]
  → session.prompt  (HTTP RPC /session.prompt)
  → dsh-host-apiproxy:
       ① durablePromptContent: base64 落盘 → 消息变 {image, attachment:{attachmentId:'sha256:...'}}
       ② 能力检查: applyOcrImagePatch 已放行 ✅（替换为 if(false)）
  → agent loop inbox
  → agent/pre-step  (cordis waterfall)
       → dsh-plugin-ocr: 扫描 image block
           imageBlockToBase64(attachment → 磁盘读字节)
           → spawn PaddleOCR-json.exe → OCR 文本
           → 替换 block 为 {text: '[用户发送了一张图片...]\n<OCR 文本>'}
       → next()
  → append user/message（落盘已是纯文本）
  → agent loop 构造请求（frozen，但内容已是纯文本）
  → dsh-llm-deepseek serializeMessages（assertTextOnly 通过 ✅）
  → DeepSeek API → 基于 OCR 文本回复
```

---

## 七、部署清单（换机器 / 重装时要记住）

1. **OCR 引擎**（251MB）已**随客户端安装包自动部署**：
   - 打包源：`src/ocr-engine/PaddleOCR-json_v1.4.1/`（本地构建资源，**已被 `.gitignore` 排除，不进 git**；首次构建前需从 `autoks\desktop_client\paddleocr\PaddleOCR-json_v1.4.1\` 复制一份到该目录）。
   - 打包：`src/package.json` 的 `build.extraResources` 把它映射进安装包 `resources/ocr-engine`。
   - 运行时：客户端启动时 `ensureOcrEngine()`（`src/main.js`）检测 `~/.dsh/ocr/PaddleOCR-json_v1.4.1/PaddleOCR-json.exe`，缺失则自动从安装包 `resources/ocr-engine` 复制过去（幂等，装完即用，无需手动复制）。
2. **插件源码**（在 git）：`plugins/dsh-plugin-ocr/`
   → 复制到 `~/.dsh/profiles/web/node_modules/dsh-plugin-ocr/`
3. **注册**：`~/.dsh/profiles/web/cordis.patch.yml` 加 `insert` 条目 `dsh-plugin-ocr`
4. **客户端补丁**：已内置 `applyOcrImagePatch()` 到 `src/main.js` 和 `app.asar`，启动自动打
5. **构建注意**：打包前确认 `src/ocr-engine/` 存在（.gitignore 已排除，需手动放一份），否则安装包内无引擎、`ensureOcrEngine` 会静默跳过（开发模式可先用 `~/.dsh/ocr` 手动引擎验证）。

---

## 八、验证记录

| 测试 | 方式 | 结果 |
|---|---|---|
| 引擎连通 | Node spawn + `image_base64` 识别测试图 | code:100，中文/英文/数字全中 |
| 插件 waterfall 单测 | cordis `Context` + `agent/pre-step` 手动触发 | image block → 4 行 OCR 文本 |
| 真实 RPC 端到端 | `/session.create` → `/session.prompt`(带图) | `accepted: true`（不再被拒） |
| 落盘校验 | `session.history` | user/message 为纯文本 `[用户发送了一张图片...]\n状态码：200OK\nDSH 图片转文字` |
| **真实模型调用** | `deepseek-v4-flash` 实际响应 | ✅ 正确回答"状态码 200 OK / DSH 图片转文字"，**无 UNSUPPORTED_CONTENT、无"看不到图"诉苦** |

---

## 九、已知限制

- OCR 引擎识别精度受图片质量影响：英文空格可能粘连（`hello world` → `helloworld`）、手写/艺术字效果差
- 引擎仅本地单机，251MB 需随机器自带
- 每张图会在 `agent/pre-step` 同步等待 OCR（首张含引擎冷启动约 2s，后续更快）
- 多图串行识别；base64 超 15MB 会跳过并提示
- 补丁直接改全局 dsh 包，依赖客户端启动时自动重打（已保证幂等）

---

## 十、相关文件索引

```
DeepSeek-Harness-Desktop/
├── src/main.js                        # 客户端主进程（applyOcrImagePatch 在这里）
├── plugins/dsh-plugin-ocr/
│   ├── index.mjs                      # OCR 插件主体（实现核心）
│   └── package.json
└── docs/OCR图片识别功能实现文档.md     # 本文档

全局 dsh 包（node_modules/@deepseek-ai/...）被读取/修改的关键文件：
- dsh-host-apiproxy/lib/index.js       # ⚠️被打补丁（2 处能力检查放行，备份 .bak-ocr）
- dsh-agent-loop/lib/index.js          # agent/pre-step hook 定义
- dsh-client-ui-conversation/lib/client.js  # 图片序列化 / "不支持图片"文案
- dsh-llm-deepseek/lib/index.js        # DeepSeek 拒绝图片的 assertTextOnly
- dsh-attachment-local/lib/index.js    # durable 附件落盘规则
- cordis/lib/index.js                  # waterfall 机制

运行数据：
- ~/.dsh/ocr/PaddleOCR-json_v1.4.1/    # OCR 引擎（复制自 autoks，251MB）
- ~/.dsh/profiles/web/cordis.patch.yml # 插件注册
- ~/.dsh/profiles/web/node_modules/dsh-plugin-ocr/  # 插件安装副本
- ~/.dsh/attachments/v1/               # 图片 durable 附件
```
