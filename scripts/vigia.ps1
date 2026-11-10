#Requires -Version 7.0
<#
.SYNOPSIS
    Corre el vigia de cg-panel una vez y anota el resultado en el log.

.DESCRIPTION
    Lo llama la tarea programada `cg-panel-vigia` cada 15 minutos (y al iniciar
    sesion). Resuelve node, ejecuta scripts/vigia.mjs y agrega la salida a
    ~/.dsh/cg-panel-vigia.log, que rota a los 256 KB.

    A mano: pwsh vigia.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Raiz de DSH: `DSH_HOME` manda, si no la convencional del usuario. El log tiene
# que caer en la misma carpeta que el estado que escribe vigia.mjs.
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$log = Join-Path $dsh 'cg-panel-vigia.log'
$script = Join-Path $PSScriptRoot 'vigia.mjs'

if (-not (Test-Path $dsh)) { New-Item -ItemType Directory -Path $dsh -Force | Out-Null }

if (-not (Test-Path $script)) {
    Add-Content -Path $log -Value "[$(Get-Date -Format o)] falta el vigia: $script" -Encoding utf8
    exit 1
}

# En una tarea programada el PATH puede no traer el shim de nvm4w: se resuelve
# node por nombre y, si no esta, por las dos ubicaciones convencionales de
# Windows (instalador oficial y nvm4w).
$node = $null
$comando = Get-Command node -ErrorAction SilentlyContinue
if ($comando) { $node = $comando.Source }
if (-not $node) {
    foreach ($candidato in @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        'C:\nvm4w\nodejs\node.exe'
    )) {
        if (Test-Path $candidato) { $node = $candidato; break }
    }
}
if (-not $node) {
    Add-Content -Path $log -Value "[$(Get-Date -Format o)] no encontre node; el vigia no corrio" -Encoding utf8
    exit 1
}

# Rotacion: el log cuenta corridas cada 15 minutos, no puede crecer sin fin.
if (Test-Path $log) {
    $info = Get-Item $log
    if ($info.Length -gt 256KB) {
        $nuevas = Get-Content -Path $log -Tail 400
        Set-Content -Path $log -Value $nuevas -Encoding utf8
    }
}

$salida = & $node $script 2>&1
$codigo = $LASTEXITCODE
if ($salida) { Add-Content -Path $log -Value $salida -Encoding utf8 }
exit $codigo
