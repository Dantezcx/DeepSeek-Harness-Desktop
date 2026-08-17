const { app, BrowserWindow, dialog, Tray, Menu, ipcMain, nativeImage, WebContentsView } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PORT = 8123;
const APP_VERSION = (() => {
  try { return require('./package.json').version; } catch (e) { return '1.1.8'; }
})();
const URL  = `http://127.0.0.1:${PORT}`;
const BAR_H = 30;
let win = null;
let webView = null;   // dsh web / setup / loading
let barView = null;   // bottom status bar
let tray = null;
let forceQuit = false;

const LOG    = path.join(app.getPath('userData'), 'dsh-client.log');
const CONFIG = path.join(app.getPath('userData'), 'config.json');
const SETTINGS_HTML = path.join(__dirname, 'settings.html');
const SETUP_HTML    = path.join(__dirname, 'setup.html');
const STATUS_HTML   = path.join(__dirname, 'statusbar.html');
const PRELOAD       = path.join(__dirname, 'preload.js');
const STATUS_PRELOAD = path.join(__dirname, 'status-preload.js');
const ICON          = path.join(__dirname, 'icon.png');
const WORKSPACE_JSON = path.join(process.env.USERPROFILE || '', '.dsh', 'storages', 'workspace.json');
const LIXIN_DIR = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'node_modules', '@linxin666');

const NODE_DIR = 'C:\\Program Files\\nodejs';
const NPM_GLOBAL_DIR = path.join(process.env.APPDATA || '', 'npm');
const NODE_EXE = path.join(NODE_DIR, 'node.exe');
const NPM_CMD  = path.join(NODE_DIR, 'npm.cmd');
const DSH_CMD  = path.join(NPM_GLOBAL_DIR, 'dsh.cmd');

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}

// ---- usage/balance state (fed by preload DOM extraction + DeepSeek API) ----
let webStats = {};
let lastModel = null;
let maxInTokens = 0, maxOutTokens = 0;
let lastCost = 0, lastDeltaCost = 0;
let balance = null, balanceAt = 0;
let envCache = null, envCacheAt = 0;
const PRICING = { // CNY per 1M tokens (DeepSeek official)
  chat:   { in: 2, inHit: 0.5, out: 8 },
  reasoner: { in: 4, inHit: 1, out: 16 },
};
function pricingFor(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('reasoner') ? PRICING.reasoner : PRICING.chat;
}
function calcCost(s) {
  const p = pricingFor(s.model);
  const inTok = Number(s.inTokens) || 0;
  const hit = Number(s.cacheHits);
  const out = Number(s.outTokens) || 0;
  if (hit == null || isNaN(hit)) {
    // 页面未提供缓存命中数：长会话上下文大多命中缓存（¥0.5/1M），
    // 按命中价估算更贴近真实账单，避免按全价（¥2/1M）虚高 4 倍
    return (inTok * p.inHit + out * p.out) / 1e6;
  }
  const hitN = Math.max(0, Math.min(hit, inTok));
  return ((inTok - hitN) * p.in + hitN * p.inHit + out * p.out) / 1e6;
}
function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  if (v === 0) return '¥0.00';
  return '¥' + (v < 0.01 ? v.toFixed(4) : v.toFixed(2));
}
function fmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(v));
}
async function getBalance() {
  if (balance != null && Date.now() - balanceAt < 30000) return balance;
  balanceAt = Date.now();
  try {
    const cred = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml');
    if (!fs.existsSync(cred)) { balance = null; return balance; }
    const key = String(fs.readFileSync(cred, 'utf8')).match(/sk-[a-zA-Z0-9]+/);
    if (!key) { balance = null; return balance; }
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key[0] },
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json();
    balance = j.balance_infos && j.balance_infos[0] ? Number(j.balance_infos[0].total_balance) : null;
    log('balance fetched: ' + balance);
  } catch (e) { balance = null; log('balance error: ' + e.message); }
  return balance;
}

// ---- config ----
let config = { closeToTray: true, stopOnExit: false, autoStart: false };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch (e) {}
function saveConfig() {
  try { fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2)); log('config saved: ' + JSON.stringify(config)); }
  catch (e) { log('saveConfig error: ' + e.message); }
}

// ---- helpers ----
function portOpen(port, timeout = 500) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

function runVersion(candidates, fallbackCmd) {
  return new Promise(resolve => {
    const exe = candidates.find(p => fs.existsSync(p)) || fallbackCmd;
    // Get-Command guard: a missing command must NOT exit 0 ($LASTEXITCODE stays
    // stale/null on CommandNotFoundException, which would report "installed").
    const psScript = `if (Get-Command '${exe}' -ErrorAction SilentlyContinue) { & '${exe}' --version 2>$null | Out-Null; exit 0 } else { exit 1 }`;
    let c;
    try {
      c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'ignore', windowsHide: true });
    } catch (e) { return resolve(false); }
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} resolve(false); }, 8000);
    c.on('error', () => { clearTimeout(t); resolve(false); });
    c.on('exit', code => { clearTimeout(t); resolve(code === 0); });
  });
}

async function checkEnv() {
  const node = await runVersion([NODE_EXE], 'node');
  const npm  = await runVersion([NPM_CMD], 'npm');
  const dsh  = await runVersion([DSH_CMD, path.join(NODE_DIR, 'dsh.cmd')], 'dsh');
  const env = { node, npm, dsh };
  log('checkEnv: ' + JSON.stringify(env));
  return env;
}

function dshCmdPath() {
  return [DSH_CMD, path.join(NODE_DIR, 'dsh.cmd')].find(p => fs.existsSync(p)) || null;
}

function dshBinPath() {
  const cands = [
    path.join(NPM_GLOBAL_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(NODE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  return cands.find(p => fs.existsSync(p)) || null;
}

function vbsQuote(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

function startDSH() {
  const bin = dshBinPath();
  if (!bin) { log('startDSH: dsh bin.js not found'); return; }
  const nodeExe = fs.existsSync(NODE_EXE) ? NODE_EXE : 'node';
  const logFile = path.join(app.getPath('temp'), 'dsh-web.log');
  // wscript (GUI) + VBS with SW_HIDE (0): window-level hiding, more reliable than
  // CREATE_NO_WINDOW for console children spawned from a GUI Electron process.
  const cmdLine = `cmd /c ""${nodeExe}" "${bin}" web --port ${PORT} >> "${logFile}" 2>&1"`;
  const vbs = path.join(app.getPath('temp'), 'dsh-launch.vbs');
  fs.writeFileSync(vbs, 'Set s = CreateObject("WScript.Shell")\r\ns.Run ' + vbsQuote(cmdLine) + ', 0, False');
  const w = spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' });
  w.on('error', e => log('startDSH wscript error: ' + e.message));
  w.unref();
  log('startDSH: wscript ' + vbs + ' | ' + cmdLine);
}

async function ensureServer() {
  if (await portOpen(PORT)) { log('service already running'); return 'already'; }
  startDSH();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) { log('service is up'); return 'started'; }
    await new Promise(r => setTimeout(r, 800));
  }
  log('TIMEOUT waiting for service');
  return 'timeout';
}

function killByPort(port) {
  return new Promise(resolve => {
    const ps = spawn('powershell', [
      '-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
      `if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }`
    ], { stdio: 'ignore', windowsHide: true });
    ps.on('exit', code => { log('killByPort powershell exit=' + code); resolve(); });
    ps.on('error', e => { log('killByPort error: ' + e.message); resolve(); });
  });
}

// ---- environment setup (one-click install) ----
function execCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', d => out += d.toString());
    c.stderr.on('data', d => out += d.toString());
    c.on('error', reject);
    c.on('exit', code => code === 0 ? resolve(out) : reject(new Error(cmd + ' exit ' + code + ': ' + out)));
  });
}
function execPS(script) {
  return execCmd('powershell', ['-NoProfile', '-Command', script]);
}
function waitFile(p, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(p)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout waiting for ' + p)); }
    }, 1000);
  });
}
function progress(msg) {
  try {
    if (webView && !webView.webContents.isDestroyed()) webView.webContents.send('setup:progress', msg);
  } catch (e) {}
  log('setup: ' + msg);
}

// heartbeat-aware exec: reports progress every interval ms while the command runs
function execCmdLive(cmd, args, interval, onTick, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, Object.assign({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    const iv = setInterval(() => { try { onTick(); } catch (e) {} }, interval || 15000);
    c.on('error', (e) => { clearInterval(iv); reject(e); });
    c.on('exit', (code) => { clearInterval(iv); code === 0 ? resolve(out) : reject(new Error(cmd + ' exit ' + code + ': ' + out.slice(-200))); });
  });
}

