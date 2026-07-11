# Run once as Administrator to allow inbound TCP 3000 on Tailscale (Private profile).
# Without this, remote tailnet devices cannot reach BÄCK even though the server binds 0.0.0.0.

$ruleName = "BACK IPTV (Tailscale)"
$existing = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Firewall rule already exists: $ruleName"
} else {
  netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes
  if ($LASTEXITCODE -ne 0) { exit 1 }
  Write-Host "Added firewall rule: $ruleName"
}

Write-Host ""
Write-Host "Open BÄCK from any device on your tailnet:"
$status = tailscale status --json 2>$null | ConvertFrom-Json
if ($status.Self.DNSName) {
  $host = ($status.Self.DNSName -replace '\.$','')
  Write-Host "  http://${host}:3000"
}
if ($status.Self.TailscaleIPs) {
  foreach ($ip in $status.Self.TailscaleIPs) {
    if ($ip -match '^\d+\.') { Write-Host "  http://${ip}:3000" }
  }
}