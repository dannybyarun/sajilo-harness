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

REM Capture our own directory NOW: after a SHIFT, %~dp0 stops pointing at
REM this script and resolves to the caller's directory instead.
set "SELF_DIR=%~dp0"

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
REM A rebranded runtime ("sajilo rebrand") is this instance's own patched copy
REM and wins over everything else - it is the only way to change the welcome
REM art without touching the opencode the rest of the machine uses.
if exist "%STATE%\rebrand.txt" (
  for /f "usebackq delims=" %%R in ("%STATE%\rebrand.txt") do if exist "%%R" set "OPENCODE_BIN=%%R"
)
if "%OPENCODE_BIN%"=="" if "%SAJILO_BIN%"=="" set "OPENCODE_BIN=opencode"
if "%OPENCODE_BIN%"=="" set "OPENCODE_BIN=%SAJILO_BIN%"

if not exist "%PLUGIN_DIR%\resources" mkdir "%PLUGIN_DIR%\resources"
if not exist "%STATE%" mkdir "%STATE%"
if not exist "%WORK%" mkdir "%WORK%"
if not exist "%ROOT%\mint" mkdir "%ROOT%\mint"

REM --- the model the harness wants ------------------------------------------
REM One pin file, read live by BOTH sides: "sajilo model <name>" writes it,
REM the launcher puts it in the runtime config, and the relay honours the same
REM file when a request carries no model. Change the model in the harness and
REM the relay follows it.
REM (Read BEFORE the environment block below: it exports MODEL_FILE.)
set "MODEL_FILE=%STATE%\model.txt"
set "MODEL_ID="
set "MODEL_AUTO="
if exist "%MODEL_FILE%" (
  for /f "usebackq delims=" %%M in ("%MODEL_FILE%") do set "MODEL_ID=%%M"
)
if /i "%MODEL_ID%"=="auto" (
  set "MODEL_ID="
  set "MODEL_AUTO=1"
)
if "%MODEL_ID%"=="" if not "%MODEL_AUTO%"=="1" set "MODEL_ID=deepseek-v4.1-flash-free"
set "PROVIDER_PREFIX=sajilo"
if exist "%STATE%\stock-identity" set "PROVIDER_PREFIX=opencode"
set "MODEL_JSON="
if not "%MODEL_ID%"=="" set "MODEL_JSON=,"model":"%PROVIDER_PREFIX%/%MODEL_ID%""

REM --- environment for the child only ---------------------------------------
set "HOME=%HOME_DIR%"
set "USERPROFILE=%HOME_DIR%"
set "SAJILO_ROOT=%ROOT%"
set "SAJILO_RELAY_PORT=%RELAY_PORT%"
set "SAJILO_RELAY_DIR=%PLUGIN_DIR%"
set "SAJILO_RELAY_MINT_DIR=%ROOT%\mint"
set "SAJILO_RELAY_ACTIVITY_LOG=%STATE%\relay-activity.log"
set "SAJILO_RELAY_UPSTREAM_FILE=%STATE%\relay-upstream.txt"
set "SAJILO_RELAY_DIRECT_EGRESS_FLAG=%STATE%\direct-egress"
set "SAJILO_RELAY_RESCUE_LOG=%STATE%\rescue.log"
set "SAJILO_RELAY_MODEL_FILE=%MODEL_FILE%"
set "SAJILO_RELAY_DUMP_DIR=%STATE%"
set "SAJILO_RELAY_RUNTIME=%OPENCODE_BIN%"
set "SAJILO_ROTATE_MARKER=%STATE%\.rotate.inprogress"
REM No usque on Windows: the sajilo relay uses the device's native egress and
REM has no proxy of its own, so it never shares a bucket with another opencode.
set "HTTPS_PROXY="
set "HTTP_PROXY="
REM The proxied leg of the egress ladder. A second egress is a second quota
REM bucket - the free allowance is keyed on the exit IP - so a drained bucket
REM can be climbed over instead of answered. The Cloudflare WARP service
REM (warp-svc.exe) listens on 127.0.0.1:40000 while WARP is on, and that is
REM the local proxy to use. Whatever the user set is kept.
if "%SAJILO_RELAY_PROXY%"=="" (
  netstat -ano | findstr /R /C:"127.0.0.1:40000 .*LISTENING" >nul 2>&1
  if not errorlevel 1 set "SAJILO_RELAY_PROXY=http://127.0.0.1:40000"
)
REM The SECOND leg of the egress ladder: the device's OWN exit, not the
REM tunnel's. The shim (egress-proxy.py --upstream direct) connects with a
REM raw socket, so it leaves the tunnel - and a different exit IP is a
REM different quota bucket, which is what the ladder climbs to. Bun < 1.4
REM ignores NO_PROXY, so this is the only way out of the tunnel on Windows.
REM The relay starts the shim itself if it is not running yet.
if "%SAJILO_RELAY_DIRECT_PROXY%"=="" set "SAJILO_RELAY_DIRECT_PROXY=http://127.0.0.1:40001"
REM What the relay will actually use, written down so `sajilo doctor` (which
REM runs in a plain shell, with none of this env) can report the real legs
REM instead of guessing.
> "%STATE%\relay-env.txt" (
  echo SAJILO_RELAY_PROXY=%SAJILO_RELAY_PROXY%
  echo SAJILO_RELAY_DIRECT_PROXY=%SAJILO_RELAY_DIRECT_PROXY%
)
set "OPENCODE_RELAY_PROXY="
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

