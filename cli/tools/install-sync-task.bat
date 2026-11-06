@echo off
rem Install the Windows scheduled task that runs sync_daily_batch.py every 15 min.
rem It exits immediately when there is nothing new, so a short interval is cheap.
rem Remove with: schtasks /delete /tn "GPT-SOP-daily-sync" /f
rem ASCII only: cmd.exe parses .bat with the ANSI codepage.

setlocal
set "TOOLS=%~dp0"
set "TASK=GPT-SOP-daily-sync"

for /f "delims=" %%i in ('where python') do (
  set "PY=%%i"
  goto :gotpy
)
:gotpy

if not defined PY (
  echo [ERROR] python not found in PATH.
  pause
  exit /b 1
)

echo Python : %PY%
echo Script : %TOOLS%sync_daily_batch.py
echo Task   : %TASK%
echo.

schtasks /create /f /tn "%TASK%" /tr "\"%PY%\" \"%TOOLS%sync_daily_batch.py\" --write --quiet" /sc minute /mo 15 /rl LIMITED

if errorlevel 1 (
  echo.
  echo [ERROR] Failed to create the task. Usual causes:
  echo   1. no permission - right click this file, Run as administrator
  echo   2. task already exists - run: schtasks /delete /tn "%TASK%" /f
  pause
  exit /b 1
)

echo.
echo Created. Running once now to verify...
schtasks /run /tn "%TASK%"
timeout /t 10 >nul
schtasks /query /tn "%TASK%" /v /fo LIST | findstr /i "Status Last"

echo.
echo Logs: %LOCALAPPDATA%\GPT SOP Tracker\data\sync-logs
pause
