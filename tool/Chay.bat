@echo off
cd /d "%~dp0"
title Tao prompt anh

if not exist "%~dp0mo.py" goto thieufile

set "PY="
set "PYW="
where py >nul 2>&1 && set "PY=py"
where pyw >nul 2>&1 && set "PYW=pyw"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PYW where pythonw >nul 2>&1 && set "PYW=pythonw"
if not defined PY if not defined PYW goto chuapython
if not defined PY set "PY=%PYW%"
if not defined PYW set "PYW=%PY%"

"%PY%" -c "import uvicorn, fastapi, httpx, tkinter" >nul 2>&1
if errorlevel 1 goto caidat
goto mo

:caidat
echo.
echo Lan dau can cai dat. Giu cua so nay mo, doi vai phut.
echo.
"%PY%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto loicai
"%PY%" -c "import tkinter" >nul 2>&1
if errorlevel 1 goto thieutk

:mo
echo.
echo Dang mo trang. Giu cua so nay, doi khoang 10 giay.
echo.
start "Tao prompt anh" /D "%~dp0" "%PYW%" "%~dp0mo.py"
set /a LAN=0

:doi
set /a LAN+=1
"%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)"
if not errorlevel 1 goto damo
if %LAN% GEQ 20 goto loimo
timeout /t 1 /nobreak >nul
goto doi

:damo
start "" "http://127.0.0.1:8765"
echo.
echo Trang da mo tren trinh duyet.
echo Neu chua thay, nhin tren thanh tac vu co cua so ten Tao prompt anh.
echo Cua so do dung de tat tool. Cua so den nay se tu dong.
timeout /t 5 /nobreak >nul
exit /b 0

:loimo
echo.
echo Chua mo duoc trang. Loi:
echo.
if exist "%~dp0loi.txt" type "%~dp0loi.txt"
echo.
echo Dang chay lai de hien loi. Dung dong cua so.
echo.
"%PY%" "%~dp0mo.py"
echo.
echo Chup man hinh ca cua so nay roi gui lai.
pause
exit /b 1

:thieufile
echo Khong thay file mo.py nam cung cho voi Chay.bat.
echo Hay tai lai file zip, bam Giai nen tat ca, mo thu muc tool, roi bam dup Chay.bat.
echo Dung bam Chay.bat ngay trong file zip.
echo.
pause
exit /b 1

:thieutk
echo Python nay khong mo duoc cua so.
echo Cai lai tu trang https://www.python.org/downloads/
echo Mo file cai, tick o Add python.exe to PATH, bam Install Now.
echo Dung cai Python tu Microsoft Store.
echo.
pause
exit /b 1

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
