/**
 * cg-panel, configuracion del host.
 *
 * Todo lo que depende de la topologia de una maquina o de sus costumbres sale
 * de `~/.dsh/cg-panel.json` (o de `$DSH_HOME/cg-panel.json`): la flota por SSH,
 * la ruta del respaldo de memoria y el canal ntfy del vigia. Sin ese archivo el
 * panel arranca igual, solo que esconde los bloques que no puede medir, y el
 * vigia no manda avisos: nunca falla por falta de configuracion.
 *
 * Formato, con todas las secciones opcionales:
 *
 *   {
 *     "flota": { "hosts": ["vps", "aio", "laptop"] },
 *     "respaldo": { "log": "C:/ruta/sync.log", "repo": "C:/ruta" },
 *     "urls": ["https://ntfy.example"],
 *     "tema": "mi-tema",
 *     "discoWarn": 85,
 *     "discoBad": 93,
 *     "memoriaWarnHoras": 30,
 *     "memoriaBadHoras": 72,
 *     "cambiosInfo": 15,
 *     "dormidosInfo": 6,
 *     "ventanas": { "info": 168, "warn": 12, "bad": 3 }
 *   }
 *
 * Los nombres de configuracion (`flota`, `respaldo`, `urls`, `tema`, ...) se
 * mantienen en espanol a proposito: son la interfaz con el archivo que ya usa
 * la gente que instalo el panel.
 *
 * @module cg-panel/config
 */
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Raiz de DSH en el momento de la llamada: `DSH_HOME` gana para poder correr
 * los tests contra una carpeta vacia sin tocar el perfil real.
 * @returns {string} carpeta donde viven el registro de workspaces y la config.
 */
export function raizDsh() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

/** Archivo de configuracion del panel. */
export function rutaConfig() {
  return path.join(raizDsh(), 'cg-panel.json');
}

/** Hosts que sabe medir el colector de flota. */
export const IDS_FLOTA = ['vps', 'aio', 'laptop'];

/**
 * Ruta convencional del respaldo de memoria (`sync-dsh.ps1`). No es una ruta
 * personal: es la que usa esa herramienta en cualquier maquina.
 */
const RESPALDO_CONVENCIONAL = path.join(os.homedir(), '.dsh-sync', 'sync.log');

/** `stat` que devuelve null en vez de tirar. */
async function statORNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

/**
 * Leer la configuracion cruda. Archivo ausente, JSON roto o un valor que no sea
 * un objeto devuelven null: el panel sigue con los defaults.
 * @returns {Promise<object | null>} el objeto leido.
 */
export async function leerConfiguracion() {
  try {
    const crudo = JSON.parse(await readFile(rutaConfig(), 'utf8'));
    if (crudo === null || typeof crudo !== 'object' || Array.isArray(crudo)) return null;
    return crudo;
  } catch {
    return null;
  }
}

/**
 * Hosts de la flota que hay que medir.
 *
 * Sin `flota` en la configuracion devuelve null y el bloque se omite del JSON:
 * un SSH a hosts que solo existen en una red concreta no se dispara nunca por
 * accidente. `flota: true` (formato de la version 0.1.0) equivale a los tres
 * hosts; `flota: { hosts: [...] }` elige cuales.
 * @returns {Promise<{hosts: string[]} | null>} hosts habilitados o null.
 */
export async function flotaConfigurada() {
  const config = await leerConfiguracion();
  const flota = config?.flota;
  if (flota === undefined || flota === null || flota === false) return null;
  if (flota === true) return { hosts: [...IDS_FLOTA] };

  const pedidos = Array.isArray(flota) ? flota : flota?.hosts;
  if (pedidos === undefined || pedidos === null) return { hosts: [...IDS_FLOTA] };
  if (!Array.isArray(pedidos)) return null;
  const hosts = pedidos.filter((id) => IDS_FLOTA.includes(id));
  return hosts.length > 0 ? { hosts } : null;
}

/**
 * Log y repo del respaldo de memoria.
 *
 * `respaldo.log` manda. Sin esa clave se usa la ruta convencional de
 * `sync-dsh.ps1` solo si el archivo existe, que es la forma de que una maquina
 * con el respaldo andando lo siga viendo sin configurar nada y una maquina
 * ajena no muestre un bloque vacio.
 * @returns {Promise<{log: string, repo: string} | null>} rutas o null.
 */
export async function respaldoConfigurado() {
  const config = await leerConfiguracion();
  const respaldo = config?.respaldo;
  if (respaldo === false) return null;

  const logConfigurado = typeof respaldo?.log === 'string' && respaldo.log.trim().length > 0
    ? path.resolve(respaldo.log)
    : null;
  if (logConfigurado !== null) {
    const repo = typeof respaldo?.repo === 'string' && respaldo.repo.trim().length > 0
      ? path.resolve(respaldo.repo)
      : path.dirname(logConfigurado);
    return { log: logConfigurado, repo };
  }

  if (await statORNull(RESPALDO_CONVENCIONAL) === null) return null;
  return { log: RESPALDO_CONVENCIONAL, repo: path.dirname(RESPALDO_CONVENCIONAL) };
}

/**
 * Canal ntfy del vigia: base URLs y tema. Sin las dos cosas devuelve null y el
 * vigia no publica nada (sale limpio avisando que falta configurar).
 * @param {object | null} config - configuracion cruda.
 * @returns {{urls: string[], tema: string} | null} canal o null.
 */
export function canalesNtfy(config) {
  const urls = Array.isArray(config?.urls)
    ? config.urls.filter((url) => typeof url === 'string' && url.trim().length > 0).map((url) => url.trim())
    : [];
  const tema = typeof config?.tema === 'string' && config.tema.trim().length > 0 ? config.tema.trim() : null;
  if (urls.length === 0 || tema === null) return null;
  return { urls, tema };
}
