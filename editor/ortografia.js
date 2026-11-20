// Corrector ortográfico, gramatical y tipográfico del editor.
// - Subraya en rojo las palabras que no están en el diccionario, con doble línea azul los
//   errores de gramática, con puntos dorados las sugerencias de estilo y con puntos azules
//   los detalles de puntuación y tipografía.
// - La ortografía y la tipografía se revisan en el navegador (ortografia-worker.js); la gramática
//   y el estilo, con LanguageTool a través de /api/gramatica, de a párrafos y guardando lo ya
//   revisado para no volver a consultarlo.
// - Tocando una palabra marcada aparecen sugerencias, «Agregar al diccionario»
//   (compartido por todo el equipo) e «Ignorar».
// - El panel «Revisar» lista todo el capítulo y permite corregir de a muchas.
'use strict';

(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let ta, marcas, interior, popup, worker, opciones;
  let errores = [];
  let version = 0;           // cambia con cada edición: descarta resultados viejos
  let revisado = -1;
  let activa = true;
  let pendientes = new Map(); // id → resolver de sugerencias
  let nId = 0;
  let tRevisar;
  let listo = false;
  let ignoradas = new Set();
  let base = [];              // errores de ortografía y tipografía (worker) del texto actual

  function guardarPref(v) { try { localStorage.setItem('ortografia', v ? '1' : '0'); } catch { /* nada */ } }
  function leerPref() { try { return localStorage.getItem('ortografia') !== '0'; } catch { return true; } }

  // Opciones de revisión (como en Word: Archivo › Opciones › Revisión). Se recuerdan en este navegador.
  const OPC_DEF = { repetidas: true, puntuacion: true, gramatica: true, confusas: true, estilo: false };
  const leerJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const guardarJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* nada */ } };
  let opc = { ...OPC_DEF, ...leerJSON('revision-opciones', {}) };
  let apagadas = new Map(leerJSON('reglas-apagadas', []));   // regla → descripción
  const ignoradasGram = new Set();                          // «regla|texto» ignorados en esta sesión

  function iniciar(o) {
    opciones = o;
    ta = o.textarea;
    // Capa de subrayados detrás del texto
    const envoltura = document.createElement('div');
    envoltura.className = 'texto-envoltura';
    ta.parentNode.insertBefore(envoltura, ta);
    marcas = document.createElement('div'); marcas.className = 'marcas'; marcas.setAttribute('aria-hidden', 'true');
    interior = document.createElement('div'); interior.className = 'marcas-int';
    marcas.appendChild(interior);
    envoltura.appendChild(marcas); envoltura.appendChild(ta);
    popup = document.createElement('div'); popup.className = 'orto-popup'; popup.hidden = true; popup.setAttribute('role', 'menu');
    document.body.appendChild(popup);

    const ajustar = () => {
      marcas.style.width = ta.clientWidth + 'px';
      marcas.style.height = ta.clientHeight + 'px';
      interior.style.transform = `translateY(${-ta.scrollTop}px)`;
    };
    new ResizeObserver(ajustar).observe(ta);
    ta.addEventListener('scroll', () => {
      interior.style.transform = `translateY(${-ta.scrollTop}px)`;
      // el menú acompaña a la palabra mientras se desplaza el texto
      if (!popup.hidden) {
        const m = interior.querySelector('mark.activa');
        const r = m && m.getBoundingClientRect(), c = ta.getBoundingClientRect();
        if (!r || r.bottom < c.top || r.top > c.bottom) cerrarPopup(); else colocar(m);
      }
    }, { passive: true });
    ta.addEventListener('input', () => { pintarPlano(); programar(); });
    ta.addEventListener('click', alTocar);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarPopup(); });
    document.addEventListener('pointerdown', (e) => { if (!popup.hidden && !popup.contains(e.target) && e.target !== ta) cerrarPopup(); });
    window.addEventListener('resize', cerrarPopup);
    ajustar();

    activa = leerPref();
    const chk = o.interruptor;
    if (chk) { chk.checked = activa; chk.onchange = () => activar(chk.checked); }
    try {
      worker = new Worker('ortografia-worker.js');
      worker.onmessage = alMensaje;
      worker.onerror = () => falla();
    } catch { falla(); }
    activar(activa);
  }

  function falla() {
    worker = null;
    ta.spellcheck = true;   // queda la corrección del navegador
    opciones.contador && (opciones.contador.textContent = 'no disponible');
  }

  function activar(si) {
    activa = si; guardarPref(si);
    ta.spellcheck = !si || !worker;      // sin doble subrayado
    marcas.hidden = !si;
    if (!si) { errores = []; cerrarPopup(); actualizarContador(); }
    else { pintarPlano(); programar(0); }
  }

  function diccionario(palabras) {
    if (!worker) return;
    listo = false;
    worker.postMessage({ tipo: 'diccionario', palabras: palabras || [] });
  }

  function alMensaje(e) {
    const d = e.data;
    if (d.tipo === 'listo') { listo = true; programar(0); }
    else if (d.tipo === 'errores') {
      if (d.id !== version) return;           // llegó tarde: el texto ya cambió
      base = d.errores.filter((x) => !(x.tipo === 'orto' && ignoradas.has(x.palabra)));
      revisado = d.id;
      mezclar();
      gramProgramar(900);
      if (opciones.alRevisar) opciones.alRevisar(errores);
    } else if (d.tipo === 'sugerencias') {
      const r = pendientes.get(d.id); if (r) { pendientes.delete(d.id); r(d.sugerencias); }
    } else if (d.tipo === 'error') {
      console.warn('Ortografía:', d.mensaje);
    }
  }

  function programar(ms = 450) {
    if (!worker || !activa) return;
    version++;
    clearTimeout(tRevisar);
    tRevisar = setTimeout(() => { if (listo) worker.postMessage({ tipo: 'revisar', id: version, texto: ta.value, opciones: { repetidas: opc.repetidas, puntuacion: opc.puntuacion } }); }, ms);
  }

  // Llamado por el editor cuando cambia el texto sin que el usuario tipee (abrir capítulo, versión anterior…)
  function textoCambio() { if (!activa) return; pintarPlano(); programar(80); }

  function pintarPlano() {
    if (!activa) return;
    interior.textContent = ta.value + '​';
    errores = []; base = [];
  }

  // ---------------------------------------------------------- gramática (LanguageTool)
  const LIMITE = 12000;        // caracteres por consulta
  const INTERVALO = 3300;      // entre consultas (el servicio gratuito admite unas 20 por minuto)
  const gram = { cache: new Map(), enCurso: false, proxima: 0, esperaHasta: 0, timer: null, falta: 0, total: 0, aviso: '' };
  const firma = () => `|${opc.confusas ? 1 : 0}${opc.estilo ? 1 : 0}|${[...apagadas.keys()].sort().join(',')}`;

  // Párrafos: bloques separados por una línea en blanco, con su posición en el texto.
  function bloques(t) {
    const out = []; const re = /\n[ \t]*\n/g; let i = 0, m;
    while ((m = re.exec(t))) { out.push({ ini: i, texto: t.slice(i, m.index) }); i = m.index + m[0].length; }
    out.push({ ini: i, texto: t.slice(i) });
    return out.filter((b) => b.texto.trim());
  }

  // Saca las marcas (#, >, *, :::, notas, fotos…) y guarda de dónde viene cada letra,
  // para ubicar después los errores en el texto original.
  function limpiar(b) {
    let out = ''; const mapa = [];
    let pos = b.ini;
    for (const linea of b.texto.split('\n')) {
      const saltar = new Array(linea.length).fill(false);
      const marcar = (re) => { re.lastIndex = 0; let m; while ((m = re.exec(linea))) { for (let k = m.index; k < m.index + m[0].length; k++) saltar[k] = true; if (!m[0].length) re.lastIndex++; } };
      if (/^\s*:::/.test(linea) || /^\s*(\*\s*){3,}$/.test(linea) || /^\s*(-\s*){3,}$/.test(linea)) saltar.fill(true);
      else {
        marcar(/^#{1,4}\s+/g); marcar(/\s*\{[.#][^}]*\}\s*$/g); marcar(/^>\s?/g); marcar(/^\[\^\d+\]:\s*/g);
        marcar(/!\[/g); marcar(/\]\([^)]*\)(\{[^}]*\})?/g); marcar(/\[\^\d+\]/g);
        marcar(/\*+/g); marcar(/\\(?=[\\*_\[\]<`#>])/g);
      }
      for (let k = 0; k < linea.length; k++) if (!saltar[k]) { out += linea[k]; mapa.push(pos + k); }
      out += '\n'; mapa.push(pos + linea.length);
      pos += linea.length + 1;
    }
    out = out.replace(/\n$/, ''); mapa.length = out.length;
    return /\p{L}{2}/u.test(out) ? { texto: out, mapa } : null;
  }

  function gramProgramar(ms = 1200) {
    clearTimeout(gram.timer);
    if (!activa || !opc.gramatica) return;
    gram.timer = setTimeout(gramPaso, ms);
  }

  async function gramPaso() {
    if (!activa || !opc.gramatica || gram.enCurso || !ta.value) return;
    const espera = Math.max(gram.proxima, gram.esperaHasta) - Date.now();
    if (espera > 0) { gramProgramar(espera + 50); return; }
    const sig = firma();
    const bs = bloques(ta.value).map((b) => ({ ini: b.ini, l: limpiar(b) })).filter((b) => b.l);
    const faltan = bs.filter((b) => !gram.cache.has(b.l.texto + sig));
    gram.total = bs.length; gram.falta = faltan.length;
    actualizarContador();
    if (!faltan.length) return;
    // primero los párrafos cerca de donde se está escribiendo
    const cur = ta.selectionStart || 0;
    faltan.sort((a, b) => Math.abs(a.ini - cur) - Math.abs(b.ini - cur));
    const lote = []; let largo = 0;
    for (const b of faltan) {
      if (b.l.texto.length > LIMITE) { gram.cache.set(b.l.texto + sig, []); continue; }   // párrafo enorme: se saltea
      if (largo && largo + b.l.texto.length + 2 > LIMITE) break;
      lote.push({ b, desde: largo }); largo += b.l.texto.length + 2;
    }
    if (!lote.length) { gramProgramar(0); return; }
    gram.enCurso = true; gram.proxima = Date.now() + INTERVALO;
    try {
      const r = await fetch('/api/gramatica', {
        method: 'POST', credentials: 'same-origin', headers: { 'x-editor': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ texto: lote.map((x) => x.b.l.texto).join('\n\n'), apagadas: [...apagadas.keys()], estilo: opc.estilo, confusas: opc.confusas }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 429) { gram.esperaHasta = Date.now() + 1000 * (d.esperar || 30); gram.aviso = 'el servicio pidió esperar un momento'; }
      else if (!r.ok) { gram.esperaHasta = Date.now() + 60000; gram.aviso = d.error || 'no disponible'; }
      else {
        gram.aviso = '';
        for (const { b, desde } of lote) {
          const hasta = desde + b.l.texto.length;
          gram.cache.set(b.l.texto + sig, (d.errores || []).filter((e) => e.ini >= desde && e.ini + e.largo <= hasta).map((e) => ({ ...e, ini: e.ini - desde })));
        }
        if (gram.cache.size > 4000) [...gram.cache.keys()].slice(0, 1000).forEach((k) => gram.cache.delete(k));
      }
    } catch { gram.esperaHasta = Date.now() + 20000; gram.aviso = 'sin conexión'; }
    finally { gram.enCurso = false; }
    if (revisado === version) mezclar();
    gramProgramar(0);
  }

  // Junta los errores del corrector con los de gramática ya revisados (sin superponerlos).
  function mezclar() {
    const t = ta.value; const sig = firma(); const g = [];
    if (opc.gramatica) {
      for (const b of bloques(t)) {
        const l = limpiar(b); if (!l) continue;
        const ms = gram.cache.get(l.texto + sig); if (!ms) continue;
        for (const m of ms) {
          if (apagadas.has(m.regla)) continue;
          const ini = l.mapa[m.ini], ult = l.mapa[m.ini + Math.max(1, m.largo) - 1];
          if (ini == null || ult == null) continue;
          const fin = ult + 1, original = t.slice(ini, fin);
          if (ignoradasGram.has(`${m.regla}|${original}`)) continue;
          const estilo = m.clase === 'style' || m.clase === 'locale-violation' || /STYLE|REDUNDANCY|REPETITION/.test(m.categoria || '');
          g.push({ tipo: estilo ? 'estilo' : 'gram', ini, fin, original, mensaje: m.mensaje, sugerencias: m.sugerencias || [], regla: m.regla, descripcion: m.descripcion });
        }
      }
    }
    const todos = [...base];
    for (const e of g) if (!todos.some((x) => e.ini < x.fin && x.ini < e.fin)) todos.push(e);
    errores = todos.sort((a, b) => a.ini - b.ini || a.fin - b.fin);
    pintar(); actualizarContador();
  }

  function pintar() {
    const t = ta.value;
    let h = '', i = 0;
    errores.forEach((e, k) => {
      h += esc(t.slice(i, e.ini));
      h += `<mark class="m-${e.tipo}" data-i="${k}">${esc(t.slice(e.ini, e.fin))}</mark>`;
      i = e.fin;
    });
    h += esc(t.slice(i)) + '​';
    interior.innerHTML = h;
  }

  function actualizarContador() {
    const c = opciones.contador; if (!c) return;
    if (!activa) { c.textContent = ''; return; }
    const n = (t) => errores.filter((e) => e.tipo === t).length;
    const o = n('orto'), g = n('gram'), s = n('estilo'), p = n('tipo');
    const partes = [o && `${o} ortografía`, g && `${g} gramática`, s && `${s} estilo`, p && `${p} puntuación`].filter(Boolean);
    const revisando = opc.gramatica && gram.falta > 0 ? (gram.aviso ? `gramática: ${gram.aviso}` : 'revisando gramática…') : '';
    c.textContent = !listo ? 'cargando…' : [partes.length ? partes.join(' · ') : 'sin errores', revisando].filter(Boolean).join(' · ');
    c.dataset.estado = o + g + s + p ? 'hay' : 'ok';
  }

  function sugerir(palabra) {
    return new Promise((ok) => {
      if (!worker) return ok([]);
      const id = ++nId; pendientes.set(id, ok);
      worker.postMessage({ tipo: 'sugerir', id, palabra });
      setTimeout(() => { if (pendientes.has(id)) { pendientes.delete(id); ok([]); } }, 4000);
    });
  }

  // ---------------------------------------------------------- cambios en el texto
  function reemplazar(ini, fin, nuevo) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ini, fin);
    if (!document.execCommand || !document.execCommand('insertText', false, nuevo)) {
      ta.setRangeText(nuevo, ini, fin, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Reemplaza muchos tramos en un solo paso (un solo «deshacer»)
  function reemplazarVarios(cambios) {
    if (!cambios.length) return;
    cambios.sort((a, b) => a.ini - b.ini);
    const t = ta.value; let out = '', i = 0;
    for (const c of cambios) { if (c.ini < i) continue; out += t.slice(i, c.ini) + c.nuevo; i = c.fin; }
    out += t.slice(i);
    ta.focus({ preventScroll: true }); ta.setSelectionRange(0, t.length);
    if (!document.execCommand || !document.execCommand('insertText', false, out)) {
      ta.value = out; ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ta.setSelectionRange(0, 0);
  }

  // ---------------------------------------------------------- menú sobre la palabra
  function alTocar() {
    if (!activa || revisado !== version || ta.readOnly) return;
    const p = ta.selectionStart;
    if (p !== ta.selectionEnd) return;
    const k = errores.findIndex((e) => p >= e.ini && p <= e.fin);
    if (k < 0) { cerrarPopup(); return; }
    abrirPopup(k);
  }

  async function abrirPopup(k) {
    const e = errores[k];
    const m = interior.querySelector(`mark[data-i="${k}"]`);
    interior.querySelectorAll('mark.activa').forEach((x) => x.classList.remove('activa'));
    if (m) m.classList.add('activa');
    popup.innerHTML = '';
    const cab = document.createElement('div'); cab.className = 'orto-cab';
    popup.appendChild(cab);
    const botones = document.createElement('div'); botones.className = 'orto-botones';
    popup.appendChild(botones);
    const boton = (texto, fn, clase = '') => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = texto; b.className = clase; b.setAttribute('role', 'menuitem');
      b.onclick = () => { cerrarPopup(); fn(); }; botones.appendChild(b); return b;
    };
    if (e.tipo === 'orto') {
      cab.textContent = `«${e.palabra}» no está en el diccionario`;
      const cargando = document.createElement('span'); cargando.className = 'orto-nota'; cargando.textContent = 'Buscando sugerencias…';
      botones.appendChild(cargando);
      colocar(m);
      const sug = await sugerir(e.palabra);
      if (popup.hidden || errores[k] !== e) return;
      cargando.remove();
      if (!sug.length) { const n = document.createElement('span'); n.className = 'orto-nota'; n.textContent = 'Sin sugerencias'; botones.appendChild(n); }
      sug.forEach((s) => boton(s, () => reemplazar(e.ini, e.fin, s), 'orto-sug'));
      const sep = document.createElement('hr'); botones.appendChild(sep);
      const iguales = errores.filter((x) => x.tipo === 'orto' && x.palabra === e.palabra).length;
      if (sug[0] && iguales > 1) boton(`Cambiar las ${iguales} por «${sug[0]}»`, () => cambiarTodas(e.palabra, sug[0]));
      boton('Agregar al diccionario', () => agregarPalabra(e.palabra));
      boton(iguales > 1 ? `Ignorar (${iguales})` : 'Ignorar', () => ignorar(e.palabra));
    } else if (e.tipo === 'gram' || e.tipo === 'estilo') {
      cab.textContent = e.mensaje;
      if (!e.sugerencias.length) { const n = document.createElement('span'); n.className = 'orto-nota'; n.textContent = 'Sin sugerencias: revisalo a mano'; botones.appendChild(n); }
      e.sugerencias.forEach((s) => boton(s === '' ? '(borrar)' : s, () => reemplazar(e.ini, e.fin, s), 'orto-sug'));
      const sep = document.createElement('hr'); botones.appendChild(sep);
      boton('Ignorar', () => { ignoradasGram.add(`${e.regla}|${e.original}`); mezclar(); });
      boton('No marcar más este tipo de error', () => apagarRegla(e.regla, e.descripcion || e.mensaje));
      if (e.descripcion) { const d = document.createElement('span'); d.className = 'orto-nota'; d.textContent = `Regla: ${e.descripcion}`; botones.appendChild(d); }
    } else {
      cab.textContent = e.mensaje;
      const antes = e.original.replace(/ /g, '·'), despues = e.arreglo.replace(/ /g, '·');
      boton(`Corregir: «${antes}» → «${despues}»`, () => reemplazar(e.ini, e.fin, e.arreglo), 'orto-sug');
      const iguales = errores.filter((x) => x.tipo === 'tipo' && x.mensaje === e.mensaje);
      if (iguales.length > 1) boton(`Corregir las ${iguales.length} iguales`, () => reemplazarVarios(iguales.map((x) => ({ ini: x.ini, fin: x.fin, nuevo: x.arreglo }))));
      boton('Dejar como está', () => { base = base.filter((x) => x !== e); errores.splice(k, 1); pintar(); actualizarContador(); });
    }
    colocar(m);
  }

  function colocar(m) {
    popup.hidden = false;
    const r = (m || ta).getBoundingClientRect();
    const w = popup.offsetWidth, h = popup.offsetHeight;
    let x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let y = r.bottom + 6;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
    y = Math.min(Math.max(8, y), window.innerHeight - h - 8);
    popup.style.left = x + 'px'; popup.style.top = y + 'px';
  }

  function cerrarPopup() {
    if (popup && !popup.hidden) { popup.hidden = true; interior.querySelectorAll('mark.activa').forEach((x) => x.classList.remove('activa')); }
  }

  function cambiarTodas(palabra, nueva) {
    reemplazarVarios(errores.filter((x) => x.tipo === 'orto' && x.palabra === palabra).map((x) => ({ ini: x.ini, fin: x.fin, nuevo: nueva })));
  }

  function ignorar(palabra) {
    ignoradas.add(palabra);
    worker && worker.postMessage({ tipo: 'agregar', palabras: [palabra] });
    base = base.filter((x) => !(x.tipo === 'orto' && x.palabra === palabra));
    mezclar();
  }

  function apagarRegla(regla, descripcion) {
    if (!regla) return;
    apagadas.set(regla, descripcion); guardarJSON('reglas-apagadas', [...apagadas]);
    mezclar();
    opciones.aviso && opciones.aviso('Listo: ese tipo de error no se marca más (se puede volver a activar en Opciones de revisión).', 4500);
  }

  async function agregarPalabra(palabra) {
    try {
      await opciones.alAgregarPalabra(palabra);
      worker && worker.postMessage({ tipo: 'agregar', palabras: [palabra] });
      base = base.filter((x) => !(x.tipo === 'orto' && x.palabra === palabra));
      mezclar();
      opciones.aviso && opciones.aviso(`«${palabra}» quedó en el diccionario de la colección`);
    } catch (err) { opciones.aviso && opciones.aviso(err.message || 'No se pudo agregar la palabra', 5000); }
  }

  // ---------------------------------------------------------- panel «Revisar»
  async function abrirPanel(dlg, lista) {
    if (!worker) { opciones.aviso && opciones.aviso('El corrector no pudo cargarse en este navegador.'); return; }
    if (!activa) activar(true), opciones.interruptor && (opciones.interruptor.checked = true);
    dlg.showModal();
    lista.innerHTML = '<p class="ayuda">Revisando…</p>';
    // esperar la revisión al día
    const t0 = Date.now();
    while ((revisado !== version || !listo) && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 150));
    llenarPanel(dlg, lista);
    // la gramática llega de a partes: se actualiza el panel mientras avanza
    clearInterval(abrirPanel.t);
    if (opc.gramatica && gram.falta > 0) {
      gramProgramar(0);
      let antes = gram.falta;
      abrirPanel.t = setInterval(() => {
        if (!dlg.open) { clearInterval(abrirPanel.t); return; }
        if (gram.falta !== antes) { antes = gram.falta; llenarPanel(dlg, lista); }
        if (!gram.falta) clearInterval(abrirPanel.t);
      }, 1500);
    }
  }

  async function llenarPanel(dlg, lista) {
    const orto = new Map(), tipo = new Map(), gramat = new Map();
    for (const e of errores) {
      const g = e.tipo === 'orto' ? orto : e.tipo === 'tipo' ? tipo : gramat;
      const k = e.tipo === 'orto' ? e.palabra : e.mensaje;
      if (!g.has(k)) g.set(k, []); g.get(k).push(e);
    }
    lista.innerHTML = '';
    if (opc.gramatica && gram.total) {
      const p = document.createElement('p'); p.className = 'ayuda';
      p.textContent = gram.falta ? `Gramática: ${gram.total - gram.falta} de ${gram.total} párrafos revisados${gram.aviso ? ` (${gram.aviso})` : '…'}` : 'Gramática y estilo: capítulo revisado.';
      lista.appendChild(p);
    }
    if (!orto.size && !tipo.size && !gramat.size) { const p = document.createElement('p'); p.className = 'orto-ok'; p.textContent = 'No se encontraron errores en este capítulo.'; lista.appendChild(p); return; }
    const seccion = (titulo, n) => { const h = document.createElement('h3'); h.textContent = `${titulo} (${n})`; lista.appendChild(h); const ol = document.createElement('ol'); ol.className = 'lista'; lista.appendChild(ol); return ol; };
    const ir = (e) => { dlg.close(); ta.focus({ preventScroll: true }); ta.setSelectionRange(e.ini, e.fin); const k = errores.indexOf(e); const m = interior.querySelector(`mark[data-i="${k}"]`); if (m) { const off = m.offsetTop - ta.clientHeight / 3; ta.scrollTop = Math.max(0, off); } };
    const btn = (padre, texto, fn, clase = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = texto; b.className = clase; b.onclick = fn; padre.appendChild(b); return b; };
    const recargar = () => setTimeout(() => abrirPanel(dlg, lista), 200);

    if (tipo.size) {
      const ol = seccion('Puntuación y tipografía', [...tipo.values()].reduce((s, x) => s + x.length, 0));
      const todos = [...tipo.values()].flat();
      const li0 = document.createElement('li');
      btn(li0, `Corregir todo (${todos.length})`, () => { reemplazarVarios(todos.map((x) => ({ ini: x.ini, fin: x.fin, nuevo: x.arreglo }))); recargar(); }, 'primario');
      ol.appendChild(li0);
      for (const [msg, es] of tipo) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="que">${esc(msg)}${es.length > 1 ? ` <span class="cuando">×${es.length}</span>` : ''}</span>`;
        const der = document.createElement('div'); der.className = 'der';
        btn(der, 'Ver', () => ir(es[0]));
        btn(der, es.length > 1 ? 'Corregir todas' : 'Corregir', () => { reemplazarVarios(es.map((x) => ({ ini: x.ini, fin: x.fin, nuevo: x.arreglo }))); recargar(); });
        li.appendChild(der); ol.appendChild(li);
      }
    }
    if (gramat.size) {
      const ol = seccion('Gramática y estilo', [...gramat.values()].reduce((s, x) => s + x.length, 0));
      for (const [msg, es] of gramat) {
        const li = document.createElement('li');
        const ej = es.slice(0, 3).map((x) => `«${esc(x.original)}»`).join(', ');
        li.innerHTML = `<span class="que"><span class="gram-tipo ${es[0].tipo}">${es[0].tipo === 'estilo' ? 'Estilo' : 'Gramática'}</span> ${esc(msg)}${es.length > 1 ? ` <span class="cuando">×${es.length}</span>` : ''}<br><span class="cuando">${ej}</span></span>`;
        const der = document.createElement('div'); der.className = 'der';
        btn(der, 'Ver', () => ir(es[0]));
        const s0 = es[0].sugerencias[0];
        const misma = s0 !== undefined && es.every((x) => x.sugerencias[0] === s0 && x.original === es[0].original);
        if (misma) btn(der, `${es.length > 1 ? 'Cambiar todas' : 'Cambiar'} por «${s0 || '(nada)'}»`, () => { reemplazarVarios(es.map((x) => ({ ini: x.ini, fin: x.fin, nuevo: s0 }))); recargar(); });
        btn(der, 'No marcar más', () => { apagarRegla(es[0].regla, es[0].descripcion || msg); li.remove(); });
        li.appendChild(der); ol.appendChild(li);
      }
    }
    if (orto.size) {
      const ol = seccion('Palabras que no están en el diccionario', orto.size);
      for (const [palabra, es] of orto) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="quien">${esc(palabra)}</span>${es.length > 1 ? `<span class="cuando">×${es.length}</span>` : ''}`;
        const sug = document.createElement('span'); sug.className = 'orto-sugs'; sug.textContent = '…'; li.appendChild(sug);
        const der = document.createElement('div'); der.className = 'der';
        btn(der, 'Ver', () => ir(es[0]));
        btn(der, 'Agregar', async () => { await agregarPalabra(palabra); li.remove(); });
        btn(der, 'Ignorar', () => { ignorar(palabra); li.remove(); });
        li.appendChild(der); ol.appendChild(li);
        sugerir(palabra).then((s) => {
          sug.textContent = '';
          if (!s.length) { sug.textContent = 'sin sugerencias'; return; }
          s.slice(0, 3).forEach((x) => btn(sug, `→ ${x}`, () => { cambiarTodas(palabra, x); recargar(); }, 'orto-sug'));
        });
      }
    }
    const nota = document.createElement('p'); nota.className = 'ayuda';
    nota.textContent = 'Las palabras en cursiva (términos en otro idioma), las direcciones web y las marcas de bloque no se revisan. «Agregar» suma la palabra al diccionario de la colección, para todo el equipo. La gramática la revisa LanguageTool: es una ayuda, no una regla; ante la duda, manda el criterio del equipo.';
    lista.appendChild(nota);
  }

  // ---------------------------------------------------------- Opciones de revisión
  function abrirOpciones(dlg, cuerpo, palabrasDiccionario = 0) {
    const fila = (clave, titulo, ayuda) => `<label class="opc"><input type="checkbox" data-opc="${clave}" ${clave === 'activa' ? (activa ? 'checked' : '') : (opc[clave] ? 'checked' : '')}>
      <span><b>${titulo}</b><br><span class="ayuda">${ayuda}</span></span></label>`;
    const reglas = [...apagadas].map(([id, d]) => `<li><span class="que">${esc(d)} <span class="cuando">${esc(id)}</span></span><div class="der"><button type="button" data-activar="${esc(id)}">Volver a marcar</button></div></li>`).join('');
    cuerpo.innerHTML = `
      <h3>Ortografía</h3>
      ${fila('activa', 'Revisar mientras escribo', 'Subraya en rojo las palabras que no están en el diccionario. Tocando la palabra aparecen sugerencias.')}
      ${fila('repetidas', 'Marcar palabras repetidas', '«de de», «la la»… (salvo las que están en el diccionario de la colección, como «neti neti»).')}
      <p class="ayuda opc-fija">✓ Siempre se ignoran las direcciones web y de correo, las marcas de bloque y lo que está en cursiva (términos en otro idioma).</p>
      <p class="ayuda opc-fija">Diccionario de la colección: ${palabrasDiccionario} palabras propias, compartidas por todo el equipo.</p>
      <h3>Gramática y estilo</h3>
      ${fila('gramatica', 'Revisar la gramática mientras escribo', 'Concordancia, tiempos verbales, tildes diacríticas (él/el, más/mas), puntuación. Doble subrayado azul.')}
      ${fila('confusas', 'Palabras que suelen confundirse', 'haber / a ver, sino / si no, porque / por qué, echo / hecho…')}
      ${fila('estilo', 'Sugerencias de estilo', 'Redundancias, muletillas, repeticiones cercanas y frases muy largas. Subrayado de puntos dorados. Marca más cosas: conviene para una última pasada.')}
      ${fila('puntuacion', 'Puntuación y tipografía', 'Espacios antes de signos, puntos suspensivos, rayas en los incisos, espacios dobles. Puntos azules.')}
      ${apagadas.size ? `<h3>Tipos de error que pediste no marcar</h3><ol class="lista">${reglas}</ol>` : ''}
      <p class="ayuda" style="margin-top:14px">La gramática la revisa <a href="https://languagetool.org/es" target="_blank" rel="noopener">LanguageTool</a>: se le envía cada párrafo para revisarlo. Estas opciones se recuerdan en este navegador.</p>`;
    cuerpo.querySelectorAll('[data-opc]').forEach((chk) => chk.onchange = () => {
      const k = chk.dataset.opc;
      if (k === 'activa') { activar(chk.checked); opciones.interruptor && (opciones.interruptor.checked = chk.checked); return; }
      opc[k] = chk.checked; guardarJSON('revision-opciones', opc);
      if (k === 'repetidas' || k === 'puntuacion') programar(0);
      else { mezclar(); gramProgramar(300); }
    });
    cuerpo.querySelectorAll('[data-activar]').forEach((b) => b.onclick = () => {
      apagadas.delete(b.dataset.activar); guardarJSON('reglas-apagadas', [...apagadas]);
      b.closest('li').remove(); gramProgramar(300); mezclar();
    });
    if (!dlg.open) dlg.showModal();
  }

  window.Ortografia = { iniciar, abrirOpciones, diccionario, textoCambio, abrirPanel, activar, cerrarPopup, _estado: () => ({ version, revisado, listo, activa, errores: errores.length }) };
})();
