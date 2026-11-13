# sajilo - one-click installer (Windows).
#
#   Double-click install.cmd          <- the one-click path
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# Nothing has to be configured by hand. This script:
#   1. creates the instance layout (own HOME, DB, sessions, project, relay),
#   2. installs the relay plugin (locally, or downloads it from the repo),
#   3. installs the launcher and the tunnel helpers,
#   4. finds your opencode - or downloads the standalone binary if you have
#      none - and pins the exact path so sajilo never depends on PATH,
#   5. puts the launcher on your user PATH,
#   6. drops a desktop shortcut.
#
# No administrator rights, no registry policy changes, nothing to edit.
#
# KEEP THIS FILE ASCII-ONLY. Windows PowerShell 5.1 reads a BOM-less file as
# cp1252, where the third byte of a UTF-8 em-dash (0x94) becomes a RIGHT
# DOUBLE QUOTATION MARK - a valid PowerShell string terminator. One em-dash
# inside a quoted string then closes the string early and silently swallows
# the rest of the script (the launcher copy never runs, with no error).
$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Here) { $Here = "" }
$RepoUrl = "https://raw.githubusercontent.com/dannybyarun/sajilo-harness/main"

if ($env:SAJILO_ROOT) {
  $Root = $env:SAJILO_ROOT
} else {
  $Root = Join-Path $env:USERPROFILE ".sajilo"
}

$HomeDir   = Join-Path $Root "home"
$PluginDir = Join-Path $HomeDir ".config\opencode\plugin"
$StateDir  = Join-Path $Root "state"
$BinDir    = Join-Path $Root "bin"
$WorkDir   = Join-Path $Root "work"
$MintDir   = Join-Path $Root "mint"

function Say([string]$m) { Write-Host "install: $m" }
function Note([string]$m) { Write-Host "  $m" }

