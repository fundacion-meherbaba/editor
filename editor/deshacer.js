// Deshacer / Rehacer propios del editor. El «deshacer» del navegador se pierde al pegar con el
// menú del teléfono, al cambiar de capítulo o con los reemplazos del corrector; este guarda
// copias del texto antes de cada cambio grande (pegar, cortar, borrar mucho) y, escribiendo,
// cada pocos segundos. Cada toque en Deshacer vuelve a la copia anterior; Rehacer la vuelve a poner.
'use strict';
(() => {
  const MAX = 80, CADA = 8000, GRANDE = 25;
  let ta, bDes, bReh, alCambiar;
  let pila = [], rehacer = [], ultimo = '', antesPend = null, tSnap = 0, restaurando = false;

  function iniciar(op) {
    ({ textarea: ta, deshacer: bDes, rehacer: bReh, alCambiar } = op);
    ultimo = ta.value;
    ta.addEventListener('beforeinput', () => { antesPend = ta.value; });
    ta.addEventListener('input', alInput);
    bDes.onclick = () => volver(pila, rehacer);
    bReh.onclick = () => volver(rehacer, pila);
    ta.addEventListener('keydown', (e) => {
      // Ctrl/⌘ + Z y Mayús + Ctrl/⌘ + Z: el nuestro, que no se pierde al pegar o cambiar de capítulo
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      e.preventDefault(); e.shiftKey ? volver(rehacer, pila) : volver(pila, rehacer);
    });
    botones();
  }

  function alInput(e) {
    const antes = antesPend ?? ultimo; antesPend = null;
    const ahora = ta.value; ultimo = ahora;
    if (restaurando) return;
    const delta = Math.abs(ahora.length - antes.length);
    const tipo = e.inputType || '';
    const grande = delta >= GRANDE || /^(insertFromPaste|insertFromDrop|deleteByCut|deleteByDrag|historyUndo|historyRedo)/.test(tipo) || !tipo;
    const t = Date.now();
    if (antes !== ahora && (grande || t - tSnap > CADA)) {
      if (pila[pila.length - 1] !== antes) { pila.push(antes); if (pila.length > MAX) pila.shift(); }
      tSnap = t; rehacer = []; botones();
    } else if (antes !== ahora && rehacer.length) { rehacer = []; botones(); }
  }

  function volver(desde, hacia) {
    if (!desde.length || ta.readOnly) return;
    const actual = ta.value;
    let destino = desde.pop();
    while (destino === actual && desde.length) destino = desde.pop();
    if (destino === actual) { botones(); return; }
    hacia.push(actual);
    let k = 0; const n = Math.min(actual.length, destino.length);
    while (k < n && actual[k] === destino[k]) k++;
    restaurando = true;
    ta.value = destino;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    restaurando = false; ultimo = destino; tSnap = Date.now();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(k, k);
    ta.scrollTop = Math.max(0, (k / Math.max(1, destino.length)) * ta.scrollHeight - ta.clientHeight / 3);
    botones();
    alCambiar && alCambiar();
  }

  function botones() {
    bDes.disabled = !pila.length; bReh.disabled = !rehacer.length;
    bDes.title = pila.length ? `Deshacer el último cambio (${pila.length} guardados) · Ctrl/⌘ + Z` : 'No hay nada para deshacer';
    bReh.title = rehacer.length ? 'Rehacer (Ctrl/⌘ + Mayús + Z)' : 'No hay nada para rehacer';
  }

  // Al abrir otro capítulo (o una versión) se empieza de cero.
  function reiniciar() { pila = []; rehacer = []; ultimo = ta.value; antesPend = null; tSnap = Date.now(); botones(); }

  // Llegaron cambios de otra persona: se ponen en el texto sin que cuenten como cambio propio, y las
  // copias guardadas para deshacer los incorporan (así «Deshacer» no borra lo que escribieron los demás).
  function remoto(poner, base, textoRemoto) {
    restaurando = true;
    try { poner(); ta.dispatchEvent(new Event('input', { bubbles: true })); } finally { restaurando = false; }
    ultimo = ta.value; antesPend = null;
    const F = window.Colaborar;
    if (F) {
      const incorporar = (s) => F.fusionar(base, s, textoRemoto).texto;
      pila = pila.slice(-20).map(incorporar); rehacer = rehacer.slice(-20).map(incorporar);
    }
    botones();
  }

  window.Deshacer = { iniciar, reiniciar, remoto };
})();
