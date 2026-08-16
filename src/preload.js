const { contextBridge, ipcRenderer } = require('electron');

try { ipcRenderer.send('debug:log', 'preload loaded @ ' + (typeof location !== 'undefined' ? location.href : '?')); } catch (e) {}

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  checkEnv: () => ipcRenderer.invoke('setup:check'),
  installSetup: () => ipcRenderer.invoke('setup:install'),
  skipSetup: () => ipcRenderer.invoke('setup:skip'),
  onSetupProgress: (cb) => ipcRenderer.on('setup:progress', (e, m) => cb(m)),
  getSyncConfig: () => ipcRenderer.invoke('sync:get-config'),
  saveSyncConfig: (sc) => ipcRenderer.invoke('sync:save-config', sc),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  testSync: (params) => ipcRenderer.invoke('sync:test', params),
  restoreSync: () => ipcRenderer.invoke('sync:restore'),
  backupCreate: () => ipcRenderer.invoke('backup:create'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupRestore: (name) => ipcRenderer.invoke('backup:restore', name),
  installPlugin: (info) => ipcRenderer.invoke('plugin:install', info),
  rulesScan: () => ipcRenderer.invoke('rules:scan'),
  rulesImport: (sel) => ipcRenderer.invoke('rules:import', sel),
  searchPlugins: (params) => ipcRenderer.invoke('plugin:search', params),
  getReadme: (fullName) => ipcRenderer.invoke('plugin:readme', fullName),
});

