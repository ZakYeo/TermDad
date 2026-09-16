param([int]$PaneId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class TermDadCapture {
 public class Window { public IntPtr Handle; public uint ProcessId; public string Title; }
 private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr state);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);
 [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
 public static Window[] Windows() {
  var windows = new List<Window>();
  EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
   if (IsWindowVisible(hwnd)) {
    uint processId; GetWindowThreadProcessId(hwnd, out processId);
    var title = new StringBuilder(32768); GetWindowText(hwnd, title, title.Capacity);
    windows.Add(new Window { Handle=hwnd, ProcessId=processId, Title=title.ToString() });
   }
   return true;
  }, IntPtr.Zero);
  return windows.ToArray();
 }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
$wez = Join-Path $env:ProgramFiles 'WezTerm\wezterm.exe'
$panes = (& $wez cli --no-auto-start list --format json | ConvertFrom-Json)
if (-not ($panes | Where-Object { $_.pane_id -eq $PaneId })) { throw 'Pane not found' }
# Resolve the mux window by its current GUI title. Never guess when ambiguous.
& $wez cli --no-auto-start activate-pane --pane-id $PaneId | Out-Null
Start-Sleep -Milliseconds 300
$panes = (& $wez cli --no-auto-start list --format json | ConvertFrom-Json)
$target = $panes | Where-Object { $_.pane_id -eq $PaneId }
function Normalize-Title([string]$title) { return ($title -replace '^\[\d+/\d+\]\s*', '' -replace '^[\u2800-\u28ff]\s*', '').Trim() }
# The mux's explicit window title can remain set by another tab, while the
# default GUI renders the newly activated pane's title. Accept either exact
# normalized title, but require a single HWND across both candidates.
$titles = @($target.window_title, $target.title | ForEach-Object { Normalize-Title $_ } | Where-Object { $_ } | Select-Object -Unique)
if ($titles.Count -eq 0) { throw 'Cannot identify a window without a title' }
$expectedGuiId = $null
if ($env:WEZTERM_UNIX_SOCKET) {
 if ((Split-Path $env:WEZTERM_UNIX_SOCKET -Leaf) -notmatch '^gui-sock-(\d+)$') { throw 'Screenshot provider requires a local GUI endpoint' }
 $expectedGuiId = [int]$Matches[1]
}
# A single WezTerm process can own multiple GUI windows. MainWindowHandle only
# exposes one of them; enumerate HWNDs and retain exact, unique title matching.
$guiIds = @(Get-Process wezterm-gui | Where-Object { $null -eq $expectedGuiId -or $_.Id -eq $expectedGuiId } | ForEach-Object { $_.Id })
$windows = @([TermDadCapture]::Windows() | Where-Object { $guiIds -contains $_.ProcessId -and $titles -contains (Normalize-Title $_.Title) })
if ($windows.Count -ne 1) { throw 'Cannot uniquely match WezTerm window title to an HWND; assign distinct window titles or provide another screenshot provider' }
$hwnd = $windows[0].Handle
if ([TermDadCapture]::IsIconic($hwnd)) { [TermDadCapture]::ShowWindow($hwnd,9) | Out-Null; Start-Sleep -Milliseconds 400 }
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
