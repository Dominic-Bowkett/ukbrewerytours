# Downloads all old-site images referenced in content/ into assets/img/.
# Full-size versions are fetched by stripping WordPress -WxH size suffixes,
# falling back to the sized URL if the full-size file doesn't exist.
$ErrorActionPreference = "Continue"
$root = Split-Path $PSScriptRoot -Parent
$imgDir = Join-Path $root "assets\img"
New-Item -ItemType Directory -Force $imgDir | Out-Null

$files = @(Get-ChildItem (Join-Path $root "content") -Recurse -Include *.json, *.md)
$urls = @{}
foreach ($f in $files) {
    $text = Get-Content $f.FullName -Raw
    foreach ($m in [regex]::Matches($text, 'https://(?:www\.)?ukbrewerytours\.com/wp-content/uploads/[^\s"''\)\]]+\.(?:jpg|jpeg|png|webp)')) {
        $urls[$m.Value] = $true
    }
}

$ok = 0; $fallback = 0; $failed = @()
foreach ($url in $urls.Keys) {
    if ($url -match '/2026/03/ChIJ') { continue }  # Google review avatars — not reused
    $base = [System.Uri]::UnescapeDataString(($url -split '/')[-1])
    $stripped = $base -replace '-\d+x\d+(?=\.\w+$)', ''
    $dest = Join-Path $imgDir $stripped
    if (Test-Path $dest) { $ok++; continue }
    $fullUrl = $url -replace [regex]::Escape($base), $stripped
    try {
        Invoke-WebRequest -Uri $fullUrl -OutFile $dest -UseBasicParsing -TimeoutSec 30 | Out-Null
        $ok++
    } catch {
        try {
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 30 | Out-Null
            $fallback++
        } catch {
            $failed += $url
            if (Test-Path $dest) { Remove-Item $dest -Force }
        }
    }
}
Write-Output "Downloaded: $ok full-size, $fallback sized-fallback, $($failed.Count) failed"
$failed | ForEach-Object { Write-Output "FAILED: $_" }
