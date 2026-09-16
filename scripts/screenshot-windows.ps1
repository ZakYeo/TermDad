param([int]$PaneId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TermDadCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
$wez = Join-Path $env:ProgramFiles 'WezTerm\wezterm.exe'
$panes = (& $wez cli list --format json | ConvertFrom-Json)
if (-not ($panes | Where-Object { $_.pane_id -eq $PaneId })) { throw 'Pane not found' }
# WezTerm mux window IDs are not HWNDs. Refuse ambiguous multi-window capture.
$windows = @(Get-Process wezterm-gui | Where-Object { $_.MainWindowHandle -ne 0 })
if ($windows.Count -ne 1 -or @($panes.window_id | Select-Object -Unique).Count -ne 1) { throw 'Windows capture currently requires exactly one WezTerm GUI window' }
& $wez cli activate-pane --pane-id $PaneId | Out-Null
Start-Sleep -Milliseconds 200
$hwnd = $windows[0].MainWindowHandle
$rect = New-Object TermDadCapture+RECT
if (-not [TermDadCapture]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Cannot locate WezTerm window' }
$bitmap = New-Object System.Drawing.Bitmap ($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
try { if (-not [TermDadCapture]::PrintWindow($hwnd,$dc,2)) { throw 'PrintWindow failed' } }
finally { $graphics.ReleaseHdc($dc) }
$stream = New-Object System.IO.MemoryStream
try { $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray())) }
finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