# ---------------------------------------------------------------- layout
foreach ($d in @((Join-Path $PluginDir "resources"), $StateDir, $WorkDir, $MintDir, $BinDir, (Join-Path $Root "tunnel"))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Say "root -> $Root"

# ---------------------------------------------------------------- plugin
# Three sources, in order: the files next to this script, the repository, and
# the published release bundle. The release bundle is the fallback because a
# branch URL on the raw CDN can serve a stale copy for minutes after a push,
# and a fresh user must never get a broken install.
$ReleaseUrl = "https://github.com/dannybyarun/sajilo-harness/releases/latest/download/sajilo-bootstrap.zip"
$BundleDir = ""

function Get-ReleaseBundle {
  $tmp = Join-Path $env:TEMP "sajilo-bundle"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "bundle.zip"
  Say "falling back to the release bundle -> $ReleaseUrl"
  try {
    & curl.exe -fsSL -o $zip $ReleaseUrl
    if ($LASTEXITCODE -ne 0) { throw "download failed" }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
  } catch {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    return $null
  }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  return $tmp
}

$localPlugin = if ($Here) { Join-Path $Here "plugin\sajilo-relay.ts" } else { "" }
if ($localPlugin -and (Test-Path $localPlugin)) {
  Copy-Item $localPlugin (Join-Path $PluginDir "sajilo-relay.ts") -Force
  # The harness spec (prompt + tools) is the USER'S. Never overwrite it: the
  # gateway checks the prompt's structure, so a clobbered spec can silently
  # break the harness (every request 429s). A new spec is only installed when
  # the instance does not have one yet.
  foreach ($r in @("agent-prompt.txt", "agent-tools.json", "title-prompt.txt", "sajilo-overlay.md")) {
    $src = Join-Path $Here "plugin\resources\$r"
    $dst = Join-Path $PluginDir "resources\$r"
    if (-not (Test-Path $src)) { continue }
    if (Test-Path $dst) {
      if ((Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash) {
        Copy-Item $dst "$dst.bak" -Force
        Say "kept your harness spec ($r) - the new one is at $dst.bak"
      }
      continue
    }
    Copy-Item $src $dst -Force
  }
  Say "relay plugin installed -> $PluginDir"
} else {
  Say "relay plugin not found next to the installer - downloading it"
  $got = $false
  try {
    Invoke-WebRequest -Uri "$RepoUrl/plugin/sajilo-relay.ts" -OutFile (Join-Path $PluginDir "sajilo-relay.ts") -UseBasicParsing
    foreach ($r in @("agent-prompt.txt", "agent-tools.json", "title-prompt.txt")) {
      Invoke-WebRequest -Uri "$RepoUrl/plugin/resources/$r" -OutFile (Join-Path $PluginDir "resources\$r") -UseBasicParsing
    }
    $got = $true
  } catch {
    $got = $false
  }
  if ($got) {
    Say "relay plugin downloaded -> $PluginDir"
  } else {
    $BundleDir = Get-ReleaseBundle
    if (-not $BundleDir) { throw "could not download the relay plugin" }
    Copy-Item (Join-Path $BundleDir "plugin\sajilo-relay.ts") (Join-Path $PluginDir "sajilo-relay.ts") -Force
    Copy-Item (Join-Path $BundleDir "plugin\resources\*") (Join-Path $PluginDir "resources") -Force
    Say "relay plugin installed from the release bundle -> $PluginDir"
  }
}

# ---------------------------------------------------------------- launcher
$launcherSrc = if ($Here) { Join-Path $Here "sajilo.cmd" } else { "" }
if ($launcherSrc -and (Test-Path $launcherSrc)) {
  Copy-Item $launcherSrc (Join-Path $BinDir "sajilo.cmd") -Force
} else {
  $got = $false
  try {
    Invoke-WebRequest -Uri "$RepoUrl/sajilo.cmd" -OutFile (Join-Path $BinDir "sajilo.cmd") -UseBasicParsing
    $got = $true
  } catch {
    $got = $false
  }
  if (-not $got) {
    if (-not $BundleDir) { $BundleDir = Get-ReleaseBundle }
    if (-not $BundleDir) { throw "could not download the launcher" }
    Copy-Item (Join-Path $BundleDir "sajilo.cmd") (Join-Path $BinDir "sajilo.cmd") -Force
  }
}
if ($Here) {
  foreach ($f in @("warp-rotate.sh", "tunnel-watchdog.sh", "usque-rotate.ps1", "usque-rotate.cmd", "sajilo-rebrand.sh", "sajilo-rebrand.ps1", "sajilo-relay.ts", "sajilo-doctor.ts")) {
    $p = Join-Path $Here "bin\$f"
    if (Test-Path $p) { Copy-Item $p (Join-Path $BinDir $f) -Force }
  }
}
Say "launcher installed -> $BinDir\sajilo.cmd"

# ---------------------------------------------------------------- tunnel
# The rotatable tunnel is what makes a NEW exit IP - and a new exit IP is a
# new quota bucket.
#
# There are two ways to get one, and the choice matters:
#
#   * Cloudflare WARP (the app) - a Windows SERVICE. Installing and
#     re-registering it needs Administrator rights, so it means a UAC prompt
#     and, on a locked-down machine, it simply is not an option.
#   * usque - a user-space WARP MASQUE client: one binary, one config file,
#     one HTTP proxy. Registering it writes a file. Rotating it registers a
#     new anonymous account. NO administrator rights, NO service, NO UAC.
#
# So usque is what the installer brings in. The WARP app is still used when
# it is already there (its proxy is a fine tunnel), but nothing is installed
# that would need a prompt.
#
# The step is best effort: the relay works without a tunnel (it resets the
# identity instead), so a failure here NEVER fails the install. Set
# SAJILO_SKIP_TUNNEL=1 to skip it.

$UsqueVersion = "v4.2.1"
$UsqueBase = "https://github.com/Diniboy1123/usque/releases/download/$UsqueVersion"
$UsquePort = if ($env:SAJILO_TUNNEL_PORT) { $env:SAJILO_TUNNEL_PORT } else { "40003" }
$UsqueBin = Join-Path $BinDir "usque.exe"
$UsqueConfig = Join-Path $Root "tunnel\config.json"
$UsqueState = Join-Path $StateDir "usque.pid"

function Test-TcpPort([int]$Port, [int]$TimeoutMs = 800) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs) -and $c.Connected
    $c.Close()
    return $ok
  } catch {
    return $false
  }
}

