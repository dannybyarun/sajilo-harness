# tunnels.ps1 - the instance's WARP tunnel farm: N tunnels, no collisions.
#
#   tunnels.ps1 ensure -Root <root> [-Slots n] [-BasePort p] [-Usque <exe>]
#   tunnels.ps1 rotate -Root <root> -Slot <s> [-Attempts n]
#   tunnels.ps1 stop   -Root <root> [-Slot <s>]
#   tunnels.ps1 status -Root <root>
#
# Why a farm and not one tunnel: every WARP registration is its own quota
# bucket, and a bucket is keyed on the EXIT IP. Running N tunnels at once means
# N buckets - but only if they do not COLLIDE:
#
#   * one registration per tunnel. A shared config file is a shared account,
#     which is a shared exit IP, which is ONE bucket - and the rotator would
#     swap the identity out from under the running process.
#   * one port per tunnel. A shared port means the relay rides somebody else's
#     tunnel (the launcher sees "something is listening" and adopts it), and
#     one drained bucket then takes both instances down with it.
#   * one pid file, one log pair and one rotator per tunnel. A shared pid file
#     means rotating one tunnel kills the other.
#   * one DISTINCT exit IP per tunnel. Cloudflare sometimes hands the same
#     address to two registrations in the same colo, so that is measured, and
#     a colliding tunnel is re-registered until it has an address of its own.
#
# The ports are CLAIMED, not guessed: a claim file per port says which
# instance owns it, and a claim whose owner is dead can be taken over. The
# claims live in one place for the whole machine (%LOCALAPPDATA%\sajilo), so
# two sajilo instances never pick the same port.
param(
  [Parameter(Position = 0)][string]$Action = "ensure",
  [string]$Root = "",
  [int]$Slots = 1,
  [int]$BasePort = 0,
  [string]$Usque = "",
  [int]$Slot = -1,
  [int]$Attempts = 3,
  # An explicit port for the acting slot: it wins over the slot's own port.
  [int]$Port = 0,
  # An explicit registration file for the acting slot.
  [string]$Config = "",
  # 1: every slot is an alt leg (the primary leg is the shared WARP app or a
  # proxy the operator set). 0: slot 0 IS the primary leg.
  [int]$SlotsAreAlt = 1,
  # How many slots are held in RESERVE: kept out of the ladder so their
  # buckets are never spent, and brought in the moment a working leg is
  # drained. The reserve is the LAST slot.
  [int]$Reserve = 0,
  [switch]$Quiet
)

$ErrorActionPreference = "Continue"

if (-not $Root) { $Root = $env:SAJILO_ROOT }
if (-not $Root) { $Root = Join-Path $env:USERPROFILE ".sajilo" }
$State = Join-Path $Root "state"
$Global = Join-Path $env:LOCALAPPDATA "sajilo"
$RegistryPath = Join-Path $Global "tunnels.json"
$ClaimDir = Join-Path $Global "claims"

if (-not $Usque) { $Usque = Join-Path $Root "bin\usque.exe" }
if (-not $BasePort) {
  if ($env:SAJILO_TUNNEL_PORT) { $BasePort = [int]$env:SAJILO_TUNNEL_PORT } else { $BasePort = 40005 }
}

function Say([string]$m) { if (-not $Quiet) { Write-Host "tunnels: $m" } }

# No BOM: a JSON file that starts with EF BB BF is not JSON to a strict
# parser, and the doctor (bun) is a strict parser.
function Write-TextNoBom([string]$path, [string]$text) {
  try {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
  } catch { }
}

# ---------------------------------------------------------------- paths

# Slot 0 keeps the historical paths (tunnel/config.json, state/usque.pid), so
# an existing install keeps working untouched. The extra slots get their own.
function Get-SlotPaths([int]$s) {
  $dir = if ($s -eq 0) { Join-Path $Root "tunnel" } else { Join-Path $Root "tunnel\slot-$s" }
  $pidName = if ($s -eq 0) { "usque.pid" } else { "usque-$s.pid" }
  $logName = if ($s -eq 0) { "usque.log" } else { "usque-$s.log" }
  return [pscustomobject]@{
    Slot = $s
    Dir = $dir
    Config = Join-Path $dir "config.json"
    Pid = Join-Path $State $pidName
    Log = Join-Path $State $logName
    LogErr = (Join-Path $State "$logName.err")
    Port = ($BasePort + $s)
  }
}

