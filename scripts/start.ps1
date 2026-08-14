# DSH client launcher: ensure `dsh web` is running, then open the client shell.
param([switch]$NoOpen)

$ErrorActionPreference = 'SilentlyContinue'
$Port   = 8123
$Url    = "http://127.0.0.1:$Port"
$Script = Join-Path $PSScriptRoot 'client.html'

function Test-Port {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $task = $c.ConnectAsync('127.0.0.1', $Port)
        if ($task.Wait(500)) { return $c.Connected } else { return $false }
    } catch { return $false }
    finally { if ($c) { $c.Close() } }
}

if (Test-Port) {
    Write-Host "[dsh] service already running at $Url" -ForegroundColor Green
} else {
    Write-Host "[dsh] starting 'dsh web --port $Port' in background..." -ForegroundColor Cyan
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c dsh web --port $Port" -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(120)
    $ready = $false
    while (-not (Test-Port)) {
        if ((Get-Date) -gt $deadline) { break }
        Start-Sleep -Milliseconds 800
    }
    if (Test-Port) {
        $ready = $true
        Write-Host "[dsh] service is up: $Url" -ForegroundColor Green
    } else {
        Write-Host "[dsh] ERROR: service did not start within 120s." -ForegroundColor Red
        Write-Host "[dsh] Try running manually: dsh web --port $Port" -ForegroundColor Yellow
    }
}

if (-not $NoOpen -and (Test-Port)) {
    Start-Sleep -Milliseconds 500
    Start-Process $Script
    Write-Host "[dsh] client opened: $Script" -ForegroundColor Green
} elseif (-not $NoOpen) {
    Write-Host "[dsh] client NOT opened (service unavailable)." -ForegroundColor Yellow
}
