#requires -version 5.1
<#
.SYNOPSIS
Integration snippet: the status-file writer + classified-alert helpers a SQL standby
restore job dot-sources to feed the Gorelo relay.

.DESCRIPTION
This is the generic, customer-agnostic half of the "Path A" sender. Dot-source it
(and Send-GoreloAlert.ps1) into your restore script, then call:

  - Write-RestoreStatusFile  on every terminal path (success, no-new-log, failure)
  - Invoke-RestoreErrorAlert in the script's main catch block
  - Resolve-GoreloAlerts     after a healthy run (clears whatever was open)

It reuses the restore script's own SQL helpers (Invoke-SqlTable, ConvertTo-SqlString),
so dot-source it AFTER those are defined. Nothing here names a customer, database, or
host — those come from $Config and the live msdb history.

The `status.json` it writes is the seam the RMM watch (Path B) reads: its mtime is the
liveness signal; `lastRestoredLogFinishUtc` is the freshness signal.
#>

Set-StrictMode -Version 2.0

# The monitor_id / dedupe namespace this job raises. Kept in one place so the success
# path can resolve exactly the keys the failure path can trigger.
$script:RestoreMonitorIds = @{
    Run           = 'daily-restore'    # generic run / SQL RESTORE failure
    LsnGap        = 'lsn-gap'          # broken log chain (missing intermediate backup)
    AzureDownload = 'azure-download'   # all SAS downloads failed
    Extract       = 'extract'          # archive extraction failed
    StandbyState  = 'standby-state'    # DB not ONLINE / read-only / standby
}

<#
.SYNOPSIS
Map a terminal exception to a (MonitorId, Severity, Title) so the alert names the
actual cause instead of a generic "job failed".

.DESCRIPTION
Classifies by the distinctive text the restore functions throw. The no-new-log case
is deliberately NOT a trigger — it returns $null so the caller stays silent and lets
SQL Agent keep polling; the RMM freshness watch owns "the feed is actually late".
#>
function Get-RestoreAlertClass {
    param([Parameter(Mandatory = $true)][string]$ErrorMessage)

    $m = $ErrorMessage

    # Expected polling state — no new transaction log yet. Silent by design.
    if ($m -like '*No new transaction-log backup was available*') {
        return $null
    }

    if ($m -like '*LSN gap detected*') {
        return @{ MonitorId = $script:RestoreMonitorIds.LsnGap; Severity = 'critical'
                  Title = 'Transaction-log chain is broken (LSN gap)' }
    }
    if ($m -like '*All configured SAS downloads failed*') {
        return @{ MonitorId = $script:RestoreMonitorIds.AzureDownload; Severity = 'critical'
                  Title = 'Azure log-shipping download failed' }
    }
    if ($m -like '*7-Zip failed*' -or $m -like '*No transaction-log backup set was found*') {
        return @{ MonitorId = $script:RestoreMonitorIds.Extract; Severity = 'critical'
                  Title = 'Archive extraction / log validation failed' }
    }
    if ($m -like '*not ONLINE in read-only standby*') {
        return @{ MonitorId = $script:RestoreMonitorIds.StandbyState; Severity = 'critical'
                  Title = 'Standby database is not in the expected state' }
    }

    # Anything else (SQL RESTORE LOG errors, config/executable problems, etc.).
    return @{ MonitorId = $script:RestoreMonitorIds.Run; Severity = 'critical'
              Title = 'Daily transaction-log restore failed' }
}

<#
.SYNOPSIS
Query msdb for the most recent restored transaction-log backup's finish time + LSN.
Returns $null if none is recorded yet.
#>
function Get-LastRestoredLogInfo {
    param(
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$Connection,
        [Parameter(Mandatory = $true)][string]$DatabaseName
    )

    $escaped = ConvertTo-SqlString -Value $DatabaseName
    $query = @"
SELECT TOP (1)
       bs.backup_finish_date AS FinishDate,
       bs.last_lsn           AS LastLSN
FROM msdb.dbo.restorehistory AS rh
INNER JOIN msdb.dbo.backupset AS bs
    ON bs.backup_set_id = rh.backup_set_id
WHERE rh.destination_database_name = N'$escaped'
  AND bs.[type] = 'L'
ORDER BY rh.restore_date DESC, rh.restore_history_id DESC;
"@

    $table = Invoke-SqlTable -Connection $Connection -Query $query
    if ($table.Rows.Count -eq 0 -or $table.Rows[0].FinishDate -eq [DBNull]::Value) {
        return $null
    }

    return [pscustomobject]@{
        FinishUtc = ([datetime]$table.Rows[0].FinishDate).ToUniversalTime()
        LastLSN   = if ($table.Rows[0].LastLSN -eq [DBNull]::Value) { $null } else { [string]$table.Rows[0].LastLSN }
    }
}

