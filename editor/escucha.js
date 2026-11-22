// Modo escucha: lee en voz alta el original (inglés) y la traducción, párrafo por párrafo,
// y deja dictar correcciones o sugerencias, que se guardan como comentarios del capítulo
// (el equipo los ve en el editor). Pensado para usarse sin mirar la pantalla: órdenes por voz,
// teclado y botones grandes.
//
// Voz: speechSynthesis (la voz del sistema) y SpeechRecognition (Chrome, Edge, Safari).
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
const AJ_DEF = { orden: 'en-es', avance: 'auto', velEs: 1, velEn: 1, vozEs: '', vozEn: '', letra: 28, tema: 'oscuro', mostrarEn: true };
const E = {
  usuario: null, libros: [], libro: null, caps: [], cap: -1,
  texto: '', unidades: [], idx: 0, tituloEn: '',
  modo: 'detenido',          // detenido | leyendo | pausa | dictando | confirmando
  fase: null, frase: 0,      // qué idioma y qué oración se está leyendo (para seguir desde ahí)
  aj: { ...AJ_DEF, ...guardado.get('escucha-ajustes', {}) },
  dictado: '', provisorio: '',
};

// ------------------------------------------------------------ texto
const plano = (md) => md
  .replace(/^:::.*$/gm, '').replace(/^#{1,4}\s+/gm, '').replace(/\s*\{[^}]*\}\s*$/gm, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, 'Foto: $1').replace(/\[\^\d+\]/g, '')
  .replace(/^>\s?/gm, '').replace(/\*+/g, '').replace(/\\(.)/g, '$1')
  .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

// Bloques del capítulo (como en herramientas/alinear_original.py)
function bloques(texto) {
  const partes = texto.replace(/\r/g, '').split(/\n[ \t]*\n/);
  const out = [];
  for (let i = 0; i < partes.length; i++) {
    let p = partes[i].replace(/^\n+|\n+$/g, '');
    if (!p.trim()) continue;
    if (/^:::/.test(p) && !/(^|\n):::\s*$/.test(p.split('\n').slice(1).join('\n'))) {
      let j = i;
      while (j + 1 < partes.length && !/(^|\n):::\s*$/.test(partes[j])) j++;
      p = partes.slice(i, j + 1).join('\n\n'); i = j;
    }
    const clase = p.match(/^:::\s*([\p{L}\w-]+)/u)?.[1];
    if (clase === 'nota-interna' || /^\[\^\d+\]:/.test(p)) continue;
    const tipo = /^# /.test(p) ? 'titulo' : /^#{2,4}\s/.test(p) ? 'seccion' : clase || 'parrafo';
    out.push({ md: p, tipo, t: plano(p) });
  }
  return out;
}

const normal = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function parecido(a, b) {
  const A = new Set(normal(a)), B = new Set(normal(b));
  if (!A.size || !B.size) return a.trim() === b.trim() ? 1 : 0;
  let c = 0; for (const w of A) if (B.has(w)) c++;
  return c / Math.min(A.size, B.size);
}

// Une los párrafos actuales del capítulo con los pares guardados (el castellano puede haber
// cambiado desde que se emparejó: se busca por parecido, en orden).
function armarUnidades(texto, pares, tituloEn) {
  const bs = bloques(texto);
  const unidades = [];
  const tit = bs.find((b) => b.tipo === 'titulo');
  const numero = E.cap + 1;
  if (tit) unidades.push({ es: [tit], en: tituloEn ? `Chapter ${numero}. ${tituloEn}` : '', titulo: true, leerEs: `Capítulo ${numero}. ${tit.t}` });
  const cuerpo = bs.filter((b) => b.tipo !== 'titulo');
  // piezas de los pares (un par puede abarcar varios párrafos en castellano)
  const piezas = [];
  pares.forEach((p, k) => { const ps = (p.es || '').split(/\n[ \t]*\n/).filter((x) => x.trim()); (ps.length ? ps : ['']).forEach((x) => piezas.push({ k, t: plano(x) })); });
  // alineación monótona por parecido (programación dinámica)
  const n = cuerpo.length, m = piezas.length;
  const S = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const P = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const s = parecido(cuerpo[i - 1].t, piezas[j - 1].t);
    const diag = S[i - 1][j - 1] + (s >= 0.35 ? s : -0.2);
    const arriba = S[i - 1][j], izq = S[i][j - 1];
    if (diag >= arriba && diag >= izq) { S[i][j] = diag; P[i][j] = 1; } else if (arriba >= izq) { S[i][j] = arriba; P[i][j] = 2; } else { S[i][j] = izq; P[i][j] = 3; }
  }
  const par = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (P[i][j] === 1) { if (parecido(cuerpo[i - 1].t, piezas[j - 1].t) >= 0.35) par[i - 1] = piezas[j - 1].k; i--; j--; }
    else if (P[i][j] === 2) i--; else j--;
  }
  // unidades: párrafos seguidos con el mismo par van juntos; los pares sin castellano, solos
  const usados = new Set(par.filter((k) => k >= 0));
  let ultimoPar = -1;
  for (let i = 0; i < n; i++) {
    const k = par[i];
    if (k >= 0) {
      for (let q = ultimoPar + 1; q < k; q++) if (!usados.has(q) && pares[q]?.en) unidades.push({ es: [], en: pares[q].en });
      const prev = unidades[unidades.length - 1];
      if (prev && prev.k === k) prev.es.push(cuerpo[i]);
      else unidades.push({ es: [cuerpo[i]], en: pares[k].en || '', k });
      ultimoPar = Math.max(ultimoPar, k);
    } else unidades.push({ es: [cuerpo[i]], en: '' });
  }
  for (let q = ultimoPar + 1; q < pares.length; q++) if (!usados.has(q) && pares[q]?.en) unidades.push({ es: [], en: pares[q].en });
  return unidades;
}

