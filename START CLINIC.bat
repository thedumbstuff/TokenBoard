@echo off
cd /d "%~dp0"
title TokenBoard  --  DO NOT CLOSE THIS WINDOW
color 0F

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo.
  echo   Please install it once from  https://nodejs.org
  echo   Choose the big green "LTS" button, then click Next until it finishes.
  echo   After that, run this file again.
  echo.
  pause
  exit /b 1
)

start "" "%~dp0open-screens.bat"

:loop
echo.
echo   Starting TokenBoard...
node server.js
echo.
echo   ============================================================
echo   The queue system stopped unexpectedly. Restarting in 3 sec.
echo   Close this window to shut the system down properly.
echo   ============================================================
timeout /t 3 >nul
goto loop
