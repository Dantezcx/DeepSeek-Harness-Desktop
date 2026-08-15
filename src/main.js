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
  if (win && !win.isDestroyed()) win.webContents.send('setup:progress', msg);
  log('setup: ' + msg);
}

async function setupInstall() {
  const env = await checkEnv();
  if (!env.node) {
    progress('下载 Node.js 安装包（国内镜像）...');
    await execPS([
      `$idx = Invoke-RestMethod 'https://npmmirror.com/mirrors/node/index.json' -TimeoutSec 30`,
      `$v = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version`,
      `$url = "https://npmmirror.com/mirrors/node/$v/node-$v-x64.msi"`,
      `Invoke-WebRequest $url -OutFile "$env:TEMP\\node-install.msi" -UseBasicParsing`,
    ].join('; '));
    progress('静默安装 Node.js（如弹出 UAC 请点"是"）...');
    await execPS(`Start-Process msiexec -ArgumentList '/i',\"$env:TEMP\\node-install.msi\",'/qn','/norestart' -Verb RunAs -Wait`);
    await waitFile(NODE_EXE, 180000);
    progress('Node.js 安装完成');
  }
  if (!(await checkEnv()).dsh) {
    const npm = fs.existsSync(NPM_CMD) ? NPM_CMD : 'npm';
    progress('配置 npm 全局安装目录...');
    await execCmd('cmd.exe', ['/c', npm, 'config', 'set', 'prefix', NPM_GLOBAL_DIR]);
    progress('正在通过 npm 安装 dsh（DeepSeek Harness）...');
    await execCmd('cmd.exe', ['/c', npm, 'install', '-g', '@deepseek-ai/dsh']);
    await waitFile(DSH_CMD, 300000);
    progress('dsh 安装完成');
  }
  progress('环境就绪');
  return checkEnv();
}

// ==================== dsh-web-ui integration (idempotent) ====================
// `dsh plugin` is a thin pnpm forwarder, so a missing pnpm silently breaks
// plugin installs (the packaged installer used to finish without dsh-web-ui).
// This block ensures pnpm, installs the default plugin set and applies the
// "概览" overview-tab patch on every boot; all steps are idempotent and
// non-blocking on failure. Install-on-first-run = "安装即使用".
const WEB_UI_PKGS = [
  '@linxin666/dsh-web-ui-all',   // 皮肤/右侧面板/任务看板/宠物 全家桶
  'dsh-plugin-marketplace',      // 设置页内置插件市场（浏览/搜索/一键安装社区插件）
  'dsh-chat-import',             // 六大工具历史对话导入
];
const WEB_NM_DIR = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'node_modules');

function pluginInstalled(pkg) {
  try {
    if (pkg.startsWith('@')) {
      const scope = pkg.split('/')[0];
      const dir = path.join(WEB_NM_DIR, scope);
      return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    }
    return fs.existsSync(path.join(WEB_NM_DIR, pkg));
  } catch (e) { return false; }
}

