# Builds the Clocked release exe and compiles a distributable Setup.exe using
# Inno Setup. Output lands in installer\dist\clocked-setup-<version>.exe.
#
# Prerequisite (one-time): Inno Setup 6
#   winget install JRSoftware.InnoSetup

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$iss      = Join-Path $repoRoot 'installer\clocked.iss'
$cargoToml = Join-Path $repoRoot 'Cargo.toml'

# --- Locate ISCC (Inno Setup compiler) first, so we fail fast with guidance ---
$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
    $iscc = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $iscc) {
    throw "Inno Setup (ISCC.exe) not found. Install it with:  winget install JRSoftware.InnoSetup"
}

# --- Read version from Cargo.toml (first `version = "x.y.z"` under [package]) ---
$version = (Select-String -Path $cargoToml -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value
if (-not $version) { throw "Could not read version from $cargoToml" }
Write-Host "Version: $version" -ForegroundColor Cyan

# --- Resolve cargo (PATH or default rustup location) and build release ---
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

# --- Compile the installer ---
Write-Host 'Compiling installer...' -ForegroundColor Cyan
& $iscc "/DMyAppVersion=$version" $iss
if ($LASTEXITCODE -ne 0) { throw "ISCC failed (exit $LASTEXITCODE)" }

$out = Join-Path $repoRoot "installer\dist\clocked-setup-$version.exe"
Write-Host ''
Write-Host "Installer built: $out" -ForegroundColor Green
Write-Host 'Share that single file. Recipients double-click it to install Clocked.' -ForegroundColor Green
