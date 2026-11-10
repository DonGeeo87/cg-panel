/**
 * cg-panel, vigia.
 *
 * Mira la laptop, los respaldos y la flota, y avisa por ntfy lo que se salio de
 * rango. Corre por tarea programada (ver `vigia-tarea.ps1`), asi que funciona
 * con DSH cerrado y sobrevive a que la app este apagada.
 *
 * Regla contra el ruido: un aviso se manda cuando aparece, cuando empeora de
 * nivel, o cuando vencio la ventana de silencio de su nivel (info 7 dias,
 * warn 12 h, bad 3 h). Cuando la condicion se resuelve, la clave se borra y la
 * proxima vez vuelve a sonar.
 *
 * Uso: node scripts/vigia.mjs [--simular]
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canalesNtfy, flotaConfigurada, leerConfiguracion, raizDsh, rutaConfig } from '../lib/config.js';
import { collectFlota, collectPanorama } from '../lib/datos.js';

// Proceso corto: la raiz se resuelve una vez al arrancar.
const DSH = raizDsh();
const CONFIG = rutaConfig();
const ESTADO = path.join(DSH, 'cg-panel-vigia.json');
const TOKEN = path.join(DSH, '.ntfy-token');

/** Orden de severidad, para decidir si un aviso "empeoro". */
const ORDEN = { info: 1, warn: 2, bad: 3 };
const PRIORIDAD = { info: 'low', warn: 'default', bad: 'high' };
const ETIQUETA = { info: 'information_source', warn: 'warning', bad: 'rotating_light' };
const MARCA = { info: '-', warn: '!', bad: '!!' };

/**
 * Ajustes por defecto de los umbrales; `~/.dsh/cg-panel.json` los pisa campo por
 * campo. El canal ntfy (base URLs y tema) no vive aca: sale de `lib/config.js`
 * y, sin configuracion, el vigia no publica nada en vez de inventar un default.
 */
const AJUSTES = {
  discoWarn: 85,
  discoBad: 93,
  memoriaWarnHoras: 30,
  memoriaBadHoras: 72,
  cambiosInfo: 15,
  dormidosInfo: 6,
  ventanas: { info: 168, warn: 12, bad: 3 },
};

/** Leer un JSON y devolver null si no existe o esta roto. */
async function leerJson(ruta) {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Ajustes efectivos: defaults, despues el archivo.
 * @param {object | null} guardados - configuracion cruda ya leida.
 * @returns {object} umbrales con los defaults puestos.
 */
function cargarAjustes(guardados) {
  if (guardados === null || typeof guardados !== 'object') {
    return { ...AJUSTES, ventanas: { ...AJUSTES.ventanas } };
  }
  return {
    ...AJUSTES,
    ...guardados,
    ventanas: { ...AJUSTES.ventanas, ...(guardados.ventanas ?? {}) },
  };
}

/**
 * Nombres legibles de una lista de contenedores o de units. Los colectores
 * devuelven objetos ({name}, {unit}), asi que un `join` a secas mandaba
 * "[object Object]" al telefono.
 * @param {Array<unknown>} lista - elementos crudos.
 * @returns {string} hasta cuatro nombres separados por coma.
 */
function nombres(lista) {
  return lista
    .slice(0, 4)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item !== null && typeof item === 'object') {
        return String(item.name ?? item.unit ?? item.id ?? '?');
      }
      return String(item);
    })
    .join(', ');
}

/**
 * Armar la lista de avisos a partir de lo medido.
 * @param {object} panorama - salida de `collectPanorama()`.
 * @param {object | null} flota - salida de `collectFlota()`, o null.
 * @param {object} ajustes - umbrales efectivos.
 * @returns {Array<{clave: string, nivel: string, texto: string}>}
 */
