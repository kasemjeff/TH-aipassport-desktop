#!/usr/bin/env pwsh
# Put `aipass` on your PATH (Windows). No build, no compiled dependencies.
#
#   powershell -ExecutionPolicy Bypass -File aipass-bridge\install.ps1
#
# On Windows npm's global bin (%AppData%\npm) is normally on PATH, so `npm link`
# works without admin. If it doesn't, this prints the manual options.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')   # repo root (package.json with the bin entry)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'need Node (>= 18) on PATH - https://nodejs.org'
  exit 1
}
$major = [int](& node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if ($major -lt 18) {
  Write-Error "need Node >= 18 (have $(& node -v))"
  exit 1
}

& npm link
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  `npm link` failed. Options:'
  Write-Host '    - run this from an elevated PowerShell, or'
  Write-Host '    - npm config set prefix "$env:LOCALAPPDATA\npm"; npm link'
  Write-Host '      (then add that dir to your PATH), or'
  Write-Host "    - call it without installing:  node `"$(Join-Path (Get-Location) 'aipass-bridge\bin\aipass.mjs')`" --help"
  exit 1
}

$ext = Join-Path (Get-Location) 'aipass-bridge\extension'
Write-Host @"

  aipass is installed (npm link).

  One-time browser step (Chrome loads the extension by hand):
    1. open  chrome://extensions
    2. turn on  Developer mode
    3. Load unpacked  ->  select  $ext
    4. open  https://de.aipass.net/chat  and leave the tab open

  Then:
    aipass           open the chat (starts the bridge for you)
    aipass status    check node / bridge / extension
    aipass --help    everything else

  Uninstall:  npm rm -g aipass
"@
