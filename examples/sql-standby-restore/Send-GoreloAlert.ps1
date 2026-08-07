#requires -version 5.1
<#
.SYNOPSIS
Relay client for the Gorelo monitoring-alert ingress (POST /v1/alerts).

.DESCRIPTION
A dot-sourceable PowerShell helper that lets an on-prem SQL Server / scheduled job
raise, update, and resolve Gorelo alerts through the gorelo-haloapi-relay Worker.

It is deliberately generic — the caller owns every identifier (source, host,
customer, monitor_id, title, details). Nothing here is customer-specific; all
routing values come from the passed-in $Config object, so this file is safe to
keep in source control.

Two design rules the restore job relies on:
  1. It NEVER throws into the caller. A monitoring outage must not fail a restore,
     so every send is wrapped and returns $true/$false instead of raising.
  2. It is a no-op when unconfigured (missing/placeholder relay URL or secret),
     so the restore script runs unchanged on a box that has no alerting yet.

The relay owns the alert lifecycle by `dedupe_key`: a `triggered` event posts one
Gorelo alert; repeats with the same key update silently; a `resolved` event clears
it. So a retrying monitor is safe to call this on every attempt.

.NOTES
Config fields consumed (see config.example.json):
  AlertRelayUrl       - https://<worker-host>/v1/alerts   (required to send)
  AlertSharedSecret   - the source's Bearer secret         (required to send)
  AlertSource         - free-text "source" label, e.g. "SQL Standby Restore"
  Customer            - Gorelo client name for routing (optional)
  AlertHost           - host/resource label (optional; defaults to $env:COMPUTERNAME)
  AlertMaxRetries     - retry count on 429/5xx (optional; default 4)
#>

Set-StrictMode -Version 2.0

# TLS 1.2 for WinHTTP/.NET on PowerShell 5.1 (older defaults negotiate down and fail
# against Cloudflare). Additive so we never clear an already-stronger policy.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}
catch {
    # Older frameworks may not expose Tls12; the request below will surface any real failure.
}

# Statuses/severities accepted by the relay (src/alerts.ts). `resolved` always rides
# at info severity; the relay maps severities to a Gorelo AlertLevel.
$script:GoreloAlertStatuses   = @('triggered', 'resolved', 'heartbeat')
$script:GoreloAlertSeverities = @('info', 'warning', 'critical')

function Write-GoreloAlertLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )
    # Reuse the restore script's Write-Log when dot-sourced into it; fall back to the
    # console when this helper is used standalone (e.g. interactive testing).
    if (Get-Command -Name Write-Log -ErrorAction SilentlyContinue) {
        Write-Log -Level $Level -Message $Message
    }
    else {
        Write-Host ('{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    }
}

function Get-GoreloConfigValue {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$Default = ''
    )
    if ($Config -and $Config.PSObject.Properties[$Name]) {
        $value = [string]$Config.$Name
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }
    return $Default
}

<#
.SYNOPSIS
Post a single alert event to the relay. Returns $true on accept, $false otherwise.