// ============ overview injection (dsh-web-ui "概览" tab) ============
const C = {
  bg: 'var(--aion-bg-base, #161b22)',
  border: 'var(--aion-border-base, #21262d)',
  text3: 'var(--aion-text-tertiary, #8b949e)',
  text2: 'var(--aion-text-secondary, #8b949e)',
  text1: 'var(--aion-text-primary, #e6edf3)',
  ok: 'var(--aion-success, #3fb950)',
  bad: 'var(--aion-danger, #f85149)',
};
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function overviewHtml(o) {
  const ws = o.workspace || {};
  const dot = (ok) => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:${ok ? C.ok : C.bad};vertical-align:middle"></span>`;
  const card = (title, rows) => `
    <div style="background:${C.bg};border:1px solid ${C.border};border-radius:8px;padding:10px 12px;margin:10px 12px;font-family:var(--aion-font-sans, 'Segoe UI', sans-serif)">
      <div style="font-size:11px;color:${C.text3};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">${esc(title)}</div>
      ${rows.map((r) => `<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:5px;font-size:12px">
        <span style="color:${C.text2};flex:none">${r.k}</span>
        <span style="color:${C.text1};text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.v)}">${r.v}</span>
      </div>`).join('')}
    </div>`;
  return card('工作区', [
    { k: '路径', v: esc(ws.path) || '—' },
    { k: '会话数', v: esc(ws.sessions) },
    { k: '最近更新', v: ws.updatedAt ? new Date(ws.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—' },
  ]) +
  card('服务', [
    { k: '状态', v: (o.online ? dot(true) + '在线' : dot(false) + '离线') },
    { k: '端口', v: esc(o.port) },
    { k: '模型', v: esc(o.model) || '未配置' },
  ]) +
  card('环境', [
    { k: 'Node.js', v: (o.env && o.env.node ? dot(true) + '已安装' : dot(false) + '未安装') },
    { k: 'npm', v: (o.env && o.env.npm ? dot(true) + '已安装' : dot(false) + '未安装') },
    { k: 'dsh', v: (o.env && o.env.dsh ? dot(true) + '已安装' : dot(false) + '未安装') },
  ]) +
  card('插件', [
    { k: 'dsh-web-ui', v: esc(o.plugins) || '—' },
  ]) +
  `<div style="padding:0 12px;color:${C.text3};font-size:11px;line-height:1.6">模型、密钥请在 dsh 界面「设置」中配置；皮肤在「设置 → 皮肤中心」。</div>`;
}

// ============ usage stats extraction ============
function extractModelFromStorage() {
  try {
    const direct = ['model', 'llm.model', 'defaultModel', 'modelId', 'chatModel', 'activeModel'];
    for (const k of direct) {
      const v = localStorage.getItem(k);
      if (v && /deepseek|chat|reasoner|v\d|r\d/i.test(v) && v.length < 60) return v;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      const v = localStorage.getItem(k) || '';
      const m = (k + ' ' + v).match(/deepseek[\s_:-]*(chat|reasoner|v\d[\w.-]*|r\d[\w.-]*|code[\w.-]*|flash[\w.-]*)/i);
      if (m) return m[0].replace(/[\s_:]+/g, '-');
    }
  } catch (e) {}
  return null;
}
function extractStats() {
  if (!document.body) return null;
  const text = document.body.innerText || '';
  const s = { model: null, inTokens: null, outTokens: null, cacheHits: null, contextNow: null, contextMax: null, hitRate: null };
  const m1 = text.match(/deepseek[\s_:-]*(chat|reasoner|v\d[\w.-]*|r\d[\w.-]*|code[\w.-]*|flash[\w.-]*)/i);
  s.model = m1 ? m1[0].replace(/[\s_:]+/g, '-') : extractModelFromStorage();
  const num = (x) => {
    const m = x.match(/([\d.,]+)\s*([kKmM]?)/);
    if (!m) return null;
    let v = parseFloat(m[1].replace(/,/g, ''));
    if (/[kK]/.test(m[2])) v *= 1000;
    if (/[mM]/.test(m[2])) v *= 1000000;
    return Math.round(v);
  };
  let m;
  m = text.match(/输入[\s:：]*([\d.,]+\s*[kKmM]?)/);
  if (m) s.inTokens = num(m[1]);
  m = text.match(/输出[\s:：]*([\d.,]+\s*[kKmM]?)/);
  if (m) s.outTokens = num(m[1]);
  m = text.match(/([\d.,]+\s*[kKmM]?)\s*tokens?/i);
  if (m && s.outTokens == null) s.outTokens = num(m[1]);
  m = text.match(/缓存[\s:：]*([\d.,]+\s*[kKmM]?)/);
  if (m) s.cacheHits = num(m[1]);
  m = text.match(/([\d]+)\s*%\s*(缓存命中|命中率)/);
  if (m) s.hitRate = parseInt(m[1], 10);
  // context: only inside a line mentioning context keywords (avoids dates like 2026/8)
  const ctxLine = text.split('\n').find((l) => /context|上下文|ctx|占用/i.test(l));
  if (ctxLine) {
    const cm = ctxLine.match(/([\d.,]+\s*[kKmM]?)\s*\/\s*([\d.,]+\s*[kKmM]?)/);
    if (cm) { s.contextNow = num(cm[1]); s.contextMax = num(cm[2]); }
  }
  return s;
}

let lastStatsJson = '';
function reportStats() {
  try {
    const s = extractStats();
    if (!s) return;
    const j = JSON.stringify(s);
    if (j !== lastStatsJson) {
      lastStatsJson = j;
      ipcRenderer.send('stats:from-web', s);
    }
  } catch (e) {}
}

if (typeof document !== 'undefined') {
  try { ipcRenderer.send('debug:log', 'preload init start'); } catch (e) {}
  const debug = (msg) => { try { ipcRenderer.send('debug:log', String(msg)); } catch (e) {} };

  // ---- overview: robust 1s polling (survives SPA tab remounts) ----
  let lastRenderAt = 0;
  let overviewOkReported = false;
  const renderOverview = async () => {
    try {
      const host = document.getElementById('dsh-overview-host');
      if (!host) return;
      const o = await ipcRenderer.invoke('overview:get');
      let html = overviewHtml(o);
      // archived sessions card
      try {
        const ar = await ipcRenderer.invoke('archive:list');
        if (ar.ok && ar.items.length) {
          const rows = ar.items.map((it) => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px">
              <span style="color:${C.text2};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.id)}">${esc(it.id.slice(0, 13))}…</span>
              <span style="color:${it.exists ? C.text3 : 'var(--aion-danger, #f85149)'}">${it.exists ? '文件在' : '文件缺失'}</span>
              <button data-unarchive="${esc(it.id)}" style="background:var(--aion-bg-hover, #21262d);color:${C.text1};border:1px solid ${C.border};border-radius:4px;padding:1px 8px;font-size:11px;cursor:pointer">取消归档</button>
            </div>`).join('');
          html += `
            <div style="background:${C.bg};border:1px solid ${C.border};border-radius:8px;padding:10px 12px;margin:10px 12px;font-family:var(--aion-font-sans, 'Segoe UI', sans-serif)">
              <div style="font-size:11px;color:${C.text3};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">归档会话（${ar.items.length}）</div>
              ${rows}
              <div style="color:${C.text3};font-size:11px;margin-top:6px">取消归档后会话将重新出现在侧边栏</div>
            </div>`;
        }
      } catch (e) {}
      host.innerHTML = html;
      if (!overviewOkReported) { overviewOkReported = true; debug('overview rendered'); }
    } catch (e) {
      debug('overview error: ' + e.message);
    }
  };
  // immediate render when the host mounts, then throttle refreshes to 3s
  const ensureOverview = () => {
    if (document.getElementById('dsh-overview-host') && Date.now() - lastRenderAt > 3000) {
      lastRenderAt = Date.now();
      renderOverview();
    }
  };
  const mo = new MutationObserver(ensureOverview);
  // document.documentElement may be null during very early preload; observe
  // `document` itself (always present) to avoid a TypeError that kills the rest.
  mo.observe(document, { childList: true, subtree: true });
  setInterval(ensureOverview, 500);

  // archive card click delegation (contextIsolation-safe: no inline onclick)
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest ? ev.target.closest('[data-unarchive]') : null;
    if (!btn) return;
    const id = btn.getAttribute('data-unarchive');
    try {
      btn.textContent = '取消归档中…';
      btn.disabled = true;
      const r = await ipcRenderer.invoke('archive:unarchive', id);
      debug('unarchive ' + id + ': ' + r.msg);
      renderOverview();
    } catch (e) { debug('unarchive error: ' + e.message); }
  });

  // ---- stats every 2s ----
  setInterval(reportStats, 2000);
  reportStats();

  try { ipcRenderer.send('debug:log', 'preload init done'); } catch (e) {}
}