async function setupInstall() {
  const env = await checkEnv();
  if (!env.node) {
    progress('下载 Node.js 安装包（国内镜像，可能需几分钟）...');
    await execCmdLive('powershell', ['-NoProfile', '-Command', [
      `$idx = Invoke-RestMethod 'https://npmmirror.com/mirrors/node/index.json' -TimeoutSec 30`,
      `$v = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version`,
      `$url = "https://npmmirror.com/mirrors/node/$v/node-$v-x64.msi"`,
      `Invoke-WebRequest $url -OutFile "$env:TEMP\\node-install.msi" -UseBasicParsing`,
    ].join('; ')], 20000, () => progress('仍在下载 Node.js…（网络较慢请耐心等待）'));
    progress('静默安装 Node.js（如弹出 UAC 请点"是"）...');
    await execPS(`Start-Process msiexec -ArgumentList '/i',\"$env:TEMP\\node-install.msi\",'/qn','/norestart' -Verb RunAs -Wait`);
    await waitFile(NODE_EXE, 180000);
    progress('Node.js 安装完成');
  }
  if (!(await checkEnv()).dsh) {
    const npm = fs.existsSync(NPM_CMD) ? NPM_CMD : 'npm';
    progress('配置 npm 全局安装目录...');
    await execCmd('cmd.exe', ['/c', npm, 'config', 'set', 'prefix', NPM_GLOBAL_DIR]);
    progress('正在通过 npm 安装 dsh（首次约需 2~5 分钟）...');
    await execCmdLive('cmd.exe', ['/c', npm, 'install', '-g', '@deepseek-ai/dsh'], 15000, () => progress('仍在安装 dsh…（下载依赖中，请耐心等待）'));
    await waitFile(DSH_CMD, 300000);
    progress('dsh 安装完成');
  }
  progress('环境就绪');
  return checkEnv();
}

// ---- quit ----
async function quitApp() {
  forceQuit = true;
  if (config.stopOnExit) {
    log('quitApp: stopping service (stopOnExit)');
    await killByPort(PORT);
  } else {
    log('quitApp: keeping dsh service running (常驻)');
  }
  app.quit();
}

// ---- autostart (registry Run key) ----
async function setAutoStart(on) {
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  try {
    if (on) {
      await execCmd('reg', ['add', runKey, '/v', 'DSHClient', '/t', 'REG_SZ', '/d', '"' + process.execPath + '" --autostart', '/f']);
    } else {
      await execCmd('reg', ['delete', runKey, '/v', 'DSHClient', '/f']);
    }
    log('autostart ' + (on ? 'enabled' : 'disabled'));
    return { ok: true };
  } catch (e) {
    log('autostart error: ' + e.message);
    return { ok: false, msg: e.message };
  }
}

// ---- settings window ----
let settingsWin = null;
function showSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 580, height: 680,
    minWidth: 480, minHeight: 520,
    resizable: true, minimizable: true, maximizable: true,
    title: 'DSH 客户端 - 设置',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(SETTINGS_HTML);
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---- tray ----
function createTray() {
  const icon = nativeImage.createFromPath(ICON);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('DSH 客户端');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '设置', click: showSettings },
    { type: 'separator' },
    { label: '退出（停止服务）', click: quitApp },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// ---- views layout ----
function layoutViews() {
  if (!win || win.isDestroyed()) return;
  const b = win.getContentBounds();
  const w = b.width, h = b.height;
  const mainH = Math.max(h - BAR_H, 0);
  if (webView) webView.setBounds({ x: 0, y: 0, width: w, height: mainH });
  if (barView) barView.setBounds({ x: 0, y: mainH, width: w, height: BAR_H });
}

