# BÄCK — own domain + real public HTTPS URL
# Run as Administrator for Tailscale Funnel; Cloudflare tunnel works without admin.

param(
  [string]$Domain = "backstream.app",
  [ValidateSet("quick", "named", "funnel", "all")]
  [string]$Mode = "all",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools = Join-Path $Root "tools"
$Cloudflared = Join-Path $Tools "cloudflared.exe"
$TunnelJson = Join-Path $Root "tunnel.json"
$ConfigJson = Join-Path $Root "config.json"
$LogDir = Join-Path $Root "logs"
$TunnelLog = Join-Path $LogDir "cloudflared.log"

function Ensure-Cloudflared {
  if (Test-Path $Cloudflared) { return }
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
  Write-Host "[..] Downloading cloudflared..."
  Invoke-WebRequest -Uri $url -OutFile $Cloudflared -UseBasicParsing
  Write-Host "[ok] cloudflared installed"
}

function Update-ConfigDomain($publicUrl) {
  $cfg = @{}
  if (Test-Path $ConfigJson) {
    $cfg = Get-Content $ConfigJson -Raw | ConvertFrom-Json -AsHashtable
  }
  if (-not $cfg) { $cfg = @{} }
  $cfg.publicDomain = if ($publicUrl -match "^https?://") { $publicUrl.TrimEnd("/") } else { "https://$Domain" }
  ($cfg | ConvertTo-Json -Depth 8) | Set-Content $ConfigJson -Encoding UTF8
  Write-Host "[ok] config.json publicDomain = $($cfg.publicDomain)"
}

function Write-TunnelJson($url, $provider, $domainName) {
  $obj = @{
    provider = $provider
    url      = $url.TrimEnd("/")
    domain   = $domainName
    updated  = (Get-Date).ToUniversalTime().ToString("o")
  }
  ($obj | ConvertTo-Json) | Set-Content $TunnelJson -Encoding UTF8
  Write-Host "[ok] tunnel.json -> $url"
}

function Start-QuickTunnel {
  Ensure-Cloudflared
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  $proc = Start-Process -FilePath $Cloudflared -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate", "--logfile", $TunnelLog, "--loglevel", "info") -PassThru -WindowStyle Hidden
  Write-Host "[..] Starting Cloudflare quick tunnel (PID $($proc.Id))..."
  $url = $null
  for ($i = 0; $i - 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $TunnelLog) {
      $log = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
      if ($log -match "(https://[a-z0-9-]+\.trycloudflare\.com)") {
        $url = $Matches[1]
        break
      }
    }
  }
  if (-not $url) {
    Write-Host "[!!] Could not read tunnel URL from $TunnelLog"
    return $null
  }
  Write-TunnelJson $url "cloudflare-quick" "trycloudflare.com"
  return $url
}

function Enable-TailscaleFunnel {
  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listening) {
    Write-Host "[!!] BÄCK not listening on port $Port"
    return $null
  }
  $out = tailscale funnel --bg --yes $Port 2>&1 | Out-String
  $out.Trim().Split("`n") | ForEach-Object { if ($_) { Write-Host $_ } }
  if ($out -match "(https://[a-zA-Z0-9.-]+\.ts\.net)") {
    $u = $Matches[1]
    Write-Host "[ok] Tailscale Funnel: $u"
    return $u
  }
  tailscale funnel status 2>&1
  return $null
}

function Show-NamedTunnelSteps {
  Write-Host ""
  Write-Host "=== Permanent domain: https://$Domain ===" -ForegroundColor Cyan
  Write-Host "1. Register $Domain (e.g. Google Domains, Cloudflare Registrar, Namecheap)"
  Write-Host "2. Add the domain to Cloudflare (free plan is fine)"
  Write-Host "3. Run once (browser login):"
  Write-Host "     $Cloudflared tunnel login"
  Write-Host "4. Create tunnel:"
  Write-Host "     $Cloudflared tunnel create back"
  Write-Host "5. Route DNS:"
  Write-Host "     $Cloudflared tunnel route dns back $Domain"
  Write-Host "6. Copy config template and start:"
  Write-Host "     Copy-Item `"$Root\cloudflared-config.example.yml`" `"$env:USERPROFILE\.cloudflared\config.yml`""
  Write-Host "     $Cloudflared tunnel run back"
  Write-Host ""
}

# --- main ---
$healthOk = $false
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
  $healthOk = $true
} catch {
  Write-Host "[!!] Start BÄCK first: cd `"$Root`"; node server.js"
  exit 1
}

Update-ConfigDomain "https://$Domain"

$liveUrl = $null
if ($Mode -eq "quick" -or $Mode -eq "all") {
  Write-Host ""
  Write-Host "=== Cloudflare Quick Tunnel (instant public HTTPS) ===" -ForegroundColor Green
  $liveUrl = Start-QuickTunnel
}

if ($Mode -eq "funnel" -or $Mode -eq "all") {
  Write-Host ""
  Write-Host "=== Tailscale Funnel (public internet, no Cloudflare) ===" -ForegroundColor Green
  $funnelUrl = Enable-TailscaleFunnel
  if ($funnelUrl -and -not $liveUrl) {
    Write-TunnelJson $funnelUrl "tailscale-funnel" ($funnelUrl -replace "^https?://", "" -replace "/.*", "")
    $liveUrl = $funnelUrl
  }
}

if ($Mode -eq "named" -or $Mode -eq "all") {
  Show-NamedTunnelSteps
}

# Restart server to pick up tunnel.json
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
  try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match "server\.js" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Root
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "=== BÄCK URLs ===" -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 8
  if ($health.urls.canonical) { Write-Host "Brand:     $($health.urls.canonical)" -ForegroundColor Magenta }
  if ($health.urls.public) { Write-Host "Live:      $($health.urls.public)" -ForegroundColor Green }
  if ($health.urls.cloudflare) { Write-Host "Cloudflare: $($health.urls.cloudflare)" -ForegroundColor Green }
  if ($health.urls.lan) { Write-Host "LAN:       $($health.urls.lan)" }
  if ($health.urls.tailscaleDns) { Write-Host "Tailscale: $($health.urls.tailscaleDns)" }
} catch {
  Write-Host "[!!] Health check failed — open http://localhost:$Port"
}

Write-Host ""
Write-Host "Register $Domain then run: .\enable-domain.ps1 -Mode named" -ForegroundColor Yellow