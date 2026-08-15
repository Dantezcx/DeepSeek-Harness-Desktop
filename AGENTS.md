# AGENTS.md — DeepSeek-Harness-Desktop（DSH 客户端）项目状态

> 项目级说明文件，Claude Code 与 dsh 会话共用（单一事实来源）。
> ⚠️ 本仓库为**开源**仓库：禁止写入任何账号、密码、Token、API Key、WebDAV 凭据等敏感信息。

## 项目概览

- **DeepSeek-Harness-Desktop**：DSH（DeepSeek Harness）Windows 桌面客户端（Electron）
- 远程仓库：`github.com/Dantezcx/DeepSeek-Harness-Desktop`（MIT，开源）
- 本地开发目录：`D:\Claude code\DSH\DeepSeek-Harness-Desktop`
- 本地测试安装（便携版）：`D:\Apps\dsh\dsh-client`——改代码后打包 `--win --dir`，覆盖其 `resources\app.asar` 即更新（需先退出客户端）

## 功能与实现要点

- **内置插件全家桶**（首次启动自动安装，`ensureWebUI` 幂等）：
  - `@linxin666/dsh-web-ui-all`（皮肤/右侧面板/任务看板/宠物）
  - `dsh-plugin-marketplace`（设置页插件市场，浏览/搜索/安装社区插件）
  - `dsh-chat-import`（历史对话导入）
  - 前提：自动确保 pnpm 可用（npm 全局安装）；pnpm 退出码非零（如 ERR_PNPM_IGNORED_BUILDS）不代表装包失败，需容错继续
- **插件注册机制**（关键）：
  - bundle 型插件（package.json 含 `dsh.bundle`）→ 注册进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`
  - 纯 client 型插件（只有 `dsh.client`，如 marketplace）→ **不能进 bundles**，走 `cordis.patch.yml` 的 insert 条目
  - `pruneInvalidBundles()` 每次启动自愈清理误注册（历史事故：marketplace 被误注册进 bundles → dsh 启动校验崩溃 → "dsh web 启动超时"）
- **补丁（幂等，插件更新后自动重打）**：
  - `applyOverviewPatch`：给 aionui-panel 的 client.js 加"概览"标签（锚点：`children: t("explorer.tabs.changes")`、ScmPanel 条件）
  - `applyMarketplaceTranslatePatch`：给 marketplace 详情面板加"🌐 翻译为中文"按钮（经 `window.api.translateText` → main 进程代理 Google 翻译，绕过浏览器 CORS）
- **设置页**：关闭最小化到托盘、同步设置（确认选项必勾）、WebDAV 测试连接、备份管理（创建备份并上传/刷新列表，备份含插件与插件设置）、底部作者署名「喵筱曦 · 开源免费使用（MIT）」
- **WebDAV 要点**：地址可含中文路径（davFetch 自动编码）；服务器 href 可能为相对/根相对/绝对三种形式（用 `new URL(h, baseUrl)` 统一解析）；`relFromDavUrl` 计算相对路径
- **备份快照**（tar.gz）：`backupPaths()` 打包 会话/API/设置 + `profiles/web` 插件配置与 `@linxin666` 插件本体；云端保留最近 10 份

## 构建与测试

- 依赖安装：`cd src && npm install`（node_modules 在本机）
- 完整安装包：`cd src && npm run dist` → `release/install-dsh-v1.0.0.exe`
- 快速迭代：`node node_modules/electron-builder/cli.js --win --dir` → `release/win-unpacked/`，把 `resources/app.asar` 复制到本地测试安装目录
- 已配置 `"npmRebuild": false`（纯 JS 无原生模块，勿改回）
- 镜像/缓存环境变量（国内网络）：`npm_config_cache`、`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- 打包若因沙箱权限失败（Access denied on D:\Apps）：需在更高权限模式下重试

## 约定

- 代码注释用简体中文；改动前先说明思路
- 所有功能最终需进安装包（"安装即使用"），但打包动作等用户测试确认后再做
- 会话结束不保存任何敏感凭证
