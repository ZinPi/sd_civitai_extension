@echo off
cd /d "%~dp0"
title Tao prompt anh

if not exist "%~dp0mo.py" goto thieufile
if not exist "%~dp0Tat.bat" goto thieufile

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
echo.
"%PY%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto loicai

:mo
echo.
echo Dang mo trang. Doi mot chut.
echo Khi trang mo, cua so den nay giu mo.
echo Dong tab la cua so den tu tat. Tat som cua so cung duoc.
echo.
if exist "%~dp0loi.txt" del "%~dp0loi.txt"
"%PY%" "%~dp0mo.py" --nen
if errorlevel 1 goto loimo
set /a LAN=0

:doi
set /a LAN+=1
"%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)"
if not errorlevel 1 goto damo
if exist "%~dp0loi.txt" goto loimo
if %LAN% GEQ 20 goto loimo
timeout /t 1 /nobreak >nul
goto doi

:damo
echo.
echo Trang da mo tren trinh duyet.
echo Dong tab trang la tool tu tat, cua so den nay cung tat.
echo Neu tat som cua so den, trang van chay den khi dong tab.
echo.
set /a MAT=0

:cho
"%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)"
if errorlevel 1 goto mat
set /a MAT=0
timeout /t 1 /nobreak >nul
goto cho

:mat
set /a MAT+=1
if %MAT% GEQ 2 goto xong
timeout /t 1 /nobreak >nul
goto cho

:xong
exit

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
echo Lam lan luot:
echo.
echo 1. Mo trinh duyet. Bam vao thanh dia chi o tren cung.
echo 2. Dan dong nay roi bam Enter:
echo https://github.com/ZinPi/sd_civitai_extension/archive/refs/heads/cursor/quy-tac-tool-48d3.zip
echo 3. Tai xong, bam phai vao file zip. Chon Extract All hoac Giai nen tat ca.
echo 4. Mo thu muc vua giai nen. Mo tiep thu muc ten tool.
echo 5. Trong thu muc tool phai thay ca hai file Chay.bat va Tat.bat.
echo 6. Bam dup Chay.bat. Dung bam file ngay ben trong file zip.
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
