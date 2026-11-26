// Editor de libros — interfaz.
// Lee y guarda los capítulos en el repositorio a través de /api (funciones de Netlify).
'use strict';

const $ = (id) => document.getElementById(id);
const cargarYaml = (t) => (window.jsyaml.safeLoad || window.jsyaml.load)(t);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const estado = {
  usuario: null,
  libros: [],
  libro: null,      // { id, base, ficha, fichaRaw, estilos, capitulos }
  cap: null,        // { ruta, titulo, sha, original }
  viendoVersion: null,
};

// ------------------------------------------------------------ API
async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  const opciones = { method: metodo, headers: { 'x-editor': '1' }, credentials: 'same-origin' };
  if (cuerpo !== undefined) { opciones.body = JSON.stringify(cuerpo); opciones.headers['content-type'] = 'application/json'; }
  let r;
  try { r = await fetch(ruta, opciones); }
  catch { throw Object.assign(new Error('Sin conexión. Revisá internet y volvé a intentar.'), { status: 0 }); }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && !ruta.startsWith('/api/sesion')) { mostrarEntrada('Tu sesión venció. Volvé a entrar.'); }
  if (!r.ok) throw Object.assign(new Error(datos.error || `Error ${r.status}`), { status: r.status, datos });
  return datos;
}

function aviso(texto, ms = 2600) {
  const t = $('toast'); t.textContent = texto; t.hidden = false;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => { t.hidden = true; }, ms);
}

const almacen = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } },
};

// ------------------------------------------------------------ Entrada con Google
function cargarGoogle() {
  return new Promise((ok, mal) => {
    if (window.google?.accounts?.id) return ok();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = ok; s.onerror = () => mal(new Error('No se pudo cargar el inicio de sesión de Google.'));
    document.head.appendChild(s);
  });
}

async function mostrarEntrada(mensaje = '') {
  $('app').hidden = true; $('pantalla-entrada').hidden = false;
  $('entrada-error').textContent = mensaje;
  try {
    const cfg = await api('/api/config');
    if (!cfg.googleClientId) { $('entrada-error').textContent = 'Falta configurar el ID de Google en Netlify (GOOGLE_CLIENT_ID).'; return; }
    await cargarGoogle();
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: alEntrar, auto_select: true, ux_mode: 'popup' });
    $('boton-google').innerHTML = '';
    google.accounts.id.renderButton($('boton-google'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'es' });
  } catch (e) { $('entrada-error').textContent = e.message; }
}

async function alEntrar(resp) {
  try {
    estado.usuario = await api('/api/sesion', { metodo: 'POST', cuerpo: { credential: resp.credential } });
    iniciar();
  } catch (e) { $('entrada-error').textContent = e.message; }
}

$('b-salir').onclick = async () => {
  if (hayCambios() && !confirm('Tenés cambios sin guardar. ¿Salir igual? (quedan guardados en este navegador)')) return;
  await api('/api/salir', { metodo: 'POST' }).catch(() => {});
  window.google?.accounts?.id?.disableAutoSelect?.();
  estado.usuario = null; mostrarEntrada();
};

// ------------------------------------------------------------ Arranque
async function iniciar() {
  $('pantalla-entrada').hidden = true; $('app').hidden = false;
  $('nombre-usuario').textContent = estado.usuario.nombre;
  try {
    estado.libros = await api('/api/libros');
  } catch (e) { aviso(e.message, 5000); return; }
  const sel = $('sel-libro'); sel.innerHTML = '';
  estado.libros.forEach((l) => sel.add(new Option(l.titulo, l.id)));
  const q = new URLSearchParams(location.search);   // enlace desde el modo escucha: ?libro=…&cap=…
  const ultimo = q.get('libro') ? { libro: q.get('libro'), cap: q.get('cap') } : (almacen.get('ultimo') || {});
  const id = estado.libros.some((l) => l.id === ultimo.libro) ? ultimo.libro : estado.libros[0]?.id;
  if (id) { sel.value = id; await abrirLibro(id, ultimo.cap); }
}

(async () => {
  try { estado.usuario = await api('/api/sesion'); iniciar(); }
  catch { mostrarEntrada(); }
})();

// ------------------------------------------------------------ Libro y ficha
async function abrirLibro(id, capPreferido) {
  if (hayCambios() && !confirm('Tenés cambios sin guardar en este capítulo. ¿Cambiar de libro igual? (quedan guardados en este navegador)')) {
    $('sel-libro').value = estado.libro?.id; return;
  }
  $('estado').textContent = 'Cargando libro…';
  let d;
  try { d = await api(`/api/libro?id=${encodeURIComponent(id)}`); }
  catch (e) { aviso(e.message, 5000); return; }
  let ficha = {}, libroYaml = {};
  try { ficha = cargarYaml(d.ficha.texto) || {}; } catch (e) { aviso('La ficha tiene un error de formato: ' + e.message, 6000); }
  try { libroYaml = cargarYaml(d.libro.texto) || {}; } catch { /* se usa la ficha sin ajustes */ }
  ficha = mezclar(ficha, libroYaml.ajustes || {});
  estado.libro = { id, base: d.base, ficha, fichaRuta: d.ficha.ruta, fichaDir: d.ficha.dir, estilos: d.estilos.texto, capitulos: d.capitulos, datos: libroYaml };
  estado.libro.diccionarioRuta = d.diccionario?.ruta;
  estado.libro.palabrasDiccionario = (d.diccionario?.texto || '').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
  window.Ortografia?.diccionario((d.diccionario?.texto || '').split('\n'));
  construirToolbar(ficha.etiquetas || []);
  construirFicha();
  prepararVista();
  const sel = $('sel-cap'); sel.innerHTML = '';
  d.capitulos.forEach((c, i) => sel.add(new Option(nombreCapitulo(c, i), c.ruta)));
  actualizarPendientes();
  const ruta = d.capitulos.some((c) => c.ruta === capPreferido) ? capPreferido : d.capitulos[0]?.ruta;
  estado.cap = null;
  if (ruta) await abrirCapitulo(ruta, true);
}

function mezclar(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' ? mezclar(out[k], v) : v;
  }
  return out;
}

