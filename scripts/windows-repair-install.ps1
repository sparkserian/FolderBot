<#
.SYNOPSIS
Removes a stuck FolderBot installation so a new build can install cleanly.

.DESCRIPTION
Versions up to 1.0.21 shipped an uninstaller whose custom hook called
nsExec::ExecToLog without popping the return value off the NSIS stack. When
FolderBot is not running, taskkill exits with 128 rather than 0, the stray value
corrupts argument parsing in the uninstaller's init, and the uninstaller exits
non-zero.

A new installer runs the OLD uninstaller to remove the previous version, retries
five times, then reports "FolderBot cannot be closed. Please close it manually
and then click Retry", followed by "Failed to uninstall all the application
files". The message names the wrong cause: any non-zero exit produces it.

Because the broken uninstaller is the one already on disk, no new installer can
fix it. This script removes the old installation directly, then the installer
sees no previous version and performs a clean install.

Settings, credentials, and history live in %APPDATA%\FolderBot and are never
touched.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\windows-repair-install.ps1
#>

[CmdletBinding()]
param(
    [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "  $Message" }

Write-Host ''
Write-Host 'FolderBot install repair' -ForegroundColor Cyan
Write-Host ''

$userDataPath = Join-Path $env:APPDATA 'FolderBot'
Write-Host "Settings kept at: $userDataPath"
Write-Host ''

# 1. Close the app if it is running, including a background tray instance.
Write-Host 'Closing FolderBot'
$running = Get-Process -Name 'FolderBot' -ErrorAction SilentlyContinue
if ($running) {
    if (-not $WhatIfOnly) { $running | Stop-Process -Force }
    Write-Step "Stopped $($running.Count) process(es)"
    Start-Sleep -Seconds 2
}
else {
    Write-Step 'Not running'
}

# 2. Remove the stale uninstall entries. This is what makes a new installer try
#    to run the broken uninstaller, so it has to go.
Write-Host ''
Write-Host 'Removing stale uninstall entries'
$uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

$removedEntries = 0
foreach ($root in $uninstallRoots) {
    if (-not (Test-Path $root)) { continue }

    Get-ChildItem -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
        $properties = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
        if ($properties.DisplayName -ne 'FolderBot') { return }

        Write-Step "$root\$($_.PSChildName)"
        if (-not $WhatIfOnly) {
            try { Remove-Item -Path $_.PSPath -Recurse -Force }
            catch { Write-Step "  could not remove (run as administrator): $($_.Exception.Message)" }
        }
        $script:removedEntries++
    }
}

if ($removedEntries -eq 0) { Write-Step 'None found' }

# 3. Remove the program files themselves.
Write-Host ''
Write-Host 'Removing program files'
# Join-Path throws on a null root, and ProgramFiles(x86) is absent on some machines.
$installCandidates = @(
    @{ Root = $env:LOCALAPPDATA;          Leaf = 'Programs\FolderBot' },
    @{ Root = $env:ProgramFiles;          Leaf = 'FolderBot' },
    @{ Root = ${env:ProgramFiles(x86)};   Leaf = 'FolderBot' }
)

$installPaths = @()
foreach ($candidate in $installCandidates) {
    if (-not $candidate.Root) { continue }
    $path = Join-Path $candidate.Root $candidate.Leaf
    if (Test-Path $path) { $installPaths += $path }
}

if ($installPaths) {
    foreach ($path in $installPaths) {
        Write-Step $path
        if (-not $WhatIfOnly) {
            try { Remove-Item -Path $path -Recurse -Force }
            catch { Write-Step "  could not remove: $($_.Exception.Message)" }
        }
    }
}
else {
    Write-Step 'None found'
}

# 4. Drop the launch-at-login entry. The new install recreates it from settings.
Write-Host ''
Write-Host 'Removing launch-at-login entries'
$runKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
)

$removedRun = 0
foreach ($key in $runKeys) {
    if (-not (Test-Path $key)) { continue }

    foreach ($name in @('FolderBot', 'folderbot')) {
        $existing = Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
        if (-not $existing) { continue }

        Write-Step "$key\$name"
        if (-not $WhatIfOnly) {
            try { Remove-ItemProperty -Path $key -Name $name -Force }
            catch { Write-Step "  could not remove: $($_.Exception.Message)" }
        }
        $script:removedRun++
    }
}

if ($removedRun -eq 0) { Write-Step 'None found' }

Write-Host ''
if ($WhatIfOnly) {
    Write-Host 'Nothing was changed. Re-run without -WhatIfOnly to apply.' -ForegroundColor Yellow
}
else {
    Write-Host 'Done. Run "FolderBot Setup 1.0.22.exe" now.' -ForegroundColor Green
    Write-Host "Your credentials and history are still in $userDataPath"
}
Write-Host ''
