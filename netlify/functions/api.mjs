// API del editor de libros (función de Netlify).
// Hace de intermediario entre el editor y el repositorio de GitHub:
// el token de GitHub nunca llega al navegador.
//
// Variables de entorno (Netlify → Site configuration → Environment variables):
//   GITHUB_TOKEN      token de GitHub con permiso de lectura/escritura en el repositorio
//   GITHUB_REPO       dueño/repositorio (por defecto fundacion-meherbaba/libros)
//   GITHUB_RAMA       rama de trabajo (por defecto main)
//   GOOGLE_CLIENT_ID  ID de cliente OAuth de Google (para "Entrar con Google")
//   EDITORES          correos autorizados, separados por coma (o @dominio.org para todo un dominio)
//   SESSION_SECRET    texto largo al azar para firmar las sesiones

import crypto from 'node:crypto';

const GH = 'https://api.github.com';
const DURACION_SESION = 12 * 60 * 60 * 1000; // 12 horas

const env = (k, d = '') => process.env[k] || d;
const REPO = () => env('GITHUB_REPO', 'fundacion-meherbaba/libros');
const RAMA = () => env('GITHUB_RAMA', 'main');

// ------------------------------------------------------------ respuestas
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const error = (status, mensaje, extra = {}) => json({ error: mensaje, ...extra }, status);

// ------------------------------------------------------------ sesiones
function hmac(texto) {
  return crypto.createHmac('sha256', env('SESSION_SECRET')).update(texto).digest('base64url');
}

function firmar(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${p}.${hmac(p)}`;
}

export function autorizado(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  return env('EDITORES')
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .some((x) => x === e || (x.startsWith('@') && e.endsWith(x)));
}

function leerSesion(req) {
  if (!env('SESSION_SECRET')) return null;
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sesion=([^;]+)/);
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s) return null;
  const esperado = hmac(p);
  if (s.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esperado))) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!datos.exp || datos.exp < Date.now()) return null;
  if (!autorizado(datos.email)) return null; // si se lo quita de la lista, pierde acceso enseguida
  return datos;
}

const cookie = (valor, maxAge) =>
  `sesion=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function verificarGoogle(credential) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!r.ok) return null;
  const t = await r.json();
  const verificado = t.email_verified === true || t.email_verified === 'true';
  const emisor = ['accounts.google.com', 'https://accounts.google.com'].includes(t.iss);
  if (t.aud !== env('GOOGLE_CLIENT_ID') || !verificado || !emisor) return null;
  return { email: t.email, nombre: t.name || t.given_name || t.email.split('@')[0] };
}

// ------------------------------------------------------------ GitHub
async function gh(ruta, opciones = {}) {
  return fetch(GH + ruta, {
    ...opciones,
    headers: {
      authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'editor-libros',
      ...(opciones.headers || {}),
    },
  });
}

async function ghJson(ruta, opciones) {
  const r = await gh(ruta, opciones);
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
  return { ok: r.ok, status: r.status, datos };
}