// self-heal: remove bundles that lack a dsh.bundle manifest (client-only pkgs
// like dsh-plugin-marketplace must be mounted via cordis.patch.yml, not bundles)
function fixProfileBundles() {
  try {
    const p = path.join(DSH_DIR, 'profiles', 'web', 'package.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [];
    const bad = bundles.filter((b) => {
      try {
        const bp = path.join(DSH_DIR, 'profiles', 'web', 'node_modules', b, 'package.json');
        if (!fs.existsSync(bp)) return false;
        const m = JSON.parse(fs.readFileSync(bp, 'utf8'));
        return !(m.dsh && m.dsh.bundle);
      } catch (e) { return false; }
    });
    if (bad.length) {
      j.dsh.profile.bundles = bundles.filter((b) => !bad.includes(b));
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
      log('fixProfileBundles: removed invalid bundles: ' + bad.join(', '));
      return true;
    }
  } catch (e) {}
  return false;
}

// ---- terminal-bash 提速补丁（命令执行 3.5s → 50ms 快速通道）----
// 根因：dsh-terminal-bash 的 CONTROLLED_PROMPT 是 "dsh> "，而上层
// dsh-tool-bash-persistent 把 PS1 设为 __DSH_PERSISTENT_BASH_PROMPT__，
// 两边暗号对不上，底层只能等 3.5s 静默超时兜底。统一暗号即恢复原生快速通道。
// 幂等；修改的是全局 dsh 包（npm 升级 dsh 后会被覆盖，客户端启动时自动重打）。
function applyTerminalBashPatch() {
  const target = path.join(NPM_GLOBAL_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-terminal-bash', 'lib', 'index.js');
  if (!fs.existsSync(target)) {
    log('[tpatch] dsh-terminal-bash not found: ' + target);
    return { ok: false, changed: false, msg: 'dsh-terminal-bash 未找到' };
  }
  let s = fs.readFileSync(target, 'utf8');
  if (s.includes('__DSH_PERSISTENT_BASH_PROMPT__ ') && !s.includes('CONTROLLED_PROMPT = "dsh> "')) {
    return { ok: true, changed: false, msg: '已修复（幂等跳过）' };
  }
  const before = s;
  s = s.replace('const CONTROLLED_PROMPT = "dsh> ";', 'const CONTROLLED_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__ ";');
  s = s.replace('Math.max(0, 6 - this.promptTail.length)', 'Math.max(0, CONTROLLED_PROMPT.length - this.promptTail.length)');
  if (s === before) { log('[tpatch] 锚点未匹配，跳过'); return { ok: false, changed: false, msg: '锚点未匹配' }; }
  fs.writeFileSync(target, s);
  log('[tpatch] terminal-bash 提速补丁已应用');
  return { ok: true, changed: true, msg: '提速补丁已应用' };
}

// ---- OCR 图片放行补丁（dsh-plugin-ocr 依赖）----
// 根因：dsh-host-apiproxy 在 prompt/selectModel 入口检查模型 inputModalities，
// DeepSeek 无 image 能力 → 图片消息在进 agent loop 前就被拒（"当前模型不支持图片"）。
// dsh-plugin-ocr 会在 agent/pre-step 把 image block 转成 OCR 文本，模型实际只收到
// 文本，因此跳过该能力检查是安全且正确的。幂等；dsh 升级覆盖后客户端启动时自动重打。
function applyOcrImagePatch() {
  const target = path.join(NPM_GLOBAL_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js');
  if (!fs.existsSync(target)) {
    log('[ocrpatch] dsh-host-apiproxy not found: ' + target);
    return { ok: false, changed: false, msg: 'dsh-host-apiproxy 未找到' };
  }
  let s = fs.readFileSync(target, 'utf8');
  if (s.includes('[dsh-plugin-ocr patch]')) {
    return { ok: true, changed: false, msg: '已打补丁（幂等跳过）' };
  }
  const before = s;
  // 1) prompt 入口：MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝 → 放行
  s = s.replace(
    /if \(modelInfo\.inputModalities !== void 0 && !modelInfo\.inputModalities\.includes\("image"\)\) return err\(request, \{\n(\s*)code: "attachment-error",/,
    '/* [dsh-plugin-ocr patch] 放行图片（OCR 插件转文本） */\n$1if (false) return err(request, {\n$1code: "attachment-error",'
  );
  // 2) selectModel 入口：model-unavailable 拒绝 → 放行
  s = s.replace(
    /if \(info\.inputModalities !== void 0 && !info\.inputModalities\.includes\("image"\)\) return err\(request, \{\n(\s*)code: "model-unavailable",/,
    '/* [dsh-plugin-ocr patch] 放行图片（OCR 插件转文本） */\n$1if (false) return err(request, {\n$1code: "model-unavailable",'
  );
  if (s === before) { log('[ocrpatch] 锚点未匹配，跳过'); return { ok: false, changed: false, msg: '锚点未匹配' }; }
  fs.writeFileSync(target, s);
  log('[ocrpatch] OCR 图片放行补丁已应用');
  return { ok: true, changed: true, msg: 'OCR 图片放行补丁已应用' };
}

// ---- OCR 引擎自动部署（安装即用）----
// OCR 引擎（PaddleOCR-json，约 250MB）随安装包通过 extraResources 打进
// resources/ocr-engine。首次启动若 ~/.dsh/ocr 缺失则从安装包复制一份过去，
// 使 dsh-plugin-ocr 立即可用（插件默认引擎路径即 ~/.dsh/ocr）。幂等：引擎
// exe 存在即跳过；开发模式/未打包时 resources 无引擎，静默跳过。
function ocrEngineDir() {
  return path.join(process.env.USERPROFILE || '', '.dsh', 'ocr', 'PaddleOCR-json_v1.4.1');
}
function ensureOcrEngine() {
  try {
    const exe = path.join(ocrEngineDir(), 'PaddleOCR-json.exe');
    if (fs.existsSync(exe)) return { ok: true, changed: false, msg: '引擎已就绪（幂等跳过）' };
    const srcDir = path.join(process.resourcesPath, 'ocr-engine', 'PaddleOCR-json_v1.4.1');
    if (!fs.existsSync(path.join(srcDir, 'PaddleOCR-json.exe'))) {
      log('[ocr-engine] 安装包内无引擎资源（开发模式？），跳过自动部署');
      return { ok: false, changed: false, msg: '安装包无引擎资源' };
    }
    const copyRec = (from, to) => {
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const e of fs.readdirSync(from)) copyRec(path.join(from, e), path.join(to, e));
      } else {
        fs.copyFileSync(from, to);
      }
    };
    copyRec(srcDir, ocrEngineDir());
    log('[ocr-engine] OCR 引擎已部署到 ' + ocrEngineDir());
    return { ok: true, changed: true, msg: 'OCR 引擎已部署' };
  } catch (e) {
    log('[ocr-engine] 部署失败: ' + e.message);
    return { ok: false, changed: false, msg: '部署失败: ' + e.message };
  }
}

// ---- boot ----
async function bootWeb() {
  try { if (fixProfileBundles()) log('profile bundles fixed, service will use patched config'); } catch (e) {}
  // 终端提速补丁：改了全局 dsh 包，若服务已在运行需重启加载新代码
  try {
    const tp = applyTerminalBashPatch();
    if (tp.changed) { log('terminal-bash patched, restarting service'); await killByPort(PORT); }
  } catch (e) { log('terminal patch error: ' + e.message); }
  // OCR 图片放行补丁：dsh-plugin-ocr 依赖（改了全局 dsh 包）
  try {
    const op = applyOcrImagePatch();
    if (op.changed) { log('ocr-image patched, restarting service'); await killByPort(PORT); }
  } catch (e) { log('ocr patch error: ' + e.message); }
  // OCR 引擎部署：首次启动把安装包内资源复制到 ~/.dsh/ocr（安装即用，幂等）
  try {
    const oe = ensureOcrEngine();
    if (!oe.ok && oe.msg !== '安装包无引擎资源') log('ocr-engine error: ' + oe.msg);
  } catch (e) { log('ocr-engine error: ' + e.message); }
  const status = await ensureServer();
  if (status === 'timeout') {
    let diag = '(无日志)';
    try {
      const logFile = path.join(app.getPath('temp'), 'dsh-web.log');
      const out = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-800) : '';
      const err = fs.existsSync(logFile + '.err') ? fs.readFileSync(logFile + '.err', 'utf8').slice(-800) : '';
      const both = (out + '\n' + err).trim();
      if (both) diag = both;
    } catch (e) {}
    dialog.showErrorBox('DSH 客户端', 'dsh web 启动超时。\n启动日志:\n' + diag + '\n\n完整日志: ' + LOG);
    if (webView) webView.webContents.loadFile('loading.html');
  } else {
    webView.webContents.loadURL(URL);
  }
  win.setTitle('DSH 客户端');
}

app.whenReady().then(async () => {
  const isAutoStart = process.argv.includes('--autostart');
  if (isAutoStart) {
    log('autostart mode: silent service boot');
    await ensureServer();
    createTray();
    return; // tray-only, no window
  }
  win = new BrowserWindow({
    width: 1440, height: 900,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'DSH 客户端',
    icon: ICON,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });

  webView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(webView);

  barView = new WebContentsView({
    webPreferences: { preload: STATUS_PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  barView.setBackgroundColor('#161b22');
  win.contentView.addChildView(barView);

  webView.webContents.loadFile('loading.html');
  barView.webContents.loadFile(STATUS_HTML);
  win.on('resize', layoutViews);
  layoutViews();

  win.on('close', (e) => {
    if (config.closeToTray && !forceQuit) {
      e.preventDefault();
      win.hide();
      log('window close intercepted -> hidden (closeToTray)');
    }
  });
  win.on('closed', () => { win = null; });

  const env = await checkEnv();
  if (!env.node || !env.npm || !env.dsh) {
    webView.webContents.loadFile(SETUP_HTML);
    win.setTitle('DSH 客户端 - 环境检测');
  } else {
    await bootWeb();
  }
  createTray();
  scheduleAutoSync();
});

ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (e, cfg) => {
  const prevAuto = config.autoStart;
  config = { ...config, ...cfg };
  if (cfg.autoStart !== undefined && cfg.autoStart !== prevAuto) {
    setAutoStart(!!cfg.autoStart);
  }
  saveConfig();
  return config;
});
ipcMain.handle('setup:check', () => checkEnv());
ipcMain.handle('setup:install', () => setupInstall());
ipcMain.handle('setup:skip', async () => { await bootWeb(); return 'ok'; });
ipcMain.handle('status:get', async () => {
  const online = await portOpen(PORT);
  let workspace = '', sessions = 0;
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const first = Object.values((ws.tables && ws.tables.workspaces) || {})[0];
    if (first) { workspace = first.path || ''; sessions = (first.sessionIds || []).length; }
  } catch (e) {}
  if (!envCache || Date.now() - envCacheAt > 10000) {
    envCache = await checkEnv();
    envCacheAt = Date.now();
  }
  const bal = await getBalance();
  const inTok = Number(webStats.inTokens) || 0;
  const outTok = Number(webStats.outTokens) || 0;
  if (inTok > maxInTokens) maxInTokens = inTok;
  if (outTok > maxOutTokens) maxOutTokens = outTok;
  const thisCost = calcCost(webStats); // 当前快照的会话累计费用
  return {
    online, port: PORT, workspace, sessions, mode: 'web', version: APP_VERSION,
    model: webStats.model || lastModel || '未配置',
    sessTokens: fmtNum(inTok + outTok),       // 当前累计 tokens（不再分别取最大再相加）
    thisTokens: fmtNum(outTok),
    thisCost: fmtMoney(Math.max(0, lastDeltaCost)), // 本次增量费用（stats 推进基线）
    sessCost: fmtMoney(thisCost),             // 会话累计费用（不再取历史峰值）
    balance: bal != null ? '¥' + bal : '—',
  };
});
ipcMain.on('stats:from-web', (e, s) => {
  if (s && typeof s === 'object') {
    webStats = s;
    if (s.model) lastModel = s.model;
    const inTok = Number(s.inTokens) || 0, outTok = Number(s.outTokens) || 0;
    if (inTok > maxInTokens) maxInTokens = inTok;
    if (outTok > maxOutTokens) maxOutTokens = outTok;
    // 费用基线：页面累计值只增不减，增量 = 本次费用
    const c = calcCost(s);
    if (c > 0 && c >= lastCost) { lastDeltaCost = c - lastCost; lastCost = c; }
  }
});
ipcMain.on('debug:log', (e, msg) => log('web: ' + msg));
ipcMain.handle('ui:settings', () => showSettings());
ipcMain.handle('ui:quit', () => quitApp());

// ==================== 静默更新（GitHub Releases） ====================
const UPDATE_REPO = 'Dantezcx/DeepSeek-Harness-Desktop';
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
// GitHub 网页 releases/latest 会 302 重定向到 /releases/tag/<tag>，
// 不受 api.github.com 匿名限流（60 次/小时/IP，超限返回 403）影响。
// 跟随重定向后从最终 URL 解析最新 tag；失败抛错由调用方兜底。
async function latestTagFromRedirect() {
  const res = await fetch('https://github.com/' + UPDATE_REPO + '/releases/latest', {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const m = (res.url || '').match(/\/releases\/tag\/([^/?#]+)/);
  if (!m) throw new Error('无法解析最新版本');
  return String(m[1]).replace(/^v/i, '');
}

async function checkUpdate() {
  try {
    // 优先 GitHub API（可带更新说明）；遇限流 403 或其它失败时回退到
    // releases/latest 网页重定向，避免"检查更新失败 HTTP 403"。
    let latest = '', notes = '';
    try {
      const res = await fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', {
        headers: { 'User-Agent': 'dsh-client', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const j = await res.json();
        latest = String(j.tag_name || '').replace(/^v/i, '');
        notes = String(j.body || '').slice(0, 600);
      } else {
        log('checkUpdate: API HTTP ' + res.status + ' (rate-limited?), fallback to redirect');
      }
    } catch (e) {
      log('checkUpdate: API error ' + e.message + ', fallback to redirect');
    }
    if (!latest) latest = await latestTagFromRedirect();
    const hasUpdate = compareVersions(latest, APP_VERSION) > 0;
    log('checkUpdate: current=' + APP_VERSION + ' latest=' + latest + ' has=' + hasUpdate);
    return { ok: true, hasUpdate, current: APP_VERSION, latest, url: 'https://github.com/' + UPDATE_REPO + '/releases/tag/v' + latest, notes };
  } catch (e) {
    log('checkUpdate error: ' + e.message);
    return { ok: false, msg: '检查更新失败: ' + e.message };
  }
}
// ---- 下载一段（支持 Range）----
function downloadRange(proto, url, start, end, tmp, onChunk, onChunkFull) {
  return new Promise((resolve) => {
    const handler = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        res.resume();
        const next = /^https?:/.test(loc) ? loc : new URL(loc, url).toString();
        downloadRange(proto, next, start, end, tmp, onChunk, onChunkFull).then(resolve);
        return;
      }
      const okCode = res.statusCode === 206 || res.statusCode === 200;
      if (!okCode) { res.resume(); resolve({ ok: false, err: 'HTTP ' + res.statusCode }); return; }
      const ws = fs.createWriteStream(tmp);
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (onChunk) onChunk(c.length);
        if (start === undefined && onChunkFull) onChunkFull(got);
      });
      res.on('error', (e) => resolve({ ok: false, err: e.message }));
      ws.on('error', (e) => resolve({ ok: false, err: '写盘: ' + e.message }));
      ws.on('finish', () => resolve({ ok: true, size: got, end }));
      res.pipe(ws);
    };
    let headers = { 'User-Agent': 'dsh-client' };
    if (start !== undefined && end !== undefined) headers['Range'] = 'bytes=' + start + '-' + end;
    const req = proto.request(url, { headers }, handler);
    req.setTimeout(15000, () => { req.destroy(new Error('连接超时')); });
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.end();
  });
}

// 多线程分段下载：并发 N 段 + Range 分片，达到接近限速上限的吞吐。
// 若源不支持 Range（返回全量200），退化为单连接整段下载。
function downloadNode(url, dest, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https:') ? https : http;
    const probe = proto.request(url, { headers: { 'User-Agent': 'dsh-client', Range: 'bytes=0-0' } }, (pr) => {
      if (pr.statusCode >= 300 && pr.statusCode < 400 && pr.headers.location) {
        const loc = pr.headers.location;
        pr.resume();
        probeRange(/^https?:/.test(loc) ? loc : new URL(loc, url).toString(), proto, dest, timeoutMs, onProgress, resolve);
        return;
      }
      const cr = pr.headers['content-range'] || '';
      const m = /bytes \d+-\d+\/(\d+)/.exec(cr);
      pr.resume();
      if (m) return parallelDownload(url, proto, dest, parseInt(m[1], 10), timeoutMs, onProgress, resolve);
      return singleDownload(url, proto, dest, timeoutMs, onProgress, resolve);
    });
    probe.setTimeout(15000, () => probe.destroy(new Error('探测超时')));
    probe.on('error', (e) => resolve({ ok: false, err: e.message }));
    probe.end();
  });
}

function probeRange(url, proto, dest, timeoutMs, onProgress, resolve) {
  const pr = proto.request(url, { headers: { 'User-Agent': 'dsh-client', Range: 'bytes=0-0' } }, (r2) => {
    if (r2.statusCode >= 300 && r2.statusCode < 400 && r2.headers.location) {
      const loc = r2.headers.location;
      r2.resume();
      probeRange(/^https?:/.test(loc) ? loc : new URL(loc, url).toString(), proto, dest, timeoutMs, onProgress, resolve);
      return;
    }
    const cr = r2.headers['content-range'] || '';
    const m = /bytes \d+-\d+\/(\d+)/.exec(cr);
    r2.resume();
    if (m) return parallelDownload(url, proto, dest, parseInt(m[1], 10), timeoutMs, onProgress, resolve);
    return singleDownload(url, proto, dest, timeoutMs, onProgress, resolve);
  });
  pr.setTimeout(15000, () => pr.destroy(new Error('探测超时')));
  pr.on('error', (e) => resolve({ ok: false, err: e.message }));
  pr.end();
}

function parallelDownload(url, proto, dest, total, timeoutMs, onProgress, resolve) {
  const N = 8;
  const CHUNK = Math.ceil(total / N);
  const tmpDir = path.join(app.getPath('temp'), 'dsh-upd-' + Date.now() + Math.floor(Math.random() * 100000));
  let parts = [];
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (let i = 0; i < N; i++) {
      const s = i * CHUNK, e = Math.min((i + 1) * CHUNK - 1, total - 1);
      if (s <= e) parts.push({ i, s, e, file: path.join(tmpDir, 'p' + i + '.bin'), ok: false });
    }
  } catch (e) { return singleDownload(url, proto, dest, timeoutMs, onProgress, resolve); }
  let doneCount = 0, totalGot = 0;
  const update = () => { if (onProgress) onProgress(Math.min(1, totalGot / total)); };
  const finish = (ok, err) => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {}
    resolve({ ok, size: totalGot, err });
  };
  parts.forEach((pt) => {
    const dl = (retry) => {
      downloadRange(proto, url, pt.s, pt.e, pt.file, (n) => { totalGot += n; update(); }).then((r) => {
        const want = pt.e - pt.s + 1;
        if (r.ok && fs.existsSync(pt.file) && fs.statSync(pt.file).size >= want) {
          pt.ok = true;
        } else if (retry) { return dl(false); }
        doneCount++;
        if (doneCount >= parts.length) {
          if (parts.every((p) => p.ok)) {
            try {
              const out = fs.createWriteStream(dest);
              let wi = 0;
              const writeNext = () => {
                if (wi >= parts.length) { out.end(); setTimeout(() => resolve({ ok: true, size: total, err: '' }), 50); return; }
                const rd = fs.createReadStream(parts[wi].file);
                rd.on('error', () => finish(false, '拼接读失败'));
                rd.on('end', () => { wi++; writeNext(); });
                rd.pipe(out, { end: false });
              };
              writeNext();
            } catch (e3) { finish(false, '拼接: ' + e3.message); }
          } else {
            finish(false, '分片失败(' + parts.filter((p) => !p.ok).map((p) => p.i).join(',') + ')');
          }
        }
      });
    };
    dl(true);
  });
}

function singleDownload(url, proto, dest, timeoutMs, onProgress, resolve) {
  downloadRange(proto, url, undefined, undefined, dest, null, (n) => {
    if (onProgress) onProgress(0); // 单连接无总量时不推进度，交给 doUpdate 的 size 校验
  }).then((r) => {
    resolve({ ok: r.ok, size: r.size, err: r.err });
  });
}

async function doUpdate() {
  try {
    const chk = await checkUpdate();
    if (!chk.ok) return chk;
    if (!chk.hasUpdate) return { ok: false, msg: '已是最新版本 ' + APP_VERSION };
    const exeName = 'install-dsh-v' + chk.latest + '.exe';
    const url = 'https://github.com/' + UPDATE_REPO + '/releases/download/v' + chk.latest + '/' + exeName;
    const tmp = path.join(app.getPath('temp'), 'dsh-update-' + chk.latest + '.exe');
    // 下载：直连 + GitHub 镜像兜底（用 Node 直连，不走系统代理）
    let saved = false, lastErr = '';
    const mirrors = ['https://ghproxy.net/', 'https://ghfast.top/', 'https://gh-proxy.com/', ''];
    for (const m of mirrors) {
      const full = m + url;
      log('update download start: ' + (m || '直连') + ' (Node 直连)');
      const r = await downloadNode(full, tmp, 180000, (p) => {
        try { barView && barView.webContents && barView.webContents.send('update:progress', { percent: Math.round(p * 100), mirror: m || '直连' }); } catch (e) {}
      });
      if (r.ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 100000) {
        saved = true;
        log('update downloaded via ' + (m || '直连') + ' ' + Math.round(r.size / 1024 / 1024) + 'MB');
        break;
      }
      lastErr = m + ':' + (r.err || '文件异常');
      log('update download ' + (m || '直连') + ' failed: ' + (r.err || '文件异常'));
      if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (e) {} }
    }
    if (!saved) return { ok: false, msg: '下载安装包失败（' + lastErr + '），请稍后重试或手动下载安装包' };
    // 静默安装（NSIS /S），短暂延迟后退出客户端
    const c = spawn(tmp, ['/S'], { detached: true, stdio: 'ignore' });
    c.on('error', (e) => log('update spawn error: ' + e.message));
    c.unref();
    setTimeout(() => { quitApp(); }, 1500);
    return { ok: true, msg: '更新已开始（' + APP_VERSION + ' → ' + chk.latest + '），客户端将自动退出，安装完成后重新打开即可使用' };
  } catch (e) {
    log('doUpdate error: ' + e.message);
    return { ok: false, msg: '更新失败: ' + e.message };
  }
}
ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('update:do', () => doUpdate());

// ==================== sync (git / webdav) ====================
const DSH_DIR = path.join(process.env.USERPROFILE || '', '.dsh');
const SYNC_GITIGNORE = [
  'node_modules/', 'profiles/*/node_modules/',
  '*.log', '.git/', '.DS_Store', 'profiles/*/pnpm-lock.yaml', 'profiles/*/pnpm-workspace.yaml',
].join('\n');

function syncSelectedPaths() {
  const c = (config.sync && config.sync.content) || {};
  const paths = [];
  if (c.sessions) paths.push('sessions');
  if (c.api) paths.push('.credentials.yaml');
  if (c.settings) paths.push('settings.yaml', 'pet.json', '.anonymous-user-id', 'storages', 'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml', 'profiles/web/package.json');
  return paths;
}
// tar.gz 快照备份：在逐文件同步内容之外，额外打包插件本体与其配置
// （dsh-web-ui 全家桶 @linxin666、pnpm 依赖锁定文件），恢复后开箱即用
function backupPaths() {
  const c = (config.sync && config.sync.content) || {};
  const paths = [];
  if (c.sessions) paths.push('sessions');
  if (c.api) paths.push('.credentials.yaml');
  if (c.settings) paths.push(
    'settings.yaml', 'pet.json', '.anonymous-user-id', 'storages',
    'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml',
    'profiles/web/package.json', 'profiles/web/pnpm-workspace.yaml', 'profiles/web/pnpm-lock.yaml',
    'profiles/web/node_modules/@linxin666'
  );
  return paths;
}
function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    c.on('error', reject);
    c.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error('git ' + args[0] + ' exit ' + code + ': ' + out.slice(-300))));
  });
}
async function gitSync() {
  const g = (config.sync && config.sync.git) || {};
  const remote = (g.remote || '').trim();
  if (!remote) return { ok: false, msg: '未配置 Git 远程地址' };
  if (!fs.existsSync(path.join(DSH_DIR, '.git'))) {
    await execGit(['init'], DSH_DIR);
    try { await execGit(['branch', '-M', 'main'], DSH_DIR); } catch (e) {} // unify branch name
    const gi = path.join(DSH_DIR, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, SYNC_GITIGNORE);
  }
  try { await execGit(['config', 'user.name', 'dsh-sync'], DSH_DIR); } catch (e) {}
  try { await execGit(['config', 'user.email', 'dsh-sync@local'], DSH_DIR); } catch (e) {}
  try { await execGit(['remote', 'remove', 'origin'], DSH_DIR); } catch (e) {}
  await execGit(['remote', 'add', 'origin', remote], DSH_DIR);
  const paths = syncSelectedPaths();
  try { await execGit(['add', '--', ...paths], DSH_DIR); } catch (e) { log('git add: ' + e.message); }
  const st = await execGit(['status', '--porcelain'], DSH_DIR);
  if (st.trim()) {
    await execGit(['commit', '-m', 'dsh sync ' + new Date().toISOString()], DSH_DIR);
  }
  // pull (rebase) then push; on conflict keep local state
  try { await execGit(['pull', '--rebase', 'origin', 'main'], DSH_DIR); }
  catch (e) { log('git pull conflict, keep local: ' + e.message); }
  await execGit(['push', 'origin', 'HEAD:main'], DSH_DIR);
  return { ok: true, msg: 'Git 同步完成' };
}