// ------------------------------------------------------------ voz que lee
const sintesis = window.speechSynthesis;
let voces = [];
function cargarVoces() {
  voces = sintesis ? sintesis.getVoices() : [];
  const llenar = (sel, pref, actual) => {
    const lista = voces.filter((v) => v.lang.toLowerCase().startsWith(pref));
    const puntaje = (v) => (/natural|neural|premium|enhanced|mejorada|google/i.test(v.name) ? 2 : 0) + (pref === 'es' && /es[-_](AR|419|US|MX|UY)/i.test(v.lang) ? 1 : 0) + (v.localService ? 0.5 : 0);
    lista.sort((a, b) => puntaje(b) - puntaje(a));
    sel.innerHTML = '';
    lista.forEach((v) => sel.add(new Option(`${v.name} (${v.lang})`, v.name)));
    if (!lista.length) sel.add(new Option('(no hay voces en este idioma)', ''));
    sel.value = lista.some((v) => v.name === actual) ? actual : (lista[0]?.name || '');
  };
  llenar($('aj-voz-es'), 'es', E.aj.vozEs);
  llenar($('aj-voz-en'), 'en', E.aj.vozEn);
}
if (sintesis) { cargarVoces(); sintesis.onvoiceschanged = cargarVoces; }

const voz = (lang) => voces.find((v) => v.name === (lang === 'en' ? $('aj-voz-en').value : $('aj-voz-es').value))
  || voces.find((v) => v.lang.toLowerCase().startsWith(lang));

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

