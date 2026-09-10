param(
    [string]$ClientSecretsPath,
    [string]$OutPath,
    [string[]]$Scopes = @('https://www.googleapis.com/auth/drive.file'),
    [int]$Port = 8631
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

if (-not $ClientSecretsPath) { $ClientSecretsPath = Join-Path $scriptDir 'client_secret.json' }
if (-not (Test-Path -LiteralPath $ClientSecretsPath)) {
    throw "Client secret file not found at '$ClientSecretsPath'."
}
if (-not $OutPath) { $OutPath = Join-Path $scriptDir 'token.json' }

$secrets = Get-Content -LiteralPath $ClientSecretsPath -Raw | ConvertFrom-Json
$clientId = $secrets.installed.client_id
$clientSecret = $secrets.installed.client_secret
if (-not $clientId -or -not $clientSecret) {
    throw "This script expects a desktop/'installed'-type OAuth client secret file."
}

$redirectUri = "http://localhost:$Port"
$state = [guid]::NewGuid().ToString('N')

$pairs = @(
    @{ k = 'client_id';     v = $clientId },
    @{ k = 'redirect_uri';  v = $redirectUri },
    @{ k = 'response_type'; v = 'code' },
    @{ k = 'scope';         v = ($Scopes -join ' ') },
    @{ k = 'access_type';   v = 'offline' },
    @{ k = 'prompt';        v = 'consent' },
    @{ k = 'state';         v = $state }
)
$authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    (($pairs | ForEach-Object { "{0}={1}" -f $_.k, [uri]::EscapeDataString([string]$_.v) }) -join '&')

function Get-QueryParam([string]$Query, [string]$Name) {
    if ($Query -match ('[?&]' + [regex]::Escape($Name) + '=([^&]+)')) {
        return [uri]::UnescapeDataString($Matches[1])
    }
    return $null
}

function Send-Response([object]$Ctx, [string]$Message) {
    $html = "<html><body><h2>$Message</h2><p>You can close this window.</p></body></html>"
    $bytes = [Text.Encoding]::UTF8.GetBytes($html)
    $Ctx.Response.ContentType = 'text/html'
    $Ctx.Response.ContentLength64 = $bytes.Length
    $Ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Ctx.Response.OutputStream.Close()
}

$code = $null
$listener = New-Object System.Net.HttpListener
$useListener = $false
try {
    $listener.Prefixes.Add("$redirectUri/")
    $listener.Start()
    $useListener = $true
} catch {
    Write-Warning "Local HTTP listener unavailable ($($_.Exception.Message)). Falling back to manual paste mode."
}

try {
    Write-Host "Opening browser for Google sign-in..."
    Write-Host ""
    Write-Host "If it does not open, visit this URL manually:"
    Write-Host $authUrl
    Write-Host ""
    try { Start-Process $authUrl | Out-Null } catch { }

    if ($useListener) {
        Write-Host "Waiting for authorization on $redirectUri (press Ctrl+C to abort)..."
        while ($true) {
            $ctx = $listener.GetContext()
            $q = $ctx.Request.Url.Query
            $errParam = Get-QueryParam $q 'error'
            if ($errParam) {
                Send-Response $ctx "Authorization failed: $errParam"
                throw "Authorization failed: $errParam"
            }
            $stParam = Get-QueryParam $q 'state'
            $codeParam = Get-QueryParam $q 'code'
            if ($stParam -ne $state) {
                Send-Response $ctx 'State mismatch, ignoring request.'
                Write-Warning 'State mismatch, ignoring request.'
                continue
            }
            if ($codeParam) {
                Send-Response $ctx 'Success! Token received.'
                $code = $codeParam
                break
            }
            Send-Response $ctx 'Missing code parameter.'
        }
    } else {
        Write-Host "After clicking Allow, the browser will land on a localhost page that will NOT load."
        Write-Host "That is expected. Copy the FULL URL from the address bar (it contains ?code=...) and paste it below:"
        $pasted = (Read-Host 'Paste URL or code').Trim()
        if (-not $pasted) { throw 'No authorization code provided.' }
        if ($pasted -match '[?&]code=([^&\s]+)') {
            $code = $Matches[1]
        } else {
            $code = $pasted
        }
    }
} finally {
    if ($useListener) {
        try { $listener.Stop() } catch { }
        try { $listener.Close() } catch { }
    }
}

Write-Host "Exchanging authorization code for tokens..."
$body = @{
    code          = $code
    client_id     = $clientId
    client_secret = $clientSecret
    redirect_uri  = $redirectUri
    grant_type    = 'authorization_code'
}
try {
    $resp = Invoke-RestMethod -Uri 'https://oauth2.googleapis.com/token' -Method Post -Body $body
} catch {
    $detail = ''
    if ($_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
    throw "Token exchange failed: $($_.Exception.Message) $detail"
}

if (-not $resp.refresh_token) {
    throw "Google did not return a refresh_token. Re-run the script; if it persists, revoke the app's access at https://myaccount.google.com/permissions and retry."
}

$tokenObj = [ordered]@{
    access_token  = $resp.access_token
    refresh_token = $resp.refresh_token
    scope         = $resp.scope
    token_type    = $resp.token_type
    expiry_date   = [long]([DateTimeOffset]::UtcNow.AddSeconds([double]$resp.expires_in).ToUnixTimeMilliseconds())
}
$json = $tokenObj | ConvertTo-Json

$outDir = Split-Path -Parent $OutPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
[IO.File]::WriteAllText($OutPath, $json)

Write-Host "Token saved to $OutPath"

try {
    $about = Invoke-RestMethod -Uri 'https://www.googleapis.com/drive/v3/about?fields=user' `
        -Headers @{ Authorization = "Bearer $($resp.access_token)" }
    Write-Host "Verified Drive access for: $($about.user.displayName) <$($about.user.emailAddress)>"
} catch {
    Write-Warning "Token saved, but verification call failed: $($_.Exception.Message)"
}
