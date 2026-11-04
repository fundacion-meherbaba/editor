// Revisión y aprobación de cambios.
// Compara la versión publicada (aprobada) con el borrador (lo que guardan los
// colaboradores), párrafo por párrafo; muestra quién hizo cada cambio y permite
// a quien publica aprobarlos o rechazarlos todos juntos o de a uno.
'use strict';

(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fecha = (f) => (f ? new Date(f).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '');

  // ---------------------------------------------------------- comparación
  const bloques = (t) => String(t || '').replace(/\r/g, '').split(/\n[ \t]*\n+/).map((b) => b.replace(/^\n+|\s+$/g, '')).filter((b) => b.trim());
  const unir = (bs) => (bs.length ? bs.join('\n\n') + '\n' : '');

  // Diferencias entre dos listas (subsecuencia común más larga)
  function lcs(a, b) {
    let ini = 0;
    while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
    let fa = a.length, fb = b.length;
    while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) { fa--; fb--; }
    const A = a.slice(ini, fa), B = b.slice(ini, fb), n = A.length, m = B.length;
    const ops = [];
    for (let i = 0; i < ini; i++) ops.push(['=', i, i]);
    if (n * m > 4e6) {                       // demasiado grande: un solo bloque de cambio
      for (let i = 0; i < n; i++) ops.push(['-', ini + i, null]);
      for (let j = 0; j < m; j++) ops.push(['+', null, ini + j]);
    } else {
      const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) { ops.push(['=', ini + i, ini + j]); i++; j++; }
        else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', ini + i, null]); i++; }
        else { ops.push(['+', null, ini + j]); j++; }
      }
    }
    for (let k = 0; k < a.length - fa; k++) ops.push(['=', fa + k, fb + k]);
    return ops;
  }

  // Agrupa en «cambios»: tramos seguidos de párrafos quitados/agregados/modificados
  function cambios(pub, bor) {
    const A = bloques(pub), B = bloques(bor);
    const ops = lcs(A, B);
    const out = [];
    let ai = 0, bi = 0, actual = null;
    for (const [t] of ops) {
      if (t === '=') { if (actual) { out.push(actual); actual = null; } ai++; bi++; continue; }
      if (!actual) actual = { a0: ai, a1: ai, b0: bi, b1: bi };
      if (t === '-') { ai++; actual.a1 = ai; } else { bi++; actual.b1 = bi; }
    }
    if (actual) out.push(actual);
    return { A, B, cambios: out.map((c) => ({ ...c, quitados: A.slice(c.a0, c.a1), agregados: B.slice(c.b0, c.b1) })) };
  }

  // Diferencia palabra por palabra dentro de un cambio (para mostrar)
  function difPalabras(viejo, nuevo) {
    const tok = (t) => t.match(/\s+|[^\s]+/g) || [];
    const a = tok(viejo), b = tok(nuevo);
    if (a.length * b.length > 2.5e6) return `<del>${esc(viejo)}</del><ins>${esc(nuevo)}</ins>`;
    const ops = lcs(a, b);
    let h = '', modo = null, buf = '';
    const volcar = () => { if (buf) h += modo === '=' ? esc(buf) : modo === '-' ? `<del>${esc(buf)}</del>` : `<ins>${esc(buf)}</ins>`; buf = ''; };
    for (const [t, i, j] of ops) {
      if (t !== modo) { volcar(); modo = t; }
      buf += t === '+' ? b[j] : a[i];
    }
    volcar();
    return h;
  }

  // Quién hizo cada cambio, mirando las versiones guardadas en el borrador
  function autoria(c, versiones) {
    if (!versiones.length) return [];
    const conjuntos = versiones.map((v) => new Set(bloques(v.texto)));
    const quienes = new Map();
    const anotar = (v) => { if (v) quienes.set(v.autor + '|' + v.sha, v); };
    for (const b of c.agregados) {
      let j = -1;
      while (j + 1 < conjuntos.length && conjuntos[j + 1].has(b)) j++;
      anotar(versiones[Math.max(0, j)]);
    }
    for (const d of c.quitados) {
      const j = conjuntos.findIndex((s) => s.has(d));
      anotar(versiones[j > 0 ? j - 1 : (j === 0 ? 0 : versiones.length - 1)]);
    }
    // una persona puede figurar en varios guardados: se muestra una vez, con la fecha más reciente
    const porAutor = new Map();
    for (const v of quienes.values()) { const x = porAutor.get(v.autor); if (!x || x.fecha < v.fecha) porAutor.set(v.autor, v); }
    return [...porAutor.values()].sort((x, y) => (x.fecha < y.fecha ? 1 : -1));
  }

  // ---------------------------------------------------------- interfaz
  let O; // opciones del editor: api, aviso, usuario, libro(), alCambiarCapitulo
  let dlg, cuerpo;

  function iniciar(o) {
    O = o; dlg = o.dialogo; cuerpo = o.cuerpo;
  }

  async function abrir() {
    if (!dlg.open) dlg.showModal();
    await lista();
  }

  async function lista() {
    const libro = O.libro();
    cuerpo.innerHTML = '<p class="ayuda">Buscando cambios…</p>';
    let pend;
    try { pend = await O.api(`/api/pendientes?libro=${encodeURIComponent(libro.id)}`); }
    catch (e) { cuerpo.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    O.alActualizarPendientes && O.alActualizarPendientes(pend);
    const pub = O.usuario().publicador;
    cuerpo.innerHTML = '';
    const intro = document.createElement('p'); intro.className = 'ayuda';
    intro.textContent = pend.length
      ? (pub ? 'Estos capítulos tienen cambios guardados que todavía no están en la versión publicada. Revisá cada uno y aprobá o rechazá sus cambios.'
             : 'Estos capítulos tienen cambios guardados que esperan la aprobación de quien publica.')
      : 'No hay cambios pendientes: la versión publicada está al día con todo lo guardado.';
    cuerpo.appendChild(intro);
    if (!pend.length) return;
    if (pub) {
      const b = document.createElement('button'); b.className = 'primario'; b.textContent = `Aprobar todo (${pend.length} capítulo${pend.length > 1 ? 's' : ''})`;
      b.onclick = () => aprobarTodo(pend, b);
      cuerpo.appendChild(b);
    }
    const ol = document.createElement('ol'); ol.className = 'lista';
    for (const p of pend) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="quien">${esc(p.titulo)}</span>${p.nuevo ? '<span class="chip va">capítulo nuevo</span>' : ''}
        <span class="cuando">${esc(fecha(p.fecha))}</span>
        <span class="que">${p.autores.map((a) => `<span class="chip autor">${esc(a)}</span>`).join(' ')} <span class="cuando">${p.guardados} guardado${p.guardados === 1 ? '' : 's'}</span></span>`;
      const der = document.createElement('div'); der.className = 'der';
      const b = document.createElement('button'); b.textContent = pub ? 'Revisar' : 'Ver cambios'; b.onclick = () => capitulo(p.ruta, p.titulo);
      der.appendChild(b); li.appendChild(der); ol.appendChild(li);
    }
    cuerpo.appendChild(ol);
  }

  async function aprobarTodo(pend, boton) {
    if (!confirm(`¿Aprobar todos los cambios de ${pend.length} capítulo(s)? Pasan a la versión publicada.`)) return;
    boton.disabled = true;
    let hechos = 0;
    for (const p of pend) {
      boton.textContent = `Aprobando ${++hechos} de ${pend.length}…`;
      try {
        const r = await O.api(`/api/revision?ruta=${encodeURIComponent(p.ruta)}`);
        await O.api('/api/aprobar', { metodo: 'POST', cuerpo: { ruta: p.ruta, texto: r.borrador.texto, sha: r.publicado.sha, mensaje: `${p.titulo} (todos los cambios)` } });
      } catch (e) { O.aviso(`${p.titulo}: ${e.message}`, 6000); }
    }
    O.aviso('Cambios aprobados');
    lista();
  }

  async function capitulo(ruta, titulo) {
    cuerpo.innerHTML = '<p class="ayuda">Cargando cambios…</p>';
    let r;
    try { r = await O.api(`/api/revision?ruta=${encodeURIComponent(ruta)}`); }
    catch (e) { cuerpo.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    const pub = O.usuario().publicador;
    const { A, B, cambios: cs } = cambios(r.publicado.texto, r.borrador.texto);
    cuerpo.innerHTML = '';
    const volver = document.createElement('button'); volver.className = 'link'; volver.textContent = '← Todos los capítulos'; volver.onclick = lista;
    cuerpo.appendChild(volver);
    const h = document.createElement('h3'); h.className = 'rev-titulo'; h.textContent = titulo; cuerpo.appendChild(h);
    if (!cs.length) {
      const p = document.createElement('p'); p.className = 'orto-ok'; p.textContent = 'Este capítulo no tiene cambios pendientes.'; cuerpo.appendChild(p); return;
    }
    const resumen = document.createElement('div'); resumen.className = 'rev-resumen';
    resumen.innerHTML = `<span>${cs.length} cambio${cs.length > 1 ? 's' : ''} sin aprobar</span>`;
    if (pub) {
      const ap = document.createElement('button'); ap.className = 'primario'; ap.textContent = 'Aprobar todos';
      ap.onclick = () => accion('aprobar', ruta, titulo, r, r.borrador.texto, 'todos los cambios');
      const re = document.createElement('button'); re.className = 'peligro'; re.textContent = 'Rechazar todos';
      re.onclick = () => { if (confirm('¿Rechazar todos los cambios de este capítulo? El borrador vuelve a la versión publicada (los cambios quedan en el historial).')) accion('rechazar', ruta, titulo, r, r.publicado.texto, 'todos los cambios'); };
      resumen.append(ap, re);
    }
    cuerpo.appendChild(resumen);
    const leyenda = document.createElement('p'); leyenda.className = 'ayuda';
    leyenda.innerHTML = '<del>tachado</del> = se quita · <ins>subrayado</ins> = se agrega';
    cuerpo.appendChild(leyenda);

    cs.forEach((c, k) => {
      const card = document.createElement('article'); card.className = 'rev-cambio';
      const quienes = autoria(c, r.versiones);
      const tipo = !c.quitados.length ? 'Agregado' : !c.agregados.length ? 'Quitado' : 'Modificado';
      card.innerHTML = `<header><span class="chip">${tipo}</span>${quienes.map((v) => `<span class="chip autor">${esc(v.autor)}</span><span class="cuando">${esc(fecha(v.fecha))}</span>`).join(' ')}
        ${quienes[0]?.mensaje && !/^Corrección en /.test(quienes[0].mensaje) ? `<span class="rev-nota">«${esc(quienes[0].mensaje.replace(/^[^:]*·[^:]*:\s*/, ''))}»</span>` : ''}</header>`;
      const dif = document.createElement('div'); dif.className = 'rev-dif';
      if (c.quitados.length && c.agregados.length) dif.innerHTML = difPalabras(c.quitados.join('\n\n'), c.agregados.join('\n\n'));
      else if (c.quitados.length) dif.innerHTML = `<del>${esc(c.quitados.join('\n\n'))}</del>`;
      else dif.innerHTML = `<ins>${esc(c.agregados.join('\n\n'))}</ins>`;
      card.appendChild(dif);
      if (pub) {
        const pie = document.createElement('footer');
        const ap = document.createElement('button'); ap.className = 'primario'; ap.textContent = 'Aprobar';
        ap.onclick = () => {
          // lo publicado + solo este cambio
          const nuevo = [...A.slice(0, c.a0), ...c.agregados, ...A.slice(c.a1)];
          accion('aprobar', ruta, titulo, r, unir(nuevo), `cambio ${k + 1} de ${cs.length}`);
        };
        const re = document.createElement('button'); re.textContent = 'Rechazar';
        re.onclick = () => {
          // el borrador sin este cambio
          const nuevo = [...B.slice(0, c.b0), ...c.quitados, ...B.slice(c.b1)];
          accion('rechazar', ruta, titulo, r, unir(nuevo), `cambio ${k + 1} de ${cs.length}`);
        };
        pie.append(ap, re); card.appendChild(pie);
      }
      cuerpo.appendChild(card);
    });
    if (!pub) {
      const n = document.createElement('p'); n.className = 'ayuda'; n.textContent = 'Solo quien publica puede aprobar o rechazar cambios.'; cuerpo.appendChild(n);
    }
  }

  async function accion(tipo, ruta, titulo, r, texto, que) {
    const sha = tipo === 'aprobar' ? r.publicado.sha : r.borrador.sha;
    try {
      await O.api(`/api/${tipo}`, { metodo: 'POST', cuerpo: { ruta, texto, sha, mensaje: `${titulo} (${que})` } });
      O.aviso(tipo === 'aprobar' ? 'Aprobado: ya está en la versión publicada' : 'Rechazado: el borrador volvió a como estaba');
      if (tipo === 'rechazar' && O.alCambiarCapitulo) O.alCambiarCapitulo(ruta);
    } catch (e) {
      O.aviso(e.status === 409 ? 'Alguien cambió este capítulo recién: se recargó la comparación.' : e.message, 5000);
    }
    capitulo(ruta, titulo);
  }

  window.Revision = { iniciar, abrir, cambios, bloques, unir, autoria, difPalabras };
})();
