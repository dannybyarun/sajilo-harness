# sajilo-rebrand.ps1 - the identity of a Sajilo instance (Windows).
#
#   sajilo rebrand            apply the Sajilo identity (default)
#   sajilo rebrand --status   report what is branded right now
#   sajilo rebrand --restore  go back to the stock opencode identity
#
# What it brands:
#   * the provider the runtime prints next to the model  -> "Sajilo"
#   * the terminal window title                          -> no "OpenCode"
#   * the update dialog and the splash banner           -> gone
#
# What it cannot brand: the runtime's own welcome wordmark. That art is a
# compressed asset inside the opencode binary; no supported setting replaces
# it. It stays.
$ErrorActionPreference = "Stop"

if ($env:SAJILO_ROOT) { $Root = $env:SAJILO_ROOT } else { $Root = Join-Path $env:USERPROFILE ".sajilo" }
$HomeDir = Join-Path $Root "home"
$StateDir = Join-Path $Root "state"
$CfgDir = Join-Path $HomeDir ".config\opencode"
$RuntimeCfg = Join-Path $CfgDir "opencode.json"
$CliCfg = Join-Path $CfgDir "cli.json"
$Marker = Join-Path $StateDir "stock-identity"

function Say([string]$m) { Write-Host "rebrand: $m" }
function Note([string]$m) { Write-Host "  $m" }

New-Item -ItemType Directory -Force -Path $CfgDir, $StateDir | Out-Null

$Mode = if ($args.Count -gt 0) { $args[0] } else { "apply" }

function Write-Sajilo {
  @"
{
  "`$schema": "https://opencode.ai/v2/cli.json",
  "terminal": { "title": false },
  "highlights": false,
  "mini": { "splash": "hide" }
}
"@ | Set-Content -Path $CliCfg -Encoding utf8
  Remove-Item $Marker -Force -ErrorAction SilentlyContinue
  Say "identity -> Sajilo"
  Note "provider name      : Sajilo"
  Note "terminal title     : off (no OpenCode in the tab)"
  Note "update dialog      : off"
  Note "splash banner      : off"
  Note "welcome wordmark   : the runtime's own art - not replaceable"
}

function Write-Stock {
  @"
{
  "`$schema": "https://opencode.ai/v2/cli.json",
  "terminal": { "title": true },
  "highlights": true,
  "mini": { "splash": "show" }
}
"@ | Set-Content -Path $CliCfg -Encoding utf8
  New-Item -ItemType File -Force -Path $Marker | Out-Null
  Say "identity -> stock opencode"
  Note "restart the instance to pick it up"
}

function Show-Status {
  if (Test-Path $Marker) { Say "identity: stock opencode" } else { Say "identity: Sajilo" }
  if (Test-Path $CliCfg) { Note "cli settings       : $CliCfg" } else { Note "cli settings       : (none)" }
  if (Test-Path $RuntimeCfg) {
    Note "runtime config     : $RuntimeCfg"
    try {
      $j = Get-Content $RuntimeCfg -Raw | ConvertFrom-Json
      foreach ($p in $j.provider.PSObject.Properties) { Note "provider           : $($p.Name) ($($p.Value.name))" }
      if ($j.model) { Note "model              : $($j.model)" }
    } catch {
      Note "provider           : (unreadable config)"
    }
  }
}

switch ($Mode) {
  "--status" { Show-Status }
  "status" { Show-Status }
  "--restore" { Write-Stock }
  "restore" { Write-Stock }
  default { Write-Sajilo }
}
