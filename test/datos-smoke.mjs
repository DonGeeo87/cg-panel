/**
 * Smoke del lado Host: corre la capa de datos sin DSH y comprueba el contrato.
 *
 * No imprime un panorama y se va: cada caso tiene assert real y el proceso sale
 * con codigo != 0 si alguna comprobacion falla, para que sirva de compuerta en
 * un CI o antes de publicar.
 *
 * Uso: node test/datos-smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Comprobaciones que fallaron, para el resumen final. */
const fallas = [];

/**
 * Correr un caso y anotar el resultado.
 * @param {string} nombre - que se comprueba.
 * @param {() => Promise<void> | void} caso - asserts del caso.
 */
async function probar(nombre, caso) {
  try {
    await caso();
    console.log(`ok    ${nombre}`);
  } catch (error) {
    fallas.push(`${nombre}: ${error.message}`);
    console.error(`FALLA ${nombre}: ${error.message}`);
  }
}

/** `stat` que devuelve null en vez de tirar. */
async function statORNull(ruta) {
  try {
    return await stat(ruta);
  } catch {
    return null;
  }
}

/**
 * Importar `lib/datos.js` con `DSH_HOME` apuntando a otra carpeta. Los modulos
 * leen `DSH_HOME` al cargarse, asi que cada caso pide una instancia nueva (la
 * query string evita la cache de ESM).
 * @param {string} dshHome - raiz de DSH a usar.
 * @returns {Promise<object>} el modulo cargado.
 */
async function cargarDatos(dshHome) {
  process.env.DSH_HOME = dshHome;
  const url = new URL('../lib/datos.js', import.meta.url);
  url.searchParams.set('caso', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return import(url.href);
}

/** Raiz de DSH de la maquina que corre el test. */
const DSH_REAL = process.env.DSH_HOME_CG_PANEL ?? path.join(os.homedir(), '.dsh');

/** Carpeta aislada: registro ausente, config ausente, sin sesiones. */
const AISLADO = await mkdtemp(path.join(os.tmpdir(), 'cg-panel-test-'));

try {
  await probar('registro de workspaces ausente -> ranking vacio, sin tirar', async () => {
    const datos = await cargarDatos(AISLADO);
    const { filas, resumen } = await datos.collectProyectos();
    assert.deepEqual(filas, [], 'un registro ausente tiene que dar []');
    assert.equal(resumen.proyectos, 0);
  });

  await probar('registro de workspaces corrupto -> ranking vacio, sin tirar', async () => {
    await mkdir(path.join(AISLADO, 'storages'), { recursive: true });
    await writeFile(path.join(AISLADO, 'storages', 'workspace.json'), '{ esto no es json', 'utf8');
    const datos = await cargarDatos(AISLADO);
    const { filas } = await datos.collectProyectos();
    assert.deepEqual(filas, [], 'un registro corrupto tiene que dar []');
  });

  await probar('flota sin configurar -> bloque omitido y sin SSH', async () => {
    const datos = await cargarDatos(AISLADO);
    const flota = await datos.collectFlota({ forzar: true });
    assert.equal(flota.omitido, true, 'sin configuracion la flota se omite');
    assert.deepEqual(flota.hosts, [], 'sin configuracion no hay hosts medidos');
  });

  await probar('collectDatos devuelve la estructura del panel', async () => {
    const datos = await cargarDatos(AISLADO);
    const payload = await datos.collectDatos({ forzar: true });
    assert.ok(Array.isArray(payload.prioridad), 'prioridad tiene que ser un array');
    assert.ok(Array.isArray(payload.avisos), 'avisos tiene que ser un array');
    assert.equal(typeof payload.generado, 'string', 'generado tiene que ser ISO');
    assert.ok(Number.isFinite(Date.parse(payload.generado)), 'generado tiene que parsear como fecha');
    assert.equal(typeof payload.resumen, 'object');
    assert.equal(typeof payload.resumen.proyectos, 'number');
    assert.equal(typeof payload.maquina, 'object', 'maquina tiene que existir aunque falle la medicion');
    assert.equal(payload.flotaConfigurada, false, 'sin configuracion la flota no esta configurada');
    // Sin config, el bloque de respaldo depende solo del log convencional de
    // `sync-dsh.ps1`: si existe se muestra, si no se omite.
    const logConvencional = path.join(os.homedir(), '.dsh-sync', 'sync.log');
    const hayLog = await statORNull(logConvencional) !== null;
    assert.equal('respaldo' in payload, hayLog, 'el bloque de respaldo sigue la existencia del log');
  });

  await probar('colectores vendorizados exportan sus funciones', async () => {
    const flota = await import('../lib/collect/flota-estado.js');
    const laptop = await import('../lib/collect/laptop-estado.js');
    const aio = await import('../lib/collect/aio-estado.js');
    const vps = await import('../lib/collect/vps-estado.js');
    assert.equal(typeof flota.collectFlotaEstado, 'function');
    assert.equal(typeof laptop.collectLaptopEstado, 'function');
    assert.equal(typeof aio.collectAioEstado, 'function');
    assert.equal(typeof vps.collectVpsEstado, 'function');
  });

  await probar('ranking real no vacio en una maquina con proyectos', async () => {
    const registro = await statORNull(path.join(DSH_REAL, 'storages', 'workspace.json'));
    const datos = await cargarDatos(DSH_REAL);
    const payload = await datos.collectDatos({ forzar: true });
    if (registro === null) {
      // Maquina sin DSH instalado: no hay ranking que exigir.
      assert.deepEqual(payload.prioridad, []);
      return;
    }
    // El registro existe; si sus workspaces siguen en disco el ranking no puede
    // venir vacio. Los que ya no existen se descartan a proposito.
    const algunProyecto = payload.resumen.proyectos > 0;
    if (!algunProyecto) {
      console.log('      (el registro real no tiene proyectos en disco: se omite la comprobacion)');
      return;
    }
    assert.ok(payload.prioridad.length > 0, 'hay proyectos medidos pero el ranking vino vacio');
    assert.ok(payload.prioridad.length <= 6, 'el panel recorta a seis filas');
    for (const fila of payload.prioridad) {
      assert.equal(typeof fila.titulo, 'string');
      assert.equal(typeof fila.puntaje, 'number');
      assert.ok(Array.isArray(fila.motivos));
    }
  });
} finally {
  await rm(AISLADO, { recursive: true, force: true });
}

if (fallas.length > 0) {
  console.error(`\n${fallas.length} comprobacion(es) fallaron`);
  process.exitCode = 1;
} else {
  console.log('\ntodo verde');
}