function revisar(panorama, flota, ajustes) {
  const avisos = [];
  const maquina = panorama.maquina ?? {};

  if (maquina.indisponible !== undefined) {
    avisos.push({ clave: 'laptop:lectura', nivel: 'warn', texto: `No pude leer la laptop: ${maquina.indisponible}` });
  }
  for (const disco of maquina.discos ?? []) {
    if (typeof disco.usedPct !== 'number') continue;
    const libre = typeof disco.availGb === 'number' ? `${disco.availGb} GB libres` : 'sin dato de espacio';
    if (disco.usedPct >= ajustes.discoBad) {
      avisos.push({ clave: `disco:${disco.mount}`, nivel: 'bad', texto: `Disco ${disco.mount} al ${Math.round(disco.usedPct)}% (${libre})` });
    } else if (disco.usedPct >= ajustes.discoWarn) {
      avisos.push({ clave: `disco:${disco.mount}`, nivel: 'warn', texto: `Disco ${disco.mount} al ${Math.round(disco.usedPct)}% (${libre})` });
    }
  }
  if (maquina.bateria !== null && maquina.bateria !== undefined
    && maquina.bateria.onAc === false && maquina.bateria.pct <= 15) {
    avisos.push({ clave: 'bateria', nivel: 'warn', texto: `Bateria al ${maquina.bateria.pct}% y sin cargador` });
  }

  // Mide la ultima CORRIDA del sync (~/.dsh-sync/sync.log), no el ultimo
  // commit: sin cambios no hay commit y ese silencio no es una falla.
  const horasMemoria = panorama.memoria?.corridaHoras ?? panorama.memoria?.horas;
  if (typeof horasMemoria === 'number') {
    if (horasMemoria >= ajustes.memoriaBadHoras) {
      avisos.push({ clave: 'memoria', nivel: 'bad', texto: `El respaldo de memoria no corre hace ${Math.round(horasMemoria)} h` });
    } else if (horasMemoria >= ajustes.memoriaWarnHoras) {
      avisos.push({ clave: 'memoria', nivel: 'warn', texto: `El respaldo de memoria no corre hace ${Math.round(horasMemoria)} h` });
    } else if (typeof panorama.memoria?.pendientes === 'number' && panorama.memoria.pendientes > 0) {
      avisos.push({ clave: 'memoria', nivel: 'warn', texto: `El respaldo de memoria tiene ${panorama.memoria.pendientes} archivo(s) sin comitear` });
    }
  }

  for (const host of flota?.hosts ?? []) {
    const etiqueta = host.label ?? host.id;
    if (host.reachable === false) {
      // El AIO puede estar apagado de noche: solo el VPS es una caida de verdad.
      const nivel = host.id === 'vps' ? 'bad' : 'info';
      avisos.push({ clave: `host:${host.id}`, nivel, texto: `${etiqueta} sin respuesta` });
      continue;
    }
    const problemas = Array.isArray(host.containers?.problems) ? host.containers.problems : [];
    if (problemas.length > 0) {
      avisos.push({
        clave: `contenedores:${host.id}`,
        nivel: problemas.length > 2 ? 'bad' : 'warn',
        texto: `${etiqueta}: ${problemas.length} contenedor(es) con problema (${nombres(problemas)})`,
      });
    }
    const units = Array.isArray(host.failedUnits) ? host.failedUnits : [];
    if (units.length > 0) {
      avisos.push({
        clave: `units:${host.id}`,
        nivel: 'warn',
        texto: `${etiqueta}: systemd caido -> ${nombres(units)}`,
      });
    }
  }

  const pesados = (panorama.filas ?? [])
    .filter((fila) => fila.cambios >= ajustes.cambiosInfo)
    .slice(0, 3);
  for (const fila of pesados) {
    avisos.push({
      clave: `trabajo:${fila.id}`,
      nivel: 'info',
      texto: `${fila.titulo}: ${fila.cambios} archivos sin commitear`,
    });
  }

  const sinGit = panorama.resumen?.sinGit ?? 0;
  if (sinGit > 0) {
    avisos.push({ clave: 'singit', nivel: 'info', texto: `${sinGit} proyecto(s) sin git, fuera de Forgejo` });
  }
  const dormidos = (panorama.filas ?? []).filter((fila) => fila.dias >= 30).length;
  if (dormidos >= ajustes.dormidosInfo) {
    avisos.push({ clave: 'dormidos', nivel: 'info', texto: `${dormidos} proyectos sin tocar hace 30+ dias` });
  }
  const marcas = panorama.resumen?.conPendientes ?? 0;
  if (marcas > 0) {
    avisos.push({ clave: 'agentes', nivel: 'info', texto: `${marcas} AGENTS.md con marcas (completar:)` });
  }

  return avisos;
}

/**
 * Leer la clave de acceso a ntfy, si existe (`~/.dsh/.ntfy-token`, texto plano).
 * Hoy ntfy del AIO no la pide; queda soportada para cuando se cierre el acceso.
 * @returns {Promise<string | null>} la clave o null.
 */
async function leerToken() {
  try {
    const texto = (await readFile(TOKEN, 'utf8')).trim();
    return texto.length > 0 ? texto : null;
  } catch {
    return null;
  }
}

/**
 * Publicar un aviso en ntfy, probando cada base URL hasta que una conteste.
 * @param {{urls: string[], tema: string}} canal - canal ntfy configurado.
 * @param {string} titulo - cabecera Title.
 * @param {string} cuerpo - texto del mensaje.
 * @param {string} nivel - info|warn|bad.
 * @returns {Promise<{url: string, id: string} | null>} exito o null.
 */
async function publicar(canal, titulo, cuerpo, nivel) {
  const cabeceras = {
    'content-type': 'text/plain; charset=utf-8',
    Title: titulo,
    Priority: PRIORIDAD[nivel] ?? 'default',
    Tags: ETIQUETA[nivel] ?? 'information_source',
  };
  const crudo = (await leerToken()) ?? '';
  if (crudo.length > 0) cabeceras.Authorization = `Bearer ${crudo}`;

  for (const base of canal.urls) {
    const url = `${String(base).replace(/\/+$/, '')}/${canal.tema}`;
    try {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: cabeceras,
        body: cuerpo,
        signal: AbortSignal.timeout(10_000),
      });
      if (!respuesta.ok) continue;
      const datos = await respuesta.json();
      return { url, id: String(datos?.id ?? '') };
    } catch {
      // Sin red o ntfy abajo: probar la siguiente base URL.
    }
  }
  return null;
}

