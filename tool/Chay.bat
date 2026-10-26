@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Tao prompt anh

where py >nul 2>&1
if %errorlevel%==0 (
  set "PY=py"
) else (
  where python >nul 2>&1
  if errorlevel 1 goto chuapython
  set "PY=python"
)

echo.
echo Dang chuan bi. Lan dau co the mat vai phut.
echo Cu de cua so nay mo. Dong cua so la trang se tat.
echo.
%PY% -m pip install -r requirements.txt
if errorlevel 1 goto loicai

echo.
echo Mo Chrome hoac Edge. Bam vao thanh dia chi o tren cung, dan dong nay roi Enter:
echo.
echo     http://127.0.0.1:8765
echo.
echo Giu nguyen cua so den nay. Dung xong thi dong cua so nay.
echo.
%PY% app.py
echo.
echo Trang da tat.
pause
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