<#
.SYNOPSIS
Write the status.json the RMM watch reads. Best-effort: never throws (a status-write
failure must not fail a restore).

.PARAMETER Outcome  one of: restored | no-new-log | failed
#>
function Write-RestoreStatusFile {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][ValidateSet('restored', 'no-new-log', 'failed')][string]$Outcome,
        [System.Data.SqlClient.SqlConnection]$Connection,
        [int]$LogsAppliedThisRun = 0,
        [string]$StandbyState = '',
        [string]$ErrorMessage = ''
    )

    try {
        $statusPath = Get-GoreloConfigValue -Config $Config -Name 'StatusFile'
        if ([string]::IsNullOrWhiteSpace($statusPath)) {
            $statusPath = Join-Path ([string]$Config.StateFolder) 'status.json'
        }

        $lastRestored = $null
        if ($Connection -and $Connection.State -eq 'Open') {
            try {
                $lastRestored = Get-LastRestoredLogInfo -Connection $Connection -DatabaseName ([string]$Config.DatabaseName)
            }
            catch {
                Write-GoreloAlertLog -Level WARN -Message ("Could not read last restored log for status file: {0}" -f $_.Exception.Message)
            }
        }

        # If we couldn't query the recovery point (e.g. a download/extract failure that
        # never opened a SQL connection), carry forward the previous file's value rather
        # than nulling it — otherwise the RMM watch would misread a transient failure as
        # "no recovery point recorded".
        $carryFinishUtc = $null
        $carryLsn       = $null
        if ($null -eq $lastRestored -and (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
            try {
                $prev = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
                if ($prev.PSObject.Properties['lastRestoredLogFinishUtc']) { $carryFinishUtc = [string]$prev.lastRestoredLogFinishUtc }
                if ($prev.PSObject.Properties['lastRestoredLsn'])          { $carryLsn       = [string]$prev.lastRestoredLsn }
            }
            catch {
                # A prior file we can't parse isn't worth failing over; just omit the carry-forward.
            }
        }

        $status = [ordered]@{
            schema                   = 'sql-standby-restore/1'
            host                     = Get-GoreloConfigValue -Config $Config -Name 'AlertHost' -Default $env:COMPUTERNAME
            database                 = [string]$Config.DatabaseName
            lastRunUtc               = (Get-Date).ToUniversalTime().ToString('o')
            outcome                  = $Outcome
            logsAppliedThisRun       = $LogsAppliedThisRun
            standbyState             = $StandbyState
            lastRestoredLogFinishUtc = if ($lastRestored) { $lastRestored.FinishUtc.ToString('o') } else { $carryFinishUtc }
            lastRestoredLsn          = if ($lastRestored) { $lastRestored.LastLSN } else { $carryLsn }
            error                    = $ErrorMessage
        }

        $tempPath = "$statusPath.tmp"
        $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempPath -Encoding UTF8
        # Atomic swap so a concurrent RMM read never sees a half-written file.
        Move-Item -LiteralPath $tempPath -Destination $statusPath -Force
        Write-GoreloAlertLog ("Wrote restore status file ({0}) to {1}." -f $Outcome, $statusPath)
    }
    catch {
        Write-GoreloAlertLog -Level WARN -Message ("Failed to write status file: {0}" -f $_.Exception.Message)
    }
}

<#
.SYNOPSIS
Classify a terminal error and raise the matching triggered alert. Silent for the
expected no-new-log state. Returns the monitor_id raised (or $null).
#>
function Invoke-RestoreErrorAlert {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$ErrorMessage,
        [hashtable]$Details
    )

    $class = Get-RestoreAlertClass -ErrorMessage $ErrorMessage
    if ($null -eq $class) {
        Write-GoreloAlertLog 'No-new-log state: not raising an alert (SQL Agent will retry; the RMM freshness watch owns staleness).'
        return $null
    }

    $detailBag = @{ database = [string]$Config.DatabaseName; error = $ErrorMessage }
    if ($Details) { foreach ($k in $Details.Keys) { $detailBag[$k] = $Details[$k] } }

    [void](Send-GoreloAlert -Config $Config -Status 'triggered' -Severity $class.Severity `
        -MonitorId $class.MonitorId -Title $class.Title -Message $ErrorMessage -Details $detailBag)
    return $class.MonitorId
}
