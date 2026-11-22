// Modo escucha: lee en voz alta el original (inglés) y la traducción, párrafo por párrafo,
// y deja dictar correcciones o sugerencias, que se guardan como comentarios del capítulo
// (el equipo los ve en el editor). Pensado para usarse sin mirar la pantalla: órdenes por voz,
// teclado y botones grandes.
//
// Voz que lee: voces naturales de Google (vía /api/voz, si está configurado) o, si no, las del
// navegador (speechSynthesis). Órdenes y dictado: SpeechRecognition (Chrome, Edge, Safari).
'use strict';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ API y sesión
async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  const op = { method: metodo, headers: { 'x-editor': '1' }, credentials: 'same-origin' };
  if (cuerpo !== undefined) { op.body = JSON.stringify(cuerpo); op.headers['content-type'] = 'application/json'; }
  let r;
  try { r = await fetch(ruta, op); } catch { throw new Error('Sin conexión. Revisá internet.'); }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !ruta.startsWith('/api/sesion')) mostrarEntrada('Tu sesión venció. Volvé a entrar.');
  if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status });
  return d;
}
const guardado = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* nada */ } },
};

async function mostrarEntrada(msg = '') {
  detenerTodo();
  $('app').hidden = true; $('entrada').hidden = false; $('entrada-error').textContent = msg;
  try {
    const cfg = await api('/api/config');
    await new Promise((ok, mal) => {
      if (window.google?.accounts?.id) return ok();
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = ok; s.onerror = () => mal(new Error('No se pudo cargar el inicio de sesión de Google.')); document.head.appendChild(s);
    });
    google.accounts.id.initialize({ client_id: cfg.googleClientId, auto_select: true, ux_mode: 'popup', callback: async (r) => {
      try { E.usuario = await api('/api/sesion', { metodo: 'POST', cuerpo: { credential: r.credential } }); iniciar(); }
      catch (e) { $('entrada-error').textContent = e.message; }
    } });
    $('boton-google').innerHTML = '';
    google.accounts.id.renderButton($('boton-google'), { theme: 'filled_black', size: 'large', text: 'signin_with', locale: 'es' });
  } catch (e) { $('entrada-error').textContent = e.message; }
}

// ------------------------------------------------------------ estado
const AJ_DEF = { orden: 'en-es', avance: 'auto', velEs: 1, velEn: 1, vozEs: '', vozEn: '', motor: 'google', gVozEs: '', gVozEn: '', letra: 28, tema: 'auto', pausaEn: 1.5, pausaEs: 4, instrucciones: 'primeras', vecesDictado: 0, mostrarEn: true };
const E = {
  usuario: null, libros: [], libro: null, caps: [], cap: -1,
  texto: '', unidades: [], idx: 0, tituloEn: '',
  modo: 'detenido',          // detenido | leyendo | pausa | dictando | confirmando
  fase: null, frase: 0,      // qué idioma y qué oración se está leyendo (para seguir desde ahí)
  aj: { ...AJ_DEF, ...guardado.get('escucha-ajustes', {}) },
  dictado: '', provisorio: '',
};

// ------------------------------------------------------------ texto (emparejar.js)
const { bloques, armarUnidades: emparejar } = window.Emparejar;
const armarUnidades = (texto, pares, tituloEn) => emparejar(texto, pares, tituloEn, E.cap + 1);

// ------------------------------------------------------------ voz que lee
// Dos motores: «google» (voces naturales, generadas en el servidor y guardadas en el navegador
// para no pedirlas dos veces) y «navegador» (speechSynthesis, sin costo y sin conexión).
const sintesis = window.speechSynthesis;
let voces = [];             // voces del navegador
let vocesGoogle = null;     // [{nombre, idioma, genero}] o null si no están configuradas
let googleCaidoHasta = 0;  // si Google falla, unos minutos con la voz del navegador antes de reintentar
const usarGoogle = () => E.aj.motor === 'google' && vocesGoogle && vocesGoogle.length > 0 && Date.now() > googleCaidoHasta;

function cargarVoces() {
  voces = sintesis ? sintesis.getVoices() : [];
  llenarVoces();
}
function llenarVoces() {
  const g = usarGoogle();
  const llenar = (sel, pref, actual) => {
    sel.innerHTML = '';
    let lista;
    if (g) {
      const puntaje = (v) => (/Chirp3-HD/.test(v.nombre) ? 3 : /Chirp-HD|Studio|Neural2/.test(v.nombre) ? 2 : 1) + (pref === 'es' && v.idioma === 'es-US' ? 0.5 : 0) + (pref === 'en' && v.idioma === 'en-US' ? 0.5 : 0);
      lista = vocesGoogle.filter((v) => v.idioma.startsWith(pref)).sort((a, b) => puntaje(b) - puntaje(a) || a.nombre.localeCompare(b.nombre));
      const tipo = (n) => (/Chirp3-HD/.test(n) ? 'Chirp 3 HD' : /Chirp-HD/.test(n) ? 'Chirp HD' : /Studio/.test(n) ? 'Studio' : /Neural2/.test(n) ? 'Neural2' : 'WaveNet');
      const gen = { FEMALE: 'mujer', MALE: 'hombre' };
      lista.forEach((v) => sel.add(new Option(`${v.nombre.split('-').pop()} · ${tipo(v.nombre)} · ${v.idioma}${gen[v.genero] ? ' · ' + gen[v.genero] : ''}`, v.nombre)));
      lista = lista.map((v) => v.nombre);
    } else {
      const vs = voces.filter((v) => v.lang.toLowerCase().startsWith(pref));
      const puntaje = (v) => (/natural|neural|premium|enhanced|mejorada|google|siri/i.test(v.name) ? 2 : 0) + (pref === 'es' && /es[-_](AR|419|US|MX|UY)/i.test(v.lang) ? 1 : 0) + (v.localService ? 0.5 : 0);
      vs.sort((a, b) => puntaje(b) - puntaje(a));
      vs.forEach((v) => sel.add(new Option(`${v.name} (${v.lang})`, v.name)));
      lista = vs.map((v) => v.name);
    }
    if (!lista.length) sel.add(new Option('(no hay voces en este idioma)', ''));
    sel.value = lista.includes(actual) ? actual : (lista[0] || '');
  };
  llenar($('aj-voz-es'), 'es', g ? E.aj.gVozEs : E.aj.vozEs);
  llenar($('aj-voz-en'), 'en', g ? E.aj.gVozEn : E.aj.vozEn);
  const m = $('aj-motor');
  m.options[0].disabled = !(vocesGoogle && vocesGoogle.length);
  m.options[0].textContent = vocesGoogle && vocesGoogle.length ? 'Voces naturales (Google)' : 'Voces naturales (Google) — no configuradas';
  m.value = g ? 'google' : 'navegador';
}
if (sintesis) { cargarVoces(); sintesis.onvoiceschanged = cargarVoces; }
async function cargarVocesGoogle() {
  try { vocesGoogle = (await api('/api/voces')).voces || []; } catch { vocesGoogle = null; }
  llenarVoces();
}

