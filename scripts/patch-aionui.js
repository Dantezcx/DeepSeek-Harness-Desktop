// 为 dsh-web-ui 的右侧面板（aionui-panel）打"概览"标签补丁（幂等）。
// 用法: node patch-aionui.js
// 更新 dsh-web-ui 后重新运行即可（若锚点不匹配会明确报错，便于适配新版）。
// 路径基于 %USERPROFILE% 动态解析（不再硬编码用户名），换机器/用户也能运行。
const fs = require('fs');
const path = require('path');

const USER = process.env.USERPROFILE || process.env.HOME || '';
const LIXIN_DIR = path.join(USER, '.dsh', 'profiles', 'web', 'node_modules', '@linxin666');

function findClientJs() {
  if (!fs.existsSync(LIXIN_DIR)) return null;
  // 首选 aionui-panel 包
  const primary = path.join(LIXIN_DIR, 'dsh-client-ui-aionui-panel', 'lib', 'client.js');
  if (fs.existsSync(primary)) return primary;
  // 兼容包名变化：扫描 @linxin666 下所有含 aionui 的包
  for (const pkg of fs.readdirSync(LIXIN_DIR)) {
    if (!/aionui/i.test(pkg)) continue;
    const cand = path.join(LIXIN_DIR, pkg, 'lib', 'client.js');
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

const P = findClientJs();
if (!P) {
  console.error('[patch] 未找到 aionui-panel client.js（@linxin666 插件未安装？目录: ' + LIXIN_DIR + '）');
  process.exit(1);
}

let s = fs.readFileSync(P, 'utf8');

// 幂等：已打过补丁则直接跳过
if (s.includes('explorer.tabs.overview') || s.includes('dsh-overview-host')) {
  console.log('[patch] 检测到补丁已存在，跳过（幂等）');
  process.exit(0);
}

function need(ok, what) { if (!ok) throw new Error('[patch] 锚点未找到: ' + what); }

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

fs.writeFileSync(P, s);
console.log('[patch] 补丁应用成功：右侧面板新增"概览"标签 (' + P + ')');
