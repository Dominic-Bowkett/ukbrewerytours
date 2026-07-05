# Downloads each DesignMyNight experience's photo (image_url) into assets/img/dmn/<slug>.jpg.
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "assets\img\dmn"
New-Item -ItemType Directory -Force $dir | Out-Null
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$eparams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$eparams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)

$ok = 0; $fail = @(); $noimg = @()
foreach ($f in Get-ChildItem (Join-Path $root "content\dmn") -Filter *.json) {
    $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
    foreach ($t in $j.dmn_experiences) {
        if (-not $t.image_url) { $noimg += $t.slug; continue }
        $dest = Join-Path $dir "$($t.slug).jpg"
        if (Test-Path $dest) { $ok++; continue }
        $tmp = Join-Path $env:TEMP ("dmn_" + ($t.slug -replace '[^a-z0-9]','_') + ".img")
        try {
            Invoke-WebRequest -Uri $t.image_url -OutFile $tmp -UseBasicParsing -TimeoutSec 40 -Headers @{ "User-Agent" = "Mozilla/5.0" }
            $img = [System.Drawing.Image]::FromFile($tmp)
            $img.Save($dest, $codec, $eparams); $img.Dispose()
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            $ok++
        } catch {
            $fail += $t.slug
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        }
    }
}
Write-Output "Downloaded $ok DMN images. Failed: $($fail.Count). No image_url: $($noimg.Count)"
Write-Output "--- NEED GENERATION (failed + no image_url) ---"
($fail + $noimg) | ForEach-Object { Write-Output $_ }