async function graphql(query, variables) {
  const r = await ghJson('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (!r.ok || r.datos?.errors) throw new Error('GraphQL: ' + JSON.stringify(r.datos?.errors || r.status));
  return r.datos.data;
}

const codificar = (ruta) => ruta.split('/').map(encodeURIComponent).join('/');

// Solo se puede leer dentro de libros/ y colecciones/; escribir, solo texto.
const rutaValida = (p) =>
  typeof p === 'string' && /^(libros|colecciones)\/[A-Za-z0-9_\-./]+$/.test(p) && !p.includes('..') && !p.includes('//');
const rutaEscribible = (p) => rutaValida(p) && /\.(md|ya?ml|css|txt)$/.test(p);

const TIPOS = {
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp',
  css: 'text/css; charset=utf-8', md: 'text/markdown; charset=utf-8', yaml: 'text/yaml; charset=utf-8', pdf: 'application/pdf',
};

// ------------------------------------------------------------ rutas
const QUERY_ARBOL = `query($owner:String!,$name:String!,$expr:String!){
  repository(owner:$owner,name:$name){ object(expression:$expr){ ... on Tree {
    entries { name path oid type object { ... on Blob { text } } } } } } }`;

async function arbol(ruta) {
  const [owner, name] = REPO().split('/');
  const d = await graphql(QUERY_ARBOL, { owner, name, expr: `${RAMA()}:${ruta}` });
  return d.repository?.object?.entries || [];
}

async function archivo(ruta, ref) {
  const r = await ghJson(`/repos/${REPO()}/contents/${codificar(ruta)}?ref=${encodeURIComponent(ref || RAMA())}`);
  if (!r.ok) return null;
  return { texto: Buffer.from(r.datos.content || '', 'base64').toString('utf8'), sha: r.datos.sha };
}

const tituloDe = (texto, nombre) => (texto?.match(/^#\s+(.+)$/m)?.[1] || nombre.replace(/\.md$/, '')).trim();

const rutas = {
  // ---- públicas
  'GET /api/config': async () => json({ googleClientId: env('GOOGLE_CLIENT_ID'), repo: REPO() }),

  'POST /api/sesion': async (req) => {
    if (!env('SESSION_SECRET') || !env('GOOGLE_CLIENT_ID')) return error(500, 'Falta configurar el inicio de sesión en Netlify.');
    const { credential } = await req.json().catch(() => ({}));
    if (!credential) return error(400, 'Falta la credencial de Google.');
    const u = await verificarGoogle(credential);
    if (!u) return error(401, 'No se pudo verificar la cuenta de Google.');
    if (!autorizado(u.email)) return error(403, `La cuenta ${u.email} no está habilitada. Pedile acceso a quien administra el editor.`);
    const sesion = { ...u, exp: Date.now() + DURACION_SESION };
    return json({ email: u.email, nombre: u.nombre }, 200, { 'set-cookie': cookie(firmar(sesion), DURACION_SESION / 1000) });
  },

  'POST /api/salir': async () => json({ ok: true }, 200, { 'set-cookie': cookie('', 0) }),

  // ---- con sesión
  'GET /api/sesion': async (req, u) => json({ email: u.email, nombre: u.nombre }),

  'GET /api/libros': async () => {
    const entradas = await arbol('libros');
    const libros = [];
    for (const e of entradas.filter((x) => x.type === 'tree')) {
      const datos = await arbol(e.path);
      const yml = datos.find((x) => x.name === 'libro.yaml')?.object?.text || '';
      libros.push({ id: e.name, titulo: yml.match(/^titulo:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || e.name });
    }
    return json(libros);
  },

  'GET /api/libro': async (req) => {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!/^[a-z0-9\-_]+$/i.test(id)) return error(400, 'Libro inválido.');
    const base = `libros/${id}`;
    const libro = await archivo(`${base}/libro.yaml`);
    if (!libro) return error(404, 'No encontré ese libro.');
    const fichaRel = libro.texto.match(/^ficha:\s*(\S+)/m)?.[1];
    if (!fichaRel) return error(500, 'El libro no indica qué ficha usa.');
    const partes = [...base.split('/'), ...fichaRel.split('/')];
    const pila = [];
    for (const p of partes) { if (p === '..') pila.pop(); else if (p && p !== '.') pila.push(p); }
    const fichaRuta = pila.join('/');
    const ficha = await archivo(fichaRuta);
    if (!ficha) return error(500, `No encontré la ficha ${fichaRuta}.`);
    const fichaDir = fichaRuta.split('/').slice(0, -1).join('/');
    const estilosNombre = ficha.texto.match(/^estilos:\s*(\S+)/m)?.[1] || 'estilos.css';
    const estilos = await archivo(`${fichaDir}/${estilosNombre}`);
    const dicNombre = ficha.texto.match(/^diccionario:\s*(\S+)/m)?.[1] || 'diccionario.txt';
    const diccionario = await archivo(`${fichaDir}/${dicNombre}`);
    const caps = (await arbol(`${base}/capitulos`))
      .filter((e) => e.type === 'blob' && e.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ ruta: e.path, nombre: e.name, titulo: tituloDe(e.object?.text, e.name), sha: e.oid }));
    return json({
      id, base,
      libro: { ruta: `${base}/libro.yaml`, texto: libro.texto, sha: libro.sha },
      ficha: { ruta: fichaRuta, dir: fichaDir, texto: ficha.texto, sha: ficha.sha },
      estilos: { ruta: `${fichaDir}/${estilosNombre}`, texto: estilos?.texto || '', sha: estilos?.sha },
      diccionario: { ruta: `${fichaDir}/${dicNombre}`, texto: diccionario?.texto || '' },
      capitulos: caps,
    });
  },

  'GET /api/archivo': async (req) => {
    const q = new URL(req.url).searchParams;
    const ruta = q.get('ruta');
    if (!rutaValida(ruta)) return error(400, 'Ruta inválida.');
    const a = await archivo(ruta, q.get('ref'));
    return a ? json(a) : error(404, 'No encontré el archivo.');
  },

  'PUT /api/archivo': async (req, u) => {
    const { ruta, texto, sha, mensaje } = await req.json().catch(() => ({}));
    if (!rutaEscribible(ruta) || typeof texto !== 'string') return error(400, 'Datos inválidos.');
    const cuerpo = {
      message: (mensaje || `Corrección en ${ruta.split('/').pop()}`).slice(0, 200) + `\n\nEditado por ${u.nombre} <${u.email}> desde el editor.`,
      content: Buffer.from(texto, 'utf8').toString('base64'),
      branch: RAMA(),
      author: { name: u.nombre, email: u.email },
      ...(sha ? { sha } : {}),
    };
    const r = await ghJson(`/repos/${REPO()}/contents/${codificar(ruta)}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
    if (r.ok) return json({ sha: r.datos.content.sha, commit: r.datos.commit.sha });
    if (r.status === 409 || (r.status === 422 && /sha/i.test(JSON.stringify(r.datos)))) {
      const actual = await archivo(ruta);
      const ultimo = await ghJson(`/repos/${REPO()}/commits?path=${encodeURIComponent(ruta)}&sha=${RAMA()}&per_page=1`);
      const c = ultimo.datos?.[0]?.commit;
      return error(409, 'Otra persona guardó cambios en este capítulo mientras lo editabas.', {
        actual, por: c?.author?.name, fecha: c?.author?.date,
      });
    }
    return error(502, 'GitHub no aceptó el cambio.', { detalle: r.datos?.message });
  },

  // Agrega una palabra al diccionario compartido de la colección (sin pisar a otros).
  'POST /api/diccionario': async (req, u) => {
    const { ruta, palabra } = await req.json().catch(() => ({}));
    const w = String(palabra || '').trim();
    if (!rutaEscribible(ruta) || !ruta.endsWith('.txt')) return error(400, 'Diccionario inválido.');
    if (!/^[\p{L}][\p{L}'’\-]{0,60}$/u.test(w)) return error(400, 'Solo se pueden agregar palabras (letras, guion o apóstrofo).');
    for (let intento = 0; intento < 4; intento++) {
      const a = await archivo(ruta);
      const lineas = (a?.texto || '# Diccionario de la colección: una palabra por línea.\n').split('\n');
      const cabecera = lineas.filter((l) => l.startsWith('#'));
      const palabras = new Set(lineas.filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim()));
      if (palabras.has(w)) return json({ ok: true, yaEstaba: true });
      palabras.add(w);
      const orden = [...palabras].sort((x, y) => x.localeCompare(y, 'es', { sensitivity: 'base' }) || x.localeCompare(y));
      const texto = [...cabecera, ...orden].join('\n') + '\n';
      const r = await ghJson(`/repos/${REPO()}/contents/${codificar(ruta)}`, { method: 'PUT', body: JSON.stringify({
        message: `Diccionario: agrega «${w}»\n\nAgregada por ${u.nombre} <${u.email}> desde el editor.`,
        content: Buffer.from(texto, 'utf8').toString('base64'), branch: RAMA(),
        author: { name: u.nombre, email: u.email }, ...(a?.sha ? { sha: a.sha } : {}),
      }) });
      if (r.ok) return json({ ok: true });
      if (r.status !== 409 && r.status !== 422) return error(502, 'GitHub no aceptó el cambio.', { detalle: r.datos?.message });
    }
    return error(409, 'Varias personas están editando el diccionario a la vez. Probá de nuevo.');
  },

  'GET /api/historial': async (req) => {
    const ruta = new URL(req.url).searchParams.get('ruta');
    if (!rutaValida(ruta)) return error(400, 'Ruta inválida.');
    const r = await ghJson(`/repos/${REPO()}/commits?path=${encodeURIComponent(ruta)}&sha=${RAMA()}&per_page=30`);
    if (!r.ok) return error(502, 'No pude leer el historial.');
    return json(r.datos.map((c) => ({
      sha: c.sha, autor: c.commit.author.name, fecha: c.commit.author.date, mensaje: c.commit.message.split('\n')[0],
    })));
  },

  'GET /api/raw': async (req) => {
    const ruta = new URL(req.url).searchParams.get('ruta');
    if (!rutaValida(ruta)) return error(400, 'Ruta inválida.');
    const r = await gh(`/repos/${REPO()}/contents/${codificar(ruta)}?ref=${RAMA()}`, { headers: { accept: 'application/vnd.github.raw' } });
    if (!r.ok) return error(404, 'No encontré el archivo.');
    const ext = ruta.split('.').pop().toLowerCase();
    return new Response(await r.arrayBuffer(), {
      headers: { 'content-type': TIPOS[ext] || 'application/octet-stream', 'cache-control': 'private, max-age=3600' },
    });
  },

  'POST /api/exportar': async (req) => {
    const { libro } = await req.json().catch(() => ({}));
    if (libro && !/^[a-z0-9\-_]+$/i.test(libro)) return error(400, 'Libro inválido.');
    const r = await ghJson(`/repos/${REPO()}/actions/workflows/exportar.yml/dispatches`, {
      method: 'POST', body: JSON.stringify({ ref: RAMA(), inputs: { libro: libro || '' } }),
    });
    return r.ok ? json({ ok: true }) : error(502, 'No pude iniciar la exportación.', { detalle: r.datos?.message });
  },

  'GET /api/exportaciones': async () => {
    const r = await ghJson(`/repos/${REPO()}/actions/workflows/exportar.yml/runs?per_page=8`);
    if (!r.ok) return error(502, 'No pude leer las exportaciones.');
    return json(r.datos.workflow_runs.map((x) => ({
      id: x.id, titulo: (x.display_title || '').split('\n')[0], estado: x.status, resultado: x.conclusion, fecha: x.created_at, enlace: x.html_url,
    })));
  },

  'GET /api/descargar': async (req) => {
    const id = new URL(req.url).searchParams.get('id');
    if (!/^\d+$/.test(id || '')) return error(400, 'Exportación inválida.');
    const a = await ghJson(`/repos/${REPO()}/actions/runs/${id}/artifacts`);
    const art = a.datos?.artifacts?.find((x) => !x.expired);
    if (!art) return error(404, 'Esta exportación ya no tiene archivos para descargar.');
    const r = await gh(`/repos/${REPO()}/actions/artifacts/${art.id}/zip`, { redirect: 'manual' });
    const url = r.headers.get('location');
    return url ? json({ url, nombre: `${art.name}.zip` }) : error(502, 'No pude obtener el enlace de descarga.');
  },
};

export default async (req) => {
  const ruta = new URL(req.url).pathname.replace(/\/$/, '');
  const clave = `${req.method} ${ruta}`;
  const fn = rutas[clave];
  if (!fn) return error(404, 'Ruta desconocida.');
  const publica = ['GET /api/config', 'POST /api/sesion', 'POST /api/salir'].includes(clave);
  // Las escrituras exigen un encabezado propio: un sitio ajeno no puede enviarlo.
  if (req.method !== 'GET' && req.headers.get('x-editor') !== '1') return error(403, 'Solicitud no permitida.');
  let usuario = null;
  if (!publica) {
    usuario = leerSesion(req);
    if (!usuario) return error(401, 'Tu sesión venció. Volvé a entrar.');
    if (!env('GITHUB_TOKEN')) return error(500, 'Falta configurar GITHUB_TOKEN en Netlify.');
  }
  try {
    return await fn(req, usuario);
  } catch (e) {
    console.error(e);
    return error(500, 'Error inesperado del servidor.', { detalle: String(e.message || e).slice(0, 300) });
  }
};

export const config = { path: '/api/*' };
