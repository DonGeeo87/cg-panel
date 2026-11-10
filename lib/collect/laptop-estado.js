// Tomado de cg-ops (mismo autor), 2026-11-10.
// Copia vendorizada: cg-panel se publica solo, sin depender de ../cg-ops.
/**
 * Collector for the laptop this harness runs on.
 *
 * The DSH host is a Windows machine, so the snapshot is taken with PowerShell
 * (`Get-CimInstance`) and parsed as JSON. The script travels as
 * `-EncodedCommand` (UTF-16LE base64): that skips cmd/PowerShell quoting rules
 * entirely, which matters because the string is built in JavaScript and accents
 * and quotes have no business being escaped twice.
 *
 * No DSH imports live here, so this module runs under plain Node for tests.
 *
 * @module cg-ops/collect/laptop-estado
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const TIMEOUT_MS = 25_000;

/**
 * Read-only Windows snapshot. Single lines only: no backticks (they are escape
 * characters in the JS template below) and no `${...}` (it would interpolate).
 */
const POWERSHELL = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$takenAt = (Get-Date).ToString('o')
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$rawCpu = $null
try { (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime | Out-Null } catch { }
Start-Sleep -Milliseconds 700
try { $rawCpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime } catch { }
if ($null -eq $rawCpu) { $rawCpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average }
$cpu = [int]$rawCpu
$totalMiB = [math]::Round($cs.TotalPhysicalMemory / 1MB)
$freeMiB = [math]::Round($os.FreePhysicalMemory / 1KB)
$disks = @()
foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
  $sizeGb = [int][math]::Round($d.Size / 1GB)
  $freeGb = [int][math]::Round($d.FreeSpace / 1GB)
  $usedPct = 0
  if ($d.Size -gt 0) { $usedPct = [int][math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100) }
  $disks += [pscustomobject]@{ mount = $d.DeviceID; sizeGb = $sizeGb; availGb = $freeGb; usedPct = $usedPct }
}
$battery = $null
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
if ($null -ne $b) { $battery = [pscustomobject]@{ pct = [int]$b.EstimatedChargeRemaining; onAc = ($b.BatteryStatus -eq 2) } }
$topProcs = @()
foreach ($p in (Get-Process | Sort-Object WS -Descending | Select-Object -First 3)) {
  $topProcs += [pscustomobject]@{ name = $p.ProcessName; memMiB = [int][math]::Round($p.WS / 1MB) }
}
$pendingReboot = $false
foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')) {
  if (Test-Path $key) { $pendingReboot = $true }
}
$renames = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations).PendingFileRenameOperations
if ($renames) { $pendingReboot = $true }
$payload = [pscustomobject]@{
  takenAt = $takenAt
  host = $env:COMPUTERNAME
  os = ($os.Caption + ' build ' + $os.BuildNumber)
  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  cpuPct = $cpu
  mem = [pscustomobject]@{ totalMiB = [int]$totalMiB; usedPct = [int][math]::Round((($totalMiB - $freeMiB) / $totalMiB) * 100) }
  disks = $disks
  battery = $battery
  topProcs = $topProcs
  pendingReboot = $pendingReboot
}
$payload | ConvertTo-Json -Compress -Depth 6
`;

/** Base64 UTF-16LE, the encoding `-EncodedCommand` expects. */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Single-element arrays come back as bare objects from some PowerShell builds. */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * Read one snapshot of this laptop.
 * @returns {Promise<object>} normalized laptop state.
 */
export async function collectLaptopEstado() {
  const encoded = encodeCommand(POWERSHELL);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];

  let stdout;
  try {
    ({ stdout } = await run('pwsh', args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const detail = String(error?.stderr || error?.message || '').trim().split('\n').slice(-2).join(' | ');
      throw new Error(`No pude leer el estado de la laptop (PowerShell): ${detail || 'sin detalle'}`);
    }
    try {
      ({ stdout } = await run('powershell.exe', args, {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }));
    } catch (fallbackError) {
      const detail = String(fallbackError?.stderr || fallbackError?.message || '').trim().split('\n').slice(-2).join(' | ');
      throw new Error(`No pude leer el estado de la laptop (PowerShell): ${detail || 'sin detalle'}`);
    }
  }

  const text = String(stdout).trim();
  if (text.length === 0) throw new Error('La laptop devolvió una salida vacía.');

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`La laptop devolvió algo que no es JSON: ${text.slice(0, 200)}`);
  }

  const mem = raw.mem ?? {};
  return {
    widget: 'laptop-estado',
    takenAt: typeof raw.takenAt === 'string' ? raw.takenAt : new Date().toISOString(),
    host: String(raw.host ?? 'laptop'),
    os: typeof raw.os === 'string' ? raw.os.trim() : null,
    uptimeHours: Number.isFinite(raw.uptimeHours) ? raw.uptimeHours : null,
    cpuPct: Number.isFinite(raw.cpuPct) ? raw.cpuPct : null,
    mem: Number.isFinite(mem.usedPct)
      ? { totalMiB: Number(mem.totalMiB) || null, usedPct: mem.usedPct }
      : null,
    disks: toArray(raw.disks).map((disk) => ({
      mount: String(disk.mount ?? '?'),
      sizeGb: Number(disk.sizeGb) || null,
      availGb: Number(disk.availGb) || null,
      usedPct: Number.isFinite(disk.usedPct) ? disk.usedPct : null,
    })),
    battery: raw.battery && Number.isFinite(raw.battery.pct)
      ? { pct: raw.battery.pct, onAc: raw.battery.onAc === true }
      : null,
    topProcs: toArray(raw.topProcs)
      .filter((proc) => proc && typeof proc.name === 'string')
      .map((proc) => ({ name: proc.name, memMiB: Number(proc.memMiB) || null })),
    pendingReboot: raw.pendingReboot === true,
  };
}
