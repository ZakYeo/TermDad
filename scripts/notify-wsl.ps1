$ErrorActionPreference = 'Stop'
# Only fixed summaries are displayed. Never render arbitrary terminal text.
$event = [Console]::In.ReadToEnd() | ConvertFrom-Json
$messages = @{
  input_required = 'A watched pane requires user input.'
  ready = 'A watched pane returned to a prompt. Success is not established.'
  inactive = 'A watched pane has unchanged text. Success is not established.'
  pane_disappeared = 'A watched pane is no longer present.'
  attention_required = 'A watched pane needs a person.'
  session_ended = 'A worker reported that its session ended.'
  'usage.threshold' = 'An account crossed a usage warning threshold. Check usage.status.'
  'usage.pause_requested' = 'An account reached its usage reserve. Work should pause at a safe boundary.'
  'usage.reset_due' = 'Expected reset time has passed. Check fresh five-hour and weekly allowances before resuming.'
  'usage.reset' = 'A fresh provider reading confirms allowance recovery.'
  'usage.resume_pending' = 'Short-window and weekly allowances permit continuation.'
}
if (-not $messages.ContainsKey([string]$event.kind)) { throw 'Unsupported notification kind' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
try {
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(2000, 'Term Dad', $messages[[string]$event.kind], [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Milliseconds 2500
} finally {
  $icon.Dispose()
}
