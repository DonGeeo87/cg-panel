/**
 * cg-panel, capa de datos.
 *
 * Todo lo que el panel muestra se arma aca, del lado del Host: el navegador
 * solo pide JSON y dibuja. Las lecturas son baratas a proposito (stat de
 * archivos, no lecturas de sesion completas), y lo caro (ssh a AIO y VPS) va
 * por una ruta aparte con cache, para que el panel pinte al instante.
 *
 * Los colectores de maquina y flota viven en `./collect/` (copia vendorizada de
 * cg-ops, mismo autor) para que el paquete publicado no dependa de un paquete
 * hermano que no viaja en el tarball. Lo que depende de la topologia de una
 * maquina concreta (hosts de la flota, ruta del respaldo de memoria) sale de
 * `./config.js`: sin esa configuracion el bloque no se mide y no se devuelve.
 *
 * @module cg-panel/datos
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectFlotaEstado } from './collect/flota-estado.js';
import { collectLaptopEstado } from './collect/laptop-estado.js';
import { flotaConfigurada, raizDsh, respaldoConfigurado } from './config.js';

const run = promisify(execFile);

const DIA_MS = 86400000;
const VENTANA_DIAS = 14;

/** Atributos de dirección de la vida media de la recencia, en dias. */
const VIDA_MEDIA_DIAS = 7;

/** Cache de la maquina: el PowerShell tarda ~1 s y no cambia por segundo. */
let cacheMaquina = { at: 0, value: null };
const MAQUINA_TTL_MS = 60_000;

/** Cache de la flota: dos SSH completos, no se pueden repetir por visita. */
let cacheFlota = { at: 0, value: null, enCurso: null };
const FLOTA_TTL_MS = 240_000;

/**
 * Topes por bloque. La peticion del panel nunca queda colgada: si una medicion
 * se pasa de su tope se devuelve el resto del panorama, con el bloque faltante
 * marcado, en vez de esperar a que termine.
 */
const TOPE_PRIORIDAD_MS = 12_000;
const TOPE_MAQUINA_MS = 20_000;
const TOPE_MEMORIA_MS = 8_000;

/** Resumen vacio, para cuando la medicion de proyectos se paso de tiempo. */
const RESUMEN_VACIO = {
  proyectos: 0,
  conPendientes: 0,
  sinGit: 0,
  conCambios: 0,
  dormidos: 0,
  hub: null,
};

/**
 * Correr una promesa con tope de tiempo.
 * @template T
 * @param {Promise<T>} promesa - trabajo a esperar.
 * @param {number} ms - tope en milisegundos.
 * @param {T} alVencer - valor que se devuelve si el tope gana.
 * @returns {Promise<T>} el resultado real o el de reemplazo.
 */
async function conTope(promesa, ms, alVencer) {
  let temporizador;
  const vence = new Promise((resolver) => {
    temporizador = setTimeout(() => resolver(null), ms);
    if (typeof temporizador?.unref === 'function') temporizador.unref();
  });
  try {
    const valor = await Promise.race([promesa, vence]);
    return valor === null ? alVencer : valor;
  } finally {
    clearTimeout(temporizador);
  }
}

/** `stat` que devuelve null en vez de tirar. */
async function statORNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

/**
 * Nombre del directorio donde el harness guarda las sesiones de una ruta.
 * Las barras pasan a guion y el dos puntos se descarta:
 * `C:\Users\me\Projects` -> `--C-Users-me-Projects--`
 * @param {string} workspacePath - ruta absoluta del workspace.
 * @returns {string} el nombre del directorio.
 */
function codificaSesiones(workspacePath) {
  return `--${workspacePath.replace(/\\/g, '-').replace(/:/g, '')}--`;
}

/**
 * Actividad de sesiones de un proyecto, sin abrir ninguna sesion: alcanza con
 * la fecha de modificacion de cada `.jsonl.zstd`.
 * @param {string} workspacePath - ruta absoluta del workspace.
 * @returns {Promise<{ultima: number | null, total: number, recientes: number}>}
 */
