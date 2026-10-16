/* Biblioteca técnica GH — versión web. Se arma con herramientas/construir_web.py; no editar a mano. */
"use strict";
var FRONTEND_VERSION = '2026-10-16T14:36';
var BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwZC6NAzLDUleScxQb57m8T675gvtHvkn7m0R_qoPfU7_Gtv9E34_VgPmCiekUk_KHU/exec';
var BACKEND_ESPEJO = 'https://script.google.com/macros/s/AKfycbwz5Eu-ScQ0qgUJQpMDE8GyotV92qIZNZn4aL1zsb269LiW0USACRPrZ1uwGG1POfxnTQ/exec';
var CLIENT_ID = '585469655594-8aj9hjmf7d4noglr1th673dbiia8ftkv.apps.googleusercontent.com';
var idToken = null;
var ultimoFalloBackend = '';

/* Pedidos al backend: lecturas en paralelo al principal y al espejo (Apps Script falla de forma
   intermitente en la puerta de entrada de Google). Mismo motor que Seguimiento de Mediciones. */
var PLAN_LECTURA = { escalones: [0, 4000, 8000, 13000, 20000], max: 5, porIntento: 25000, tope: 50000 };
function pedirAlBackend(action, extra) {
  var plan = PLAN_LECTURA;
  var texto = JSON.stringify(Object.assign({ action: action, idToken: idToken }, extra || {}));
  var t0 = Date.now();
  return new Promise(function (resolve, reject) {
    var terminado = false, lanzados = 0, activos = 0, ultimoError = null, controles = [], relojes = [];
    function cerrar(fin, valor) {
      if (terminado) return;
      terminado = true; relojes.forEach(clearTimeout); controles.forEach(function (c) { c.abort(); }); fin(valor);
    }
    function anotar(err, n) {
      ultimoFalloBackend = action + ' · ' + ((err && err.name) || 'error') + ' a los ' + Math.round((Date.now() - t0) / 1000) +
        ' s (intento ' + n + ' de ' + plan.max + (n % 2 === 0 ? ', espejo' : '') + ')' + (navigator.onLine === false ? ' · sin internet' : '');
    }
    function lanzar() {
      if (terminado || lanzados >= plan.max) return;
      var n = ++lanzados; activos++;
      var corte = new AbortController(); controles.push(corte);
      var base = (n % 2 === 0) ? BACKEND_ESPEJO : BACKEND_URL;
      var url = n <= 2 ? base : base + '?r=' + Date.now() + '_' + n;
      var reloj = setTimeout(function () { corte.abort(); }, plan.porIntento);
      fetch(url, { method: 'POST', body: texto, signal: corte.signal })
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          var json;
          try { json = JSON.parse(txt); } catch (e) { var er = new Error('El backend respondió algo que no es JSON'); er.name = 'RespuestaInvalida'; throw er; }
          cerrar(resolve, json);
        })
        .catch(function (err) { if (!terminado) { ultimoError = err; anotar(err, n); } })
        .then(function () {
          clearTimeout(reloj); activos--;
          if (terminado) return;
          if (lanzados < plan.max) lanzar(); else if (activos === 0) cerrar(reject, ultimoError || new Error('sin respuesta'));
        });
    }
    plan.escalones.slice(1).forEach(function (ms) { relojes.push(setTimeout(lanzar, ms)); });
    relojes.push(setTimeout(function () {
      if (!ultimoError) { var e = new Error('tiempo agotado'); e.name = 'AbortError'; ultimoError = e; anotar(e, lanzados); }
      cerrar(reject, ultimoError);
    }, plan.tope));
    lanzar();
  });
}

/* Catálogo: se guarda en el navegador y el backend solo lo manda si cambió. */
async function catalogoWeb() {
  let guardado = null;
  try { guardado = JSON.parse(localStorage.getItem('ghBibCatalogo') || 'null'); } catch (e) { guardado = null; }
  const d = await pedirAlBackend('getCatalogo', { completo: true, version: guardado && guardado.version });
  if (!d || !d.ok) { const e = new Error((d && d.error) || 'catalogo'); e.name = (d && d.error === 'auth_failed') ? 'NoAutorizada' : 'Error'; throw e; }
  if (d.igual && guardado) return guardado.catalogo;
  try { localStorage.setItem('ghBibCatalogo', JSON.stringify({ version: d.version, catalogo: d.catalogo })); } catch (e) { /* sin lugar: se baja de nuevo */ }
  return d.catalogo;
}

/* Estado de calibración de cada equipo de la Biblioteca, calculado con la planilla de Calibraciones. */
async function calibracionesWeb(cat) {
  let filas = [];
  try { const d = await pedirAlBackend('getCalibraciones', {}); filas = (d && d.equiposCal) || []; } catch (e) { return {}; }
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const porId = Object.fromEntries(filas.map(f => [f.id, f]));
  const fecha = v => { if (!v) return null; const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const iso = d => d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : null;
  const salida = {};
  for (const [k, nombre] of Object.entries(cat.equipos)) {
    const fis = ((cat.equiposCal || {})[k] || []).map(id => porId[id]).filter(Boolean);
    const vence = fis.map(f => fecha(f.fecha_venc)).filter(Boolean).sort((a, b) => b - a)[0] || null;   // la mejor
    const cal = fis.map(f => fecha(f.fecha_cal)).filter(Boolean).sort((a, b) => b - a)[0] || null;
    let dias = null, estado = 'sin dato';
    if (vence) { dias = Math.round((vence - hoy) / 86400000); estado = dias < 0 ? 'vencida' : dias <= 60 ? 'por vencer' : 'vigente'; }
    const conCert = fis.filter(f => f.pdf_file_id).sort((a, b) => String(b.fecha_cal).localeCompare(String(a.fecha_cal)))[0];
    salida[k] = { nombre, vence: iso(vence), calibrado: iso(cal), dias, estado, aviso: null,
      certificado: conCert ? { nombre: 'Certificado de ' + conCert.equipo, rel: 'drive:' + conCert.pdf_file_id } : null };
  }
  return salida;
}

/* Inicio de sesión */
const MENSAJES_CARGA = ['Verificando tu acceso…', 'Trayendo el catálogo…', 'Ordenando los documentos…', 'Revisando las calibraciones…', 'Ya casi está…'];
let cargaIntervalo = null, cargaTimeout = null;
function iniciarCargaVisual() {
  const msg = document.getElementById('loadingMsg'); let i = 0;
  document.getElementById('loginSpinner').style.display = 'block';
  msg.style.opacity = 1; msg.textContent = MENSAJES_CARGA[0];
  clearInterval(cargaIntervalo); clearTimeout(cargaTimeout);
  cargaIntervalo = setInterval(() => {
    i = (i + 1) % MENSAJES_CARGA.length; msg.style.opacity = 0;
    cargaTimeout = setTimeout(() => { msg.textContent = MENSAJES_CARGA[i]; msg.style.opacity = 1; }, 300);
  }, 2200);
}
function detenerCargaVisual() {
  clearInterval(cargaIntervalo); clearTimeout(cargaTimeout); cargaIntervalo = cargaTimeout = null;
  document.getElementById('loginSpinner').style.display = 'none';
}
function mostrarErrorLogin(html) {
  const err = document.getElementById('loginError'); err.innerHTML = html; err.style.display = 'block';
}
function handleCredentialResponse(resp) {
  idToken = resp.credential;
  document.getElementById('gsiButton').style.display = 'none';
  document.getElementById('loginError').style.display = 'none';
  iniciarCargaVisual();
  intentarLogin(true);
}
async function intentarLogin(primerIntento) {
  try {
    const cat = await catalogoWeb();
    window.__catalogoInicial = cat;
    detenerCargaVisual();
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    window.__arrancarBiblioteca();
  } catch (fallo) {
    if (fallo.name === 'NoAutorizada') {
      if (primerIntento) return intentarLogin(false);
      detenerCargaVisual(); idToken = null;
      document.getElementById('gsiButton').style.display = 'flex';
      mostrarErrorLogin('Esta cuenta no está autorizada. Pedile a GH Consultora que agregue tu email a la lista.');
      return;
    }
    detenerCargaVisual();
    document.getElementById('gsiButton').style.display = 'flex';
    const causa = fallo.name === 'AbortError' ? 'El backend tardó demasiado en responder.'
      : fallo.name === 'RespuestaInvalida' ? 'Google devolvió una respuesta inesperada.' : 'No se pudo conectar con el backend.';
    mostrarErrorLogin(esc(causa) + ' Casi siempre se arregla recargando la página con la versión más nueva.' +
      (ultimoFalloBackend ? '<div class="rastro">' + esc(ultimoFalloBackend) + '</div>' : '') +
      '<button type="button" id="btnRecargarLogin">Recargar</button>');
    document.getElementById('btnRecargarLogin').onclick = () => location.replace(location.pathname + '?recargar=' + Date.now());
  }
}
window.addEventListener('load', function iniciarGoogle() {
  if (!window.google || !google.accounts) { setTimeout(iniciarGoogle, 300); return; }
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: handleCredentialResponse });
  google.accounts.id.renderButton(document.getElementById('gsiButton'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
});
/* Aviso de versión nueva */
setInterval(() => {
  if (document.hidden) return;
  fetch(location.pathname + '?v=' + Date.now(), { cache: 'no-store' }).then(r => r.text()).then(t => {
    const m = t.match(/FRONTEND_VERSION = '([^']+)'/);
    if (m && m[1] !== FRONTEND_VERSION) { const el = document.getElementById('toast'); if (el) { el.innerHTML = 'Hay una versión nueva. <a href="' + location.pathname + '?recargar=' + Date.now() + '">Recargar</a>'; el.classList.add('ver'); } }
  }).catch(() => {});
}, 300000);

