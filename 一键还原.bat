@echo off
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  python -X utf8 restore.py
) else (
  py -3 -X utf8 restore.py
)
pause
