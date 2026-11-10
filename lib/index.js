/**
 * cg-panel, host half.
 *
 * Registra dos rutas en el webServer del propio harness, o sea mismo origen que
 * la GUI: el navegador las pide con `fetch('/api/cg-panel/...')` y no hay CORS
 * ni puerto extra que mantener vivo.
 *
 *  - `/api/cg-panel/datos`  lectura local (prioridad, laptop, memoria), cache 45 s.
 *  - `/api/cg-panel/flota`  AIO y VPS por SSH, cache 240 s; `?forzar=1` la saltea.
 *
 * Las rutas se sueltan con `ctx.effect`: sin eso, apagar y volver a prender el
 * bundle en el mismo proceso choca con "duplicate exact route".
 *
 * Candado propio: el candado de auth del harness cubre el prefijo `/api`, pero
 * `WebServer.match` mira la tabla exacta antes que los prefijos, asi que una
 * ruta exacta `/api/cg-panel/...` quedaria fuera y respondería a cualquier
 * proceso local. Por eso cada handler exige que el socket venga de loopback y
 * responde 403 al resto: el panel solo habla con el navegador de la misma
 * maquina, que es de donde salen estos datos.
 *
 * @module cg-panel
 */
import { collectDatos, collectFlota } from './datos.js';

/** Identidad estable del Loader. */
export const name = 'cg-panel';

/** Direcciones que cuentan como loopback. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Topes de la peticion completa, por si una medicion se cuelga igual. */
const TOPE_DATOS_MS = 22_000;
const TOPE_FLOTA_MS = 30_000;

/**
 * El pedido viene del navegador de esta misma maquina.
 * @param {object} req - peticion HTTP de Node.
 * @returns {boolean} true solo para loopback.
 */
function esLoopback(req) {
  const direccion = req?.socket?.remoteAddress;
  return typeof direccion === 'string' && LOOPBACK.has(direccion);
}

/**
 * Correr una promesa con tope de tiempo.
 * @param {Promise<unknown>} promesa - trabajo a esperar.
 * @param {number} ms - tope en milisegundos.
 * @returns {Promise<{vencido: boolean, valor?: unknown}>} resultado o marca.
 */
async function conTope(promesa, ms) {
  let temporizador;
  const vence = new Promise((resolver) => {
    temporizador = setTimeout(() => resolver(null), ms);
    if (typeof temporizador?.unref === 'function') temporizador.unref();
  });
  try {
    const valor = await Promise.race([promesa, vence]);
    return valor === null ? { vencido: true } : { vencido: false, valor };
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * `webServer` es dependencia dura y no opcional: sin esto `apply` corre antes de
 * que el servidor HTTP exista, `ctx.get('webServer')` devuelve undefined y el
 * panel se queda sin rutas (la GUI muestra 404 "not found" en cada fetch).
 * Cordis llama a `apply` recien cuando la dependencia esta disponible, y la
 * vuelve a llamar si se cae.
 */
export const inject = ['webServer'];

/** Marca de "ya registrado" en el objeto del servidor, por proceso. */
const MARCA = Symbol.for('cg-panel.rutas');

/**
 * Contestar un JSON y cerrar.
 * @param {object} res - respuesta HTTP de Node.
 * @param {number} status - codigo.
 * @param {unknown} cuerpo - valor serializable.
 */
function responder(res, status, cuerpo) {
  let texto;
  try {
    texto = JSON.stringify(cuerpo);
  } catch (error) {
    status = 500;
    texto = JSON.stringify({ error: `No pude serializar la respuesta: ${String(error?.message ?? error)}` });
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(texto),
  });
  res.end(texto);
}

/**
 * Registrar una ruta tolerando que una instancia anterior ya la haya dejado
 * puesta: en ese caso se conserva la viva y no se rompe la activacion.
 * @param {object} server - el webServer del harness.
 * @param {object} route - ruta `{ kind, path, handler }`.
 * @returns {() => void} removedor de la ruta (no-op si ya existia).
 */
function registrar(server, route) {
  try {
    return server.register(route);
  } catch (error) {
    const mensaje = String(error?.message ?? error);
    if (/duplicate/i.test(mensaje)) return () => {};
    throw error;
  }
}

/**
 * Atender una ruta del panel: candado de loopback, tope de tiempo y JSON.
 * @param {object} req - peticion HTTP.
 * @param {object} res - respuesta HTTP.
 * @param {() => Promise<unknown>} fabricar - colector a correr.
 * @param {number} topeMs - tope total de la peticion.
 */
async function atender(req, res, fabricar, topeMs) {
  if (!esLoopback(req)) {
    responder(res, 403, { error: 'forbidden: only loopback clients' });
    return;
  }
  try {
    const { vencido, valor } = await conTope(fabricar(), topeMs);
    if (vencido) {
      responder(res, 504, { error: `sin respuesta despues de ${topeMs / 1000} s` });
      return;
    }
    responder(res, 200, valor);
  } catch (error) {
    responder(res, 500, { error: String(error?.message ?? error) });
  }
}

/**
 * Registrar las rutas del panel.
 * @param {object} ctx - alcance del perfil con `webServer` opcional.
 */
export function apply(ctx) {
  const server = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
  if (server === undefined || server === null) return;
  if (typeof server.register !== 'function') return;
  if (server[MARCA] === true) return;

  const quitar = [];

  quitar.push(registrar(server, {
    kind: 'exact',
    path: '/api/cg-panel/datos',
    async handler(req, res) {
      const forzar = typeof req?.url === 'string' && /[?&]forzar=1\b/.test(req.url);
      await atender(req, res, () => collectDatos({ forzar }), TOPE_DATOS_MS);
    },
  }));

  quitar.push(registrar(server, {
    kind: 'exact',
    path: '/api/cg-panel/flota',
    async handler(req, res) {
      const forzar = typeof req?.url === 'string' && /[?&]forzar=1\b/.test(req.url);
      await atender(req, res, () => collectFlota({ forzar }), TOPE_FLOTA_MS);
    },
  }));

  server[MARCA] = true;
  const soltar = () => {
    server[MARCA] = false;
    for (const quitarRuta of quitar) {
      try {
        quitarRuta();
      } catch {
        // El servidor ya puede estar cerrado: soltar una ruta no es fatal.
      }
    }
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => soltar, 'cg-panel: rutas del panel');
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', soltar);
  }
}
