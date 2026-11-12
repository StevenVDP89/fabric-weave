<#
.SYNOPSIS
  Builds the Fabric Weave deployment package: one ZIP you can hand to a customer or a colleague.

.DESCRIPTION
  Takes the committed files of this repository (git archive HEAD, so the same files as a release), adds
  deployment\package-info.json and, with -IncludeOfflineCache, an npm package cache so the install needs no access
  to the npm registry. Writes dist\fabric-weave-<version>[-offline].zip and a .sha256 file next to it.

  Commit your changes first: uncommitted work is not part of the package (the script stops when there is some,
  unless you pass -AllowDirty).

  The offline cache holds the packages for the platform you build on (for example win32-x64). Build the offline
  package on the same kind of machine the customer deploys from.

.PARAMETER OutputZipPath
  Where to write the ZIP. Default: dist\fabric-weave-<version>.zip (or ...-offline.zip).

.PARAMETER IncludeOfflineCache
  Bundle the npm packages the install needs (about 150 MB uncompressed) in offline-cache\npm-cache.

.PARAMETER AllowDirty
  Build even though the working tree has uncommitted changes. Those changes are NOT in the package.

.PARAMETER SkipVerify
  Skip the checks: that an offline install works from the bundled cache, and that the ZIP holds what it should.

.EXAMPLE
  .\deployment\Build-Package.ps1

.EXAMPLE
  .\deployment\Build-Package.ps1 -IncludeOfflineCache
#>
[CmdletBinding()]
param(
  [string]$OutputZipPath,
  [switch]$IncludeOfflineCache,
  [switch]$AllowDirty,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-Step([string]$Text) { Write-Host ""; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "   $Text" }

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkDir) {
  Push-Location -LiteralPath $WorkDir
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'$File $($Arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
}

