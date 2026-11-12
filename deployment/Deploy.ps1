<#
.SYNOPSIS
  Installs Fabric Weave into a Fabric workspace, using the settings in deployment\customer.config.json.

.DESCRIPTION
  A thin Windows wrapper around install.mjs (docs\DEPLOYMENT-GUIDE.md explains everything it does). It:
    1. checks Node.js (20 to 24) and the Azure CLI,
    2. makes sure the Azure CLI is signed in to the tenant named in the config file (and signs in when it is not),
    3. uses the bundled offline-cache\npm-cache when the package has one,
    4. runs  node install.mjs --config <file> --result deployment\last-deployment-result.json,
    5. prints the app URL and what to do next.
  Run it again at any time: the installer updates what exists and leaves the rest alone.

.PARAMETER ConfigPath
  The settings file. Default: deployment\customer.config.json (copy customer.config.example.json and fill it in).

.PARAMETER Offline
  Install packages only from offline-cache\npm-cache and never from the internet. Without this switch the bundled cache
  is used first and the npm registry is the fallback. The package must have been built with -IncludeOfflineCache.

.PARAMETER NonInteractive
  Never prompt (no browser sign-in, no questions). Use this in pipelines; sign in with az login first.

.PARAMETER DryRun
  Show what would happen and change nothing.

.PARAMETER SkipPreflight
  Skip the installer's preflight checks (not recommended).

.EXAMPLE
  .\deployment\Deploy.ps1

.EXAMPLE
  .\deployment\Deploy.ps1 -DryRun

