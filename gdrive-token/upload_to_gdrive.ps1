$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

$clientSecretsPath = Join-Path $scriptDir 'client_secret.json'
$tokenPath = Join-Path $scriptDir 'token.json'
$imagePath = Join-Path $scriptDir 'image.png'

$secrets = Get-Content -LiteralPath $clientSecretsPath -Raw | ConvertFrom-Json
$clientId = $secrets.installed.client_id
$clientSecret = $secrets.installed.client_secret

$token = Get-Content -LiteralPath $tokenPath -Raw | ConvertFrom-Json

# Refresh access token if expired
$now = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
if ($now -ge $token.expiry_date) {
    Write-Host "Access token expired, refreshing..."
    $body = @{
        client_id     = $clientId
        client_secret = $clientSecret
        refresh_token = $token.refresh_token
        grant_type    = 'refresh_token'
    }
    $resp = Invoke-RestMethod -Uri 'https://oauth2.googleapis.com/token' -Method Post -Body $body
    $token.access_token = $resp.access_token
    $token.expiry_date = [long]([DateTimeOffset]::UtcNow.AddSeconds([double]$resp.expires_in).ToUnixTimeMilliseconds())
    $token | ConvertTo-Json | Set-Content -LiteralPath $tokenPath
    Write-Host "Token refreshed."
}

$authHeader = @{ Authorization = "Bearer $($token.access_token)" }

# Create folder "test-upload" using Drive API v3 (not upload endpoint)
Write-Host "Creating folder 'test-upload'..."
$folderMeta = @{
    name     = 'test-upload'
    mimeType = 'application/vnd.google-apps.folder'
} | ConvertTo-Json

$folder = Invoke-RestMethod -Uri 'https://www.googleapis.com/drive/v3/files' `
    -Method Post -Headers $authHeader `
    -ContentType 'application/json; charset=UTF-8' `
    -Body $folderMeta

Write-Host "Folder created: $($folder.id)"

# Upload image.png to the folder using simple multipart upload
Write-Host "Uploading image.png..."
$fileName = 'image.png'
$metadataObj = @{
    name    = $fileName
    parents = @($folder.id)
}
$metadataJson = $metadataObj | ConvertTo-Json

$boundary = [guid]::NewGuid().ToString('N')
$enc = [Text.Encoding]::UTF8

# Build multipart body using .NET
$metadataPart = $enc.GetBytes(
    "--$boundary`r`n" +
    "Content-Type: application/json; charset=UTF-8`r`n`r`n" +
    $metadataJson + "`r`n"
)
$filePart = $enc.GetBytes(
    "--$boundary`r`n" +
    "Content-Type: image/png`r`n" +
    "Content-Disposition: form-data; name=`"file`"; filename=`"$fileName`"`r`n`r`n"
)
$endPart = $enc.GetBytes("`r`n--$boundary--`r`n")
$fileBytes = [IO.File]::ReadAllBytes($imagePath)

$ms = New-Object System.IO.MemoryStream
$ms.Write($metadataPart, 0, $metadataPart.Length)
$ms.Write($filePart, 0, $filePart.Length)
$ms.Write($fileBytes, 0, $fileBytes.Length)
$ms.Write($endPart, 0, $endPart.Length)
$fullBody = $ms.ToArray()
$ms.Dispose()

$uploaded = Invoke-RestMethod -Uri 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart' `
    -Method Post -Headers $authHeader `
    -ContentType "multipart/related; boundary=$boundary" `
    -Body $fullBody

Write-Host "Uploaded! File ID: $($uploaded.id)"
Write-Host "Open: https://drive.google.com/file/d/$($uploaded.id)/view"