let tokenHabla = 0;
let hablando = false, finHabla = 0;
function hablar(texto, lang, desde = 0, alAvanzar) {
  return new Promise((ok) => {
    if (!sintesis || !texto) { ok(true); return; }
    const mio = ++tokenHabla;
    const partes = oraciones(texto);
    let i = desde;
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
function callar() { tokenHabla++; if (sintesis) sintesis.cancel(); hablando = false; finHabla = Date.now(); }

// Avisos cortos (con voz) y sonidos
const audio = window.AudioContext ? new AudioContext() : null;
function tono(f = 880, ms = 120, vol = 0.12) {
  if (!audio) return;
  if (audio.state === 'suspended') audio.resume();
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = f; g.gain.value = vol; o.connect(g); g.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + ms / 1000);
}
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
async function leer({ solo = null, desdeFase = null, desdeFrase = 0 } = {}) {
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
    const termino = await hablar(textoDe(u, f), f, k === 0 || desdeFase === f ? desdeFrase : 0, (i) => { E.frase = i; });
    desdeFrase = 0;
    if (!termino || E.modo !== 'leyendo' || E.idx !== idxInicio) return;   // pausado o movido
    if (k < fases.length - 1) await new Promise((r) => setTimeout(r, 450));
  }
  marcarIdioma(null); E.fase = null; E.frase = 0; E.terminada = true;
  if (solo || E.aj.avance === 'esperar') {
    E.modo = 'pausa'; actualizarBotones(); tono(660, 90);
    estado('En pausa. Decí «seguir» para el próximo párrafo, o «comentar».');
    return;
  }
  await new Promise((r) => setTimeout(r, 700));
  if (E.modo !== 'leyendo' || E.idx !== idxInicio) return;
  if (E.idx < E.unidades.length - 1) { E.idx++; leer(); }
  else { E.modo = 'pausa'; actualizarBotones(); await decir('Fin del capítulo. Decí «capítulo siguiente» para seguir, o «comentar».'); }
}

function pausar() {
  if (E.modo !== 'leyendo') return;
  callar(); E.modo = 'pausa'; actualizarBotones(); tono(440, 120);
  estado('En pausa. Decí «seguir», «repetir», «inglés», «castellano» o «comentar».');
}
function seguir() {
  if (E.modo === 'leyendo') return;
  if (E.modo === 'pausa' && E.fase) { leer({ desdeFase: E.fase, desdeFrase: E.frase }); return; }
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
  decir('Dictá tu comentario. Para terminar, decí: listo.').then(() => { if (E.modo === 'dictando') { tono(988, 140); estado('Te escucho… (para terminar, decí «listo»)'); } });
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
    [/\s+punto y coma\s+/gi, '; '], [/\s+dos puntos\s+/gi, ': '], [/\s+punto y aparte\s+/gi, '.\n'], [/\s+nuevo párrafo\s+/gi, '\n'],
    [/\s+punto y seguido\s+/gi, '. '], [/\s+punto\s+/gi, '. '], [/\s+coma\s+/gi, ', '], [/\s+abrir comillas\s+/gi, ' “'], [/\s+cerrar comillas\s+/gi, '” '],
    [/\s+abrir signo de pregunta\s+/gi, ' ¿'], [/\s+cerrar signo de pregunta\s+/gi, '? '], [/\s+puntos suspensivos\s+/gi, '… '],
  ];
  for (const [re, x] of reemplazos) s = s.replace(re, x);
  s = s.replace(/\s+([,.;:?”…])/g, '$1').replace(/“\s+/g, '“').replace(/[ \t]+/g, ' ').trim();
  s = s.replace(/(^|[.?!…]\s+|\n)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  return s;
}
async function terminarDictado() {
  const t = puntuar(($('dictado-teclado').value.trim() ? $('dictado-teclado').value : E.dictado).trim());
  E.dictado = t; E.provisorio = ''; pintarDictado();
  if (!t) { E.modo = 'dictando'; await decir('No escuché nada. Probá de nuevo, o decí «cancelar».'); tono(988, 140); return; }
  E.modo = 'confirmando'; actualizarBotones();
  await decir(`Anoté: ${t}. Para guardarlo, decí «guardar». Para dictarlo de nuevo, «de nuevo». Para descartarlo, «cancelar».`);
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
    tono(1046, 110); setTimeout(() => tono(1318, 140), 130);
    await decir('Guardado. Decí «seguir» para continuar, o «repetir».');
  } catch (e) { await decir('No se pudo guardar: ' + e.message + '. Probá de nuevo con «guardar».'); }
}
function cancelarDictado() {
  $('dictado').hidden = true; E.dictado = ''; E.provisorio = ''; E.modo = 'pausa'; actualizarBotones();
  decir('Descartado. Decí «seguir» para continuar.');
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
    else if (/^(de nuevo|otra vez|dictar de nuevo|repetir|corregir)$/.test(c)) { E.modo = 'dictando'; E.dictado = ''; pintarDictado(); decir('Dictá de nuevo. Para terminar, decí: listo.').then(() => tono(988, 140)); }
    else if (/^(agregar|seguir dictando|sumar|continuar)$/.test(c)) { E.modo = 'dictando'; decir('Seguí dictando. Para terminar, decí: listo.').then(() => tono(988, 140)); }
    else if (/^(cancelar|no|descartar|borrar)$/.test(c)) cancelarDictado();
    return;
  }
  const texto = (final || provisorio).trim();
  if (!texto) return;
  if (ocupado) {
    // con la voz hablando: solo «pausa», y solo si es una palabra o dos
    if (texto.split(/\s+/).length <= 2 && PARAR.test(sinTildes(texto))) pausar();
    return;
  }
  if (final && texto.split(/\s+/).length <= 5) {
    if (!comando(texto)) estado(`No entendí «${texto}». Decí «ayuda» para escuchar las órdenes.`);
  }
}