// ---- WebDAV (https + PROPFIND/PUT/GET) ----
function davFetch(method, url, { body, headers, timeout = 20000 } = {}) {
  // 编码非 ASCII 字符（如中文路径段），不破坏已有 %XX
  url = url.replace(/[^\x00-\x7F]/g, (c) => encodeURIComponent(c));
  return fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeout) });
}
function davAuth(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}
async function davMkcol(url, auth, timeout = 20000) {
  const res = await davFetch('MKCOL', url, { headers: { Authorization: auth }, timeout });
  // 201 created / 405 already exists / any 2xx are fine; everything else is an error
  if (res.status !== 201 && res.status !== 405 && !(res.status >= 200 && res.status < 300)) {
    throw new Error('MKCOL ' + res.status);
  }
}
async function davList(url, auth) {
  // PROPFIND depth:1 -> [{path, url, lastModified(ms)}]
  const res = await davFetch('PROPFIND', url, { headers: { Authorization: auth, Depth: '1' } });
  if (!res.ok) throw new Error('PROPFIND ' + res.status);
  const xml = await res.text();
  // 以请求 URL（补尾斜杠）为基准解析 href，兼容相对/根相对/绝对三种形式
  //（Synology 返回根相对路径，origin+h 拼接会错位）
  const baseUrl = /\/$/.test(url) ? url : url + '/';
  const hrefRe = /<[A-Za-z0-9_-]+:href>([^<]+)<\/[A-Za-z0-9_-]+:href>/g;
  const lmRe = /<[A-Za-z0-9_-]+:getlastmodified>([^<]+)<\/[A-Za-z0-9_-]+:getlastmodified>/g;
  const szRe = /<[A-Za-z0-9_-]+:getcontentlength>([^<]+)<\/[A-Za-z0-9_-]+:getcontentlength>/g;
  let m;
  const out = [];
  while ((m = hrefRe.exec(xml))) {
    const h = m[1];
    let full;
    try { full = new globalThis.URL(h, baseUrl).href; } catch (e) { full = baseUrl + h; }
    out.push({ path: decodeURIComponent(h), url: full, lastModified: null, size: null });
  }
  const lms = [];
  while ((m = lmRe.exec(xml))) lms.push(Date.parse(m[1]));
  const sizes = [];
  while ((m = szRe.exec(xml))) sizes.push(parseInt(m[1], 10) || null);
  out.forEach((it, i) => {
    it.lastModified = lms[i] || null;
    it.size = sizes[i] || null;
  });
  return out;
}
async function davListRecursive(url, auth) {
  const out = [];
  const stack = [url];
  while (stack.length) {
    const cur = stack.pop();
    const curNorm = cur.replace(/\/+$/, '');
    let items = [];
    try { items = await davList(cur, auth); } catch (e) {}
    for (const it of items) {
      const urlNorm = it.url.replace(/\/+$/, '');
      if (urlNorm === curNorm) continue; // skip self
      if (it.path.endsWith('/')) stack.push(it.url);
      else out.push(it);
    }
  }
  return out;
}
// extract relative path under the sync root from a full DAV url
//（两端统一走 URL 规范化，兼容中文路径被 %XX 编码后与 root 前缀匹配）
function relFromDavUrl(fullUrl, root) {
  let p = String(fullUrl || '');
  let r = String(root || '').replace(/\/+$/, '');
  try { p = new globalThis.URL(p).href; } catch (e) {}
  try { r = new globalThis.URL(r).href; } catch (e) {}
  r = r.replace(/\/+$/, '') + '/';
  if (p.startsWith(r)) {
    p = p.slice(r.length);
  } else {
    try { p = new globalThis.URL(p).pathname.replace(/^\/+/, ''); } catch (e) {}
  }
  return decodeURIComponent(p.replace(/\/+$/, ''));
}
async function davGet(url, auth) {
  const res = await davFetch('GET', url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error('GET ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
async function davPut(url, buf, auth) {
  const headers = { Authorization: auth, 'Content-Type': 'application/octet-stream' };
  let res = await davFetch('PUT', url, { body: buf, headers });
  if (res.status === 409) {
    // Synology WebDAV refuses overwriting an existing file with PUT;
    // delete first, then retry.
    try { await davFetch('DELETE', url, { headers: { Authorization: auth } }); } catch (e) {}
    res = await davFetch('PUT', url, { body: buf, headers });
  }
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('PUT ' + res.status);
}
function collectSyncFiles() {
  const c = (config.sync && config.sync.content) || {};
  const files = [];
  const rel = (p) => path.relative(DSH_DIR, p).split(path.sep).join('/');
  const addDir = (dir) => {
    const d = path.join(DSH_DIR, dir);
    if (!fs.existsSync(d)) return;
    const walk = (cur) => {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.name.endsWith('.lock')) files.push({ local: p, rel: rel(p) });
      }
    };
    walk(d);
  };
  if (c.sessions) addDir('sessions');
  if (c.settings) addDir('storages');
  if (c.api && fs.existsSync(path.join(DSH_DIR, '.credentials.yaml'))) files.push({ local: path.join(DSH_DIR, '.credentials.yaml'), rel: '.credentials.yaml' });
  if (c.settings) {
    for (const f of ['settings.yaml', 'pet.json', '.anonymous-user-id', 'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml', 'profiles/web/package.json']) {
      const p = path.join(DSH_DIR, f);
      if (fs.existsSync(p)) files.push({ local: p, rel: f.split(path.sep).join('/') });
    }
  }
  return files;
}
async function webdavSync() {
  const w = (config.sync && config.sync.webdav) || {};
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return { ok: false, msg: 'WebDAV 配置不完整（地址/用户名/密码）' };
  const auth = davAuth(w.user, w.pass);
  const root = base + '/dsh-sync';
  const errors = [];
  const ensureDir = async (relDir) => {
    const parts = relDir.split('/').filter(Boolean);
    let cur = root;
    for (const p of parts) {
      cur += '/' + p;
      try { await davMkcol(cur, auth); }
      catch (e) { errors.push('建目录 ' + p + ': ' + e.message); return; }
    }
  };
  const files = collectSyncFiles();
  for (const f of files) {
    try {
      const parent = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
      await ensureDir(parent);
      const buf = fs.readFileSync(f.local);
      const url = root + '/' + f.rel;
      const remoteLast = await davList(parent ? root + '/' + parent : root, auth).catch(() => []);
      const item = remoteLast.find((x) => {
        const p = decodeURIComponent(x.path);
        return p === f.rel || p.endsWith('/' + f.rel);
      });
      if (!item || !item.lastModified || fs.statSync(f.local).mtimeMs > item.lastModified) {
        await davPut(url, buf, auth);
      }
    } catch (e) {
      errors.push(f.rel + ': ' + e.message);
    }
  }
  try {
    // 会话为多级目录（sessions/<工作区>/<会话ID>/...），depth-1 只列一层 → 递归拉取
    const remote = await davListRecursive(root + '/sessions', auth).catch(() => []);
    for (const item of remote) {
      const rel = relFromDavUrl(item.url, root); // e.g. 'sessions/<ws>/<id>/session.jsonl.zstd'
      if (!rel || rel === 'sessions' || !rel.startsWith('sessions/')) continue;
      const local = path.join(DSH_DIR, rel.split('/').join(path.sep));
      if (!fs.existsSync(local) || (item.lastModified && item.lastModified > fs.statSync(local).mtimeMs)) {
        try {
          const buf = await davGet(item.url, auth);
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, buf);
        } catch (e) { errors.push('pull ' + rel + ': ' + e.message); }
      }
    }
  } catch (e) { errors.push('pull: ' + e.message); }
  if (errors.length) {
    const sample = errors.slice(0, 3).join(' ; ');
    return { ok: false, msg: '同步失败（' + errors.length + ' 个文件）：' + sample + (errors.length > 3 ? ' …' : '') };
  }
  return { ok: true, msg: 'WebDAV 同步完成' };
}

