# BACK - complete access setup (LAN :80, Tailscale HTTPS, WAN fallback)
# Run once as Administrator for firewall, port proxy, and optional Funnel.

param(
  [switch]$SkipCloudflare,
  [switch]$SkipAutostart
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Port = 3000
$Tools = Join-Path $Root "tools"
$Cloudflared = Join-Path $Tools "cloudflared.exe"
$TunnelJson = Join-Path $Root "tunnel.json"
$LogDir = Join-Path $Root "logs"
$TunnelLog = Join-Path $LogDir "cloudflared.log"

function Write-Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Cyan }

function Ensure-Server {
  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host "[ok] BACK listening on port $Port"
    return
  }
  Write-Host "[..] Starting BACK server..."
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Root
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Write-Host "[ok] BACK started"; return }
  }
  throw "BACK did not start on port $Port"
}

function Ensure-Cloudflared {
  if (Test-Path $Cloudflared) { return }
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
  Write-Host "[..] Downloading cloudflared..."
  Invoke-WebRequest -Uri $url -OutFile $Cloudflared -UseBasicParsing
  Write-Host "[ok] cloudflared installed"
}

function Start-CloudflareTunnel {
  Ensure-Cloudflared
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  $proc = Start-Process -FilePath $Cloudflared -ArgumentList @(
    "tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate",
    "--logfile", $TunnelLog, "--loglevel", "info"
  ) -PassThru -WindowStyle Hidden
  Write-Host "[..] Cloudflare tunnel starting (PID $($proc.Id))..."
  $url = $null
  if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $TunnelLog) {
      $log = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
      $matches = [regex]::Matches($log, "https://[a-z0-9-]+\.trycloudflare\.com")
      if ($matches.Count -gt 0) {
        $url = $matches[$matches.Count - 1].Value
        break
      }
    }
  }
  if (-not $url) {
    Write-Host "[!!] Could not read Cloudflare URL from log"
    return $null
  }
  $obj = @{
    provider = "cloudflare-quick"
    url      = $url.TrimEnd("/")
    domain   = "trycloudflare.com"
    updated  = (Get-Date).ToUniversalTime().ToString("o")
  }
  ($obj | ConvertTo-Json) | Set-Content $TunnelJson -Encoding UTF8
  Write-Host "[ok] Cloudflare WAN: $url"
  return $url
}

function Register-Autostart {
  $taskName = "BACK-IPTV-Server"
  $serverScript = Join-Path $Root "start-background.ps1"
  if (-not (Test-Path $serverScript)) { return }
  $existing = schtasks /Query /TN $taskName 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[ok] Autostart task already exists: $taskName"
    return
  }
  $action = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serverScript`""
  schtasks /Create /TN $taskName /TR $action /SC ONLOGON /RL HIGHEST /F | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "[ok] Autostart registered: $taskName" }
}

# --- main ---
Write-Host ""
Write-Host "  BACK - Complete Access Setup" -ForegroundColor Green
Write-Host ""

Write-Step "1. Server"
Ensure-Server

Write-Step "2. LAN without :3000 (port 80 proxy + firewall)"
& (Join-Path $Root "enable-clean-url.ps1") -LanOnly

Write-Step "3. Tailscale HTTPS (outside LAN, no :3000)"
& (Join-Path $Root "enable-clean-url.ps1")

$funnelOk = $false
try {
  $funnelStatus = tailscale funnel status --json 2>$null | ConvertFrom-Json
  $funnelOk = [bool]$funnelStatus.Funnel
} catch { }

if (-not $funnelOk) {
  Write-Host ""
  Write-Host "[..] Trying Tailscale Funnel (public internet, no Tailscale app)..."
  $funnelJob = Start-Job { param($p) tailscale funnel --bg --yes $p 2>&1 | Out-String } -ArgumentList $Port
  $funnelOut = $null
  Wait-Job $funnelJob -Timeout 8 | Out-Null
  if ($funnelJob.State -eq "Running") {
    Stop-Job $funnelJob -Force | Out-Null
    Remove-Job $funnelJob -Force | Out-Null
    Write-Host "[!!] Funnel timed out (likely needs admin enable)"
  } else {
    $funnelOut = Receive-Job $funnelJob
    Remove-Job $funnelJob -Force | Out-Null
    if ($funnelOut -match "Funnel is not enabled") {
      if ($funnelOut -match "https://login\.tailscale\.com/f/funnel\?node=[^\s]+") {
        Write-Host ""
        Write-Host "Enable Funnel once (Tailscale admin), then re-run:" -ForegroundColor Yellow
        Write-Host "  $($Matches[0])" -ForegroundColor Cyan
      }
    } else {
      Write-Host "[ok] Tailscale Funnel active"
      $funnelOk = $true
    }
  }
}

if (-not $funnelOk -and -not $SkipCloudflare) {
  Write-Step "4. Cloudflare WAN fallback (works without Tailscale app)"
  Start-CloudflareTunnel
} else {
  Write-Host ""
  Write-Host "[ok] Skipping Cloudflare (Funnel active or -SkipCloudflare)"
}

if (-not $SkipAutostart) {
  Write-Step "5. Autostart on login"
  Register-Autostart
}

Write-Step "Your URLs"
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 10
if ($health.urls.lan) { Write-Host "LAN (no port):  $($health.urls.lan)" -ForegroundColor Cyan }
if ($health.urls.tailscaleDns) { Write-Host "Tailscale:      $($health.urls.tailscaleDns)" -ForegroundColor Green }
if ($health.urls.wan -and $health.urls.wan -ne $health.urls.tailscaleDns) {
  Write-Host "Public WAN:     $($health.urls.wan)" -ForegroundColor Magenta
}
if ($health.network.funnelEnableUrl -and -not $health.network.funnel) {
  Write-Host "Enable Funnel:  $($health.network.funnelEnableUrl)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Playback on remote devices still requires Mullvad VPN on that device." -ForegroundColor DarkGray