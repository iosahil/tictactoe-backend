param(
    [string]$ResourceGroup = "NetworkWatcherRG",
    [string]$ContainerApp = "tictactoedemo",
    [string]$AcrName = "tictactoedemo",
    [string]$AcrLoginServer = "tictactoedemo.azurecr.io",
    [string]$ImageRepository = "nakama-server",
    [int]$MinReplicas = 1,
    [int]$BuildRetries = 3,
    [int]$RevisionReadyTimeoutSec = 240,
    [switch]$NoFollowLogs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

function Get-LatestContainerAppRevision {
    param(
        [string]$Rg,
        [string]$App
    )

    $json = az containerapp revision list -g $Rg -n $App -o json
    Assert-LastExitCode "az containerapp revision list"

    $revisions = $json | ConvertFrom-Json
    if (-not $revisions) {
        throw "No revisions found for container app '$App' in resource group '$Rg'."
    }

    return $revisions |
        Sort-Object { [DateTime]$_.properties.createdTime } |
        Select-Object -Last 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverDir = Join-Path $repoRoot "server"
$dockerfilePath = Join-Path $repoRoot "Dockerfile"
if (-not (Test-Path $dockerfilePath)) {
    throw "Dockerfile not found at $dockerfilePath"
}

Write-Host "==> Repo root: $repoRoot"
Write-Host "==> Building latest TypeScript server module"
Push-Location $serverDir
try {
    npm run build
    Assert-LastExitCode "npm run build"
} finally {
    Pop-Location
}

$tag = "refresh-" + (Get-Date -Format "yyyyMMddHHmmss")
$image = "$AcrLoginServer/$ImageRepository" + ":" + $tag

Write-Host "==> Logging in to ACR: $AcrName"
az acr login -n $AcrName
Assert-LastExitCode "az acr login"

$buildSucceeded = $false
for ($attempt = 1; $attempt -le $BuildRetries; $attempt++) {
    Write-Host "==> Docker build+push attempt $attempt/$BuildRetries"
    docker buildx build --progress plain --platform linux/amd64 --pull --no-cache --provenance=false --sbom=false -f $dockerfilePath -t $image --push $repoRoot
    if ($LASTEXITCODE -eq 0) {
        $buildSucceeded = $true
        break
    }

    if ($attempt -lt $BuildRetries) {
        Write-Warning "docker buildx failed; retrying in 5 seconds"
        Start-Sleep -Seconds 5
    }
}

if (-not $buildSucceeded) {
    throw "docker buildx build failed after $BuildRetries attempts"
}

Write-Host "==> Verifying pushed tag exists in ACR"
$tagsJson = az acr repository show-tags -n $AcrName --repository $ImageRepository -o json
Assert-LastExitCode "az acr repository show-tags"
$tags = $tagsJson | ConvertFrom-Json
if (-not ($tags -contains $tag)) {
    throw "Image tag '$tag' not found in ACR repository '$ImageRepository'"
}

Write-Host "==> Updating Container App image"
az containerapp update -g $ResourceGroup -n $ContainerApp --image $image --min-replicas $MinReplicas --output none
Assert-LastExitCode "az containerapp update"

Write-Host "==> Waiting for latest revision to become Healthy/Running"
$deadline = (Get-Date).AddSeconds($RevisionReadyTimeoutSec)
$readyRevision = $null

while ((Get-Date) -lt $deadline) {
    $latest = Get-LatestContainerAppRevision -Rg $ResourceGroup -App $ContainerApp
    $latestImage = $latest.properties.template.containers[0].image
    $health = [string]$latest.properties.healthState
    $state = [string]$latest.properties.runningState
    $traffic = $latest.properties.trafficWeight

    Write-Host "Revision=$($latest.name) Image=$latestImage Health=$health State=$state Traffic=$traffic"

    if ($latestImage -eq $image -and $health -eq "Healthy" -and $state -eq "Running") {
        $readyRevision = $latest
        break
    }

    Start-Sleep -Seconds 5
}

if (-not $readyRevision) {
    throw "Timed out waiting for new revision to become Healthy/Running (timeout=$RevisionReadyTimeoutSec sec)"
}

$appJson = az containerapp show -g $ResourceGroup -n $ContainerApp -o json
Assert-LastExitCode "az containerapp show"
$app = $appJson | ConvertFrom-Json
$mode = $app.properties.configuration.activeRevisionsMode
$fqdn = $app.properties.configuration.ingress.fqdn

Write-Host "==> Fetching recent console logs"
$logs = az containerapp logs show -g $ResourceGroup -n $ContainerApp --tail 160 --follow false --type console --format text 2>&1
$logText = $logs | Out-String
$logLines = $logText -split "`r?`n"

$markerLines = $logLines |
    Where-Object { $_ -match "Auto-starting ranked match|broadcastState sent|broadcastState skipped" } |
    Select-Object -Last 30

$errorLines = $logLines |
    Where-Object { $_ -match "(?i)\b(error|exception|failed|panic|traceback)\b" } |
    Select-Object -First 20

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Image:      $image"
Write-Host "Revision:   $($readyRevision.name)"
Write-Host "Health:     $($readyRevision.properties.healthState)"
Write-Host "State:      $($readyRevision.properties.runningState)"
Write-Host "Traffic:    $($readyRevision.properties.trafficWeight)"
Write-Host "Mode:       $mode"
Write-Host "Endpoint:   https://$fqdn"

if ($markerLines) {
    Write-Host ""
    Write-Host "--- Marker Logs (latest) ---"
    $markerLines | ForEach-Object { Write-Host $_ }
}

if ($errorLines) {
    Write-Host ""
    Write-Warning "--- Error-like Log Lines ---"
    $errorLines | ForEach-Object { Write-Host $_ }
}

[pscustomobject]@{
    image = $image
    revision = $readyRevision.name
    health = $readyRevision.properties.healthState
    state = $readyRevision.properties.runningState
    traffic = $readyRevision.properties.trafficWeight
    mode = $mode
    endpoint = "https://$fqdn"
    markerCount = @($markerLines).Count
    errorLikeLineCount = @($errorLines).Count
} | ConvertTo-Json -Depth 5

if (-not $NoFollowLogs) {
    Write-Host ""
    Write-Host "==> Streaming live console logs. Press Ctrl+C to stop." -ForegroundColor Yellow
    az containerapp logs show -g $ResourceGroup -n $ContainerApp --follow --tail 80 --type console --format text
}
