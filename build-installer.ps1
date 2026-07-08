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

# Optional Authenticode signing. Set CLOCKED_SIGN_CERT to a PFX path (and
# CLOCKED_SIGN_PASSWORD if needed), or CLOCKED_SIGN_THUMBPRINT for a store cert.
if ($env:CLOCKED_SIGN_CERT -or $env:CLOCKED_SIGN_THUMBPRINT) {
    Write-Host 'Signing installer…' -ForegroundColor Cyan
    $signtool = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe",
        "${env:ProgramFiles}\Windows Kits\10\bin\*\x64\signtool.exe"
    ) | ForEach-Object { Get-Item $_ -ErrorAction SilentlyContinue } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $signtool) { throw 'signtool.exe not found. Install Windows SDK or unset CLOCKED_SIGN_*' }

    $signArgs = @('sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256')
    if ($env:CLOCKED_SIGN_THUMBPRINT) {
        $signArgs += @('/sha1', $env:CLOCKED_SIGN_THUMBPRINT)
    } else {
        $signArgs += @('/f', $env:CLOCKED_SIGN_CERT)
        if ($env:CLOCKED_SIGN_PASSWORD) { $signArgs += @('/p', $env:CLOCKED_SIGN_PASSWORD) }
    }
    $signArgs += $out
    & $signtool @signArgs
    if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)" }
    Write-Host 'Installer signed.' -ForegroundColor Green
} else {
    Write-Host 'Installer not signed (set CLOCKED_SIGN_CERT or CLOCKED_SIGN_THUMBPRINT for production).' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "Installer built: $out" -ForegroundColor Green
Write-Host 'Share that single file. Recipients double-click it to install Clocked.' -ForegroundColor Green
