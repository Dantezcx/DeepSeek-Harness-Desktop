const { app, BrowserWindow, dialog, Tray, Menu, ipcMain, nativeImage, WebContentsView } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 8123;
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
let sessionCost = 0;
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
  const hit = Number(s.cacheHits) || 0;
  const out = Number(s.outTokens) || 0;
  return ((inTok - hit) * p.in + hit * p.inHit + out * p.out) / 1e6;
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
let config = { closeToTray: true };
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
function execCmdLive(cmd, args, interval, onTick) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  log('quitApp: stopping service on port ' + PORT);
  await killByPort(PORT);
  app.quit();
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

// ---- boot ----
async function bootWeb() {
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
ipcMain.handle('config:set', (e, cfg) => { config = { ...config, ...cfg }; saveConfig(); return config; });
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
  const thisCost = calcCost(webStats);
  sessionCost = Math.max(sessionCost, thisCost);
  return {
    online, port: PORT, workspace, sessions, mode: 'web',
    model: webStats.model || lastModel || '未配置',
    sessTokens: fmtNum(maxInTokens + maxOutTokens),
    thisTokens: fmtNum(outTok),
    thisCost: fmtMoney(thisCost),
    sessCost: fmtMoney(sessionCost),
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
    sessionCost = Math.max(sessionCost, calcCost(s));
  }
});
ipcMain.on('debug:log', (e, msg) => log('web: ' + msg));
ipcMain.handle('ui:settings', () => showSettings());
ipcMain.handle('ui:quit', () => quitApp());

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
  return fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeout) });
}
function davAuth(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}
async function davMkcol(url, auth) {
  try { await davFetch('MKCOL', url, { headers: { Authorization: auth } }); } catch (e) {}
}
async function davList(url, auth) {
  // PROPFIND depth:1 -> [{path, url, lastModified(ms)}]
  const res = await davFetch('PROPFIND', url, { headers: { Authorization: auth, Depth: '1' } });
  if (!res.ok) throw new Error('PROPFIND ' + res.status);
  const xml = await res.text();
  const origin = new globalThis.URL(url).origin;
  const items = [];
  const hrefRe = /<[A-Za-z0-9_-]+:href>([^<]+)<\/[A-Za-z0-9_-]+:href>/g;
  const lmRe = /<[A-Za-z0-9_-]+:getlastmodified>([^<]+)<\/[A-Za-z0-9_-]+:getlastmodified>/g;
  const szRe = /<[A-Za-z0-9_-]+:getcontentlength>([^<]+)<\/[A-Za-z0-9_-]+:getcontentlength>/g;
  let m;
  while ((m = hrefRe.exec(xml))) items.push({ href: m[1], lastModified: null, size: null });
  const lms = [];
  while ((m = lmRe.exec(xml))) lms.push(Date.parse(m[1]));
  const sizes = [];
  while ((m = szRe.exec(xml))) sizes.push(parseInt(m[1], 10) || null);
  const out = [];
  items.forEach((it, i) => {
    const h = it.href;
    const full = /^https?:\/\//i.test(h) ? h : origin + h;
    out.push({ path: decodeURIComponent(h), url: full, lastModified: lms[i] || null, size: sizes[i] || null });
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
// extract relative path under the sync root from a DAV href
function relFromDavPath(p) {
  return decodeURIComponent(p).replace(/\/+$/, '').replace(/^\/+/, '').replace(/^dsh-sync\/?/, '');
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
      await ensureDir(f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '');
      const buf = fs.readFileSync(f.local);
      const url = root + '/' + f.rel;
      const remoteLast = await davList(root + '/' + f.rel.slice(0, f.rel.lastIndexOf('/')), auth).catch(() => []);
      const item = remoteLast.find((x) => decodeURIComponent(x.path).endsWith('/' + f.rel));
      if (!item || !item.lastModified || fs.statSync(f.local).mtimeMs > item.lastModified) {
        await davPut(url, buf, auth);
      }
    } catch (e) {
      errors.push(f.rel + ': ' + e.message);
    }
  }
  try {
    const remote = await davList(root + '/sessions', auth).catch(() => []);
    for (const item of remote) {
      const rel = relFromDavPath(item.path);
      if (!rel || item.path.endsWith('/')) continue;
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
    const rel = relFromDavPath(it.path);
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
function scheduleAutoSync() {
  const s = config.sync || {};
  if (!s.auto) return;
  const mins = Math.max(1, Number(s.intervalMin) || 30);
  setTimeout(() => {
    syncNow();
    setInterval(syncNow, mins * 60000);
  }, 60000);
}
ipcMain.handle('sync:get-config', () => (config.sync || {}));
ipcMain.handle('sync:save-config', (e, sc) => {
  config.sync = sc;
  saveConfig();
  return config.sync;
});
ipcMain.handle('sync:now', () => syncNow());
ipcMain.handle('sync:restore', () => restoreNow());

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
    const paths = syncSelectedPaths();
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
    const items = await davList(dv.base, dv.auth).catch((e) => {
      log('backupList davList error: ' + e.message);
      return [];
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
  log('window-all-closed: stopping service on port ' + PORT);
  await killByPort(PORT);
  app.quit();
});
