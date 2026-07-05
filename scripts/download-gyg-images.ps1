# Downloads each partner tour's source photo (image_url) into assets/img/gyg/<slug>.jpg,
# re-encoded as JPEG. Reads content/gyg/*.json.
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "assets\img\gyg"
New-Item -ItemType Directory -Force $dir | Out-Null
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$eparams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$eparams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)

$ok = 0; $fail = @()
foreach ($f in Get-ChildItem (Join-Path $root "content\gyg") -Filter *.json) {
    $g = Get-Content $f.FullName -Raw | ConvertFrom-Json
    foreach ($t in $g.gyg_tours) {
        if (-not $t.image_url) { continue }
        $dest = Join-Path $dir "$($t.slug).jpg"
        if (Test-Path $dest) { $ok++; continue }
        $tmp = Join-Path $env:TEMP "gyg_$($t.slug).img"
        try {
            Invoke-WebRequest -Uri $t.image_url -OutFile $tmp -UseBasicParsing -TimeoutSec 40 -Headers @{ "User-Agent" = "Mozilla/5.0" }
            $img = [System.Drawing.Image]::FromFile($tmp)
            $img.Save($dest, $codec, $eparams)
            $img.Dispose()
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            $ok++
        } catch {
            $fail += $t.slug
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        }
    }
}
Write-Output "Downloaded $ok GYG images. Failed: $($fail.Count)"
$fail | ForEach-Object { Write-Output "FAIL: $_" }
