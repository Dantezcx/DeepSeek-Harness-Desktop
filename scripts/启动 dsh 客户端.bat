@echo off
chcp 65001 >/dev/null
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
