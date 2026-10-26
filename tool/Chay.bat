@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Tao prompt anh

set "PY="
set "PYW="
where py >nul 2>&1 && set "PY=py"
where pyw >nul 2>&1 && set "PYW=pyw"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PYW where pythonw >nul 2>&1 && set "PYW=pythonw"
if not defined PY if not defined PYW goto chuapython
if not defined PY set "PY=%PYW%"
if not defined PYW set "PYW=%PY%"

"%PY%" -c "import uvicorn, fastapi, httpx" >nul 2>&1
if errorlevel 1 goto caidat
goto mo

:caidat
echo.
echo Lan dau can cai dat. Cua so den nay se tu tat khi xong.
echo Doi vai phut. Dung dong cua so.
echo.
"%PY%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto loicai

:mo
start "" "%PYW%" "%~dp0mo.py"
exit /b 0

:chuapython
echo Chua tim thay Python tren may.
echo.
echo Lam dung 4 viec nay, roi bam dup chuot file Chay.bat lan nua:
echo 1. Mo trinh duyet, vao https://www.python.org/downloads/
echo 2. Bam nut vang Download Python
echo 3. Mo file vua tai. O man hinh dau, tick o Add python.exe to PATH o sat day
echo 4. Bam Install Now. Cai xong thi dong het cua so den, roi bam dup Chay.bat
echo.
pause
exit /b 1

:loicai
echo.
echo Cai thu vien khong duoc. Chup man hinh ca cua so nay roi gui lai.
pause
exit /b 1
