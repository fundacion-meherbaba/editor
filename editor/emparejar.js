// Empareja los párrafos actuales de un capítulo (Markdown, en castellano) con el original en
// inglés guardado en libros/<libro>/original/<capítulo>.json ({ titulo, pares: [{ es, en }] }).
// El castellano puede haber cambiado desde que se emparejó: se busca por parecido, en orden.
// Lo usan el modo escucha y la vista «Original en inglés» del editor.
'use strict';
(() => {
  const plano = (md) => md
    .replace(/^:::.*$/gm, '').replace(/^#{1,4}\s+/gm, '').replace(/\s*\{[^}]*\}\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, 'Foto: $1').replace(/\[\^\d+\]/g, '')
    .replace(/^>\s?/gm, '').replace(/\*+/g, '').replace(/\\(.)/g, '$1')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

  // Bloques del capítulo (como en herramientas/alinear_original.py), con su posición en el texto.
  function bloques(texto) {
    const partes = [];
    const re = /\n[ \t]*\n/g; let desde = 0, m;
    while ((m = re.exec(texto))) { partes.push({ t: texto.slice(desde, m.index), ini: desde }); desde = m.index + m[0].length; }
    partes.push({ t: texto.slice(desde), ini: desde });
    const out = [];
    for (let i = 0; i < partes.length; i++) {
      let p = partes[i].t, ini = partes[i].ini, fin = ini + p.length;
      if (/^:::/.test(p.replace(/^\n+/, '')) && !/(^|\n):::\s*$/.test(p.replace(/^\n+/, '').split('\n').slice(1).join('\n'))) {
        let j = i;
        while (j + 1 < partes.length && !/(^|\n):::\s*$/.test(partes[j].t.replace(/\n+$/, ''))) j++;
        fin = partes[j].ini + partes[j].t.length; p = texto.slice(ini, fin); i = j;
      }
      const lead = p.match(/^[\n\r]*/)[0].length;
      ini += lead; p = p.slice(lead);
      p = p.replace(/[\n\r]+$/, ''); fin = ini + p.length;
      if (!p.trim()) continue;
      const clase = p.match(/^:::\s*([\p{L}\w-]+)/u)?.[1];
      if (clase === 'nota-interna' || /^\[\^\d+\]:/.test(p)) continue;
      const tipo = /^# /.test(p) ? 'titulo' : /^#{2,4}\s/.test(p) ? 'seccion' : clase || 'parrafo';
      out.push({ md: p, tipo, t: plano(p), ini, fin });
    }
    return out;
  }

  const normal = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  function parecido(a, b) {
    const A = new Set(normal(a)), B = new Set(normal(b));
    if (!A.size || !B.size) return a.trim() === b.trim() ? 1 : 0;
    let c = 0; for (const w of A) if (B.has(w)) c++;
    return c / Math.min(A.size, B.size);
  }

  // Unidades de lectura: { es: [bloques], en: 'texto', k: índice del par, titulo?: true, leerEs? }
  function armarUnidades(texto, pares, tituloEn, numero) {
    const bs = bloques(texto);
    const unidades = [];
    const tit = bs.find((b) => b.tipo === 'titulo');
    if (tit) unidades.push({ es: [tit], en: tituloEn ? `Chapter ${numero}. ${tituloEn}` : '', titulo: true, leerEs: `Capítulo ${numero}. ${tit.t}` });
    const cuerpo = bs.filter((b) => b.tipo !== 'titulo');
    // piezas de los pares (un par puede abarcar varios párrafos en castellano)
    const piezas = [];
    pares.forEach((p, k) => { const ps = (p.es || '').split(/\n[ \t]*\n/).filter((x) => x.trim()); (ps.length ? ps : ['']).forEach((x) => piezas.push({ k, t: plano(x) })); });
    // alineación monótona por parecido (programación dinámica)
    const n = cuerpo.length, m = piezas.length;
    const S = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
    const P = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    const sim = Array.from({ length: n }, () => new Float32Array(m));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const s = sim[i - 1][j - 1] = parecido(cuerpo[i - 1].t, piezas[j - 1].t);
      const diag = S[i - 1][j - 1] + (s >= 0.35 ? s : -0.2);
      const arriba = S[i - 1][j], izq = S[i][j - 1];
      if (diag >= arriba && diag >= izq) { S[i][j] = diag; P[i][j] = 1; } else if (arriba >= izq) { S[i][j] = arriba; P[i][j] = 2; } else { S[i][j] = izq; P[i][j] = 3; }
    }
    const par = new Array(n).fill(-1);
    for (let i = n, j = m; i > 0 && j > 0;) {
      if (P[i][j] === 1) { if (sim[i - 1][j - 1] >= 0.35) par[i - 1] = piezas[j - 1].k; i--; j--; }
      else if (P[i][j] === 2) i--; else j--;
    }
    // párrafos seguidos con el mismo par van juntos; los pares sin castellano, solos
    const usados = new Set(par.filter((k) => k >= 0));
    let ultimoPar = -1;
    for (let i = 0; i < n; i++) {
      const k = par[i];
      if (k >= 0) {
        for (let q = ultimoPar + 1; q < k; q++) if (!usados.has(q) && pares[q]?.en) unidades.push({ es: [], en: pares[q].en, k: q });
        const prev = unidades[unidades.length - 1];
        if (prev && prev.k === k && prev.es.length) prev.es.push(cuerpo[i]);
        else unidades.push({ es: [cuerpo[i]], en: pares[k].en || '', k });
        ultimoPar = Math.max(ultimoPar, k);
      } else unidades.push({ es: [cuerpo[i]], en: '' });
    }
    for (let q = ultimoPar + 1; q < pares.length; q++) if (!usados.has(q) && pares[q]?.en) unidades.push({ es: [], en: pares[q].en, k: q });
    return unidades;
  }

  window.Emparejar = { plano, bloques, parecido, armarUnidades };
})();
