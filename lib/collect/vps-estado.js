// Tomado de cg-ops (mismo autor), 2026-11-10.
// Copia vendorizada: cg-panel se publica solo, sin depender de ../cg-ops.
/**
 * Collector for the VPS (`ssh vps`).
 *
 * Runs the read-only snapshot script deployed at
 * /opt/codigo-guerrero/bin/vps-estado.py (source of truth: cg-ops/vps/vps-estado.py
 * in the workspace) and validates the payload. No DSH imports live here, so this
 * module runs under plain Node for tests.
 *
 * @module cg-ops/collect/vps-estado
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SSH_TIMEOUT_MS = 25_000;
const REMOTE_SCRIPT = '/opt/codigo-guerrero/bin/vps-estado.py';

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
 * Read one snapshot of the VPS.
 * @returns {Promise<object>} the payload printed by the remote script.
 */
export async function collectVpsEstado() {
  let stdout;
  try {
    ({ stdout } = await run('ssh', ['vps', `python3 ${REMOTE_SCRIPT}`], {
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    const detail = tail(error);
    throw new Error(
      `No pude leer el estado del VPS (ssh vps → ${REMOTE_SCRIPT}): ${detail || 'sin detalle'}. `
      + 'Verifica que el VPS responda y que el script siga desplegado.',
    );
  }

  const text = String(stdout).trim();
  if (text.length === 0) throw new Error('El VPS devolvió una salida vacía.');

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`El VPS devolvió algo que no es JSON: ${text.slice(0, 200)}`);
  }
  if (payload === null || typeof payload !== 'object' || payload.widget !== 'vps-estado') {
    throw new Error('El VPS devolvió un payload inesperado (falta widget="vps-estado").');
  }
  return payload;
}
