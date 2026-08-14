# Stop the dsh web service bound to port 8123.
$ErrorActionPreference = 'SilentlyContinue'
$Port = 8123

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $conns | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "[dsh] stopped process $($_.OwningProcess) (listener on port $Port)" -ForegroundColor Green
    }
} else {
    Write-Host "[dsh] no service listening on port $Port - nothing to stop." -ForegroundColor Yellow
}