function Get-Output([string]$File, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $File @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($out | Out-String).Trim()
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Remove-Tree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  } catch {
    # Deep node_modules paths can defeat Remove-Item on Windows PowerShell 5.1; cmd handles them.
    & cmd.exe /c "rmdir /s /q `"$Path`""
    if (Test-Path -LiteralPath $Path) { throw "could not delete $Path" }
  }
}

function Format-Size([long]$Bytes) {
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  return ('{0:N0} KB' -f ($Bytes / 1KB))
}

function Get-FolderSize([string]$Path) {
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
  if ($sum) { return [long]$sum }
  return [long]0
}

$stage = $null
try {
  Write-Host 'Fabric Weave package builder' -ForegroundColor Green

  Write-Step 'Checking the repository'
  $gitVersion = Get-Output 'git' @('--version')
  if (-not $gitVersion) { throw 'git was not found. Install Git for Windows.' }
  $insideRepo = Get-Output 'git' @('-C', $root, 'rev-parse', '--is-inside-work-tree')
  if ($insideRepo -ne 'true') { throw "$root is not a git repository. The package is built from the committed files, so build it from a clone." }

  $dirty = Get-Output 'git' @('-C', $root, 'status', '--porcelain')
  if ($dirty) {
    if (-not $AllowDirty) {
      throw "the working tree has uncommitted changes:`n$dirty`nThe package contains only what is committed. Commit (or stash) the changes, or pass -AllowDirty to build without them."
    }
    Write-Host '   WARNING: uncommitted changes are NOT in the package.' -ForegroundColor Yellow
  }

  $commit = Get-Output 'git' @('-C', $root, 'rev-parse', 'HEAD')
  $shortCommit = Get-Output 'git' @('-C', $root, 'rev-parse', '--short', 'HEAD')
  $baseYml = Join-Path $root 'app\rayfin\rayfin.base.yml'
  if (-not (Test-Path -LiteralPath $baseYml)) { throw "$baseYml is missing." }
  $versionMatch = [regex]::Match((Get-Content -LiteralPath $baseYml -Raw), '(?m)^version:\s*["'']?([0-9A-Za-z.+-]+)["'']?\s*$')
  if (-not $versionMatch.Success) { throw "no 'version:' line in $baseYml." }
  $version = $versionMatch.Groups[1].Value
  Write-Info "version $version, commit $shortCommit"

  $name = "fabric-weave-$version"
  $suffix = ''
  if ($IncludeOfflineCache) { $suffix = '-offline' }
  if (-not $OutputZipPath) { $OutputZipPath = Join-Path $root "dist\$name$suffix.zip" }
  $OutputZipPath = [IO.Path]::GetFullPath($OutputZipPath)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputZipPath) | Out-Null

  Write-Step 'Exporting the committed files'
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('fw-pkg-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $archive = Join-Path $stage 'source.zip'
  & git -C $root archive --format=zip "--prefix=$name/" -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed.' }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
  Remove-Item -LiteralPath $archive -Force
  $pkg = Join-Path $stage $name
  if (-not (Test-Path -LiteralPath (Join-Path $pkg 'install.mjs'))) { throw 'the export has no install.mjs; is HEAD the right commit?' }
  Write-Info "exported to $pkg"

  $offlineInfo = $null
  if ($IncludeOfflineCache) {
    Write-Step 'Building the offline package cache'
    $nodeVersion = Get-Output 'node' @('--version')
    $npmVersion = Get-Output 'npm' @('--version')
    if (-not $nodeVersion -or -not $npmVersion) { throw 'Node.js and npm are needed to build the offline cache.' }
    $platform = Get-Output 'node' @('-p', 'process.platform+''-''+process.arch')
    Write-Info "Node.js $nodeVersion, npm $npmVersion, platform $platform"

    $appDir = Join-Path $pkg 'app'
    $cache = Join-Path $pkg 'offline-cache\npm-cache'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null

    Write-Info 'downloading the packages from package-lock.json (npm ci, scripts off)'
    Invoke-Checked 'npm' @('ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', $cache) $appDir
    Remove-Tree (Join-Path $appDir 'node_modules')

    if (-not $SkipVerify) {
      Write-Info 'checking that the cache is complete (npm ci --offline)'
      Invoke-Checked 'npm' @('ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', $cache) $appDir
      Remove-Tree (Join-Path $appDir 'node_modules')
      Write-Info 'the cache is complete: a clean install worked without the internet'
    }
    Remove-Tree (Join-Path $cache '_logs')
    Get-ChildItem -LiteralPath $cache -File -Force | Remove-Item -Force
    Write-Info "cache size $(Format-Size (Get-FolderSize $cache))"

    $offlineInfo = [ordered]@{ platform = $platform; node = $nodeVersion; npm = $npmVersion }
  }

  Write-Step 'Writing package-info.json'
  $info = [ordered]@{
    product      = 'Fabric Weave'
    version      = $version
    commit       = $commit
    builtAtUtc   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    offlineCache = $offlineInfo
  }
  $infoJson = ($info | ConvertTo-Json -Depth 5) + "`n"
  [IO.File]::WriteAllText((Join-Path $pkg 'deployment\package-info.json'), $infoJson, (New-Object Text.UTF8Encoding($false)))

  Write-Step 'Creating the ZIP'
  if (Test-Path -LiteralPath $OutputZipPath) { Remove-Item -LiteralPath $OutputZipPath -Force }
  # CreateFromDirectory writes backslashes in entry names on Windows PowerShell 5.1, which breaks unzipping on macOS and Linux.
  $zipStream = [IO.File]::Open($OutputZipPath, [IO.FileMode]::Create)
  try {
    $archive = New-Object IO.Compression.ZipArchive($zipStream, [IO.Compression.ZipArchiveMode]::Create)
    try {
      $stageRoot = (Get-Item -LiteralPath $stage).FullName.TrimEnd('\') + '\'
      foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File -Force)) {
        $entryName = $file.FullName.Substring($stageRoot.Length).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal)
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $zipStream.Dispose()
  }
  $hash = (Get-FileHash -LiteralPath $OutputZipPath -Algorithm SHA256).Hash.ToLower()
  $hashFile = "$OutputZipPath.sha256"
  [IO.File]::WriteAllText($hashFile, "$hash  $(Split-Path -Leaf $OutputZipPath)`n", (New-Object Text.UTF8Encoding($false)))

  if (-not $SkipVerify) {
    Write-Step 'Checking the ZIP'
    $zip = [IO.Compression.ZipFile]::OpenRead($OutputZipPath)
    try {
      $entries = @($zip.Entries | ForEach-Object { $_.FullName })
    } finally {
      $zip.Dispose()
    }
    $required = @('install.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'deployment/Deploy.ps1', 'deployment/customer.config.example.json',
      'deployment/package-info.json', 'docs/DEPLOYMENT-GUIDE.md', 'app/package-lock.json', 'app/rayfin/rayfin.base.yml')
    foreach ($file in $required) {
      if ($entries -notcontains "$name/$file") { throw "the ZIP is missing $file" }
    }
    $backslashes = @($entries | Where-Object { $_ -like '*\*' })
    if ($backslashes.Count -gt 0) { throw "the ZIP has entries with backslashes (for example $($backslashes[0])); other platforms cannot unpack it" }
    $forbidden = @($entries | Where-Object { $_ -match '/(customer\.config\.json|last-deployment-result\.json|\.env|rayfin\.yml|\.deployments\.json)$' })
    if ($forbidden.Count -gt 0) { throw "the ZIP holds files that must not be shared: $($forbidden -join ', ')" }
    if ($IncludeOfflineCache -and -not ($entries | Where-Object { $_ -like "$name/offline-cache/npm-cache/_cacache/*" })) {
      throw 'the ZIP has no npm cache content'
    }
    Write-Info "$($entries.Count) entries, all required files present, no private files"
  }

  $size = (Get-Item -LiteralPath $OutputZipPath).Length
  Write-Host ""
  Write-Host 'Package ready' -ForegroundColor Green
  Write-Host "  ZIP:     $OutputZipPath ($(Format-Size $size))"
  Write-Host "  SHA256:  $hash"
  Write-Host "  Hash file: $hashFile"
  if ($IncludeOfflineCache) {
    Write-Host "  Offline cache for $($offlineInfo.platform): use it on the same platform (docs\DEPLOYMENT-GUIDE.md, 'Offline package')."
  }
} catch {
  Write-Host ""
  Write-Host "Build stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if ($stage) {
    try { Remove-Tree $stage } catch { Write-Host "   could not remove the temporary folder $stage" -ForegroundColor Yellow }
  }
}
