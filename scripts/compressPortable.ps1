param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
)

$ErrorActionPreference = "Stop"
Compress-Archive -LiteralPath $SourcePath -DestinationPath $DestinationPath -Force