.EXAMPLE
  .\deployment\Deploy.ps1 -ConfigPath C:\secure\contoso.json -NonInteractive
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [switch]$Offline,
  [switch]$NonInteractive,
  [switch]$DryRun,
  [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$resultPath = Join-Path $here 'last-deployment-result.json'

function Write-Step([string]$Text) { Write-Host ""; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "   $Text" }
function Write-Warn([string]$Text) { Write-Host "   WARNING: $Text" -ForegroundColor Yellow }
function Stop-Deploy([string]$Text) { throw $Text }

# Runs a native command and returns its trimmed stdout, or $null when it failed. Never throws, never prints stderr.
function Invoke-Quiet([string]$File, [string[]]$Arguments) {
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

$savedEnv = @{}
$code = 1
try {
  Write-Host "Fabric Weave deployment" -ForegroundColor Green
  Write-Info "package folder: $root"
  if ($root.Length -gt 70) {
    Write-Warn "this folder path is long. Windows limits paths to 260 characters and node_modules goes deep. Unzip the package close to the drive root (for example C:\fabric-weave) if the install fails with ENOENT or path errors."
  }

  # 1. Tools
  Write-Step 'Checking tools'
  $nodeVersion = Invoke-Quiet 'node' @('--version')
  if (-not $nodeVersion) { Stop-Deploy 'Node.js was not found. Install Node.js 20, 22 or 24 (LTS) from https://nodejs.org and open a new PowerShell window.' }
  $nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
  if ($nodeMajor -lt 20 -or $nodeMajor -gt 24) { Stop-Deploy "Node.js $nodeVersion is not supported. Use Node.js 20, 22 or 24 (LTS)." }
  Write-Info "Node.js $nodeVersion"

  $azJson = Invoke-Quiet 'az' @('version', '-o', 'json')
  $azVersion = $null
  if ($azJson) { try { $azVersion = ($azJson | ConvertFrom-Json).'azure-cli' } catch { $azVersion = $null } }
  if (-not $azVersion) { Stop-Deploy 'The Azure CLI (az) was not found. Install it from https://aka.ms/installazurecliwindows and open a new PowerShell window.' }
  Write-Info "Azure CLI $azVersion"

  # 2. Config
  Write-Step 'Reading the settings file'
  if (-not $ConfigPath) { $ConfigPath = Join-Path $here 'customer.config.json' }
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Stop-Deploy "$ConfigPath does not exist. Copy deployment\customer.config.example.json to deployment\customer.config.json, fill it in and run this script again."
  }
  $ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Stop-Deploy "$ConfigPath is not valid JSON: $($_.Exception.Message)"
  }
  Write-Info "config: $ConfigPath"

  $tenantId = ''
  if ($config.PSObject.Properties.Name -contains 'tenantId' -and $config.tenantId) { $tenantId = ([string]$config.tenantId).Trim() }
  if ($tenantId -match '[<>]') { Stop-Deploy "tenantId in $ConfigPath still has the example placeholder. Put your Entra tenant id there." }
  if ($tenantId -match '^0{8}-0{4}-0{4}-0{4}-0{12}$') { $tenantId = '' }

  # 3. Sign-in
  Write-Step 'Azure sign-in'
  $currentTenant = Invoke-Quiet 'az' @('account', 'show', '--query', 'tenantId', '-o', 'tsv')
  $sameTenant = $currentTenant -and ((-not $tenantId) -or ($currentTenant -ieq $tenantId))
  if (-not $sameTenant) {
    if ($NonInteractive) {
      if ($currentTenant) { Stop-Deploy "the Azure CLI is signed in to tenant $currentTenant, but the config says $tenantId. Run: az login --tenant $tenantId" }
      Stop-Deploy 'the Azure CLI is not signed in. Run: az login --tenant <your tenant id>'
    }
    if ($tenantId) {
      Write-Info "signing in to tenant $tenantId (a browser window opens)"
      & az login --tenant $tenantId --only-show-errors | Out-Null
    } else {
      Write-Info 'signing in (a browser window opens)'
      & az login --only-show-errors | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { Stop-Deploy 'az login did not finish. Run it again.' }
    $currentTenant = Invoke-Quiet 'az' @('account', 'show', '--query', 'tenantId', '-o', 'tsv')
  }
  $account = Invoke-Quiet 'az' @('account', 'show', '--query', 'user.name', '-o', 'tsv')
  Write-Info "signed in as $account (tenant $currentTenant)"

  # 4. Offline cache
  $cache = Join-Path $root 'offline-cache\npm-cache'
  $infoPath = Join-Path $here 'package-info.json'
  if ($Offline -and -not (Test-Path -LiteralPath $cache)) {
    Stop-Deploy "-Offline needs $cache, which is not in this package. Build the package with deployment\Build-Package.ps1 -IncludeOfflineCache, or leave out -Offline."
  }
  if (Test-Path -LiteralPath $cache) {
    Write-Step 'Offline package cache'
    $hostPlatform = Invoke-Quiet 'node' @('-p', 'process.platform+''-''+process.arch')
    if ((Test-Path -LiteralPath $infoPath) -and $hostPlatform) {
      try {
        $pkgInfo = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pkgInfo.offlineCache -and $pkgInfo.offlineCache.platform -and $pkgInfo.offlineCache.platform -ne $hostPlatform) {
          Write-Warn "the cache was built for $($pkgInfo.offlineCache.platform) and this machine is $hostPlatform. Packages with native parts will come from the internet instead."
          if ($Offline) { Stop-Deploy 'the offline cache does not match this machine, so -Offline cannot work. Rebuild the package on this platform, or leave out -Offline.' }
        }
      } catch {
        Write-Info 'package-info.json could not be read; continuing'
      }
    }
    foreach ($name in @('npm_config_cache', 'npm_config_prefer_offline', 'npm_config_offline')) {
      $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $env:npm_config_cache = $cache
    $env:npm_config_prefer_offline = 'true'
    if ($Offline) { $env:npm_config_offline = 'true' }
    Write-Info "using $cache$(if ($Offline) { ' (offline: the internet is not used for packages)' } else { ' first, the npm registry as a fallback' })"
  }

  # 5. Install
  Write-Step 'Installing'
  if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
  $installArgs = @((Join-Path $root 'install.mjs'), '--config', $ConfigPath, '--result', $resultPath)
  if ($DryRun) { $installArgs += '--dry-run' }
  if ($NonInteractive) { $installArgs += '--non-interactive' }
  if ($SkipPreflight) { $installArgs += '--skip-preflight' }

  Push-Location -LiteralPath $root
  try {
    & node @installArgs
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  # 6. Outcome
  if ($code -ne 0) {
    Write-Host ""
    Write-Host "The install stopped (exit code $code). The message above says why; docs\DEPLOYMENT-GUIDE.md, section 'Troubleshooting', lists the usual causes. It is safe to run this script again." -ForegroundColor Red
  } elseif ($DryRun) {
    Write-Host ""
    Write-Host 'Dry run finished. Nothing was changed.' -ForegroundColor Green
  } elseif (Test-Path -LiteralPath $resultPath) {
    $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ""
    Write-Host "Fabric Weave $($result.version) is installed ($($result.mode))." -ForegroundColor Green
    if ($result.app.url) { Write-Host "  App:        $($result.app.url)" }
    Write-Host "  Workspace:  $($result.workspace.url)"
    Write-Host "  Details:    $resultPath"
    Write-Host ""
    Write-Host 'Next (see docs\DEPLOYMENT-GUIDE.md, "After the install"):'
    Write-Host '  1. Give the app access to the workspaces people want to scan (workspace > Manage access > add the app).'
    if ($result.aiModel) { Write-Host '  2. Give the app the "Cognitive Services OpenAI User" role on your Azure OpenAI resource.' }
    Write-Host '  3. Open the app, sign in and check the Status page.'
  } else {
    Write-Warn 'the install reported success but wrote no result file.'
  }
} catch {
  Write-Host ""
  Write-Host "Deployment stopped: $($_.Exception.Message)" -ForegroundColor Red
  $code = 1
} finally {
  foreach ($name in $savedEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
  }
}
exit $code