$('sel-libro').onchange = (e) => abrirLibro(e.target.value);

// ------------------------------------------------------------ Capítulos
const claveBorrador = (ruta) => `borrador:${ruta}`;
const hayCambios = () => !!estado.cap && $('src').value !== estado.cap.original;

async function abrirCapitulo(ruta, forzar = false) {
  if (!forzar && hayCambios() && !confirm('Tenés cambios sin guardar. ¿Cambiar de capítulo igual? (quedan guardados en este navegador)')) {
    $('sel-cap').value = estado.cap.ruta; return;
  }
  $('sel-cap').value = ruta;
  $('estado').textContent = 'Cargando…'; $('estado').className = 'estado';
  let a;
  try { a = await api(`/api/archivo?ruta=${encodeURIComponent(ruta)}`); }
  catch (e) { aviso(e.message, 5000); return; }
  const info = estado.libro.capitulos.find((c) => c.ruta === ruta);
  estado.cap = { ruta, titulo: info?.titulo || ruta, sha: a.sha, original: a.texto };
  estado.viendoVersion = null;
  $('src').value = a.texto; $('src').readOnly = false; $('src').scrollTop = 0;
  window.Deshacer?.reiniciar();
  $('nota').value = '';
  ocultarAviso();
  almacen.set('ultimo', { libro: estado.libro.id, cap: ruta });
  // ¿Quedó un borrador sin guardar de una sesión anterior?
  const b = almacen.get(claveBorrador(ruta));
  if (b && b.texto !== a.texto) {
    const cuando = new Date(b.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    const cambio = b.sha !== a.sha ? ' Ojo: desde entonces otra persona guardó cambios en este capítulo.' : '';
    mostrarAviso(`Tenés cambios sin guardar (${cuando}).${cambio}`, [
      ['Recuperarlos', () => { $('src').value = b.texto; ocultarAviso(); alEditar(); }],
      ['Descartarlos', () => { almacen.del(claveBorrador(ruta)); ocultarAviso(); }],
    ]);
  } else if (b) almacen.del(claveBorrador(ruta));
  actualizarEstado(); renderizar(); $('vista').contentWindow?.scrollTo(0, 0);
  window.Comentarios?.cargar(ruta);
  window.Original?.abrir(ruta, estado.libro.capitulos.findIndex((c) => c.ruta === ruta) + 1);
}

$('sel-cap').onchange = (e) => abrirCapitulo(e.target.value);

function actualizarEstado() {
  const el = $('estado');
  if (estado.viendoVersion) { el.textContent = 'Viendo una versión anterior'; el.className = 'estado cambios'; return; }
  const info = estado.libro?.capitulos.find((c) => c.ruta === estado.cap?.ruta);
  if (hayCambios()) { el.textContent = 'Cambios sin guardar'; el.className = 'estado cambios'; }
  else if (info?.pendiente) { el.textContent = 'Guardado · falta aprobar'; el.className = 'estado pendiente'; el.title = 'Los cambios están guardados en el borrador; pasan a la versión publicada cuando quien publica los aprueba.'; }
  else { el.textContent = 'Guardado · publicado'; el.className = 'estado ok'; el.title = 'Este capítulo coincide con la versión publicada.'; }
}

// ------------------------------------------------------------ Cambios pendientes de aprobación
const nombreCapitulo = (c, i) => `${String(i + 1).padStart(2, '0')} · ${c.titulo}${c.pendiente ? '  ◆' : ''}${c.comentarios ? `  · ${c.comentarios} coment.` : ''}`;
function actualizarPendientes(lista) {
  if (!estado.libro) return;
  if (lista) {
    const rutas = new Set(lista.map((p) => p.ruta));
    estado.libro.capitulos.forEach((c) => { c.pendiente = rutas.has(c.ruta); });
  }
  const opts = [...$('sel-cap').options];
  estado.libro.capitulos.forEach((c, i) => { const o = opts.find((x) => x.value === c.ruta); if (o) o.textContent = nombreCapitulo(c, i); });
  const n = estado.libro.capitulos.filter((c) => c.pendiente).length;
  $('b-cambios').innerHTML = n ? `Cambios <span class="insignia">${n}</span>` : 'Cambios';
  $('b-cambios').title = n ? `${n} capítulo(s) con cambios sin aprobar` : 'No hay cambios pendientes';
  actualizarEstado();
}

let tBorrador, tRender;
function alEditar() {
  actualizarEstado();
  clearTimeout(tRender); tRender = setTimeout(renderizar, $('src').value.length > 60000 ? 220 : 60);
  clearTimeout(tBorrador);
  tBorrador = setTimeout(() => {
    if (!estado.cap || estado.viendoVersion) return;
    if (hayCambios()) almacen.set(claveBorrador(estado.cap.ruta), { texto: $('src').value, sha: estado.cap.sha, fecha: Date.now() });
    else almacen.del(claveBorrador(estado.cap.ruta));
  }, 500);
}
$('src').addEventListener('input', alEditar);
window.Deshacer?.iniciar({ textarea: $('src'), deshacer: $('b-deshacer'), rehacer: $('b-rehacer') });

window.addEventListener('beforeunload', (e) => { if (hayCambios()) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------ Guardar y conflictos
async function guardar(forzarSha) {
  if (!estado.cap || estado.viendoVersion) return;
  if (!hayCambios() && !forzarSha) { aviso('No hay cambios para guardar.'); return; }
  const btn = $('b-guardar'); btn.textContent = 'Guardando…';
  const nota = $('nota').value.trim();
  const libroTitulo = estado.libros.find((l) => l.id === estado.libro.id)?.titulo || estado.libro.id;
  const mensaje = `${libroTitulo} · ${estado.cap.titulo}: ${nota || 'corrección'}`;
  const texto = $('src').value;
  try {
    const r = await api('/api/archivo', { metodo: 'PUT', cuerpo: { ruta: estado.cap.ruta, texto, sha: forzarSha || estado.cap.sha, mensaje } });
    estado.cap.sha = r.sha; estado.cap.original = texto;
    const info = estado.libro.capitulos.find((c) => c.ruta === estado.cap.ruta);
    if (info) info.sha = r.sha;
    const nuevoTitulo = texto.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (nuevoTitulo && info && nuevoTitulo !== info.titulo) {
      info.titulo = nuevoTitulo; estado.cap.titulo = nuevoTitulo;
      const opt = [...$('sel-cap').options].find((o) => o.value === info.ruta);
      if (opt) opt.textContent = opt.textContent.replace(/·.*$/, `· ${nuevoTitulo}`);
    }
    almacen.del(claveBorrador(estado.cap.ruta));
    $('nota').value = '';
    if (info) info.pendiente = true;
    actualizarPendientes(); aviso(estado.usuario?.publicador ? 'Guardado en el borrador (aprobalo en «Cambios»)' : 'Guardado: queda pendiente de aprobación');
  } catch (e) {
    if (e.status === 409) {
      estado.conflicto = e.datos;
      const cuando = e.datos.fecha ? new Date(e.datos.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
      $('conflicto-msg').textContent = `${e.datos.por || 'Otra persona'} guardó este capítulo${cuando ? ' el ' + cuando : ''} mientras lo editabas. Si guardás la tuya, reemplazás esos cambios (aunque siguen en el historial).`;
      almacen.set(claveBorrador(estado.cap.ruta), { texto, sha: estado.cap.sha, fecha: Date.now() });
      $('dlg-conflicto').showModal();
    } else aviso(e.message, 5000);
  } finally { btn.textContent = 'Guardar'; }
}
$('b-guardar').onclick = () => guardar();
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); guardar(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && document.activeElement === $('src')) { e.preventDefault(); aplicar({ tipo: 'cursiva' }); }
});
$('b-conf-ver').onclick = () => {
  const act = estado.conflicto?.actual; $('dlg-conflicto').close();
  if (!act) return;
  estado.cap.sha = act.sha; estado.cap.original = act.texto; $('src').value = act.texto;
  const b = almacen.get(claveBorrador(estado.cap.ruta));
  mostrarAviso('Cargaste la versión nueva. Tu versión quedó guardada en este navegador.', [
    ['Volver a la mía', () => { if (b) { $('src').value = b.texto; alEditar(); } ocultarAviso(); }],
    ['Olvidar la mía', () => { almacen.del(claveBorrador(estado.cap.ruta)); ocultarAviso(); }],
  ]);
  actualizarEstado(); renderizar();
};
$('b-conf-mia').onclick = () => { const sha = estado.conflicto?.actual?.sha; $('dlg-conflicto').close(); if (sha) guardar(sha); };

function mostrarAviso(texto, botones = []) {
  const a = $('aviso'); a.innerHTML = '';
  const s = document.createElement('span'); s.textContent = texto; a.appendChild(s);
  const g = document.createElement('div'); g.className = 'acciones';
  for (const [t, fn] of botones) { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; g.appendChild(b); }
  a.appendChild(g); a.hidden = false;
}
function ocultarAviso() { $('aviso').hidden = true; }

// ------------------------------------------------------------ Historial
$('b-historial').onclick = async () => {
  if (!estado.cap) return;
  const ol = $('lista-historial'); ol.innerHTML = '<li class="cuando">Cargando…</li>';
  $('dlg-historial').showModal();
  try {
    const h = await api(`/api/historial?ruta=${encodeURIComponent(estado.cap.ruta)}`);
    ol.innerHTML = '';
    h.forEach((c, i) => {
      const li = document.createElement('li');
      const fecha = new Date(c.fecha).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
      li.innerHTML = `<span class="quien">${esc(c.autor)}</span><span class="cuando">${esc(fecha)}</span>${i === 0 ? '<span class="chip ok">actual</span>' : ''}<span class="que">${esc(c.mensaje)}</span>`;
      if (i > 0) {
        const der = document.createElement('div'); der.className = 'der';
        const ver = document.createElement('button'); ver.textContent = 'Ver esta versión';
        ver.onclick = () => verVersion(c, fecha);
        der.appendChild(ver); li.appendChild(der);
      }
      ol.appendChild(li);
    });
    if (!h.length) ol.innerHTML = '<li class="cuando">Sin historial.</li>';
  } catch (e) { ol.innerHTML = `<li class="error">${esc(e.message)}</li>`; }
};

async function verVersion(c, fecha) {
  if (hayCambios() && !confirm('Tenés cambios sin guardar. ¿Ver otra versión igual? (quedan guardados en este navegador)')) return;
  try {
    const a = await api(`/api/archivo?ruta=${encodeURIComponent(estado.cap.ruta)}&ref=${c.sha}`);
    $('dlg-historial').close();
    clearTimeout(tBorrador);
    const previo = $('src').value; // lo que había en pantalla (con o sin cambios)
    if (previo !== estado.cap.original) almacen.set(claveBorrador(estado.cap.ruta), { texto: previo, sha: estado.cap.sha, fecha: Date.now() });
    estado.viendoVersion = { texto: a.texto };
    $('src').value = a.texto; $('src').readOnly = true;
    mostrarAviso(`Versión de ${c.autor} del ${fecha} (solo lectura).`, [
      ['Volver a la actual', () => { estado.viendoVersion = null; $('src').readOnly = false; $('src').value = previo; ocultarAviso(); alEditar(); renderizar(); }],
      ['Usar esta versión', () => { estado.viendoVersion = null; $('src').readOnly = false; $('nota').value = `vuelvo a la versión del ${fecha}`; ocultarAviso(); alEditar(); aviso('Revisala y tocá Guardar para confirmarla.', 4000); }],
    ]);
    actualizarEstado(); renderizar();
  } catch (e) { aviso(e.message, 5000); }
}

// ------------------------------------------------------------ Exportar
let tExport;
$('b-exportar').onclick = () => { $('dlg-exportar').showModal(); cargarExportaciones(); };
$('b-generar').onclick = async () => {
  if (hayCambios()) { if (!confirm('Tenés cambios sin guardar: el PDF se va a generar sin ellos. ¿Seguir?')) return; }
  $('exportar-msg').textContent = 'Iniciando…';
  try {
    const version = document.querySelector('input[name="version-export"]:checked')?.value || 'publicada';
    await api('/api/exportar', { metodo: 'POST', cuerpo: { libro: estado.libro.id, version } });
    $('exportar-msg').textContent = 'Listo: la exportación empezó. Aparece abajo en unos segundos.';
    setTimeout(cargarExportaciones, 4000);
  } catch (e) { $('exportar-msg').textContent = e.message; }
};
async function cargarExportaciones() {
  clearTimeout(tExport);
  const ol = $('lista-export');
  try {
    const runs = await api('/api/exportaciones');
    ol.innerHTML = '';
    let enCurso = false;
    for (const r of runs) {
      const li = document.createElement('li');
      const fecha = new Date(r.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
      let chip;
      if (r.estado !== 'completed') { chip = '<span class="chip va">generando…</span>'; enCurso = true; }
      else if (r.resultado === 'success') chip = '<span class="chip ok">listo</span>';
      else chip = `<span class="chip mal">${r.resultado === 'cancelled' ? 'cancelada' : 'falló'}</span>`;
      li.innerHTML = `${chip}<span class="cuando">${esc(fecha)}</span><span class="que">${esc(r.titulo)}</span>`;
      if (r.estado === 'completed' && r.resultado === 'success') {
        const der = document.createElement('div'); der.className = 'der';
        const b = document.createElement('button'); b.textContent = 'Descargar';
        b.onclick = () => descargar(r.id, b);
        der.appendChild(b); li.appendChild(der);
      }
      ol.appendChild(li);
    }
    if (!runs.length) ol.innerHTML = '<li class="cuando">Todavía no hay exportaciones.</li>';
    if (enCurso && $('dlg-exportar').open) tExport = setTimeout(cargarExportaciones, 12000);
  } catch (e) { ol.innerHTML = `<li class="error">${esc(e.message)}</li>`; }
}
async function descargar(id, boton) {
  boton.textContent = 'Preparando…';
  try {
    const d = await api(`/api/descargar?id=${id}`);
    window.location.href = d.url; // descarga un .zip con el PDF y el EPUB
  } catch (e) { aviso(e.message, 5000); }
  finally { setTimeout(() => { boton.textContent = 'Descargar'; }, 1500); }
}

// ------------------------------------------------------------ Diálogos
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-cerrar]')) d.close(); });
});

