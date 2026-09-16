$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $binary = (Get-Item -LiteralPath $request.binary).FullName
  $guiPath = Join-Path (Split-Path $binary) 'wezterm-gui.exe'
  $processes = @(Get-Process -Name wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $guiPath })
  $endpoint = $request.endpoint
  if (-not $endpoint) {
    if ($processes.Count -ne 1) { throw 'Configure WEZTERM_UNIX_SOCKET to select one WezTerm GUI endpoint.' }
    $endpoint = Join-Path $env:USERPROFILE ('.local\share\wezterm\gui-sock-' + $processes[0].Id)
  }
  if ((Split-Path $endpoint -Leaf) -notmatch '^gui-sock-(\d+)$') { throw 'Automatic identity requires a local GUI socket named gui-sock-PID.' }
  $guiId = [int]$Matches[1]
  $gui = @($processes | Where-Object { $_.Id -eq $guiId })
  if ($gui.Count -ne 1 -or -not (Test-Path -LiteralPath $endpoint)) { throw 'Configured WezTerm GUI endpoint is not alive.' }
  $endpoint = (Get-Item -LiteralPath $endpoint).FullName
  $key = $env:COMPUTERNAME + ':' + $guiId + ':' + $gui[0].StartTime.ToUniversalTime().ToString('o')
  @{ endpoint = $endpoint; key = $key } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('WezTerm identity unavailable: ' + $_.Exception.Message)
  exit 1
}