async function lecturaSesiones(workspacePath) {
  const dir = path.join(raizDsh(), 'sessions', codificaSesiones(workspacePath));
  let ultima = null;
  let total = 0;
  let recientes = 0;
  let entradas;
  try {
    entradas = await readdir(dir, { withFileTypes: true });
  } catch {
    return { ultima, total, recientes };
  }
  const ahora = Date.now();
  for (const entrada of entradas) {
    if (!entrada.isDirectory()) continue;
    total += 1;
    const info = await statORNull(path.join(dir, entrada.name, 'session.v4.jsonl.zstd'));
    if (info === null) continue;
    if (ultima === null || info.mtimeMs > ultima) ultima = info.mtimeMs;
    if (ahora - info.mtimeMs < VENTANA_DIAS * DIA_MS) recientes += 1;
  }
  return { ultima, total, recientes };
}

/**
 * Correr un comando git en un proyecto.
 * @param {string} workspacePath - ruta absoluta del workspace.
 * @param {string[]} args - argumentos despues de `-C <ruta>`.
 * @returns {Promise<string>} stdout.
 */
async function gitSalida(workspacePath, args) {
  const { stdout } = await run('git', ['-C', workspacePath, ...args], {
    timeout: 8000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout);
}

/**
 * Estado de git de un proyecto: fecha del ultimo commit y archivos con cambios
 * sin commitear. Estas son las dos senales que de verdad dicen "aca quedamos".
 * Si git no contesta, cae al truco de mirar el index y el HEAD.
 * @param {string} workspacePath - ruta absoluta del workspace.
 * @returns {Promise<{ultimo: number | null, cambios: number, esGit: boolean}>}
 */
async function lecturaGit(workspacePath) {
  const marcador = path.join(workspacePath, '.git');
  const info = await statORNull(marcador);
  if (info === null) return { ultimo: null, cambios: 0, esGit: false };

  try {
    const [log, status] = await Promise.all([
      gitSalida(workspacePath, ['log', '-1', '--format=%ct']),
      gitSalida(workspacePath, ['status', '--porcelain', '--untracked-files=no']),
    ]);
    const segundos = Number(String(log).trim());
    const cambios = String(status).split('\n').filter((linea) => linea.trim().length > 0).length;
    const ultimo = Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null;
    return { ultimo, cambios, esGit: true };
  } catch {
    // Respaldo sin git: el index se toca al preparar y el HEAD al commitear.
    let gitDir = marcador;
    if (info.isFile()) {
      try {
        const contenido = await readFile(marcador, 'utf8');
        const linea = contenido.split('\n').find((fila) => fila.startsWith('gitdir:'));
        if (linea === undefined) return { ultimo: null, cambios: 0, esGit: true };
        const destino = linea.slice('gitdir:'.length).trim();
        gitDir = path.isAbsolute(destino) ? destino : path.join(workspacePath, destino);
      } catch {
        return { ultimo: null, cambios: 0, esGit: true };
      }
    }
    const [indice, head] = await Promise.all([
      statORNull(path.join(gitDir, 'index')),
      statORNull(path.join(gitDir, 'HEAD')),
    ]);
    const ultimo = Math.max(indice?.mtimeMs ?? 0, head?.mtimeMs ?? 0) || null;
    const pendiente = indice !== null && head !== null && indice.mtimeMs > head.mtimeMs + 60_000;
    return { ultimo, cambios: pendiente ? 1 : 0, esGit: true };
  }
}

/**
 * Mapear con un tope de concurrencia: 36 proyectos lanzados a la vez abren 72
 * procesos git y en Windows eso se nota.
 * @template T, R
 * @param {T[]} items - elementos.
 * @param {number} tope - cuantos a la vez.
 * @param {(item: T) => Promise<R>} fn - trabajo por elemento.
 * @returns {Promise<R[]>} resultados en el mismo orden.
 */
async function enLotes(items, tope, fn) {
  const salida = new Array(items.length);
  let cursor = 0;
  const trabajadores = Array.from({ length: Math.min(tope, items.length) }, async () => {
    while (cursor < items.length) {
      const indice = cursor;
      cursor += 1;
      salida[indice] = await fn(items[indice]);
    }
  });
  await Promise.all(trabajadores);
  return salida;
}

/**
 * Marcas `(completar:` que quedaron en el AGENTS.md del proyecto.
 * @param {string} workspacePath - ruta absoluta del workspace.
 * @returns {Promise<number>} cuantas marcas quedan.
 */
async function lecturaPendientes(workspacePath) {
  try {
    const texto = await readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');
    return (texto.slice(0, 65_536).match(/\(completar:/g) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Leer el registro durable de workspaces. Archivo ausente, JSON roto o una
 * tabla con otra forma devuelven []: el panel pinta "sin proyectos" en vez de
 * devolver un 500.
 * @returns {Promise<Array<{id: string, path: string, title: string}>>}
 */
async function leerRegistro() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(raizDsh(), 'storages', 'workspace.json'), 'utf8'));
  } catch {
    return [];
  }
  const tabla = parsed?.tables?.workspaces;
  if (tabla === undefined || tabla === null) return [];
  const filas = Array.isArray(tabla)
    ? tabla
    : Object.entries(tabla).map(([id, valor]) => ({ id, ...(valor ?? {}) }));
  const orden = Array.isArray(parsed?.global?.workspaceIds) ? parsed.global.workspaceIds : [];
  const porId = new Map(filas.map((fila) => [fila.id, fila]));
  const ordenadas = orden.map((id) => porId.get(id)).filter((fila) => fila !== undefined);
  const resto = filas.filter((fila) => !orden.includes(fila.id));
  return [...ordenadas, ...resto].filter((fila) => typeof fila.path === 'string' && fila.path.length > 0);
}

/** Texto humano para una cantidad de dias. */
function hace(dias) {
  if (dias < 1 / 48) return 'recien';
  if (dias < 1) return `hace ${Math.round(dias * 24)} h`;
  if (dias < 45) return `hace ${Math.round(dias)} d`;
  return `hace ${Math.round(dias / 30)} meses`;
}

/**
 * Puntaje de prioridad: recencia con decaimiento exponencial, mas senales de
 * trabajo abierto (sesiones de las ultimas dos semanas, archivos sin commitear,
 * marcas pendientes en el AGENTS.md). Los motivos se devuelven uno por uno para
 * que el panel pueda explicar el orden en vez de solo mostrarlo.
 * @param {{dias: number, recientes: number, cambios: number, marcas: number}} señales
 * @returns {{puntaje: number, motivos: string[]}}
 */
function puntuar({ dias, recientes, cambios, marcas }) {
  const recencia = Math.exp(-dias / VIDA_MEDIA_DIAS);
  const motivos = [];
  let puntaje = 100 * recencia;
  if (recientes > 0) {
    puntaje += Math.min(recientes, 6) * 8;
    motivos.push(`${recientes} ${recientes === 1 ? 'sesion' : 'sesiones'} en ${VENTANA_DIAS} dias`);
  }
  motivos.push(`ultimo movimiento ${hace(dias)}`);
  if (cambios > 0) {
    puntaje += 8 + Math.min(cambios, 10) * 1.5;
    motivos.push(`${cambios} ${cambios === 1 ? 'archivo' : 'archivos'} sin commitear`);
  }
  if (marcas > 0) {
    puntaje += 6;
    motivos.push(`${marcas} ${marcas === 1 ? 'marca' : 'marcas'} por cerrar`);
  }
  return { puntaje: Math.round(puntaje), motivos };
}

/** Es el hub de tareas meta, no un proyecto. */
function esHub(espacio) {
  const normalizada = espacio.path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizada.endsWith('/default-workspace') || espacio.title === 'default-workspace';
}

/** Material pesado: no se abre como workspace. */
function esMaterial(espacio) {
  return /[\\/]_material([\\/]|$)/.test(espacio.path);
}

/**
 * Ranking de proyectos por "donde conviene seguir".
 * @returns {Promise<{filas: object[], resumen: object}>} ranking y totales.
 */
async function collectPrioridad() {
  const ahora = Date.now();
  const espacios = await leerRegistro();
  const hub = espacios.find((espacio) => esHub(espacio));
  const hubSesiones = hub === undefined ? null : await lecturaSesiones(hub.path);

  const proyectos = espacios.filter((espacio) => !esHub(espacio) && !esMaterial(espacio));
  const medidos = await enLotes(proyectos, 6, async (espacio) => {
    const info = await statORNull(espacio.path);
    if (info === null || !info.isDirectory()) return null;
    const [sesiones, git, marcas] = await Promise.all([
      lecturaSesiones(espacio.path),
      lecturaGit(espacio.path),
      lecturaPendientes(espacio.path),
    ]);
    // El registro de workspaces no guarda `updatedAt`; leerlo daba null y la
    // senal no puntuaba nunca. Quedan las dos que si existen: sesiones y git.
    const marcasTiempo = [sesiones.ultima, git.ultimo]
      .filter((valor) => typeof valor === 'number' && valor > 0);
    const ultimo = marcasTiempo.length > 0 ? Math.max(...marcasTiempo) : info.mtimeMs;
    const dias = Math.max(0, (ahora - ultimo) / DIA_MS);
    const { puntaje, motivos } = puntuar({
      dias,
      recientes: sesiones.recientes,
      cambios: git.cambios,
      marcas,
    });
    return {
      id: espacio.id,
      titulo: espacio.title ?? path.basename(espacio.path),
      ruta: espacio.path,
      puntaje,
      motivos,
      dias: Math.round(dias * 10) / 10,
      sesiones: sesiones.total,
      sesionesRecientes: sesiones.recientes,
      git: git.esGit,
      cambios: git.cambios,
      marcas,
    };
  });

  const filas = medidos.filter((fila) => fila !== null);
  const resumen = {
    proyectos: filas.length,
    conPendientes: filas.filter((fila) => fila.marcas > 0).length,
    sinGit: filas.filter((fila) => fila.git === false).length,
    conCambios: filas.filter((fila) => fila.cambios > 0).length,
    // Mismo umbral que el vigia (30 dias): el resumen y el aviso hablan de lo
    // mismo y no pueden discrepar.
    dormidos: filas.filter((fila) => fila.dias >= 30).length,
    hub: hubSesiones === null
      ? null
      : { recientes: hubSesiones.recientes, total: hubSesiones.total },
  };

  filas.sort((a, b) => b.puntaje - a.puntaje);
  return { filas, resumen };
}

/**
 * Todos los proyectos medidos y ordenados, sin recortar. Lo usa el vigia, que
 * necesita ver los 36 y no solo los seis primeros del panel.
 * @returns {Promise<{filas: object[], resumen: object}>} ranking completo.
 */
export async function collectProyectos() {
  return collectPrioridad();
}

/**
 * Estado de la laptop, normalizado para el panel. Nunca tira: si PowerShell no
 * responde devuelve `indisponible`, y si se pasa del tope devuelve la ultima
 * medicion marcada con `vencido` (una laptop saturada tarda mas de 20 s y eso no
 * es motivo para gritar "no pude leer la laptop").
 * @returns {Promise<object>} bloque `maquina`.
 */
async function collectMaquina() {
  const ahora = Date.now();
  if (cacheMaquina.value !== null && ahora - cacheMaquina.at < MAQUINA_TTL_MS) return cacheMaquina.value;
  let crudo;
  try {
    crudo = await conTope(collectLaptopEstado(), TOPE_MAQUINA_MS, null);
  } catch (error) {
    return { indisponible: String(error?.message ?? error) };
  }
  if (crudo === null) {
    if (cacheMaquina.value !== null) return { ...cacheMaquina.value, vencido: true };
    return { indisponible: 'la medicion se paso del tope de tiempo' };
  }
  const valor = {
    host: crudo.host ?? null,
    os: crudo.os ?? null,
    takeado: crudo.takenAt ?? null,
    uptimeHoras: crudo.uptimeHours ?? null,
    cpuPct: crudo.cpuPct ?? null,
    mem: crudo.mem ?? null,
    discos: Array.isArray(crudo.disks)
      ? crudo.disks.filter((disco) => (disco.sizeGb ?? 0) > 0)
      : [],
    bateria: crudo.battery ?? null,
    procesos: Array.isArray(crudo.topProcs) ? crudo.topProcs.slice(0, 3) : [],
  };
  cacheMaquina = { at: ahora, value: valor };
  return valor;
}

/**
 * Estado del respaldo de memoria (~/.dsh-sync hacia Forgejo).
 *
 * Ojo: la antiguedad del ultimo COMMIT no sirve como alarma. `sync-dsh.ps1` no
 * comitea si no hay cambios, asi que un dia tranquilo deja el ultimo commit
 * viejo con el respaldo perfectamente sano (medido el 2026-11-03: ultimo commit
 * de 36 h y `git status` limpio). Lo que importa es que el script haya corrido y
 * que no haya quedado nada sin comitear.
 * @param {{log: string, repo: string}} rutas - log del sync y repo de memoria,
 *   resueltos por `config.js`; si el bloque no esta configurado no se llama.
 * @returns {Promise<object>} `cuando`/`horas` del commit, `corrida`/`corridaHoras`
 *   de la ultima ejecucion (mtime de sync.log) y `pendientes` sin comitear.
 */
async function collectMemoria(rutas) {
  const salida = { cuando: null, horas: null, corrida: null, corridaHoras: null, pendientes: null };
  try {
    const { stdout } = await run('git', ['-C', rutas.repo, 'log', '-1', '--format=%ct'], {
      timeout: 8000,
      windowsHide: true,
    });
    const segundos = Number(String(stdout).trim());
    if (Number.isFinite(segundos) && segundos > 0) {
      const cuando = new Date(segundos * 1000);
      salida.cuando = cuando.toISOString();
      salida.horas = Math.round((Date.now() - cuando.getTime()) / 3_600_000);
    }
  } catch {
    // Sin commit legible el resto del bloque igual sirve.
  }
  try {
    const info = await stat(rutas.log);
    const corrida = new Date(info.mtimeMs);
    salida.corrida = corrida.toISOString();
    salida.corridaHoras = Math.round((Date.now() - corrida.getTime()) / 3_600_000);
  } catch {
    // Log borrado o nunca escrito: queda en null y se usa el commit como pista.
  }
  try {
    const { stdout } = await run('git', ['-C', rutas.repo, 'status', '--porcelain'], {
      timeout: 8000,
      windowsHide: true,
    });
    salida.pendientes = String(stdout).split('\n').filter((linea) => linea.trim() !== '').length;
  } catch {
    // Sin git status no se opina sobre pendientes.
  }
  return salida;
}

/**
 * Avisos derivados: lo que el panel tiene que gritar sin que se lo pidan.
 * @param {object} maquina - bloque `maquina`.
 * @param {{horas: number | null} | null} memoria - bloque `respaldo.memoria`, o
 *   null cuando el respaldo no esta configurado en esta maquina.
 * @param {object} resumen - totales de proyectos.
 * @returns {Array<{nivel: string, texto: string}>}
 */
function collectAvisos(maquina, memoria, resumen) {
  const avisos = [];
  if (maquina.indisponible !== undefined) {
    avisos.push({ nivel: 'warn', texto: `No pude leer la laptop: ${maquina.indisponible}` });
  }
  for (const disco of maquina.discos ?? []) {
    if (typeof disco.usedPct === 'number' && disco.usedPct >= 85) {
      avisos.push({
        nivel: disco.usedPct >= 93 ? 'bad' : 'warn',
        texto: `Disco ${disco.mount} al ${Math.round(disco.usedPct)}% (quedan ${disco.availGb ?? '?'} GB)`,
      });
    }
  }
  // La CPU se mide en un instante: un pico de 3 s no es un problema. Solo
  // avisa si esta clavada.
  if (typeof maquina.cpuPct === 'number' && maquina.cpuPct >= 95) {
    avisos.push({ nivel: 'warn', texto: `CPU al ${Math.round(maquina.cpuPct)}%` });
  }
  if (maquina.bateria !== null && maquina.bateria !== undefined
    && maquina.bateria.onAc === false && maquina.bateria.pct <= 20) {
    avisos.push({ nivel: 'warn', texto: `Bateria al ${maquina.bateria.pct}% y sin cargador` });
  }
  // La alarma es "el script dejo de correr", no "no hubo commits": sin cambios
  // no hay commit y eso es normal. Sin respaldo configurado no hay nada que
  // opinar: el bloque entero se omite.
  const horasRespaldo = memoria === null ? null : (memoria.corridaHoras ?? memoria.horas);
  if (horasRespaldo !== null && horasRespaldo !== undefined && horasRespaldo > 30) {
    avisos.push({
      nivel: horasRespaldo > 72 ? 'bad' : 'warn',
      texto: `El respaldo de memoria (~/.dsh) no corre hace ${Math.round(horasRespaldo)} h`,
    });
  } else if (typeof memoria?.pendientes === 'number' && memoria.pendientes > 0) {
    avisos.push({
      nivel: 'warn',
      texto: `El respaldo de memoria (~/.dsh) tiene ${memoria.pendientes} archivo(s) sin comitear`,
    });
  }
  if (resumen.sinGit > 0) {
    avisos.push({
      nivel: 'info',
      texto: `${resumen.sinGit} ${resumen.sinGit === 1 ? 'proyecto no esta' : 'proyectos no estan'} en Forgejo (sin git)`,
    });
  }
  if (resumen.conPendientes > 0) {
    avisos.push({
      nivel: 'info',
      texto: `${resumen.conPendientes} AGENTS.md con marcas (completar:)`,
    });
  }
  return avisos;
}

/** Cache del payload rapido: abrir y cerrar el panel no debe repetir 72 git. */
let cacheDatos = { at: 0, value: null };
const DATOS_TTL_MS = 45_000;

/**
 * Panorama completo, sin recortar ni cachear: proyectos, maquina, memoria y
 * avisos. Es lo que usa el vigia (`scripts/vigia.mjs`), que necesita los 36
 * proyectos y no los seis del panel.
 * @returns {Promise<object>} datos frescos.
 */
export async function collectPanorama() {
  const respaldo = await respaldoConfigurado();
  const [prioridad, maquina, memoria] = await Promise.all([
    conTope(collectPrioridad(), TOPE_PRIORIDAD_MS, { filas: [], resumen: RESUMEN_VACIO, vencido: true }),
    // `collectMaquina` ya aplica su propio tope y devuelve la medicion previa.
    collectMaquina(),
    respaldo === null
      ? Promise.resolve(null)
      : conTope(collectMemoria(respaldo), TOPE_MEMORIA_MS, {
        cuando: null,
        horas: null,
        corrida: null,
        corridaHoras: null,
        pendientes: null,
        vencido: true,
      }),
  ]);
  const avisos = collectAvisos(maquina, memoria, prioridad.resumen);
  if (prioridad.vencido === true) {
    avisos.unshift({ nivel: 'warn', texto: 'La medicion de proyectos se paso de 12 s: el ranking puede venir incompleto' });
  }
  return {
    generado: new Date().toISOString(),
    filas: prioridad.filas,
    resumen: prioridad.resumen,
    maquina,
    memoria,
    avisos,
  };
}

/**
 * Estado del vigia, si ya corrio alguna vez.
 * @returns {Promise<object | null>} `{ultimaCorrida, ultimoEnvio, activos}`.
 */
async function leerVigia() {
  try {
    const crudo = JSON.parse(await readFile(path.join(raizDsh(), 'cg-panel-vigia.json'), 'utf8'));
    return {
      ultimaCorrida: typeof crudo?.ultimaCorrida === 'string' ? crudo.ultimaCorrida : null,
      ultimoEnvio: typeof crudo?.ultimoEnvio === 'string' ? crudo.ultimoEnvio : null,
      activos: Array.isArray(crudo?.activos) ? crudo.activos.slice(0, 8) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Payload rapido del panel: lectura local, sin SSH.
 *
 * `respaldo` se omite entero cuando esta maquina no tiene respaldo de memoria
 * configurado, y `flotaConfigurada` es lo que el navegador mira para decidir si
 * pide (y dibuja) el bloque de la flota.
 * @param {{forzar?: boolean}} [opciones] - `forzar` ignora la cache vigente.
 * @returns {Promise<object>} bloque `/api/cg-panel/datos`.
 */
export async function collectDatos(opciones = {}) {
  if (opciones.forzar !== true
    && cacheDatos.value !== null
    && Date.now() - cacheDatos.at < DATOS_TTL_MS) {
    return cacheDatos.value;
  }
  const panorama = await collectPanorama();
  const flota = await flotaConfigurada();
  const valor = {
    generado: panorama.generado,
    prioridad: panorama.filas.slice(0, 6),
    resumen: panorama.resumen,
    maquina: panorama.maquina,
    ...(panorama.memoria === null ? {} : { respaldo: { memoria: panorama.memoria } }),
    flotaConfigurada: flota !== null,
    vigia: await leerVigia(),
    avisos: panorama.avisos,
  };
  cacheDatos = { at: Date.now(), value: valor };
  return valor;
}

/**
 * Payload lento del panel: AIO, VPS y laptop via SSH, con cache y sin
 * solaparse entre visitas concurrentes. Si la flota no esta configurada no se
 * dispara ningun SSH: se devuelve un payload marcado con `omitido: true`.
 * @param {{forzar?: boolean}} [opciones] - `forzar` ignora la cache vigente.
 * @returns {Promise<object>} bloque `/api/cg-panel/flota`.
 */
export async function collectFlota(opciones = {}) {
  const config = await flotaConfigurada();
  if (config === null) {
    return {
      widget: 'flota-estado',
      omitido: true,
      hosts: [],
      summary: { status: 'ok', hosts: 0, reachable: 0, bad: 0, warn: 0 },
      resumen: 'flota no configurada',
    };
  }
  const ahora = Date.now();
  const vigente = cacheFlota.value !== null && ahora - cacheFlota.at < FLOTA_TTL_MS;
  if (opciones.forzar !== true && vigente) return cacheFlota.value;
  if (cacheFlota.enCurso !== null) return cacheFlota.enCurso;
  cacheFlota.enCurso = (async () => {
    try {
      const valor = await collectFlotaEstado({ hosts: config.hosts });
      cacheFlota = { at: Date.now(), value: valor, enCurso: null };
      return valor;
    } catch (error) {
      cacheFlota = { at: cacheFlota.at, value: cacheFlota.value, enCurso: null };
      return { widget: 'flota-estado', error: String(error?.message ?? error) };
    }
  })();
  return cacheFlota.enCurso;
}
