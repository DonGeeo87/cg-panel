# cg-panel

A DeepSeek Harness plugin that puts a **command center** in the main slot and opens it when the
harness starts: which project to pick up next, how the laptop is doing, whether the memory backup
is alive, and — if configured — the state of the rest of the fleet over SSH.

- [Español](#español)

Everything is measured on the host and served as JSON to the panel. The browser never reads files;
it only asks `/api/cg-panel/...` on the same origin it already loaded from, so there is no extra
port and no CORS.

## What it shows

| Block | Where it comes from | Cost |
|---|---|---|
| Start with | DSH workspace registry + git (last commit, uncommitted files) + session activity per path | local, ~3 s the first time |
| Laptop | PowerShell snapshot (`Get-CimInstance`): CPU, memory, disks, battery, uptime | ~1.5 s, cached 60 s |
| Backups | last **run** of the memory sync log + `restic` status reported by the fleet hosts | local, cached with the data payload (45 s) |
| Alerts | derived: full disk, backup that stopped running or has uncommitted work, projects outside git, `(completar:` markers left in `AGENTS.md` | local |
| Fleet | one SSH call per configured host, read-only snapshot script on the other side | ~5 s, cached 240 s |

The ranking is not a black box: every row says **why** it is there (sessions in the last two weeks,
last movement, uncommitted files, open markers).

## How it works

- **Host** (`lib/index.js`) registers two exact routes on the harness `webServer`:
  - `GET /api/cg-panel/datos` — priority, laptop, memory backup, alert list.
  - `GET /api/cg-panel/flota` — configured hosts over SSH, cached; `?forzar=1` bypasses the cache.
- **Client** (`lib/client.js`) fills the `main` slot under the key `cg-panel` and registers the
  icon in `sidebar.panellist`. It opens once per page load and never replaces a restored
  conversation or another panel.

### Only loopback clients

Both routes are **exact** route names, and the harness authentication gate covers the `/api`
*prefix* while `WebServer.match` looks at the exact table first. An exact `/api/cg-panel/...` route
therefore sits outside that gate and would answer any local process without a token. The plugin
does not rely on that: every handler requires `req.socket.remoteAddress` to be loopback
(`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and answers **403** to anything else. The panel is meant
for the browser on the same machine, which is where those measurements live anyway.

### Bounded waits

Every measurement has a cap, so the panel never hangs on a slow disk, a wedged PowerShell or an
unreachable SSH host:

| Stage | Cap |
|---|---|
| Project ranking | 12 s (partial ranking + a warning when it expires) |
| Laptop snapshot | 20 s; on expiry the last measurement is shown marked "stale" instead of a false failure |
| Memory backup | 8 s |
| `/api/cg-panel/datos` as a whole | 22 s, then `504` |
| `/api/cg-panel/flota` as a whole | 30 s, then `504` |
| Client-side fetch | 25 s (data) / 35 s (fleet) |

## Configuration

Optional file: `~/.dsh/cg-panel.json` (or `$DSH_HOME/cg-panel.json`). Missing, empty or corrupt, the
panel still works: it just hides the blocks it cannot measure.

```json
{
  "flota": { "hosts": ["vps", "aio", "laptop"] },
  "respaldo": { "log": "C:/path/to/.dsh-sync/sync.log", "repo": "C:/path/to/.dsh-sync" },
  "urls": ["https://ntfy.example"],
  "tema": "my-topic",
  "discoWarn": 85,
  "discoBad": 93,
  "memoriaWarnHoras": 30,
  "memoriaBadHoras": 72,
  "cambiosInfo": 15,
  "dormidosInfo": 6,
  "ventanas": { "info": 168, "warn": 12, "bad": 3 }
}
```

| Key | Meaning | Without it |
|---|---|---|
| `flota` | which fleet hosts to measure: `true` for all three, an array of ids, or `{ "hosts": [...] }` | the fleet block is **omitted**: no SSH is fired and the browser does not even request it |
| `respaldo.log` | file touched by your memory backup script; its mtime is the "last run" | the conventional `~/.dsh-sync/sync.log` is used **only if it exists**; otherwise the backups block is omitted |
| `respaldo.repo` | git repository that holds the memory backup | directory of `respaldo.log` |
| `urls` | ntfy base URLs the watchdog publishes to | the watchdog runs, writes its state and exits cleanly saying the channel is not configured |
| `tema` | ntfy topic | same |
| thresholds | disk %, backup age in hours, uncommitted files, idle projects, quiet windows | defaults shown above |

The fleet hosts are measured with the collectors in `lib/collect/`: the `aio` and `vps` ones expect
SSH aliases of those names and a read-only snapshot script deployed on the other side; `laptop` is
this Windows machine. Hosts can be selected, not renamed.

## Turning off the auto-open

In the GUI console:

```js
localStorage.setItem('cg-panel:auto', '0')
```

With `'1'` (or nothing) it opens by itself again. The "already opened" marker lives on `window`, so a
reload (F5) opens the panel again while the same page load only opens it once.

## The watchdog (optional ntfy notifications)

`scripts/vigia.mjs` measures the laptop and the fleet and publishes what is out of range to an ntfy
server. It does **not** run inside DSH: it is a Windows scheduled task, so it keeps warning with the
harness closed.

```bash
# task status and last runs
pwsh scripts/vigia-tarea.ps1 -Estado
# install / remove (every 15 minutes)
pwsh scripts/vigia-tarea.ps1 -Instalar
pwsh scripts/vigia-tarea.ps1 -Quitar
# run once now
pwsh scripts/vigia-tarea.ps1 -Correr
# print what it would send without publishing anything
node scripts/vigia.mjs --simular
```

- **Channel**: `urls` and `tema` from `~/.dsh/cg-panel.json`. Without them nothing is published and
  the run ends with exit code 0 saying the channel is missing (a missing channel is a configuration
  gap, not a failure). `~/.dsh/.ntfy-token` is read when present, for servers that require auth.
- **State**: `~/.dsh/cg-panel-vigia.json` (active alerts and when each one was sent), written
  atomically through a temporary file plus rename so a half-written JSON cannot make the panel show
  the previous run as healthy. Log: `~/.dsh/cg-panel-vigia.log`, rotated at 256 KB.
- **Any thrown error** is logged and makes the run exit with code 1, so a broken run shows up as a
  broken run instead of a stale healthy state.
- What it watches: disk and battery, backup age, containers and failed units on the remote hosts,
  projects with many uncommitted files, projects outside git, projects idle for 30+ days and
  unclosed `AGENTS.md` markers.
- Anti-noise: an alert is sent when the problem appears, when it gets worse, or when the quiet
  window for its level expired — `info` 7 days, `warn` 12 h, `bad` 3 h. When the condition is gone
  the key is dropped and the next occurrence alerts again.

## Install / remove

```bash
# from the npm registry
plugin_manager install_bundle target=cg-panel
# or from a local folder
plugin_manager install_bundle target=<path-to-cg-panel>
# remove
plugin_manager remove_bundle cg-panel
```

Reload only the host half without restarting DSH: `plugin_manager set_bundle cg-panel false` and then
`true`. `apply` runs again in the live process (the ESM cache may keep the old code, so a code change
still asks for a restart).

## Tests

```bash
node test/datos-smoke.mjs
```

Real assertions, not a screen dump: missing registry and corrupt registry both give an empty ranking
instead of throwing, an unconfigured fleet is omitted without SSH, the payload keeps its shape, the
vendored collectors still export their functions, and on a machine whose registry has projects the
ranking is not empty. Exit code is non-zero on any failure.

## Design notes

- **`webServer` goes in `inject`, not in a defensive `ctx.get`.** With `inject = []`, `apply` runs
  before the HTTP server exists, `ctx.get('webServer')` returns `undefined` and the plugin goes mute
  with no error: the GUI shows `not found` in every block and the panel looks broken.
- **The age of the last commit is not a backup alarm.** A sync script that only commits when there
  are changes leaves an old commit behind on a quiet day while the backup is perfectly healthy.
  What matters is that the script ran (log mtime) and that nothing is left uncommitted.
- **CPU needs two samples.** `Win32_PerfFormattedData_PerfOS_Processor` returns 100 on the first
  read, so the snapshot reads it twice with 700 ms in between; without that the panel shouts "CPU
  at 100%" on an idle laptop.
- **Session directories encode the path dropping the colon**: `C:\Users\me\Projects` becomes
  `--C-Users-me-Projects--`. Replacing the colon with a dash gives a directory that does not exist.
- **The workspace registry lives in `~/.dsh/storages/workspace.json`** (`tables.workspaces` plus
  `global.workspaceIds`), not inside each project, and it has no `updatedAt` per workspace: the
  ranking only uses signals that actually exist (sessions, git, `AGENTS.md` markers).
- **Session activity says where the session was opened, not which project was touched**, so most
  recent sessions pile up on the hub. Per-project activity is measured with git instead.
- The machine and fleet collectors are a **vendored copy** of the same author's earlier `cg-ops`
  package (see the attribution header in each file), so the published tarball has no relative
  dependency on a package that is not published.

## Español

Plugin de DeepSeek Harness que pone un **centro de mando** en el slot principal y lo abre al
iniciar el harness: qué proyecto conviene seguir, cómo está la laptop, si el respaldo de memoria
está vivo y —si se configura— el estado del resto de la flota por SSH.

Todo se mide en el host y se sirve como JSON; el navegador solo pide `/api/cg-panel/...` al mismo
origen, sin CORS ni puerto extra.

**Bloques y coste**: ranking de proyectos (registro de workspaces + git + sesiones, local), laptop
(PowerShell, cache 60 s), respaldos (última corrida del sync, local), avisos derivados y flota por
SSH (cache 240 s). Cada fila del ranking explica por qué está ahí.

**Rutas**: `GET /api/cg-panel/datos` y `GET /api/cg-panel/flota` (`?forzar=1` saltea la cache).
Las dos exigen que el pedido venga de loopback y responden 403 al resto: el candado de auth del
harness cubre el prefijo `/api`, pero una ruta exacta queda fuera de la tabla de prefijos. Cada
medición tiene tope de tiempo, así que un disco lento o un SSH caído no cuelgan el panel.

**Configuración opcional** en `~/.dsh/cg-panel.json`:

```json
{
  "flota": { "hosts": ["vps", "aio", "laptop"] },
  "respaldo": { "log": "C:/ruta/.dsh-sync/sync.log", "repo": "C:/ruta/.dsh-sync" },
  "urls": ["https://ntfy.ejemplo"],
  "tema": "mi-tema",
  "discoWarn": 85,
  "discoBad": 93,
  "memoriaWarnHoras": 30,
  "memoriaBadHoras": 72,
  "cambiosInfo": 15,
  "dormidosInfo": 6,
  "ventanas": { "info": 168, "warn": 12, "bad": 3 }
}
```

Sin `flota` el bloque de flota **no se muestra y no dispara ningún SSH**. Sin `respaldo` se usa
`~/.dsh-sync/sync.log` solo si existe; si no existe, el bloque de respaldos se omite. Sin `urls` y
`tema`, el vigía corre, guarda su estado y sale con código 0 avisando que falta configurar el canal.

**Arranque automático**: se apaga con `localStorage.setItem('cg-panel:auto', '0')` en la consola de
la GUI. La marca de "ya se abrió" vive en `window`, así que un F5 lo vuelve a abrir.

**Vigía (ntfy)**: `pwsh scripts/vigia-tarea.ps1 -Instalar` crea una tarea de Windows cada 15 minutos
que funciona con el harness cerrado; `-Estado`, `-Correr` y `-Quitar` son las otras acciones.
`node scripts/vigia.mjs --simular` muestra qué avisaría sin publicar nada. El estado se escribe de
forma atómica y cualquier error deja la corrida en código 1.

**Pruebas**: `node test/datos-smoke.mjs` corre asserts reales (registro ausente o corrupto, flota sin
configurar, forma del payload, colectores vendorizados y ranking no vacío cuando hay proyectos) y sale
con código distinto de cero si algo falla.

**Instalar / quitar**: `plugin_manager install_bundle target=cg-panel` y
`plugin_manager remove_bundle cg-panel`.
