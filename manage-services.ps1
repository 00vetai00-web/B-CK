# BACK - interactive service management TUI (Windows / PowerShell)
# Usage:
#   .\manage-services.ps1
#   .\manage-services.cmd
#   .\manage-services.ps1 -ConfigPath .\services.conf
#   .\manage-services.ps1 -Action status -Service back-proxy

param(
  [string]$ConfigPath = "",
  [ValidateSet("", "status", "start", "stop", "restart", "backup")]
  [string]$Action = "",
  [string]$Service = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $ScriptDir "services.conf" }
$LogDir = if ($env:BACK_ADMIN_LOG_DIR) { $env:BACK_ADMIN_LOG_DIR } else { Join-Path $ScriptDir "logs" }
$AdminLog = Join-Path $LogDir "admin-actions.log"
$StateDir = if ($env:BACK_STATE_DIR) { $env:BACK_STATE_DIR } else { Join-Path $ScriptDir ".service-state" }

$Global:SvcList = @()
$Global:SvcMap = @{}
$Global:CliMode = [bool]$Action

function Write-User([string]$Message, [string]$Color = "") {
  if ($Global:CliMode) {
    Write-Output $Message
    return
  }
  if ($Color) { Write-Host $Message -ForegroundColor $Color }
  else { Write-Host $Message }
}

function Write-AdminLog([string]$Message) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
  $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Add-Content -Path $AdminLog -Value "$ts $Message" -Encoding UTF8
}

function Exit-Err([string]$Message) {
  Write-User "ERROR: $Message" "Red"
  Write-AdminLog "ERROR: $Message"
  exit 1
}

function Resolve-ServicePath([string]$Base, [string]$Rel) {
  if ([System.IO.Path]::IsPathRooted($Rel)) { return $Rel }
  return Join-Path $Base $Rel
}

function Read-IniConfig([string]$Path) {
  if (-not (Test-Path $Path)) {
    Exit-Err "Config not found: $Path (copy services.conf.example to services.conf)"
  }
  $section = ""
  $list = New-Object System.Collections.Generic.List[string]
  $map = @{}

  foreach ($raw in Get-Content -Path $Path -Encoding UTF8) {
    $line = ($raw -replace "#.*$", "").Trim()
    if (-not $line) { continue }
    if ($line -match "^\[(.+)\]$") {
      $section = $Matches[1].Trim()
      if (-not $map.ContainsKey($section)) {
        $map[$section] = @{}
        [void]$list.Add($section)
      }
      continue
    }
    if (-not $section) { continue }
    if ($line -match "^([^=]+)=(.*)$") {
      $key = $Matches[1].Trim()
      $val = $Matches[2].Trim().Trim('"')
      $map[$section][$key] = $val
    }
  }

  if ($list.Count -eq 0) { Exit-Err "No services defined in $Path" }
  $Global:SvcList = $list.ToArray()
  $Global:SvcMap = $map
}

function Get-ServiceDef([string]$Name) {
  if (-not $Global:SvcMap.ContainsKey($Name)) { Exit-Err "Unknown service: $Name" }
  return $Global:SvcMap[$Name]
}

function Get-PortListener([int]$Port) {
  if (-not $Port) { return $null }
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  return [int]$conn.OwningProcess
}

function Test-ProcessAlive([int]$ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Read-ServicePid([string]$Name) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $pf = $def["pid_file"]
  if (-not $wd -or -not $pf) { return $null }
  $path = Resolve-ServicePath $wd $pf
  if (-not (Test-Path $path)) { return $null }
  $pidText = (Get-Content $path -Raw -ErrorAction SilentlyContinue).Trim()
  if ($pidText -notmatch "^\d+$") { return $null }
  $procId = [int]$pidText
  if (-not (Test-ProcessAlive $procId)) { return $null }
  return $procId
}

function Write-ServicePid([string]$Name, [int]$ProcessId) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $pf = if ($def["pid_file"]) { $def["pid_file"] } else { ".pid" }
  $path = Resolve-ServicePath $wd $pf
  $parent = Split-Path $path -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -Path $path -Value $ProcessId -Encoding ASCII -NoNewline
}

function Clear-ServicePid([string]$Name) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $pf = $def["pid_file"]
  if (-not $wd -or -not $pf) { return }
  $path = Resolve-ServicePath $wd $pf
  if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
}

