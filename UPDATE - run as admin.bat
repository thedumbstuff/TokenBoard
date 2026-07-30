@echo off
setlocal
rem TokenBoard updater. The data folder - numbers, settings, archives - is
rem never touched. Keeps a backup and rolls back if the new version fails
rem its self-check.

rem run from a temp copy, so the update can safely replace this very file
if /i not "%~dp0"=="%TEMP%\" (
  set "APPDIR=%~dp0"
  copy /y "%~f0" "%TEMP%\tokenboard-update.bat" >nul
  call "%TEMP%\tokenboard-update.bat"
  exit /b %errorlevel%
)

title TokenBoard - update
cd /d "%APPDIR%"
echo.
echo   TokenBoard - update
echo   ============================================
echo.

net session >nul 2>nul
if errorlevel 1 (
  echo   [X] Please right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

rem ---- where is the new version coming from? -----------------------------
set "SRC="
if exist "%APPDIR%update\server.js" set "SRC=%APPDIR%update"
if defined SRC goto :have_src

if not exist "%APPDIR%.git" goto :try_download
where git >nul 2>nul
if errorlevel 1 goto :try_download
set "SRC=GIT"
goto :have_src

:try_download
echo   Downloading the latest version...
rmdir /s /q "%TEMP%\tokenboard-new" >nul 2>nul
del "%TEMP%\tokenboard-new.zip" >nul 2>nul
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest 'https://github.com/thedumbstuff/TokenBoard/archive/refs/heads/main.zip' -OutFile ($env:TEMP + '\tokenboard-new.zip') -UseBasicParsing; Expand-Archive -Path ($env:TEMP + '\tokenboard-new.zip') -DestinationPath ($env:TEMP + '\tokenboard-new') -Force } catch { exit 1 }"
if errorlevel 1 goto :no_source
if not exist "%TEMP%\tokenboard-new\TokenBoard-main\server.js" goto :no_source
set "SRC=%TEMP%\tokenboard-new\TokenBoard-main"
goto :have_src

:no_source
echo.
echo   [X] Could not get the new version.
echo.
echo       Either connect this PC to the internet and run this again, or ask
echo       for the new TokenBoard files, copy them into a folder called
echo           update
echo       inside the TokenBoard folder, and run this again.
echo.
pause
exit /b 1

:have_src

rem ---- stop TokenBoard while we work --------------------------------------
echo   Stopping TokenBoard...
taskkill /fi "WINDOWTITLE eq TokenBoard*" /f >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

rem ---- keep the old version, in case --------------------------------------
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set "STAMP=%%t"
echo   Keeping a copy of the current version in  backup\%STAMP%
robocopy "%APPDIR%." "%APPDIR%backup\%STAMP%" /E /XD data backup update .git node_modules >nul
if errorlevel 8 goto :backup_failed

rem ---- bring in the new version -------------------------------------------
if "%SRC%"=="GIT" goto :apply_git

echo   Copying the new files...
robocopy "%SRC%" "%APPDIR%." /E /XD data backup update .git node_modules >nul
if errorlevel 8 goto :apply_failed
if exist "%APPDIR%update\server.js" ren "%APPDIR%update" "update-installed-%STAMP%" >nul 2>nul
goto :check

:apply_git
echo   Updating with git...
git pull --ff-only
if errorlevel 1 goto :apply_failed
goto :check

rem ---- the new version must pass its own tests ----------------------------
:check
echo   Checking the new version - this takes about ten seconds...
node "%APPDIR%test.js" >nul 2>nul
if not errorlevel 1 goto :done

echo.
echo   [!] The new version failed its self-check. Putting the old one back...
robocopy "%APPDIR%backup\%STAMP%" "%APPDIR%." /E /XD data >nul
echo   [OK] The previous version is restored. Nothing is lost.
goto :restart

:done
echo   [OK] Update finished.

:restart
echo.
echo   Starting TokenBoard...
start "" "%APPDIR%START CLINIC.bat"
echo.
pause
exit /b 0

:backup_failed
echo   [X] Could not make a backup - stopping here. Nothing was changed.
pause
exit /b 1

:apply_failed
echo   [X] Could not bring in the new files.
echo       If anything looks wrong, copy everything from  backup\%STAMP%
echo       back into this folder - but leave data\ alone.
pause
exit /b 1
