# Non-interactive smoke test for manage-services.ps1
param([string]$Service = "back-proxy")

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Script = Join-Path $Root "manage-services.ps1"

function Invoke-Mgmt([string]$Action, [string]$Name) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = & $Script -Action $Action -Service $Name 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return @{ Code = $code; Out = ($out | Out-String).Trim() }
}

function Get-Status([string]$Name) {
  return Invoke-Mgmt "status" $Name
}

function Assert([bool]$Cond, [string]$Msg) {
  if (-not $Cond) { throw "FAIL: $Msg" }
  Write-Host "OK: $Msg" -ForegroundColor Green
}

Write-Host "=== manage-services smoke test ($Service) ===" -ForegroundColor Cyan

Invoke-Mgmt "stop" $Service | Out-Null
Start-Sleep -Seconds 1
$st = Get-Status $Service
Assert ($st.Out -match "STOPPED") "stop leaves service stopped"

$r = Invoke-Mgmt "start" $Service
Assert ($r.Code -eq 0) "start exits 0"
Start-Sleep -Seconds 2
$st = Get-Status $Service
Assert ($st.Out -match "RUNNING") "start brings service up"

$r2 = Invoke-Mgmt "start" $Service
Assert ($r2.Code -eq 0) "second start is idempotent"
Assert ($r2.Out -match "already running") "duplicate start reports already running"

$r3 = Invoke-Mgmt "restart" $Service
Assert ($r3.Code -eq 0) "restart exits 0"
Start-Sleep -Seconds 2
$st = Get-Status $Service
Assert ($st.Out -match "RUNNING") "restart keeps service running"

$r4 = Invoke-Mgmt "backup" $Service
Assert ($r4.Code -eq 0) "backup exits 0"

try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 5
  Assert ($resp.StatusCode -eq 200) "health endpoint responds"
} catch {
  throw "FAIL: health endpoint unreachable - $($_.Exception.Message)"
}

Write-Host "=== all checks passed ===" -ForegroundColor Green