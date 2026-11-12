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
foreach ($d in @((Join-Path $PluginDir "resources"), $StateDir, $WorkDir, $MintDir, $BinDir)) {
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
  Copy-Item (Join-Path $Here "plugin\resources\*") (Join-Path $PluginDir "resources") -Force
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
  foreach ($f in @("warp-rotate.sh", "tunnel-watchdog.sh", "sajilo-rebrand.sh", "sajilo-rebrand.ps1", "sajilo-relay.ts")) {
    $p = Join-Path $Here "bin\$f"
    if (Test-Path $p) { Copy-Item $p (Join-Path $BinDir $f) -Force }
  }
}
Say "launcher installed -> $BinDir\sajilo.cmd"

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
Write-Host "  project, relay (43914), pins and logs - it cannot affect any"
Write-Host "  opencode you are already running."
Write-Host ""