/* Biblioteca técnica GH — interfaz. Datos: /api/catalogo (armado por herramientas/indexar.py). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const ico = {
  abrir: '<svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  finder: '<svg class="i" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  copiar: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  cerrar: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  alerta: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  ok: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  imprimir: '<svg class="i" viewBox="0 0 24 24"><path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2"/><rect x="7" y="14" width="10" height="6" rx="1"/></svg>',
};
const ORG_COLOR = {
  "NIOSH": "--o-niosh", "OSHA": "--o-osha", "EPA": "--o-epa", "ASTM": "--o-astm", "IRAM": "--o-iram", "ISO": "--o-iso",
  "SRT / MTEySS": "--o-srt", "Legislación": "--o-leg", "GH": "--o-gh", "Chile (SMA)": "--o-chile", "INSST": "--o-insst",
  "GRI": "--o-gri", "NFPA": "--o-nfpa", "SAPROCEA": "--o-gri", "Bomberos SJ": "--o-nfpa", "Dpto. Hidráulica SJ": "--o-iram",
};
const colorOrg = o => `var(${ORG_COLOR[o] || "--o-otros"})`;
const ORDEN_TIPO = ["Método de referencia", "Procedimiento GH", "Legislación", "Planilla / protocolo", "Norma técnica",
  "Cadena de custodia", "Guía / manual", "Procedimiento externo", "Procedimiento / plan", "Registro / formulario",
  "Manual de equipo", "Curso", "Capacitación", "Video"];

const S = {
  cat: null, docs: [], porId: {}, calib: {}, fts: null, ftsQ: "",
  f: {area: new Set(), tipo: new Set(), org: new Set()}, viejos: false, vista: "grid", orden: "rel", q: "",
  plan: new Set(JSON.parse(localStorage.getItem("gh-bib-plan") || "[]")), jornada: 480, caudales: {}, tiempos: {},
};
try { S.vista = localStorage.getItem("gh-bib-vista") || "grid"; } catch {}

// ------------------------------------------------------------------ carga
async function cargar() {
  const cat = window.__catalogoInicial || await catalogoWeb();
  const calib = await calibracionesWeb(cat);
  window.__drivePorRuta = {};
  for (const d of cat.documentos) for (const v of [d.principal, ...d.formatos, ...d.anteriores]) for (const r of v.rutas) window.__drivePorRuta[r] = v.driveId;
  S.cat = cat; S.calib = calib;
  S.docs = cat.documentos;
  S.porId = Object.fromEntries(S.docs.map(d => [d.id, d]));
  const fecha = new Date(cat.generado);
  $("#sub").textContent = `${cat.totales.documentos} documentos · leído del Drive ${fecha.toLocaleDateString("es-AR")} ${fecha.toLocaleTimeString("es-AR", {hour: "2-digit", minute: "2-digit"})}`;
  pintarHero(); pintarFiltros(); pintarResultados(); pintarPlan(); pintarMatriz(); pintarObs();
  const h = location.hash.match(/^#doc=(\w+)/);
  if (h && S.porId[h[1]]) abrirDoc(h[1]);
}

const vigentes = () => S.docs.filter(d => !d.reemplazadoPor);

// ------------------------------------------------------------------ hero
function pintarHero() {
  const v = vigentes();
  const metodos = v.filter(d => d.tipo === "Método de referencia").length;
  const procs = v.filter(d => d.tipo === "Procedimiento GH").length;
  const leg = v.filter(d => d.tipo === "Legislación" || d.tipo === "Planilla / protocolo").length;
  const obs = observaciones().filter(o => o.nivel !== "info").length;
  $("#hero").innerHTML = `
    <div class="kpi clic" data-tipo="Método de referencia"><b>${metodos}</b><span>Métodos de referencia</span></div>
    <div class="kpi clic" data-tipo="Procedimiento GH"><b>${procs}</b><span>Procedimientos GH vigentes</span></div>
    <div class="kpi clic" data-tipo="Legislación"><b>${leg}</b><span>Normativa y protocolos</span></div>
    <div class="kpi"><b>${S.cat.totales.copias + S.cat.totales.versiones}</b><span>Copias y versiones viejas agrupadas</span></div>
    <div class="kpi clic alerta" data-ir="obs"><b>${obs}</b><span>Observaciones para revisar</span></div>`;
  $("#numobs").textContent = obs || "";
  $$("#hero .kpi.clic").forEach(k => k.onclick = () => {
    if (k.dataset.ir) return irA(k.dataset.ir);
    S.f.tipo = new Set([k.dataset.tipo]); pintarFiltros(); pintarResultados();
  });
}

// ------------------------------------------------------------------ filtros
function contar(campo) {
  const c = {};
  for (const d of S.docs) {
    if (!S.viejos && d.reemplazadoPor) continue;
    const vals = campo === "area" ? d.areas : [campo === "tipo" ? d.tipo : d.organismo];
    for (const v of vals) c[v] = (c[v] || 0) + 1;
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}
function pintarFiltros() {
  const grupo = (titulo, campo, items, conPunto) => `
    <div class="fgrupo"><h3>${titulo}</h3>${items.map(([v, n]) => `
      <button class="fitem" data-campo="${campo}" data-v="${esc(v)}" aria-pressed="${S.f[campo].has(v)}">
        ${conPunto ? `<span class="pt" style="background:${colorOrg(v)}"></span>` : ""}${esc(v)}<span class="c">${n}</span>
      </button>`).join("")}</div>`;
  const tipos = contar("tipo").sort((a, b) => ORDEN_TIPO.indexOf(a[0]) - ORDEN_TIPO.indexOf(b[0]));
  $("#filtros").innerHTML = `
    <label class="switch"><input type="checkbox" id="viejos" ${S.viejos ? "checked" : ""}> Mostrar reemplazados</label>
    ${grupo("Área", "area", contar("area"))}
    ${grupo("Tipo", "tipo", tipos)}
    ${grupo("Organismo", "org", contar("org"), true)}`;
  $("#viejos").onchange = e => { S.viejos = e.target.checked; pintarFiltros(); pintarResultados(); };
  $$("#filtros .fitem").forEach(b => b.onclick = () => {
    const s = S.f[b.dataset.campo], v = b.dataset.v;
    s.has(v) ? s.delete(v) : s.add(v);
    pintarFiltros(); pintarResultados();
  });
}

// ------------------------------------------------------------------ resultados
function filtrar() {
  const q = norm(S.q.trim());
  const palabras = q.split(/\s+/).filter(Boolean);
  let lista = S.docs.filter(d =>
    (S.viejos || !d.reemplazadoPor) &&
    (!S.f.area.size || d.areas.some(a => S.f.area.has(a))) &&
    (!S.f.tipo.size || S.f.tipo.has(d.tipo)) &&
    (!S.f.org.size || S.f.org.has(d.organismo)));
  const puntaje = {};
  if (palabras.length) {
    const fts = S.fts && S.ftsQ === S.q ? S.fts : {};
    lista = lista.filter(d => {
      const base = norm(`${d.codigo || ""} ${d.titulo} ${d.principal.nombre} ${d.organismo} ${d.tipo} ${d.areas.join(" ")}`);
      const enTitulo = palabras.every(p => base.includes(p));
      if (enTitulo) puntaje[d.id] = 1000 + (norm(d.codigo || "").includes(q) ? 500 : 0);
      else if (fts[d.id]) puntaje[d.id] = 500 - fts[d.id].pos;
      return enTitulo || fts[d.id];
    });
  }
  const tipoIdx = d => { const i = ORDEN_TIPO.indexOf(d.tipo); return i < 0 ? 99 : i; };
  const cmpCod = (a, b) => (a.codigo || "~" + a.titulo).localeCompare(b.codigo || "~" + b.titulo, "es", {numeric: true});
  if (S.orden === "cod") lista.sort(cmpCod);
  else if (S.orden === "area") lista.sort((a, b) => a.areas[0].localeCompare(b.areas[0], "es") || cmpCod(a, b));
  else if (S.orden === "nuevo") lista.sort((a, b) => (b.principal.fecha || "").localeCompare(a.principal.fecha || "") || b.principal.mtime - a.principal.mtime);
  else lista.sort((a, b) => (puntaje[b.id] || 0) - (puntaje[a.id] || 0) || tipoIdx(a) - tipoIdx(b) || cmpCod(a, b));
  return lista;
}

function etiquetaVersion(d) {
  const p = d.principal;
  const partes = [];
  if (p.etiqueta) partes.push(p.etiqueta);
  return partes.join(" · ");
}
function resaltar(texto) {
  const palabras = norm(S.q).split(/\s+/).filter(w => w.length > 1);
  let html = esc(texto);
  if (!palabras.length) return html;
  // resalta sobre el texto original, comparando sin tildes
  const plano = norm(texto);
  const marcas = [];
  for (const p of palabras) { let i = -1; while ((i = plano.indexOf(p, i + 1)) >= 0) marcas.push([i, i + p.length]); }
  if (!marcas.length) return html;
  marcas.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [a, b] of marcas) { if (a < pos) continue; out += esc(texto.slice(pos, a)) + "<mark>" + esc(texto.slice(a, b)) + "</mark>"; pos = b; }
  return out + esc(texto.slice(pos));
}
function fragmento(d) {
  const f = S.fts && S.ftsQ === S.q && S.fts[d.id];
  if (!f) return "";
  return `<div class="frag">${esc(f.fragmento).replace(/⟦/g, "<mark>").replace(/⟧/g, "</mark>")}</div>`;
}

function card(d) {
  const p = d.principal;
  const alerta = d.alertas.find(a => a.nivel === "mal") || d.alertas.find(a => a.nivel === "ojo");
  const nAnt = d.anteriores.length;
  return `<button class="card" data-id="${d.id}">
    <div class="thumb">
      ${p.mini ? `<img loading="lazy" src="/miniaturas/${p.mini}.png" alt="">` : `<span class="ext">${esc(p.ext.toUpperCase())}</span>`}
      ${d.reemplazadoPor ? '<div class="reempl"></div>' : ""}
      <div class="badges">
        ${d.codigo ? `<span class="cod" style="background:${colorOrg(d.organismo)}">${esc(d.codigo)}</span>` : ""}
        <span class="extb">${esc(p.ext.toUpperCase())}</span>
      </div>
      ${alerta ? `<span class="alertdot ${alerta.nivel}" title="${esc(alerta.texto)}">!</span>` : ""}
    </div>
    <div class="cuerpo">
      <h4>${resaltar(d.titulo)}</h4>
      ${fragmento(d)}
      <div class="meta">
        ${d.reemplazadoPor ? `<span class="chip vieja">Reemplazado por ${esc(d.reemplazadoPor)}</span>` :
          nAnt ? `<span class="chip nueva" title="Se muestra la versión más nueva">Más nueva${p.etiqueta ? " · " + esc(p.etiqueta) : ""}</span><span class="chip">+${nAnt} anterior${nAnt > 1 ? "es" : ""}</span>` :
          p.etiqueta ? `<span class="chip">${esc(p.etiqueta)}</span>` : ""}
        <span class="chip">${esc(d.areas[0])}</span>
      </div>
    </div>
  </button>`;
}
function fila(d) {
  const p = d.principal;
  return `<button class="fila" data-id="${d.id}">
    <span>${d.codigo ? `<span class="cod" style="background:${colorOrg(d.organismo)}">${esc(d.codigo)}</span>` : `<span class="chip">${esc(p.ext.toUpperCase())}</span>`}</span>
    <span class="t">${resaltar(d.titulo)}<small>${esc(p.nombre)}</small></span>
    <span class="chip" style="justify-self:start">${esc(d.areas[0])}</span>
    <span style="font-size:12px;color:var(--label-2)">${d.reemplazadoPor ? "Reemplazado" : esc(etiquetaVersion(d) || d.tipo)}${d.anteriores.length ? ` · <b style="color:var(--verde)">más nueva</b>` : ""}</span>
    <span>${d.alertas.some(a => a.nivel !== "info") ? `<span style="color:var(--rojo)">${ico.alerta}</span>` : ""}</span>
  </button>`;
}

function pintarResultados() {
  const lista = filtrar();
  const total = S.docs.filter(d => S.viejos || !d.reemplazadoPor).length;
  $("#info").innerHTML = `<b>${lista.length}</b> de ${total} documentos`;
  const activos = [...[...S.f.area].map(v => ["area", v]), ...[...S.f.tipo].map(v => ["tipo", v]), ...[...S.f.org].map(v => ["org", v])];
  $("#activos").innerHTML = activos.map(([c, v]) => `<button data-c="${c}" data-v="${esc(v)}">${esc(v)} ✕</button>`).join("");
  $$("#activos button").forEach(b => b.onclick = () => { S.f[b.dataset.c].delete(b.dataset.v); pintarFiltros(); pintarResultados(); });
  const cont = $("#resultados");
  if (!lista.length) {
    cont.innerHTML = `<div class="vacio"><b>Nada por acá</b>${S.q ? "Probá con otra palabra o sacá algún filtro." : "Sacá algún filtro."}</div>`;
    return;
  }
  cont.innerHTML = S.vista === "grid" ? `<div class="grid">${lista.map(card).join("")}</div>` : `<div class="lista">${lista.map(fila).join("")}</div>`;
  $$("[data-id]", cont).forEach(el => el.onclick = () => abrirDoc(el.dataset.id));
}

let tBusca;
$("#q").addEventListener("input", e => {
  S.q = e.target.value;
  if (!$("#v-lib").classList.contains("activa")) irA("lib");
  pintarResultados();
  clearTimeout(tBusca);
  tBusca = setTimeout(async () => {
    const q = S.q;
    if (q.trim().length < 2) { S.fts = null; return; }
    const r = [];
    if (q !== S.q) return;
    S.fts = Object.fromEntries(r.map((x, i) => [x.id, {...x, pos: i}])); S.ftsQ = q;
    pintarResultados();
  }, 220);
});
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  if (e.key === "Escape") cerrarDoc();
});
$("#orden").onchange = e => { S.orden = e.target.value; pintarResultados(); };
function setVista(v) {
  S.vista = v; try { localStorage.setItem("gh-bib-vista", v); } catch {}
  $("#vgrid").setAttribute("aria-pressed", v === "grid"); $("#vlista").setAttribute("aria-pressed", v === "lista");
  pintarResultados();
}
$("#vgrid").onclick = () => setVista("grid");
$("#vlista").onclick = () => setVista("lista");
setVista(S.vista);

// ------------------------------------------------------------------ pestañas
function irA(v) {
  $$(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === v));
  $$(".vista").forEach(s => s.classList.toggle("activa", s.id === "v-" + v));
  window.scrollTo({top: 0});
}
$$(".tabs button").forEach(b => b.onclick = () => irA(b.dataset.v));

// ------------------------------------------------------------------ panel de documento
const driveDe = rel => String(rel).startsWith("drive:") ? String(rel).slice(6) : (window.__drivePorRuta || {})[rel];
const urlDrive = rel => { const id = driveDe(rel); return id ? "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/view" : null; };
const urlArchivo = rel => urlDrive(rel) || "";
const tam = b => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
const fechaMod = t => new Date(t * 1000).toLocaleDateString("es-AR");

function visor(v) {
  const id = driveDe(v.rutas[0]);
  if (!id) return `<div class="noview"><div>Este archivo no tiene enlace de Drive todavía.</div></div>`;
  return `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(id)}/preview" title="Vista previa" allow="autoplay"></iframe>`;
}

function bloqueVersion(v, rol) {
  const chip = rol === "principal" ? '<span class="chip nueva">Más nueva · se muestra</span>' :
    rol === "formato" ? (["mp4", "avi"].includes(v.ext) ? '<span class="chip">Video relacionado</span>' : '<span class="chip">Misma versión, otro formato</span>') : '<span class="chip vieja">Anterior</span>';
  return `<div class="ver">
    <div class="ico">${v.mini ? `<img src="/miniaturas/${v.mini}.png" alt="">` : esc(v.ext.toUpperCase())}</div>
    <div class="d"><b>${esc(v.nombre)}</b>
      <small>${[v.etiqueta, v.paginas ? v.paginas + (v.ext === "pdf" ? " pág." : v.ext.startsWith("xls") ? " hojas" : " diap.") : "", tam(v.tam), "modif. " + fechaMod(v.mtime)].filter(Boolean).join(" · ")}</small>
      <div style="margin:4px 0">${chip}</div>
      <div class="rutas">${v.rutas.map(r => `<div title="${esc(r)}">📁 ${esc(r.split("/").slice(0, -1).join(" › "))}</div>`).join("")}</div>
      <button class="lnk" data-abrir="${esc(v.rutas[0])}">Abrir</button>
      ${rol !== "principal" && v.vista ? ` · <button class="lnk" data-ver="${esc(v.sha)}">Ver acá</button>` : ""}
    </div></div>`;
}

function chipDoc(id, extra = "") {
  const d = S.porId[id]; if (!d) return "";
  const comp = d.titulo.includes(" — ") ? d.titulo.split(" — ").pop() : "";
  const t = d.codigo && comp && d.clave.includes("|") ? comp : d.titulo;
  return `<button data-doc="${id}" title="${esc(d.titulo)}"><i style="background:${colorOrg(d.organismo)}"></i>${esc(d.codigo ? d.codigo + " · " : "")}${esc(t.length > 60 ? t.slice(0, 58) + "…" : t)}${extra}</button>`;
}

function parametrosDe(d) {
  if (!d.codigo && !d.clave.startsWith("G:")) return [];
  const codigo = d.clave.startsWith("G:") ? d.clave.slice(2) : d.clave.slice(2).split("|")[0];
  return S.cat.parametros.filter(p => [...p.metodos, ...p.proc, ...p.legis].some(x => x.codigo === codigo));
}

function fichaMuestreo(p) {
  const rango = (r, u) => !r ? "" : r[0] === r[1] ? `${fmt(r[0])} ${u}` : `${fmt(r[0])} – ${fmt(r[1])} ${u}`;
  const datos = [["Medio", p.medio], ["Caudal", rango(p.caudal, "L/min")], ["Volumen", rango(p.vol, "L")],
    ["Técnica", p.tecnica], ["Límite", p.limite], ["Análisis", p.lab ? "Laboratorio externo" : "En campo / GH"], ["Notas", p.notas]].filter(x => x[1]);
  return `<div class="bloque"><h5>Ficha de muestreo · ${esc(p.nombre)}</h5>
    ${datos.map(([k, v]) => `<div class="dato"><span>${k}</span><div>${esc(v)}</div></div>`).join("")}
    <div class="acc"><button class="btn chico" data-plan="${p.id}">＋ Agregar al planificador</button></div></div>`;
}

function abrirDoc(id, sha) {
  const d = S.porId[id]; if (!d) return;
  history.replaceState(null, "", "#doc=" + id);
  const todas = [d.principal, ...d.formatos, ...d.anteriores];
  const actual = (sha && todas.find(v => v.sha === sha)) || d.principal;
  const params = parametrosDe(d);
  const nuevo = d.reemplazadoPor && S.cat.porCodigo[d.reemplazadoPor];
  const reemplaza = (d.reemplazaA || []).flatMap(c => S.cat.porCodigo[c] || []);
  const relacionados = new Set();
  params.forEach(p => [...p.metodos, ...p.proc, ...p.legis].forEach(x => x.ids.forEach(i => i !== id && relacionados.add(i))));
  d.citas.forEach(c => (S.cat.porCodigo[c] || []).forEach(i => relacionados.delete(i)));
  const mismaNorma = d.codigo ? S.docs.filter(o => o.id !== id && o.codigo === d.codigo).map(o => o.id) : [];
  const citas = d.citas.flatMap(c => S.cat.porCodigo[c] || []).filter(i => i !== id);

  $("#panel").innerHTML = `
    <div class="phead">
      <div class="top">
        ${d.codigo ? `<span class="cod" style="background:${colorOrg(d.organismo)};font-size:13px">${esc(d.codigo)}</span>` : ""}
        <span class="chip">${esc(d.tipo)}</span><span class="chip">${esc(d.organismo)}</span>
        <button class="icobtn cerrar" id="cerrar" title="Cerrar (Esc)">${ico.cerrar}</button>
      </div>
      <h2>${esc(d.titulo)}</h2>
      <div class="sub">${d.areas.map(a => `<span class="chip">${esc(a)}</span>`).join("")}
        ${actual === d.principal ? (d.anteriores.length ? `<span class="chip nueva">Versión más nueva${d.principal.etiqueta ? " · " + esc(d.principal.etiqueta) : ""}</span>` : (d.principal.etiqueta ? `<span class="chip">${esc(d.principal.etiqueta)}</span>` : "")) :
          `<span class="chip vieja">Viendo una versión anterior</span> <button class="lnk" style="border:0;background:none;color:var(--accent);cursor:pointer;font-weight:600" data-ver="${esc(d.principal.sha)}">Volver a la más nueva</button>`}
      </div>
      <div class="acc">
        <button class="btn primario" data-abrir="${esc(actual.rutas[0])}">${ico.abrir} Abrir en Drive</button>
        <button class="btn" data-copiar="${esc(actual.rutas[0])}">${ico.copiar} Copiar enlace</button>
      </div>
    </div>
    <div class="pbody">
      <div class="visor">${visor(actual)}</div>
      <div class="lateral">
        ${d.reemplazadoPor ? `<div class="aviso ojo">${ico.alerta}<div><b>Reemplazado por ${esc(d.reemplazadoPor)}.</b> ${esc(d.notaLinaje || "")}
            ${nuevo ? `<div class="rel" style="margin-top:8px">${nuevo.map(i => chipDoc(i)).join("")}</div>` : ""}</div></div>` : ""}
        ${d.alertas.map(a => `<div class="aviso ${a.nivel}">${a.nivel === "info" ? ico.info : ico.alerta}<div>${esc(a.texto)}</div></div>`).join("")}
        ${d.resumen ? `<div class="bloque"><h5>De qué trata</h5><div style="font-size:13px;line-height:19px;color:var(--label-2)">${esc(d.resumen)}</div></div>` : ""}
        ${params.map(fichaMuestreo).join("")}
        <div class="bloque"><h5>Versiones y copias (${(n => n + (n === 1 ? " archivo" : " archivos"))(todas.reduce((n, v) => n + v.rutas.length, 0))})</h5>
          ${bloqueVersion(d.principal, "principal")}
          ${d.formatos.map(v => bloqueVersion(v, "formato")).join("")}
          ${d.anteriores.map(v => bloqueVersion(v, "anterior")).join("")}
        </div>
        ${reemplaza.length ? `<div class="bloque"><h5>Reemplaza a</h5><div class="rel">${reemplaza.map(i => chipDoc(i)).join("")}</div></div>` : ""}
        ${mismaNorma.length ? `<div class="bloque"><h5>Otros documentos de la misma norma</h5><div class="rel">${mismaNorma.map(i => chipDoc(i)).join("")}</div></div>` : ""}
        ${citas.length ? `<div class="bloque"><h5>Este documento cita</h5><div class="rel">${citas.map(i => chipDoc(i)).join("")}</div></div>` : ""}
        ${d.citadoPor.length ? `<div class="bloque"><h5>Lo citan</h5><div class="rel">${d.citadoPor.map(i => chipDoc(i)).join("")}</div></div>` : ""}
        ${relacionados.size ? `<div class="bloque"><h5>Se usa junto con</h5><div class="rel">${[...relacionados].slice(0, 14).map(i => chipDoc(i)).join("")}</div></div>` : ""}
      </div>
    </div>`;
  $("#panel").classList.add("abierto"); $("#velo").classList.add("abierto");
  $("#panel").setAttribute("aria-hidden", "false");
  $("#cerrar").onclick = cerrarDoc;
  cargarPdf();
  $$("#panel [data-ver]").forEach(b => b.onclick = () => abrirDoc(id, b.dataset.ver));
  $$("#panel [data-doc]").forEach(b => b.onclick = () => abrirDoc(b.dataset.doc));
  $$("#panel [data-plan]").forEach(b => b.onclick = () => { S.plan.add(b.dataset.plan); guardarPlan(); pintarPlan(); cerrarDoc(); irA("plan"); });
}
// El PDF se pasa como blob: así lo muestran tanto Chrome como el navegador integrado.
let blobActual = null;
async function cargarPdf() {
  const fr = $("#panel iframe[data-blob]");
  if (!fr) return;
  const rel = fr.dataset.blob;
  try {
    const r = await fetch(urlArchivo(rel));
    if (!r.ok) throw new Error(r.status);
    const b = await r.blob();
    if (fr.dataset.blob !== rel || !fr.isConnected) return;
    if (blobActual) URL.revokeObjectURL(blobActual);
    blobActual = URL.createObjectURL(new Blob([b], {type: "application/pdf"}));
    fr.src = blobActual;
    fr.nextElementSibling?.remove();
  } catch (e) {
    const c = fr.nextElementSibling;
    if (c) c.textContent = "No se pudo cargar la vista previa. Usá «Abrir».";
  }
}
function cerrarDoc() {
  if (!$("#panel").classList.contains("abierto")) return;
  $("#panel").classList.remove("abierto"); $("#velo").classList.remove("abierto");
  $("#panel").setAttribute("aria-hidden", "true");
  history.replaceState(null, "", location.pathname);
  setTimeout(() => { if (!$("#panel").classList.contains("abierto")) $("#panel").innerHTML = ""; }, 450);
}
$("#velo").onclick = cerrarDoc;

// acciones globales: abrir, finder, copiar, ir a documento
document.addEventListener("click", e => {
  const b = e.target.closest("[data-abrir],[data-copiar]");
  if (!b) return;
  if (b.tagName === "A") e.preventDefault();
  const rel = b.dataset.copiar || b.dataset.abrir;
  const url = urlDrive(rel);
  if (!url) { toast("Este archivo no tiene enlace de Drive"); return; }
  if (b.dataset.copiar) { navigator.clipboard.writeText(url).then(() => toast("Enlace copiado"), () => toast("No se pudo copiar")); return; }
  window.open(url, "_blank", "noopener");
});
let tToast;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("ver"); clearTimeout(tToast); tToast = setTimeout(() => el.classList.remove("ver"), 1800); }

// ------------------------------------------------------------------ planificador
const fmt = n => n == null ? "" : Number(n).toLocaleString("es-AR", {maximumFractionDigits: 3});
function guardarPlan() { try { localStorage.setItem("gh-bib-plan", JSON.stringify([...S.plan])); } catch {} }
function grupos() {
  const g = {};
  for (const p of S.cat.parametros) (g[p.grupo] ||= []).push(p);
  return g;
}
function pintarSelector(filtro = "") {
  const f = norm(filtro);
  const g = grupos();
  $("#selector").innerHTML = `
    <input type="search" id="pbusca" placeholder="Buscar parámetro…" value="${esc(filtro)}">
    ${Object.entries(g).map(([grupo, ps]) => {
      const vis = ps.filter(p => !f || norm(p.nombre + " " + grupo + " " + p.metodos.map(m => m.codigo).join(" ")).includes(f));
      if (!vis.length) return "";
      return `<h3>${esc(grupo)}</h3>${vis.map(p => `<label class="pchk"><input type="checkbox" value="${p.id}" ${S.plan.has(p.id) ? "checked" : ""}>${esc(p.nombre)}</label>`).join("")}`;
    }).join("")}`;
  const inp = $("#pbusca");
  inp.oninput = () => { const pos = inp.selectionStart; pintarSelector(inp.value); const n = $("#pbusca"); n.focus(); n.setSelectionRange(pos, pos); };
  $$("#selector input[type=checkbox]").forEach(c => c.onchange = () => {
    c.checked ? S.plan.add(c.value) : S.plan.delete(c.value); guardarPlan(); pintarHoja();
  });
}

function estadoEquipo(k) {
  const c = S.calib[k];
  if (!c) return {cls: "sin", txt: "sin dato"};
  const cls = {vigente: "vigente", "por vencer": "por", vencida: "vencida", revisar: "revisar"}[c.estado] || "sin";
  let txt = c.estado;
  if (c.vence && c.estado !== "revisar") txt += " · " + new Date(c.vence + "T12:00").toLocaleDateString("es-AR");
  return {cls, txt, c};
}
function linkDocs(lista) {
  return lista.map(x => x.ids.length ? x.ids.map(i => chipDoc(i)).join("") : `<button disabled style="opacity:.6">${esc(x.codigo)} · no está en el Drive</button>`).join("");
}
function calc(p) {
  if (!p.caudal) return "";
  const [qmin, qmax] = p.caudal;
  const q = S.caudales[p.id] ?? (qmin === qmax ? qmin : +((qmin + qmax) / 2).toFixed(3));
  const t = S.tiempos[p.id] ?? p.tiempo ?? S.jornada;
  const vol = q * t;
  let veredicto = "";
  if (p.vol) {
    const [vmin, vmax] = p.vol;
    const tmin = vmin / q, tmax = vmax / q;
    const ok = vol >= vmin && vol <= vmax;
    veredicto = `<div class="r"><span>Tiempo para el rango del método</span><b>${fmtT(tmin)} – ${fmtT(tmax)}</b></div>
      <div class="aviso ${ok ? "bien" : "ojo"}" style="margin-top:6px">${ok ? ico.ok : ico.alerta}<div>${ok ? `Con ${fmt(t)} min se juntan ${fmt(vol)} L: dentro del rango.` :
        vol > vmax ? `Con ${fmt(t)} min se juntan ${fmt(vol)} L: supera el máximo (${fmt(vmax)} L). Cambiar el medio a mitad de jornada o bajar el caudal.` :
          `Con ${fmt(t)} min se juntan ${fmt(vol)} L: no llega al mínimo (${fmt(vmin)} L). Subir caudal o tiempo.`}</div></div>`;
  }
  return `<div class="calc">
    <div class="r"><span>Caudal (${qmin === qmax ? "fijo" : fmt(qmin) + "–" + fmt(qmax)} L/min)</span><input type="number" step="any" data-caudal="${p.id}" value="${q}" ${qmin === qmax ? "readonly" : ""}></div>
    <div class="r"><span>Tiempo de muestreo (min)</span><input type="number" min="1" data-tiempo="${p.id}" value="${t}"></div>
    <div class="r"><span>Volumen juntado</span><b>${fmt(vol)} L</b></div>
    ${veredicto}</div>`;
}
const fmtT = m => m < 1 ? Math.round(m * 60) + " s" : m < 120 ? fmt(Math.round(m)) + " min" : fmt(+(m / 60).toFixed(1)) + " h";


// ------------------------------------------------------------------ muestreo compartido
// Qué parámetros pueden ir en el mismo filtro / tubo / instrumento y cuáles no (reglas en
// herramientas/compatibilidad.py, motor en web/plan.js). Siempre es una sugerencia.
S.puestos = 1;
async function asegurarMotor() {
  if (S.ix) return S.ix;
  let cat = S.cat;
  if (!cat.muestreo) {
    const extra = await fetch("/api/muestreo").then(r => r.json()).catch(() => ({}));
    if (!extra.muestreo) return null;
    cat = {...cat, muestreo: extra.muestreo, equiposCal: extra.equiposCal, ignorar: extra.ignorar,
      parametros: cat.parametros.map(p => ({...p, ...(extra.parametros[p.id] || {})}))};
  }
  S.ix = GHPlan.indexar(cat);
  return S.ix;
}
function bloqueMuestreo(sel) {
  const m = GHPlan.agruparMuestreo(S.ix, sel.map(p => p.id), {jornada: S.jornada, muestras: S.puestos});
  const nom = id => S.ix.porId[id] ? S.ix.porId[id].nombre : id;
  const r = m.resumen;
  const grupos = m.grupos.map(g => {
    const comparte = g.compartido && g.estado !== "no_compatible";
    return `<div class="bloque" style="margin-bottom:10px;${comparte ? "border-left:3px solid var(--verde)" : ""}">
      <h5>${comparte ? '<span class="chip nueva">Comparten</span> ' : ""}${esc(g.nombre)}</h5>
      <div style="font-size:13px">${g.nombresFichas.map(esc).join(" + ")}</div>
      ${g.sugerido ? `<div style="font-weight:600;margin:6px 0">Bomba a ${fmt(g.sugerido.caudal)} L/min durante ${fmt(g.sugerido.tiempo)} min = ${fmt(g.sugerido.volumen)} L</div>` : (g.bomba ? "" : '<div style="font-weight:600;margin:6px 0">Sin bomba: lectura en el momento</div>')}
      ${g.avisos.map(a => `<div class="aviso ojo">${ico.alerta}<div>${esc(a)}</div></div>`).join("")}
      ${g.notas.map(n => `<div class="aviso">${ico.info}<div>${esc(n.texto)} <small style="color:var(--label-3)">[${esc(n.fuente)}]</small></div></div>`).join("")}
    </div>`;
  }).join("");
  const no = m.noComparten.map(e => `<div style="font-size:13px;margin:5px 0"><b>${esc(nom(e.a))} / ${esc(nom(e.b))}</b> — ${esc(e.razon)} <small style="color:var(--label-3)">[${esc(e.fuente)}]</small></div>`).join("");
  const red = m.redundantes.map(e => `<div style="font-size:13px;margin:5px 0"><b>${esc(nom(e.a))}</b> ya sale con ${esc(nom(e.b))} — ${esc(e.razon)} <small style="color:var(--label-3)">[${esc(e.fuente)}]</small></div>`).join("");
  return `<div class="pcard"><div class="h"><h3>Muestreo: qué se puede compartir</h3><span class="g">sugerencia</span></div>
    <label style="font-size:13px;display:block;margin-bottom:8px">Puestos a muestrear <input type="number" id="puestos" min="1" value="${S.puestos}" style="width:64px"></label>
    <p style="font-size:13px;color:var(--label-2);margin:0 0 10px">Por puesto: <b>${r.mediosCompartiendo}</b> medio(s) de captación${r.mediosSinCompartir !== r.mediosCompartiendo ? ` en vez de ${r.mediosSinCompartir} si no se comparte` : ""} · <b>${r.bombas}</b> bomba(s) ·
      ${m.muestras} puesto(s) → ${m.muestras} medio(s) de cada tipo, más al menos <b>${m.blancos}</b> blancos de campo por lote. La decisión final es del técnico y del laboratorio.</p>
    ${grupos}${(no || red) ? `<h5 style="margin:12px 0 4px">No comparten</h5>${no}${red}` : ""}</div>`;
}

function pintarHoja() {
  const sel = S.cat.parametros.filter(p => S.plan.has(p.id));
  if (!sel.length) {
    $("#hoja").innerHTML = `<div class="hoja-head"><h2>Hoja de campo</h2></div>
      <div class="vacio bloque" style="padding:50px 20px"><b>Elegí qué vas a medir</b>Marcá los parámetros de la orden de trabajo y te armo la hoja: método, procedimiento GH vigente, medio de captación, caudales, tiempos, equipos con su calibración y cadenas de custodia.</div>`;
    return;
  }
  const equipos = [...new Set(sel.flatMap(p => p.equipos))];
  const ccs = [...new Set(sel.map(p => p.ccId).filter(Boolean))];
  const lab = sel.filter(p => p.lab);
  $("#hoja").innerHTML = `
    <div class="hoja-head">
      <h2>Hoja de campo · ${sel.length} parámetro${sel.length > 1 ? "s" : ""}</h2>
      <label>Jornada por defecto <input type="number" id="jornada" value="${S.jornada}" min="1"> min</label>
      <button class="btn noprint" id="limpiar">Limpiar</button>
      <button class="btn primario noprint" onclick="print()">${ico.imprimir} Imprimir</button>
    </div>
    ${sel.map(p => `<div class="pcard">
      <div class="h"><h3>${esc(p.nombre)}</h3><span class="g">${esc(p.grupo)}</span>${p.lab ? '<span class="chip">Laboratorio externo</span>' : ""}</div>
      <div class="pgrid">
        <div>
          ${[["Medio", p.medio], ["Técnica", p.tecnica], ["Límite", p.limite], ["Notas", p.notas]].filter(x => x[1]).map(([k, v]) => `<div class="dato"><span>${k}</span><div>${esc(v)}</div></div>`).join("")}
          <div class="dato"><span>Método</span><div class="rel">${p.metodos.length ? linkDocs(p.metodos) : '<span style="color:var(--label-3)">—</span>'}</div></div>
          <div class="dato"><span>Proc. GH</span><div class="rel">${p.proc.length ? linkDocs(p.proc) : '<span class="mc"><span class="falta">Sin procedimiento propio</span></span>'}</div></div>
          <div class="dato"><span>Normativa</span><div class="rel">${p.legis.length ? linkDocs(p.legis) : "—"}</div></div>
          <div class="dato"><span>Custodia</span><div class="rel">${p.ccId ? chipDoc(p.ccId) : "—"}</div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${calc(p)}
          ${p.equipos.length ? `<div>${p.equipos.map(k => { const e = estadoEquipo(k); return `<div class="eq"><div>${esc(S.cat.equipos[k] || k)}${e.c?.aviso ? `<small>${esc(e.c.aviso)}</small>` : ""}</div><span class="estado ${e.cls}">${esc(e.txt)}</span></div>`; }).join("")}</div>` : ""}
        </div>
      </div></div>`).join("")}
    ${S.ix ? bloqueMuestreo(sel) : ""}
    <div class="pcard"><div class="h"><h3>Para llevar</h3></div>
      <div class="check">
        ${equipos.map(k => { const e = estadoEquipo(k); return `<label><input type="checkbox"> ${esc(S.cat.equipos[k] || k)} <span class="estado ${e.cls}" style="margin-left:auto">${esc(e.txt)}</span></label>`; }).join("")}
        ${ccs.map(i => `<label><input type="checkbox"> Cadena de custodia: ${esc(S.porId[i].principal.nombre.replace(/\.xlsx?$/, ""))}</label>`).join("")}
        ${sel.some(p => p.caudal) ? "<label><input type=\"checkbox\"> Calibrador de caudal (antes y después)</label>" : ""}
        ${sel.some(p => p.id.startsWith("ruido")) ? "<label><input type=\"checkbox\"> Calibrador acústico</label>" : ""}
        ${lab.length ? `<label><input type="checkbox"> Conservadora y blancos de campo (${lab.length} parámetro${lab.length > 1 ? "s" : ""} van a laboratorio)</label>` : ""}
        <label><input type="checkbox"> GPS / coordenadas de cada punto (PEM 008)</label>
      </div></div>`;
  $("#jornada").onchange = e => { S.jornada = Math.max(1, +e.target.value || 480); pintarHoja(); };
  if ($("#puestos")) $("#puestos").onchange = e => { S.puestos = Math.max(1, +e.target.value || 1); pintarHoja(); };
  if (!S.ix && !S.motorPedido) { S.motorPedido = true; asegurarMotor().then(ix => { if (ix) pintarHoja(); }).catch(() => {}); }
  $("#limpiar").onclick = () => { S.plan.clear(); guardarPlan(); pintarSelector(); pintarHoja(); };
  $$("#hoja [data-caudal]").forEach(i => i.onchange = () => { S.caudales[i.dataset.caudal] = +i.value; pintarHoja(); });
  $$("#hoja [data-tiempo]").forEach(i => i.onchange = () => { S.tiempos[i.dataset.tiempo] = Math.max(1, +i.value || 1); pintarHoja(); });
  $$("#hoja [data-doc]").forEach(b => b.onclick = () => abrirDoc(b.dataset.doc));
}
function pintarPlan() { pintarSelector(); pintarHoja(); }

// ------------------------------------------------------------------ matriz
function pintarMatriz() {
  const ps = S.cat.parametros;
  const conProc = ps.filter(p => p.proc.some(x => x.ids.length)).length;
  const conMet = ps.filter(p => p.metodos.some(x => x.ids.length) || p.legis.some(x => x.ids.length)).length;
  const conCC = ps.filter(p => p.ccId).length;
  const eqs = [...new Set(ps.flatMap(p => p.equipos))];
  const eqOk = eqs.filter(k => S.calib[k]?.estado === "vigente").length;
  const kpi = (n, t, txt) => `<div class="kpi"><b>${n}<span style="font-size:15px;color:var(--label-3)"> / ${t}</span></b><span>${txt}</span><div class="barra"><i style="width:${Math.round(n / t * 100)}%"></i></div></div>`;
  const celda = lista => {
    if (!lista.length) return '<span class="na">—</span>';
    return lista.map(x => x.ids.length ? (() => {
        const i = x.ids.find(i => !S.porId[i].clave.includes("|")) || x.ids[0], d = S.porId[i];
        const mas = x.ids.length > 1 ? ` +${x.ids.length - 1}` : "";
        return `<button data-doc="${i}" style="background:${colorOrg(d.organismo)}" title="${esc(d.titulo)}${mas ? " (y " + (x.ids.length - 1) + " documentos más de la misma norma)" : ""}">${esc(d.codigo || x.codigo)}${d.reemplazadoPor ? " ⚠" : ""}<span style="opacity:.7">${mas}</span></button>`; })()
      : `<span class="falta" title="Citado pero no está en el Drive">${esc(x.codigo)} ✕</span>`).join("");
  };
  const g = grupos();
  $("#v-matriz").innerHTML = `
    <div class="cobertura">
      ${kpi(conMet, ps.length, "Parámetros con método o norma en el Drive")}
      ${kpi(conProc, ps.length, "Parámetros con procedimiento GH propio")}
      ${kpi(conCC, ps.length, "Parámetros con cadena de custodia")}
      ${kpi(eqOk, eqs.length, "Equipos con calibración vigente (según planilla)")}
    </div>
    <div class="mwrap"><table class="m">
      <thead><tr><th>Parámetro</th><th>Método de referencia</th><th>Procedimiento GH</th><th>Normativa</th><th>Custodia</th><th>Equipos</th></tr></thead>
      <tbody>${Object.entries(g).map(([grupo, lista]) => `<tr class="grp"><td colspan="6">${esc(grupo)}</td></tr>` + lista.map(p => `
        <tr><td class="p"><a href="#" data-p="${p.id}" style="color:inherit;text-decoration:none">${esc(p.nombre)}</a></td>
          <td><div class="mc">${celda(p.metodos)}</div></td>
          <td><div class="mc">${p.proc.length ? celda(p.proc) : '<span class="falta">Falta</span>'}</div></td>
          <td><div class="mc">${celda(p.legis)}</div></td>
          <td><div class="mc">${p.ccId ? `<button data-doc="${p.ccId}" style="background:var(--o-gh)">CC</button>` : '<span class="falta">Falta</span>'}</div></td>
          <td>${p.equipos.map(k => { const e = estadoEquipo(k); return `<div style="display:flex;gap:6px;align-items:center;justify-content:space-between;margin-bottom:3px"><span style="font-size:12px">${esc((S.cat.equipos[k] || k).split(" (")[0])}</span><span class="estado ${e.cls}">${esc(e.cls === "sin" ? "s/d" : e.c.estado)}</span></div>`; }).join("") || '<span class="na">—</span>'}</td></tr>`).join("")).join("")}
      </tbody></table></div>
    <p style="font-size:12.5px;color:var(--label-3);margin-top:10px">⚠ = el documento enlazado fue reemplazado por uno más nuevo. ✕ = citado pero el archivo no está en el Drive. Clic en un parámetro lo agrega al planificador.</p>`;
  $$("#v-matriz [data-doc]").forEach(b => b.onclick = () => abrirDoc(b.dataset.doc));
  $$("#v-matriz [data-p]").forEach(a => a.onclick = e => { e.preventDefault(); S.plan.add(a.dataset.p); guardarPlan(); pintarPlan(); irA("plan"); });
}

// ------------------------------------------------------------------ observaciones
function observaciones() {
  const o = [];
  for (const d of S.docs) for (const a of d.alertas) o.push({...a, id: d.id});
  return o;
}
function pintarObs() {
  const obs = observaciones();
  const item = x => { const d = S.porId[x.id]; return `<div class="oitem" data-doc="${x.id}"><span style="color:var(--${x.nivel === "mal" ? "rojo" : x.nivel === "ojo" ? "amarillo" : "azul"})">${x.nivel === "info" ? ico.info : ico.alerta}</span><div><span class="ot">${esc(d.codigo ? d.codigo + " · " : "")}${esc(d.principal.nombre)}</span><small>${esc(x.texto)}</small></div></div>`; };
  const mal = obs.filter(x => x.nivel === "mal"), ojo = obs.filter(x => x.nivel === "ojo");
  const cyma = obs.filter(x => x.nivel === "info" && /CyMA/.test(x.texto));
  const escaneados = obs.filter(x => x.nivel === "info" && /escaneado/.test(x.texto));
  const repetidos = S.docs.map(d => ({d, n: [d.principal, ...d.formatos, ...d.anteriores].reduce((s, v) => s + v.rutas.length, 0)})).filter(x => x.n > 2).sort((a, b) => b.n - a.n);
  const conViejas = S.docs.filter(d => d.anteriores.length);
  const faltan = [...new Set(S.cat.parametros.flatMap(p => [...p.metodos, ...p.legis]).filter(x => !x.ids.length).map(x => x.codigo))];
  const sinProc = S.cat.parametros.filter(p => !p.proc.some(x => x.ids.length));
  const calVenc = Object.entries(S.calib).filter(([, c]) => ["vencida", "revisar", "por vencer"].includes(c.estado));
  $("#v-obs").innerHTML = `<div class="obs">
    <div class="bloque"><h5 style="color:var(--rojo)">${ico.alerta} Archivos que no son lo que dicen (${mal.length})</h5>${mal.map(item).join("") || "Nada."}</div>
    <div class="bloque"><h5 style="color:var(--amarillo)">${ico.alerta} Para revisar (${ojo.length})</h5>${ojo.map(item).join("") || "Nada."}</div>
    <div class="bloque"><h5>Procedimientos reemplazados</h5>
      ${S.cat.linaje.map(l => { const v = S.cat.porCodigo[l.viejo] || [], n = S.cat.porCodigo[l.nuevo] || [];
        return `<div class="linaje"><span class="rel">${v.map(i => chipDoc(i)).join("") || esc(l.viejo)}</span><span class="flecha">→</span><span class="rel">${n.map(i => chipDoc(i)).join("") || esc(l.nuevo)}</span><small style="color:var(--label-3);flex-basis:100%">${esc(l.nota)}</small></div>`; }).join("")}
      <p style="font-size:12.5px;color:var(--label-3);margin:10px 0 0">Los reemplazados no aparecen en la biblioteca salvo que actives «Mostrar reemplazados».</p></div>
    <div class="bloque"><h5>Documentos con versiones viejas guardadas (${conViejas.length})</h5>
      <div class="rel">${conViejas.map(d => chipDoc(d.id, ` <span style="color:var(--label-3)">+${d.anteriores.length}</span>`)).join("")}</div>
      <p style="font-size:12.5px;color:var(--label-3);margin:10px 0 0">En cada uno se muestra la versión más nueva; las anteriores quedan en «Versiones y copias».</p></div>
    <div class="bloque"><h5>Calibraciones a mirar (${calVenc.length})</h5>
      ${calVenc.map(([k, c]) => `<div class="eq"><div>${esc(c.nombre)}${c.aviso ? `<small>${esc(c.aviso)}</small>` : ""}${c.certificado ? `<small><a href="#" data-abrir="${esc(c.certificado.rel)}">Último certificado: ${esc(c.certificado.nombre)}</a></small>` : ""}</div><span class="estado ${estadoEquipo(k).cls}">${esc(estadoEquipo(k).txt)}</span></div>`).join("") || "Todo vigente."}</div>
    <div class="bloque"><h5>Huecos en la biblioteca</h5>
      <div class="oitem" style="cursor:default"><span style="color:var(--rojo)">${ico.alerta}</span><div><span class="ot">Citados pero no están en el Drive</span><small>${faltan.map(esc).join(" · ") || "—"}</small></div></div>
      <div class="oitem" style="cursor:default"><span style="color:var(--amarillo)">${ico.info}</span><div><span class="ot">Parámetros sin procedimiento GH propio (${sinProc.length})</span><small>${sinProc.map(p => esc(p.nombre)).join(" · ")}</small></div></div>
      <div class="oitem" style="cursor:default"><span style="color:var(--azul)">${ico.info}</span><div><span class="ot">Métodos NIOSH de la 4ª edición</span><small>Los NIOSH del Drive son de la 4ª edición del NMAM (1994–2003). Antes de citarlos en un informe, verificar en la 5ª edición (cdc.gov/niosh/nmam) si hay un «Issue» más nuevo.</small></div></div>
    </div>
    <div class="bloque"><h5>Heredados de CyMA (${cyma.length})</h5>${cyma.map(item).join("") || "—"}</div>
    <div class="bloque"><h5>El mismo archivo en 3 o más carpetas (${repetidos.length})</h5>
      ${repetidos.slice(0, 25).map(x => `<div class="oitem" data-doc="${x.d.id}"><span style="color:var(--label-3)">${ico.copiar}</span><div><span class="ot">${esc(x.d.codigo ? x.d.codigo + " · " : "")}${esc(x.d.titulo)}</span><small>${x.n} archivos</small></div></div>`).join("")}</div>
    ${escaneados.length ? `<div class="bloque"><h5>PDF escaneados, sin texto para buscar (${escaneados.length})</h5>${escaneados.map(item).join("")}</div>` : ""}
  </div>`;
  $$("#v-obs [data-doc]").forEach(b => b.onclick = () => abrirDoc(b.dataset.doc));
}

// ------------------------------------------------------------------ arranque (lo llama el inicio de sesión)
window.__arrancarBiblioteca = () => cargar().catch(e => { $("#resultados").innerHTML = `<div class="vacio"><b>No pude cargar el catálogo</b>${esc(e.message)}.</div>`; });