const voz = (lang) => voces.find((v) => v.name === (lang === 'en' ? $('aj-voz-en').value : $('aj-voz-es').value))
  || voces.find((v) => v.lang.toLowerCase().startsWith(lang));
const vozGoogle = (lang) => (lang === 'en' ? $('aj-voz-en').value : $('aj-voz-es').value)
  || vocesGoogle.find((v) => v.idioma.startsWith(lang))?.nombre;

// Partir en oraciones: Chrome corta las lecturas largas, y así se puede seguir desde la oración donde se pausó.
function oraciones(t) {
  const out = [];
  for (const linea of t.split('\n')) {
    const ps = linea.match(/[^.!?…;:]+[.!?…;:]+[”"’»)]*\s*|[^.!?…;:]+$/g) || [linea];
    let buf = '';
    for (const p of ps) {
      if ((buf + p).length > 220 && buf) { out.push(buf.trim()); buf = ''; }
      buf += p;
      if (buf.length > 60) { out.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter(Boolean);
}
// Para las voces de Google: trozos más largos (menos pedidos y entonación más natural); el
// primero, corto, para que empiece enseguida.
function trozos(t) {
  const out = []; let buf = '';
  for (const o of oraciones(t)) {
    const max = out.length ? 900 : 260;
    if (buf && (buf + ' ' + o).length > max) { out.push(buf); buf = ''; }
    buf = buf ? buf + ' ' + o : o;
  }
  if (buf) out.push(buf);
  return out;
}

let tokenHabla = 0;
let hablando = false, finHabla = 0;
function hablar(texto, lang, op = {}) {
  return usarGoogle() ? hablarGoogle(texto, lang, op) : hablarNavegador(texto, lang, op);
}
function hablarNavegador(texto, lang, { desde = 0, alAvanzar } = {}) {
  return new Promise((ok) => {
    if (!sintesis || !texto) { ok(true); return; }
    const mio = ++tokenHabla;
    reproductor.pause();
    const partes = oraciones(texto);
    let i = Math.min(desde, partes.length);
    const una = () => {
      if (mio !== tokenHabla) { ok(false); return; }
      if (i >= partes.length) { hablando = false; finHabla = Date.now(); ok(true); return; }
      alAvanzar && alAvanzar(i);
      const u = new SpeechSynthesisUtterance(partes[i]);
      u.lang = lang === 'en' ? 'en-US' : 'es-AR';
      const v = voz(lang); if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = lang === 'en' ? E.aj.velEn : E.aj.velEs;
      u.onend = () => { i++; una(); };
      u.onerror = (e) => { if (e.error === 'interrupted' || e.error === 'canceled') { ok(false); return; } i++; una(); };
      hablando = true;
      sintesis.speak(u);
    };
    sintesis.cancel();
    setTimeout(una, 60);
  });
}

// --- voces de Google
const reproductor = new Audio();
reproductor.preload = 'auto';
let posGoogle = null;        // dónde quedó la última lectura (para «seguir» desde el mismo segundo)
const audios = new Map();    // texto+voz -> Promise<URL del audio>
async function sha(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function traerAudio(texto, nombreVoz) {
  let cache = null, clave = null;
  try { cache = await caches.open('voces-1'); clave = new Request('/__voz/' + await sha(nombreVoz + '|' + texto)); const hay = await cache.match(clave); if (hay) return URL.createObjectURL(await hay.blob()); } catch { cache = null; }
  let r;
  try {
    r = await fetch('/api/voz', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-editor': '1' }, body: JSON.stringify({ texto, voz: nombreVoz }) });
  } catch { throw new Error('Sin conexión.'); }
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status }); }
  const blob = await r.blob();
  try { if (cache) await cache.put(clave, new Response(blob, { headers: { 'content-type': 'audio/mpeg' } })); } catch { /* sin lugar: no importa */ }
  return URL.createObjectURL(blob);
}
function audioDe(texto, nombreVoz) {
  const k = nombreVoz + '|' + texto;
  if (!audios.has(k)) {
    if (audios.size > 400) { const [k0, p0] = audios.entries().next().value; audios.delete(k0); p0.then((u) => URL.revokeObjectURL(u), () => {}); }
    audios.set(k, traerAudio(texto, nombreVoz).catch((e) => { audios.delete(k); throw e; }));
  }
  return audios.get(k);
}
// Pedir por adelantado el audio del próximo párrafo, para que no haya silencio entre uno y otro.
function anticipar(u) {
  if (!usarGoogle() || !u) return;
  for (const f of fasesDe(u)) { const p = trozos(textoDe(u, f))[0]; if (p) audioDe(p, vozGoogle(f)).catch(() => {}); }
}
let avisoFalloGoogle = false;
function hablarGoogle(texto, lang, { desde = 0, alAvanzar, reanudar = false } = {}) {
  return new Promise((ok) => {
    if (!texto) { ok(true); return; }
    const mio = ++tokenHabla;
    if (sintesis) sintesis.cancel();
    reproductor.pause();
    const partes = trozos(texto), nombre = vozGoogle(lang), clave = lang + '|' + texto;
    let i = Math.min(desde, partes.length);
    let desdeSeg = reanudar && posGoogle && posGoogle.clave === clave && posGoogle.i === i ? Math.max(0, posGoogle.t - 1.2) : 0;
    const una = async () => {
      if (mio !== tokenHabla) { ok(false); return; }
      if (i >= partes.length) { hablando = false; finHabla = Date.now(); posGoogle = null; ok(true); return; }
      alAvanzar && alAvanzar(i);
      let src;
      try {
        src = await audioDe(partes[i], nombre);
        if (i + 1 < partes.length) audioDe(partes[i + 1], nombre).catch(() => {});
      } catch (e) {
        if (mio !== tokenHabla) { ok(false); return; }
        // Si Google falla, se sigue con la voz del navegador (y se avisa una sola vez).
        googleCaidoHasta = Date.now() + 3 * 60 * 1000;
        if (e.status === 503) vocesGoogle = null;
        if (!avisoFalloGoogle) { avisoFalloGoogle = true; $('posicion').textContent = `Voces de Google no disponibles (${e.message}). Sigo con la voz del navegador.`; }
        ok(await hablarNavegador(partes.slice(i).join(' '), lang));
        return;
      }
      if (mio !== tokenHabla) { ok(false); return; }
      const n = i;
      reproductor.src = src;
      reproductor.playbackRate = lang === 'en' ? E.aj.velEn : E.aj.velEs;
      reproductor.onloadedmetadata = () => { if (desdeSeg) { try { reproductor.currentTime = desdeSeg; } catch { /* nada */ } desdeSeg = 0; } };
      reproductor.ontimeupdate = () => { if (mio === tokenHabla && alAvanzar) posGoogle = { clave, i: n, t: reproductor.currentTime }; };
      reproductor.onended = () => { if (mio !== tokenHabla) return; i++; una(); };
      reproductor.onerror = () => { if (mio !== tokenHabla) return; i++; una(); };
      hablando = true;
      try { await reproductor.play(); }
      catch (e) {
        if (mio !== tokenHabla) { ok(false); return; }
        hablando = false; finHabla = Date.now();
        if (e.name === 'NotAllowedError') { estado('Tocá «Seguir» (o la barra espaciadora) para que empiece el audio.'); E.modo = 'pausa'; actualizarBotones(); ok(false); return; }
        i++; una();
      }
    };
    una();
  });
}
// Safari solo deja reproducir audio si la primera vez fue con un toque o una tecla.
function desbloquearAudio() {
  document.removeEventListener('pointerdown', desbloquearAudio, true);
  document.removeEventListener('keydown', desbloquearAudio, true);
  if (reproductor.src) return;
  const muestras = 800, b = new ArrayBuffer(44 + muestras * 2), d = new DataView(b);
  const w = (o, s) => [...s].forEach((c, k) => d.setUint8(o + k, c.charCodeAt(0)));
  w(0, 'RIFF'); d.setUint32(4, 36 + muestras * 2, true); w(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, muestras * 2, true);
  reproductor.src = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  reproductor.play().catch(() => {});
}
document.addEventListener('pointerdown', desbloquearAudio, true);
document.addEventListener('keydown', desbloquearAudio, true);

function callar() {
  tokenHabla++;
  if (sintesis) sintesis.cancel();
  reproductor.pause();
  hablando = false; finHabla = Date.now();
}

// Avisos cortos (con voz) y sonidos
const audio = window.AudioContext ? new AudioContext() : null;
function tono(f = 880, ms = 120, vol = 0.12) {
  if (!audio) return;
  if (audio.state === 'suspended') audio.resume();
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = f; g.gain.value = vol; o.connect(g); g.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + ms / 1000);
}
// Señales cortas, para no repetir instrucciones en voz alta (ver «Qué significan los sonidos»).
const senal = {
  escucho() { tono(660, 90); setTimeout(() => tono(990, 130), 110); },            // dos notas que suben: dictá
  confirmar() { tono(990, 90); setTimeout(() => tono(990, 90), 160); },           // dos notas iguales: ¿guardo?
  guardado() { tono(1046, 110); setTimeout(() => tono(1318, 140), 130); },        // campanita
  descartado() { tono(660, 90); setTimeout(() => tono(440, 140), 110); },         // dos notas que bajan
  finParrafo() { tono(523, 70, 0.06); },                                          // nota suave: momento para pensar
  noEntendi() { tono(220, 90, 0.1); setTimeout(() => tono(220, 90, 0.1), 140); }, // nota grave doble
  pausa() { tono(440, 120); },
};
// Las instrucciones habladas del dictado: las primeras veces (o siempre, o nunca, según Ajustes).
const conInstrucciones = () => E.aj.instrucciones === 'siempre' || (E.aj.instrucciones === 'primeras' && E.aj.vecesDictado < 3);
async function decir(t) { estado(t); await hablar(t, 'es'); }
function estado(t) { $('estado').textContent = t; }

// ------------------------------------------------------------ lectura
function mostrarUnidad() {
  const u = E.unidades[E.idx];
  $('txt-en').textContent = u?.en || '';
  if (u && !u.en) $('txt-en').innerHTML = '<span class="vacio">(no hay original emparejado para este párrafo)</span>';
  $('txt-es').textContent = u ? (u.leerEs || u.es.map((b) => b.t).join('\n\n')) : '';
  if (u && !u.es.length) $('txt-es').innerHTML = '<span class="vacio">(este párrafo del original no tiene traducción)</span>';
  $('caja-en').hidden = !E.aj.mostrarEn;
  $('posicion').textContent = E.caps[E.cap] ? `${E.caps[E.cap].titulo} · párrafo ${E.idx + 1} de ${E.unidades.length}` : '';
  guardado.set(`escucha:${E.libro}`, { cap: E.caps[E.cap]?.ruta, idx: E.idx });
}
function marcarIdioma(f) {
  $('caja-en').classList.toggle('activa', f === 'en');
  $('caja-es').classList.toggle('activa', f === 'es');
}
const textoDe = (u, f) => (f === 'en' ? u.en : (u.leerEs || u.es.map((b) => b.t).join('\n')));
const fasesDe = (u) => (E.aj.orden === 'es-en' ? ['es', 'en'] : E.aj.orden === 'es' ? ['es'] : E.aj.orden === 'en' ? ['en'] : ['en', 'es']).filter((f) => textoDe(u, f));

// Lee la unidad actual (todas sus fases, o solo una) y, si corresponde, sigue con la próxima.
async function leer({ solo = null, desdeFase = null, desdeFrase = 0, reanudar = false } = {}) {
  const u = E.unidades[E.idx];
  if (!u) { E.modo = 'pausa'; await decir('Fin del capítulo. Decí «capítulo siguiente» para seguir.'); return; }
  E.modo = 'leyendo'; E.terminada = false; actualizarBotones(); pedirPantallaEncendida();
  mostrarUnidad();
  const fases = solo ? [solo].filter((f) => textoDe(u, f)) : fasesDe(u);
  let k = desdeFase ? Math.max(0, fases.indexOf(desdeFase)) : 0;
  const idxInicio = E.idx;
  for (; k < fases.length; k++) {
    if (E.modo !== 'leyendo' || E.idx !== idxInicio) return;     // se pausó entre un idioma y otro
    const f = fases[k];
    E.fase = f; marcarIdioma(f); estado(f === 'en' ? 'Leyendo el original…' : 'Leyendo la traducción…');
    if (k === fases.length - 1) anticipar(E.unidades[E.idx + 1]);
    const retomar = k === 0 || desdeFase === f;
    const termino = await hablar(textoDe(u, f), f, { desde: retomar ? desdeFrase : 0, reanudar: retomar && reanudar, alAvanzar: (i) => { E.frase = i; } });
    desdeFrase = 0; reanudar = false;
    if (!termino || E.modo !== 'leyendo' || E.idx !== idxInicio) return;   // pausado o movido
    if (k < fases.length - 1 && !(await esperar(E.aj.pausaEn, idxInicio))) return;
  }
  marcarIdioma(null); E.fase = null; E.frase = 0; E.terminada = true;
  if (solo || E.aj.avance === 'esperar') {
    E.modo = 'pausa'; actualizarBotones(); senal.finParrafo();
    estado('En pausa. Decí «seguir» para el próximo párrafo, o «comentar».');
    return;
  }
  senal.finParrafo();
  estado('Pausa para pensar… Decí «comentar», «repetir» o «seguir».');
  if (!(await esperar(E.aj.pausaEs, idxInicio))) return;
  if (E.idx < E.unidades.length - 1) { E.idx++; leer(); }
  else { E.modo = 'pausa'; actualizarBotones(); await decir('Fin del capítulo. Decí «capítulo siguiente» para seguir, o «comentar».'); }
}

// Espera entre idiomas y entre párrafos. Si en ese momento se oye hablar, espera un poco más
// (puede venir una orden); «seguir» o «siguiente» la cortan.
async function esperar(seg, idxInicio) {
  E.esperaHasta = Date.now() + seg * 1000;
  while (Date.now() < E.esperaHasta) {
    await new Promise((r) => setTimeout(r, 100));
    if (E.modo !== 'leyendo' || E.idx !== idxInicio) { E.esperaHasta = 0; return false; }
  }
  E.esperaHasta = 0;
  return E.modo === 'leyendo' && E.idx === idxInicio;
}

function pausar() {
  if (E.modo !== 'leyendo') return;
  callar(); E.modo = 'pausa'; actualizarBotones(); senal.pausa();
  estado('En pausa. Decí «seguir», «repetir», «inglés», «castellano» o «comentar».');
}
function seguir() {
  if (E.modo === 'leyendo') { if (E.esperaHasta) E.esperaHasta = 0; return; }
  if (E.modo === 'pausa' && E.fase) { leer({ desdeFase: E.fase, desdeFrase: E.frase, reanudar: true }); return; }
  if (E.modo === 'pausa' && E.terminada) { irA(E.idx + 1); return; }
  leer();
}
function irA(i) {
  callar();
  if (i < 0) { decir('Es el primer párrafo del capítulo.'); return; }
  if (i >= E.unidades.length) { decir('Es el último párrafo del capítulo. Decí «capítulo siguiente».'); return; }
  E.idx = i; E.fase = null; E.frase = 0; mostrarUnidad(); leer();
}
function detenerTodo() { callar(); E.modo = 'detenido'; }

// ------------------------------------------------------------ comentar por voz
function empezarDictado() {
  if (!E.unidades[E.idx]?.es.length) { decir('Este párrafo no tiene traducción para comentar.'); return; }
  callar();
  E.modo = 'dictando'; E.dictado = ''; E.provisorio = '';
  $('dictado').hidden = false; $('dictado-teclado').value = ''; pintarDictado(); actualizarBotones();
  if (!reconocimiento) {
    estado('Escribí tu comentario y tocá Guardar (este navegador no reconoce la voz).');
    $('dictado-teclado').focus(); return;
  }
  activarMicrofono(true);
  const listo = () => { if (E.modo === 'dictando') { senal.escucho(); finHabla = Date.now() - 400; estado('Te escucho… (para terminar, decí «listo»)'); } };
  if (conInstrucciones()) decir('Dictá tu comentario. Para terminar, decí: listo.').then(listo);
  else { estado('Te escucho…'); listo(); }
}
function pintarDictado() {
  $('txt-dictado').innerHTML = '';
  const a = document.createElement('span'); a.textContent = E.dictado;
  const b = document.createElement('span'); b.className = 'provisorio'; b.textContent = E.provisorio ? ' ' + E.provisorio : '';
  $('txt-dictado').append(a, b);
}
// «coma», «punto»… -> signos
function puntuar(t) {
  let s = ' ' + t + ' ';
  const reemplazos = [
    [/\s+abrir comillas\s+/gi, ' “'], [/\s+cerrar comillas\s+/gi, '” '], [/\s+abrir signo de pregunta\s+/gi, ' ¿'], [/\s+cerrar signo de pregunta\s+/gi, '? '],
    [/\s+puntos suspensivos\s+/gi, '… '], [/\s+punto y coma\s+/gi, '; '], [/\s+dos puntos\s+/gi, ': '], [/\s+punto y aparte\s+/gi, '.\n'], [/\s+nuevo párrafo\s+/gi, '\n'],
    [/\s+punto y seguido\s+/gi, '. '], [/\s+punto\s+/gi, '. '], [/\s+coma\s+/gi, ', '],
  ];
  // «falta una coma», «sacaría el punto»: ahí la palabra es el tema del comentario, no un signo.
  const sustantivo = '(?<!\\b(?:un|una|el|la|los|las|otro|otra|ese|esa|este|esta|sin|con|del|de|falta|faltan|sobra|sobran|poner|pondría|pondria|agregar|agregaría|agregaria|sacar|sacaría|sacaria|quitar|quitaría|quitaria|cambiar|cambiaría|cambiaria|por|y|o|ni|qué|que|cuál|cual|primer|segundo|ningún|ningun|algún|algun|doble|dos|tres|unas|unos))';
  for (const [re, x] of reemplazos) s = s.replace(new RegExp(sustantivo + re.source, re.flags), x);
  s = s.replace(/\s+([,.;:?”…])/g, '$1').replace(/“\s+/g, '“').replace(/[ \t]+/g, ' ').trim();
  s = s.replace(/(^|[.?!…]\s+|\n)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  return s;
}
async function terminarDictado() {
  const t = puntuar(($('dictado-teclado').value.trim() ? $('dictado-teclado').value : E.dictado).trim());
  E.dictado = t; E.provisorio = ''; pintarDictado();
  if (!t) { E.modo = 'dictando'; await decir(conInstrucciones() ? 'No escuché nada. Probá de nuevo, o decí «cancelar».' : 'No escuché nada.'); senal.escucho(); return; }
  E.modo = 'confirmando'; actualizarBotones();
  await decir(conInstrucciones() ? `Anoté: ${t}. Para guardarlo, decí «guardar». Para dictarlo de nuevo, «de nuevo». Para descartarlo, «cancelar».` : `Anoté: ${t}`);
  if (E.modo === 'confirmando') { senal.confirmar(); estado('¿Lo guardo? Decí «guardar», «de nuevo» o «cancelar».'); }
}
async function guardarComentario() {
  const t = puntuar(($('dictado-teclado').value.trim() ? $('dictado-teclado').value : E.dictado).trim());
  if (!t) { decir('El comentario está vacío.'); return; }
  const u = E.unidades[E.idx];
  const cita = u.es[0].md.slice(0, 1000);
  const i = E.texto.indexOf(cita);
  try {
    estado('Guardando…');
    await api('/api/comentarios', { metodo: 'POST', cuerpo: {
      ruta: E.caps[E.cap].ruta, accion: 'nuevo', texto: t, cita,
      antes: i >= 0 ? E.texto.slice(Math.max(0, i - 40), i) : '', despues: i >= 0 ? E.texto.slice(i + cita.length, i + cita.length + 40) : '',
      pos: i >= 0 ? i : undefined,
    } });
    $('dictado').hidden = true; E.dictado = ''; E.modo = 'pausa'; actualizarBotones();
    senal.guardado();
    const instr = conInstrucciones(); E.aj.vecesDictado++; guardarAjustes();
    if (instr) await decir('Guardado. Decí «seguir» para continuar, o «repetir».');
    else estado('Guardado. Decí «seguir» para continuar.');
  } catch (e) { await decir('No se pudo guardar: ' + e.message + '. Probá de nuevo con «guardar».'); }
}
function cancelarDictado() {
  $('dictado').hidden = true; E.dictado = ''; E.provisorio = ''; E.modo = 'pausa'; actualizarBotones();
  senal.descartado();
  const instr = conInstrucciones(); E.aj.vecesDictado++; guardarAjustes();
  if (instr) decir('Descartado. Decí «seguir» para continuar.'); else estado('Descartado.');
}

// ------------------------------------------------------------ órdenes por voz
const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
let reconocimiento = null, micActivo = false, reiniciar = null;
const sinTildes = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
const NUMEROS = { uno: 1, un: 1, primero: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25 };
const PARAR = /^(pausa|pausar|pausa por favor|alto|stop|deten(er|te)|basta|espera|esperá|silencio|para|pará|frena|frená)$/;

function comando(t) {
  const c = sinTildes(t);
  if (!c) return false;
  if (PARAR.test(c)) { pausar(); return true; }
  if (/^(seguir|segui|sigue|continuar|continua|continuemos|dale|adelante|empezar|empeza|comenzar|leer|lee)$/.test(c)) { seguir(); return true; }
  if (/^(siguiente|proximo|el siguiente|el proximo|siguiente parrafo|proximo parrafo)$/.test(c)) { irA(E.idx + 1); return true; }
  if (/^(anterior|atras|volver|el anterior|parrafo anterior|volver atras)$/.test(c)) { irA(E.idx - 1); return true; }
  if (/^(repetir|repeti|repite|otra vez|de nuevo|repetir parrafo)$/.test(c)) { callar(); E.fase = null; E.frase = 0; leer(); return true; }
  if (/^(ingles|en ingles|el ingles|original|el original|leer el original|lee el original|otra vez el ingles)$/.test(c)) { callar(); leer({ solo: 'en' }); return true; }
  if (/^(castellano|en castellano|espanol|en espanol|traduccion|la traduccion|leer la traduccion|otra vez el castellano)$/.test(c)) { callar(); leer({ solo: 'es' }); return true; }
  if (/^(comentar|comentario|hacer un comentario|correccion|corregir|sugerencia|sugerir|anotar|nota)$/.test(c)) { empezarDictado(); return true; }
  if (/^(donde estoy|donde estamos|en que parte estoy|posicion)$/.test(c)) { callar(); E.modo = 'pausa'; decir(`${E.caps[E.cap].titulo}. Párrafo ${E.idx + 1} de ${E.unidades.length}.`); return true; }
  if (/^(mas lento|mas despacio|lento)$/.test(c)) { velocidad(-0.1); return true; }
  if (/^(mas rapido|rapido|mas ligero)$/.test(c)) { velocidad(0.1); return true; }
  if (/^(capitulo siguiente|proximo capitulo|siguiente capitulo)$/.test(c)) { abrirCapitulo(E.cap + 1, true); return true; }
  if (/^(capitulo anterior)$/.test(c)) { abrirCapitulo(E.cap - 1, true); return true; }
  const m = c.match(/^(ir al )?capitulo (\d+|\w+)$/);
  if (m) { const n = +m[2] || NUMEROS[m[2]]; if (n) { abrirCapitulo(n - 1, true); return true; } }
  if (/^(ayuda|que puedo decir|comandos|ordenes|opciones)$/.test(c)) { ayudaEnVoz(); return true; }
  return false;
}

function alResultado(ev) {
  let final = '', provisorio = '';
  for (let i = ev.resultIndex; i < ev.results.length; i++) {
    const r = ev.results[i];
    if (r.isFinal) final += r[0].transcript; else provisorio += r[0].transcript;
  }
  // Mientras habla la voz (o justo después) el micrófono puede oírla: solo se aceptan
  // órdenes cortas para detener. Con auriculares no pasa.
  const ocupado = hablando || Date.now() - finHabla < 700;
  if (E.modo === 'dictando') {
    if (ocupado) return;
    if (final) {
      const f = final.trim();
      const c = sinTildes(f);
      if (/^(cancelar|cancela|descartar)$/.test(c)) { cancelarDictado(); return; }
      const fin = c.match(/(^|\s)(listo|termine|ya esta|fin del comentario)$/);
      const limpio = fin ? f.replace(/\s*(listo|terminé|termine|ya está|ya esta|fin del comentario)[.!]?\s*$/i, '') : f;
      E.dictado = (E.dictado + ' ' + limpio).trim(); E.provisorio = ''; pintarDictado();
      if (fin) terminarDictado();
    } else { E.provisorio = provisorio; pintarDictado(); }
    return;
  }
  if (E.modo === 'confirmando') {
    if (ocupado || !final) return;
    const c = sinTildes(final);
    if (/^(guardar|guardalo|guarda|si|sí|dale|ok|okay|confirmar|listo)$/.test(c)) guardarComentario();
    else if (/^(de nuevo|otra vez|dictar de nuevo|repetir|corregir)$/.test(c)) { E.modo = 'dictando'; E.dictado = ''; pintarDictado(); (conInstrucciones() ? decir('Dictá de nuevo. Para terminar, decí: listo.') : Promise.resolve(estado('Te escucho…'))).then(() => senal.escucho()); }
    else if (/^(agregar|seguir dictando|sumar|continuar)$/.test(c)) { E.modo = 'dictando'; (conInstrucciones() ? decir('Seguí dictando. Para terminar, decí: listo.') : Promise.resolve(estado('Te escucho…'))).then(() => senal.escucho()); }
    else if (/^(cancelar|no|descartar|borrar)$/.test(c)) cancelarDictado();
    return;
  }
  const texto = (final || provisorio).trim();
  if (!texto) return;
  $('oido').textContent = `Oí: «${texto}»`;
  if (E.esperaHasta && !hablando) E.esperaHasta = Math.max(E.esperaHasta, Date.now() + 2500);
  if (ocupado) {
    // con la voz hablando: solo «pausa», y solo si es una palabra o dos
    if (texto.split(/\s+/).length <= 2 && PARAR.test(sinTildes(texto))) pausar();
    return;
  }
  if (final && texto.split(/\s+/).length <= 5) {
    if (!comando(texto)) { senal.noEntendi(); estado(`No entendí «${texto}». Decí «ayuda» para escuchar las órdenes.`); }
  }
}

// El navegador corta el reconocimiento cada tanto y se vuelve a encender solo. Si se corta enseguida
// una y otra vez (el ícono del micrófono parpadea), algo lo impide: se apaga y se explica qué pasa.
let micInicio = 0, micCortes = 0, micError = '', micOyo = false;
const esSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
function problemaMic(err) {
  if (err === 'not-allowed') return 'El navegador no tiene permiso para usar el micrófono. Tocá el candado junto a la dirección de la página y permitilo. En la Mac, revisá también Ajustes del Sistema, Privacidad y seguridad, Micrófono.';
  if (err === 'service-not-allowed') return esSafari ? 'Safari necesita el Dictado activado: Ajustes del Sistema, Teclado, Dictado.' : 'Este navegador no ofrece reconocimiento de voz. Usá Google Chrome.';
  if (err === 'audio-capture') return 'No encuentro el micrófono, o lo está usando otra aplicación (Zoom, Meet, WhatsApp…).';
  if (err === 'network') return navigator.brave ? 'Brave no trae reconocimiento de voz. Usá Google Chrome o Safari.'
    : 'El reconocimiento de voz no pudo conectarse con su servicio. Si usás Brave, Arc, Dia, Opera o Vivaldi, probá con Google Chrome o Safari: no traen reconocimiento de voz. Si tenés VPN o un bloqueador, probá sin.';
  return '';
}
function apagarMic(msg) {
  activarMicrofono(false);
  estado(msg); $('oido').textContent = '';
  if (E.modo !== 'leyendo') decir(msg);
}
function activarMicrofono(si) {
  if (!Reconocimiento) { estado('Este navegador no reconoce la voz: usá Chrome, Edge o Safari. Mientras tanto, botones y teclado.'); return; }
  micActivo = si;
  $('b-microfono').setAttribute('aria-pressed', si ? 'true' : 'false');
  $('b-microfono').textContent = si ? '🎙 Micrófono encendido' : '🎙 Micrófono apagado';
  guardado.set('escucha-mic', si);
  clearTimeout(reiniciar);
  if (!si) { $('oido').textContent = ''; try { reconocimiento?.abort(); } catch { /* nada */ } return; }
  micCortes = 0; micError = '';
  if (!reconocimiento) {
    reconocimiento = new Reconocimiento();
    reconocimiento.lang = 'es-AR'; reconocimiento.continuous = true; reconocimiento.interimResults = true; reconocimiento.maxAlternatives = 1;
    reconocimiento.onstart = () => { micInicio = Date.now(); micOyo = false; $('oido').textContent = '🎙 Escuchando…'; };
    reconocimiento.onresult = (ev) => { micOyo = true; micCortes = 0; alResultado(ev); };
    reconocimiento.onerror = (e) => {
      micError = e.error;
      if (e.error === 'language-not-supported' && reconocimiento.lang !== 'es-ES') { reconocimiento.lang = 'es-ES'; return; }
      const msg = problemaMic(e.error);
      if (msg) apagarMic(msg);
    };
    reconocimiento.onend = () => {
      if (!micActivo) return;
      const corto = !micOyo && Date.now() - micInicio < 2500;
      micCortes = corto ? micCortes + 1 : 0;
      if (micCortes >= 4) {
        apagarMic(`El micrófono se corta solo${micError ? ` (${micError})` : ''}. ${problemaMic(micError) || 'Probá con Google Chrome, cerrá otras aplicaciones que usen el micrófono y volvé a encenderlo.'}`);
        return;
      }
      $('oido').textContent = '';
      reiniciar = setTimeout(() => { try { reconocimiento.start(); } catch { /* ya estaba */ } }, corto ? 500 * micCortes : 250);
    };
  }
  try { reconocimiento.start(); } catch { /* ya estaba encendido */ }
}

async function ayudaEnVoz() {
  callar(); E.modo = 'pausa'; actualizarBotones();
  await decir('Podés decir: pausa. Seguir. Siguiente. Anterior. Repetir. Inglés. Castellano. Comentar, y al terminar, listo. Dónde estoy. Más lento o más rápido. Capítulo siguiente, o capítulo y un número.');
}

function velocidad(d) {
  E.aj.velEs = Math.min(1.6, Math.max(0.6, +(E.aj.velEs + d).toFixed(2)));
  E.aj.velEn = Math.min(1.6, Math.max(0.6, +(E.aj.velEn + d).toFixed(2)));
  guardarAjustes(); pintarAjustes();
  if (usarGoogle() && E.modo === 'leyendo' && E.fase) {   // con las voces de Google se cambia sin cortar
    reproductor.playbackRate = E.fase === 'en' ? E.aj.velEn : E.aj.velEs;
    tono(d < 0 ? 520 : 780, 90); estado(d < 0 ? 'Más lento.' : 'Más rápido.');
    return;
  }
  const f = E.fase;
  callar();
  decir(d < 0 ? 'Más lento.' : 'Más rápido.').then(() => { if (f) leer({ desdeFase: f, desdeFrase: E.frase, reanudar: true }); else E.modo = 'pausa'; });
}

// ------------------------------------------------------------ pantalla encendida (celular)
let candado = null;
async function pedirPantallaEncendida() {
  try { if ('wakeLock' in navigator && !candado) { candado = await navigator.wakeLock.request('screen'); candado.addEventListener('release', () => { candado = null; }); } } catch { /* nada */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && E.modo === 'leyendo') pedirPantallaEncendida(); });

// ------------------------------------------------------------ libros y capítulos
async function iniciar() {
  $('entrada').hidden = true; $('app').hidden = false;
  aplicarAjustes();
  E.libros = await api('/api/libros').catch((e) => { estado(e.message); return []; });
  const sel = $('sel-libro'); sel.innerHTML = '';
  E.libros.forEach((l) => sel.add(new Option(l.titulo, l.id)));
  const q = new URLSearchParams(location.search);
  const id = E.libros.some((l) => l.id === q.get('libro')) ? q.get('libro') : (guardado.get('escucha-libro') || E.libros[0]?.id);
  if (id) { sel.value = id; await abrirLibro(id, q.get('cap')); }
  cargarVocesGoogle();
  if (Reconocimiento && guardado.get('escucha-mic', false)) activarMicrofono(true);
  if (!sintesis) estado('Este navegador no puede leer en voz alta. Probá con Chrome, Edge o Safari.');
}

async function abrirLibro(id, capRuta) {
  detenerTodo();
  E.libro = id; guardado.set('escucha-libro', id);
  const d = await api(`/api/libro?id=${encodeURIComponent(id)}`);
  E.caps = d.capitulos;
  const sel = $('sel-cap'); sel.innerHTML = '';
  E.caps.forEach((c, i) => sel.add(new Option(`${i + 1}. ${c.titulo}`, String(i))));
  const ult = guardado.get(`escucha:${id}`, {});
  let i = E.caps.findIndex((c) => c.ruta === (capRuta || ult.cap));
  if (i < 0) i = 0;
  await abrirCapitulo(i, false, capRuta ? 0 : (ult.cap === E.caps[i]?.ruta ? ult.idx : 0));
}

async function abrirCapitulo(i, leerAlAbrir = false, idx = 0) {
  if (i < 0 || i >= E.caps.length) { decir(i < 0 ? 'Es el primer capítulo.' : 'Es el último capítulo del libro.'); return; }
  detenerTodo();
  E.cap = i; $('sel-cap').value = String(i);
  estado('Cargando el capítulo…');
  const ruta = E.caps[i].ruta;
  const [a, o] = await Promise.all([api(`/api/archivo?ruta=${encodeURIComponent(ruta)}`), api(`/api/original?ruta=${encodeURIComponent(ruta)}`).catch(() => ({ pares: [] }))]);
  E.texto = a.texto; E.tituloEn = o.titulo || '';
  E.unidades = armarUnidades(a.texto, o.pares || [], o.titulo);
  E.sinOriginal = !(o.pares || []).length;
  E.idx = Math.min(Math.max(0, idx || 0), E.unidades.length - 1); E.fase = null; E.frase = 0; E.terminada = false;
  $('ir-editor').href = `/?libro=${encodeURIComponent(E.libro)}&cap=${encodeURIComponent(ruta)}`;
  mostrarUnidad(); actualizarBotones();
  const aviso = E.sinOriginal ? ' Este capítulo no tiene el original emparejado: se lee solo la traducción.' : '';
  if (leerAlAbrir) { await decir(`Capítulo ${i + 1}.${aviso}`); leer(); }
  else estado(`Listo para escuchar. Tocá «Empezar», apretá la barra espaciadora o decí «empezar».${aviso}`);
}

$('sel-libro').onchange = (e) => abrirLibro(e.target.value);
$('sel-cap').onchange = (e) => abrirCapitulo(+e.target.value);
$('b-salir').onclick = async () => { await api('/api/salir', { metodo: 'POST' }).catch(() => {}); window.google?.accounts?.id?.disableAutoSelect?.(); mostrarEntrada(); };

// ------------------------------------------------------------ botones y teclado
function actualizarBotones() {
  const b = $('b-leer');
  b.textContent = E.modo === 'leyendo' ? '⏸ Pausa' : (E.modo === 'pausa' ? '▶ Seguir' : '▶ Empezar');
  const dict = E.modo === 'dictando' || E.modo === 'confirmando';
  ['b-anterior', 'b-leer', 'b-siguiente', 'b-repetir', 'b-ingles', 'b-castellano', 'b-comentar'].forEach((id) => { $(id).disabled = dict; });
}
$('b-leer').onclick = () => (E.modo === 'leyendo' ? pausar() : seguir());
$('b-anterior').onclick = () => irA(E.idx - 1);
$('b-siguiente').onclick = () => irA(E.idx + 1);
$('b-repetir').onclick = () => { callar(); E.fase = null; E.frase = 0; leer(); };
$('b-ingles').onclick = () => { callar(); leer({ solo: 'en' }); };
$('b-castellano').onclick = () => { callar(); leer({ solo: 'es' }); };
$('b-comentar').onclick = () => empezarDictado();
$('b-microfono').onclick = () => activarMicrofono(!micActivo);
$('b-guardar').onclick = () => guardarComentario();
$('b-redictar').onclick = () => { E.dictado = ''; $('dictado-teclado').value = ''; E.modo = 'dictando'; pintarDictado(); actualizarBotones(); (conInstrucciones() ? decir('Dictá de nuevo. Para terminar, decí: listo.') : Promise.resolve(estado('Te escucho…'))).then(() => senal.escucho()); };
$('b-cancelar').onclick = () => cancelarDictado();

document.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input, select') && e.key !== 'Escape') {
    if (e.target.id === 'dictado-teclado' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); guardarComentario(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const dict = E.modo === 'dictando' || E.modo === 'confirmando';
  const k = e.key.toLowerCase();
  if (dict) {
    if (k === 'enter') { e.preventDefault(); E.modo === 'dictando' ? terminarDictado() : guardarComentario(); }
    else if (k === 'escape') { e.preventDefault(); cancelarDictado(); }
    return;
  }
  if (e.target.matches('button') && (k === ' ' || k === 'enter')) return;   // el botón enfocado ya lo maneja
  const acciones = { ' ': () => $('b-leer').click(), arrowright: () => irA(E.idx + 1), arrowleft: () => irA(E.idx - 1),
    r: () => $('b-repetir').click(), i: () => $('b-ingles').click(), e: () => $('b-castellano').click(), c: () => empezarDictado(),
    '?': () => ayudaEnVoz(), d: () => comando('dónde estoy') };
  if (acciones[k]) { e.preventDefault(); acciones[k](); }
});

// ------------------------------------------------------------ ajustes
function guardarAjustes() { guardado.set('escucha-ajustes', E.aj); }
function pintarAjustes() {
  $('aj-orden').value = E.aj.orden; $('aj-avance').value = E.aj.avance;
  $('aj-vel-es').value = E.aj.velEs; $('out-vel-es').textContent = `${E.aj.velEs}×`;
  $('aj-vel-en').value = E.aj.velEn; $('out-vel-en').textContent = `${E.aj.velEn}×`;
  $('aj-letra').value = E.aj.letra; $('out-letra').textContent = `${E.aj.letra} px`;
  $('aj-tema').value = E.aj.tema; $('aj-mostrar-en').checked = E.aj.mostrarEn;
  $('aj-pausa-en').value = E.aj.pausaEn; $('out-pausa-en').textContent = `${E.aj.pausaEn} s`;
  $('aj-pausa-es').value = E.aj.pausaEs; $('out-pausa-es').textContent = `${E.aj.pausaEs} s`;
  $('aj-instrucciones').value = E.aj.instrucciones;
}
function aplicarAjustes() {
  document.documentElement.style.setProperty('--letra', `${E.aj.letra}px`);
  document.documentElement.dataset.tema = E.aj.tema === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'claro' : 'oscuro') : E.aj.tema;
  $('caja-en').hidden = !E.aj.mostrarEn;
  pintarAjustes();
}
const enlazar = (id, clave, conv = (x) => x) => $(id).addEventListener('input', (e) => { E.aj[clave] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value); guardarAjustes(); aplicarAjustes(); });
enlazar('aj-orden', 'orden'); enlazar('aj-avance', 'avance'); enlazar('aj-vel-es', 'velEs', Number); enlazar('aj-vel-en', 'velEn', Number);
enlazar('aj-letra', 'letra', Number); enlazar('aj-tema', 'tema'); enlazar('aj-mostrar-en', 'mostrarEn');
enlazar('aj-pausa-en', 'pausaEn', Number); enlazar('aj-pausa-es', 'pausaEs', Number);
enlazar('aj-instrucciones', 'instrucciones', (v) => { E.aj.vecesDictado = 0; return v; });
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (E.aj.tema === 'auto') aplicarAjustes(); });
$('aj-voz-es').onchange = (e) => { E.aj[usarGoogle() ? 'gVozEs' : 'vozEs'] = e.target.value; guardarAjustes(); };
$('aj-voz-en').onchange = (e) => { E.aj[usarGoogle() ? 'gVozEn' : 'vozEn'] = e.target.value; guardarAjustes(); };
$('aj-motor').onchange = (e) => { callar(); if (E.modo === 'leyendo') { E.modo = 'pausa'; actualizarBotones(); } E.aj.motor = e.target.value; guardarAjustes(); llenarVoces(); };
$('b-probar-voz').onclick = () => { callar(); if (E.modo === 'leyendo') { E.modo = 'pausa'; actualizarBotones(); } hablar('Hola. Así suena esta voz en castellano.', 'es').then((ok) => ok && hablar('And this is how the English voice sounds.', 'en')); };

// ------------------------------------------------------------ arranque
aplicarAjustes();
(async () => {
  try { E.usuario = await api('/api/sesion'); iniciar(); }
  catch { mostrarEntrada(); }
})();

window.__escucha = { E, senal, armarUnidades, bloques, comando, puntuar, alResultado, reproductor, trozos };   // para pruebas