// ------------------------------------------------------------ Ficha: botones y referencia
function tipoDeMarca(m) {
  const marca = (m || '').trim();
  let x;
  if ((x = marca.match(/^:::\s*([\p{L}\w-]+)/u))) return { tipo: 'bloque', clase: x[1] };
  if (/^##\s+Parte\b/i.test(marca)) return { tipo: 'parte' };
  if ((x = marca.match(/^(#{1,4})\s.*?(\s*\{[^}]*\})?$/))) return { tipo: 'titulo', nivel: x[1].length, atributos: (x[2] || '').trim() };
  if (/^>\s?/.test(marca)) return { tipo: 'cita' };
  if (/^(\*\s*){3,}$|^(-\s*){3,}$/.test(marca)) return { tipo: 'separador' };
  if (/^\d+\.\s/.test(marca)) return { tipo: 'lista' };
  if (/^!\[/.test(marca)) return { tipo: 'imagen', clase: marca.match(/\{\.([\w-]+)\}/)?.[1] || 'tabla' };
  if (/^\*[^*]/.test(marca)) return { tipo: 'cursiva' };
  if (/\[\^\d+\]/.test(marca)) return { tipo: 'nota' };
  return null;
}

function construirToolbar(etiquetas) {
  const tb = $('toolbar'); tb.innerHTML = '';
  const grupos = {};
  for (const e of etiquetas) {
    const t = tipoDeMarca(e.marca); if (!t) continue;
    const g = e.grupo || 'Etiquetas';
    if (!grupos[g]) {
      const div = document.createElement('div'); div.className = 'grp';
      div.innerHTML = `<span class="lbl">${esc(g)}</span>`; tb.appendChild(div); grupos[g] = div;
    }
    const b = document.createElement('button');
    b.textContent = e.nombre; b.title = [e.uso, e.estilo].filter(Boolean).join(' — ');
    if (t.tipo === 'bloque') b.className = 'bloque';
    if (t.tipo === 'cursiva') b.innerHTML = `<i>${esc(e.nombre)}</i>`;
    b.onclick = () => aplicar(t);
    grupos[g].appendChild(b);
  }
}

function construirFicha() {
  const f = estado.libro.ficha;
  $('ficha-origen').textContent = `Este libro usa la ficha «${f.nombre || estado.libro.fichaRuta}» (${estado.libro.fichaRuta}).`;
  const p = f.pagina || {}, t = f.tipografia || {}, ti = f.titulos || {};
  const filas = [
    ['Página', `${p.ancho} × ${p.alto}`],
    ['Márgenes', `interior ${p['margen-interior']} · exterior ${p['margen-exterior']} · superior ${p['margen-superior']} · inferior ${p['margen-inferior']}`],
    ['Tipografía', `${t.familia} · ${t.cuerpo} sobre ${t.interlineado} · sangría ${t.sangria}`],
    ['Títulos', Object.entries(ti).map(([k, v]) => `${k} ${v}`).join(' · ')],
    ['Capítulos', `empiezan en página ${f.paginacion?.['capitulo-empieza-en'] || 'impar'}`],
  ];
  $('ficha-specs').innerHTML = filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('ficha-tabla').innerHTML = (f.etiquetas || []).map((e) =>
    `<tr><td>${esc(e.nombre)}</td><td><code>${esc(e.marca)}</code></td><td>${esc(e.uso)}</td><td>${esc(e.estilo)}</td></tr>`).join('');
}
$('b-ficha').onclick = () => $('dlg-ficha').showModal();

// ------------------------------------------------------------ Aplicar etiquetas
function lineasSeleccionadas() {
  const ta = $('src'), v = ta.value;
  let a = ta.selectionStart, b = ta.selectionEnd;
  a = v.lastIndexOf('\n', a - 1) + 1;
  const nb = v.indexOf('\n', b);
  b = nb === -1 ? v.length : (b > a && v[b - 1] === '\n' ? b - 1 : nb);
  return { a, b, txt: v.slice(a, b) };
}
function reemplazar(a, b, txt, selA, selB) {
  const ta = $('src'); ta.focus(); ta.setSelectionRange(a, b);
  if (!document.execCommand || !document.execCommand('insertText', false, txt)) ta.setRangeText(txt, a, b, 'end');
  if (selA != null) ta.setSelectionRange(selA, selB);
  alEditar();
}
const sinMarcas = (t) => t.replace(/^#{1,4}\s+/, '').replace(/\s*\{[^}]*\}\s*$/, '').replace(/^\d{1,2}\.\s+/, '').replace(/^>\s?/, '');

function aplicar(t) {
  if ($('src').readOnly) { aviso('Estás viendo una versión anterior.'); return; }
  const v = $('src').value;
  if (t.tipo === 'titulo' || t.tipo === 'parte') {
    const { a, b, txt } = lineasSeleccionadas();
    let base = sinMarcas(txt).trim() || 'Título';
    const pre = t.tipo === 'parte' ? '## ' : '#'.repeat(t.nivel) + ' ';
    if (t.tipo === 'parte' && !/^Parte\s+[IVXLC]+/i.test(base)) base = 'Parte I: ' + base;
    const post = t.atributos ? ' ' + t.atributos : '';
    reemplazar(a, b, pre + base + post, a + pre.length, a + pre.length + base.length);
  } else if (t.tipo === 'cita') {
    const { a, b, txt } = lineasSeleccionadas();
    const yaEsCita = txt.split('\n').filter((x) => x.trim()).every((x) => /^>/.test(x));
    const nuevo = yaEsCita
      ? txt.split('\n').map((x) => x.replace(/^>\s?/, '')).join('\n')          // segundo clic: la saca
      : (txt.trim() ? txt : 'Texto').split('\n').map((x) => (x.trim() ? '> ' + x : '>')).join('\n');
    reemplazar(a, b, nuevo, a, a + nuevo.length);
  } else if (t.tipo === 'separador') {
    const { b } = lineasSeleccionadas();
    reemplazar(b, b, '\n\n***\n', b + 7, b + 7);
  } else if (t.tipo === 'bloque') {
    const { a, b, txt } = lineasSeleccionadas();
    const cuerpo = txt.trim() ? txt : 'Texto';
    const pre = `::: ${t.clase}\n`;
    const antes = a > 0 && v[a - 2] !== '\n' ? '\n' : '';
    reemplazar(a, b, antes + pre + cuerpo + '\n:::', a + antes.length + pre.length, a + antes.length + pre.length + cuerpo.length);
  } else if (t.tipo === 'lista') {
    const { a, b, txt } = lineasSeleccionadas();
    const items = txt.split('\n').filter((x) => x.trim()).map((x, k) => `${k + 1}. ${sinMarcas(x).trim()}`).join('\n') || '1. Texto';
    reemplazar(a, b, items, a, a + items.length);
  } else if (t.tipo === 'cursiva') {
    const ta = $('src'); const a = ta.selectionStart, b = ta.selectionEnd; const s = v.slice(a, b) || 'texto';
    reemplazar(a, b, `*${s}*`, a + 1, a + 1 + s.length);
  } else if (t.tipo === 'nota') {
    const usados = [...v.matchAll(/\[\^(\d+)\]/g)].map((m) => +m[1]);
    const n = (usados.length ? Math.max(...usados) : 0) + 1;
    const ta = $('src'); const b = ta.selectionEnd;
    reemplazar(b, b, `[^${n}]`);
    const fin = $('src').value.length; const nota = `Texto de la nota ${n}`;
    const def = `${$('src').value.endsWith('\n') ? '' : '\n'}\n[^${n}]: ${nota}\n`;
    reemplazar(fin, fin, def, fin + def.length - nota.length - 1, fin + def.length - 1);
  } else if (t.tipo === 'imagen') {
    const { b } = lineasSeleccionadas(); const cap = 'Epígrafe';
    const ins = `\n\n![${cap}](img/nombre-del-archivo.jpg){.${t.clase}}\n`;
    reemplazar(b, b, ins, b + 4, b + 4 + cap.length);
  }
}

// ------------------------------------------------------------ Fotos
const versionFoto = {};   // ruta relativa -> marca para no ver la foto vieja guardada en el navegador
const urlFoto = (rel) => {
  const r = rel.replace(/^\.\//, '');
  return `/api/raw?ruta=${encodeURIComponent(estado.libro.base + '/' + r)}${versionFoto[r] ? '&v=' + versionFoto[r] : ''}`;
};
const RE_FOTO = /^!\[([^\]]*)\]\(([^)\s]+)\)(\{[^}]*\})?[ \t]*$/gm;
function fotosDelTexto() {
  return [...$('src').value.matchAll(RE_FOTO)].map((m) => ({ pos: m.index, linea: m[0], epigrafe: m[1], ruta: m[2], marca: m[3] || '' }));
}
function dibujarFotos() {
  const fotos = fotosDelTexto();
  const ol = $('lista-fotos');
  if (!fotos.length) { ol.innerHTML = '<li class="ayuda">Este capítulo no tiene fotos. Para agregar una, usá el botón de foto de la barra de etiquetas y después volvé acá.</li>'; return; }
  ol.innerHTML = fotos.map((f, i) => {
    const pendiente = /(^|\/)pendiente-/.test(f.ruta);
    return `<li class="foto-fila${pendiente ? ' pendiente' : ''}" data-i="${i}">
      <img src="${/^https?:/.test(f.ruta) ? esc(f.ruta) : esc(urlFoto(f.ruta))}" alt="" loading="lazy">
      <div class="foto-datos"><div class="foto-epi">${esc(f.epigrafe || '(sin epígrafe)')}</div>
        <div class="ayuda">${pendiente ? 'Falta la foto · ' : ''}${esc(f.ruta.replace(/^img\//, ''))}</div>
        <label class="boton-archivo"><span>${pendiente ? 'Subir foto' : 'Cambiar foto'}</span><input type="file" accept="image/*" hidden></label>
        <span class="foto-estado" role="status"></span></div></li>`;
  }).join('');
}
// Achica la foto (lado mayor 1800 px, JPG) para que suba rápido y pese poco en el libro.
async function achicarFoto(archivo) {
  const bmp = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.86));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
$('b-fotos').onclick = () => { dibujarFotos(); $('dlg-fotos').showModal(); };
$('lista-fotos').addEventListener('change', async (e) => {
  const inp = e.target.closest('input[type=file]'); if (!inp || !inp.files[0]) return;
  const fila = inp.closest('.foto-fila'); const est = fila.querySelector('.foto-estado');
  if ($('src').readOnly) { est.textContent = 'Estás viendo una versión anterior.'; return; }
  const f = fotosDelTexto()[+fila.dataset.i]; if (!f) return;
  est.textContent = 'Subiendo…';
  try {
    const datos = await achicarFoto(inp.files[0]);
    const base = f.ruta.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/^pendiente-/, 'foto-');
    const r = await api('/api/foto', { metodo: 'POST', cuerpo: { libro: estado.libro.id, nombre: base, datos } });
    versionFoto[r.ruta] = Date.now();
    // se cambia solo la ruta de esa línea, para que Deshacer la devuelva
    const actual = fotosDelTexto()[+fila.dataset.i];
    const nueva = actual.linea.replace(`](${actual.ruta})`, `](${r.ruta})`);
    reemplazar(actual.pos, actual.pos + actual.linea.length, nueva);
    aviso('Foto subida.'); dibujarFotos(); renderizar();
  } catch (err) { est.textContent = err.message || 'No se pudo subir la foto.'; }
  inp.value = '';
});

// ------------------------------------------------------------ Vista previa
// «letra» agranda o achica solo la tipografía (todo lo que está en pt); la página (en mm) no cambia,
// así se ve cuántos caracteres entran por línea con una letra más chica o más grande.
function variablesFicha(f, letra = 1) {
  const v = [];
  for (const [s, valores] of Object.entries(f)) {
    if (!valores || typeof valores !== 'object' || Array.isArray(valores) || s === 'paginacion') continue;
    for (const [k, val] of Object.entries(valores)) {
      let x = val;
      if (k === 'familia') x = `"${val}"`;
      else if (letra !== 1 && /^\s*[\d.]+\s*pt\s*$/.test(String(val))) x = `${+(parseFloat(val) * letra).toFixed(2)}pt`;
      v.push(`--${s}-${k}: ${x};`);
    }
  }
  return `:root{${v.join('')}}`;
}

const CSS_VISTA = `
html{background:#e9e7e2;overflow-x:hidden}
body{margin:0;padding:16px 12px 60px}
.hoja{background:#fff;color:#000;width:var(--pagina-ancho);margin:0 auto;box-sizing:border-box;
  padding:var(--pagina-margen-superior) var(--pagina-margen-exterior) var(--pagina-margen-inferior) var(--pagina-margen-interior);
  box-shadow:0 1px 3px rgba(0,0,0,.18)}
.encabezado{font-size:var(--tipografia-pie,8pt);text-align:right;color:#555;margin-bottom:10mm}
.nota-interna{display:block!important;font-family:system-ui,sans-serif;font-size:12px;line-height:1.45;background:#fff6e5;border:1px dashed #b7791f;padding:6px 8px;margin:8px 0}
.nota-interna p{text-indent:0;text-align:left}
.nota-interna::before{content:"Nota interna · no se imprime";display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#8a5a12;margin-bottom:3px}
.desconocida{outline:1px dashed #c0392b;outline-offset:2px}
.desconocida::before{content:"Etiqueta desconocida: " attr(data-clase);display:block;font:11px system-ui,sans-serif;color:#c0392b}
.falta-img{border:1px dashed #999;padding:2em;font:12px system-ui,sans-serif;color:#666}
.marca-anio{display:block!important;font:11px system-ui,sans-serif;color:#0a5c8a;border-top:1px dashed #7fb3d5;padding-top:2px;margin:6px 0;text-align:left}
.marca-anio::before{content:"Desde acá, el pie de página dice: "}
.pie-vista{font:11px system-ui,sans-serif;color:#777;text-align:center;margin-top:16px}
.ref-nota{font-size:.7em;line-height:0}
.notas-pie{margin-top:2em;padding-top:.5em;border-top:.4pt solid #000;width:100%;font-size:8pt;line-height:10.2pt}
.notas-pie p{text-indent:0;margin:0 0 .3em}`;

function prepararVista() {
  const L = estado.libro;
  const estilos = (L.estilos || '').replace(/url\(["']?(?!https?:|data:|\/)([^"')]+)["']?\)/g,
    (m, rel) => `url("/api/raw?ruta=${encodeURIComponent(L.fichaDir + '/' + rel)}")`);
  const doc = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style id="vars">${variablesFicha(L.ficha, letraVista())}</style>
<style>${estilos}</style><style>${CSS_VISTA}</style></head><body><div class="hoja"><div class="encabezado" id="enc"></div><div id="c"></div></div>
<p class="pie-vista">Vista continua. La paginación final la hace la exportación a PDF.</p></body></html>`;
  const f = $('vista');
  f.onload = () => {
    ajustarHoja(); renderizar();
    f.contentWindow.addEventListener('resize', ajustarHoja);
  };
  f.srcdoc = doc;
}

// La hoja se escala para entrar justo en el ancho del panel: se ve la página entera,
// con los mismos cortes de línea que el libro, y nunca hace falta moverse a los costados.
function ajustarHoja() {
  const d = $('vista').contentDocument; const h = d?.querySelector('.hoja'); if (!h) return;
  h.style.zoom = 1;
  const disponible = d.documentElement.clientWidth - 24;      // padding del body
  const ancho = h.getBoundingClientRect().width;
  if (ancho > 0) h.style.zoom = Math.min(1.6, disponible / ancho).toFixed(4);
}
const letraVista = () => +$('zoom').value || 1;
$('zoom').onchange = () => {
  almacen.set('letra', $('zoom').value);
  $('original').style.setProperty('--or-letra', letraVista());
  const d = $('vista').contentDocument; const v = d?.getElementById('vars');
  if (v && estado.libro) { v.textContent = variablesFicha(estado.libro.ficha, letraVista()); ajustarHoja(); }
};
{ const z = almacen.get('letra'); if (z && [...$('zoom').options].some((o) => o.value === z)) $('zoom').value = z; }
$('original').style.setProperty('--or-letra', letraVista());

// ------------------------------------------------------------ Divisor entre texto y página
// Se arrastra para dar más lugar a uno u otro panel (también con las flechas del teclado;
// doble clic vuelve a la mitad). La página se reacomoda sola al nuevo ancho.
(() => {
  const main = $('main'); const div = $('divisor'); if (!div) return;
  const aplicar = (p) => {
    p = Math.min(0.8, Math.max(0.2, p));
    main.style.setProperty('--izq', `${p}fr`); main.style.setProperty('--der', `${1 - p}fr`);
    div.setAttribute('aria-valuenow', Math.round(p * 100));
    return p;
  };
  let actual = aplicar(almacen.get('divisor') ?? 0.49);
  const guardar = () => almacen.set('divisor', actual);
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault(); div.setPointerCapture(e.pointerId); main.classList.add('arrastrando');
    const r = main.getBoundingClientRect();
    const mover = (ev) => { actual = aplicar((ev.clientX - r.left) / r.width); };
    const soltar = () => {
      main.classList.remove('arrastrando'); guardar();
      div.removeEventListener('pointermove', mover); div.removeEventListener('pointerup', soltar); div.removeEventListener('pointercancel', soltar);
    };
    div.addEventListener('pointermove', mover); div.addEventListener('pointerup', soltar); div.addEventListener('pointercancel', soltar);
  });
  div.addEventListener('keydown', (e) => {
    const paso = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
    if (paso) { e.preventDefault(); actual = aplicar(actual + paso); guardar(); }
  });
  div.addEventListener('dblclick', () => { actual = aplicar(0.49); guardar(); });
})();

// Convierte el texto marcado en HTML con las mismas clases que produce la exportación (herramientas/marcas.lua).
function inline(s) {
  // los caracteres escapados (\* \_ \[ …) se muestran tal cual y no abren cursiva
  const esc2 = []; s = s.replace(/\\([\\*_\[\]<`#>])/g, (m, c) => { esc2.push(c); return `\u0000${esc2.length - 1}\u0000`; });
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/&quot;(.+?)&quot;/g, '“$1”')
    .replace(/(^|[\s(])--(?=\s|$)/g, '$1–')
    .replace(/\u0000(\d+)\u0000/g, (m, k) => esc(esc2[+k]));
}
function figura(linea) {
  const m = linea.match(/^!\[([^\]]*)\]\(([^)\s]+)\)(\{\.([\w-]+)\})?\s*$/); if (!m) return null;
  const ruta = /^https?:/.test(m[2]) ? m[2] : urlFoto(m[2]);
  return `<figure class="${esc(m[4] || '')}"><img src="${esc(ruta)}" alt="${esc(m[1])}" onerror="this.outerHTML='<div class=falta-img>No encuentro la imagen ${esc(m[2])}</div>'">${m[1] ? `<figcaption>${inline(m[1])}</figcaption>` : ''}</figure>`;
}
function entradaGlosario(t) {
  const cortes = [/\s\(/, /:/, /\.\s/, /\.$/].map((r) => t.search(r)).filter((x) => x > 0);
  if (!cortes.length) return inline(t);
  const c = Math.min(...cortes);
  return `<span class="termino">${inline(t.slice(0, c))}</span>${inline(t.slice(c))}`;
}
const CLASES_CONOCIDAS = () => new Set((estado.libro.ficha.etiquetas || []).map((e) => tipoDeMarca(e.marca)).filter((t) => t?.tipo === 'bloque').map((t) => t.clase));
// Bloques que respetan los renglones («lineas: si» en la ficha)
const CLASES_CON_RENGLONES = () => new Set((estado.libro.ficha.etiquetas || []).filter((e) => /^(si|sí|true)$/i.test(String(e.lineas ?? '')))
  .map((e) => tipoDeMarca(e.marca)).filter((t) => t?.tipo === 'bloque').map((t) => t.clase));

function aHtml(texto) {
  const notas = {}; const orden = [];
  texto = texto.replace(/^\[\^(\d+)\]:\s*(.*)$/gm, (m, id, t) => { notas[id] = t; return ''; });
  const L = texto.replace(/\r/g, '').split('\n');
  const conocidas = CLASES_CONOCIDAS();
  const renglones = CLASES_CON_RENGLONES();
  let h = ''; let buf = []; let lista = []; let cita = [];
  const parrafos = (lineas, clase) => lineas.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    if (clase === 'contacto') return p.split('\n').map((x) => `<p>${inline(x)}</p>`).join('');
    if (renglones.has(clase)) return `<p>${p.split('\n').map((x) => inline(x.trim())).join('<br>')}</p>`;
    const f = figura(p); if (f) return f;
    const plano = p.replace(/\n/g, ' ');
    return `<p>${clase === 'entrada' ? entradaGlosario(plano) : inline(plano)}</p>`;
  }).join('');
  const vaciarP = () => { if (buf.length) { h += parrafos(buf); buf = []; } };
  const vaciarL = () => { if (lista.length) { h += `<ol start="${lista[0].n}">${lista.map((x) => `<li>${inline(x.t)}</li>`).join('')}</ol>`; lista = []; } };
  const vaciarC = () => { if (cita.length) { h += `<blockquote>${parrafos(cita)}</blockquote>`; cita = []; } };
  const vaciar = () => { vaciarP(); vaciarL(); vaciarC(); };
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const div = l.match(/^:::\s*([\p{L}\w-]+)\s*$/u);
    if (div) {
      vaciar(); const clase = div[1]; const dentro = []; i++;
      while (i < L.length && !/^:::\s*$/.test(L[i])) { dentro.push(L[i]); i++; }
      if (clase === 'año' || clase === 'anio') {
        h += `<div class="marca-anio">año ${esc(dentro.join(' ').trim())}</div>`; continue;
      }
      const ok = conocidas.has(clase) || clase === 'nota-interna';
      h += `<div class="${esc(clase)}${ok ? '' : ' desconocida'}" data-clase="${esc(clase)}">${parrafos(dentro, clase)}</div>`;
      continue;
    }
    const q = l.match(/^>\s?(.*)$/);
    if (q) { vaciarP(); vaciarL(); cita.push(q[1]); continue; }
    if (cita.length && l.trim()) { cita.push(l); continue; }   // continuación perezosa de la cita
    if (/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$/.test(l)) { vaciar(); h += '<hr>'; continue; }
    const t = l.match(/^(#{1,4})\s+(.*?)\s*(?:\{([^}]*)\})?\s*$/);
    if (t) {
      vaciar(); const n = t[1].length, tx = t[2];
      const clases = (t[3] || '').split(/\s+/).filter((c) => c.startsWith('.')).map((c) => c.slice(1)).join(' ');
      if (n === 2) {
        const p = tx.match(/^(Parte\s+[IVXLC]+)\s*:?\s*(.*)$/i);
        h += p ? `<h2 class="parte"><span>${esc(p[1])}</span>${p[2] ? `<span>${inline(p[2])}</span>` : ''}</h2>` : `<h2 class="seccion">${inline(tx)}</h2>`;
      } else h += `<h${n}${clases ? ` class="${esc(clases)}"` : ''}>${inline(tx)}</h${n}>`;
      continue;
    }
    const li = l.match(/^(\d{1,3})\.\s+(.*)$/);
    if (li) { vaciarP(); vaciarC(); lista.push({ n: +li[1], t: li[2] }); continue; }
    if (!l.trim()) { vaciar(); continue; }
    vaciarL(); vaciarC(); buf.push(l);
  }
  vaciar();
  h = h.replace(/\[\^(\d+)\]/g, (m, id) => { if (!orden.includes(id)) orden.push(id); return `<sup class="ref-nota">${orden.indexOf(id) + 1}</sup>`; });
  if (orden.length) h += `<div class="notas-pie">${orden.map((id, k) => `<p><span>${k + 1}.</span> ${inline(notas[id] || '(falta el texto de esta nota)')}</p>`).join('')}</div>`;
  return h;
}

function renderizar() {
  window.Ortografia?.textoCambio();
  window.Comentarios?.textoCambio();
  window.Original?.textoCambio();
  const d = $('vista').contentDocument;
  const c = d?.getElementById('c'); if (!c || !estado.cap) return;
  const texto = $('src').value;
  c.innerHTML = aHtml(texto);
  d.getElementById('enc').textContent = (texto.match(/^#\s+(.+)$/m)?.[1] || '').replace(/\s*\{[^}]*\}\s*$/, '');
}

// ------------------------------------------------------------ Vista en pantallas chicas
function vista(v) {
  $('main').dataset.vista = v;
  $('tab-texto').setAttribute('aria-pressed', v === 'texto');
  $('tab-pagina').setAttribute('aria-pressed', v === 'pagina');
}
$('tab-texto').onclick = () => vista('texto');

// ------------------------------------------------------------ Panel derecho: página u original
window.Original?.iniciar({ textarea: $('src'), contenedor: $('original'), api });
function modoPanel(m) {
  const original = m === 'original';
  $('pv-pagina').setAttribute('aria-pressed', !original);
  $('pv-original').setAttribute('aria-pressed', original);
  $('vista').hidden = original; $('original').hidden = !original;
  $('main').classList.toggle('con-original', original);
  almacen.set('panel', m);
  window.Original?.mostrar(original);
  if (!original) ajustarHoja();
}
$('pv-pagina').onclick = () => modoPanel('pagina');
$('pv-original').onclick = () => modoPanel('original');
modoPanel(almacen.get('panel') === 'original' ? 'original' : 'pagina');
$('tab-pagina').onclick = () => vista('pagina');

// ------------------------------------------------------------ Ortografía
window.Ortografia?.iniciar({
  textarea: $('src'),
  interruptor: $('orto-activa'),
  contador: $('orto-contador'),
  aviso,
  alAgregarPalabra: (palabra) => api('/api/diccionario', { metodo: 'POST', cuerpo: { ruta: estado.libro?.diccionarioRuta, palabra } }),
});
$('b-orto').onclick = () => window.Ortografia?.abrirPanel($('dlg-orto'), $('orto-lista'));
$('b-escucha').onclick = () => { location.href = `escucha.html?libro=${encodeURIComponent(estado.libro?.id || '')}&cap=${encodeURIComponent(estado.cap?.ruta || '')}`; };
$('b-orto-opc').onclick = () => window.Ortografia?.abrirOpciones($('dlg-orto-opc'), $('orto-opc'), estado.libro?.palabrasDiccionario || 0);

// ------------------------------------------------------------ Comentarios
// El texto y el panel de comentarios van uno al lado del otro
(() => {
  const env = $('src').parentNode; const fila = document.createElement('div'); fila.className = 'fila-ed';
  env.parentNode.insertBefore(fila, env); fila.appendChild(env); fila.appendChild($('panel-com'));
})();
window.Comentarios?.iniciar({
  textarea: $('src'), panel: $('panel-com'), botonPanel: $('b-comentarios'), botonComentar: $('b-comentar'),
  api, aviso, usuario: () => estado.usuario || {}, soloLectura: () => !!estado.viendoVersion,
  alCambiarCantidad: (ruta, n) => {
    const c = estado.libro?.capitulos.find((x) => x.ruta === ruta);
    if (c && c.comentarios !== n) { c.comentarios = n; actualizarPendientes(); }
  },
});

// ------------------------------------------------------------ Revisión y aprobación
window.Revision?.iniciar({
  dialogo: $('dlg-revision'), cuerpo: $('revision-cuerpo'), api, aviso,
  usuario: () => estado.usuario || {}, libro: () => estado.libro,
  alActualizarPendientes: (lista) => actualizarPendientes(lista),
  alCambiarCapitulo: (ruta) => {
    if (estado.cap?.ruta !== ruta) return;
    if (hayCambios()) aviso('Se rechazaron cambios de este capítulo: guardá o descartá lo tuyo y volvé a abrirlo.', 6000);
    else abrirCapitulo(ruta, true);
  },
});
$('b-cambios').onclick = () => window.Revision?.abrir();