function Install-Usque {
  # The asset is named usque_<version>_<os>_<arch>.zip, and the release
  # ships a checksums.txt - the download is verified, not trusted.
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $asset = "usque_$($UsqueVersion.TrimStart('v'))_windows_$arch.zip"
  $tmp = Join-Path $env:TEMP "sajilo-usque"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    & curl.exe -fsSL --max-time 180 -o (Join-Path $tmp $asset) "$UsqueBase/$asset"
    if ($LASTEXITCODE -ne 0) { throw "download failed: $UsqueBase/$asset" }
    & curl.exe -fsSL --max-time 60 -o (Join-Path $tmp "checksums.txt") "$UsqueBase/checksums.txt"
    if ($LASTEXITCODE -ne 0) { throw "could not download checksums.txt" }
    $line = (Get-Content (Join-Path $tmp "checksums.txt") | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1)
    if (-not $line) { throw "no checksum for $asset" }
    $expected = ($line -split "\s+")[0].ToLower()
    $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "checksum mismatch for $asset" }
    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp "x") -Force
    $exe = Get-ChildItem (Join-Path $tmp "x") -Filter "usque.exe" -Recurse | Select-Object -First 1
    if (-not $exe) { throw "the archive has no usque.exe" }
    Copy-Item $exe.FullName $UsqueBin -Force
  } catch {
    Note "tunnel: could not install usque ($($_.Exception.Message))"
    return $false
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  return $true
}

function Register-Usque {
  # usque must reach Cloudflare itself: an inherited proxy would send it
  # through the tunnel it is meant to replace.
  $env:HTTPS_PROXY = ""; $env:HTTP_PROXY = ""; $env:https_proxy = ""; $env:http_proxy = ""
  $name = "sajilo-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  try {
    # usque writes its progress to STDERR (including a harmless "Config file
    # not found" on a first run), and this script runs with
    # ErrorActionPreference=Stop - so stderr would abort the install. The
    # preference is relaxed around the call and the CONFIG FILE is what
    # decides whether the registration worked.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $out = & $UsqueBin register -a -c $UsqueConfig -n $name 2>&1
      $rc = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $oldPref
    }
    if (-not (Test-Path $UsqueConfig)) { throw "register failed (rc=$rc): $out" }
  } catch {
    Note "tunnel: usque could not register ($($_.Exception.Message))"
    return $false
  }
  return $true
}

function Start-Usque {
  $env:HTTPS_PROXY = ""; $env:HTTP_PROXY = ""; $env:https_proxy = ""; $env:http_proxy = ""
  $log = Join-Path $StateDir "usque.log"
  $proc = Start-Process -FilePath $UsqueBin -ArgumentList @(
    "-c", $UsqueConfig, "http-proxy", "-b", "127.0.0.1", "-p", $UsquePort
  ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $proc.Id | Set-Content $UsqueState -Encoding ascii
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-TcpPort ([int]$UsquePort)) { return $true }
  }
  return $false
}

function Get-TunnelState {
  # usque: the instance's own rotatable tunnel (no admin).
  if (Test-Path $UsqueBin) {
    return [pscustomobject]@{ Kind = "usque"; Rotatable = $true; Proxy = "http://127.0.0.1:$UsquePort"; Up = (Test-TcpPort ([int]$UsquePort)) }
  }
  # the WARP stack: its proxy is a fine tunnel, and its rotator is there too.
  $stackBin = Join-Path $env:LOCALAPPDATA "opencode-warp\bin"
  if ((Test-Path (Join-Path $stackBin "warp-rotate.cmd")) -and (Test-TcpPort 40000)) {
    return [pscustomobject]@{ Kind = "warp-stack"; Rotatable = $true; Proxy = "http://127.0.0.1:40000"; Up = $true }
  }
  return [pscustomobject]@{ Kind = "none"; Rotatable = $false; Proxy = ""; Up = $false }
}

if ($env:SAJILO_SKIP_TUNNEL -eq "1") {
  Say "tunnel skipped (SAJILO_SKIP_TUNNEL=1) - the relay will use the machine's own egress"
  "skipped by SAJILO_SKIP_TUNNEL=1" | Set-Content (Join-Path $StateDir "tunnel.txt")
} else {
  # The Cloudflare WARP APP is the primary: where it is installed and
  # running, it is the tunnel - its rotation is fast (measured: 6.8 s) and it
  # was working before usque existed.
  $stackBin = Join-Path $env:LOCALAPPDATA "opencode-warp\bin"
  $warpApp = (Test-Path (Join-Path $stackBin "warp-rotate.cmd")) -and (Test-TcpPort 40000)
  if ($warpApp) {
    Say "tunnel: the Cloudflare WARP app is running (127.0.0.1:40000) - a rotation is a new exit IP"
    "warp-app: http://127.0.0.1:40000" | Set-Content (Join-Path $StateDir "tunnel.txt")
  } else {
    # No WARP app: bring usque, the user-space WARP client. Installing AND
    # rotating it needs no administrator rights, no service and no UAC - it
    # is the fallback that makes the tunnel work everywhere.
    $haveUsque = Test-Path $UsqueBin
    if ($haveUsque -and -not (Test-TcpPort ([int]$UsquePort))) {
      Note "tunnel: usque is installed but not running - starting it"
      if (-not (Start-Usque)) { $haveUsque = $false }
    }
    if (-not $haveUsque) {
      Note "tunnel: installing usque (a user-space WARP client - no administrator rights, no UAC)"
      if ((Install-Usque) -and (Register-Usque) -and (Start-Usque)) {
        $haveUsque = $true
      }
    }
    if ($haveUsque) {
      Say "tunnel: usque on http://127.0.0.1:$UsquePort - a rotation is a new exit IP, no admin needed"
      "usque: http://127.0.0.1:$UsquePort" | Set-Content (Join-Path $StateDir "tunnel.txt")
    } else {
      Say "tunnel: not available - the relay resets the identity instead (one bucket, not two)"
      "unavailable" | Set-Content (Join-Path $StateDir "tunnel.txt")
    }
  }
}

