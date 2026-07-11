# BACK - clean URLs (no :3000) + outside-LAN access
# Run once as Administrator

param(
  [switch]$PublicWan,
  [switch]$LanOnly
)

$ErrorActionPreference = "Stop"
$rule80 = "BACK IPTV (HTTP 80)"
$rule3000 = "BACK IPTV (Tailscale)"

function Ensure-FirewallRule($name, $port) {
  $existing = netsh advfirewall firewall show rule name="$name" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[ok] Firewall rule exists: $name"
  } else {
    netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=TCP localport=$port profile=any enable=yes | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to add firewall rule: $name" }
    Write-Host "[ok] Added firewall rule: $name (TCP $port)"
  }
}

function Ensure-PortProxy80 {
  $show = netsh interface portproxy show v4tov4 2>$null
  if ($show -match "127\.0\.0\.1\s+3000" -and $show -match "0\.0\.0\.0\s+80") {
    Write-Host "[ok] Port proxy 80 -> 127.0.0.1:3000 already configured"
    return
  }
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=3000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to add port proxy 80 -> 3000" }
  Write-Host "[ok] Port proxy: 0.0.0.0:80 -> 127.0.0.1:3000"
}

$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host "[!!] BACK is not running on port 3000."
  Write-Host "     Start it: cd A:\Projekt\BACK-GROK\back-proxy; node server.js"
  exit 1
}

Ensure-FirewallRule $rule3000 3000
Ensure-FirewallRule $rule80 80
Ensure-PortProxy80

if (-not $LanOnly) {
  Write-Host ""
  Write-Host "=== Tailscale HTTPS (no :3000, outside LAN) ==="
  $serveOut = tailscale serve --bg --yes 3000 2>&1
  $serveOut | ForEach-Object { Write-Host $_ }
  if ($serveOut -match "Serve is not enabled") {
    if ($serveOut -match "https://login\.tailscale\.com/f/serve\?node=[^\s]+") {
      $enableUrl = $Matches[0]
      Write-Host ""
      Write-Host "Open this link once (same Tailscale account), then re-run this script:" -ForegroundColor Yellow
      Write-Host "  $enableUrl" -ForegroundColor Cyan
    }
  } else {
    Write-Host "[ok] Tailscale Serve configured"
    tailscale serve status
  }

  if ($PublicWan) {
    Write-Host ""
    Write-Host "=== Public WAN (internet - no Tailscale app required) ==="
    $funnelOut = tailscale funnel --bg --yes 3000 2>&1
    $funnelOut | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[ok] Tailscale Funnel configured"
      tailscale funnel status
    }
  }
}

Write-Host ""
Write-Host "=== Your URLs ==="
$health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 8
if ($health.urls.lan) { Write-Host "LAN:      $($health.urls.lan)" -ForegroundColor Cyan }
if ($health.urls.public) { Write-Host "Remote:   $($health.urls.public)" -ForegroundColor Green }
elseif ($health.urls.remote) { Write-Host "Remote:   $($health.urls.remote)" -ForegroundColor Cyan }
if ($health.network.serveEnableUrl) {
  Write-Host "Enable:   $($health.network.serveEnableUrl)" -ForegroundColor Yellow
}
if ($health.network.funnelEnableUrl -and -not $health.network.funnel) {
  Write-Host "Funnel:   $($health.network.funnelEnableUrl)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Playback on remote devices still requires Mullvad VPN on that device."