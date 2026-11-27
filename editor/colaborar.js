// Edición en conjunto: fusión de cambios (tipo «diff3», por palabras), resaltado de lo que se acaba de
// corregir y las funciones de autoguardado y autoactualización que usa app.js.
'use strict';
(() => {
  // ---------------------------------------------------------------- diff por palabras (Myers)
  const tokenizar = (t) => t.match(/\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu) || [];

  // Trozos distintos entre dos listas de palabras: [{a0,a1,b0,b1}] (a = original, b = nuevo)
  function diff(A, B) {
    let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    if (s === ea && s === eb) return [];
    if (s === ea || s === eb) return [{ a0: s, a1: ea, b0: s, b1: eb }];
    const a = A.slice(s, ea), b = B.slice(s, eb), n = a.length, m = b.length;
    const max = Math.min(n + m, 4000), off = max + 1;
    const V = new Int32Array(2 * max + 3); const filas = []; let hallado = -1;
    for (let d = 0; d <= max && hallado < 0; d++) {
      const fila = new Int32Array(d + 1);
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        V[off + k] = x; fila[(k + d) / 2] = x;
        if (x >= n && y >= m) { hallado = d; break; }
      }
      filas.push(fila);
    }
    if (hallado < 0) return [{ a0: s, a1: ea, b0: s, b1: eb }];   // demasiado distintos: un solo trozo
    const ops = []; let x = n, y = m;
    for (let d = hallado; d > 0; d--) {
      const k = x - y, prev = filas[d - 1];
      const kp = (k === -d || (k !== d && prev[(k - 1 + d - 1) / 2] < prev[(k + 1 + d - 1) / 2])) ? k + 1 : k - 1;
      const xp = prev[(kp + d - 1) / 2], yp = xp - kp;
      ops.push(kp === k + 1 ? { t: 'i', a: xp, b: yp } : { t: 'd', a: xp, b: yp });
      x = xp; y = yp;
    }
    ops.reverse();
    const hs = [];
    for (const op of ops) {
      const h = hs[hs.length - 1];
      if (op.t === 'd') { if (h && h.a1 === op.a && h.b1 === op.b) h.a1++; else hs.push({ a0: op.a, a1: op.a + 1, b0: op.b, b1: op.b }); }
      else if (h && h.a1 === op.a && h.b1 === op.b) h.b1++; else hs.push({ a0: op.a, a1: op.a, b0: op.b, b1: op.b + 1 });
    }
    return hs.map((h) => ({ a0: h.a0 + s, a1: h.a1 + s, b0: h.b0 + s, b1: h.b1 + s }));
  }

  const desplazamientos = (T) => { const o = [0]; for (const t of T) o.push(o[o.length - 1] + t.length); return o; };

  // Fusiona dos versiones (local y remota) que salieron de la misma base.
  // Devuelve { texto, conflictos, perdidos, remotos: [{ini,fin}], puntos } — «puntos» son posiciones del
  // texto local (cursor, selección) ya trasladadas al texto fusionado.
  function fusionar(base, local, remoto, puntos = []) {
    const mapa = (t) => ({ texto: t, conflictos: 0, perdidos: [], remotos: [], puntos: puntos.slice() });
    if (local === remoto) return mapa(local);
    const A = tokenizar(base), L = tokenizar(local), R = tokenizar(remoto);
    const oA = desplazamientos(A), oL = desplazamientos(L), oR = desplazamientos(R);
    const hl = local === base ? [] : diff(A, L), hr = remoto === base ? [] : diff(A, R);
    const out = []; let largo = 0; const remotos = []; const perdidos = []; let conflictos = 0;
    const res = puntos.slice();
    const colocados = new Array(puntos.length).fill(false);
    const emitir = (toks) => { for (const t of toks) { out.push(t); largo += t.length; } };
    // un trozo de L (índices lIni..lFin) que ahora empieza en «dest» del texto fusionado
    const anclar = (lIni, lFin, dest) => {
      puntos.forEach((p, i) => { if (!colocados[i] && p >= oL[lIni] && p <= oL[lFin]) { res[i] = dest + (p - oL[lIni]); colocados[i] = true; } });
    };
    const aplicar = (hs, desde, hasta, T) => {   // base [desde,hasta) con los trozos hs aplicados, en palabras de T
      const r = []; let pos = desde;
      for (const h of hs) { for (let q = pos; q < h.a0; q++) r.push(A[q]); for (let q = h.b0; q < h.b1; q++) r.push(T[q]); pos = h.a1; }
      for (let q = pos; q < hasta; q++) r.push(A[q]);
      return r;
    };
    const choca = (l, r) => {
      if (l.a0 === l.a1 && r.a0 === r.a1) return l.a0 === r.a0 && L.slice(l.b0, l.b1).join('') !== R.slice(r.b0, r.b1).join('');
      if (l.a0 === l.a1) return l.a0 > r.a0 && l.a0 < r.a1;
      if (r.a0 === r.a1) return r.a0 > l.a0 && r.a0 < l.a1;
      return l.a0 < r.a1 && r.a0 < l.a1;
    };
    let pos = 0, i = 0, j = 0, shiftL = 0;
    const copiarBase = (hasta) => {
      if (hasta > pos) { anclar(pos + shiftL, hasta + shiftL, largo); emitir(A.slice(pos, hasta)); pos = hasta; }
    };
    while (i < hl.length || j < hr.length) {
      const l = hl[i], r = hr[j];
      if (l && r && choca(l, r)) {
        // grupo de trozos que se pisan: se queda lo local (lo remoto sigue en el historial)
        let u0 = Math.min(l.a0, r.a0), u1 = Math.max(l.a1, r.a1); const gl = [], gr = [];
        let crece = true;
        while (crece) {
          crece = false;
          while (i < hl.length && hl[i].a0 <= u1 && (hl[i].a1 >= u0)) { gl.push(hl[i]); u0 = Math.min(u0, hl[i].a0); u1 = Math.max(u1, hl[i].a1); i++; crece = true; }
          while (j < hr.length && hr[j].a0 <= u1 && (hr[j].a1 >= u0)) { gr.push(hr[j]); u0 = Math.min(u0, hr[j].a0); u1 = Math.max(u1, hr[j].a1); j++; crece = true; }
        }
        copiarBase(u0);
        const sl = aplicar(gl, u0, u1, L).join(''), sr = aplicar(gr, u0, u1, R).join('');
        if (sl !== sr) { conflictos++; perdidos.push(sr); }
        const lIni = gl.length ? gl[0].b0 : u0 + shiftL;
        const lFin = gl.length ? gl[gl.length - 1].b1 + (u1 - gl[gl.length - 1].a1) : u1 + shiftL;
        anclar(lIni, lFin, largo);
        emitir(aplicar(gl, u0, u1, L));
        for (const h of gl) shiftL += (h.b1 - h.b0) - (h.a1 - h.a0);
        pos = u1;
      } else if (l && (!r || l.a1 <= r.a0)) {
        copiarBase(l.a0);
        anclar(l.b0, l.b1, largo); emitir(L.slice(l.b0, l.b1));
        shiftL += (l.b1 - l.b0) - (l.a1 - l.a0); pos = l.a1; i++;
      } else {
        copiarBase(r.a0);
        const ini = largo; emitir(R.slice(r.b0, r.b1));
        if (largo > ini) remotos.push({ ini, fin: largo });
        pos = Math.max(pos, r.a1); j++;
        if (r.a1 > r.a0 && shiftL !== 0) { /* los trozos locales ya contabilizados no se ven afectados */ }
      }
    }
    copiarBase(A.length);
    puntos.forEach((p, k) => { if (!colocados[k]) res[k] = largo; });
    return { texto: out.join(''), conflictos, perdidos, remotos, puntos: res };
  }

  // ---------------------------------------------------------------- resaltado de cambios recientes
  const VIDA = { yo: 9000, otro: 40000 };
  let capa, interior, ta, rangos = [], previo = '', tPintar = 0, activoResaltar = true;

  function iniciarResaltado(textarea) {
    ta = textarea; previo = ta.value;
    capa = document.createElement('div'); capa.className = 'marcas marcas-cambios'; capa.setAttribute('aria-hidden', 'true');
    interior = document.createElement('div'); interior.className = 'marcas-int'; capa.appendChild(interior);
    const env = ta.parentNode; env.insertBefore(capa, env.firstChild);
    const ajustar = () => { capa.style.width = ta.clientWidth + 'px'; capa.style.height = ta.clientHeight + 'px'; interior.style.transform = `translateY(${-ta.scrollTop}px)`; };
    new ResizeObserver(ajustar).observe(ta);
    ta.addEventListener('scroll', () => { interior.style.transform = `translateY(${-ta.scrollTop}px)`; }, { passive: true });
    ta.addEventListener('input', alInput);
    try { activoResaltar = localStorage.getItem('resaltar-cambios') !== 'no'; } catch { /* nada */ }
    ajustar();
  }

  function alInput() {
    const ahora = ta.value; const antes = previo; previo = ahora;
    if (ahora === antes) return;
    let pre = 0; const n = Math.min(antes.length, ahora.length);
    while (pre < n && antes[pre] === ahora[pre]) pre++;
    let suf = 0; while (suf < n - pre && antes[antes.length - 1 - suf] === ahora[ahora.length - 1 - suf]) suf++;
    const quitadoFin = antes.length - suf, ins = ahora.length - suf - pre, delta = ahora.length - antes.length;
    rangos = rangos.map((r) => {
      if (r.fin <= pre) return r;
      if (r.ini >= quitadoFin) return { ...r, ini: r.ini + delta, fin: r.fin + delta };
      return { ...r, ini: Math.min(r.ini, pre), fin: Math.max(pre + ins, r.fin + delta) };
    }).filter((r) => r.fin > r.ini);
    if (ins > 0) {
      const u = rangos.find((r) => r.quien === 'yo' && r.fin === pre && Date.now() - r.t < 4000);
      if (u) { u.fin = pre + ins; u.t = Date.now(); } else rangos.push({ ini: pre, fin: pre + ins, quien: 'yo', t: Date.now() });
    }
    programarPintado();
  }

  // Texto puesto desde afuera (cambios de otra persona): se cuentan como cambios de esa persona.
  function textoPuesto(texto, remotos, autor) {
    const antes = previo; previo = texto;
    // los resaltados de antes se trasladan con el mismo criterio que una edición
    let pre = 0; const n = Math.min(antes.length, texto.length);
    while (pre < n && antes[pre] === texto[pre]) pre++;
    let suf = 0; while (suf < n - pre && antes[antes.length - 1 - suf] === texto[texto.length - 1 - suf]) suf++;
    const quitadoFin = antes.length - suf, ins = texto.length - suf - pre, delta = texto.length - antes.length;
    rangos = rangos.map((r) => {
      if (r.fin <= pre) return r;
      if (r.ini >= quitadoFin) return { ...r, ini: r.ini + delta, fin: r.fin + delta };
      return { ...r, ini: Math.min(r.ini, pre), fin: Math.max(pre + ins, r.fin + delta) };
    }).filter((r) => r.fin > r.ini);
    for (const r of remotos || []) rangos.push({ ini: r.ini, fin: r.fin, quien: 'otro', autor, t: Date.now() });
    programarPintado();
  }

  function programarPintado() { if (!tPintar) tPintar = setTimeout(pintar, 60); }

  function pintar() {
    tPintar = 0;
    const ahora = Date.now();
    rangos = rangos.filter((r) => ahora - r.t < VIDA[r.quien]);
    if (!activoResaltar || !rangos.length) { interior.textContent = ''; return; }
    const texto = ta.value;
    const cortes = [...rangos].sort((a, b) => a.ini - b.ini);
    let h = '', pos = 0;
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const r of cortes) {
      const ini = Math.max(pos, Math.min(r.ini, texto.length)), fin = Math.min(texto.length, Math.max(ini, r.fin));
      if (fin <= ini) continue;
      const edad = (ahora - r.t) / VIDA[r.quien];
      const alfa = (0.55 * (1 - edad)).toFixed(2);
      const color = r.quien === 'yo' ? `rgba(255,214,102,${alfa})` : `rgba(88,196,120,${alfa})`;
      h += esc(texto.slice(pos, ini)) + `<mark class="m-cambio" style="background:${color}">${esc(texto.slice(ini, fin))}</mark>`;
      pos = fin;
    }
    interior.innerHTML = h + esc(texto.slice(pos)) + '​';
    tPintar = setTimeout(pintar, 500);
  }

  function activar(si) { activoResaltar = si; try { localStorage.setItem('resaltar-cambios', si ? 'si' : 'no'); } catch { /* nada */ } pintar(); }
  const resaltadoActivo = () => activoResaltar;
  const ultimosRemotos = () => rangos.filter((r) => r.quien === 'otro').sort((a, b) => a.ini - b.ini);
  const reiniciarResaltado = () => { if (!ta) return; rangos = []; previo = ta.value; pintar(); };

  window.Colaborar = { tokenizar, diff, fusionar, iniciarResaltado, textoPuesto, activar, resaltadoActivo, ultimosRemotos, reiniciarResaltado };
})();