async function syncNow() {
  const s = config.sync || {};
  const t0 = Date.now();
  let result;
  try {
    if (s.method === 'git') result = await gitSync();
    else if (s.method === 'webdav') result = await webdavSync();
    else return { ok: false, msg: '未启用同步' };
  } catch (e) {
    result = { ok: false, msg: e.message };
  }
  s.lastSync = new Date().toISOString();
  s.lastStatus = result.msg;
  saveConfig();
  log('sync result: ' + result.msg);
  return result;
}

// ---- restore from cloud (overwrites local with cloud state) ----
async function webdavRestore() {
  const w = (config.sync && config.sync.webdav) || {};
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return { ok: false, msg: 'WebDAV 配置不完整' };
  const auth = davAuth(w.user, w.pass);
  const root = base + '/dsh-sync';
  const items = await davListRecursive(root, auth);
  if (!items.length) return { ok: true, msg: '云端没有备份文件（先执行一次同步）' };
  let restored = 0;
  const errors = [];
  for (const it of items) {
    const rel = relFromDavUrl(it.url, root);
    if (!rel) continue;
    const local = path.join(DSH_DIR, rel.split('/').join(path.sep));
    try {
      const buf = await davGet(it.url, auth);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, buf);
      restored++;
    } catch (e) { errors.push(rel + ': ' + e.message); }
  }
  if (errors.length) return { ok: false, msg: '恢复 ' + restored + ' 个，失败 ' + errors.length + '：' + errors.slice(0, 2).join(' ; ') + (errors.length > 2 ? ' …' : '') };
  return { ok: true, msg: '已从云端恢复 ' + restored + ' 个文件' };
}
async function gitRestore() {
  await execGit(['fetch', 'origin', 'main'], DSH_DIR);
  await execGit(['reset', '--hard', 'origin/main'], DSH_DIR);
  return { ok: true, msg: '已恢复到云端（origin/main）最新版本' };
}
async function restoreNow() {
  const s = config.sync || {};
  let result;
  try {
    if (s.method === 'git') result = await gitRestore();
    else if (s.method === 'webdav') result = await webdavRestore();
    else return { ok: false, msg: '未启用同步' };
  } catch (e) {
    result = { ok: false, msg: e.message };
  }
  s.lastRestore = new Date().toISOString();
  s.lastStatus = result.msg;
  saveConfig();
  log('restore result: ' + result.msg);
  return result;
}
let autoSyncTimers = [];
function scheduleAutoSync() {
  const s = config.sync || {};
  clearAutoSyncTimers();
  if (!s.auto) { log('auto sync: disabled (auto=false), timers cleared'); return; }
  const mins = Math.max(1, Number(s.intervalMin) || 30);
  const first = setTimeout(() => { syncNow(); }, 60000);
  const iv = setInterval(syncNow, mins * 60000);
  autoSyncTimers = [first, iv];
  log('auto sync: scheduled (first in 60s, then every ' + mins + ' min)');
}
function clearAutoSyncTimers() {
  for (const t of autoSyncTimers) { try { clearTimeout(t); clearInterval(t); } catch (e) {} }
  autoSyncTimers = [];
}
ipcMain.handle('sync:get-config', () => (config.sync || {}));
ipcMain.handle('sync:save-config', (e, sc) => {
  config.sync = sc;
  saveConfig();
  scheduleAutoSync();
  return config.sync;
});
ipcMain.handle('sync:now', () => syncNow());
ipcMain.handle('sync:restore', () => restoreNow());

