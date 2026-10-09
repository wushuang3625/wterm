[CmdletBinding()]
param(
    [string]$InstallationDirectory = $PSScriptRoot,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
# NSIS is a 32-bit process even for x64/ARM64 installers. Re-enter native
# PowerShell so Appx deployment and registry queries use the OS architecture.
if ([Environment]::Is64BitOperatingSystem -and ![Environment]::Is64BitProcess) {
    $nativePowerShell = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-InstallationDirectory', $InstallationDirectory)
    if ($Remove) { $arguments += '-Remove' }
    & $nativePowerShell @arguments
    exit $LASTEXITCODE
}
$identity = 'dev.wterm.Explorer'
if ($Remove) {
    Get-AppxPackage -Name $identity | Remove-AppxPackage
    Write-Output 'wterm Explorer integration removed for the current user.'
    exit 0
}
$installation = (Resolve-Path -LiteralPath $InstallationDirectory).Path
foreach ($file in @('wterm.exe', 'wterm_shell.dll', 'AppxManifest.xml')) {
    if (!(Test-Path -LiteralPath (Join-Path $installation $file) -PathType Leaf)) {
        throw "Missing integration file: $file in $installation"
    }
}
$package = Join-Path $installation 'wterm-explorer.msix'
function Test-SignedIdentityPackage([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try { return $null -ne $archive.GetEntry('AppxSignature.p7x') } finally { $archive.Dispose() }
}
$signed = Test-SignedIdentityPackage $package
if (!$signed) {
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $registry.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock')
        try { $developerMode = if ($key) { $key.GetValue('AllowDevelopmentWithoutDevLicense', 0) } else { 0 } }
        finally { if ($key) { $key.Dispose() } }
    } finally { $registry.Dispose() }
    if ($developerMode -ne 1) {
        throw 'Windows 11 Explorer integration needs a trusted signed wterm-explorer.msix. Developer Mode is not enabled; no security settings were changed.'
    }
}
function Register-CurrentIdentity {
    if ($signed) {
        # Windows verifies the signer and trust chain; never import certificates here.
        Add-AppxPackage -Path $package -ExternalLocation $installation
    } else {
        Add-AppxPackage -Register (Join-Path $installation 'AppxManifest.xml') -ExternalLocation $installation
    }
}
# A sparse package cannot be registered with a different external location.
# Move only our current-user identity, retaining loose-package app data and a
# working registration source for rollback. The external application is kept.
$previous = Get-AppxPackage -Name $identity
$migrating = $false
if ($previous) {
    $manager = New-Object Windows.Management.Deployment.PackageManager
    $nativePackage = $manager.FindPackageForUser('', $previous.PackageFullName)
    $previousExternal = $nativePackage.EffectiveExternalLocation.Path
    if (!$previousExternal) { throw 'Existing wterm identity has no external location; automatic relocation was skipped.' }
    $migrating = ![string]::Equals($previousExternal.TrimEnd('\'), $installation.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    if ($migrating) {
        $previousManifest = Join-Path $previous.InstallLocation 'AppxManifest.xml'
        $previousPackage = Join-Path $previousExternal 'wterm-explorer.msix'
        if ($previous.IsDevelopmentMode) {
            if (!(Test-Path -LiteralPath $previousManifest -PathType Leaf)) { throw 'Previous identity manifest is missing; relocation was skipped to retain the existing registration.' }
        } elseif (!(Test-SignedIdentityPackage $previousPackage)) {
            throw 'Previous signed identity package is missing; relocation was skipped to retain the existing registration.'
        }
        Write-Output "Moving wterm Explorer identity: $previousExternal -> $installation"
        Remove-AppxPackage -Package $previous.PackageFullName -PreserveApplicationData:$previous.IsDevelopmentMode
    }
}
try { Register-CurrentIdentity }
catch {
    $registrationFailure = $_
    if ($migrating) {
        try {
            if ($previous.IsDevelopmentMode) { Add-AppxPackage -Register $previousManifest -ExternalLocation $previousExternal }
            else { Add-AppxPackage -Path $previousPackage -ExternalLocation $previousExternal }
            Write-Warning 'New registration failed; the previous wterm Explorer identity was restored.'
        } catch { Write-Warning "Could not restore the previous identity: $_" }
    }
    throw $registrationFailure
}
Get-AppxPackage -Name $identity | Select-Object Name, Version, Status, InstallLocation
