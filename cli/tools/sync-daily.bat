@echo off
rem Daily sync: import the report + attach classified images produced by the
rem material collector tool (the Electron app in the HANHAI source tree).
rem The scheduled task runs this every 15 minutes; this file is for manual re-runs.
rem ASCII ONLY on purpose: cmd.exe parses .bat with the ANSI codepage, and a single
rem non-ASCII byte in a comment breaks quoting (learned the hard way).

set "TOOLS=%~dp0"
python "%TOOLS%sync_daily_batch.py" --write %*
echo.
echo Done. Click Refresh in the tracker app.
pause
