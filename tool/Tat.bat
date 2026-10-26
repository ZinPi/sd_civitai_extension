@echo off
cd /d "%~dp0"
title Tat tool
set "PID="
if exist "%~dp0tool.pid" set /p PID=<"%~dp0tool.pid"
if defined PID taskkill /PID %PID% /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
if exist "%~dp0tool.pid" del "%~dp0tool.pid"
echo Da tat tool. Trang web se khong mo duoc nua.
echo Bam dup Chay.bat khi muon mo lai.
timeout /t 4 /nobreak >nul
exit /b 0