/** Recortar el estado: claves muy viejas no sirven de nada. */
function podar(claves) {
  const limite = Date.now() - 45 * 86_400_000;
  const limpio = {};
  for (const [clave, valor] of Object.entries(claves)) {
    if (typeof valor?.enviado === 'number' && valor.enviado > limite) limpio[clave] = valor;
  }
  return limpio;
}

async function main() {
  const simular = process.argv.includes('--simular');
  const config = await leerConfiguracion();
  const ajustes = cargarAjustes(config);
  const canal = canalesNtfy(config);
  const flota = await flotaConfigurada();
  const previo = (await leerJson(ESTADO)) ?? {};
  const claves = { ...(previo.claves ?? {}) };

  const [panorama, flotaDatos] = await Promise.all([
    collectPanorama(),
    flota === null ? Promise.resolve(null) : collectFlota({ forzar: true }),
  ]);
  const avisos = revisar(panorama, flotaDatos, ajustes);
  const ahora = Date.now();

  const salen = [];
  const presentes = new Set();
  for (const aviso of avisos) {
    presentes.add(aviso.clave);
    const guardado = claves[aviso.clave];
    const horas = guardado === undefined ? Number.POSITIVE_INFINITY : (ahora - guardado.enviado) / 3_600_000;
    const empeoro = guardado === undefined || ORDEN[aviso.nivel] > ORDEN[guardado.nivel];
    if (empeoro || horas >= (ajustes.ventanas[aviso.nivel] ?? 12)) {
      salen.push(aviso);
      claves[aviso.clave] = { nivel: aviso.nivel, enviado: ahora };
    } else {
      claves[aviso.clave] = { nivel: aviso.nivel, enviado: guardado.enviado };
    }
  }
  for (const clave of Object.keys(claves)) {
    if (!presentes.has(clave)) delete claves[clave];
  }

  let envio = null;
  let sinCanal = false;
  if (salen.length > 0 && !simular) {
    if (canal === null) {
      // Sin canal configurado no hay a donde publicar. Se sale limpio y las
      // claves quedan sin marca, asi suenan cuando alguien configure el canal.
      sinCanal = true;
      for (const aviso of salen) delete claves[aviso.clave];
    } else {
      const nivel = salen.reduce((maximo, aviso) => (ORDEN[aviso.nivel] > ORDEN[maximo] ? aviso.nivel : maximo), 'info');
      const titulo = salen.length === 1
        ? `CG: ${salen[0].texto.slice(0, 70)}`
        : `CG panel: ${salen.length} avisos`;
      const cuerpo = [
        ...salen.map((aviso) => `[${MARCA[aviso.nivel] ?? '-'}] ${aviso.texto}`),
        '',
        `Laptop ${panorama.maquina?.host ?? '?'} · ${panorama.resumen?.proyectos ?? 0} proyectos · ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`,
      ].join('\n');
      envio = await publicar(canal, titulo, cuerpo, nivel);
      if (envio === null) {
        // No se pudo avisar: dejar esas claves sin marca para reintentar a la proxima.
        for (const aviso of salen) delete claves[aviso.clave];
      }
    }
  }

  const estado = {
    ultimaCorrida: new Date(ahora).toISOString(),
    ultimoEnvio: envio === null ? (previo.ultimoEnvio ?? null) : new Date(ahora).toISOString(),
    activos: avisos.map((aviso) => ({ clave: aviso.clave, nivel: aviso.nivel, texto: aviso.texto })),
    claves: simular ? { ...(previo.claves ?? {}) } : podar(claves),
    ultimoCanal: envio?.url ?? (previo.ultimoCanal ?? null),
  };
  // Escritura atomica: el panel lee este archivo mientras el vigia lo escribe, y
  // un JSON a medio escribir lo hacia mostrar la corrida anterior como sana.
  const temporal = `${ESTADO}.${process.pid}.tmp`;
  await writeFile(temporal, JSON.stringify(estado, null, 1), 'utf8');
  await rename(temporal, ESTADO);

  // "enviados" cuenta publicaciones reales: sin canal o con el publish caido
  // son cero, aunque hubiera avisos para mandar.
  const enviados = envio === null ? 0 : salen.length;
  const resumen = simular
    ? `simulacion: ${avisos.length} activos, ${salen.length} habrian salido`
    : `activos ${avisos.length}, enviados ${enviados}${envio === null ? '' : ` via ${envio.url}`}`;
  console.log(`[${estado.ultimaCorrida}] ${resumen}`);
  if (salen.length > 0) {
    for (const aviso of salen) console.log(`  ${aviso.nivel}: ${aviso.texto}`);
  }
  if (sinCanal) {
    console.log(`ntfy sin configurar: agrega "urls" y "tema" en ${CONFIG}; ${salen.length} aviso(s) quedaron sin enviar`);
  } else if (!simular && salen.length > 0 && envio === null) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[${new Date().toISOString()}] el vigia fallo: ${String(error?.stack ?? error?.message ?? error)}`);
  process.exitCode = 1;
});
