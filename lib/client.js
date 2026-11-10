/**
 * cg-panel, browser half.
 *
 * Ocupa el slot `main` con la clave `cg-panel` y se abre desde un icono propio
 * del sidebar. Los datos los pide por HTTP al mismo origen que la GUI
 * (`/api/cg-panel/...`), asi que no hay puerto extra ni CORS.
 *
 * Arranque: se intenta abrir una vez por carga de la pagina, y nunca pisa una
 * conversacion ya restaurada. Para desactivarlo: localStorage['cg-panel:auto']='0'.
 */
window.__ModuleLoader__.load({
	id: 'cg-panel',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const h = react.createElement;

		const OK = '#3ddc97';
		const WARN = '#f5b83d';
		const BAD = '#f2555a';
		const PANEL_ID = 'cg-panel';
		const AUTO_KEY = 'cg-panel:auto';

		const CSS = [
			'.cgp_root{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;padding:24px clamp(16px,3vw,40px) 40px;gap:18px}',
			'.cgp_root>*{width:100%;max-width:1080px}',
			'.cgp_head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
			'.cgp_titles{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.cgp_title{font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}',
			'.cgp_sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.cgp_spacer{flex:1 1 auto}',
			'.cgp_btn{appearance:none;background:none;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:6px 10px;cursor:pointer;white-space:nowrap}',
			'.cgp_btn:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
			'.cgp_btn:disabled{opacity:.5;cursor:default}',
			'.cgp_btn_on{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
			'.cgp_section{display:flex;flex-direction:column;gap:8px}',
			'.cgp_stitle{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#8a8f98)}',
			'.cgp_card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}',
			'.cgp_rows{display:flex;flex-direction:column;gap:8px}',
			'.cgp_pri{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);padding:10px 12px;display:flex;align-items:center;gap:12px;min-width:0}',
			'.cgp_pri_top{border-color:var(--dsw-alias-border-l2)}',
			'.cgp_rank{flex:none;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;background:rgba(61,220,151,.14);color:#2fae7b}',
			'.cgp_pri_body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}',
			'.cgp_pri_name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.cgp_chips{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}',
			'.cgp_chip{font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
			'.cgp_chip_hot{background:rgba(242,85,90,.12);color:#d94a50}',
			'.cgp_chip_warn{background:rgba(245,184,61,.14);color:#c08c1d}',
			'.cgp_path{font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
			'.cgp_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;align-items:start}',
			'.cgp_metric{display:flex;align-items:baseline;gap:8px;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.cgp_metric b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
			'.cgp_bar{height:5px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;margin-top:3px}',
			'.cgp_barfill{height:100%;border-radius:999px}',
			'.cgp_kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}',
			'.cgp_kv span:first-child{color:var(--dsw-alias-label-caption,#8a8f98)}',
			'.cgp_kv span:last-child{color:var(--dsw-alias-label-primary);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.cgp_dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}',
			'.cgp_host{display:flex;align-items:center;gap:8px;min-width:0}',
			'.cgp_hostname{font-weight:600;font-size:12px;color:var(--dsw-alias-label-primary)}',
			'.cgp_hostmeta{font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.cgp_avisos{display:flex;flex-direction:column;gap:6px}',
			'.cgp_aviso{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.cgp_empty{font-size:12px;color:var(--dsw-alias-label-caption,#8a8f98);padding:6px 0}',
			'.cgp_err{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);padding:10px 12px;font-size:12px;color:#d94a50;background:rgba(242,85,90,.08);white-space:pre-wrap}',
		].join('');

		const TAG_ID = 'cg-panel/panel.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'cg-panel';
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** "hace 3 h" a partir de horas. */
		function haceHoras(horas) {
			if (typeof horas !== 'number' || !Number.isFinite(horas)) return 'sin dato';
			if (horas < 1) return 'hace menos de 1 h';
			if (horas < 48) return `hace ${Math.round(horas)} h`;
			return `hace ${Math.round(horas / 24)} d`;
		}

		/** "hace 3 d" a partir de dias. */
		function haceDias(dias) {
			if (typeof dias !== 'number' || !Number.isFinite(dias)) return 'sin dato';
			if (dias < 1) return 'hoy';
			if (dias < 45) return `hace ${Math.round(dias)} d`;
			return `hace ${Math.round(dias / 30)} meses`;
		}

		/** Color por porcentaje usado. */
		function pctColor(pct) {
			if (typeof pct !== 'number') return 'var(--dsw-alias-border-l2)';
			if (pct >= 93) return BAD;
			if (pct >= 85) return WARN;
			return OK;
		}

		/** Color por nivel de aviso. */
		function nivelColor(nivel) {
			if (nivel === 'bad') return BAD;
			if (nivel === 'warn') return WARN;
			return 'var(--dsw-alias-border-l2)';
		}

		/** Fila etiqueta/valor. */
		function Kv(props) {
			return h('div', { className: 'cgp_kv' },
				h('span', null, props.label),
				h('span', { title: props.title }, props.value));
		}

		/** Barra de uso con porcentaje. */
		function Bar(props) {
			const pct = typeof props.pct === 'number' ? Math.max(0, Math.min(100, props.pct)) : 0;
			return h('div', { className: 'cgp_bar' },
				h('div', { className: 'cgp_barfill', style: { width: `${pct}%`, background: pctColor(props.pct) } }));
		}

		/** Icono del sidebar: tres barras de tablero. */
		function Icono(props) {
			const size = props && typeof props.size === 'number' ? props.size : 16;
			return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
				h('rect', { x: 1.5, y: 8.5, width: 3, height: 6, rx: 1, fill: 'currentColor', opacity: 0.55 }),
				h('rect', { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1, fill: 'currentColor' }),
				h('rect', { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1, fill: 'currentColor', opacity: 0.75 }));
		}

		/**
		 * Pedir JSON al mismo origen, con tope de tiempo propio.
		 * @param {string} ruta - ruta absoluta del endpoint.
		 * @param {AbortSignal} [signal] - cancelacion de quien llama.
		 * @param {number} [topeMs] - tope propio; ausente o 0 = sin tope.
		 * @returns {Promise<object>} el cuerpo parseado.
		 */
		async function pedir(ruta, signal, topeMs) {
			const control = new AbortController();
			let temporizador = null;
			let vencio = false;
			if (typeof topeMs === 'number' && topeMs > 0) {
				temporizador = window.setTimeout(() => {
					vencio = true;
					control.abort();
				}, topeMs);
			}
			if (signal !== undefined && signal !== null) {
				if (signal.aborted) control.abort();
				else signal.addEventListener('abort', () => control.abort(), { once: true });
			}
			try {
				const respuesta = await fetch(ruta, { cache: 'no-store', signal: control.signal });
				const texto = await respuesta.text();
				let cuerpo;
				try {
					cuerpo = JSON.parse(texto);
				} catch {
					throw new Error(`Respuesta no JSON (${respuesta.status}): ${texto.slice(0, 160)}`);
				}
				if (!respuesta.ok) throw new Error(cuerpo?.error ?? `HTTP ${respuesta.status}`);
				return cuerpo;
			} catch (fallo) {
				if (vencio) throw new Error(`tiempo de espera agotado (${Math.round(topeMs / 1000)} s)`);
				throw fallo;
			} finally {
				if (temporizador !== null) window.clearTimeout(temporizador);
			}
		}

		/** Una fila del ranking. */
		function FilaPrioridad(props) {
			const fila = props.fila;
			const chips = [];
			for (const motivo of Array.isArray(fila.motivos) ? fila.motivos : []) chips.push(motivo);
			return h('div', { className: `cgp_pri${props.index === 0 ? ' cgp_pri_top' : ''}` },
				h('div', { className: 'cgp_rank', title: `puntaje ${fila.puntaje}` }, String(props.index + 1)),
				h('div', { className: 'cgp_pri_body' },
					h('div', { className: 'cgp_pri_name', title: fila.ruta }, fila.titulo),
					h('div', { className: 'cgp_chips' },
						chips.map((texto, i) => h('span', {
							className: `cgp_chip${i === 0 ? ' cgp_chip_warn' : ''}`,
							key: texto,
						}, texto)),
						fila.sesiones > 0 ? h('span', { className: 'cgp_chip' }, `${fila.sesiones} sesiones`) : null),
					h('div', { className: 'cgp_path', title: fila.ruta }, fila.ruta)),
				props.abrir === undefined
					? null
					: h('button', {
						type: 'button',
						className: 'cgp_btn cgp_btn_on',
						onClick: () => props.abrir(fila),
						title: 'Abrir este proyecto como workspace',
					}, 'Abrir'));
		}

		/** Tarjeta de la laptop. */
		function TarjetaMaquina(props) {
			const maquina = props.maquina ?? {};
			if (maquina.indisponible !== undefined) {
				return h('div', { className: 'cgp_card' },
					h('div', { className: 'cgp_stitle' }, 'Laptop'),
					h('div', { className: 'cgp_empty' }, `Sin datos: ${maquina.indisponible}`));
			}
			const discos = Array.isArray(maquina.discos) ? maquina.discos : [];
			const mem = maquina.mem ?? null;
			return h('div', { className: 'cgp_card' },
				h('div', { className: 'cgp_stitle' },
					`Laptop${maquina.host ? ` · ${maquina.host}` : ''}${maquina.vencido === true ? ' · medicion atrasada' : ''}`),
				typeof maquina.cpuPct === 'number'
					? h('div', null,
						h('div', { className: 'cgp_metric' }, h('span', null, 'CPU'), h('b', null, `${Math.round(maquina.cpuPct)}%`)),
						h(Bar, { pct: maquina.cpuPct }))
					: null,
				mem !== null && typeof mem.usedPct === 'number'
					? h('div', null,
						h('div', { className: 'cgp_metric' },
							h('span', null, 'Memoria'),
							h('b', null, `${Math.round(mem.usedPct)}%${mem.totalMiB ? ` de ${Math.round(mem.totalMiB / 1024)} GB` : ''}`)),
						h(Bar, { pct: mem.usedPct }))
					: null,
				discos.length === 0
					? h('div', { className: 'cgp_empty' }, 'Sin discos medidos.')
					: discos.map((disco) => h('div', { key: disco.mount },
						h('div', { className: 'cgp_metric' },
							h('span', null, disco.mount),
							h('b', null, `${disco.availGb ?? '?'} GB libres${typeof disco.usedPct === 'number' ? ` · ${Math.round(disco.usedPct)}%` : ''}`)),
						h(Bar, { pct: disco.usedPct }))),
				maquina.bateria !== null && maquina.bateria !== undefined
					? h(Kv, {
						label: 'Bateria',
						value: `${maquina.bateria.pct}%${maquina.bateria.onAc ? ' (enchufada)' : ''}`,
					})
					: null,
				typeof maquina.uptimeHoras === 'number'
					? h(Kv, { label: 'Encendida', value: `${Math.round(maquina.uptimeHoras)} h` })
					: null);
		}

		/** Tarjeta de respaldos: memoria local y host(s) remotos. */
		function TarjetaRespaldo(props) {
			const memoria = props.datos?.respaldo?.memoria ?? null;
			// Sin `respaldo` en el payload esta maquina no tiene respaldo de memoria
			// configurado: la fila no se dibuja (y si tampoco hay flota, la tarjeta
			// entera desaparece).
			const hayMemoria = props.datos?.respaldo !== undefined && props.datos?.respaldo !== null;
			// La fila habla de la ultima CORRIDA del sync, no del ultimo commit: sin
			// cambios no hay commit y la fecha vieja asustaba sin motivo.
			const memoriaTexto = memoria === null
				? 'sin registro'
				: (memoria.corridaHoras === null || memoria.corridaHoras === undefined
					? (memoria.cuando === null ? 'sin registro' : `commit ${haceHoras(memoria.horas)}`)
					: `corrio ${haceHoras(memoria.corridaHoras)}${memoria.pendientes > 0 ? ` · ${memoria.pendientes} sin comitear` : ''}`);
			const todos = props.hosts ?? [];
			// Solo los host que reportan restic con fecha: el VPS no lleva el suyo
			// en este payload y una fila "sin dato" solo mete ruido.
			const hosts = todos.filter((host) => host.reachable === false
				|| (Array.isArray(host.backups) && host.backups.some((backup) => typeof backup.agoMin === 'number')));
			if (!hayMemoria && hosts.length === 0) return null;
			return h('div', { className: 'cgp_card' },
				h('div', { className: 'cgp_stitle' }, 'Respaldos'),
				hayMemoria
					? h(Kv, {
						label: 'Memoria (~/.dsh)',
						value: memoriaTexto,
						title: memoria?.cuando === null ? undefined : `ultimo commit ${memoria?.cuando}`,
					})
					: null,
				hosts.map((host) => {
					const backups = Array.isArray(host.backups) ? host.backups : [];
					const ultimo = backups.find((backup) => typeof backup.agoMin === 'number') ?? null;
					return h(Kv, {
						key: host.id,
						label: `restic ${host.label ?? host.id}`,
						value: ultimo === null
							? (host.reachable === false ? 'sin respuesta' : 'sin dato')
							: `${ultimo.name ?? 'repo'} ${haceHoras(ultimo.agoMin / 60)}`,
					});
				}),
				hosts.length === 0 && props.flotaActiva === true
					? h('div', { className: 'cgp_empty' }, 'Midiendo AIO y VPS...')
					: null);
		}

		/** Una fila de host de la flota. */
		function FilaHost(props) {
			const host = props.host;
			const color = host.color === 'bad' ? BAD : (host.color === 'warn' ? WARN : OK);
			const contenedores = host.containers;
			const piezas = [];
			if (host.reachable === false) piezas.push('sin respuesta');
			else {
				if (typeof host.uptimeHours === 'number') piezas.push(`${Math.round(host.uptimeHours)} h uptime`);
				if (contenedores && typeof contenedores === 'object') {
					piezas.push(`${contenedores.running ?? '?'}/${contenedores.total ?? '?'} contenedores`);
					if (Array.isArray(contenedores.problems) && contenedores.problems.length > 0) {
						piezas.push(`${contenedores.problems.length} con problema`);
					}
				}
				const discos = Array.isArray(host.disks) ? host.disks : [];
				const peor = discos.reduce((maximo, disco) => (
					typeof disco.usedPct === 'number' && disco.usedPct > maximo ? disco.usedPct : maximo
				), 0);
				if (peor > 0) piezas.push(`disco ${Math.round(peor)}%`);
				if (Array.isArray(host.failedUnits) && host.failedUnits.length > 0) {
					piezas.push(`${host.failedUnits.length} units caidas`);
				}
				if (typeof host.cpuPct === 'number') piezas.push(`cpu ${Math.round(host.cpuPct)}%`);
			}
			const alerts = Array.isArray(host.alerts) ? host.alerts.filter((alerta) => alerta.sev !== 'info') : [];
			return h('div', { className: 'cgp_card' },
				h('div', { className: 'cgp_host' },
					h('span', { className: 'cgp_dot', style: { background: color } }),
					h('span', { className: 'cgp_hostname' }, host.label ?? host.id),
					h('span', { className: 'cgp_spacer' }),
					h('span', { className: 'cgp_hostmeta' }, piezas.join(' · '))),
				alerts.length === 0
					? null
					: h('div', { className: 'cgp_avisos' },
						alerts.slice(0, 4).map((alerta, i) => h('div', { className: 'cgp_aviso', key: `${alerta.text}-${i}` },
							h('span', { className: 'cgp_dot', style: { background: alerta.sev === 'bad' ? BAD : WARN } }),
							h('span', null, alerta.text)))));
		}

		/**
		 * El panel completo.
		 * @param {object} props - owner props (con las acciones inyectadas).
		 */
		function Panel(props) {
			const [datos, setDatos] = react.useState(null);
			const [flota, setFlota] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [errorFlota, setErrorFlota] = react.useState(null);
			const [cargando, setCargando] = react.useState(true);
			const [midiendoFlota, setMidiendoFlota] = react.useState(false);
			const [marca, setMarca] = react.useState(0);
			// Primero null (todavia no hay datos): el bloque de la flota se pide
			// recien cuando el host dice que esta configurado. En una maquina sin
			// `flota` en la configuracion no se dispara ni un request.
			const flotaActiva = datos === null ? null : datos?.flotaConfigurada !== false;

			react.useEffect(() => {
				let vigente = true;
				const control = new AbortController();
				setCargando(true);
				setError(null);
				pedir('/api/cg-panel/datos', control.signal, 25000)
					.then((cuerpo) => {
						if (vigente) setDatos(cuerpo);
					})
					.catch((fallo) => {
						if (vigente && fallo?.name !== 'AbortError') setError(String(fallo?.message ?? fallo));
					})
					.finally(() => {
						if (vigente) setCargando(false);
					});
				return () => {
					vigente = false;
					control.abort();
				};
			}, [marca]);

			react.useEffect(() => {
				let vigente = true;
				const control = new AbortController();
				if (flotaActiva !== true) {
					setFlota(null);
					setMidiendoFlota(false);
					return () => {
						vigente = false;
					};
				}
				setMidiendoFlota(true);
				setErrorFlota(null);
				pedir(`/api/cg-panel/flota${marca > 0 ? '?forzar=1' : ''}`, control.signal, 35000)
					.then((cuerpo) => {
						if (vigente) setFlota(cuerpo);
					})
					.catch((fallo) => {
						if (vigente && fallo?.name !== 'AbortError') setErrorFlota(String(fallo?.message ?? fallo));
					})
					.finally(() => {
						if (vigente) setMidiendoFlota(false);
					});
				return () => {
					vigente = false;
					control.abort();
				};
			}, [marca, flotaActiva]);

			// Vigilante: mientras el panel esta abierto se vuelve a medir cada 5 min,
			// asi el disco o un respaldo viejo aparecen sin apretar nada.
			react.useEffect(() => {
				const timer = window.setInterval(() => setMarca((valor) => valor + 1), 300_000);
				return () => window.clearInterval(timer);
			}, []);

			const host = datos?.maquina?.host ?? null;
			const vigiaLinea = datos?.vigia === undefined
				? null
				: (datos.vigia === null
					? h('div', { className: 'cgp_empty' }, 'El vigia (ntfy) todavia no corrio.')
					: h(Kv, {
						label: 'Vigia ntfy',
						value: [
							`${(datos.vigia.activos ?? []).length} activos`,
							datos.vigia.ultimaCorrida === null
								? null
								: `corrio ${haceHoras((Date.now() - Date.parse(datos.vigia.ultimaCorrida)) / 3_600_000)}`,
							datos.vigia.ultimoEnvio === null
								? null
								: `aviso ${haceHoras((Date.now() - Date.parse(datos.vigia.ultimoEnvio)) / 3_600_000)}`,
						].filter((parte) => parte !== null).join(' · '),
					}));
			const prioridad = Array.isArray(datos?.prioridad) ? datos.prioridad : [];
			const resumen = datos?.resumen ?? {};
			const avisos = Array.isArray(datos?.avisos) ? datos.avisos : [];
			const hosts = Array.isArray(flota?.hosts) ? flota.hosts : [];
			const flotaVisible = flotaActiva === true && flota?.omitido !== true;
			const desactualizado = datos?.generado === undefined
				? null
				: `medido ${haceHoras((Date.now() - Date.parse(datos.generado)) / 3_600_000)}`;

			return h('div', { className: 'cgp_root' },
				h('div', { className: 'cgp_head' },
					h('div', { className: 'cgp_titles' },
						h('div', { className: 'cgp_title' }, 'Centro de mando'),
						h('div', { className: 'cgp_sub' },
							[
								host === null ? null : `laptop ${host}`,
								datos === null ? null : `${resumen.proyectos ?? 0} proyectos`,
								resumen.hub !== null && resumen.hub !== undefined && resumen.hub.recientes > 0
									? `${resumen.hub.recientes} sesiones del hub`
									: null,
								desactualizado,
							].filter((parte) => parte !== null).join(' · '))),
					h('span', { className: 'cgp_spacer' }),
					props.conversacion === undefined
						? null
						: h('button', { type: 'button', className: 'cgp_btn', onClick: () => props.conversacion(), title: 'Volver a la conversacion' }, 'Conversacion'),
					h('button', {
						type: 'button',
						className: 'cgp_btn',
						disabled: cargando,
						onClick: () => setMarca((valor) => valor + 1),
						title: 'Volver a medir todo, incluida la flota',
					}, cargando ? 'Midiendo...' : 'Actualizar')),

				error === null ? null : h('div', { className: 'cgp_err' }, `No pude leer los datos: ${error}`),

				h('div', { className: 'cgp_section' },
					h('div', { className: 'cgp_stitle' }, 'Empezar por'),
					prioridad.length === 0
						? h('div', { className: 'cgp_empty' }, cargando ? 'Leyendo proyectos...' : 'Sin proyectos para priorizar.')
						: h('div', { className: 'cgp_rows' },
							prioridad.map((fila, index) => h(FilaPrioridad, {
								key: fila.id ?? fila.ruta,
								fila,
								index,
								abrir: props.abrir,
							})))),

				h('div', { className: 'cgp_grid' },
					h(TarjetaMaquina, { maquina: datos?.maquina }),
					h(TarjetaRespaldo, { datos, hosts, flotaActiva }),
					h('div', { className: 'cgp_card' },
						h('div', { className: 'cgp_stitle' }, 'Avisos'),
						errorFlota === null ? null : h('div', { className: 'cgp_aviso' },
							h('span', { className: 'cgp_dot', style: { background: WARN } }),
							h('span', null, `Flota: ${errorFlota}`)),
						avisos.length === 0
							? h('div', { className: 'cgp_empty' }, cargando ? 'Revisando...' : 'Nada que reportar.')
							: h('div', { className: 'cgp_avisos' },
								avisos.map((aviso, i) => h('div', { className: 'cgp_aviso', key: `${aviso.texto}-${i}` },
									h('span', { className: 'cgp_dot', style: { background: nivelColor(aviso.nivel) } }),
									h('span', null, aviso.texto)))),
						vigiaLinea)),

				flotaVisible
					? h('div', { className: 'cgp_section' },
						h('div', { className: 'cgp_stitle' },
							`Flota${midiendoFlota ? ' · midiendo' : ''}${flota?.summary?.status ? ` · ${flota.summary.status}` : ''}`),
						hosts.length === 0
							? h('div', { className: 'cgp_empty' }, midiendoFlota ? 'Consultando AIO y VPS...' : 'Sin datos de la flota.')
							: h('div', { className: 'cgp_grid' }, hosts.map((host) => h(FilaHost, { key: host.id, host }))))
					: null);
		}

		/**
		 * Registrar panel e icono, y abrir el panel una vez por carga.
		 * @param {object} ctx - alcance cliente con `slots`.
		 */
		function apply(ctx) {
			let layout = null;
			let uiWorkspace = null;

			const abrir = (fila) => {
				if (uiWorkspace === null || fila?.id === undefined) return;
				try {
					Promise.resolve(uiWorkspace.openWorkspace(fila.id)).catch(() => {});
				} catch {
					// Abrir un workspace no puede romper el panel.
				}
			};

			const conversacion = () => {
				if (layout === null) return;
				try {
					layout.selectPanel(null);
				} catch {
					// Sin conversacion disponible: dejar el panel como esta.
				}
			};

			ctx.slots.inject('main', () => {
				const soltar = ctx.slots.register({
					name: 'main',
					key: PANEL_ID,
					inject: () => ({ abrir, conversacion }),
				}, Panel);
				// El slot puede inyectarse en el acto, asi que `abrirAlArrancar` va
				// declarada con `function` (se hoistea) y no como const.
				abrirAlArrancar();
				return soltar;
			});

			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 2,
				label: () => 'Centro de mando',
			}, Icono));

			if (typeof ctx.inject === 'function') {
				ctx.inject(['layout', 'uiWorkspace'], (scoped) => {
					layout = scoped.layout ?? null;
					uiWorkspace = scoped.uiWorkspace ?? null;
				});
			}

			// Arranque: una sola vez por carga de la pagina, sin pisar una
			// conversacion ya abierta ni un panel distinto.
			function abrirAlArrancar() {
				try {
					if (window.localStorage.getItem(AUTO_KEY) === '0') return;
				} catch {
					// Sin localStorage igual intentamos una vez.
				}
				// Marca en window: vive lo que dura la carga de la pagina. En
				// sessionStorage sobrevivia a F5 (la sesion de la pestaña sigue viva)
				// y el panel no se volvia a abrir nunca mas despues de recargar.
				if (window.__cgPanelAbierto === true) return;
				const intentar = () => {
					if (layout === null) return false;
					try {
						const activo = layout.panelInfo?.getSnapshot?.()?.activePanelId ?? null;
						if (activo !== null && activo !== 'conversation' && activo !== PANEL_ID) return true;
						layout.selectPanel(PANEL_ID);
						window.__cgPanelAbierto = true;
						return true;
					} catch {
						return false;
					}
				};
				if (intentar()) return;
				const timer = window.setTimeout(() => {
					if (intentar()) return;
					window.setTimeout(intentar, 2000);
				}, 1200);
				ctx.on?.('dispose', () => window.clearTimeout(timer));
			}
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