# ---------------------------------------------------------------- opencode
# cmd.exe can run a .cmd or an .exe, but NOT a .ps1 shim, so only accept
# something cmd.exe can execute directly.
function Find-Opencode {
  if ($env:SAJILO_FORCE_DOWNLOAD -eq "1") { return $null }
  if ($env:SAJILO_BIN -and (Test-Path $env:SAJILO_BIN)) {
    return (Resolve-Path $env:SAJILO_BIN).Path
  }
  if ($env:OPENCODE_BIN -and (Test-Path $env:OPENCODE_BIN)) {
    return (Resolve-Path $env:OPENCODE_BIN).Path
  }
  $app = Get-Command opencode -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($app) { return $app.Path }
  $candidates = @(
    (Join-Path $env:USERPROFILE ".opencode\bin\opencode.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\opencode.exe")
  )
  try {
    $npmPrefix = (& npm prefix -g 2>$null | Select-Object -First 1)
    if ($npmPrefix) { $candidates += (Join-Path $npmPrefix "opencode.cmd") }
  } catch { }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Install-Opencode {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $url = "https://opencode.ai/update/api/latest/cli/opencode/opencode-windows-$arch.zip"
  $zip = Join-Path $env:TEMP "opencode-windows-$arch.zip"
  Say "no opencode on this machine - downloading the standalone binary (about 120 MB)"
  & curl.exe -fsSL -o $zip $url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $BinDir)
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  return (Join-Path $BinDir "opencode.exe")
}

$bin = Find-Opencode
if ($bin) {
  Say "opencode found: $bin"
} elseif ($env:SAJILO_NO_DOWNLOAD -eq "1") {
  Say "opencode NOT found and SAJILO_NO_DOWNLOAD=1 - install it from https://opencode.ai"
  exit 1
} else {
  $bin = Install-Opencode
  Say "opencode installed -> $bin"
}

# Pin the exact binary so sajilo always starts the same one, even when it is
# launched from a shell whose PATH knows nothing about opencode.
Set-Content -Path (Join-Path $StateDir "sajilo-bin.txt") -Value $bin -Encoding ascii
Say "runtime binary pinned -> $StateDir\sajilo-bin.txt"

# ---------------------------------------------------------------- PATH
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $userPath) { $userPath = "" }
$parts = @($userPath -split ";" | Where-Object { $_ -and $_.Trim() })
if ($parts -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable("Path", (($parts + $BinDir) -join ";"), "User")
  Say "added to your PATH -> $BinDir"
} else {
  Say "already on your PATH -> $BinDir"
}

# ---------------------------------------------------------------- shortcut
try {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $desktop "sajilo.lnk"))
  $lnk.TargetPath = Join-Path $BinDir "sajilo.cmd"
  $lnk.WorkingDirectory = $WorkDir
  $lnk.Description = "sajilo - a coding agent harness in its own sandbox"
  $lnk.WindowStyle = 1
  $lnk.Save()
  Say "desktop shortcut created -> $desktop\sajilo.lnk"
} catch {
  Say "desktop shortcut skipped (not fatal)"
}

# ---------------------------------------------------------------- done
Write-Host ""
Say "done"
Write-Host ""
Write-Host "  sajilo             # interactive"
Write-Host "  sajilo run `"hi`"   # headless"
Write-Host "  sajilo status      # what is running"
Write-Host ""
Write-Host "  Open a NEW terminal (or use the desktop shortcut) so the PATH"
Write-Host "  change takes effect. sajilo has its own HOME, database, sessions,"
Write-Host "  project, relay (43915), pins and logs - it cannot affect any"
Write-Host "  opencode you are already running."
Write-Host ""