function activarMicrofono(si) {
  if (!Reconocimiento) { estado('Este navegador no reconoce la voz: usá Chrome, Edge o Safari. Mientras tanto, botones y teclado.'); return; }
  micActivo = si;
  $('b-microfono').setAttribute('aria-pressed', si ? 'true' : 'false');
  $('b-microfono').textContent = si ? '🎙 Micrófono encendido' : '🎙 Micrófono apagado';
  guardado.set('escucha-mic', si);
  if (!si) { try { reconocimiento?.abort(); } catch { /* nada */ } return; }
  if (!reconocimiento) {
    reconocimiento = new Reconocimiento();
    reconocimiento.lang = 'es-AR'; reconocimiento.continuous = true; reconocimiento.interimResults = true; reconocimiento.maxAlternatives = 1;
    reconocimiento.onresult = alResultado;
    reconocimiento.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { activarMicrofono(false); estado('No hay permiso para usar el micrófono. Habilitalo en el navegador.'); }
    };
    reconocimiento.onend = () => {   // el navegador lo corta cada tanto: se vuelve a encender
      if (!micActivo) return;
      clearTimeout(reiniciar); reiniciar = setTimeout(() => { try { reconocimiento.start(); } catch { /* ya estaba */ } }, 250);
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
  const f = E.fase;
  callar();
  decir(d < 0 ? 'Más lento.' : 'Más rápido.').then(() => { if (f) leer({ desdeFase: f, desdeFrase: E.frase }); else E.modo = 'pausa'; });
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
$('b-redictar').onclick = () => { E.dictado = ''; $('dictado-teclado').value = ''; E.modo = 'dictando'; pintarDictado(); actualizarBotones(); decir('Dictá de nuevo. Para terminar, decí: listo.').then(() => tono(988, 140)); };
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
}
function aplicarAjustes() {
  document.documentElement.style.setProperty('--letra', `${E.aj.letra}px`);
  document.documentElement.dataset.tema = E.aj.tema;
  $('caja-en').hidden = !E.aj.mostrarEn;
  pintarAjustes();
}
const enlazar = (id, clave, conv = (x) => x) => $(id).addEventListener('input', (e) => { E.aj[clave] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value); guardarAjustes(); aplicarAjustes(); });
enlazar('aj-orden', 'orden'); enlazar('aj-avance', 'avance'); enlazar('aj-vel-es', 'velEs', Number); enlazar('aj-vel-en', 'velEn', Number);
enlazar('aj-letra', 'letra', Number); enlazar('aj-tema', 'tema'); enlazar('aj-mostrar-en', 'mostrarEn');
$('aj-voz-es').onchange = (e) => { E.aj.vozEs = e.target.value; guardarAjustes(); };
$('aj-voz-en').onchange = (e) => { E.aj.vozEn = e.target.value; guardarAjustes(); };

// ------------------------------------------------------------ arranque
aplicarAjustes();
(async () => {
  try { E.usuario = await api('/api/sesion'); iniciar(); }
  catch { mostrarEntrada(); }
})();

window.__escucha = { E, armarUnidades, bloques, comando, puntuar, alResultado };   // para pruebas
