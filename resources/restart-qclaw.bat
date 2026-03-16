@echo off
setlocal

set "EXE=%~dp0..\QClaw.exe"
set "LOG=%~dp0restart-debug.log"

echo [%time%] bat started > "%LOG%"
echo [%time%] EXE path: %EXE% >> "%LOG%"

if exist "%EXE%" (
  echo [%time%] EXE found >> "%LOG%"
) else (
  echo [%time%] EXE NOT FOUND >> "%LOG%"
  exit /b 1
)

echo [%time%] waiting for QClaw to exit >> "%LOG%"
ping -n 3 127.0.0.1 >nul

:wait_loop
tasklist /FI "IMAGENAME eq QClaw.exe" 2>nul | find /i "QClaw.exe" >nul
if not errorlevel 1 (
  echo [%time%] QClaw still running, waiting... >> "%LOG%"
  ping -n 2 127.0.0.1 >nul
  goto wait_loop
)

echo [%time%] QClaw exited, launching new instance >> "%LOG%"
start "" "%EXE%"
echo [%time%] start command issued >> "%LOG%"

exit /b 0
