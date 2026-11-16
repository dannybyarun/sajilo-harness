# usque-rotate.ps1 - rotate the usque WARP registration, without
# administrator rights.
#
#   usque-rotate.ps1 [--rotate-only] [--slot N] [-Root <root>] [-Port <p>]
#
# Why usque and not the Cloudflare WARP app: the app is a Windows SERVICE, so
# registering it again needs Administrator rights - and the user should never
# have to click through that. usque is a user-space MASQUE client: one
# binary, one config file, one HTTP proxy. Registering it writes a file, and
# rotating it is registering a NEW anonymous account.
#
# The rotation is the point: the free allowance is keyed on the exit IP, so a
# new WARP account is (usually) a new exit IP is a new quota bucket. Note
# that Cloudflare sometimes hands the same address to two registrations in the
# same colo, so the rotator retries until the address actually changes - and
# the registration id is reported as the certain signal.
#
# Steps, per attempt:
#   1. stop THIS SLOT's proxy (and only this slot's - with more than one
#      tunnel on the machine, killing "whatever listens on the port" kills a
#      sibling's tunnel and takes its bucket down with it),
#   2. move this slot's registration aside (usque asks before overwriting
#      one, and the old file is the way back if the registration fails),
#   3. register a fresh anonymous WARP account,
#   4. start this slot's proxy again, read the exit IP, and make sure that
#      address is not already in use by another tunnel on this machine - two
#      tunnels on one address are ONE bucket, however many processes they are.
#
# The proxy env is cleared for the usque child: usque must reach Cloudflare
# itself, and an inherited proxy would send it through the tunnel it is
# supposed to replace.
#
# The work lives in tunnels.ps1 (the tunnel farm): this script is the stable
# entry point the relay calls, and it keeps the flags the relay already uses.
$raw = @($args)

$Root = ""
$Port = 0
$Config = ""
$Bin = ""
$Attempts = 3
$Slot = -1

for ($i = 0; $i -lt $raw.Count; $i++) {
  $a = [string]$raw[$i]
  $next = if ($i + 1 -lt $raw.Count) { [string]$raw[$i + 1] } else { "" }
  switch -Regex ($a) {
    "^--?slot=(.+)$" { $Slot = [int]$Matches[1]; continue }
    "^--?slot$" { $Slot = [int]$next; $i++; continue }
    "^--?root=(.+)$" { $Root = $Matches[1]; continue }
    "^--?root$" { $Root = $next; $i++; continue }
    "^--?port=(.+)$" { $Port = [int]$Matches[1]; continue }
    "^--?port$" { $Port = [int]$next; $i++; continue }
    "^--?config=(.+)$" { $Config = $Matches[1]; continue }
    "^--?config$" { $Config = $next; $i++; continue }
    "^--?bin=(.+)$" { $Bin = $Matches[1]; continue }
    "^--?bin$" { $Bin = $next; $i++; continue }
    "^--?attempts=(.+)$" { $Attempts = [int]$Matches[1]; continue }
    "^--?attempts$" { $Attempts = [int]$next; $i++; continue }
    default { }
  }
}

if (-not $Root) { $Root = $env:SAJILO_ROOT }
if (-not $Root) { $Root = Join-Path $env:USERPROFILE ".sajilo" }
if ($Slot -lt 0) { $Slot = 0 }

$manager = Join-Path $Root "bin\tunnels.ps1"
if (-not (Test-Path $manager)) {
  # A fresh install may not have the manager yet (or it was removed): fall
  # back to the sibling copy next to this script.
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $fallback = Join-Path $here "tunnels.ps1"
  if (Test-Path $fallback) { $manager = $fallback }
}

if (-not (Test-Path $manager)) {
  Write-Host "usque-rotate: no tunnel manager at $manager - nothing to rotate"
  exit 0
}

$cmd = @("rotate", "-Root", $Root, "-Slot", "$Slot", "-Attempts", "$Attempts")
if ($Port -gt 0) { $cmd += @("-Port", "$Port") }
if ($Config) { $cmd += @("-Config", $Config) }
if ($Bin) { $cmd += @("-Usque", $Bin) }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $manager @cmd
exit $LASTEXITCODE
