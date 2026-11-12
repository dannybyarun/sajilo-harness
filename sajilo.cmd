@echo off
REM sajilo.cmd - launch sajilo, a coding agent harness on Windows.
REM
REM Sajilo is a COMPLETELY SEPARATE instance: its own HOME (USERPROFILE for
REM Bun on Windows), its own project dir, its own relay on 43914, its own
REM pins, mint dir and logs. Nothing it does can touch an opencode you are
REM already running.
REM
REM   sajilo.cmd              interactive TUI
REM   sajilo.cmd run "hello"  headless, one prompt
REM   sajilo.cmd status       what is running
REM   sajilo.cmd shell        a shell with the sajilo environment
REM
REM Delayed expansion stays OFF on purpose: it would eat "!" characters that
REM belong to the prompt passed to "sajilo run ...".
setlocal DisableDelayedExpansion

if "%SAJILO_ROOT%"=="" (
  set "ROOT=%USERPROFILE%\.sajilo"
) else (
  set "ROOT=%SAJILO_ROOT%"
)
set "HOME_DIR=%ROOT%\home"
set "STATE=%ROOT%\state"
set "WORK=%ROOT%\work"
set "PLUGIN_DIR=%HOME_DIR%\.config\opencode\plugin"
REM The port override must be COPIED, not just defaulted: setting the env var
REM to something else used to leave RELAY_PORT empty, which pointed the client
REM at http://127.0.0.1/ (port 80) and made the relay bind a random
REM ephemeral port.
if "%SAJILO_RELAY_PORT%"=="" (
  set "RELAY_PORT=43914"
) else (
  set "RELAY_PORT=%SAJILO_RELAY_PORT%"
)

REM The opencode binary is sajilo's runtime. The installer pins the exact one
REM it found (or downloaded) so sajilo always starts the same binary,
REM whatever shell launched it. The pin is only used when it points at a file
REM that really exists, so a POSIX path written by the Linux installer can
REM never break this launcher.
if exist "%STATE%\sajilo-bin.txt" (
  for /f "usebackq delims=" %%B in ("%STATE%\sajilo-bin.txt") do if exist "%%B" set "OPENCODE_BIN=%%B"
)
if "%OPENCODE_BIN%"=="" if "%SAJILO_BIN%"=="" set "OPENCODE_BIN=opencode"
if "%OPENCODE_BIN%"=="" set "OPENCODE_BIN=%SAJILO_BIN%"

if not exist "%PLUGIN_DIR%\resources" mkdir "%PLUGIN_DIR%\resources"
if not exist "%STATE%" mkdir "%STATE%"
if not exist "%WORK%" mkdir "%WORK%"
if not exist "%ROOT%\mint" mkdir "%ROOT%\mint"

REM --- environment for the child only ---------------------------------------
set "HOME=%HOME_DIR%"
set "USERPROFILE=%HOME_DIR%"
set "SAJILO_RELAY_PORT=%RELAY_PORT%"
set "SAJILO_RELAY_DIR=%PLUGIN_DIR%"
set "SAJILO_RELAY_MINT_DIR=%ROOT%\mint"
set "SAJILO_RELAY_ACTIVITY_LOG=%STATE%\relay-activity.log"
set "SAJILO_RELAY_UPSTREAM_FILE=%STATE%\relay-upstream.txt"
set "SAJILO_RELAY_DIRECT_EGRESS_FLAG=%STATE%\direct-egress"
set "SAJILO_RELAY_RESCUE_LOG=%STATE%\rescue.log"
set "SAJILO_ROTATE_MARKER=%STATE%\.rotate.inprogress"
REM No usque on Windows: the sajilo relay uses the device's native egress and
REM has no proxy of its own, so it never shares a bucket with another opencode.
set "HTTPS_PROXY="
set "HTTP_PROXY="
set "SAJILO_RELAY_PROXY="
set "OPENCODE_RELAY_PROXY="
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

REM --- point the runtime at the sajilo relay --------------------------------
if /i not "%~1"=="direct" (
  >"%HOME_DIR%\.config\opencode\opencode.json" echo {"$schema":"https://opencode.ai/config.json","provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:%RELAY_PORT%/openai/v1"}}}}
) else (
  if exist "%HOME_DIR%\.config\opencode\opencode.json" del /q "%HOME_DIR%\.config\opencode\opencode.json"
)

if /i "%~1"=="status" (
  echo root       : %ROOT%
  echo relay      : http://127.0.0.1:%RELAY_PORT%/relay-health
  echo db         : %HOME_DIR%\.local\share\opencode\opencode.db
  echo project    : %WORK%
  echo runtime    : %OPENCODE_BIN%
  echo tunnel     : none on Windows ^(native egress^)
  exit /b 0
)

cd /d "%WORK%"
if /i "%~1"=="run" goto :do_run
if /i "%~1"=="shell" (
  cmd /k
  exit /b 0
)
"%OPENCODE_BIN%" --standalone %*
exit /b %errorlevel%

REM --- run: rebuild the argument list by hand --------------------------------
REM "%*" is NOT affected by SHIFT in a batch file, so passing it after a
REM SHIFT would smuggle the literal word "run" into the prompt. Read %1..%9
REM one at a time, each on its own line so every SHIFT is seen immediately.
REM Each argument is re-quoted so spacing and inner quotes survive intact.
:do_run
shift
set "ARGS="
:do_run_next
if "%~1"=="" goto :do_run_exec
set "ARGS=%ARGS% "%~1""
shift
goto :do_run_next
:do_run_exec
"%OPENCODE_BIN%" run --standalone%ARGS%
exit /b %errorlevel%
