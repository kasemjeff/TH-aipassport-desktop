# Copies the local Node into the sidecar slot Tauri's externalBin expects.
#
# The packaged app ships Node so it never depends on the machine having it:
# the whole backend is .mjs files run by this binary. Run this once per Node
# upgrade — the artifact itself is gitignored, because a 92 MB executable does
# not belong in a repo.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'node-x86_64-pc-windows-msvc.exe'
$node = (Get-Command node).Source
Copy-Item $node $target -Force
"sidecar ready: $target ($([math]::Round((Get-Item $target).Length/1MB)) MB, node $(node --version))"
