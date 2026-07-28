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

rem ---- never start a second copy: is something already on port 8080? ----
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 8080); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   TokenBoard is already running on this computer.
  echo   Use the window that is already open. This one will close.
  echo.
  pause
  exit /b 0
)

start "" "%~dp0open-screens.bat"

:loop
echo.
echo   Starting TokenBoard...
node server.js
if errorlevel 2 (
  echo.
  echo   TokenBoard is already running in another window.
  echo   Use that one. This window will close.
  echo.
  pause
  exit /b 0
)
echo.
echo   ============================================================
echo   The queue system stopped unexpectedly. Restarting in 3 sec.
echo   Close this window to shut the system down properly.
echo   ============================================================
timeout /t 3 >nul
goto loop
