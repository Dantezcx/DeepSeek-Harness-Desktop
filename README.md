# 🐋 DeepSeek-Harness-Desktop

**DSH（DeepSeek Harness）Windows 桌面客户端** —— 内置 UI、一键安装、云端快照备份、多端同步、用量统计，开箱即用。

> 致敬 [Tampermonkey（油猴）](https://www.tampermonkey.net/) 的云备份设计 —— 本项目的备份/恢复采用了"打包成带日期的快照、按时间点选择恢复"的思路，向这个伟大的浏览器扩展致敬。

---

## 📸 主界面

![主界面](docs/主界面.png)

- 窗口内嵌完整 DSH Web UI（不唤起浏览器）
- 底部状态栏实时显示：模型 / 方式 / 会话 tokens / 本次 tokens / 本次费用 / 会话费用 / 余额
- 右侧面板集成"概览"标签（工作区 / 服务 / 环境 / 插件 / 归档管理）
- 托盘常驻、关闭最小化到任务栏、退出自动停止服务

---

## 🚀 一键安装

- **Windows 安装包**：下载 `install-dsh-v1.1.0.exe`，双击安装（可自定义目录 + 自动创建桌面快捷方式）
- **便携版**：解压 `win-unpacked/`，双击 `DSH客户端.exe` 即用
- **更新日志**：详见 [CHANGELOG.md](CHANGELOG.md)
- **环境自检**：首次启动自动检测 Node.js / npm / dsh / pnpm，缺失时**一键安装**（国内镜像下载 + UAC 静默安装 + 自动装 dsh），并自动安装 dsh-web-ui 全家桶 / 插件市场 / 对话导入插件（安装即使用）
- **一键更新 dsh-web-ui**：`更新 dsh-web-ui.bat` 自动拉最新插件并重新打"概览"标签补丁

---

## 🎨 集成皮肤

客户端集成了 [**zhu1090093659/dsh-web-ui**](https://github.com/zhu1090093659/dsh-web-ui)（DeepSeek Harness Web UI 插件与皮肤合集，Apache-2.0）的**皮肤中心**，9 款皮肤可先试穿再应用：

| 皮肤 | 说明 |
|---|---|
| Windows XP（Luna） | 经典蓝色渐变 + 绿色开始按钮 |
| Minecraft 方块世界 | 像素天空盒 + 石板按钮 |
| Blue Fantasy 蓝色幻想 | 鲸鱼插画 + 靛蓝色调（暗色更佳） |
| 鲸吟（Whale Song） | 深海鲸语女神主题 |
| 交易终端 | 实时行情跑马灯（A股/港股/美股/加密） |
| QQ2008 / 同花顺 / 龙的传人 / 初音未来 | 怀旧与二次元风格 |

![集成皮肤](docs/集成皮肤.png)

> 皮肤与右侧面板（文件树/预览/Git 变更）均由 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 提供，安装方式：`dsh plugin --profile web add @linxin666/dsh-web-ui-all@0.1.12`

---

## 📂 侧边概览 + 取消归档（客户端独有增强）

右侧面板新增 **"概览"标签**，集成：工作区信息、服务状态、环境检测、插件统计，以及 **归档会话管理**。

![侧边概览+取消归档](docs/侧边概览+取消归档.png)

**为什么需要"取消归档"功能**：DSH 官方 README 明确写道 ——

> *"archived sessions have no viewing or unarchive surface. If you want to recover them, you can only manually edit `workspace.json` to remove the corresponding ID from the `archivedSessionIds` array, then restart the GUI to make them reappear in the sidebar."*

本客户端把这个"只能手改文件"的操作做成了**一键按钮**：概览 → 归档会话 → 点「取消归档」，自动改写 `workspace.json` 并重启服务，会话即刻回到侧边栏。

---

## ☁️ 云端同步（快照式备份）

受油猴云备份启发，采用**压缩包快照**方案：把 会话记录 / API 配置 / 设置与工作区状态 打包上传，按日期管理、随时回滚。

![云端同步](docs/云端同步.png)

**同步格式**：单个 `.tar.gz` 压缩包，命名规则 `dsh-backup-YYYYMMDD-HHMMSS.tar.gz`（如 `dsh-backup-20260815-031358.tar.gz`），由系统 `tar` 打包，内容结构：

```
dsh-backup-20260815-031358.tar.gz
├── sessions/                      # 会话记录（session.jsonl.zstd）
│   └── --工作区--/<会话ID>/
├── .credentials.yaml              # API 配置
├── settings.yaml / pet.json       # 设置
├── .anonymous-user-id
├── storages/workspace.json        # 工作区与归档状态
└── profiles/web/                  # 插件配置（不含 node_modules）
```

![备份格式](docs/备份格式.png)

- **备份**：一键打包上传，云端自动保留最近 **10 份**
- **恢复**：按日期选择快照，下载解压覆盖本地，并**自动重启服务**加载会话
- **传输方式**：WebDAV（群晖/坚果云等）或 Git（远程仓库，含版本历史）
- **多端同步**：Git push/pull 或 WebDAV 逐文件双向同步（会话/API/设置）

> ⚠️ 提示：WebDAV 密码以明文存于本地 `%APPDATA%\dsh-client\config.json`；API Key 同步到云端有泄露风险，请使用可信私有仓库。

---

## 🔧 开发

```bash
cd app
npm install
npm run dist        # 打包 NSIS 安装包（输出 release/）
```

## ⚠️ 说明

- 群晖 WebDAV 需对共享文件夹**父级**授予账号读写权限（否则返回 405）
- dsh-web-ui 更新后需重新打"概览"标签补丁（`scripts/patch-aionui.js`，幂等）

## 📄 License

MIT
