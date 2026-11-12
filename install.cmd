@echo off
REM sajilo - ONE-CLICK installer for Windows.
REM
REM Double-click this file. It installs the instance, wires up the PATH and
REM the desktop shortcut, and then opens sajilo so you can start working.
REM No administrator rights, nothing to configure.
REM
REM   install.cmd              install and start
REM   install.cmd status       install, do not start
REM   install.cmd --no-start   install, do not start
setlocal

cd /d "%~dp0"

set "START=1"
for %%A in (%*) do (
  if /i "%%~A"=="status" set "START=0"
  if /i "%%~A"=="--no-start" set "START=0"
)

echo.
echo   sajilo - one-click install
echo   -------------------------------
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo install FAILED with exit code %RC%
  echo.
  pause
  exit /b %RC%
)

if "%START%"=="0" (
  echo.
  echo Run "sajilo" in a new terminal, or use the desktop shortcut.
  echo.
  pause
  exit /b 0
)

echo.
echo Starting sajilo - close this window or press Ctrl+C to stop it.
echo.
"%USERPROFILE%\.sajilo\bin\sajilo.cmd"
echo.
echo sajilo exited.
pause
exit /b 0
