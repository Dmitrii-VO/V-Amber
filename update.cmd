@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0update.ps1"
if %errorlevel% neq 0 (
  echo.
  pause
)