REM --- the TUI's own identity ------------------------------------------------
REM The runtime draws its own product name in the window title and the splash
REM banner. These CLI settings are injected inline (nothing to edit by hand):
REM   terminal.title false -> the tab stops saying "OpenCode"
REM   highlights false     -> no update dialog on start
REM   mini.splash hide     -> no entry/exit splash banner
REM The provider in the config above is what the TUI prints next to the model
REM (Sajilo, not OpenCode).
REM "sajilo rebrand --restore" drops the stock marker: this instance goes back
REM to the stock opencode identity.
set "OPENCODE_CLI_CONFIG_CONTENT="
if not exist "%STATE%\stock-identity" (
  set "OPENCODE_CLI_CONFIG_CONTENT={"terminal":{"title":false},"highlights":false,"mini":{"splash":"hide"}}"
)

REM --- where to run ------------------------------------------------------------
REM Sajilo opens in the directory you are standing in, or the one you name -
REM exactly like opencode does. The isolation comes from the HOME (own DB,
REM own sessions, own config), never from the project directory.
set "TARGET=%CD%"
if not "%~1"=="" if exist "%~1\" (
  set "TARGET=%~f1"
  shift
)

REM --- the provider, and where it is merged in -------------------------------
REM The config file belongs to the user: it is where "opencode mcp add",
REM permissions, agents and commands live. So the launcher does NOT write it -
REM the relay plugin MERGES the sajilo provider into it at startup (see
REM mergeRuntimeConfig in sajilo-relay.ts), which keeps every other key intact.
REM
REM "direct" talks to the gateway without the relay; "sajilo rebrand
REM --restore" keeps the stock opencode name.
set "SAJILO_RELAY_PROVIDER=sajilo"
if /i "%~1"=="direct" set "SAJILO_RELAY_PROVIDER=none"
if exist "%STATE%\stock-identity" set "SAJILO_RELAY_PROVIDER=opencode"

if /i "%~1"=="status" (
  echo root       : %ROOT%
  echo relay      : http://127.0.0.1:%RELAY_PORT%/relay-health
  echo db         : %HOME_DIR%\.local\share\opencode\opencode.db
  echo project    : %TARGET%
  echo runtime    : %OPENCODE_BIN%
  if "%MODEL_ID%"=="" (echo model       : auto ^(the relay resets the limit, it never rotates models^)) else (echo model       : %MODEL_ID%)
  echo tunnel     : none on Windows ^(native egress^)
  echo base url   : http://127.0.0.1:%RELAY_PORT%/v1 - or /openai/v1
  exit /b 0
)

if /i "%~1"=="rebrand" goto :do_rebrand
if /i "%~1"=="mint" goto :do_mint
if /i "%~1"=="doctor" goto :do_doctor
if /i "%~1"=="relay" goto :do_relay
if /i "%~1"=="model" goto :do_model
if /i "%~1"=="run" goto :do_run
if /i "%~1"=="shell" goto :do_shell
if /i "%~1"=="serve" goto :do_serve
if /i "%~1"=="direct" goto :do_direct
goto :do_tui

REM --- mint: a fresh session/project pair -> a fresh quota bucket ------------
:do_mint
curl -s -m 180 -X POST "http://127.0.0.1:%RELAY_PORT%/relay-mint?force=1" -H "content-type: application/json" -d "{}"
echo.
echo A fresh pair means a fresh bucket: every free model's pool for THIS
echo identity starts over, so a drained model becomes usable again.
exit /b 0

