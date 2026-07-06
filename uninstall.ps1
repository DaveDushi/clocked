# Removes the clocked per-user install: Start-menu shortcut, installed exe, and
# the autostart Run key. Leaves user data in %APPDATA%\clocked untouched.

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Clocked'
$startMenu  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcut   = Join-Path $startMenu 'Clocked.lnk'
$runKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if (Test-Path $shortcut) {
    Remove-Item $shortcut -Force
    Write-Host "Removed shortcut: $shortcut" -ForegroundColor Green
} else {
    Write-Host "Shortcut not found: $shortcut"
}

if (Test-Path $installDir) {
    Remove-Item $installDir -Recurse -Force
    Write-Host "Removed install dir: $installDir" -ForegroundColor Green
} else {
    Write-Host "Install dir not found: $installDir"
}

# Mirror autostart::disable() - remove the "clocked" Run value if present.
$runValue = Get-ItemProperty -Path $runKey -Name 'clocked' -ErrorAction SilentlyContinue
if ($null -ne $runValue) {
    Remove-ItemProperty -Path $runKey -Name 'clocked'
    Write-Host 'Removed autostart entry (HKCU Run\clocked)' -ForegroundColor Green
} else {
    Write-Host 'No autostart entry to remove.'
}

$dataDir = Join-Path $env:APPDATA 'clocked'
Write-Host ''
Write-Host "Your data was left intact: $dataDir" -ForegroundColor Yellow