// ==================== inherit external AI rules ====================
const RULE_CANDIDATES = [
  ['Claude Code', ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/CLAUDE.local.md']],
  ['Cursor', ['.cursor/rules/*.mdc', '.cursorrules', '.cursor/rules/*.md']],
  ['Gemini', ['GEMINI.md', '.gemini/GEMINI.md']],
  ['Codex', ['CODEX.md', '.codex/CODEX.md']],
  ['Copilot', ['.github/copilot-instructions.md']],
  ['DSH', ['.dsh/AGENTS.md', 'AGENTS.md', '.dsh/REASONIX.md', 'REASONIX.md']],
];
function expandRules() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cwd = process.cwd();
  const roots = [home, cwd, path.join(home, 'AppData', 'Roaming', 'Claude')];
  const out = [];
  for (const [tool, pats] of RULE_CANDIDATES) {
    for (const p of pats) {
      const hasGlob = p.includes('*');
      if (!hasGlob) {
        for (const r of roots) {
          const f = path.join(r, p.split('/').join(path.sep));
          if (fs.existsSync(f) && fs.statSync(f).isFile()) out.push({ name: tool + ' — ' + f, path: f, size: fs.statSync(f).size });
        }
      } else {
        const dir = path.join(cwd, p.slice(0, p.indexOf('*')).replace(/\//g, path.sep));
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            const full = path.join(dir, f);
            if (fs.statSync(full).isFile()) out.push({ name: tool + ' — ' + full, path: full, size: fs.statSync(full).size });
          }
        }
      }
    }
  }
  return out;
}
ipcMain.handle('plugin:readme', async (e, fullName) => {
  try {
    if (!fullName) return null;
    const res = await fetch('https://api.github.com/repos/' + fullName + '/readme', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-client' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.content) return null;
    return Buffer.from(j.content, 'base64').toString('utf8');
  } catch (err) { log('plugin:readme error: ' + err.message); return null; }
});
ipcMain.handle('rules:scan', () => {
  try {
    const list = expandRules().map((x) => ({ name: x.name, path: x.path, size: x.size }));
    log('rules:scan found ' + list.length);
    return list;
  } catch (e) { log('rules:scan error: ' + e.message); return []; }
});
ipcMain.handle('rules:import', async (e, sel) => {
  try {
    const f = sel && sel.path;
    if (!f || !fs.existsSync(f)) return { ok: false, msg: '规则文件不存在' };
    const content = fs.readFileSync(f, 'utf8').slice(0, 12000);
    const cred = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml');
    const key = fs.existsSync(cred) ? String(fs.readFileSync(cred, 'utf8')).match(/sk-[a-zA-Z0-9]+/) : null;
    if (!key) return { ok: false, msg: '未配置 API Key' };
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key[0] },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是规则精简助手。把外部 AI 工具的规则文件精简改写为通用、适用于 DeepSeek Harness 的规则：剔除该工具专属特性（如 plan!/ponytail/autosolve 等），保留通用行为准则。输出为简洁的 Markdown 规则列表（要点式，200 字内）。' },
          { role: 'user', content: content },
        ],
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(40000),
    });
    const j = await res.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) return { ok: false, msg: 'AI 无返回: ' + (j.error ? j.error.message : '') };
    const target = path.join(process.env.USERPROFILE || '', '.dsh', 'AGENTS.md');
    const head = '\n\n## 继承自 ' + (sel.name || '外部 AI 工具') + '\n' + text.trim() + '\n';
    fs.appendFileSync(target, head);
    log('rules:import wrote to ' + target);
    return { ok: true, msg: '已写入 ~/.dsh/AGENTS.md（' + (text.length) + ' 字符）' };
  } catch (err) {
    return { ok: false, msg: '导入失败: ' + err.message };
  }
});

