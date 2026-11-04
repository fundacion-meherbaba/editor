// Revisión ortográfica y tipográfica (corre aparte para no trabar la escritura).
// Diccionario: español de Argentina (LibreOffice / RLA-ES) + diccionario de la colección.
'use strict';
importScripts('vendor/nspell.min.js');

let corrector = null;
let listo = null;
const cache = new Map();          // palabra → true (bien) / false (mal)
const sugerencias = new Map();
const extra = new Set();          // diccionario de la colección + ignoradas
const extraMinus = new Set();

function cargar() {
  if (listo) return listo;
  listo = Promise.all([
    fetch('vendor/diccionario/es-AR.aff').then((r) => r.text()),
    fetch('vendor/diccionario/es-AR.dic').then((r) => r.text()),
  ]).then(([aff, dic]) => { corrector = self.NSpell({ aff, dic }); });
  return listo;
}

function agregar(palabras) {
  for (const p of palabras) {
    const w = p.trim();
    if (!w || w.startsWith('#')) continue;
    extra.add(w); extraMinus.add(w.toLocaleLowerCase('es'));
  }
  cache.clear(); sugerencias.clear();
}

const esRomano = (w) => /^[IVXLCDM]+$/.test(w);
const LETRA = /\p{L}/u;

function palabraCorrecta(w) {
  if (cache.has(w)) return cache.get(w);
  let ok;
  if (w.length < 2 || esRomano(w)) ok = true;
  else if (extra.has(w) || extraMinus.has(w.toLocaleLowerCase('es'))) ok = true;
  else if (corrector.correct(w)) ok = true;
  else if (w.includes('-')) ok = w.split('-').every((p) => !p || palabraCorrecta(p));
  else if (/^\p{Lu}[\p{Ll}]+$/u.test(w) && corrector.correct(w.toLocaleLowerCase('es'))) ok = true;
  else ok = false;
  cache.set(w, ok);
  return ok;
}

// Zonas que no se revisan: marcas de bloque, imágenes, referencias de notas,
// direcciones web y correos, y lo que está en *cursiva* (términos en otro idioma).
function zonasExcluidas(t) {
  const z = [];
  const agregarZ = (re, todo = true) => { for (const m of t.matchAll(re)) z.push([m.index, m.index + m[0].length, todo]); };
  agregarZ(/^:::.*$/gm);
  agregarZ(/^::: *contacto *\n[\s\S]*?^:::\s*$/gm);          // direcciones de los centros: no se revisan
  agregarZ(/!\[[^\]\n]*\]\([^)\n]*\)(\{[^}\n]*\})?/g);
  agregarZ(/\[\^\d+\]:?/g);
  agregarZ(/\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/g);
  agregarZ(/(?<![*\w])\*(?!\*)[^*\n]+\*(?!\*)/g, false);   // cursiva: solo se saltea la ortografía
  return z.sort((a, b) => a[0] - b[0]);
}
const dentro = (zonas, i, soloTodo) => zonas.some(([a, b, todo]) => i >= a && i < b && (!soloTodo || todo));