function Sync-ServicePidFromPort([string]$Name) {
  $def = Get-ServiceDef $Name
  $port = $def["port"]
  if (-not $port) { return $null }
  $owner = Get-PortListener ([int]$port)
  if ($owner) { Write-ServicePid $Name $owner }
  return $owner
}

function Get-RunningServicePid([string]$Name) {
  $def = Get-ServiceDef $Name
  $port = $def["port"]
  $servicePid = Read-ServicePid $Name

  if ($port) {
    $owner = Get-PortListener ([int]$port)
    if ($owner) {
      if (-not $servicePid -or $servicePid -ne $owner) {
        Write-ServicePid $Name $owner
      }
      return $owner
    }
  }

  return $servicePid
}

function Test-ServiceRunning([string]$Name) {
  return [bool](Get-RunningServicePid $Name)
}

function Get-ServiceStatusText([string]$Name) {
  $def = Get-ServiceDef $Name
  $port = $def["port"]
  $servicePid = Get-RunningServicePid $Name
  if ($servicePid) {
    if ($port) { return "RUNNING (port $port pid $servicePid)" }
    return "RUNNING (pid $servicePid)"
  }
  return "STOPPED"
}

function Split-StartCommand([string]$Command) {
  $exe = ""
  $argList = @()
  $m = [regex]::Match($Command, '^\s*("([^"]+)"|(\S+))(?:\s+(.*))?$')
  if (-not $m.Success) { return @{ Exe = $Command; Args = @() } }
  $exe = if ($m.Groups[2].Success) { $m.Groups[2].Value } else { $m.Groups[3].Value }
  $rest = $m.Groups[4].Value
  if ($rest) {
    $argList = [regex]::Matches($rest, '"([^"]*)"|(\S+)') | ForEach-Object {
      if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    }
  }
  return @{ Exe = $exe; Args = $argList }
}

function Wait-ServiceReady([string]$Name, [int]$TimeoutSec = 8) {
  $def = Get-ServiceDef $Name
  $port = $def["port"]
  $deadline = (Get-Date).AddSeconds($TimeoutSec)

  while ((Get-Date) -lt $deadline) {
    if ($port) {
      $owner = Get-PortListener ([int]$port)
      if ($owner) {
        Write-ServicePid $Name $owner
        return $owner
      }
    } else {
      $servicePid = Read-ServicePid $Name
      if ($servicePid) { return $servicePid }
    }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Start-BackService([string]$Name) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $cmd = $def["start_cmd"]
  $port = $def["port"]
  if (-not $wd -or -not $cmd) { Exit-Err "[$Name] missing workdir or start_cmd" }
  if (-not (Test-Path $wd)) { Exit-Err "[$Name] workdir not found: $wd" }

  $runningPid = Get-RunningServicePid $Name
  if ($runningPid) {
    Write-User "[$Name] already running (pid $runningPid)" "Yellow"
    return
  }

  if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

  $logRel = $def["log_file"]
  $logPath = if ($logRel) { Resolve-ServicePath $wd $logRel } else { $null }
  if ($logPath) {
    $logParent = Split-Path $logPath -Parent
    if (-not (Test-Path $logParent)) { New-Item -ItemType Directory -Force -Path $logParent | Out-Null }
    if (-not (Test-Path $logPath)) { New-Item -ItemType File -Force -Path $logPath | Out-Null }
  }

  Write-AdminLog "START $Name cwd=$wd cmd=$cmd"

  $parsed = Split-StartCommand $cmd
  $exe = $parsed.Exe
  $args = $parsed.Args
  $proc = $null

  if ($exe -eq "node") {
    $startArgs = @{ FilePath = "node"; ArgumentList = $args; WorkingDirectory = $wd; WindowStyle = "Hidden"; PassThru = $true }
    if ($logPath) {
      $startArgs["RedirectStandardOutput"] = $logPath
      $startArgs["RedirectStandardError"] = "$logPath.err"
    }
    $proc = Start-Process @startArgs
  } elseif ($exe -match "cloudflared") {
    $cf = Resolve-ServicePath $wd $exe
    if (-not (Test-Path $cf)) { $cf = $exe }
    $startArgs = @{ FilePath = $cf; ArgumentList = $args; WorkingDirectory = $wd; WindowStyle = "Hidden"; PassThru = $true }
    if ($logPath) {
      $startArgs["RedirectStandardOutput"] = $logPath
      $startArgs["RedirectStandardError"] = "$logPath.err"
    }
    $proc = Start-Process @startArgs
  } else {
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $cmd) -WorkingDirectory $wd -WindowStyle Hidden -PassThru
  }

  if ($proc) { Write-ServicePid $Name $proc.Id }

  $readyPid = Wait-ServiceReady $Name
  if ($readyPid) {
    Write-User "[$Name] started (pid $readyPid)" "Green"
    Write-AdminLog "STARTED $Name pid=$readyPid"
    return
  }

  Clear-ServicePid $Name
  $hint = if ($logPath) { "check $logPath" } else { "check process list" }
  Exit-Err "[$Name] failed to start - $hint"
}

