@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Closing both clients is required before merging.
echo.
python merge_tracker_into_main.py --write
echo.
pause
