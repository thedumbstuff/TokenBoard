@echo off
cd /d "%~dp0"
title TokenBoard - first time setup
echo.
echo   TokenBoard - one time setup
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is NOT installed.
  echo       Install it from https://nodejs.org  ^(green LTS button^),
  echo       then run this setup again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v found.

rem ---- desktop shortcut -------------------------------------------------
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\TokenBoard.lnk');" ^
  "$s.TargetPath='%~dp0START CLINIC.bat'; $s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%~dp0public\icon.ico,0'; $s.Save()" >nul 2>nul
if errorlevel 1 (echo   [!] Could not create the desktop shortcut.) else (echo   [OK] Desktop shortcut "TokenBoard" created.)

rem ---- start automatically when Windows starts ---------------------------
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\TokenBoard.lnk');" ^
  "$s.TargetPath='%~dp0START CLINIC.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0public\icon.ico,0'; $s.Save()" >nul 2>nul
if errorlevel 1 (echo   [!] Could not set auto-start.) else (echo   [OK] Will start automatically after a power cut / reboot.)

rem ---- allow phones on the same WiFi to reach it -------------------------
netsh advfirewall firewall show rule name="TokenBoard" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="TokenBoard" dir=in action=allow protocol=TCP localport=8080 >nul 2>nul
  if errorlevel 1 (
    echo   [!] Firewall rule not added. Right-click this file and choose
    echo       "Run as administrator" if the doctor wants to use his phone.
  ) else (
    echo   [OK] Firewall opened on port 8080 for phones/tablets.
  )
) else (
  echo   [OK] Firewall rule already present.
)

echo.
echo   Setup finished. Use the "TokenBoard" icon on the desktop.
echo.
pause
