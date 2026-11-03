#requires -Version 7.0
[CmdletBinding()]
param(
    [string] $Root = (Get-Location).Path,
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $DshVersion = '0.2.2-alpha.3',
    [string] $Model = 'kitchen-deepseek-r1:8b',
    [string] $BaseUrl = 'http://127.0.0.1:11434/v1',
    [ValidateRange(2, 1048576)] [int] $ContextWindow = 8192,
    [ValidateRange(1, 1048575)] [int] $MaxTokens = 2048
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $Root).Path
$endpoint = [Uri] $BaseUrl
if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -notin @('127.0.0.1', '[::1]', '::1') -or
    $endpoint.AbsolutePath.TrimEnd('/') -ne '/v1' -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.UserInfo) {
    throw 'BaseUrl must be a literal loopback HTTP /v1 endpoint.'
}
if ($MaxTokens -ge $ContextWindow) { throw 'MaxTokens must be smaller than ContextWindow.' }
if ([string]::IsNullOrWhiteSpace($Model) -or $Model.Contains(':cloud')) { throw 'Select an explicit local model.' }
$origin = $endpoint.GetLeftPart([UriPartial]::Authority)
$inventory = Invoke-RestMethod -Uri "$origin/api/tags" -TimeoutSec 10 -MaximumRedirection 0
$selected = @($inventory.models | Where-Object { $_.name -ceq $Model })
if ($selected.Count -ne 1 -or $selected[0].digest -notmatch '^(?:sha256:)?[a-f0-9]{64}$') {
    throw "Local model '$Model' is not installed or has no valid digest. Complete Ollama setup first."
}
$modelDigest = if ($selected[0].digest.StartsWith('sha256:')) { $selected[0].digest } else { 'sha256:' + $selected[0].digest }
$show = Invoke-RestMethod -Method Post -Uri "$origin/api/show" -ContentType 'application/json' `
    -Body (@{ model = $Model } | ConvertTo-Json) -TimeoutSec 10 -MaximumRedirection 0
if ($show.parameters -notmatch "(?m)^\s*num_ctx\s+$ContextWindow\s*$") {
    throw "The model alias must set PARAMETER num_ctx $ContextWindow in its Modelfile. See docs/local-deepseek.md."
}
$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'24.9.0') { throw 'DSH requires Node >=24.9.' }
$launcher = if ($IsWindows) { 'npx.cmd' } else { 'npx' }
$package = "@deepseek-ai/dsh@$DshVersion"
& $launcher --yes $package --version
if ($LASTEXITCODE -ne 0) { throw 'DSH package provisioning failed.' }
$actualVersion = & $launcher --yes --offline $package --version
if ($LASTEXITCODE -ne 0 -or ($actualVersion -join "`n").Trim() -cne $DshVersion) {
    throw 'The cached DSH runtime did not report the pinned version.'
}
$localPath = Join-Path $projectRoot 'kitchen.config.local.json'
$localConfig = if (Test-Path -LiteralPath $localPath) {
    Get-Content -LiteralPath $localPath -Raw | ConvertFrom-Json -AsHashtable
} else { @{} }
if ($localConfig -isnot [System.Collections.IDictionary]) { throw 'Local config must be a JSON object.' }
$setupDir = Join-Path $projectRoot ".kitchen/deepseek-setup/$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))"
New-Item -ItemType Directory -Path $setupDir -Force | Out-Null
if (Test-Path -LiteralPath $localPath) { Copy-Item -LiteralPath $localPath -Destination (Join-Path $setupDir 'previous-config.json') }
if (-not $localConfig.ContainsKey('providers')) { $localConfig['providers'] = @{} }
if ($localConfig['providers'] -isnot [System.Collections.IDictionary]) { throw 'providers must be an object.' }
$localConfig['providers']['author'] = @{
    provider = 'deepseek'
    model = $Model
    dsh = @{
        version = $DshVersion
        baseURL = $BaseUrl
        contextWindow = $ContextWindow
        maxTokens = $MaxTokens
        expectedModelDigest = $modelDigest
    }
}
if (-not $localConfig['providers'].ContainsKey('timeoutMs')) { $localConfig['providers']['timeoutMs'] = 1200000 }
$localConfig | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $localPath -Encoding utf8NoBOM
@{ version = $DshVersion; model = $Model; digest = $modelDigest; baseURL = $BaseUrl } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $setupDir 'setup.json') -Encoding utf8NoBOM
Write-Output "Configured DeepSeek author in $localPath"
Write-Output 'Existing reviewer and station overrides are preserved. Audit explicit Codex station roles separately.'
Write-Output 'Next: run kitchen doctor in the target project for a local schema probe.'
