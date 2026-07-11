# Start BÄCK server + LAN port 80 proxy (used by autostart task)
$ErrorActionPreference = "SilentlyContinue"
$Root = $PSScriptRoot

$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Root
  Start-Sleep -Seconds 2
}

$show = netsh interface portproxy show v4tov4 2>$null
if ($show -notmatch "127\.0\.0\.1\s+3000") {
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=3000 | Out-Null
}

# Refresh Tailscale Serve if available
tailscale serve --bg --yes 3000 2>$null | Out-Null

# Restart Cloudflare tunnel if tunnel.json exists
$tunnelJson = Join-Path $Root "tunnel.json"
$cloudflared = Join-Path $Root "tools\cloudflared.exe"
if ((Test-Path $tunnelJson) -and (Test-Path $cloudflared)) {
  $t = Get-Content $tunnelJson -Raw | ConvertFrom-Json
  if ($t.provider -eq "cloudflare-quick") {
    $log = Join-Path $Root "logs\cloudflared.log"
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 400
    Start-Process -FilePath $cloudflared -ArgumentList @(
      "tunnel", "--url", "http://127.0.0.1:3000", "--no-autoupdate",
      "--logfile", $log, "--loglevel", "info"
    ) -WindowStyle Hidden
  }
}