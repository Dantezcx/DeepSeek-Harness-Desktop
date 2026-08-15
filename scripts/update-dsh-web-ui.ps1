$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot

Write-Host '[update] 0/5 检查 pnpm（dsh 插件系统依赖）...' -ForegroundColor Cyan
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host '[update] 未找到 pnpm，正在通过 npm 全局安装...' -ForegroundColor Yellow
    & npm install -g pnpm
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Host '[update] ERROR: pnpm 安装失败，请手动执行: npm install -g pnpm' -ForegroundColor Red
        exit 1
    }
}
Write-Host '[update] pnpm 就绪: ' + (pnpm --version) -ForegroundColor Green

Write-Host '[update] 1/5 停止 dsh 服务（释放文件占用）...' -ForegroundColor Cyan
if (Test-Path "$here\stop.ps1") { powershell -NoProfile -ExecutionPolicy Bypass -File "$here\stop.ps1" | Out-Host }

Write-Host '[update] 2/5 获取最新版本号...' -ForegroundColor Cyan
$raw = (& npm view @linxin666/dsh-web-ui-all version 2>&1 | Out-String)
$m = [regex]::Match($raw, '(\d+\.\d+\.\d+)')
if ($m.Success) { $ver = $m.Groups[1].Value } else { Write-Host '[update] 获取版本失败，退回 latest' -ForegroundColor Yellow; $ver = 'latest' }
Write-Host "[update] 目标版本: $ver"

Write-Host '[update] 3/5 更新 dsh-web-ui 插件（可能需要几分钟）...' -ForegroundColor Cyan
& dsh plugin --profile web add "@linxin666/dsh-web-ui-all@$ver"
if ($LASTEXITCODE -ne 0) { Write-Host '[update] 插件更新命令返回非零，继续尝试打补丁' -ForegroundColor Yellow }

Write-Host '[update] 4/5 重新打"概览"标签补丁...' -ForegroundColor Cyan
& node "$here\patch-aionui.js"

Write-Host '[update] 5/5 重启 dsh 服务...' -ForegroundColor Cyan
if (Test-Path "$here\start.ps1") { powershell -NoProfile -ExecutionPolicy Bypass -File "$here\start.ps1" -NoOpen | Out-Host }

Write-Host '[update] 全部完成' -ForegroundColor Green
