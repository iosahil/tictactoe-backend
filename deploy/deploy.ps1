param(
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$ContainerApp = "",
    [string]$ContainerAppEnv = "",
    [string]$AcrName = "",
    [string]$AcrLoginServer = "",
    [string]$ImageRepository = "",
    [string]$ImageTag = "",
    [string]$DbAddress = "",
    [string]$NakamaServerKey = "",
    [int]$TargetPort = 7350,
    [int]$MinReplicas = 1,
    [int]$MaxReplicas = 1,
    [string]$Cpu = "0.5",
    [string]$Memory = "1Gi",
    [int]$BuildRetries = 3,
    [int]$RevisionReadyTimeoutSec = 300,
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

function Test-CommandAvailable {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' not found in PATH."
    }
}

function Import-DotEnv {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path $Path)) {
        return $values
    }

    foreach ($rawLine in Get-Content -Path $Path) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) {
            continue
        }

        $separatorIndex = $line.IndexOf("=")
        if ($separatorIndex -lt 1) {
            continue
        }

        $name = $line.Substring(0, $separatorIndex).Trim()
        $value = $line.Substring($separatorIndex + 1).Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $values[$name] = $value
    }

    return $values
}

function Resolve-StringSetting {
    param(
        [string]$Name,
        [string]$CurrentValue,
        [string]$EnvName,
        [string]$Fallback,
        [hashtable]$DotEnv,
        [hashtable]$BoundParameters
    )

    if ($BoundParameters.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($CurrentValue)) {
        return $CurrentValue
    }

    if ($DotEnv.ContainsKey($EnvName)) {
        $envValue = [string]$DotEnv[$EnvName]
        if (-not [string]::IsNullOrWhiteSpace($envValue)) {
            return $envValue
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($CurrentValue)) {
        return $CurrentValue
    }

    return $Fallback
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

function Test-ContainerAppExists {
    param(
        [string]$Rg,
        [string]$App
    )

    az containerapp show -g $Rg -n $App -o none 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Test-ContainerAppEnvExists {
    param(
        [string]$Rg,
        [string]$EnvName
    )

    az containerapp env show -g $Rg -n $EnvName -o none 2>$null
    return ($LASTEXITCODE -eq 0)
}

Test-CommandAvailable -Name "az"
Test-CommandAvailable -Name "docker"
Test-CommandAvailable -Name "npm"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dotenvPath = Join-Path $repoRoot ".env"
$dotenv = Import-DotEnv -Path $dotenvPath

$ResourceGroup = Resolve-StringSetting -Name "ResourceGroup" -CurrentValue $ResourceGroup -EnvName "AZURE_RESOURCE_GROUP" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$Location = Resolve-StringSetting -Name "Location" -CurrentValue $Location -EnvName "AZURE_LOCATION" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$ContainerApp = Resolve-StringSetting -Name "ContainerApp" -CurrentValue $ContainerApp -EnvName "AZURE_CONTAINER_APP" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$ContainerAppEnv = Resolve-StringSetting -Name "ContainerAppEnv" -CurrentValue $ContainerAppEnv -EnvName "AZURE_CONTAINER_APP_ENV" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$AcrName = Resolve-StringSetting -Name "AcrName" -CurrentValue $AcrName -EnvName "AZURE_ACR_NAME" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$AcrLoginServer = Resolve-StringSetting -Name "AcrLoginServer" -CurrentValue $AcrLoginServer -EnvName "AZURE_ACR_LOGIN_SERVER" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$ImageRepository = Resolve-StringSetting -Name "ImageRepository" -CurrentValue $ImageRepository -EnvName "IMAGE_REPOSITORY" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$DbAddress = Resolve-StringSetting -Name "DbAddress" -CurrentValue $DbAddress -EnvName "DB_ADDRESS" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters
$NakamaServerKey = Resolve-StringSetting -Name "NakamaServerKey" -CurrentValue $NakamaServerKey -EnvName "NAKAMA_SERVER_KEY" -Fallback "" -DotEnv $dotenv -BoundParameters $PSBoundParameters

$requiredConfig = @(
    @{ Name = "ResourceGroup"; Value = $ResourceGroup; Source = "AZURE_RESOURCE_GROUP" }
    @{ Name = "Location"; Value = $Location; Source = "AZURE_LOCATION" }
    @{ Name = "ContainerApp"; Value = $ContainerApp; Source = "AZURE_CONTAINER_APP" }
    @{ Name = "ContainerAppEnv"; Value = $ContainerAppEnv; Source = "AZURE_CONTAINER_APP_ENV" }
    @{ Name = "AcrName"; Value = $AcrName; Source = "AZURE_ACR_NAME" }
    @{ Name = "AcrLoginServer"; Value = $AcrLoginServer; Source = "AZURE_ACR_LOGIN_SERVER" }
    @{ Name = "ImageRepository"; Value = $ImageRepository; Source = "IMAGE_REPOSITORY" }
)

foreach ($entry in $requiredConfig) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
        throw "Missing required setting '$($entry.Name)'. Pass -$($entry.Name) or set $($entry.Source) in $dotenvPath"
    }
}

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

if ([string]::IsNullOrWhiteSpace($ImageTag)) {
    $ImageTag = "deploy-" + (Get-Date -Format "yyyyMMddHHmmss")
}

$image = "${AcrLoginServer}/${ImageRepository}:$ImageTag"

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
if (-not ($tags -contains $ImageTag)) {
    throw "Image tag '$ImageTag' not found in ACR repository '$ImageRepository'"
}

$appExists = Test-ContainerAppExists -Rg $ResourceGroup -App $ContainerApp

if ($appExists) {
    Write-Host "==> Existing container app found. Updating image."
    az containerapp update -g $ResourceGroup -n $ContainerApp --image $image --min-replicas $MinReplicas --max-replicas $MaxReplicas --output none
    Assert-LastExitCode "az containerapp update"
} else {
    Write-Host "==> Container app not found. Creating fresh deployment."

    if ([string]::IsNullOrWhiteSpace($DbAddress)) {
        throw "DbAddress is required for first deployment. Pass -DbAddress '<user>:<pass>@<host>:5432/nakama?sslmode=require'"
    }

    if ([string]::IsNullOrWhiteSpace($NakamaServerKey)) {
        throw "NakamaServerKey is required for first deployment. Pass -NakamaServerKey '<server_key>'"
    }

    $envExists = Test-ContainerAppEnvExists -Rg $ResourceGroup -EnvName $ContainerAppEnv
    if (-not $envExists) {
        Write-Host "==> Creating Container Apps environment: $ContainerAppEnv"
        az containerapp env create -g $ResourceGroup -n $ContainerAppEnv -l $Location --output none
        Assert-LastExitCode "az containerapp env create"
    } else {
        Write-Host "==> Reusing existing Container Apps environment: $ContainerAppEnv"
    }

    Write-Host "==> Fetching ACR credentials for registry pull"
    $acrCredJson = az acr credential show -n $AcrName -o json
    Assert-LastExitCode "az acr credential show"
    $acrCred = $acrCredJson | ConvertFrom-Json

    $acrUsername = [string]$acrCred.username
    $acrPassword = [string]$acrCred.passwords[0].value

    if ([string]::IsNullOrWhiteSpace($acrUsername) -or [string]::IsNullOrWhiteSpace($acrPassword)) {
        throw "Could not resolve ACR username/password. Ensure admin user is enabled on ACR '$AcrName'."
    }

    Write-Host "==> Creating container app: $ContainerApp"
    az containerapp create `
        -g $ResourceGroup `
        -n $ContainerApp `
        --environment $ContainerAppEnv `
        --image $image `
        --ingress external `
        --target-port $TargetPort `
        --transport auto `
        --cpu $Cpu `
        --memory $Memory `
        --min-replicas $MinReplicas `
        --max-replicas $MaxReplicas `
        --registry-server $AcrLoginServer `
        --registry-username $acrUsername `
        --registry-password $acrPassword `
        --secrets "nakama-server-key=$NakamaServerKey" "db-address=$DbAddress" `
        --env-vars "NAKAMA_SERVER_KEY=secretref:nakama-server-key" "DB_ADDRESS=secretref:db-address" `
        --output none
    Assert-LastExitCode "az containerapp create"
}

Write-Host "==> Waiting for latest revision to become Healthy/Running"
$deadline = (Get-Date).AddSeconds($RevisionReadyTimeoutSec)
$readyRevision = $null

while ((Get-Date) -lt $deadline) {
    $latest = Get-LatestContainerAppRevision -Rg $ResourceGroup -App $ContainerApp
    $containers = $latest.properties.template.containers
    $latestImage = ""
    if ($containers -and $containers.Count -gt 0) {
        $latestImage = [string]$containers[0].image
    }

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