# ---------------------------------------------------------------- the network

function Clear-ProxyEnv {
  # usque must reach Cloudflare itself: an inherited proxy would send it
  # through the very tunnel it is supposed to replace.
  $env:HTTPS_PROXY = ""; $env:HTTP_PROXY = ""; $env:ALL_PROXY = ""
  $env:https_proxy = ""; $env:http_proxy = ""; $env:all_proxy = ""
}

function Get-ListenerPid([int]$port) {
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch { }
  return 0
}

function Get-CommandLine([int]$procId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.CommandLine }
  } catch { }
  return ""
}

# Is the thing listening on this port OUR tunnel for THIS config? Anything
# else is a foreign tenant: another instance's tunnel, or the ambient WARP
# app. Adopting it would put two instances in one bucket.
function Get-OwnTunnelPid([int]$port, [string]$config) {
  $procId = Get-ListenerPid $port
  if (-not $procId) { return 0 }
  $cmd = Get-CommandLine $procId
  if (-not $cmd) { return 0 }
  if ($config -and ($cmd.IndexOf($config, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
    return $procId
  }
  return 0
}

function Get-ExitIp([int]$port) {
  try {
    $out = & curl.exe -s --max-time 10 -x "http://127.0.0.1:$port" https://www.cloudflare.com/cdn-cgi/trace 2>$null
    $line = $out | Select-String "^ip=" | Select-Object -First 1
    if ($line) {
      $ip = ($line -replace "^ip=", "").Trim()
      if ($ip) { return $ip }
    }
  } catch { }
  return ""
}

function Get-RegistrationId([string]$config) {
  try {
    $j = Get-Content $config -Raw | ConvertFrom-Json
    if ($j.id) { return [string]$j.id }
    if ($j.account.id) { return [string]$j.account.id }
  } catch { }
  return ""
}

# ---------------------------------------------------------------- the claims

function Get-ClaimPath([int]$port) { Join-Path $ClaimDir "$port.json" }

function Get-LiveClaim([int]$port) {
  # A claim is only binding while its owner is alive. A dead owner leaves a
  # stale claim behind, and a stale claim can be taken over.
  $p = Get-ClaimPath $port
  if (-not (Test-Path $p)) { return $null }
  try { $j = Get-Content $p -Raw | ConvertFrom-Json } catch { return $null }
  $alive = $false
  if ($j.pid) { $alive = [bool](Get-Process -Id ([int]$j.pid) -ErrorAction SilentlyContinue) }
  if (-not $alive) { return $null }
  return $j
}

function Set-Claim([int]$port, $paths, [int]$procId) {
  try {
    New-Item -ItemType Directory -Force -Path $ClaimDir | Out-Null
    $obj = [pscustomobject]@{
      port = $port
      root = $Root
      slot = $paths.Slot
      pid = $procId
      config = $paths.Config
      updated = (Get-Date).ToUniversalTime().ToString("o")
    }
    $p = Get-ClaimPath $port
    $tmp = "$p.$PID.tmp"
    Set-Content -Path $tmp -Value ($obj | ConvertTo-Json -Compress) -Encoding ascii
    Move-Item -Path $tmp -Destination $p -Force
  } catch { }
}

function Clear-Claim([int]$port) {
  try { Remove-Item (Get-ClaimPath $port) -Force -ErrorAction SilentlyContinue } catch { }
}

# The next port this slot may take: the wanted one, or the first one after it
# that nothing else holds.
function Get-AvailablePort([int]$wanted, $paths) {
  for ($p = $wanted; $p -lt ($wanted + 32); $p++) {
    if (Get-OwnTunnelPid $p $paths.Config) { return $p }   # already ours
    if (Get-ListenerPid $p) {
      # Something is listening. Is it a live claim by another instance?
      $claim = Get-LiveClaim $p
      if ($claim -and ($claim.root -ne $Root)) { continue }  # theirs - skip
      # Not claimed by a live instance: it is a stray process. We can take the
      # port only if we can stop it - a foreign tunnel is left alone.
      continue
    }
    return $p
  }
  return $wanted
}

# ---------------------------------------------------------------- the registry

function Read-Registry {
  if (-not (Test-Path $RegistryPath)) { return @() }
  try {
    $j = Get-Content $RegistryPath -Raw | ConvertFrom-Json
    if ($j.tunnels) { return @($j.tunnels) }
  } catch { }
  return @()
}

function Write-Registry($entries) {
  try {
    New-Item -ItemType Directory -Force -Path $Global | Out-Null
    $obj = [pscustomobject]@{
      updated = (Get-Date).ToUniversalTime().ToString("o")
      tunnels = @($entries)
    }
    $tmp = "$RegistryPath.$PID.tmp"
    Write-TextNoBom $tmp ($obj | ConvertTo-Json -Depth 6)
    Move-Item -Path $tmp -Destination $RegistryPath -Force
  } catch { }
}

function Update-RegistryEntry($entry) {
  $entries = @()
  foreach ($t in (Read-Registry)) {
    if ([int]$t.port -ne [int]$entry.port) { $entries += $t }
  }
  $entries += $entry
  Write-Registry $entries
}

# Every tunnel that is alive on this machine, with its exit IP measured LIVE
# (a registry entry can be stale - the tunnel may have been rotated since).
function Get-LiveTunnels {
  $live = @()
  foreach ($t in (Read-Registry)) {
    $procId = [int]$t.pid
    if (-not $procId) { continue }
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { continue }
    $ip = Get-ExitIp ([int]$t.port)
    $live += [pscustomobject]@{
      port = [int]$t.port
      root = [string]$t.root
      slot = [int]$t.slot
      pid = $procId
      config = [string]$t.config
      exitIp = $ip
    }
  }
  return $live
}

# ---------------------------------------------------------------- the tunnels

function Register-Slot($paths) {
  New-Item -ItemType Directory -Force -Path $paths.Dir | Out-Null
  Clear-ProxyEnv
  $name = "sajilo-s$($paths.Slot)-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $out = & $Usque register -a -c $paths.Config -n $name 2>&1
  return (Test-Path $paths.Config)
}

function Stop-SlotProcess($paths) {
  # ONLY this slot's process. The old rotator killed whatever was listening on
  # the port, which - with more than one tunnel - killed a sibling's tunnel.
  $procId = Get-OwnTunnelPid $paths.Port $paths.Config
  if ($procId) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $paths.Pid) {
    $recorded = (Get-Content $paths.Pid -Raw).Trim()
    if ($recorded -and ($recorded -ne "$procId")) {
      $cmd = Get-CommandLine ([int]$recorded)
      if ($cmd -and ($cmd.IndexOf($paths.Config, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        Stop-Process -Id ([int]$recorded) -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-Item $paths.Pid -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Get-OwnTunnelPid $paths.Port $paths.Config)) { break }
    Start-Sleep -Milliseconds 200
  }
}

function Start-SlotProcess($paths) {
  Clear-ProxyEnv
  try {
    $proc = Start-Process -FilePath $Usque -ArgumentList @(
      "-c", $paths.Config, "http-proxy", "-b", "127.0.0.1", "-p", "$($paths.Port)"
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $paths.Log -RedirectStandardError $paths.LogErr
  } catch {
    Say "slot $($paths.Slot): could not start usque: $($_.Exception.Message)"
    return 0
  }
  try { $proc.Id | Set-Content $paths.Pid -Encoding ascii } catch { }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-ListenerPid $paths.Port) { return $proc.Id }
  }
  return 0
}

function Save-SlotState($paths, [int]$procId, [string]$ip) {
  $entry = [pscustomobject]@{
    port = $paths.Port
    root = $Root
    slot = $paths.Slot
    pid = $procId
    config = $paths.Config
    exitIp = $ip
    registrationId = (Get-RegistrationId $paths.Config)
    updated = (Get-Date).ToUniversalTime().ToString("o")
  }
  Update-RegistryEntry $entry
  try {
    $obj = [pscustomobject]@{
      root = $Root
      slotsAreAlt = $SlotsAreAlt
      reserve = $Reserve
      slots = @((Read-Registry | Where-Object { $_.root -eq $Root } | ForEach-Object {
        [pscustomobject]@{
          slot = $_.slot; port = $_.port; pid = $_.pid; config = $_.config
          exitIp = $_.exitIp; registrationId = $_.registrationId
        }
      }))
    }
    Write-TextNoBom (Join-Path $State "tunnels.json") ($obj | ConvertTo-Json -Depth 6)
  } catch { }
  return $entry
}

# The flag as it was saved, so a rotation does not reshuffle the legs.
function Get-SavedSlotsAreAlt {
  try {
    $p = Join-Path $State "tunnels.json"
    if (Test-Path $p) {
      $j = Get-Content $p -Raw | ConvertFrom-Json
      if ($null -ne $j.slotsAreAlt) { return [int]$j.slotsAreAlt }
    }
  } catch { }
  return $SlotsAreAlt
}

# The reserve count as it was saved: a rotation must not move the reserve.
function Get-SavedReserve {
  try {
    $p = Join-Path $State "tunnels.json"
    if (Test-Path $p) {
      $j = Get-Content $p -Raw | ConvertFrom-Json
      if ($null -ne $j.reserve) { return [int]$j.reserve }
    }
  } catch { }
  return $Reserve
}

# The environment the relay reads: the instance's own tunnels, in slot order.
#
# $SlotsAreAlt = 1: every slot is an alt leg (the primary leg is the shared
# WARP app, or a proxy the operator set). 0: slot 0 IS the primary leg (no WARP
# app on this machine), so the alt legs are slots 1..N-1.
function Write-TunnelEnv($entries, [int]$slotsAreAlt = 1, [int]$reserve = 0) {
  $own = @($entries | Where-Object { $_.root -eq $Root } | Sort-Object slot)
  $primary = $null
  $alts = @()
  $slots = @()
  # The RESERVE: the last slot(s) are held out of the ladder, so their
  # buckets are never spent. The relay brings them in the moment a working
  # leg is drained - that is the "always one extra in queue" part.
  $reserveSlots = @()
  if ($reserve -gt 0 -and $own.Count -gt 1) {
    $count = [Math]::Min($reserve, $own.Count - 1)
    $reserveSlots = @($own | Select-Object -Last $count)
    $own = @($own | Select-Object -First ($own.Count - $count))
  }
  foreach ($e in $own) {
    # Only a tunnel that is ALIVE is a leg. A dead one would be a leg the
    # relay climbs into and fails on - and a stopped slot is not a bucket.
    if ($e.pid -and -not (Get-Process -Id ([int]$e.pid) -ErrorAction SilentlyContinue)) { continue }
    $proxy = "http://127.0.0.1:$($e.port)"
    if ([int]$e.slot -eq 0 -and $slotsAreAlt -eq 0) {
      $primary = $proxy
      continue
    }
    $alts += $proxy
    $slots += "$($e.slot)"
  }
  $lines = @()
  if ($primary) { $lines += "SAJILO_TUNNEL_PRIMARY=$primary" }
  if ($alts.Count -gt 0) {
    $lines += "SAJILO_RELAY_PROXY_ALT=$($alts[0])"
    $lines += "SAJILO_RELAY_PROXY_ALT_SLOT=$($slots[0])"
  }
  if ($alts.Count -gt 1) {
    $lines += "SAJILO_RELAY_PROXY_ALTS=$(($alts[1..($alts.Count - 1)]) -join ',')"
    $lines += "SAJILO_RELAY_PROXY_ALT_SLOTS=$(($slots[1..($slots.Count - 1)]) -join ',')"
  }
  if ($reserveSlots.Count -gt 0) {
    $r = $reserveSlots[0]
    $lines += "SAJILO_RELAY_PROXY_RESERVE=http://127.0.0.1:$($r.port)"
    $lines += "SAJILO_RELAY_PROXY_RESERVE_SLOT=$($r.slot)"
  }
  try {
    # CRLF: cmd.exe's `for /f` reads this file into the launcher's env.
    Write-TextNoBom (Join-Path $State "tunnels.env") (($lines -join "`r`n") + "`r`n")
  } catch { }
}

# ---------------------------------------------------------------- collisions

# The exit IPs that are ALREADY taken on this machine: every live tunnel we
# know about, plus the ambient WARP app (its exit is shared with the rest of
# the machine, but sharing a bucket with it is still a collision).
function Get-TakenExitIps([int]$exceptPort) {
  $taken = @{}
  foreach ($t in (Get-LiveTunnels)) {
    if ($t.port -eq $exceptPort) { continue }
    if ($t.exitIp) { $taken[$t.exitIp] = $t.port }
  }
  $appPid = Get-ListenerPid 40000
  if ($appPid) {
    $ip = Get-ExitIp 40000
    if ($ip) { $taken[$ip] = 40000 }
  }
  return $taken
}

# Rotate this slot until it has an exit IP nobody else on this machine has.
function Resolve-ExitIpCollision($paths, [int]$attempts) {
  for ($i = 1; $i -le $attempts; $i++) {
    $ip = Get-ExitIp $paths.Port
    if (-not $ip) { return "" }
    $taken = Get-TakenExitIps $paths.Port
    if (-not $taken.ContainsKey($ip)) { return $ip }
    $other = $taken[$ip]
    Say "slot $($paths.Slot): the exit IP $ip is already in use by the tunnel on port $other - re-registering (attempt $i/$attempts)"
    Rotate-Slot $paths $attempts 2>$null | Out-Null
  }
  return (Get-ExitIp $paths.Port)
}

# ---------------------------------------------------------------- actions

function Ensure-Slot([int]$s) {
  $paths = Get-SlotPaths $s

  # Already ours? Adopt it and move on - this is the fast path, and it is the
  # one that keeps a restart from registering a second account.
  $own = Get-OwnTunnelPid $paths.Port $paths.Config
  if ($own) {
    # Adopt it: the pid file is written too, so the rotator and the doctor
    # see the process that is really serving this port.
    try { $own | Set-Content $paths.Pid -Encoding ascii } catch { }
    Set-Claim $paths.Port $paths $own
    $ip = Get-ExitIp $paths.Port
    $entry = Save-SlotState $paths $own $ip
    Say "slot ${s}: already up on 127.0.0.1:$($paths.Port) (pid $own, exit $ip)"
    return $entry
  }

  # Somebody else holds the port: another instance's tunnel, the WARP app, or
  # a stray process. A port is never shared - move to the next one.
  if (Get-ListenerPid $paths.Port) {
    $wanted = $paths.Port
    $paths.Port = Get-AvailablePort $paths.Port $paths
    if ($paths.Port -ne $wanted) {
      Say "slot ${s}: port $wanted is taken by another tunnel - moving to $($paths.Port)"
    }
  }

  if (-not (Test-Path $paths.Config)) {
    Say "slot ${s}: registering a WARP account of its own (a bucket of its own)"
    if (-not (Register-Slot $paths)) {
      Say "slot ${s}: the registration failed"
      return $null
    }
  }

  $procId = Start-SlotProcess $paths
  if (-not $procId) {
    Say "slot ${s}: usque did not come up on $($paths.Port)"
    return $null
  }
  Set-Claim $paths.Port $paths $procId
  $ip = Get-ExitIp $paths.Port
  $entry = Save-SlotState $paths $procId $ip
  Say "slot ${s}: up on 127.0.0.1:$($paths.Port) (pid $procId, exit $ip)"
  return $entry
}

function Rotate-Slot($paths, [int]$attempts) {
  # A new registration is a new exit IP is a new quota bucket. The old one is
  # kept aside: usque asks before overwriting a registration, and the old file
  # is the way back if the registration fails.
  $beforeIp = Get-ExitIp $paths.Port
  $beforeId = Get-RegistrationId $paths.Config
  for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    Stop-SlotProcess $paths
    $backup = "$($paths.Config).rotate.bak"
    $hadConfig = Test-Path $paths.Config
    if ($hadConfig) {
      Copy-Item $paths.Config $backup -Force
      Remove-Item $paths.Config -Force -ErrorAction SilentlyContinue
    }
    Clear-ProxyEnv
    $name = "sajilo-s$($paths.Slot)-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    & $Usque register -a -c $paths.Config -n $name 2>&1 | Out-Null
    if (-not (Test-Path $paths.Config)) {
      Say "slot $($paths.Slot): the registration failed - putting the previous one back"
      if ($hadConfig -and (Test-Path $backup)) { Copy-Item $backup $paths.Config -Force }
      return $false
    }
    Remove-Item $backup -Force -ErrorAction SilentlyContinue
    $procId = Start-SlotProcess $paths
    if (-not $procId) {
      Say "slot $($paths.Slot): usque did not come back after the rotation"
      return $false
    }
    Set-Claim $paths.Port $paths $procId
    Start-Sleep -Seconds 2
    $afterIp = Get-ExitIp $paths.Port
    $afterId = Get-RegistrationId $paths.Config
    if ($beforeIp -and $afterIp -and ($afterIp -eq $beforeIp)) {
      Say "slot $($paths.Slot): the exit IP is still $afterIp - trying again"
      continue
    }
    if ($afterIp) { Say "slot $($paths.Slot): new exit IP $afterIp" }
    if ($afterId -and ($afterId -ne $beforeId)) { Say "slot $($paths.Slot): new registration $afterId" }
    $null = Save-SlotState $paths $procId $afterIp
    return $true
  }
  Say "slot $($paths.Slot): the exit IP did not change after $attempts attempt(s)"
  return $false
}

function Action-Ensure {
  if (-not (Test-Path $Usque)) {
    Say "no usque at $Usque - no tunnels to manage"
    return
  }
  New-Item -ItemType Directory -Force -Path $State | Out-Null
  $entries = @()
  for ($s = 0; $s -lt $Slots; $s++) {
    $e = Ensure-Slot $s
    if ($e) { $entries += $e }
  }
  # The bucket check: two tunnels that landed on the same address are ONE
  # bucket, however many processes they are. The later slot is re-registered.
  for ($s = 0; $s -lt $entries.Count; $s++) {
    $paths = Get-SlotPaths $s
    $paths.Port = [int]$entries[$s].port
    $ip = Resolve-ExitIpCollision $paths 2
    if ($ip) {
      $entries[$s].exitIp = $ip
      Update-RegistryEntry $entries[$s]
    }
  }
  Write-TunnelEnv (Read-Registry) $SlotsAreAlt $Reserve
}

function Action-Rotate {
  if (-not (Test-Path $Usque)) { Say "no usque at $Usque - nothing to rotate"; return }
  $s = if ($Slot -ge 0) { $Slot } else { 0 }
  $paths = Get-SlotPaths $s
  # A slot whose port drifted keeps its real port.
  $entry = Read-Registry | Where-Object { $_.root -eq $Root -and [int]$_.slot -eq $s } | Select-Object -First 1
  if ($entry) { $paths.Port = [int]$entry.port }
  if ($Port -gt 0) { $paths.Port = $Port }
  if ($Config) { $paths.Config = $Config }
  if (-not (Test-Path $paths.Config)) {
    Say "slot ${s}: no registration yet - making one"
    if (Register-Slot $paths) {
      $procId = Start-SlotProcess $paths
      if ($procId) { Set-Claim $paths.Port $paths $procId; Save-SlotState $paths $procId (Get-ExitIp $paths.Port) }
    }
    return
  }
  $null = Rotate-Slot $paths $Attempts
  # A rotation is only useful if the bucket actually moved.
  $paths2 = Get-SlotPaths $s
  $paths2.Port = $paths.Port
  $ip = Resolve-ExitIpCollision $paths2 2
  if ($ip) {
    $entry = Save-SlotState $paths2 (Get-OwnTunnelPid $paths2.Port $paths2.Config) $ip
    Write-TunnelEnv (Read-Registry) (Get-SavedSlotsAreAlt) (Get-SavedReserve)
  }
}

function Action-Stop {
  $s = if ($Slot -ge 0) { $Slot } else { -1 }
  $targets = @()
  if ($s -ge 0) {
    $targets += $s
  } else {
    foreach ($e in (Read-Registry | Where-Object { $_.root -eq $Root })) { $targets += [int]$e.slot }
  }
  foreach ($t in ($targets | Select-Object -Unique)) {
    $paths = Get-SlotPaths $t
    $entry = Read-Registry | Where-Object { $_.root -eq $Root -and [int]$_.slot -eq $t } | Select-Object -First 1
    if ($entry) { $paths.Port = [int]$entry.port }
    Stop-SlotProcess $paths
    Clear-Claim $paths.Port
    Say "slot $t stopped"
  }
}

function Action-Status {
  foreach ($t in (Read-Registry)) {
    $alive = if ($t.pid) { [bool](Get-Process -Id ([int]$t.pid) -ErrorAction SilentlyContinue) } else { $false }
    $ip = if ($alive) { Get-ExitIp ([int]$t.port) } else { "" }
    Say ("slot {0}  port {1}  pid {2}  {3}  exit {4}  {5}" -f $t.slot, $t.port, $t.pid, $(if ($alive) { "up" } else { "DOWN" }), $ip, $t.root)
  }
}

switch ($Action.ToLower()) {
  "ensure" { Action-Ensure }
  "rotate" { Action-Rotate }
  "stop" { Action-Stop }
  "status" { Action-Status }
  default { Say "unknown action '$Action' (ensure|rotate|stop|status)" }
}
