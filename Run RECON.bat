@echo off
title RECON launcher
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   Could not find .venv\Scripts\python.exe
  echo   Expected it under: %cd%
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting RECON on http://127.0.0.1:8000
echo   A second window will open running the server. Close it to stop RECON.
echo.

start "RECON server" ".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000

timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:8000

exit