function pnpmCmdPath() {
  const cands = [
    path.join(process.env.APPDATA || '', 'npm', 'pnpm.cmd'),
    path.join(NODE_DIR, 'pnpm.cmd'),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}
function ensureNpmBinOnPath() {
  // npm global bin dir may not be on this process' PATH (e.g. fresh install);
  // child processes inherit process.env, so inject it once.
  const npmBin = path.join(process.env.APPDATA || '', 'npm');
  if (npmBin && !String(process.env.PATH || '').split(path.delimiter).includes(npmBin)) {
    process.env.PATH = npmBin + path.delimiter + (process.env.PATH || '');
    log('ensurePnpm: added npm global bin to PATH: ' + npmBin);
  }
}
async function ensurePnpm() {
  // 1) known full paths (no PATH dependency)
  const direct = pnpmCmdPath();
  if (direct) {
    try { await execCmd('cmd.exe', ['/c', direct, '--version']); return true; } catch (e) {}
  }
  // 2) on PATH
  try { await execCmd('cmd.exe', ['/c', 'pnpm', '--version']); return true; } catch (e) {}
  // 3) install via npm -g, then use the resolved full path
  try {
    const npm = fs.existsSync(NPM_CMD) ? NPM_CMD : 'npm';
    log('ensurePnpm: installing pnpm globally via npm...');
    await execCmd('cmd.exe', ['/c', npm, 'install', '-g', 'pnpm']);
    ensureNpmBinOnPath();
    const after = pnpmCmdPath();
    if (after) { await execCmd('cmd.exe', ['/c', after, '--version']); return true; }
    await execCmd('cmd.exe', ['/c', 'pnpm', '--version']);
    return true;
  } catch (e) {
    log('ensurePnpm npm path failed: ' + e.message);
  }
  // 4) corepack (bundled with Node)
  try {
    const corepack = path.join(NODE_DIR, 'corepack.cmd');
    if (fs.existsSync(corepack)) {
      log('ensurePnpm: enabling pnpm via corepack...');
      await execCmd('cmd.exe', ['/c', corepack, 'enable', 'pnpm']);
      const after = path.join(NODE_DIR, 'pnpm.cmd');
      if (fs.existsSync(after)) { await execCmd('cmd.exe', ['/c', after, '--version']); return true; }
    }
  } catch (e) {
    log('ensurePnpm corepack path failed: ' + e.message);
  }
  return false;
}

function applyOverviewPatch() {
  const target = path.join(LIXIN_DIR, 'dsh-client-ui-aionui-panel', 'lib', 'client.js');
  if (!fs.existsSync(target)) {
    log('[patch] aionui-panel client.js not found: ' + target);
    return { ok: false, msg: 'aionui-panel client.js 未找到' };
  }
  let s = fs.readFileSync(target, 'utf8');
  if (s.includes('explorer.tabs.overview') || s.includes('dsh-overview-host')) {
    log('[patch] already applied (idempotent)');
    return { ok: true, msg: '已应用（幂等跳过）' };
  }
  const need = (ok, what) => { if (!ok) throw new Error('[patch] 锚点未找到: ' + what); };
  // 1) zh locale
  {
    const anchor = '"explorer.tabs.files": "文件",';
    need(s.includes(anchor), 'zh locale');
    s = s.replace(anchor, anchor + '\n\t\t\t"explorer.tabs.overview": "概览",');
  }
  // 2) en locale
  {
    const anchor = '"explorer.tabs.files": "Files",';
    need(s.includes(anchor), 'en locale');
    s = s.replace(anchor, anchor + '\n\t\t\t"explorer.tabs.overview": "Overview",');
  }
  // 3) tab bar: insert overview button after the changes tab button
  {
    const needle = 'children: t("explorer.tabs.changes")';
    const i = s.indexOf(needle);
    need(i >= 0, 'changes tab button');
    const closeNeedle = '}),';
    const j = s.indexOf(closeNeedle, i);
    need(j >= 0, 'changes tab button close');
    const indent = s.slice(0, j).split('\n').pop().match(/^\s*/)[0];
    const btn =
      '\n' + indent + '/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {' +
      '\n' + indent + '\ttype: "button",' +
      '\n' + indent + '\tclassName: state.activeTab === "overview" ? explorer_module_css_default.tabBtnActive : explorer_module_css_default.tabBtn,' +
      '\n' + indent + '\tonClick: () => stores.explorer.setActiveTab("overview"),' +
      '\n' + indent + '\tchildren: t("explorer.tabs.overview")' +
      '\n' + indent + '}),';
    s = s.slice(0, j + closeNeedle.length) + btn + s.slice(j + closeNeedle.length);
  }
  // 4) content area: overview host container after ScmPanel conditional
  {
    const anchor = 'state.activeTab === "changes" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScmPanel, { stores })';
    const i = s.indexOf(anchor);
    need(i >= 0, 'ScmPanel conditional');
    const tail = ', state.activeTab === "overview" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { id: "dsh-overview-host", style: { flex: 1, minHeight: 0, overflowY: "auto" } })';
    s = s.slice(0, i + anchor.length) + tail + s.slice(i + anchor.length);
  }
  fs.writeFileSync(target, s);
  log('[patch] overview tab patch applied');
  return { ok: true, msg: '概览标签补丁已应用' };
}

// 给 dsh-plugin-marketplace 的详情面板 README 摘要加「🌐 翻译为中文」按钮：
// 点击后经 window.api.translateText（main 进程代理 Google 翻译，无 CORS 限制）
// 翻译摘要，结果直接写入 DOM（不依赖 React state）。幂等。
function applyMarketplaceTranslatePatch() {
  const target = path.join(WEB_NM_DIR, 'dsh-plugin-marketplace', 'client.js');
  if (!fs.existsSync(target)) {
    log('[mp-patch] marketplace client.js not found');
    return { ok: false, changed: false, msg: 'client.js 未找到' };
  }
  let s = fs.readFileSync(target, 'utf8');
  if (s.includes('__mp_translateBtn') || s.includes('translateText')) {
    log('[mp-patch] already applied (idempotent)');
    return { ok: true, changed: false, msg: '已应用（幂等跳过）' };
  }
  const anchor = [
    '            : props.readmeError ? props.t("readmeEmpty")',
    '            : (props.readme || "")',
    '        )',
    '      );',
  ].join('\n');
  const i = s.indexOf(anchor);
  if (i < 0) {
    log('[mp-patch] 锚点未找到，跳过（插件版本可能已更新）');
    return { ok: false, changed: false, msg: '锚点未找到' };
  }
  const btn = [
    '            : props.readmeError ? props.t("readmeEmpty")',
    '            : (props.readme || "")',
    '        ),',
    '        h("div", { className: "__mp_translateRow" },',
    '          h("button", { type: "button", className: "__mp_translateBtn",',
    '            style: { marginTop: "8px", padding: "4px 10px", fontSize: "12px", cursor: "pointer", background: "var(--dsw-alias-bg-hover, #21262d)", color: "var(--dsw-alias-label-primary, #e6edf3)", border: "1px solid var(--dsw-alias-border, #30363d)", borderRadius: "6px" },',
    '            onClick: function(ev) {',
    '              var btn = ev.currentTarget;',
    '              var out = document.getElementById("__mp_translateOut");',
    '              if (!out || !window.api || !window.api.translateText) return;',
    '              btn.disabled = true;',
    '              out.textContent = "翻译中…";',
    '              window.api.translateText(props.readme || "").then(function(t) {',
    '                out.textContent = t || "（翻译失败，请检查网络）";',
    '                btn.style.display = "none";',
    '              }).catch(function() { out.textContent = "（翻译失败，请检查网络）"; btn.disabled = false; });',
    '            }',
    '          }, "🌐 翻译为中文"),',
    '          h("div", { id: "__mp_translateOut", style: { fontSize: "12px", lineHeight: "1.6", color: "var(--dsw-alias-label-secondary, #8b949e)", whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: "8px", borderTop: "1px solid var(--dsw-alias-border, #21262d)", paddingTop: "8px" } }, "")',
    '        )',
    '      );',
  ].join('\n');
  s = s.slice(0, i) + btn + s.slice(i + anchor.length);
  fs.writeFileSync(target, s);
  log('[mp-patch] marketplace 翻译补丁已应用');
  return { ok: true, changed: true, msg: '翻译补丁已应用' };
}

async function ensureWebUI() {
  try {
    const missing = WEB_UI_PKGS.filter((p) => !pluginInstalled(p));
    if (missing.length) {
      if (!(await ensurePnpm())) return { ok: false, installed: false, msg: 'pnpm 不可用，无法安装插件' };
      const bin = dshBinPath();
      const nodeExe = fs.existsSync(NODE_EXE) ? NODE_EXE : 'node';
      for (const pkg of missing) {
        log('ensureWebUI: installing ' + pkg + ' (this may take a while)...');
        if (bin) {
          try {
            await execCmd(nodeExe, [bin, 'plugin', '--profile', 'web', 'add', pkg]);
          } catch (e) {
            // pnpm may exit non-zero (e.g. ERR_PNPM_IGNORED_BUILDS) even though
            // every package was installed — continue to the installed-check below
            log('ensureWebUI: ' + pkg + ' add exited non-zero (may still be installed): ' + e.message);
          }
        } else {
          await execCmd('cmd.exe', ['/c', DSH_CMD, 'plugin', '--profile', 'web', 'add', pkg])
            .catch((e) => log('ensureWebUI: ' + pkg + ' add (cmd) exited non-zero: ' + e.message));
        }
      }
      const stillMissing = WEB_UI_PKGS.filter((p) => !pluginInstalled(p));
      if (stillMissing.length) return { ok: false, installed: false, msg: '部分插件未装齐: ' + stillMissing.join(', ') };
    } else {
      log('ensureWebUI: all plugins already installed');
    }
    // pnpm exits non-zero (ERR_PNPM_IGNORED_BUILDS) on this profile, so dsh's
    // own reconcile (registering packages into dsh.profile.bundles) never runs;
    // make sure every installed plugin is registered, otherwise dsh won't load it.
    // registerBundle only accepts packages with a dsh.bundle manifest; client-only
    // plugins (e.g. dsh-plugin-marketplace) are wired up via cordis.patch.yml.
    let registered = false;
    for (const pkg of WEB_UI_PKGS) {
      if (pluginInstalled(pkg) && registerBundle(pkg)) registered = true;
    }
    if (ensureMarketplacePatch()) registered = true;
    // 自愈：无论谁把无 dsh.bundle 的纯客户端插件写进了 bundles（例如 dsh 自己的
    // reconcile 在 pnpm 退出码为 0 时会把新装插件一律注册进 bundles），启动时
    // 移除它们——dsh 对 bundles 强制校验 dsh.bundle，误注册会导致服务崩溃
    // （历史事故：dsh-plugin-marketplace 曾导致 "dsh web 启动超时"）。
    if (pruneInvalidBundles()) registered = true;
    if (registered) log('ensureWebUI: bundles updated, service restart needed');
    const patch = applyOverviewPatch();
    // marketplace 详情面板中文翻译补丁（幂等；变更后需要重启服务加载）
    if (pluginInstalled('dsh-plugin-marketplace')) {
      const mp = applyMarketplaceTranslatePatch();
      if (mp.changed) { registered = true; log('ensureWebUI: marketplace translate patch applied, restart needed'); }
    }
    log('ensureWebUI done: installed=' + (missing.length > 0) + ' registered=' + registered + ' patch=' + patch.msg);
    return { ok: patch.ok, installed: missing.length > 0 || registered, msg: patch.msg };
  } catch (e) {
    log('ensureWebUI error: ' + e.message);
    return { ok: false, installed: false, msg: e.message };
  }
}

// 检查某插件是否声明了 dsh.bundle 清单。dsh 启动时会把 bundles 里的每个
// 包当作 profile bundle 加载并强制要求 dsh.bundle 字段，缺失会直接抛错
// （如 dsh-plugin-marketplace 曾被误注册导致 dsh web 崩溃、客户端启动超时）。
// 纯客户端插件（只有 dsh.client）必须走 cordis.patch.yml，不能进 bundles。
function hasBundleManifest(pkg) {
  try {
    const p = path.join(WEB_NM_DIR, pkg.split('/').join(path.sep), 'package.json');
    if (!fs.existsSync(p)) return false;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return !!(j.dsh && j.dsh.bundle);
  } catch (e) { return false; }
}

// 把已安装的 dsh 插件登记进 profiles/web/package.json 的 dsh.profile.bundles
// （幂等：已在列表则不动；仅登记声明了 dsh.bundle 的包；返回是否发生了变更）
function registerBundle(pkg) {
  try {
    if (!hasBundleManifest(pkg)) {
      log('ensureWebUI: skip registering ' + pkg + ' (no dsh.bundle manifest, client-only via patch)')
      return false;
    }
    const pj = path.join(WEB_NM_DIR, '..', 'package.json');
    if (!fs.existsSync(pj)) return false;
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    j.dsh = j.dsh || {};
    j.dsh.profile = j.dsh.profile || {};
    const bundles = j.dsh.profile.bundles || [];
    if (bundles.includes(pkg)) return false;
    bundles.push(pkg);
    j.dsh.profile.bundles = bundles;
    fs.writeFileSync(pj, JSON.stringify(j, null, 2));
    log('ensureWebUI: registered bundle ' + pkg);
    return true;
  } catch (e) {
    log('registerBundle ' + pkg + ' error: ' + e.message);
    return false;
  }
}

// dsh-plugin-marketplace 是纯客户端插件（package.json 只有 dsh.client，无
// dsh.bundle），按它的 README 通过 profiles/web/cordis.patch.yml 的 insert
// 条目加载，而不是进 bundles。幂等：已有条目则不动。
function ensureMarketplacePatch() {
  try {
    const f = path.join(WEB_NM_DIR, '..', 'cordis.patch.yml');
    if (!fs.existsSync(f)) return false;
    let s = fs.readFileSync(f, 'utf8');
    if (s.includes('plugin-marketplace')) return false;
    const entry = '- insert:\n    - id: plugin-marketplace\n      name: dsh-plugin-marketplace\n';
    const trimmed = s.trim();
    s = (trimmed === '[]' || trimmed === '')
      ? entry
      : (trimmed.endsWith('\n') ? trimmed : trimmed + '\n') + '\n' + entry;
    fs.writeFileSync(f, s);
    log('ensureWebUI: cordis.patch.yml insert plugin-marketplace');
    return true;
  } catch (e) {
    log('ensureMarketplacePatch error: ' + e.message);
    return false;
  }
}

// 自愈清理：从 dsh.profile.bundles 移除"物理存在但未声明 dsh.bundle"的包。
// 无法读取/不在 node_modules 的包（如 dsh 内置的 base/web-app）一律保守保留。
// 幂等：无变化返回 false。
function pruneInvalidBundles() {
  try {
    const pj = path.join(WEB_NM_DIR, '..', 'package.json');
    if (!fs.existsSync(pj)) return false;
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const bundles = (j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [];
    const kept = bundles.filter((pkg) => {
      try {
        const p = path.join(WEB_NM_DIR, pkg, 'package.json');
        if (!fs.existsSync(p)) return true; // 非物理包（dsh 内置）→ 保留
        const j2 = JSON.parse(fs.readFileSync(p, 'utf8'));
        return !!(j2.dsh && j2.dsh.bundle);
      } catch (e) { return true; } // 无法判断 → 保守保留
    });
    if (kept.length === bundles.length) return false;
    j.dsh.profile.bundles = kept;
    fs.writeFileSync(pj, JSON.stringify(j, null, 2));
    log('ensureWebUI: pruned invalid bundles: ' + bundles.filter((p) => !kept.includes(p)).join(', '));
    return true;
  } catch (e) {
    log('pruneInvalidBundles error: ' + e.message);
    return false;
  }
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
    {
      label: '关于',
      click: () => dialog.showMessageBox(win, {
        type: 'info',
        title: '关于 DSH 客户端',
        message: '🐋 DSH 客户端',
        detail: '作者：喵筱曦\n开源免费使用（MIT）\n基于 DeepSeek Harness 生态构建，内置 dsh-web-ui 全家桶 / 插件市场 / 云端快照备份。',
        buttons: ['好的'],
      }),
    },
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
  const ui = await ensureWebUI();
  let status = await ensureServer();
  if (ui.installed && status === 'already') {
    // plugin was just installed while a service was already running;
    // restart it so dsh-web-ui is actually loaded
    log('bootWeb: web-ui freshly installed, restarting running service');
    await killByPort(PORT);
    status = await ensureServer();
  }
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
  const hit = Number(webStats.cacheHits) || 0;
  if (inTok > maxInTokens) maxInTokens = inTok;
  if (outTok > maxOutTokens) maxOutTokens = outTok;
  const thisCost = calcCost(webStats);
  sessionCost = Math.max(sessionCost, thisCost);
  const ctx = (webStats.contextNow != null && webStats.contextMax != null)
    ? fmtNum(webStats.contextNow) + '/' + fmtNum(webStats.contextMax) : '—';
  return {
    online, port: PORT, workspace, sessions, mode: 'web',
    model: webStats.model || '未配置',
    hitThis: fmtNum(hit),
    hitAvg: webStats.hitRate != null ? webStats.hitRate + '%' : '—',
    sessTokens: fmtNum(maxInTokens + maxOutTokens),
    thisTokens: fmtNum(outTok),
    thisCost: fmtMoney(thisCost),
    context: ctx,
    compress: '—',
    sessCost: fmtMoney(sessionCost),
    balance: bal != null ? '¥' + bal : '—',
  };
});
ipcMain.on('stats:from-web', (e, s) => {
  if (s && typeof s === 'object') {
    webStats = s;
    log('stats: ' + JSON.stringify(s));
    const inTok = Number(s.inTokens) || 0, outTok = Number(s.outTokens) || 0;
    if (inTok > maxInTokens) maxInTokens = inTok;
    if (outTok > maxOutTokens) maxOutTokens = outTok;
    sessionCost = Math.max(sessionCost, calcCost(s));
  }
});
ipcMain.on('debug:log', (e, msg) => log('web: ' + msg));
ipcMain.handle('ui:settings', () => showSettings());
ipcMain.handle('ui:quit', () => quitApp());
// 插件介绍中文翻译（main 进程代理 Google 翻译，无浏览器 CORS 限制）
ipcMain.handle('translate:text', async (e, text) => {
  try {
    let t = String(text || '').trim();
    if (!t) return '';
    if (t.length > 1500) t = t.slice(0, 1500);
    const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(t), {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return (j[0] || []).map((x) => x[0] || '').join('');
  } catch (e) {
    log('translate error: ' + e.message);
    return '';
  }
});

// ==================== 继承外部 AI 规则（Claude Code / Cursor / Gemini 等） ====================
const RULE_CANDIDATES = [
  { name: 'Claude Code — ~/.claude/CLAUDE.md', path: path.join(process.env.USERPROFILE || '', '.claude', 'CLAUDE.md') },
  { name: 'Claude Code — ~/.claude/AGENTS.md', path: path.join(process.env.USERPROFILE || '', '.claude', 'AGENTS.md') },
  { name: 'Cursor — ~/.cursorrules', path: path.join(process.env.USERPROFILE || '', '.cursorrules') },
  { name: 'Copilot — ~/.copilot-instructions.md', path: path.join(process.env.USERPROFILE || '', '.copilot-instructions.md') },
  { name: 'Gemini — ~/.gemini/instructions.md', path: path.join(process.env.USERPROFILE || '', '.gemini', 'instructions.md') },
  { name: 'Codex — ~/.codex/AGENTS.md', path: path.join(process.env.USERPROFILE || '', '.codex', 'AGENTS.md') },
];
// 剔除的软件特性关键词（这些行/段落不属于 dsh 通用行为）
const TOOL_SPECIFIC = /plan!|ponytail|autosolve|sessionend|session end|hook|技能清单|快捷键|@-mention|@mention|\/compact|mcp|permission mode|build mode|autocommit|schedule agent/i;

function scanRuleFiles() {
  const found = [];
  for (const c of RULE_CANDIDATES) {
    try {
      if (fs.existsSync(c.path)) {
        const st = fs.statSync(c.path);
        if (st.size > 0 && st.size < 512 * 1024) found.push({ name: c.name, path: c.path, size: st.size });
      }
    } catch (e) {}
  }
  // Cursor rules 目录
  try {
    const dir = path.join(process.env.USERPROFILE || '', '.cursor', 'rules');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mdc'))) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (st.size < 512 * 1024) found.push({ name: 'Cursor — rules/' + f, path: p, size: st.size });
      }
    }
  } catch (e) {}
  return found;
}

