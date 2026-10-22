@echo off
cd /d "%~dp0"
title Batch Image Console - http://127.0.0.1:7799
echo ============================================
echo   Batch Image Console
echo   http://127.0.0.1:7799
echo   Close this window or press Ctrl+C to stop
echo ============================================
echo.
"C:\Program Files\nodejs\node.exe" app\server.mjs --open
echo.
echo Server stopped.
pause
