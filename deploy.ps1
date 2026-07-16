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
    $extensionZip = Join-Path $repoRoot 'extension\clocked-chrome.zip'
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

    Write-Host 'Packing Chrome extension...' -ForegroundColor Cyan
    $extSrc = Join-Path $repoRoot 'extension\chrome'
    $extStage = Join-Path $repoRoot 'extension\_pack_stage'
    if (Test-Path $extStage) { Remove-Item $extStage -Recurse -Force }
    New-Item -ItemType Directory -Path $extStage | Out-Null
    Copy-Item (Join-Path $extSrc 'manifest.json'),
        (Join-Path $extSrc 'background.js'),
        (Join-Path $extSrc 'options.html'),
        (Join-Path $extSrc 'options.js'),
        (Join-Path $extSrc 'popup.html'),
        (Join-Path $extSrc 'popup.js') -Destination $extStage
    Copy-Item (Join-Path $extSrc 'icons') -Destination (Join-Path $extStage 'icons') -Recurse
    if (Test-Path $extensionZip) { Remove-Item $extensionZip -Force }
    Compress-Archive -Path (Join-Path $extStage '*') -DestinationPath $extensionZip -Force
    Remove-Item $extStage -Recurse -Force
    if (-not (Test-Path $extensionZip)) {
        throw "Extension zip was not created: $extensionZip"
    }

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
    } else {
        $tagCommit = (& git rev-list -n 1 $tag).Trim()
        $headCommit = (& git rev-parse HEAD).Trim()
        if ($tagCommit -ne $headCommit) {
            throw "Tag $tag already points at $tagCommit, but HEAD is $headCommit. Move/delete the tag intentionally before deploying."
        }
    }
    Run-Native git @('push', 'origin', $tag)

    Write-Host "Publishing GitHub Release $tag..." -ForegroundColor Cyan
    $releaseExists = $false
    try {
        & $gh release view $tag --repo $Repo *> $null
        $releaseExists = $LASTEXITCODE -eq 0
    } catch {
        $releaseExists = $false
    }
    if ($releaseExists) {
        $uploadArgs = @('release', 'upload', $tag, $installer, $stableInstaller, $extensionZip, '--repo', $Repo, '--clobber')
        Run-Native $gh $uploadArgs
    } else {
        $createArgs = @(
            'release', 'create', $tag, $installer, $stableInstaller, $extensionZip,
            '--repo', $Repo, '--title', "clocked $tag", '--notes', "Release $tag"
        )
        Run-Native $gh $createArgs
    }

    Write-Host ''
    Write-Host "Deploy complete: https://github.com/$Repo/releases/tag/$tag" -ForegroundColor Green
    Write-Host "Installer: $installer" -ForegroundColor Green
    Write-Host "Extension: $extensionZip" -ForegroundColor Green
} finally {
    Pop-Location
}
