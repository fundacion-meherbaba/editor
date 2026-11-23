// Vista «Original en inglés» del editor: en el panel derecho, en lugar de la página del libro,
// muestra el original párrafo por párrafo, emparejado con el castellano (emparejar.js). El
// párrafo donde está el cursor se resalta y queda a la vista; tocar un párrafo del original
// lleva el cursor a su traducción.
'use strict';
(() => {
  let nuevo = false, ta, caja, api, ruta = null, datos = null, unidades = [], activo = -1, visible = false, numero = 1, tRe;

  function iniciar(op) {
    ({ textarea: ta, contenedor: caja, api } = op);
    const mover = () => { if (visible) marcarCursor(); };
    ['keyup', 'click', 'select'].forEach((ev) => ta.addEventListener(ev, mover));
    caja.addEventListener('click', (e) => {
      const el = e.target.closest('.or-par'); if (!el) return;
      irA(+el.dataset.i);
    });
  }

  async function abrir(r, n) {
    ruta = r; numero = n; datos = null; unidades = []; activo = -1; nuevo = true;
    if (visible) await cargar();
  }

  async function cargar() {
    if (!ruta) return;
    if (!datos) {
      caja.innerHTML = '<p class="or-aviso">Cargando el original…</p>';
      const r = ruta;
      try { datos = await api(`/api/original?ruta=${encodeURIComponent(r)}`); }
      catch (e) { if (r === ruta) caja.innerHTML = `<p class="or-aviso">No se pudo cargar el original: ${esc(e.message)}</p>`; return; }
      if (r !== ruta) return;
    }
    rearmar();
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const recorte = (t, n = 90) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t);

  function rearmar() {
    if (!datos) return;
    if (!datos.pares?.length) {
      caja.innerHTML = '<p class="or-aviso">Este capítulo todavía no tiene el original en inglés emparejado.<br>' +
        'Se arma a partir del PDF en inglés con <code>herramientas/alinear_original.py</code> (repositorio de libros).</p>';
      unidades = []; return;
    }
    unidades = window.Emparejar.armarUnidades(ta.value, datos.pares, datos.titulo, numero);
    caja.innerHTML = unidades.map((u, i) => {
      const es = u.es.map((b) => b.t).join(' ');
      if (!u.en) return `<div class="or-par sin" data-i="${i}"><p class="or-es">${esc(recorte(es))}</p><p class="or-falta">(sin original emparejado)</p></div>`;
      return `<div class="or-par${u.titulo ? ' tit' : ''}" data-i="${i}">` +
        (u.es.length ? `<p class="or-es">${esc(recorte(es))}</p>` : '<p class="or-es or-falta">(sin traducción)</p>') +
        `<p class="or-en" lang="en">${esc(u.titulo ? u.en.replace(/^Chapter \d+\.\s*/, '') : u.en).replace(/\n/g, '<br>')}</p></div>`;
    }).join('');
    // al abrir un capítulo el cursor queda al final del texto: se empieza por el principio
    if (nuevo && document.activeElement !== ta) ta.setSelectionRange(0, 0);
    nuevo = false;
    activo = -1; marcarCursor(true);
  }

  // Unidad que contiene la posición del cursor (o la más cercana antes).
  function unidadEn(pos) {
    let mejor = -1;
    unidades.forEach((u, i) => { if (u.es.length && u.es[0].ini <= pos) mejor = i; });
    if (mejor < 0) mejor = unidades.findIndex((u) => u.es.length);
    // si el cursor quedó entre dos bloques y la unidad siguiente no tiene castellano, igual es esta
    return mejor;
  }

  function marcarCursor(forzar) {
    if (!unidades.length) return;
    const i = unidadEn(ta.selectionStart);
    if (i === activo && !forzar) return;
    caja.querySelector('.or-par.activo')?.classList.remove('activo');
    activo = i;
    const el = caja.querySelector(`.or-par[data-i="${i}"]`);
    if (!el) return;
    el.classList.add('activo');
    const r = el.getBoundingClientRect(), c = caja.getBoundingClientRect();
    if (r.top < c.top + 8 || r.bottom > c.bottom - 8) caja.scrollTo({ top: el.offsetTop - caja.clientHeight / 4, behavior: forzar ? 'auto' : 'smooth' });
  }

  // Lleva el cursor (y el texto) al castellano de una unidad.
  function irA(i) {
    let u = unidades[i];
    if (!u?.es.length) { u = unidades.slice(i).find((x) => x.es.length) || unidades.slice(0, i).reverse().find((x) => x.es.length); }
    if (!u) return;
    const b = u.es[0];
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(b.ini, b.ini);
    ta.scrollTop = Math.max(0, alturaHasta(b.ini) - ta.clientHeight / 4);
    marcarCursor();
  }

  // Altura del texto hasta una posición (con un espejo del textarea), para desplazarlo ahí.
  let espejo = null;
  function alturaHasta(pos) {
    if (!espejo) { espejo = document.createElement('div'); espejo.setAttribute('aria-hidden', 'true'); document.body.appendChild(espejo); }
    const cs = getComputedStyle(ta);
    Object.assign(espejo.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      width: ta.clientWidth + 'px', font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, padding: cs.padding, boxSizing: 'border-box', tabSize: cs.tabSize });
    espejo.textContent = ta.value.slice(0, pos) + '​';
    return espejo.scrollHeight - parseFloat(cs.paddingBottom || 0);
  }

  function textoCambio() {
    if (!visible || !datos) return;
    clearTimeout(tRe); tRe = setTimeout(rearmar, 700);
  }

  async function mostrar(si) {
    visible = si;
    if (si) { await cargar(); marcarCursor(true); }
  }

  window.Original = { iniciar, abrir, mostrar, textoCambio };
})();