// ==================== GitHub search proxy (for marketplace) ====================
ipcMain.handle('plugin:search', async (e, { q, sort, page } = {}) => {
  try {
    const params = new URLSearchParams({ q: q || 'topic:dsh-plugin', sort: sort || 'stars', order: 'desc', per_page: '20', page: String(page || 1) });
    const url = 'https://api.github.com/search/repositories?' + params.toString();
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-client' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, msg: 'GitHub API ' + res.status, items: [] };
    const j = await res.json();
    const items = (j.items || []).map((r) => ({
      fullName: r.full_name,
      desc: r.description || '',
      stars: r.stargazers_count || 0,
      updated: r.updated_at || '',
      lang: r.language || '',
      htmlUrl: r.html_url,
    }));
    return { ok: true, items, total: j.total_count || 0 };
  } catch (err) { return { ok: false, msg: err.message, items: [], total: 0 }; }
});

// ==================== smart plugin install (marketplace "一键安装") ====================
const GIT_MIRRORS = [
  'https://ghproxy.net/https://github.com/',
  'https://ghfast.top/https://github.com/',
  'https://gh-proxy.com/https://github.com/',
];
async function restartDSH() {
  await killByPort(PORT);
  await ensureServer();
  if (webView && !webView.webContents.isDestroyed()) webView.webContents.loadURL(URL);
}
async function gitCloneMirror(repo, dest) {
  const url = 'https://github.com/' + repo + '.git';
  for (const m of GIT_MIRRORS) {
    try {
      await execGitTimeout(['clone', '--depth', '1', m + url, dest], 90000);
      log('git clone OK via ' + m);
      return true;
    } catch (e) { log('mirror clone failed ' + m + ': ' + e.message); }
  }
  try { await execGitTimeout(['clone', '--depth', '1', url, dest], 120000); log('git clone OK (direct)'); return true; } catch (e) { log('direct clone failed: ' + e.message); }
  return false;
}
ipcMain.handle('plugin:install', async (e, info) => {
  const pkg = (info && info.pkg) || '';
  const repo = (info && info.repo) || '';
  try {
    // 1) npm route (npmmirror already configured in profile .npmrc)
    if (pkg) {
      try {
        await execCmdLive('cmd.exe', ['/c', 'dsh', 'plugin', '--profile', 'web', 'add', pkg], 20000, () => log('plugin:install npm ' + pkg + ' …'));
        await restartDSH();
        return { ok: true, msg: '已通过 npm 安装: ' + pkg };
      } catch (npmErr) { log('npm install failed: ' + npmErr.message); }
    }
    // 2) git route (mirror-first)
    if (repo) {
      const name = String(repo.split('/').pop() || '').toLowerCase();
      const tmp = path.join(app.getPath('temp'), 'mp-install-' + name);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (await gitCloneMirror(repo, tmp)) {
        if (fs.existsSync(path.join(tmp, 'SKILL.md'))) {
          const dest = path.join(process.env.USERPROFILE || '', '.dsh', 'skills', name);
          fs.rmSync(dest, { recursive: true, force: true });
          fs.cpSync(tmp, dest, { recursive: true });
          await restartDSH();
          return { ok: true, msg: '已安装 Skill: ' + name + '（~/.dsh/skills/' + name + '）' };
        }
        if (fs.existsSync(path.join(tmp, 'package.json'))) {
          const profile = path.join(DSH_DIR, 'profiles', 'web');
          await execCmdLive('cmd.exe', ['/c', 'pnpm', 'add', 'file:' + tmp], 20000, () => log('plugin:install pnpm ' + name + ' …'), { cwd: profile });
          // mount via cordis.patch.yml
          const patch = path.join(profile, 'cordis.patch.yml');
          const cur = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '';
          if (!cur.includes("name: '" + name + "'") && !cur.includes('name: "' + name + '"')) {
            const entry = '\n- insert:\n    - id: ' + name + '\n      name: \'' + name + '\'\n';
            fs.writeFileSync(patch, cur.trimEnd() + entry);
          }
          await restartDSH();
          return { ok: true, msg: '已安装插件: ' + name + '（已挂载 cordis）' };
        }
        return { ok: false, msg: '仓库类型无法识别（无 SKILL.md / package.json）' };
      }
      return { ok: false, msg: '克隆失败：所有 GitHub 镜像不可达，请检查网络' };
    }
    return { ok: false, msg: '缺少安装信息' };
  } catch (err) {
    return { ok: false, msg: '安装失败: ' + err.message };
  }
});
// plugin description -> AI explanation via DeepSeek (uses dsh's configured key)
ipcMain.handle('translate:text', async (e, text) => {
  try {
    const cred = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml');
    const key = fs.existsSync(cred) ? String(fs.readFileSync(cred, 'utf8')).match(/sk-[a-zA-Z0-9]+/) : null;
    if (!key) return '未配置 API Key（请在 dsh 设置中配置）';
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key[0] },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是插件说明助手。用户会给你一个 DeepSeek Harness（DSH）插件的名称和英文介绍。请用简体中文简洁说明：这个插件是做什么的、能实现什么功能。50~150 字，用 2~4 个要点，不要逐句翻译原文。' },
          { role: 'user', content: String(text).slice(0, 2000) },
        ],
        max_tokens: 500,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) return 'AI 无返回: ' + (j.error ? j.error.message : 'unknown');
    return content.trim();
  } catch (err) {
    return 'AI 解释失败: ' + err.message;
  }
});
ipcMain.handle('sync:test', async (e, p) => {
  try {
    if (p && p.method === 'git') {
      const remote = (p.remote || '').trim();
      if (!remote) return { ok: false, msg: '未填写 Git 远程地址' };
      const r = await execGitTimeout(['ls-remote', remote], 15000);
      return { ok: true, msg: 'Git 连接成功（远程可访问）' };
    }
    const url = ((p && p.webdav && p.webdav.url) || '').trim().replace(/\/+$/, '');
    const user = (p && p.webdav && p.webdav.user) || '';
    const pass = (p && p.webdav && p.webdav.pass) || '';
    if (!url || !user || !pass) return { ok: false, msg: 'WebDAV 配置不完整（地址/用户名/密码）' };
    const auth = davAuth(user, pass);
    // 8s 短超时：服务器不可达时尽快返回错误，避免长时间卡在「测试中」
    const res = await davFetch('PROPFIND', url + '/', { headers: { Authorization: auth, Depth: '0' }, timeout: 8000 });
    if (res.ok) return { ok: true, msg: 'WebDAV 连接成功（HTTP ' + res.status + '）' };
    return { ok: false, msg: 'WebDAV 连接失败（HTTP ' + res.status + '，检查地址/认证/目录权限）' };
  } catch (e) {
    return { ok: false, msg: '连接失败: ' + e.message };
  }
});
// 静默重启 dsh web 服务（改插件/补丁后强制生效）
ipcMain.handle('service:restart', async () => {
  try {
    log('service:restart requested');
    await restartDSH();
    return { ok: true, msg: '服务已重启' };
  } catch (e) {
    log('service:restart error: ' + e.message);
    return { ok: false, msg: '重启失败: ' + e.message };
  }
});
function execGitTimeout(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = spawn('git', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} reject(new Error('连接超时（15 秒）')); }, timeoutMs || 15000);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error('git 连接失败 exit ' + code + ': ' + out.slice(-120))); });
  });
}

