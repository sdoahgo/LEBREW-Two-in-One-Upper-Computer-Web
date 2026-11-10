[CmdletBinding()]
param([switch]$SkipDependencyInstall)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$venvRoot = Join-Path $projectRoot '.venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$buildRoot = Join-Path $projectRoot 'build'
$packageRoot = Join-Path $buildRoot 'package'
$candidateDirectory = Join-Path $packageRoot 'AwCalibrator'
$candidateExe = Join-Path $candidateDirectory 'AwCalibrator.exe'
$latestDirectory = Join-Path $projectRoot 'releases\latest'
$builtExe = Join-Path $latestDirectory 'AwCalibrator.exe'
$previousPyCache = [Environment]::GetEnvironmentVariable('PYTHONPYCACHEPREFIX', 'Process')

function Assert-ProjectPath {
    param([string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($projectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing file operation outside this project: $resolved"
    }
}

function New-ArchivePath {
    param([string]$Parent, [string]$Prefix)
    $leaf = $Prefix + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $path = Join-Path $Parent $leaf
    Assert-ProjectPath $path
    if (-not (Test-Path -LiteralPath $Parent)) {
        New-Item -ItemType Directory -Path $Parent | Out-Null
    }
    return $path
}

function Invoke-SmokeTest {
    param([string]$Exe)
    $process = Start-Process -FilePath $Exe -ArgumentList @('--simulate', '--smoke-test') -WorkingDirectory (Split-Path -Parent $Exe) -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(30000)) {
        throw "Simulation smoke test did not finish; process ID: $($process.Id)"
    }
    if ($process.ExitCode -ne 0) {
        throw "Simulation smoke test failed: exit $($process.ExitCode)"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

Push-Location $projectRoot
try {
    foreach ($path in @($buildRoot, $packageRoot, $candidateDirectory, $latestDirectory)) {
        Assert-ProjectPath $path
    }
    $running = Get-Process -Name AwCalibrator -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $builtExe -or $_.Path -eq $candidateExe
    }
    if ($running) {
        throw 'Please export any needed session data and close the calibrator before building.'
    }
    $env:PYTHONPYCACHEPREFIX = Join-Path $buildRoot 'cache\python'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        $bootstrapPython = (Get-Command python -ErrorAction Stop).Source
        Invoke-Checked $bootstrapPython @('-m', 'venv', $venvRoot)
    }

    if (-not $SkipDependencyInstall) {
        Invoke-Checked $venvPython @(
            '-m', 'pip', 'install', '--disable-pip-version-check',
            '-r', (Join-Path $projectRoot 'requirements-build.txt')
        )
    }
    Invoke-Checked $venvPython @('-m', 'unittest', 'discover', '-s', 'tests', '-v')
    if (Test-Path -LiteralPath $candidateDirectory) {
        $savedPackage = New-ArchivePath (Join-Path $buildRoot 'archive') 'previous-package'
        Move-Item -LiteralPath $candidateDirectory -Destination $savedPackage
    }
    Invoke-Checked $venvPython @(
        '-m', 'PyInstaller', '--clean', '--noconfirm',
        '--distpath', $packageRoot,
        '--workpath', (Join-Path $buildRoot 'work'),
        'AwCalibrator.spec'
    )

    if (-not (Test-Path -LiteralPath $candidateExe)) {
        throw "Expected executable was not created: $candidateExe"
    }
    Invoke-SmokeTest $candidateExe
    $savedLatest = $null
    if (Test-Path -LiteralPath $latestDirectory) {
        $savedLatest = New-ArchivePath (Join-Path $projectRoot 'releases\archive') 'previous-latest'
        Move-Item -LiteralPath $latestDirectory -Destination $savedLatest
    }
    try {
        Move-Item -LiteralPath $candidateDirectory -Destination $latestDirectory
        if ($savedLatest -and (Test-Path -LiteralPath (Join-Path $savedLatest 'exports'))) {
            Copy-Item -LiteralPath (Join-Path $savedLatest 'exports') -Destination (Join-Path $latestDirectory 'exports') -Recurse
        }
    }
    catch {
        if (Test-Path -LiteralPath $latestDirectory) {
            $failedPackage = New-ArchivePath (Join-Path $buildRoot 'archive') 'failed-publish'
            Move-Item -LiteralPath $latestDirectory -Destination $failedPackage
        }
        if ($savedLatest) {
            Move-Item -LiteralPath $savedLatest -Destination $latestDirectory
        }
        throw
    }
    $shell = New-Object -ComObject WScript.Shell
    # Keep the script ASCII-compatible with Windows PowerShell 5.1's default encoding.
    $shortcutName = -join ([char[]]@(0x542F, 0x52A8, 0x6C34, 0x6D3B, 0x4E0A, 0x4F4D, 0x673A))
    $shortcut = $shell.CreateShortcut((Join-Path $projectRoot ($shortcutName + '.lnk')))
    $shortcut.TargetPath = $builtExe
    $shortcut.WorkingDirectory = $latestDirectory
    $shortcut.IconLocation = $builtExe + ',0'
    $shortcut.Description = $shortcutName
    $shortcut.Save()
    Write-Host "BUILD_OK: $builtExe"
}
finally {
    if ($null -eq $previousPyCache) {
        Remove-Item -LiteralPath 'Env:PYTHONPYCACHEPREFIX' -ErrorAction SilentlyContinue
    }
    else {
        $env:PYTHONPYCACHEPREFIX = $previousPyCache
    }
    Pop-Location
}
