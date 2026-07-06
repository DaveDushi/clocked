# Installs clocked as a per-user Windows app so it shows up in Start-menu search.
# No admin required: the exe goes under %LOCALAPPDATA%\Programs and the Start-menu
# shortcut goes under the current user's Start Menu.

$ErrorActionPreference = 'Stop'

$repoRoot   = $PSScriptRoot
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Clocked'
$exeSrc     = Join-Path $repoRoot 'target\release\clocked.exe'
$exeDst     = Join-Path $installDir 'clocked.exe'
$startMenu  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcut   = Join-Path $startMenu 'Clocked.lnk'

# Resolve cargo from PATH, or fall back to the default rustup install location.
$cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargo) {
    $fallback = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path $fallback) { $cargo = $fallback }
}
if (-not $cargo) { throw 'cargo not found on PATH or in ~/.cargo/bin. Install Rust from https://rustup.rs' }

Write-Host 'Building release...' -ForegroundColor Cyan
Push-Location $repoRoot
try {
    & $cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

if (-not (Test-Path $exeSrc)) { throw "Built exe not found at $exeSrc" }

Write-Host "Installing to $installDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Path $exeSrc -Destination $exeDst -Force

Write-Host 'Creating Start-menu shortcut...' -ForegroundColor Cyan
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath       = $exeDst
$lnk.WorkingDirectory = $installDir
$lnk.IconLocation     = $exeDst
$lnk.Description       = 'Clocked time tracker'
$lnk.Save()

Write-Host ''
Write-Host "Installed: $exeDst" -ForegroundColor Green
Write-Host "Shortcut:  $shortcut" -ForegroundColor Green
Write-Host 'Press Start and search "Clocked" to launch it.' -ForegroundColor Green
