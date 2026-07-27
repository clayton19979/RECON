@echo off
title RECON launcher
cd /d "%~dp0"

REM Development launcher: runs RECON from source in its own window, exactly
REM the way the installed exe does. The old version started bare uvicorn and
REM opened a browser tab, which is no longer how the app works -- and nothing
REM stopped it launching a second server on top of the first.

if not exist ".venv\Scripts\pythonw.exe" (
  echo.
  echo   Could not find .venv\Scripts\pythonw.exe
  echo   Expected it under: %cd%
  echo   Run this first:  uv sync
  echo.
  pause
  exit /b 1
)

start "" ".venv\Scripts\pythonw.exe" -m app.tray_app
exit
