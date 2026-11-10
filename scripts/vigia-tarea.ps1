#Requires -Version 7.0
<#
.SYNOPSIS
    Instala, quita o consulta la tarea programada que corre el vigia de cg-panel.

.DESCRIPTION
    El vigia revisa la laptop y la flota y avisa por ntfy. Corre por el
    Programador de tareas de Windows (no dentro de DSH), asi funciona con el
    harness cerrado.

    Crea una sola tarea, `cg-panel-vigia`, cada 15 minutos. No crea disparador
    "al iniciar sesion": ese tipo de tarea exige elevacion (acceso denegado sin
    admin) y no hace falta, porque despues de un arranque el primer tick de los
    15 minutos corre igual.

    Uso:
      pwsh vigia-tarea.ps1 -Instalar
      pwsh vigia-tarea.ps1 -Estado
      pwsh vigia-tarea.ps1 -Correr
      pwsh vigia-tarea.ps1 -Quitar
#>
[CmdletBinding(DefaultParameterSetName = 'Estado')]
param(
    [Parameter(ParameterSetName = 'Instalar')][switch]$Instalar,
    [Parameter(ParameterSetName = 'Quitar')][switch]$Quitar,
    [Parameter(ParameterSetName = 'Correr')][switch]$Correr,
    [Parameter(ParameterSetName = 'Estado')][switch]$Estado
)

$ErrorActionPreference = 'Stop'

$nombre = 'cg-panel-vigia'
$envoltorio = Join-Path $PSScriptRoot 'vigia.ps1'
# Misma raiz que usa vigia.ps1: DSH_HOME si esta puesta, si no ~/.dsh.
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$log = Join-Path $dsh 'cg-panel-vigia.log'
$intervaloMin = 15

function Remove-Tareas {
    foreach ($tarea in @($nombre, "$nombre-logon")) {
        & schtasks.exe /delete /tn $tarea /f 2>$null | Out-Null
    }
}

function Show-Estado {
    Write-Host "Tarea del vigia:" -ForegroundColor Cyan
    $salida = & schtasks.exe /query /tn $nombre /fo LIST 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  $nombre : no instalada (pwsh vigia-tarea.ps1 -Instalar)" -ForegroundColor DarkGray
    } else {
        $estado = ($salida | Select-String '^Estado:|^Status:' | Select-Object -First 1).ToString().Trim()
        $proxima = ($salida | Select-String '^Pr.xima ejecuci.n:|^Next Run Time:' | Select-Object -First 1)
        $ultima = ($salida | Select-String '^.ltima ejecuci.n:|^Last Run Time:' | Select-Object -First 1)
        Write-Host "  $nombre : $estado" -ForegroundColor Green
        if ($proxima) { Write-Host "    $($proxima.ToString().Trim())" -ForegroundColor DarkGray }
        if ($ultima) { Write-Host "    $($ultima.ToString().Trim())" -ForegroundColor DarkGray }
    }
    if (Test-Path $log) {
        Write-Host ""
        Write-Host "Ultimas lineas del log ($log):" -ForegroundColor Cyan
        Get-Content $log -Tail 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
}

switch ($PSCmdlet.ParameterSetName) {
    'Instalar' {
        if (-not (Test-Path $envoltorio)) { throw "Falta el envoltorio: $envoltorio" }
        $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
        if (-not $pwsh) { $pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe' }
        if (-not (Test-Path $pwsh)) { throw "No encontre pwsh para programar la tarea." }

        $accion = "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$envoltorio`""
        Remove-Tareas

        & schtasks.exe /create /tn $nombre /tr $accion /sc minute /mo $intervaloMin /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "No pude crear la tarea $nombre (codigo $LASTEXITCODE)." }

        Write-Host "Instalada: $nombre, cada $intervaloMin minutos." -ForegroundColor Green
        & schtasks.exe /run /tn $nombre | Out-Null
        Write-Host "Primera corrida lanzada; el resultado queda en $log" -ForegroundColor DarkGray
    }
    'Quitar' {
        Remove-Tareas
        Write-Host "Quitadas: $nombre y $nombre-logon." -ForegroundColor Green
    }
    'Correr' {
        if (-not (Test-Path $envoltorio)) { throw "Falta el envoltorio: $envoltorio" }
        & $envoltorio
        Write-Host "Corrida terminada (codigo $LASTEXITCODE)." -ForegroundColor Green
    }
    default {
        Show-Estado
    }
}