function Stop-BackService([string]$Name) {
  $def = Get-ServiceDef $Name
  $custom = $def["stop_cmd"]
  $port = $def["port"]
  Write-AdminLog "STOP $Name"

  if ($custom) {
    $wd = $def["workdir"]
    Push-Location $wd
    try {
      Invoke-Expression $custom
    } finally {
      Pop-Location
    }
    Clear-ServicePid $Name
    Write-User "[$Name] stopped (custom command)" "Green"
    Write-AdminLog "STOPPED $Name custom"
    return
  }

  $stopped = $false
  $servicePid = Read-ServicePid $Name
  if ($servicePid) {
    Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Test-ProcessAlive $servicePid) {
      Start-Sleep -Seconds 2
      Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
    }
    $stopped = $true
    Write-User "[$Name] stopped (pid $servicePid)" "Green"
    Write-AdminLog "STOPPED $Name pid=$servicePid"
  }

  if ($port) {
    $owners = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owner in $owners) {
      Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
      $stopped = $true
      Write-User "[$Name] stopped via port $port (pid $owner)" "Green"
      Write-AdminLog "STOPPED $Name port=$port pid=$owner"
    }
  }

  Clear-ServicePid $Name
  if (-not $stopped) {
    Write-User "[$Name] not running" "DarkGray"
  }
}

function Restart-BackService([string]$Name) {
  Write-AdminLog "RESTART $Name"
  Stop-BackService $Name
  Start-Sleep -Seconds 1
  Start-BackService $Name
}

function Show-ServiceResources([string]$Name) {
  $servicePid = Get-RunningServicePid $Name
  if (-not $servicePid) {
    Write-Host "[$Name] not running" -ForegroundColor Yellow
    return
  }
  $p = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
  if (-not $p) {
    Write-Host "[$Name] pid $servicePid not found" -ForegroundColor Yellow
    return
  }
  $cpu = "{0:N1}" -f $p.CPU
  $memMb = "{0:N1}" -f ($p.WorkingSet64 / 1MB)
  Write-Host ("[{0}] pid={1} CPU={2}s MEM={3} MB Name={4}" -f $Name, $servicePid, $cpu, $memMb, $p.ProcessName) -ForegroundColor Cyan
}

function Backup-ServiceConfig([string]$Name) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $files = $def["config_files"]
  if (-not $files) {
    Write-Host "[$Name] no config_files defined" -ForegroundColor Yellow
    return
  }

  $backupDir = Join-Path $StateDir "backups"
  if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $dest = Join-Path $backupDir "$Name-$stamp.zip"

  $toZip = @()
  foreach ($f in ($files -split ",")) {
    $f = $f.Trim()
    if (-not $f) { continue }
    $full = Resolve-ServicePath $wd $f
    if (Test-Path $full) { $toZip += $full }
  }
  if ($toZip.Count -eq 0) { Exit-Err "[$Name] no config files found to backup" }

  Compress-Archive -Path $toZip -DestinationPath $dest -Force
  Write-Host "[$Name] backup -> $dest" -ForegroundColor Green
  Write-AdminLog "BACKUP $Name -> $dest"
}

function Show-ServiceLogs([string]$Name, [bool]$Follow) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $logRel = $def["log_file"]
  if (-not $logRel) { Exit-Err "[$Name] no log_file configured" }
  $path = Resolve-ServicePath $wd $logRel
  if (-not (Test-Path $path)) {
    New-Item -ItemType File -Force -Path $path | Out-Null
    Write-Host "[$Name] log file created (empty): $path" -ForegroundColor Yellow
  }

  Write-AdminLog "LOGS $Name follow=$Follow"
  if ($Follow) {
    Get-Content -Path $path -Tail 80 -Wait
  } else {
    Get-Content -Path $path -Tail 80 -ErrorAction SilentlyContinue
  }
}

