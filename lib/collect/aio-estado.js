// Tomado de cg-ops (mismo autor), 2026-11-10.
// Copia vendorizada: cg-panel se publica solo, sin depender de ../cg-ops.
/**
 * Collector for `aio_estado`.
 *
 * Talks to the AIO over the existing `ssh aio` alias and runs the read-only
 * snapshot script deployed at /opt/aio/bin/aio-estado.py (source of truth:
 * cg-ops/aio/aio-estado.py in the workspace). No DSH imports live here, so this
 * module runs under plain Node for tests.
 *
 * @module cg-ops/collect/aio-estado
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SSH_TIMEOUT_MS = 25_000;
const REMOTE_SCRIPT = '/opt/aio/bin/aio-estado.py';

/**
 * Last few lines of a failed command, for an actionable error message.
 * @param {unknown} error - the execFile rejection.
 * @returns {string}
 */
function tail(error) {
  const raw = error?.stderr || error?.message || '';
  return String(raw).trim().split('\n').slice(-3).join(' | ');
}

/**
 * Read one snapshot of the AIO.
 * @returns {Promise<object>} the payload printed by the remote script.
 */
export async function collectAioEstado() {
  let stdout;
  try {
    ({ stdout } = await run('ssh', ['aio', `python3 ${REMOTE_SCRIPT}`], {
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    const detail = tail(error);
    throw new Error(
      `No pude leer el estado del AIO (ssh aio → ${REMOTE_SCRIPT}): ${detail || 'sin detalle'}. `
      + 'Verifica que el AIO esté encendido y que el script siga desplegado.',
    );
  }

  const text = String(stdout).trim();
  if (text.length === 0) throw new Error('El AIO devolvió una salida vacía.');

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`El AIO devolvió algo que no es JSON: ${text.slice(0, 200)}`);
  }
  if (payload === null || typeof payload !== 'object' || payload.widget !== 'aio-estado') {
    throw new Error('El AIO devolvió un payload inesperado (falta widget="aio-estado").');
  }
  return payload;
}
