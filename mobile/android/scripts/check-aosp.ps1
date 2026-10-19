$ErrorActionPreference = 'Stop'
$androidRoot = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $androidRoot '.tools/aosp'
New-Item -ItemType Directory -Force $destination | Out-Null
$sources = @(
    @('android14-release', 'UserUsageStatsService'),
    @('android14-release', 'UsageStatsService'),
    @('android14-release', 'UsageStatsDatabase'),
    @('android14-release', 'UsageStatsProtoV2'),
    @('android15-release', 'UserUsageStatsService'),
    @('android16-release', 'UserUsageStatsService')
)
foreach ($entry in $sources) {
    $branch, $sourceName = $entry
    $url = "https://android.googlesource.com/platform/frameworks/base/+/refs/heads/$branch/services/usage/java/com/android/server/usage/$sourceName.java?format=TEXT"
    $encoded = & curl.exe -sSfL --retry 2 $url
    if ($LASTEXITCODE -ne 0) { throw "AOSP download failed: $url" }
    $path = Join-Path $destination "$branch-$sourceName.java"
    [IO.File]::WriteAllText($path, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($encoded -join ''))))
    Get-FileHash -Algorithm SHA256 -LiteralPath $path | Select-Object Hash, Path
    Select-String -LiteralPath $path -Pattern 'new Event\(DEVICE_STARTUP|Math.max\(currentDailyStats.lastTimeSaved|TIME_CHANGE_THRESHOLD_MILLIS =|persist.debug.time_correction|onTimeChanged\(expectedSystemTime|mDatabase.onTimeChanged|newTime = files.keyAt|event.mTimeStamp = beginTime|writeOffsetTimestamp\(proto, EventObfuscatedProto.TIME_MS|initializeUserUsageStatsServiceLocked\(userId, System.currentTimeMillis|reportEvent\(pendingEvents.poll' |
        ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
}
