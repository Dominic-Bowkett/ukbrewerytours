# Downloads a generated PNG from a URL and saves it as a compressed JPEG in assets/img/.
# Usage: save-genimage.ps1 -Url <presigned url> -Name <output name without extension>
param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$Name
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$flat = ($Name -replace '[\\/]', '_')
$tmp = Join-Path $env:TEMP "$flat.png"
$dest = Join-Path $root "assets\img\$Name.jpg"
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -TimeoutSec 60 | Out-Null
$img = [System.Drawing.Image]::FromFile($tmp)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
$img.Save($dest, $codec, $params)
$img.Dispose()
Remove-Item $tmp -Force
$kb = [Math]::Round((Get-Item $dest).Length / 1KB)
Write-Output "$Name.jpg saved ($kb KB, $($img.Width)x$($img.Height))"
