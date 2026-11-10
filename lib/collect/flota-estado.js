// Tomado de cg-ops (mismo autor), 2026-11-10.
// Copia vendorizada: cg-panel se publica solo, sin depender de ../cg-ops.
// Cambio local respecto del original: `collectFlotaEstado` acepta `{ hosts }`
// para medir solo los hosts que la configuracion de cg-panel habilita.
/**
 * Collector for `flota_estado`: one snapshot of the three machines that make up
 * the setup — VPS, AIO and the laptop running the harness.
 *
 * The three collectors run in parallel and never reject as a group: a host that
 * does not answer becomes `reachable: false` with its error, because "the VPS is
 * down" is exactly the answer this tool exists to give. Alerts are computed here
 * (not in the card) so the model receives the same verdict the user sees.
 *
 * No DSH imports live here, so this module runs under plain Node for tests.
 *
 * @module cg-ops/collect/flota-estado
 */
import { collectAioEstado } from './aio-estado.js';
import { collectLaptopEstado } from './laptop-estado.js';
import { collectVpsEstado } from './vps-estado.js';

/** Disk and memory thresholds, in percent. */
const DISK_WARN = 85;
const DISK_BAD = 95;
const MEM_WARN = 92;
const BATTERY_WARN = 20;

/** Backup age thresholds, in minutes (36 h and 72 h). */
const BACKUP_WARN_MIN = 36 * 60;
const BACKUP_BAD_MIN = 72 * 60;

const HOSTS = [
  { id: 'vps', label: 'VPS', collect: collectVpsEstado, normalize: normalizeVps },
  { id: 'aio', label: 'AIO', collect: collectAioEstado, normalize: normalizeAio },
  { id: 'laptop', label: 'Laptop', collect: collectLaptopEstado, normalize: normalizeLaptop },
];

/**
 * "hace 12 min" from a minute count.
 * @param {unknown} minutes
 * @returns {string|null}
 */
