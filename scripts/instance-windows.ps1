$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $binary = (Get-Item -LiteralPath $request.binary).FullName
  $guiPath = Join-Path (Split-Path $binary) 'wezterm-gui.exe'
  $processes = @(Get-Process -Name wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $guiPath })
  function Get-GuiIdentity($gui, $socket) {
    if (-not (Test-Path -LiteralPath $socket) -or $gui.HasExited) { return $null }
    $started = $gui.StartTime.ToUniversalTime()
    return @{
      endpoint = (Get-Item -LiteralPath $socket).FullName
      key = $env:COMPUTERNAME + ':' + $gui.Id + ':' + $started.ToString('o')
      pid = $gui.Id
      title = ([string]$gui.MainWindowTitle).Substring(0, [Math]::Min(4096, ([string]$gui.MainWindowTitle).Length))
      started = $started.Ticks
    }
  }
  $action = $request.action
  if (-not $action) { $action = 'resolve' }
  if ($action -notin @('resolve', 'list', 'select')) { throw 'Unknown GUI identity action.' }
  $endpoint = $request.endpoint
  if ($action -eq 'resolve' -and $endpoint) {
    if ((Split-Path $endpoint -Leaf) -notmatch '^gui-sock-(\d+)$') { throw 'Automatic identity requires a local GUI socket named gui-sock-PID.' }
    $guiId = [int]$Matches[1]
    $gui = @($processes | Where-Object { $_.Id -eq $guiId })
    if ($gui.Count -ne 1) { throw 'Configured WezTerm GUI endpoint is not alive. List GUI instances and select one explicitly.' }
    $selected = Get-GuiIdentity $gui[0] $endpoint
    if (-not $selected) { throw 'Configured WezTerm GUI endpoint is not alive. List GUI instances and select one explicitly.' }
  } else {
    # Process exit races are expected during discovery. Only expose live identities.
    $live = @(foreach ($gui in $processes) {
      try {
        $socket = Join-Path $env:USERPROFILE ('.local\share\wezterm\gui-sock-' + $gui.Id)
        $identity = Get-GuiIdentity $gui $socket
        if ($identity) { $identity }
      } catch { }
    })
    $live = @($live | Sort-Object @{Expression={$_.started};Descending=$true}, @{Expression={$_.pid};Descending=$true})
    if ($action -eq 'list') {
      $items = @($live | Select-Object -First 64 | ForEach-Object { @{endpoint=$_.endpoint;key=$_.key;pid=$_.pid;title=$_.title} })
      ConvertTo-Json -InputObject $items -Compress
      exit 0
    }
    if ($action -eq 'select') {
      $matches = @($live | Where-Object { $_.key -ceq $request.key })
      if ($matches.Count -ne 1) { throw 'Selected WezTerm GUI is no longer alive. List GUI instances and retry.' }
      $selected = $matches[0]
    } else {
      if ($live.Count -eq 0) { throw 'No running WezTerm GUI with a live socket found. Start WezTerm, then retry.' }
      $selected = $live[0]
      if ($live.Count -gt 1) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TermDadForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
        [uint32]$foregroundId = 0
        [void][TermDadForeground]::GetWindowThreadProcessId([TermDadForeground]::GetForegroundWindow(), [ref]$foregroundId)
        $foreground = @($live | Where-Object { $_.pid -eq $foregroundId })
        if ($foreground.Count -eq 1) { $selected = $foreground[0] }
      }
    }
  }
  @{ endpoint = $selected.endpoint; key = $selected.key } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('WezTerm identity unavailable: ' + $_.Exception.Message)
  exit 1
}