function Update-BackService([string]$Name) {
  $def = Get-ServiceDef $Name
  $wd = $def["workdir"]
  $cmd = $def["update_cmd"]
  if (-not $cmd) {
    Write-Host "[$Name] no update_cmd configured" -ForegroundColor Yellow
    return
  }
  Write-AdminLog "UPDATE $Name"
  Push-Location $wd
  try {
    Invoke-Expression $cmd
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Exit-Err "[$Name] update failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  Write-Host "[$Name] update complete" -ForegroundColor Green
  Write-AdminLog "UPDATED $Name"
}

function Select-Service {
  Write-Host ""
  Write-Host "Services:" -ForegroundColor Cyan
  for ($i = 0; $i -lt $Global:SvcList.Count; $i++) {
    $name = $Global:SvcList[$i]
    $st = Get-ServiceStatusText $name
    Write-Host ("  {0}) {1} - {2}" -f ($i + 1), $name, $st)
  }
  Write-Host ""
  $pick = Read-Host ("Select service [1-{0}]" -f $Global:SvcList.Count)
  if ($pick -notmatch "^\d+$") { Exit-Err "Invalid selection" }
  $idx = [int]$pick - 1
  if ($idx -lt 0 -or $idx -ge $Global:SvcList.Count) { Exit-Err "Invalid selection" }
  return $Global:SvcList[$idx]
}

function Show-Menu {
  Clear-Host
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host "   BACK - Service Management TUI" -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host "Config:    $ConfigPath"
  Write-Host "Admin log: $AdminLog"
  Write-Host ""
  Write-Host "  1) Start service"
  Write-Host "  2) Stop service"
  Write-Host "  3) Restart service"
  Write-Host "  4) Status (all)"
  Write-Host "  5) Tail logs (follow)"
  Write-Host "  6) Tail logs (last 80 lines)"
  Write-Host "  7) Backup configuration"
  Write-Host "  8) Resource usage (CPU/RAM)"
  Write-Host "  9) Update service"
  Write-Host "  0) Exit"
  Write-Host ""
}

# --- bootstrap ---
Read-IniConfig $ConfigPath
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

if ($Action -eq "status" -and $Service) {
  $status = Get-ServiceStatusText $Service
  Write-Output $status
  if ($status -eq "STOPPED") { exit 1 }
  exit 0
}
if ($Action -eq "start" -and $Service) { Start-BackService $Service; exit 0 }
if ($Action -eq "stop" -and $Service) { Stop-BackService $Service; exit 0 }
if ($Action -eq "restart" -and $Service) { Restart-BackService $Service; exit 0 }
if ($Action -eq "backup" -and $Service) { Backup-ServiceConfig $Service; exit 0 }

Write-AdminLog "TUI session start config=$ConfigPath"

while ($true) {
  Show-Menu
  $choice = Read-Host "Choice"
  switch ($choice) {
    "1" { $s = Select-Service; Start-BackService $s; Read-Host "Press Enter" }
    "2" { $s = Select-Service; Stop-BackService $s; Read-Host "Press Enter" }
    "3" { $s = Select-Service; Restart-BackService $s; Read-Host "Press Enter" }
    "4" {
      foreach ($s in $Global:SvcList) {
        $st = Get-ServiceStatusText $s
        Write-Host ("  {0,-16} {1}" -f $s, $st)
      }
      Read-Host "Press Enter"
    }
    "5" { $s = Select-Service; Show-ServiceLogs $s $true }
    "6" { $s = Select-Service; Show-ServiceLogs $s $false; Read-Host "Press Enter" }
    "7" { $s = Select-Service; Backup-ServiceConfig $s; Read-Host "Press Enter" }
    "8" { $s = Select-Service; Show-ServiceResources $s; Read-Host "Press Enter" }
    "9" { $s = Select-Service; Update-BackService $s; Read-Host "Press Enter" }
    "0" { Write-AdminLog "TUI session end"; Write-Host "Bye."; exit 0 }
    default { Write-Host "Invalid choice" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
  }
}