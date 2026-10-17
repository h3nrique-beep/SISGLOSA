$node = 'C:\Users\henri\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$projectRoot = Split-Path $PSScriptRoot -Parent

Set-Location $projectRoot
& $node (Join-Path $projectRoot 'server.js')
exit $LASTEXITCODE