REM --- doctor: is the harness and the relay healthy? -------------------------
:do_doctor
where bun >nul 2>&1
if errorlevel 1 goto :doctor_nobun
bun run "%ROOT%\bin\sajilo-doctor.ts"
exit /b %errorlevel%
:doctor_nobun
echo sajilo doctor needs bun ^(https://bun.sh^)
exit /b 1

REM --- relay: the provider on its own, for other agents ---------------------
:do_relay
REM --lean: a third-party agent's own prompt and tools only - no harness
REM footprint. The free allowance is weight-based, so a lean relay fits
REM requests a full one does not.
set "LEAN="
for %%A in (%*) do (
  if /i "%%~A"=="--lean" set "LEAN=1"
)
if "%LEAN%"=="1" (
  set "SAJILO_RELAY_TOOLS=caller"
  set "SAJILO_RELAY_HARNESS=caller"
)
where bun >nul 2>&1
if errorlevel 1 goto :relay_nobun
bun run "%ROOT%\bin\sajilo-relay.ts"
exit /b %errorlevel%
:relay_nobun
echo sajilo relay needs bun ^(https://bun.sh^) - install it, or keep a sajilo
echo session open: the relay runs inside every sajilo instance.
exit /b 1

REM --- serve: the runtime headless, so the relay stays up for other agents --
:do_serve
cd /d "%TARGET%"
"%OPENCODE_BIN%" serve --stdio
exit /b %errorlevel%

REM --- shell: a shell with the sajilo environment -----------------------------
:do_shell
cd /d "%TARGET%"
cmd /k
exit /b 0

REM --- direct: talk to the gateway without the relay --------------------------
:do_direct
cd /d "%TARGET%"
set "ARGS="
:do_direct_next
if "%~1"=="" goto :do_direct_exec
set "ARGS=%ARGS% "%~1""
shift
goto :do_direct_next
:do_direct_exec
"%OPENCODE_BIN%" --standalone%ARGS%
exit /b %errorlevel%

REM --- the TUI, in the directory you are standing in ---------------------------
:do_tui
cd /d "%TARGET%"
set "ARGS="
:do_tui_next
if "%~1"=="" goto :do_tui_exec
set "ARGS=%ARGS% "%~1""
shift
goto :do_tui_next
:do_tui_exec
"%OPENCODE_BIN%" --standalone%ARGS%
exit /b %errorlevel%

REM --- rebrand: the identity of this instance --------------------------------
:do_rebrand
shift
if not exist "%SELF_DIR%sajilo-rebrand.ps1" goto :rebrand_missing
REM "%*" is not affected by SHIFT, so the arguments are passed one by one
REM (these lines are parsed after the shift, so %1 is the first real option).
powershell -NoProfile -ExecutionPolicy Bypass -File "%SELF_DIR%sajilo-rebrand.ps1" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%
:rebrand_missing
echo rebrand: bin\sajilo-rebrand.ps1 is missing - reinstall sajilo
exit /b 1

REM --- model: one pin file, honoured by the runtime AND the relay -----------
:do_model
shift
if "%~1"=="" goto :model_show
if /i "%~1"=="--auto" goto :model_clear
if not exist "%STATE%" mkdir "%STATE%"
>"%MODEL_FILE%" echo %~1
echo model pinned  : %~1
echo                 (the relay uses it on the next request; the free pool
echo                  still covers it if that model is drained)
goto :model_end
:model_show
if "%MODEL_ID%"=="" (
  echo model        : auto ^(the relay resets the limit, it never rotates models^)
) else (
  echo model        : %MODEL_ID%
)
goto :model_end
:model_clear
if exist "%MODEL_FILE%" del /q "%MODEL_FILE%"
echo model        : auto ^(the relay resets the limit, it never rotates models^)
:model_end
exit /b 0

REM --- run: rebuild the argument list by hand --------------------------------
REM "%*" is NOT affected by SHIFT in a batch file, so passing it after a
REM SHIFT would smuggle the literal word "run" into the prompt. Read %1..%9
REM one at a time, each on its own line so every SHIFT is seen immediately.
REM Each argument is re-quoted so spacing and inner quotes survive intact.
:do_run
shift
cd /d "%TARGET%"
set "ARGS="
:do_run_next
if "%~1"=="" goto :do_run_exec
set "ARGS=%ARGS% "%~1""
shift
goto :do_run_next
:do_run_exec
"%OPENCODE_BIN%" run --standalone%ARGS%
exit /b %errorlevel%