function agoText(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `hace ${Math.round(hours)} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

/** Keep only the numbers the card and the model actually read. */
function cleanDisks(disks) {
  if (!Array.isArray(disks)) return [];
  return disks
    .filter((disk) => disk && typeof disk.mount === 'string')
    .map((disk) => ({
      mount: disk.mount,
      size: typeof disk.size === 'string' ? disk.size : (Number(disk.sizeGb) ? `${disk.sizeGb}G` : null),
      usedPct: Number.isFinite(disk.usedPct) ? disk.usedPct : null,
    }));
}

/**
 * @param {object} payload - raw `vps-estado` payload.
 * @returns {object} canonical host state.
 */
function normalizeVps(payload) {
  const containers = payload.containers ?? {};
  const problems = Array.isArray(containers.problems) ? containers.problems : [];
  return {
    id: 'vps',
    host: payload.host ?? 'vps',
    os: payload.os ?? null,
    uptimeHours: payload.uptimeHours ?? null,
    load: payload.load ?? null,
    cpuPct: null,
    mem: payload.mem ?? null,
    disks: cleanDisks(payload.disks),
    containers: {
      total: Number(containers.total) || 0,
      running: Number(containers.running) || 0,
      problems,
    },
    failedUnits: Array.isArray(payload.failedUnits) ? payload.failedUnits : [],
    backups: [],
    extras: {
      monitors: payload.monitors ?? null,
      rebootRequired: payload.rebootRequired === true,
    },
  };
}

/**
 * @param {object} payload - raw `aio-estado` payload.
 * @returns {object} canonical host state.
 */
function normalizeAio(payload) {
  const summary = payload.summary ?? {};
  const list = Array.isArray(payload.containers) ? payload.containers : [];
  const stopped = Array.isArray(summary.stopped) ? summary.stopped : [];
  const unhealthy = Array.isArray(summary.unhealthy) ? summary.unhealthy : [];
  const problems = list
    .filter((box) => stopped.includes(box.name) || unhealthy.includes(box.name))
    .map((box) => ({ name: box.name, state: box.state, status: box.status, health: box.health }));
  const repos = Array.isArray(payload.repos) ? payload.repos : [];
  return {
    id: 'aio',
    host: payload.host ?? 'aio',
    os: null,
    uptimeHours: payload.uptimeHours ?? null,
    load: payload.load ?? null,
    cpuPct: null,
    mem: payload.mem ?? null,
    disks: cleanDisks(payload.disks),
    containers: {
      total: Number(summary.total) || list.length,
      running: Number(summary.running) || 0,
      problems,
    },
    failedUnits: Array.isArray(payload.failedUnits) ? payload.failedUnits : [],
    backups: repos.map((repo) => ({
      name: repo.name,
      agoMin: Number.isFinite(repo.lastSnapshotAgoMin) ? repo.lastSnapshotAgoMin : null,
      ok: repo.ok === true,
      error: repo.error ?? null,
    })),
    extras: {
      whatsapp: payload.whatsapp ?? null,
    },
  };
}

/**
 * @param {object} payload - raw `laptop-estado` payload.
 * @returns {object} canonical host state.
 */
function normalizeLaptop(payload) {
  return {
    id: 'laptop',
    host: payload.host ?? 'laptop',
    os: payload.os ?? null,
    uptimeHours: payload.uptimeHours ?? null,
    load: null,
    cpuPct: payload.cpuPct ?? null,
    mem: payload.mem ?? null,
    disks: cleanDisks(payload.disks),
    containers: null,
    failedUnits: [],
    backups: [],
    extras: {
      battery: payload.battery ?? null,
      topProcs: Array.isArray(payload.topProcs) ? payload.topProcs : [],
      pendingReboot: payload.pendingReboot === true,
    },
  };
}

/**
 * Derive the alert list and the host color from one normalized host.
 * @param {object} host
 * @returns {{alerts: Array<{sev: 'bad'|'warn', text: string}>, color: 'ok'|'warn'|'bad'}}
 */
function judge(host) {
  /** @type {Array<{sev: 'bad'|'warn', text: string}>} */
  const alerts = [];

  if (host.reachable === false) {
    alerts.push({ sev: 'bad', text: `sin respuesta: ${host.error}` });
    return { alerts, color: 'bad' };
  }

  for (const disk of host.disks) {
    if (typeof disk.usedPct !== 'number') continue;
    if (disk.usedPct >= DISK_BAD) {
      alerts.push({ sev: 'bad', text: `disco ${disk.mount} al ${disk.usedPct}%` });
    } else if (disk.usedPct >= DISK_WARN) {
      alerts.push({ sev: 'warn', text: `disco ${disk.mount} al ${disk.usedPct}%` });
    }
  }

  if (typeof host.mem?.usedPct === 'number' && host.mem.usedPct >= MEM_WARN) {
    alerts.push({ sev: 'warn', text: `memoria al ${host.mem.usedPct}%` });
  }

  if (host.containers !== null) {
    for (const box of host.containers.problems) {
      if (box.state !== 'running') {
        alerts.push({ sev: 'bad', text: `contenedor abajo: ${box.name}` });
      } else {
        alerts.push({ sev: 'warn', text: `contenedor degradado: ${box.name}` });
      }
    }
    if (host.containers.total === 0) {
      alerts.push({ sev: 'bad', text: 'docker no devolvió contenedores' });
    }
  }

  for (const unit of host.failedUnits) {
    const when = agoText(unit.failedAgoMin);
    alerts.push({
      sev: 'warn',
      text: `unidad en failed: ${unit.unit}${when === null ? '' : ` (${when})`}`,
    });
  }

  for (const backup of host.backups) {
    if (backup.ok === false) {
      alerts.push({ sev: 'bad', text: `backup ${backup.name} ilegible: ${backup.error ?? 'sin detalle'}` });
      continue;
    }
    if (typeof backup.agoMin !== 'number') continue;
    if (backup.agoMin >= BACKUP_BAD_MIN) {
      alerts.push({ sev: 'bad', text: `backup ${backup.name} ${agoText(backup.agoMin)}` });
    } else if (backup.agoMin >= BACKUP_WARN_MIN) {
      alerts.push({ sev: 'warn', text: `backup ${backup.name} ${agoText(backup.agoMin)}` });
    }
  }

  const monitors = host.extras.monitors;
  if (monitors && Array.isArray(monitors.down) && monitors.down.length > 0) {
    const names = monitors.down.map((item) => item.name).slice(0, 3).join(', ');
    const extra = monitors.down.length > 3 ? ` y ${monitors.down.length - 3} más` : '';
    alerts.push({
      sev: 'warn',
      text: `monitor${monitors.down.length === 1 ? '' : 'es'} caído${monitors.down.length === 1 ? '' : 's'}: ${names}${extra}`,
    });
  }

  if (host.id === 'laptop') {
    const battery = host.extras.battery;
    if (battery && battery.onAc === false && battery.pct <= BATTERY_WARN) {
      alerts.push({ sev: 'warn', text: `batería al ${battery.pct}% y sin cargador` });
    }
    if (host.extras.pendingReboot === true) {
      alerts.push({ sev: 'warn', text: 'reinicio de Windows pendiente' });
    }
  }

  if (host.extras.rebootRequired === true) {
    alerts.push({ sev: 'warn', text: 'reinicio del servidor pendiente' });
  }

  const color = alerts.some((alert) => alert.sev === 'bad')
    ? 'bad'
    : (alerts.length > 0 ? 'warn' : 'ok');
  return { alerts, color };
}

/** One host: collect, normalize, judge. Never throws. */
async function snapshot(definition) {
  const base = { id: definition.id, label: definition.label };
  try {
    const payload = await definition.collect();
    const host = definition.normalize(payload);
    host.label = definition.label;
    host.reachable = true;
    const verdict = judge(host);
    host.alerts = verdict.alerts;
    host.color = verdict.color;
    return host;
  } catch (error) {
    const message = String(error?.message ?? error);
    const host = {
      ...base,
      reachable: false,
      error: message,
      host: null,
      os: null,
      uptimeHours: null,
      load: null,
      cpuPct: null,
      mem: null,
      disks: [],
      containers: null,
      failedUnits: [],
      backups: [],
      extras: {},
    };
    const verdict = judge(host);
    host.alerts = verdict.alerts;
    host.color = verdict.color;
    return host;
  }
}

/** One line the model can quote without reading the whole payload. */
function resumen(hosts) {
  return hosts
    .map((host) => {
      if (host.reachable === false) return `${host.label} sin respuesta`;
      const detail = host.alerts.length === 0
        ? ''
        : ` (${host.alerts.map((alert) => alert.text).join('; ')})`;
      return `${host.label} ${host.color}${detail}`;
    })
    .join(' · ');
}

/**
 * Read one snapshot of the whole fleet.
 * @param {{hosts?: string[]}} [opciones] - `hosts` limita la medicion a esos
 *   ids (`vps`, `aio`, `laptop`); sin el se miden los tres.
 * @returns {Promise<object>} the `flota-estado` payload.
 */
export async function collectFlotaEstado(opciones = {}) {
  const pedidos = Array.isArray(opciones.hosts)
    ? opciones.hosts.filter((id) => HOSTS.some((definition) => definition.id === id))
    : [];
  const elegidos = pedidos.length > 0 ? HOSTS.filter((definition) => pedidos.includes(definition.id)) : HOSTS;
  const hosts = await Promise.all(elegidos.map((definition) => snapshot(definition)));
  const bad = hosts.reduce(
    (total, host) => total + host.alerts.filter((alert) => alert.sev === 'bad').length,
    0,
  );
  const warn = hosts.reduce(
    (total, host) => total + host.alerts.filter((alert) => alert.sev === 'warn').length,
    0,
  );
  return {
    widget: 'flota-estado',
    takenAt: new Date().toISOString(),
    hosts,
    summary: {
      status: bad > 0 ? 'bad' : (warn > 0 ? 'warn' : 'ok'),
      hosts: hosts.length,
      reachable: hosts.filter((host) => host.reachable !== false).length,
      bad,
      warn,
    },
    resumen: resumen(hosts),
  };
}