// ==================== backup packs (webdav tar.gz snapshots) ====================
function execTar(args) {
  return new Promise((resolve, reject) => {
    const c = spawn('tar', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    c.on('error', reject);
    c.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error('tar exit ' + code + ': ' + out.slice(-200))));
  });
}
function davBackupRoot() {
  const w = (config.sync && config.sync.webdav) || {};
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return null;
  return { base, auth: davAuth(w.user, w.pass) };
}
async function cleanupBackups(dir, auth, keep) {
  try {
    const items = await davList(dir, auth);
    const backups = items.filter((x) => x.path.endsWith('.tar.gz'))
      .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    for (const old of backups.slice(keep)) {
      try { await davFetch('DELETE', old.url, { headers: { Authorization: auth } }); } catch (e) {}
    }
  } catch (e) {}
}
function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
async function backupCreate() {
  if ((config.sync || {}).method === 'git') return syncNow();
  const dv = davBackupRoot();
  if (!dv) return { ok: false, msg: 'WebDAV 未配置（请先在同步设置中填写地址/账号）' };
  const name = 'dsh-backup-' + tsStamp() + '.tar.gz';
  const tmp = path.join(app.getPath('temp'), name);
  try {
    const paths = backupPaths();
    await execTar(['-czf', tmp, '-C', DSH_DIR, ...paths]);
    await davMkcol(dv.base, dv.auth);
    await davPut(dv.base + '/' + name, fs.readFileSync(tmp), dv.auth);
    fs.unlinkSync(tmp);
    await cleanupBackups(dv.base, dv.auth, 10);
    const s = config.sync || {};
    s.lastSync = new Date().toISOString();
    s.lastStatus = '备份已上传: ' + name;
    saveConfig();
    log('backup created: ' + name);
    return { ok: true, msg: '备份已上传: ' + name };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    return { ok: false, msg: '备份失败: ' + e.message };
  }
}
async function backupList() {
  const dv = davBackupRoot();
  if (!dv) return { ok: false, items: [], msg: 'WebDAV 未配置' };
  try {
    // 服务器不可达/认证失败时如实报错，而不是伪装成"暂无备份"
    const items = await davList(dv.base, dv.auth).catch((e) => {
      log('backupList davList error: ' + e.message);
      throw e;
    });
    log('backupList raw: ' + items.length + ' items: ' + JSON.stringify(items.map((x) => x.path)));
    const list = items
      .filter((x) => x.path.endsWith('.tar.gz'))
      .map((x) => {
        const base = decodeURIComponent(x.path).split('/').pop();
        return { name: base, date: (x.lastModified ? new Date(x.lastModified).toLocaleString('zh-CN', { hour12: false }) : '—'), size: (x.size || 0) };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    log('backupList result: ' + list.length + ' backups');
    return { ok: true, items: list };
  } catch (e) {
    log('backupList error: ' + e.message);
    return { ok: false, items: [], msg: '列出备份失败: ' + e.message };
  }
}
async function backupRestore(name) {
  if ((config.sync || {}).method === 'git') return gitRestore();
  const dv = davBackupRoot();
  if (!dv) return { ok: false, msg: 'WebDAV 未配置' };
  const tmp = path.join(app.getPath('temp'), name);
  try {
    const buf = await davGet(dv.base + '/' + name, dv.auth);
    fs.writeFileSync(tmp, buf);
    // stop dsh first so a running instance cannot overwrite the restored state
    await killByPort(PORT);
    await execTar(['-xzf', tmp, '-C', DSH_DIR]);
    fs.unlinkSync(tmp);
    // self-heal: restored profile may carry invalid bundles (e.g. dsh-plugin-marketplace)
    try { if (fixProfileBundles()) log('restore: fixed invalid profile bundles'); } catch (e) { log('restore fixProfileBundles: ' + e.message); }
    // restart dsh so it loads the restored sessions/workspace
    await ensureServer();
    if (webView && !webView.webContents.isDestroyed()) {
      webView.webContents.loadURL(URL);
    }
    const s = config.sync || {};
    s.lastRestore = new Date().toISOString();
    s.lastStatus = '已从备份恢复: ' + name;
    saveConfig();
    log('restored from backup: ' + name);
    return { ok: true, msg: '已恢复备份并重启服务: ' + name };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    await ensureServer().catch(() => {});
    return { ok: false, msg: '恢复失败: ' + e.message };
  }
}
ipcMain.handle('backup:create', () => backupCreate());
ipcMain.handle('backup:list', () => backupList());
ipcMain.handle('backup:restore', (e, name) => backupRestore(name));

// ==================== archive management (workspace.json archivedSessionIds) ====================
ipcMain.handle('archive:list', async () => {
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const archived = (ws.global && ws.global.archivedSessionIds) || [];
    const wsArr = Object.values((ws.tables && ws.tables.workspaces) || {});
    const items = archived.map((id) => {
      const file = path.join(DSH_DIR, 'sessions', '--D-Claude~0020Code-dsh--', id, 'session.jsonl.zstd');
      return { id, exists: fs.existsSync(file) };
    });
    return { ok: true, items, workspace: wsArr.length ? (wsArr[0].title || wsArr[0].path || '') : '' };
  } catch (e) { return { ok: false, msg: e.message }; }
});
ipcMain.handle('archive:unarchive', async (e, id) => {
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const arr = (ws.global && ws.global.archivedSessionIds) || [];
    const i = arr.indexOf(id);
    if (i < 0) return { ok: false, msg: '该会话不在归档列表' };
    arr.splice(i, 1);
    const wsArr = Object.values((ws.tables && ws.tables.workspaces) || {});
    if (wsArr.length) {
      wsArr[0].sessionIds = wsArr[0].sessionIds || [];
      if (!wsArr[0].sessionIds.includes(id)) wsArr[0].sessionIds.push(id);
    }
    fs.writeFileSync(WORKSPACE_JSON, JSON.stringify(ws, null, 2));
    log('unarchived session: ' + id);
    // restart dsh so the sidebar picks up the change
    await killByPort(PORT);
    await ensureServer();
    if (webView && !webView.webContents.isDestroyed()) webView.webContents.loadURL(URL);
    return { ok: true, msg: '已取消归档，会话将重新显示' };
  } catch (e) { return { ok: false, msg: e.message }; }
});
ipcMain.handle('overview:get', async () => {
  const online = await portOpen(PORT);
  let env = envCache;
  if (Date.now() - envCacheAt > 10000 || !envCache) {
    env = await checkEnv();
    envCache = env;
    envCacheAt = Date.now();
  }
  let workspace = { path: '', sessions: 0, updatedAt: null };
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const first = Object.values((ws.tables && ws.tables.workspaces) || {})[0];
    if (first) {
      workspace = {
        path: first.path || '',
        sessions: (first.sessionIds || []).length,
        updatedAt: first.updatedAt || null,
      };
    }
  } catch (e) {}
  let plugins = 0;
  try { plugins = fs.existsSync(LIXIN_DIR) ? fs.readdirSync(LIXIN_DIR).length : 0; } catch (e) {}
  return { online, port: PORT, workspace, env, plugins, model: null };
});

app.on('window-all-closed', async () => {
  log('window-all-closed');
  if (config.stopOnExit) {
    log('stopping service (stopOnExit)');
    await killByPort(PORT);
  }
  app.quit();
});
