# MinimalTube installer for Windows (install-windows.cmd in the folder above starts it; run that one).
#
# It gets MinimalTube's own Python, a standalone CPython build (python-build-standalone) kept in
# %LOCALAPPDATA%\MinimalTube\python, and runs install.py with it, which does the rest: the server's
# packages and its own yt-dlp, ffmpeg and deno, the native host the extension starts the server
# through (per-user registry keys), and MinimalTube in the Start menu.
# No step needs admin rights, nothing is installed system-wide and PATH isn't changed.
#
# The extension ID follows from the "key" in manifest.json; a copy without that key passes its
# ID: install-windows.cmd <id>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$AppDir = Join-Path $env:LOCALAPPDATA 'MinimalTube'
$Python = Join-Path $AppDir 'python\python.exe'
$Release = 'https://github.com/astral-sh/python-build-standalone/releases'
# used when GitHub can't be asked for the newest build
$PbsTag = '20261026'
$PbsPython = '3.13.18'
$Headers = @{ 'User-Agent' = 'MinimalTube-installer' }

function Get-OwnPython {
    $cpu = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
    $triple = "$cpu-pc-windows-msvc"
    Write-Host "Getting MinimalTube's own Python (about 30 MB, once)..."
    $name = $null
    $url = $null
    $sumsUrl = $null
    try {
        $latest = Invoke-RestMethod -Uri 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest' -Headers $Headers
        $asset = $latest.assets | Where-Object { $_.name -match "^cpython-3\.13\.\d+\+\d+-$triple-install_only\.tar\.gz$" } | Select-Object -First 1
        $sums = $latest.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
        if ($asset) {
            $name = $asset.name
            $url = $asset.browser_download_url
            if ($sums) { $sumsUrl = $sums.browser_download_url }
        }
    } catch {
        Write-Host "  (couldn't ask GitHub for the newest build: $($_.Exception.Message))"
    }
    if (-not $url) {
        $name = "cpython-$PbsPython+$PbsTag-$triple-install_only.tar.gz"
        $url = "$Release/download/$PbsTag/" + $name.Replace('+', '%2B')
        $sumsUrl = "$Release/download/$PbsTag/SHA256SUMS"
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('minimaltube-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $archive = Join-Path $tmp 'python.tar.gz'
        Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -Headers $Headers
        # the release lists every file's SHA-256: the download has to match it
        $sumsFile = Join-Path $tmp 'SHA256SUMS'
        $haveSums = $false
        if ($sumsUrl) {
            try {
                Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsFile -UseBasicParsing -Headers $Headers
                $haveSums = $true
            } catch {}
        }
        if ($haveSums) {
            $want = ''
            foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
                $parts = $line.Trim() -split '\s+'
                if ($parts.Count -eq 2 -and $parts[1] -eq $name) { $want = $parts[0].ToLower() }
            }
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLower()
            if ($want -ne $got) { throw "the Python download doesn't match its published checksum" }
        } else {
            Write-Warning "couldn't get the checksums to verify the Python download"
        }
        # Windows 10 and 11 come with tar. It reads its arguments in the system code page, so it gets
        # no paths at all (a user name in another alphabet would be garbled): it runs inside $tmp.
        Push-Location -LiteralPath $tmp
        try { & tar.exe -xzf 'python.tar.gz' } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "couldn't unpack the Python download (tar.exe failed)" }
        New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        $target = Join-Path $AppDir 'python'
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $tmp 'python') -Destination $target
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    $usable = $false
    if (Test-Path -LiteralPath $Python) {
        # PowerShell 5.1 turns a program's stderr into errors when it's redirected: not here
        $ErrorActionPreference = 'Continue'
        & $Python -c 'import sys' *> $null
        $usable = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = 'Stop'
    }
    if (-not $usable) { Get-OwnPython }
    & $Python -X utf8 -B (Join-Path $PSScriptRoot 'install.py') @args
    exit $LASTEXITCODE
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
