// Comentarios del equipo sobre el texto, como en Word o Google Docs.
// - Se selecciona un tramo y se toca «Comentar» (o Ctrl/⌘ + Alt + M).
// - El tramo comentado queda resaltado en amarillo; el panel «Comentarios» los lista en orden,
//   con respuestas, «Resolver» y «Reabrir».
// - Se guardan aparte del texto (libros/<libro>/comentarios/<capítulo>.json), así no pasan por
//   la aprobación ni se imprimen. Cada comentario recuerda el texto citado y lo que lo rodea, para
//   volver a encontrarlo aunque el capítulo cambie.
'use strict';

(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let o, ta, capa, interior, panel, lista, filtro;
  let ruta = null;
  let comentarios = [];
  let ubicados = new Map();     // id → { ini, fin } en el texto actual (o null si no se encontró)
  let tPintar, tRefrescar;
  let activo = null;            // id del comentario elegido
  let nuevo = null;             // { ini, fin, cita, antes, despues } mientras se escribe uno nuevo
  const CONTEXTO = 40;

  function iniciar(opciones) {
    o = opciones; ta = o.textarea;
    // Capa de resaltado detrás del texto (comparte la envoltura con la ortografía)
    const env = ta.parentNode;
    capa = document.createElement('div'); capa.className = 'marcas marcas-com'; capa.setAttribute('aria-hidden', 'true');
    interior = document.createElement('div'); interior.className = 'marcas-int';
    capa.appendChild(interior);
    env.insertBefore(capa, env.firstChild);
    const ajustar = () => {
      capa.style.width = ta.clientWidth + 'px'; capa.style.height = ta.clientHeight + 'px';
      interior.style.transform = `translateY(${-ta.scrollTop}px)`;
    };
    new ResizeObserver(ajustar).observe(ta);
    ta.addEventListener('scroll', () => { interior.style.transform = `translateY(${-ta.scrollTop}px)`; }, { passive: true });
    ta.addEventListener('input', () => { pintarPlano(); clearTimeout(tPintar); tPintar = setTimeout(ubicarYPintar, 350); });
    ta.addEventListener('click', alTocar);
    ta.addEventListener('keyup', (e) => { if ((e.key || '').startsWith('Arrow')) alTocar(); });
    ajustar();

    // Panel lateral, a la derecha del texto
    panel = o.panel; lista = panel.querySelector('.com-lista'); filtro = panel.querySelector('.com-filtro');
    filtro.onchange = () => { try { localStorage.setItem('comentarios-filtro', filtro.value); } catch { /* nada */ } dibujar(); };
    try { filtro.value = localStorage.getItem('comentarios-filtro') || 'abiertos'; } catch { /* nada */ }
    panel.querySelector('.com-cerrar').onclick = () => mostrarPanel(false);
    o.botonPanel.onclick = () => mostrarPanel(panel.hidden);
    o.botonComentar.onclick = () => comentarSeleccion();
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) { e.preventDefault(); comentarSeleccion(); }
    });
    // Comentarios de otras personas: se refrescan cada minuto y al volver a la pestaña
    setInterval(() => { if (!document.hidden) refrescar(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refrescar(); });
  }

  function mostrarPanel(si) {
    panel.hidden = !si;
    o.botonPanel.setAttribute('aria-pressed', si ? 'true' : 'false');
    if (si) { refrescar(); dibujar(); }
  }

  // ---------------------------------------------------------- datos
  async function cargar(r) {
    ruta = r; comentarios = []; activo = null; nuevo = null;
    ubicarYPintar(); dibujar();
    if (!r) return;
    try { comentarios = (await o.api(`/api/comentarios?ruta=${encodeURIComponent(r)}`)).comentarios || []; }
    catch (e) { o.aviso && o.aviso('No se pudieron cargar los comentarios: ' + e.message, 4000); }
    if (ruta !== r) return;
    ubicarYPintar(); dibujar();
  }

  async function refrescar() {
    if (!ruta || nuevo) return;
    clearTimeout(tRefrescar);
    tRefrescar = setTimeout(async () => {
      const r = ruta;
      try {
        const d = await o.api(`/api/comentarios?ruta=${encodeURIComponent(r)}`);
        if (r !== ruta || JSON.stringify(d.comentarios) === JSON.stringify(comentarios)) return;
        comentarios = d.comentarios || []; ubicarYPintar(); dibujar();
      } catch { /* sin conexión: se reintenta en el próximo minuto */ }
    }, 200);
  }

  async function enviar(cuerpo) {
    try {
      const d = await o.api('/api/comentarios', { metodo: 'POST', cuerpo: { ruta, ...cuerpo } });
      comentarios = d.comentarios || []; ubicarYPintar(); dibujar();
      return true;
    } catch (e) {
      if (e.datos?.comentarios) { comentarios = e.datos.comentarios; ubicarYPintar(); dibujar(); }
      o.aviso && o.aviso(e.message, 5000);
      return false;
    }
  }

  // ---------------------------------------------------------- ubicar en el texto
  // Busca la cita en el texto actual; si aparece varias veces, gana la que tiene alrededor el
  // mismo texto que cuando se comentó (y, a igualdad, la más cercana a donde estaba).
  function ubicar(c, t) {
    if (!c.cita) return null;
    const cand = []; let i = t.indexOf(c.cita);
    while (i >= 0 && cand.length < 400) { cand.push(i); i = t.indexOf(c.cita, i + 1); }
    if (!cand.length) return null;
    const comun = (a, b, desdeElFinal) => {
      let n = 0; const L = Math.min(a.length, b.length);
      while (n < L && (desdeElFinal ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
      return n;
    };
    let mejor = null, puntaje = -1;
    for (const k of cand) {
      const p = comun(t.slice(Math.max(0, k - CONTEXTO), k), c.antes || '', true) + comun(t.slice(k + c.cita.length, k + c.cita.length + CONTEXTO), c.despues || '', false);
      const cerca = Number.isInteger(c.pos) ? -Math.abs(k - c.pos) / 1e7 : 0;
      if (p + cerca > puntaje) { puntaje = p + cerca; mejor = k; }
    }
    return { ini: mejor, fin: mejor + c.cita.length };
  }

  function ubicarYPintar() {
    const t = ta.value;
    ubicados = new Map(comentarios.map((c) => [c.id, ubicar(c, t)]));
    pintar();
  }

  function pintarPlano() { interior.textContent = ta.value + '​'; }

  function pintar() {
    const t = ta.value;
    const visibles = comentarios.filter((c) => !c.resuelto && ubicados.get(c.id));
    const tramos = visibles.map((c) => ({ ...ubicados.get(c.id), id: c.id }));
    if (nuevo) tramos.push({ ini: nuevo.ini, fin: nuevo.fin, id: '_nuevo' });
    // fronteras: un tramo puede superponerse con otro
    const cortes = new Set([0, t.length]);
    tramos.forEach((r) => { cortes.add(r.ini); cortes.add(r.fin); });
    const xs = [...cortes].sort((a, b) => a - b);
    let h = '';
    for (let k = 0; k < xs.length - 1; k++) {
      const a = xs[k], b = xs[k + 1]; if (a === b) continue;
      const en = tramos.filter((r) => r.ini <= a && r.fin >= b);
      const seg = esc(t.slice(a, b));
      if (!en.length) { h += seg; continue; }
      const act = en.some((r) => r.id === activo || r.id === '_nuevo');
      h += `<mark class="m-com${en.length > 1 ? ' doble' : ''}${act ? ' activa' : ''}">${seg}</mark>`;
    }
    interior.innerHTML = h + '​';
    actualizarContador();
  }

  function actualizarContador() {
    const n = comentarios.filter((c) => !c.resuelto).length;
    o.botonPanel.querySelector('.n').textContent = n ? ` (${n})` : '';
    o.alCambiarCantidad && o.alCambiarCantidad(ruta, n);
  }

  // ---------------------------------------------------------- tocar el texto
  function alTocar() {
    if (ta.selectionStart !== ta.selectionEnd) return;
    const p = ta.selectionStart;
    const c = comentarios.find((x) => !x.resuelto && (() => { const u = ubicados.get(x.id); return u && p >= u.ini && p <= u.fin; })());
    if (!c) { if (activo) { activo = null; pintar(); marcarTarjeta(); } return; }
    activo = c.id; pintar();
    if (panel.hidden) mostrarPanel(true); else marcarTarjeta(true);
  }

  function irA(c) {
    const u = ubicados.get(c.id); if (!u) return;
    activo = c.id; pintar(); marcarTarjeta();
    ta.focus({ preventScroll: true }); ta.setSelectionRange(u.ini, u.fin);
    const m = interior.querySelector('mark.activa');
    if (m) ta.scrollTop = Math.max(0, m.offsetTop - ta.clientHeight / 3);
  }

  function marcarTarjeta(desplazar) {
    lista.querySelectorAll('.com').forEach((el) => el.classList.toggle('activa', el.dataset.id === activo));
    if (desplazar) lista.querySelector(`.com[data-id="${activo}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------------------------------------------------------- comentar
  function comentarSeleccion() {
    if (!ruta) return;
    if (o.soloLectura && o.soloLectura()) { o.aviso && o.aviso('Estás viendo una versión anterior: volvé a la actual para comentar.'); return; }
    let a = ta.selectionStart, b = ta.selectionEnd; const t = ta.value;
    if (a === b) {   // sin selección: la palabra donde está el cursor
      while (a > 0 && /[\p{L}\p{N}’'-]/u.test(t[a - 1])) a--;
      while (b < t.length && /[\p{L}\p{N}’'-]/u.test(t[b])) b++;
    }
    // sin espacios sobrantes en los bordes
    while (a < b && /\s/.test(t[a])) a++;
    while (b > a && /\s/.test(t[b - 1])) b--;
    if (a === b) { o.aviso && o.aviso('Seleccioná el texto que querés comentar.'); return; }
    if (b - a > 1000) b = a + 1000;
    nuevo = { ini: a, fin: b, cita: t.slice(a, b), antes: t.slice(Math.max(0, a - CONTEXTO), a), despues: t.slice(b, b + CONTEXTO) };
    activo = null; pintar();
    mostrarPanel(true);
    setTimeout(() => panel.querySelector('.com-nuevo textarea')?.focus(), 30);
  }

  // ---------------------------------------------------------- panel
  const cuando = (iso) => {
    const d = new Date(iso); if (isNaN(d)) return '';
    const s = (Date.now() - d) / 1000;
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };

  function dibujar() {
    if (!panel || panel.hidden) { actualizarContador(); return; }
    const yo = (o.usuario() || {});
    const mio = (x) => (x.email || '').toLowerCase() === (yo.email || '').toLowerCase();
    const ver = filtro.value;
    let cs = comentarios.filter((c) => ver === 'todos' || (ver === 'resueltos' ? c.resuelto : !c.resuelto));
    cs = cs.sort((a, b) => (ubicados.get(a.id)?.ini ?? 1e12) - (ubicados.get(b.id)?.ini ?? 1e12) || a.fecha.localeCompare(b.fecha));
    let h = '';
    if (nuevo) {
      h += `<div class="com com-nuevo"><blockquote>${esc(recorte(nuevo.cita))}</blockquote>
        <textarea rows="3" placeholder="Escribí tu comentario…" aria-label="Nuevo comentario"></textarea>
        <div class="com-acc"><button type="button" class="primario" data-acc="publicar">Comentar</button><button type="button" data-acc="cancelar">Cancelar</button>
        <span class="ayuda">Ctrl + Enter para publicar</span></div></div>`;
    }
    if (!cs.length && !nuevo) {
      h += `<p class="ayuda com-vacio">${ver === 'abiertos' ? 'No hay comentarios abiertos en este capítulo.' : 'No hay comentarios.'}<br>Seleccioná un tramo del texto y tocá <b>Comentar</b> (o Ctrl/⌘ + Alt + M).</p>`;
    }
    for (const c of cs) {
      const u = ubicados.get(c.id);
      const puedeBorrar = mio(c) || (o.usuario() || {}).publicador;
      h += `<div class="com${c.resuelto ? ' resuelto' : ''}${c.id === activo ? ' activa' : ''}" data-id="${esc(c.id)}">
        <blockquote class="${u ? 'ir' : 'perdido'}" title="${u ? 'Ir al texto' : ''}">${esc(recorte(c.cita))}</blockquote>
        ${u ? '' : '<p class="com-aviso">El texto comentado cambió o ya no está.</p>'}
        <div class="com-cab"><b>${esc(c.autor)}</b> <span class="cuando">${cuando(c.fecha)}${c.editado ? ' · editado' : ''}</span></div>
        <div class="com-texto">${esc(c.texto)}</div>
        ${(c.respuestas || []).map((r) => `<div class="com-resp"><div class="com-cab"><b>${esc(r.autor)}</b> <span class="cuando">${cuando(r.fecha)}</span></div><div class="com-texto">${esc(r.texto)}</div></div>`).join('')}
        ${c.resuelto ? `<p class="com-aviso ok">Resuelto por ${esc(c.resueltoPor || '')} · ${cuando(c.resueltoFecha)}</p>` : ''}
        <div class="com-acc">
          ${c.resuelto ? '<button type="button" data-acc="reabrir">Reabrir</button>' : '<button type="button" data-acc="responder">Responder</button><button type="button" data-acc="resolver" title="Marcar como resuelto: deja de resaltarse">✓ Resolver</button>'}
          ${mio(c) ? '<button type="button" class="link" data-acc="editar">Editar</button>' : ''}
          ${puedeBorrar ? '<button type="button" class="link peligro" data-acc="borrar">Borrar</button>' : ''}
        </div></div>`;
    }
    lista.innerHTML = h;
    actualizarContador();

    // acciones
    const nuevoEl = lista.querySelector('.com-nuevo');
    if (nuevoEl) {
      const txt = nuevoEl.querySelector('textarea');
      const publicar = async () => {
        const t = txt.value.trim(); if (!t) { txt.focus(); return; }
        nuevoEl.querySelectorAll('button').forEach((b) => b.disabled = true);
        const n = nuevo;
        if (await enviar({ accion: 'nuevo', texto: t, cita: n.cita, antes: n.antes, despues: n.despues, pos: n.ini })) { nuevo = null; ubicarYPintar(); dibujar(); }
        else nuevoEl.querySelectorAll('button').forEach((b) => b.disabled = false);
      };
      nuevoEl.querySelector('[data-acc="publicar"]').onclick = publicar;
      nuevoEl.querySelector('[data-acc="cancelar"]').onclick = () => { nuevo = null; pintar(); dibujar(); };
      txt.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); publicar(); } if (e.key === 'Escape') { nuevo = null; pintar(); dibujar(); } };
    }
    lista.querySelectorAll('.com[data-id]').forEach((el) => {
      const c = comentarios.find((x) => x.id === el.dataset.id); if (!c) return;
      el.querySelector('blockquote.ir')?.addEventListener('click', () => irA(c));
      el.querySelectorAll('[data-acc]').forEach((b) => b.onclick = () => accion(c, b.dataset.acc, el));
    });
  }

  const recorte = (t) => (t.length > 180 ? t.slice(0, 120) + ' … ' + t.slice(-40) : t);

  function formulario(el, valor, alEnviar, etiqueta) {
    el.querySelector('.com-form')?.remove();
    const f = document.createElement('div'); f.className = 'com-form';
    f.innerHTML = `<textarea rows="2" aria-label="${etiqueta}">${esc(valor || '')}</textarea>
      <div class="com-acc"><button type="button" class="primario">${etiqueta}</button><button type="button">Cancelar</button></div>`;
    el.appendChild(f);
    const txt = f.querySelector('textarea'); txt.focus();
    const [ok, no] = f.querySelectorAll('button');
    const mandar = async () => { const t = txt.value.trim(); if (!t) return; ok.disabled = true; if (!(await alEnviar(t))) ok.disabled = false; };
    ok.onclick = mandar; no.onclick = () => f.remove();
    txt.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); mandar(); } if (e.key === 'Escape') f.remove(); };
  }

  async function accion(c, acc, el) {
    if (acc === 'responder') return formulario(el, '', (t) => enviar({ accion: 'responder', id: c.id, texto: t }), 'Responder');
    if (acc === 'editar') return formulario(el, c.texto, (t) => enviar({ accion: 'editar', id: c.id, texto: t }), 'Guardar');
    if (acc === 'borrar' && !confirm('¿Borrar este comentario y sus respuestas?')) return;
    await enviar({ accion: acc, id: c.id });
  }

  // El editor avisa cuando cambia el texto sin tipear (abrir versión, recuperar borrador…)
  function textoCambio() { pintarPlano(); clearTimeout(tPintar); tPintar = setTimeout(ubicarYPintar, 50); }

  window.Comentarios = { iniciar, cargar, textoCambio, comentarSeleccion, mostrarPanel };
})();