// Reglas de puntuación y tipografía (los mismos criterios que herramientas/limpiar_texto.py)
const REGLAS = [
  { re: /(\S)([ \t]+)([,;:.)?!»])(?=\s|$|[*"”’])/g, msg: (m) => `Sobra el espacio antes de «${m[3]}»`, arreglo: (m) => m[1] + m[3] },
  { re: /([(¿¡«])[ \t]+(?=\S)/g, msg: (m) => `Sobra el espacio después de «${m[1]}»`, arreglo: (m) => m[1] },
  { re: /(?<!\.)\.\.\.(?!\.)/g, msg: () => 'Puntos suspensivos: usar «…»', arreglo: () => '…' },
  { re: /(?<=\p{L}) - (?=\p{L})/gu, msg: () => 'Inciso: usar raya o semirraya «–» en lugar de guion', arreglo: () => ' – ' },
  { re: /([\p{Ll})])([,;])(?=[\p{L}¿¡])/gu, msg: (m) => `Falta un espacio después de «${m[2]}»`, arreglo: (m) => m[1] + m[2] + ' ' },
  { re: /(\p{Ll}{2})\.(?=[\p{Lu}¿¡]\p{Ll})/gu, msg: () => 'Falta un espacio después del punto', arreglo: (m) => m[1] + '. ' },
  { re: /(?<=\S)[ \t]{2,}(?=\S)/g, msg: () => 'Espacio doble', arreglo: () => ' ' },
  { re: /(?<![\p{L}])(\p{L}{2,})[ \t]+\1(?![\p{L}])/giu, msg: (m) => `Palabra repetida: «${m[1]}»`, arreglo: (m) => m[1], repetida: true },
];

function revisar(texto) {
  const zonas = zonasExcluidas(texto);
  const errores = [];
  // Ortografía
  for (const m of texto.matchAll(/\p{L}+(?:[-'’]\p{L}+)*/gu)) {
    const w = m[0];
    if (dentro(zonas, m.index, false)) continue;
    if (!palabraCorrecta(w)) errores.push({ tipo: 'orto', ini: m.index, fin: m.index + w.length, palabra: w });
  }
  // Puntuación y tipografía
  for (const r of REGLAS) {
    r.re.lastIndex = 0;
    for (const m of texto.matchAll(r.re)) {
      if (dentro(zonas, m.index, true)) continue;
      if (r.repetida && (extraMinus.has(m[1].toLocaleLowerCase('es')))) continue;   // «neti neti», términos propios
      errores.push({ tipo: 'tipo', ini: m.index, fin: m.index + m[0].length, original: m[0], mensaje: r.msg(m), arreglo: r.arreglo(m) });
    }
  }
  errores.sort((a, b) => a.ini - b.ini || a.fin - b.fin);
  // sin superposiciones (gana la primera)
  const out = []; let hasta = -1;
  for (const e of errores) { if (e.ini >= hasta) { out.push(e); hasta = e.fin; } }
  return out;
}

// Variantes con una tilde agregada, quitada o cambiada de lugar, y con ü/ñ.
const TILDES = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' };
const SIN = Object.fromEntries(Object.entries(TILDES).map(([k, v]) => [v, k]));
function variantesTilde(w) {
  const base = [...w].map((c) => SIN[c] || c).join('');
  const out = new Set([base]);
  const letras = [...base];
  letras.forEach((c, i) => {
    if (TILDES[c]) { const v = [...letras]; v[i] = TILDES[c]; out.add(v.join('')); }
    if (c === 'u' || c === 'U') { const v = [...letras]; v[i] = c === 'u' ? 'ü' : 'Ü'; out.add(v.join('')); }
    if (c === 'n' || c === 'N') { const v = [...letras]; v[i] = c === 'n' ? 'ñ' : 'Ñ'; out.add(v.join('')); }
  });
  out.delete(w);
  return [...out].filter((x) => palabraCorrecta(x));
}
// Palabras pegadas: «decaracter» → «de carácter», «llevaen» → «lleva en».
// Solo si una de las dos partes es una palabra corta de enlace (evita cortes absurdos).
const ENLACE = new Set('a al de del el en la las los lo un una y o u e que por con sin su sus es no mi tu ya'.split(' '));
const NO_SEGUNDA = new Set('me te se le les lo la los las nos'.split(' '));
function separadas(w) {
  const out = [];
  for (let i = 1; i < w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b.length < 2) continue;
    const la = a.toLocaleLowerCase('es'), lb = b.toLocaleLowerCase('es');
    const enlaceA = ENLACE.has(la), enlaceB = ENLACE.has(lb) && !NO_SEGUNDA.has(lb);
    if (!enlaceA && !enlaceB) continue;
    if ((!enlaceA && a.length < 3) || (!enlaceB && b.length < 3)) continue;
    const okA = palabraCorrecta(a) ? [a] : variantesTilde(a);
    const okB = palabraCorrecta(b) ? [b] : variantesTilde(b);
    if (okA.length && okB.length) out.push(`${okA[0]} ${okB[0]}`);
  }
  return out;
}
// Parecidas en el diccionario de la colección (sanaskaras → sanskaras)
function distancia(a, b) {
  const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
function parecidasPropias(w) {
  const lw = w.toLocaleLowerCase('es');
  return [...extra].map((x) => [x, distancia(lw, x.toLocaleLowerCase('es'))]).filter(([, d]) => d <= (w.length > 6 ? 2 : 1))
    .sort((a, b) => a[1] - b[1]).map(([x]) => x);
}

function sugerir(w) {
  if (sugerencias.has(w)) return sugerencias.get(w);
  let s = [...variantesTilde(w), ...parecidasPropias(w), ...separadas(w), ...corrector.suggest(w)];
  // Primero las que solo difieren en tildes o mayúsculas (el error más común en español)
  const base = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
  s = [...s.filter((x) => base(x) === base(w)), ...s.filter((x) => base(x) !== base(w))];
  // Respetar mayúscula inicial de la palabra escrita
  if (/^\p{Lu}/u.test(w)) s = s.map((x) => x.charAt(0).toLocaleUpperCase('es') + x.slice(1));
  else s = s.map((x) => (/^\p{Lu}\p{Ll}/u.test(x) && palabraCorrecta(x.toLocaleLowerCase('es')) ? x.toLocaleLowerCase('es') : x));
  const vistas = new Set();
  s = s.filter((x) => x !== w && !vistas.has(x) && vistas.add(x)).slice(0, 6);
  sugerencias.set(w, s);
  return s;
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    await cargar();
    if (d.tipo === 'diccionario') { agregar(d.palabras); self.postMessage({ tipo: 'listo' }); }
    else if (d.tipo === 'agregar') { agregar(d.palabras); }
    else if (d.tipo === 'revisar') {
      const t0 = Date.now();
      self.postMessage({ tipo: 'errores', id: d.id, errores: revisar(d.texto), ms: Date.now() - t0 });
    } else if (d.tipo === 'sugerir') {
      self.postMessage({ tipo: 'sugerencias', id: d.id, palabra: d.palabra, sugerencias: sugerir(d.palabra) });
    }
  } catch (err) {
    self.postMessage({ tipo: 'error', id: d.id, mensaje: String(err && err.message || err) });
  }
};
