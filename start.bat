@echo off
chcp 65001 > nul
echo [QClaw] 启动中...
cd /d "%~dp0"
start "" "%~dp0\QClaw.exe"