async function llmRewriteRules(text, sourceName) {
  const key = (() => {
    try {
      const cred = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml');
      if (!fs.existsSync(cred)) return null;
      return String(fs.readFileSync(cred, 'utf8')).match(/sk-[a-zA-Z0-9]+/)?.[0] || null;
    } catch (e) { return null; }
  })();
  const sys = [
    '你是 AI 助手规则精简专家。用户会给你一份其他 AI 工具（如 Claude Code / Cursor / Gemini）的规则文件原文。',
    '请执行：1) 剔除该工具专属特性（plan! 指令、ponytail、autosolve、会话钩子、技能清单、快捷键、@-mention、/compact、MCP 等）；',
    '2) 保留通用行为约定（语言偏好、编码原则、文件/扫描权限、先出思路后执行、中文备注、输出标注、凭证安全等）；',
    '3) 输出精简后的简体中文 Markdown，开头标题为「### 继承自 ' + sourceName + ' 的规则」，条目式，不含任何账号/密码/路径等敏感信息。',
  ].join(' ');
  try {
    if (!key) return { ok: false, msg: '未找到 API 密钥（~/.dsh/.credentials.yaml），无法智能精简' };
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: String(text).slice(0, 20000) },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    if (!out) throw new Error('空响应');
    return { ok: true, content: out };
  } catch (e) {
    log('llmRewriteRules error: ' + e.message);
    // 降级：启发式过滤
    const kept = String(text).split('\n').filter((l) => !TOOL_SPECIFIC.test(l)).join('\n').trim();
    return { ok: true, content: '### 继承自 ' + sourceName + ' 的规则（启发式精简）\n\n' + kept.slice(0, 4000), degraded: true };
  }
}

