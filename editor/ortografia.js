// Corrector ortográfico y tipográfico del editor.
// - Subraya en rojo las palabras que no están en el diccionario y en azul los
//   detalles de puntuación y tipografía.
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

  function guardarPref(v) { try { localStorage.setItem('ortografia', v ? '1' : '0'); } catch { /* nada */ } }
  function leerPref() { try { return localStorage.getItem('ortografia') !== '0'; } catch { return true; } }

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
      errores = d.errores.filter((x) => !(x.tipo === 'orto' && ignoradas.has(x.palabra)));
      revisado = d.id;
      pintar(); actualizarContador();
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
    tRevisar = setTimeout(() => { if (listo) worker.postMessage({ tipo: 'revisar', id: version, texto: ta.value }); }, ms);
  }

  // Llamado por el editor cuando cambia el texto sin que el usuario tipee (abrir capítulo, versión anterior…)
  function textoCambio() { if (!activa) return; pintarPlano(); programar(80); }

  function pintarPlano() {
    if (!activa) return;
    interior.textContent = ta.value + '​';
    errores = [];
  }

  function pintar() {
    const t = ta.value;
    let h = '', i = 0;
    errores.forEach((e, k) => {
      h += esc(t.slice(i, e.ini));
      h += `<mark class="${e.tipo === 'orto' ? 'm-orto' : 'm-tipo'}" data-i="${k}">${esc(t.slice(e.ini, e.fin))}</mark>`;
      i = e.fin;
    });
    h += esc(t.slice(i)) + '​';
    interior.innerHTML = h;
  }

  function actualizarContador() {
    const c = opciones.contador; if (!c) return;
    if (!activa) { c.textContent = ''; return; }
    const o = errores.filter((e) => e.tipo === 'orto').length, p = errores.length - o;
    c.textContent = !listo ? 'cargando…' : (o + p === 0 ? 'sin errores' : [o && `${o} ortografía`, p && `${p} puntuación`].filter(Boolean).join(' · '));
    c.dataset.estado = o + p ? 'hay' : 'ok';
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
    } else {
      cab.textContent = e.mensaje;
      const antes = e.original.replace(/ /g, '·'), despues = e.arreglo.replace(/ /g, '·');
      boton(`Corregir: «${antes}» → «${despues}»`, () => reemplazar(e.ini, e.fin, e.arreglo), 'orto-sug');
      const iguales = errores.filter((x) => x.tipo === 'tipo' && x.mensaje === e.mensaje);
      if (iguales.length > 1) boton(`Corregir las ${iguales.length} iguales`, () => reemplazarVarios(iguales.map((x) => ({ ini: x.ini, fin: x.fin, nuevo: x.arreglo }))));
      boton('Dejar como está', () => { errores.splice(k, 1); pintar(); actualizarContador(); });
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
    errores = errores.filter((x) => !(x.tipo === 'orto' && x.palabra === palabra));
    pintar(); actualizarContador();
  }

  async function agregarPalabra(palabra) {
    try {
      await opciones.alAgregarPalabra(palabra);
      worker && worker.postMessage({ tipo: 'agregar', palabras: [palabra] });
      errores = errores.filter((x) => !(x.tipo === 'orto' && x.palabra === palabra));
      pintar(); actualizarContador();
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
  }

  async function llenarPanel(dlg, lista) {
    const orto = new Map(), tipo = new Map();
    for (const e of errores) {
      const g = e.tipo === 'orto' ? orto : tipo;
      const k = e.tipo === 'orto' ? e.palabra : e.mensaje;
      if (!g.has(k)) g.set(k, []); g.get(k).push(e);
    }
    lista.innerHTML = '';
    if (!orto.size && !tipo.size) { lista.innerHTML = '<p class="orto-ok">No se encontraron errores en este capítulo.</p>'; return; }
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
    nota.textContent = 'Las palabras en cursiva (términos en otro idioma), las direcciones web y las marcas de bloque no se revisan. «Agregar» suma la palabra al diccionario de la colección, para todo el equipo.';
    lista.appendChild(nota);
  }

  window.Ortografia = { iniciar, diccionario, textoCambio, abrirPanel, activar, cerrarPopup, _estado: () => ({ version, revisado, listo, activa, errores: errores.length }) };
})();
