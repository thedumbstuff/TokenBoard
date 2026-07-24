@echo off
rem Waits for the server to come up, then opens both screens.
rem Called automatically by "START CLINIC.bat" - you do not need to run this.

set PORT=8080
set TRIES=0

:wait
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',%PORT%);exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto ready
set /a TRIES+=1
if %TRIES% GEQ 30 goto giveup
timeout /t 1 >nul
goto wait

:ready
start "" "http://localhost:%PORT%/"
timeout /t 2 >nul
start "" "http://localhost:%PORT%/display"
exit /b 0

:giveup
echo Could not reach the queue system on port %PORT%.
echo Open http://localhost:%PORT%/ in your browser manually.
pause
exit /b 1
