@echo off
chcp 65001 >/dev/null
echo ============================================
echo   dsh-web-ui 一键更新 + 自动打补丁
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-dsh-web-ui.ps1"
echo.
pause
