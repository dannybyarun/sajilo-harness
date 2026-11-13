@echo off
REM usque-rotate.cmd - rotate the usque WARP identity (no administrator rights).
REM
REM The relay calls the rotator as "<rotator> --rotate-only"; the flag is
REM accepted and ignored, because rotating usque means the same thing on
REM every platform: stop the proxy, register a fresh anonymous WARP account,
REM start it again. A new account is a new exit IP is a new quota bucket.
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%usque-rotate.ps1" %*
exit /b %ERRORLEVEL%
