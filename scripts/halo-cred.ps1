#!/usr/bin/env pwsh
# PowerShell port of scripts/halo-cred.sh. Generate a per-product Halo OAuth
# credential pair (client_id + client_secret), push the SECRET into the Worker with
# `wrangler secret put`, and print the values to paste into that product's Halo
# integration on the other side. See issue #51: each product authenticates with its
# OWN client_id/secret, so multiple products can pass HALO_TOKEN_ENFORCE="enforce".
#
# Usage:
#   ./scripts/halo-cred.ps1 tier2                 # -> HALO_CLIENT_ID / HALO_CLIENT_SECRET
#   ./scripts/halo-cred.ps1 huntress              # -> HALO_CLIENT_ID_HUNTRESS / HALO_CLIENT_SECRET_HUNTRESS
#   $env:CLIENT_ID='13b3832f...'; ./scripts/halo-cred.ps1 huntress   # reuse a client_id the product already fixes
#   ./scripts/halo-cred.ps1 huntress --env staging                   # extra args pass through to wrangler
#   $env:DRY_RUN='1'; ./scripts/halo-cred.ps1 tier2   # print the values, don't call wrangler
#
# The client_id is NOT a secret (it's a public identifier) — set it in wrangler.toml
# [vars] under the printed var name, OR `wrangler secret put` it too if you prefer.
# Only the client_secret is pushed as a secret here. Requires: PowerShell 5.1+ and
# wrangler (via npx). Runs on Windows PowerShell and PowerShell 7 (Windows/macOS/Linux).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Product,
    # Remaining args pass straight through to `wrangler secret put`.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$WranglerArgs
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root (this script's parent dir) so wrangler is pointed at the
# repo's wrangler.toml regardless of the caller's working directory — otherwise
# wrangler can't find the config and fails with "Required Worker name missing".
$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Split-Path -Parent $ScriptDir
$WranglerConfig = Join-Path $RepoRoot 'wrangler.toml'

# tier2 keeps the original un-suffixed var names; every other product is suffixed
# with its uppercased key (matches clientIdVar/clientSecretVar in src/products.ts).
if ($Product -eq 'tier2') {
    $IdVar = 'HALO_CLIENT_ID'
    $SecretVar = 'HALO_CLIENT_SECRET'
}
else {
    $keyUpper = $Product.ToUpperInvariant().Replace('-', '_')
    $IdVar = "HALO_CLIENT_ID_${keyUpper}"
    $SecretVar = "HALO_CLIENT_SECRET_${keyUpper}"
}

# A URL-safe high-entropy token (32 bytes), base64url without padding.
function New-UrlSafeToken {
    $bytes = New-Object 'byte[]' 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

$ClientId = if ($env:CLIENT_ID) { $env:CLIENT_ID } else { New-UrlSafeToken }
$ClientSecret = New-UrlSafeToken

Write-Host "Product:       $Product"
Write-Host "client_id  var: $IdVar"
Write-Host "client_secret var: $SecretVar"
Write-Host ""
Write-Host "--- paste these into ${Product}'s Halo integration (the other side) ---"
Write-Host "client_id:     $ClientId"
Write-Host "client_secret: $ClientSecret"
Write-Host "-----------------------------------------------------------------------"
Write-Host ""

$extra = ($WranglerArgs -join ' ')
# --config points wrangler at the repo's wrangler.toml so it works from any CWD;
# without it wrangler can't find the config and fails "Required Worker name missing".
$cfg = "--config `"$WranglerConfig`""

if ($env:DRY_RUN -eq '1') {
    Write-Host "DRY_RUN=1 - not calling wrangler. To apply:"
    Write-Host "  `$env:HALO_SECRET='$ClientSecret'; `$env:HALO_SECRET | npx wrangler secret put $SecretVar $cfg $extra"
    Write-Host "  # then set $IdVar=`"$ClientId`" in wrangler.toml [vars] (or secret-put it too)"
    exit 0
}

# Pipe the secret to wrangler on stdin so it never lands in shell history/argv.
# Use ProcessStartInfo + StandardInput.Write (NOT WriteLine) so no trailing newline
# is appended to the secret. On Windows, npx is a .cmd, so it must be run via cmd.exe.
Write-Host "Pushing $SecretVar via wrangler secret put..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$isWin = $IsWindows -or ($env:OS -eq 'Windows_NT')
if ($isWin) {
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = "/c npx wrangler secret put $SecretVar $cfg $extra"
}
else {
    $psi.FileName = 'npx'
    $psi.Arguments = "wrangler secret put $SecretVar $cfg $extra"
}
$psi.RedirectStandardInput = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.Write($ClientSecret)
$proc.StandardInput.Close()
$proc.WaitForExit()
if ($proc.ExitCode -ne 0) { exit $proc.ExitCode }

Write-Host ""
Write-Host "Done. Remaining step: set the (non-secret) client_id so the relay can validate it -"
Write-Host "  add to wrangler.toml [vars]:  $IdVar = `"$ClientId`""
Write-Host "  (or push it as a secret too:  `$env:HALO_ID='$ClientId'; `$env:HALO_ID | npx wrangler secret put $IdVar $cfg $extra)"
Write-Host ""
Write-Host "Both parts must resolve non-empty for $Product to be validated + token-enforced;"
Write-Host "leave them unset to keep $Product lenient (any creds accepted) during rollout."
