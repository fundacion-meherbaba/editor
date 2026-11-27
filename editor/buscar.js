// Buscar (Ctrl/⌘ + F) en todos los capítulos del libro abierto.
// Los resultados se agrupan por capítulo; tocar uno abre el capítulo y deja el texto elegido a la vista.
'use strict';
(() => {
  let o, panel, entrada, lista, cuenta, chkExacto, ta;
  let textos = null, resultados = [], actual = -1, tBuscar, cargando = false;

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = (t) => t.split('').map((c) => { const n = c.normalize('NFD')[0] || c; return n.toLowerCase(); }).join('');

  function iniciar(op) {
    o = op; ta = o.textarea;
    panel = document.getElementById('buscar'); entrada = document.getElementById('buscar-q');
    lista = document.getElementById('buscar-lista'); cuenta = document.getElementById('buscar-cuenta');
    chkExacto = document.getElementById('buscar-exacto');
    document.getElementById('buscar-cerrar').onclick = cerrar;
    document.getElementById('b-buscar').onclick = () => abrir();
    document.getElementById('buscar-sig').onclick = () => ir(1);
    document.getElementById('buscar-ant').onclick = () => ir(-1);
    entrada.addEventListener('input', () => { clearTimeout(tBuscar); tBuscar = setTimeout(buscar, 160); });
    chkExacto.addEventListener('change', buscar);
    entrada.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!resultados.length) buscar(); ir(e.shiftKey ? -1 : 1, true); }
      if (e.key === 'Escape') { e.preventDefault(); cerrar(); }
    });
    lista.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) elegir(+li.dataset.i, true); });
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !document.getElementById('app').hidden) { e.preventDefault(); abrir(); }
      else if (e.key === 'F3' || (mod && e.key.toLowerCase() === 'g')) { if (resultados.length || !panel.hidden) { e.preventDefault(); ir(e.shiftKey ? -1 : 1, true); } }
      else if (e.key === 'Escape' && !panel.hidden && document.activeElement === ta) { cerrar(false); }
    });
  }

  async function cargarTextos() {
    if (cargando) return;
    cargando = true; cuenta.textContent = 'Cargando los capítulos…';
    try {
      const l = await o.api(`/api/texto-libro?id=${encodeURIComponent(o.libro().id)}`);
      textos = new Map(l.map((c) => [c.ruta, c.texto]));
    } catch (e) { cuenta.textContent = 'No se pudieron cargar los capítulos: ' + e.message; }
    cargando = false;
  }

  async function abrir() {
    const sel = ta.selectionEnd > ta.selectionStart && ta.selectionEnd - ta.selectionStart < 80 ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    panel.hidden = false;
    if (sel) entrada.value = sel;
    entrada.focus(); entrada.select();
    textos = null; await cargarTextos(); buscar();
  }
  function cerrar(foco = true) { panel.hidden = true; resultados = []; actual = -1; if (foco) ta.focus({ preventScroll: true }); }

  function buscar() {
    const q = entrada.value;
    resultados = []; actual = -1;
    if (!q.trim() || !textos) { lista.innerHTML = ''; if (!q.trim() && textos) cuenta.textContent = ''; return; }
    const exacto = chkExacto.checked;
    const aguja = exacto ? q : base(q);
    const caps = o.libro().capitulos;
    const actualRuta = o.capActual();
    for (let ci = 0; ci < caps.length; ci++) {
      const c = caps[ci];
      const texto = c.ruta === actualRuta ? ta.value : (textos.get(c.ruta) ?? '');
      const pajar = exacto ? texto : base(texto);
      let i = 0;
      while ((i = pajar.indexOf(aguja, i)) !== -1) {
        resultados.push({ ruta: c.ruta, ci, titulo: c.titulo, ini: i, fin: i + q.length, texto });
        i += Math.max(1, aguja.length);
        if (resultados.length >= 600) break;
      }
      if (resultados.length >= 600) break;
    }
    pintar(q);
  }

  function pintar(q) {
    if (!resultados.length) { lista.innerHTML = ''; cuenta.textContent = 'Sin resultados.'; return; }
    const porCap = new Set(resultados.map((r) => r.ruta)).size;
    cuenta.textContent = `${resultados.length >= 600 ? 'Más de 600' : resultados.length} resultado${resultados.length === 1 ? '' : 's'} en ${porCap} capítulo${porCap === 1 ? '' : 's'}`;
    let h = '', ultimo = null;
    resultados.forEach((r, i) => {
      if (r.ruta !== ultimo) { h += `<div class="b-cap">${String(r.ci + 1).padStart(2, '0')} · ${esc(r.titulo)}</div>`; ultimo = r.ruta; }
      const a = Math.max(0, r.ini - 40), b = Math.min(r.texto.length, r.fin + 50);
      const sn = (a > 0 ? '…' : '') + esc(r.texto.slice(a, r.ini).replace(/\s+/g, ' ')) + '<mark>' + esc(r.texto.slice(r.ini, r.fin)) + '</mark>' + esc(r.texto.slice(r.fin, b).replace(/\s+/g, ' ')) + (b < r.texto.length ? '…' : '');
      h += `<div class="b-res" data-i="${i}">${sn}</div>`;
    });
    lista.innerHTML = h;
  }

  function ir(d, enfocar) {
    if (!resultados.length) return;
    // empieza por el primer resultado desde el cursor, si todavía no se eligió ninguno
    if (actual < 0) {
      const pos = ta.selectionEnd;
      const i = resultados.findIndex((r) => r.ruta === o.capActual() && r.ini >= (d > 0 ? pos : 0));
      actual = d > 0 ? (i >= 0 ? i - 1 : -1) : (i >= 0 ? i : 0);
    }
    elegir((actual + d + resultados.length) % resultados.length, enfocar);
  }

  async function elegir(i, enfocar) {
    const r = resultados[i]; if (!r) return;
    actual = i;
    lista.querySelectorAll('.b-res.sel').forEach((x) => x.classList.remove('sel'));
    const el = lista.querySelector(`[data-i="${i}"]`); el?.classList.add('sel'); el?.scrollIntoView({ block: 'nearest' });
    if (r.ruta !== o.capActual()) { await o.abrirCapitulo(r.ruta); buscar(); actual = resultados.findIndex((x) => x.ruta === r.ruta && x.ini === r.ini); }
    const x = resultados[actual] || r;
    o.mostrar(x.ini, x.fin, enfocar);
  }

  window.Buscar = { iniciar, abrir, cerrar };
})();