.DESCRIPTION
Builds the /v1/alerts JSON contract, authenticates with the source's Bearer secret,
and retries on 429/500/502/503/504. A 502 leaves the alert un-stored on the relay,
so a later retry re-posts cleanly. Never throws.
#>
function Send-GoreloAlert {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][ValidateSet('triggered', 'resolved', 'heartbeat')][string]$Status,
        [ValidateSet('info', 'warning', 'critical')][string]$Severity = 'info',
        [Parameter(Mandatory = $true)][string]$MonitorId,
        [string]$Title,
        [string]$Message,
        [hashtable]$Details,
        [string]$EventId
    )

    $relayUrl = Get-GoreloConfigValue -Config $Config -Name 'AlertRelayUrl'
    $secret   = Get-GoreloConfigValue -Config $Config -Name 'AlertSharedSecret'

    # No-op (not an error) when alerting isn't configured, or still on its placeholder.
    if ([string]::IsNullOrWhiteSpace($relayUrl) -or [string]::IsNullOrWhiteSpace($secret) -or
        $relayUrl -like '<REPLACE*' -or $secret -like '<REPLACE*') {
        Write-GoreloAlertLog -Level WARN -Message ("Gorelo alerting not configured; skipping {0} '{1}'." -f $Status, $MonitorId)
        return $false
    }

    $sourceLabel = Get-GoreloConfigValue -Config $Config -Name 'AlertSource' -Default 'SQL Standby Restore'
    $customer    = Get-GoreloConfigValue -Config $Config -Name 'Customer'
    $hostLabel   = Get-GoreloConfigValue -Config $Config -Name 'AlertHost' -Default $env:COMPUTERNAME
    $maxRetries  = [int](Get-GoreloConfigValue -Config $Config -Name 'AlertMaxRetries' -Default '4')

    # dedupe_key is the relay's stable identity for this alert. Namespacing by host keeps
    # two servers running the same monitor from colliding (mirrors the README examples).
    $dedupeKey = '{0}:{1}' -f $hostLabel, $MonitorId
    if ([string]::IsNullOrWhiteSpace($EventId)) {
        $EventId = '{0}:{1}:{2}' -f $dedupeKey, $Status, ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    }

    $payload = [ordered]@{
        source     = $sourceLabel
        host       = $hostLabel
        monitor_id = $MonitorId
        dedupe_key = $dedupeKey
        status     = $Status
        severity   = $Severity
        title      = if ([string]::IsNullOrWhiteSpace($Title)) { $MonitorId } else { $Title }
        message    = if ([string]::IsNullOrWhiteSpace($Message)) { $Title } else { $Message }
        timestamp  = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        event_id   = $EventId
    }
    if (-not [string]::IsNullOrWhiteSpace($customer)) { $payload['customer'] = $customer }
    if ($Details -and $Details.Count -gt 0)          { $payload['details']  = $Details }

    $body = $payload | ConvertTo-Json -Depth 6 -Compress
    $headers = @{
        'Authorization'   = "Bearer $secret"
        'Idempotency-Key' = $EventId
    }

    for ($attempt = 1; $attempt -le ($maxRetries + 1); $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri $relayUrl -Method Post -Headers $headers `
                -ContentType 'application/json' -Body $body -TimeoutSec 30
            $action = if ($response -and $response.PSObject.Properties['action']) { $response.action } else { 'accepted' }
            Write-GoreloAlertLog ("Gorelo alert {0} '{1}' -> {2} (dedupe {3})." -f $Status, $MonitorId, $action, $dedupeKey)
            return $true
        }
        catch {
            # Retry only transient statuses (429/500/502/503/504); fail fast on 4xx auth/validation.
            $statusCode = 0
            $resp = $_.Exception.Response
            if ($resp -and $resp.PSObject.Properties['StatusCode']) {
                try { $statusCode = [int]$resp.StatusCode } catch { $statusCode = 0 }
            }
            $retryable = @(429, 500, 502, 503, 504) -contains $statusCode -or $statusCode -eq 0

            if (-not $retryable -or $attempt -gt $maxRetries) {
                Write-GoreloAlertLog -Level WARN -Message (
                    "Gorelo alert {0} '{1}' failed (HTTP {2}, attempt {3}): {4}" -f `
                        $Status, $MonitorId, $statusCode, $attempt, $_.Exception.Message)
                return $false
            }

            $backoff = [Math]::Min(30, [Math]::Pow(2, $attempt))
            Write-GoreloAlertLog -Level WARN -Message (
                "Gorelo alert {0} '{1}' transient failure (HTTP {2}); retrying in {3}s." -f `
                    $Status, $MonitorId, $statusCode, $backoff)
            Start-Sleep -Seconds $backoff
        }
    }

    return $false
}

<#
.SYNOPSIS
Resolve (clear) one or more monitor keys. Safe to call even if none are open — the
relay treats a resolve of a non-open alert as an idempotent no-op (no Gorelo post).

.DESCRIPTION
On a healthy run the restore job doesn't know which alert (if any) was open, so it
resolves every key it might have triggered. Only the actually-open one posts a
"Resolved: …" alert; the rest are no-ops.
#>
function Resolve-GoreloAlerts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string[]]$MonitorIds,
        [string]$Message = 'Condition cleared; the standby restore is healthy.'
    )
    foreach ($monitorId in $MonitorIds) {
        [void](Send-GoreloAlert -Config $Config -Status 'resolved' -Severity 'info' `
            -MonitorId $monitorId -Title ("Recovered: {0}" -f $monitorId) -Message $Message)
    }
}
