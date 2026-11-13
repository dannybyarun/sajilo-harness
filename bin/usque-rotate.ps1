# usque-rotate.ps1 - rotate the usque WARP registration, without
# administrator rights.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File usque-rotate.ps1
#
# Why usque and not the Cloudflare WARP app: the app is a Windows SERVICE, so
# registering it again needs Administrator rights - and the user should never
# have to click through that. usque is a user-space MASQUE client: one
# binary, one config file, one HTTP proxy. Registering it writes a file, and
# rotating it is registering a NEW anonymous account.
#
# The rotation is the point: the free allowance is keyed on the exit IP, so a
# new WARP account is (usually) a new exit IP is a new quota bucket. Note
# that Cloudflare sometimes hands the same address to two registrations in
# the same colo, so the rotator retries until the address actually changes -
# and the registration id is reported as the certain signal.
#
# Steps, per attempt:
#   1. stop the proxy that serves our port,
#   2. move the registration aside (usque asks before overwriting one, and
#      the old file is the way back if the registration fails),
#   3. register a fresh anonymous WARP account,
#   4. start the proxy again and read the exit IP.
#
# The proxy env is cleared for the usque child: usque must reach Cloudflare
# itself, and an inherited proxy would send it through the tunnel it is
# supposed to replace.
param(
  [string]$Root = "",
  [string]$Config = "",
  [string]$Port = "",
  [string]$Bin = "",
  [string]$State = "",
  [int]$Attempts = 3
)

$ErrorActionPreference = "Continue"

if (-not $Root) { $Root = $env:SAJILO_ROOT }
if (-not $Root) { $Root = Join-Path $env:USERPROFILE ".sajilo" }
if (-not $Config) { $Config = Join-Path $Root "tunnel\config.json" }
if (-not $Port) { $Port = $env:SAJILO_TUNNEL_PORT }
if (-not $Port) { $Port = "40003" }
if (-not $Bin) { $Bin = Join-Path $Root "bin\usque.exe" }
if (-not $State) { $State = Join-Path $Root "state" }

function Say([string]$m) { Write-Host "usque-rotate: $m" }

if (-not (Test-Path $Bin)) {
  Say "no usque at $Bin - nothing to rotate"
  exit 0
}

function Clear-ProxyEnv {
  $env:HTTPS_PROXY = ""; $env:HTTP_PROXY = ""; $env:ALL_PROXY = ""
  $env:https_proxy = ""; $env:http_proxy = ""; $env:all_proxy = ""
}

function Stop-Usque {
  # The pid file first (the launcher writes it), then anyone still holding
  # the port - a leftover from a crashed run.
  $pidFile = Join-Path $State "usque.pid"
  if (Test-Path $pidFile) {
    $p = (Get-Content $pidFile -Raw).Trim()
    if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
    if ($c.OwningProcess -and $c.OwningProcess -ne $PID) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-Usque {
  Clear-ProxyEnv
  $log = Join-Path $State "usque.log"
  try {
    $proc = Start-Process -FilePath $Bin -ArgumentList @(
      "-c", $Config, "http-proxy", "-b", "127.0.0.1", "-p", $Port
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  } catch {
    Say "could not start usque: $($_.Exception.Message)"
    return $false
  }
  try {
    $proc.Id | Set-Content (Join-Path $State "usque.pid") -Encoding ascii
  } catch { /* diagnostics only */ }
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { return $true }
  }
  return $false
}

function Exit-Ip {
  # Cloudflare's trace endpoint: it reports the address family Cloudflare
  # itself sees for the inference endpoint.
  try {
    $out = & curl.exe -s --max-time 10 -x "http://127.0.0.1:$Port" https://www.cloudflare.com/cdn-cgi/trace 2>$null
    $ip = ($out | Select-String "^ip=" | Select-Object -First 1) -replace "^ip=", ""
    return $ip.Trim()
  } catch {
    return ""
  }
}

function Registration-Id {
  try {
    $j = Get-Content $Config -Raw | ConvertFrom-Json
    if ($j.id) { return [string]$j.id }
    if ($j.account.id) { return [string]$j.account.id }
  } catch { /* diagnostics only */ }
  return ""
}

$beforeIp = Exit-Ip
$beforeId = Registration-Id
if ($beforeIp) { Say "current exit IP: $beforeIp" }

for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
  Say "rotating (attempt $attempt/$Attempts): stopping usque on port $Port"
  Stop-Usque

  # Move the registration aside: usque asks before overwriting one, and the
  # old file is the way back if the registration fails.
  $backup = "$Config.rotate.bak"
  $hadConfig = Test-Path $Config
  if ($hadConfig) {
    Copy-Item $Config $backup -Force
    Remove-Item $Config -Force -ErrorAction SilentlyContinue
  }

  Say "rotating: registering a fresh WARP account (a new exit IP)"
  Clear-ProxyEnv
  $name = "sajilo-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $out = & $Bin register -a -c $Config -n $name 2>&1
  $rc = $LASTEXITCODE
  $registered = Test-Path $Config

  if (-not $registered) {
    Say "the registration failed (rc=$rc) - putting the previous one back"
    if ($hadConfig -and (Test-Path $backup)) {
      Copy-Item $backup $Config -Force
    }
  } else {
    Remove-Item $backup -Force -ErrorAction SilentlyContinue
  }

  Say "rotating: starting usque again"
  if (-not (Start-Usque)) {
    Say "usque did not come up - see $State\usque.log"
    exit 1
  }
  Start-Sleep -Seconds 2

  $afterIp = Exit-Ip
  $afterId = Registration-Id
  if ($beforeIp -and $afterIp -and $afterIp -eq $beforeIp) {
    Say "the exit IP is still $afterIp (Cloudflare handed the same address to the new account)"
    continue
  }
  if ($afterIp) { Say "new exit IP: $afterIp" }
  if ($afterId -and $afterId -ne $beforeId) { Say "new registration id: $afterId" }
  Say "rotating: usque is up on 127.0.0.1:$Port with a new identity"
  exit 0
}

Say "rotating: the exit IP did not change after $Attempts attempt(s) - the registration is new anyway"
exit 0
