# Builds and publishes a Clocked desktop release from this machine.
#
# What it does:
#   1. verifies the working tree is clean
#   2. runs cargo test
#   3. builds installer\dist\clocked-setup-<version>.exe
#   4. pushes the current branch
#   5. creates/pushes tag v<version> if needed
#   6. creates/updates the GitHub Release and uploads the installer

[CmdletBinding()]
param(
    [string]$Repo = 'DaveDushi/clocked',
    [switch]$SkipTests,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Host @"
Usage:
  .\deploy.ps1
  .\deploy.ps1 -SkipTests

Before running:
  - Commit your changes.
  - Bump Cargo.toml's version when you want users to see a new update.

This script publishes version v<version from Cargo.toml> to GitHub repo $Repo.
"@
    exit 0
}

$repoRoot = $PSScriptRoot
$cargoToml = Join-Path $repoRoot 'Cargo.toml'

function Run-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$CommandArgs = @()
    )

    & $File @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$File $($CommandArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Find-Cargo {
    $cargo = (Get-Command cargo.exe -ErrorAction SilentlyContinue).Source
    if ($cargo) { return $cargo }

    $fallback = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path $fallback) { return $fallback }

    throw 'cargo not found on PATH or in ~/.cargo/bin. Install Rust from https://rustup.rs'
}

function Find-GitHubCli {
    $candidates = @(
        (Join-Path $env:APPDATA 'com.jean.desktop\gh-cli\gh.exe'),
        (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    throw 'GitHub CLI (gh.exe) not found. Install it or run this from Jean.'
}

Push-Location $repoRoot
try {
    $version = (Select-String -Path $cargoToml -Pattern '^\s*version\s*=\s*"([^"]+)"' |
        Select-Object -First 1).Matches.Groups[1].Value
    if (-not $version) { throw "Could not read version from $cargoToml" }

    $tag = "v$version"
    $installer = Join-Path $repoRoot "installer\dist\clocked-setup-$version.exe"
    $stableInstaller = Join-Path $repoRoot 'installer\dist\clocked-setup.exe'
    $cargo = Find-Cargo
    $gh = Find-GitHubCli

    Write-Host "Deploying clocked $tag" -ForegroundColor Cyan

    $branch = (& git branch --show-current).Trim()
    if (-not $branch) {
        throw 'Not on a branch. Check out a branch before deploying.'
    }

    $dirty = & git status --porcelain
    if ($dirty) {
        throw "Working tree has uncommitted changes. Commit or stash them before deploying.`n$($dirty -join "`n")"
    }

    if (-not $SkipTests) {
        Write-Host 'Running tests...' -ForegroundColor Cyan
        Run-Native $cargo @('test')
    }

    Write-Host 'Building installer...' -ForegroundColor Cyan
    & (Join-Path $repoRoot 'build-installer.ps1')
    if (-not (Test-Path $installer)) {
        throw "Installer was not created: $installer"
    }
    Copy-Item -LiteralPath $installer -Destination $stableInstaller -Force

    $dirtyAfterBuild = & git status --porcelain
    if ($dirtyAfterBuild) {
        throw "Build/test changed the working tree. Commit these changes, then rerun deploy.`n$($dirtyAfterBuild -join "`n")"
    }

    Write-Host "Pushing branch $branch..." -ForegroundColor Cyan
    Run-Native git @('push', '-u', 'origin', $branch)

    Write-Host 'Syncing tags...' -ForegroundColor Cyan
    Run-Native git @('fetch', '--tags', 'origin')
    $existingTag = & git tag --list $tag | Select-Object -First 1
    if (-not $existingTag) {
        Run-Native git @('tag', '-a', $tag, '-m', "clocked $tag")
    }
    Run-Native git @('push', 'origin', $tag)

    Write-Host "Publishing GitHub Release $tag..." -ForegroundColor Cyan
    & $gh release view $tag --repo $Repo *> $null
    if ($LASTEXITCODE -eq 0) {
        Run-Native $gh @('release', 'upload', $tag, $installer, $stableInstaller, '--repo', $Repo, '--clobber')
    } else {
        Run-Native $gh @('release', 'create', $tag, $installer, $stableInstaller, '--repo', $Repo, '--title', "clocked $tag", '--notes', "Release $tag")
    }

    Write-Host ''
    Write-Host "Deploy complete: https://github.com/$Repo/releases/tag/$tag" -ForegroundColor Green
    Write-Host "Installer: $installer" -ForegroundColor Green
} finally {
    Pop-Location
}
