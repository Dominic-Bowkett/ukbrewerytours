# Downloads each DesignMyNight experience's gallery photos into
# assets/img/dmn/<slug>-1.jpg, -2.jpg ... (the hero stays <slug>.jpg via download-dmn-images.ps1).
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "assets\img\dmn"
New-Item -ItemType Directory -Force $dir | Out-Null
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$eparams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$eparams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)

$ok = 0; $skip = 0; $fail = @()
foreach ($f in Get-ChildItem (Join-Path $root "content\dmn") -Filter *.json) {
    $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
    foreach ($t in $j.dmn_experiences) {
        if (-not $t.gallery) { continue }
        $i = 0
        foreach ($url in $t.gallery) {
            $i++
            $dest = Join-Path $dir "$($t.slug)-$i.jpg"
            if (Test-Path $dest) { $skip++; continue }
            $tmp = Join-Path $env:TEMP ("dmng_" + ($t.slug -replace '[^a-zA-Z0-9]','_') + "_$i.img")
            try {
                Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 40 -Headers @{ "User-Agent" = "Mozilla/5.0" }
                $img = [System.Drawing.Image]::FromFile($tmp)
                $img.Save($dest, $codec, $eparams); $img.Dispose()
                Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                $ok++
            } catch {
                $fail += "$($t.slug)-$i"
                if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
            }
        }
    }
}
Write-Output "Gallery images: $ok downloaded, $skip already present, $($fail.Count) failed."
$fail | ForEach-Object { Write-Output "  FAILED $_" }