async function importRulesFile(name, filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, msg: '文件不存在' };
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.trim()) return { ok: false, msg: '文件为空' };
    const r = await llmRewriteRules(text, name);
    if (!r.ok) return r;
    const agents = path.join(process.env.USERPROFILE || '', '.dsh', 'AGENTS.md');
    const stamp = '\n\n### 继承的外部规则（导入于 ' + new Date().toLocaleString('zh-CN', { hour12: false }) + '，来源：' + name + '）\n' + r.content + '\n';
    fs.appendFileSync(agents, stamp);
    log('rules import: ' + name + ' -> ' + agents);
    return { ok: true, msg: '已导入并精简为 dsh 规则' + (r.degraded ? '（API 不可用，使用启发式精简）' : '') };
  } catch (e) {
    log('importRulesFile error: ' + e.message);
    return { ok: false, msg: e.message };
  }
}
ipcMain.handle('rules:scan', () => scanRuleFiles());
ipcMain.handle('rules:import', (e, f) => importRulesFile(f.name, f.path));

// 静默重启 dsh web 服务（编译/改插件后强制生效）
ipcMain.handle('service:restart', async () => {
  try {
    log('service:restart requested');
    await killByPort(PORT);
    const status = await ensureServer();
    if (webView && !webView.webContents.isDestroyed()) webView.webContents.loadURL(URL);
    const ok = status !== 'timeout';
    return { ok, msg: ok ? '服务已重启' : '服务重启超时（' + status + '）' };
  } catch (e) {
    log('service:restart error: ' + e.message);
    return { ok: false, msg: '重启失败: ' + e.message };
  }
});

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
  // encode non-ASCII chars (e.g. Chinese path segments) without touching existing %XX
  url = url.replace(/[^\x00-\x7F]/g, (c) => encodeURIComponent(c));
  return fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeout) });
}
function davAuth(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}
async function davMkcol(url, auth) {
  const res = await davFetch('MKCOL', url, { headers: { Authorization: auth } });
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
  // Resolve hrefs against the *request* URL (with trailing slash) so that
  // relative ("child/"), root-relative ("/share/folder/...") and absolute
  // hrefs all map to the correct full URL. Synology returns root-relative
  // paths that the old origin+h join would misplace.
  const baseUrl = /\/$/.test(url) ? url : url + '/';
  const hrefRe = /<[A-Za-z0-9_-]+:href>([^<]+)<\/[A-Za-z0-9_-]+:href>/g;
  const lmRe = /<[A-Za-z0-9_-]+:getlastmodified>([^<]+)<\/[A-Za-z0-9_-]+:getlastmodified>/g;
  const szRe = /<[A-Za-z0-9_-]+:getcontentlength>([^<]+)<\/[A-Za-z0-9_-]+:getcontentlength>/g;
  let m;
  const out = [];
  while ((m = hrefRe.exec(xml))) {
    const h = m[1];
    let full;
    try { full = new globalThis.URL(h, baseUrl).href; }
    catch (e) { full = baseUrl + h; }
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
function relFromDavUrl(fullUrl, root) {
  let p = String(fullUrl || '');
  let r = String(root || '').replace(/\/+$/, '');
  // normalize both sides through URL so percent-encoding matches
  // (e.g. 中文 path segments get %XX-encoded by new URL())
  try { p = new globalThis.URL(p).href; } catch (e) {}
  try { r = new globalThis.URL(r).href; } catch (e) {}
  r = r.replace(/\/+$/, '') + '/';
  if (p.startsWith(r)) {
    p = p.slice(r.length);
  } else {
    // href not under our sync root; fall back to the URL pathname
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
    // sessions are nested (sessions/<workspace>/<id>/session.jsonl.zstd),
    // so a depth-1 listing would only return workspace dirs -> recurse
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

// ---- connection test (settings UI: "测试连接") ----
async function webdavTest(w) {
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return { ok: false, msg: 'WebDAV 配置不完整（地址/用户名/密码）' };
  const auth = davAuth(w.user, w.pass);
  const t0 = Date.now();
  try {
    const res = await davFetch('PROPFIND', base, { headers: { Authorization: auth, Depth: '0' } });
    const ok2xx = res.status >= 200 && res.status < 300;
    if (!ok2xx && res.status !== 207) {
      if (res.status === 401 || res.status === 403) return { ok: false, msg: '认证失败（HTTP ' + res.status + '）：请检查用户名/密码' };
      if (res.status === 404) return { ok: false, msg: '目标路径不存在（HTTP 404）：请检查 WebDAV 地址' };
      if (res.status === 405) return { ok: false, msg: '目标不支持 WebDAV（HTTP 405）：请检查地址或父目录权限' };
      return { ok: false, msg: '连接失败（HTTP ' + res.status + '）' };
    }
    // verify the backup root is creatable/accessible (405 = already exists = OK)
    for (const sub of ['dsh-sync', 'dsh-sync/sessions']) {
      try {
        await davMkcol(base + '/' + sub, auth);
      } catch (e) {
        return { ok: false, msg: '目录创建失败（' + sub + '）：' + e.message + '，请检查写权限' };
      }
    }
    return { ok: true, msg: '连接成功（' + (Date.now() - t0) + 'ms），目录可读写' };
  } catch (e) {
    return { ok: false, msg: '无法连接：' + (e && e.message ? e.message : String(e)) };
  }
}
async function gitTest(g) {
  const remote = (g.remote || '').trim();
  if (!remote) return { ok: false, msg: '未配置 Git 远程地址' };
  const t0 = Date.now();
  try {
    await execGit(['ls-remote', '--exit-code', remote, 'HEAD'], DSH_DIR);
    return { ok: true, msg: '连接成功（' + (Date.now() - t0) + 'ms），远程仓库可访问' };
  } catch (e) {
    return { ok: false, msg: '无法访问远程仓库：' + (e && e.message ? e.message : String(e)) };
  }
}

async function syncNow() {
  const s = config.sync || {};
  if (s.method && s.method !== 'off' && !s.ack) {
    return { ok: false, msg: '请先在「设置 → 同步设置」勾选确认选项（知晓同步到云端存在泄露风险）' };
  }
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
  if (s.method && s.method !== 'off' && !s.ack) {
    return { ok: false, msg: '请先在「设置 → 同步设置」勾选确认选项（知晓同步到云端存在泄露风险）' };
  }
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
let autoSyncDelay = null, autoSyncLoop = null;
function scheduleAutoSync() {
  if (autoSyncDelay) { clearTimeout(autoSyncDelay); autoSyncDelay = null; }
  if (autoSyncLoop) { clearInterval(autoSyncLoop); autoSyncLoop = null; }
  const s = config.sync || {};
  if (!s.auto) return;
  const mins = Math.max(1, Number(s.intervalMin) || 30);
  autoSyncDelay = setTimeout(() => {
    autoSyncDelay = null;
    syncNow();
    autoSyncLoop = setInterval(syncNow, mins * 60000);
  }, 60000);
  log('auto sync scheduled: interval ' + mins + 'min');
}
ipcMain.handle('sync:get-config', () => (config.sync || {}));
ipcMain.handle('sync:save-config', (e, sc) => {
  config.sync = sc;
  saveConfig();
  scheduleAutoSync();
  return config.sync;
});
ipcMain.handle('sync:test', (e, p) => {
  const p2 = p || {};
  if (p2.method === 'git') return gitTest(p2.git || {});
  if (p2.method === 'webdav') return webdavTest(p2.webdav || {});
  return { ok: false, msg: '请先选择同步方式（Git 或 WebDAV）' };
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
  const s = config.sync || {};
  if (s.method && s.method !== 'off' && !s.ack) {
    return { ok: false, msg: '请先在「设置 → 同步设置」勾选确认选项（知晓同步到云端存在泄露风险）' };
  }
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
