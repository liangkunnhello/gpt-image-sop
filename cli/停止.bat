@echo off
echo Stopping Batch Image Console (port 7799)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7799 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Done.
timeout /t 2 >nul
