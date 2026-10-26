@echo off
cd /d "%~dp0"
title Tao prompt anh

if not exist "%~dp0mo.py" goto thieufile
if not exist "%~dp0chay_an.vbs" goto thieufile

set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY goto chuapython

"%PY%" -c "import uvicorn, fastapi, httpx" >nul 2>&1
if errorlevel 1 goto caidat
goto mo

:caidat
echo.
echo Lan dau can cai dat. Giu cua so nay mo, doi vai phut.
echo Cua so nay se tu tat sau khi trang mo.
echo.
"%PY%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto loicai

:mo
echo.
echo Dang mo trang. Doi mot chut. Dung dong cua so nay.
echo.
"%PY%" -c "import pathlib,sys; print(pathlib.Path(sys.executable).with_name('pythonw.exe'))" > "%~dp0pyw-path.txt"
set /p PYW=<"%~dp0pyw-path.txt"
del "%~dp0pyw-path.txt"
if not exist "%PYW%" set "PYW=%PY%"
cscript //nologo "%~dp0chay_an.vbs" "%PYW%"
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
echo Trang da mo. Cua so den nay se tu tat.
echo Trang van con khi cua so den da tat.
echo Muon tat tool thi bam dup file Tat.bat
timeout /t 6 /nobreak >nul
exit /b 0

:loimo
echo.
echo Chua mo duoc trang.
if exist "%~dp0loi.txt" type "%~dp0loi.txt"
echo.
echo Chup man hinh ca cua so nay roi gui lai.
pause
exit /b 1

:thieufile
echo Ban dang dung ban cu, hoac chua giai nen file zip.
echo Tai lai file zip, bam Giai nen tat ca, mo thu muc tool.
echo Trong do phai co file Tat.bat. Roi bam dup Chay.bat.
echo.
pause
exit /b 1

:chuapython
echo Chua tim thay Python tren may.
echo.
echo 1. Mo trinh duyet, vao https://www.python.org/downloads/
echo 2. Bam nut vang Download Python
echo 3. Mo file vua tai. Tick o Add python.exe to PATH o sat day
echo 4. Bam Install Now. Cai xong, bam dup Chay.bat lan nua
echo.
pause
exit /b 1

:loicai
echo.
echo Cai thu vien khong duoc. Chup man hinh ca cua so nay roi gui lai.
pause
exit /b 1
