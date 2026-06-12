$src  = "$PSScriptRoot\frontend"
$dest = "$PSScriptRoot\..\JoachimVN.github.io\choridor"

Write-Host "Syncing frontend -> choridor..." -ForegroundColor Cyan

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse

Set-Location $dest\..
git add choridor/
git commit -m "chore: sync CHORIDOR from CHORIDOR-web"
git push

Write-Host "Done." -ForegroundColor Green
