const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// ═════════════════════════════════════════════════════════════
//  CONECTOR STEL ORDER · ELEVADORS DASCEN · v3 (acceso completo)
//  Variables en Render > Environment:
//    STEL_API_KEY → clave de la API de STEL Order
//    MCP_TOKEN    → contraseña del conector (MUY recomendada)
// ═════════════════════════════════════════════════════════════
const STEL_API_KEY = process.env.STEL_API_KEY;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const BASE = "https://app.stelorder.com/app/";

// Recursos conocidos de la API de STEL (se pueden usar otros si existen)
const RECURSOS_CONOCIDOS = {
  clients: "Clientes", potentialClients: "Clientes potenciales", suppliers: "Proveedores",
  employees: "Empleados", addresses: "Direcciones", assets: "Activos (aparatos/vehículos)",
  products: "Productos", services: "Servicios", productCategories: "Categorías de producto",
  rates: "Tarifas", warehouses: "Almacenes",
  salesEstimates: "Presupuestos", salesOrders: "Pedidos de venta",
  salesDeliveryNotes: "Albaranes de venta", ordinaryInvoices: "Facturas",
  refundInvoices: "Facturas rectificativas", ordinaryInvoiceReceipts: "Cobros de facturas",
  refundInvoiceReceipts: "Cobros de rectificativas",
  workEstimates: "Presupuestos de trabajo", workOrders: "Órdenes de trabajo",
  workDeliveryNotes: "Partes / albaranes de trabajo", incidents: "Incidencias (SAT)",
  events: "Agenda / eventos", calendars: "Calendarios",
  purchaseOrders: "Pedidos a proveedor", purchaseDeliveryNotes: "Albaranes de compra",
  purchaseInvoices: "Facturas de compra", purchaseInvoiceReceipts: "Pagos a proveedores",
  expenses: "Gastos", documentStates: "Estados de documento", paymentOptions: "Formas de pago",
  paymentTerms: "Plazos de pago", taxLines: "Impuestos", bankAccounts: "Cuentas bancarias",
  serialNumbers: "Series de numeración",
};
const ALIAS = {
  presupuestos: "salesEstimates", pedidos: "salesOrders", albaranes: "salesDeliveryNotes",
  facturas: "ordinaryInvoices", rectificativas: "refundInvoices", cobros: "ordinaryInvoiceReceipts",
  clientes: "clients", proveedores: "suppliers", productos: "products", servicios: "services",
  incidencias: "incidents", agenda: "events", activos: "assets", gastos: "expenses",
  ordenes_trabajo: "workOrders", partes_trabajo: "workDeliveryNotes",
};
// Recursos que NO se pueden borrar desde Claude (Verifactu / contabilidad)
const NO_BORRAR = new Set(["ordinaryInvoices", "refundInvoices", "ordinaryInvoiceReceipts", "refundInvoiceReceipts"]);

const recurso = (r) => {
  const k = ALIAS[String(r).toLowerCase()] || r;
  if (!/^[A-Za-z]+$/.test(k)) throw new Error("Nombre de recurso no válido: " + r);
  return k;
};

// ───────────── Llamadas a STEL ─────────────
async function stel(method, path, params = {}, body) {
  const url = new URL(BASE + path);
  url.searchParams.set("APIKEY", STEL_API_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`STEL respondió ${res.status}: ${text.slice(0, 800)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const uno = (d) => (Array.isArray(d) ? d[0] : d);

// Lee todas las páginas (máx. 500 por petición) con caché de 2 minutos
const cache = new Map();
async function leerTodo(path, params = {}, maxPaginas = 40) {
  const key = path + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 2 * 60 * 1000) return hit.data;
  const todos = [], vistos = new Set();
  for (let p = 0; p < maxPaginas; p++) {
    const pagina = await stel("GET", path, { ...params, limit: 500, start: p * 500 });
    if (!Array.isArray(pagina) || pagina.length === 0) break;
    let nuevos = 0;
    for (const x of pagina) if (!vistos.has(x.id)) { vistos.add(x.id); todos.push(x); nuevos++; }
    if (nuevos === 0 || pagina.length < 500) break;
  }
  cache.set(key, { t: Date.now(), data: todos });
  return todos;
}
const invalidar = (path) => { for (const k of cache.keys()) if (k.startsWith(path)) cache.delete(k); };

// ───────────── Utilidades ─────────────
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fecha = (d) => (d ? String(d).slice(0, 10) : null);
const nombreDe = (c) => c?.name || c?.["legal-name"] || c?.["commercial-name"] || `Cliente ${c?.id}`;
const MAX_CHARS = 90000;
function json(obj) {
  let text = JSON.stringify(obj, null, 1);
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) +
      "\n…[RESPUESTA RECORTADA: demasiados datos. Usa filtros (buscar, desde/hasta, campos) o un límite menor]";
  }
  return { content: [{ type: "text", text }] };
}
const error = (e) => ({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });
const pick = (o, campos) => (campos?.length ? Object.fromEntries(campos.filter((k) => k in o).map((k) => [k, o[k]])) : o);
// Quita campos de solo lectura antes de volver a crear un registro
const SOLO_LECTURA = /(^id$|-path$|^path$|creation-date|utc-last-modification-date|full-reference|pdf-path|verifactu|^receipts$|email-.*-date|email-read-count|email-sent)/;
const limpiar = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !SOLO_LECTURA.test(k)));

// RAE (Dascen lo guarda en Fax y/o Comentarios del cliente)
function extraerRae(txt) {
  if (!txt) return null;
  const m = String(txt).match(/RAE[\s.:\-–nº°]*([0-9A-Z][0-9A-Z.\-\/]*[0-9A-Z])/i);
  return m ? "RAE " + m[1].trim() : null;
}
const normRae = (r) => String(r || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
function fichaCliente(c) {
  const dir = c["main-address"] || {};
  return {
    id: c.id, nombre: nombreDe(c), razon_social: c["legal-name"] || undefined,
    nif: c["tax-identification-number"] || undefined,
    direccion: [dir["address-data"], dir["postal-code"], dir["city-town"]].filter(Boolean).join(", ") || undefined,
    email: c.email || undefined, telefono: c.phone || undefined, telefono2: c.phone2 || undefined,
    rae: extraerRae(c.fax) || extraerRae(c.comments) || undefined,
    comentarios: c.comments || undefined, referencia: c["full-reference"] || c.reference,
  };
}
async function mapaClientes() {
  return new Map((await leerTodo("clients")).map((c) => [c.id, nombreDe(c)]));
}
function resumenDoc(d, clientes) {
  return {
    id: d.id, referencia: d["full-reference"] || d.reference, fecha: fecha(d.date),
    cliente: clientes?.get(d["account-id"]) || d["account-id"], cliente_id: d["account-id"],
    titulo: d.title || undefined, total: r2(d["total-amount"]),
    cobrado: d["paid-total-amount"] !== undefined ? r2(d["paid-total-amount"]) : undefined,
    enviado_a: d["email-sent-to"] || undefined, enviado_el: fecha(d["email-sent-date"]) || undefined,
    leido: d["email-read-count"] ? `sí (${d["email-read-count"]} veces)` : undefined,
  };
}

// ───────────── Historial de cambios hechos desde Claude (para deshacer) ─────────────
// Se guarda en memoria: se pierde si Render reinicia el servidor.
const historial = [];
let nextOp = 1;
function registrar(accion, rec, id, antes, despues) {
  const op = { op: nextOp++, fecha: new Date().toISOString(), accion, recurso: rec, id, antes, despues };
  historial.push(op);
  if (historial.length > 300) historial.shift();
  return op.op;
}

// Líneas de documento en español → formato STEL
const LineaSchema = z.object({
  articulo_id: z.number().optional().describe("ID de producto/servicio de STEL (buscar_articulo)"),
  descripcion: z.string().optional().describe("Texto de la línea (obligatorio si no hay articulo_id)"),
  unidades: z.number().default(1),
  precio: z.number().optional().describe("Precio unitario sin IVA. Si se omite, el del artículo"),
  iva: z.number().default(21).describe("21 general; 10 en reparación/renovación de vivienda con requisitos"),
  descuento: z.number().optional(),
});
const lineasSTEL = (lineas) => lineas.map((l, i) => {
  const o = { "line-type": "ITEM", order: i, units: l.unidades, "primary-tax-percentage": l.iva };
  if (l.articulo_id) o["item-id"] = l.articulo_id;
  if (l.descripcion) { o["item-name"] = l.descripcion; o["item-description"] = l.descripcion; }
  if (l.precio !== undefined) o["item-base-price"] = l.precio;
  if (l.descuento) o["discount-percentage"] = l.descuento;
  return o;
});

const CONFIRMAR = z.boolean().describe(
  "true SOLO si el usuario ha visto exactamente qué se va a hacer y lo ha aprobado de forma expresa en el chat");

// ═════════════════════════════════════════════════════════════
//  HERRAMIENTAS
// ═════════════════════════════════════════════════════════════
function createServer() {
  const server = new McpServer({ name: "stelorder-dascen", version: "3.0.0" });

  // ─────────── A. ACCESO COMPLETO (cualquier recurso) ───────────

  server.tool(
    "recursos_disponibles",
    "Comprueba qué secciones de STEL Order están accesibles por la API (clientes, facturas, incidencias, agenda…) y qué campos tiene cada una. Usar al empezar o si un recurso falla.",
    {},
    async () => {
      const out = [];
      for (const [r, nombre] of Object.entries(RECURSOS_CONOCIDOS)) {
        try {
          const d = await stel("GET", r, { limit: 1 });
          const ej = Array.isArray(d) ? d[0] : d;
          out.push({ recurso: r, nombre, accesible: true, campos: ej ? Object.keys(ej) : [] });
        } catch (e) {
          out.push({ recurso: r, nombre, accesible: false, motivo: e.message.slice(0, 120) });
        }
      }
      return json(out);
    }
  );

  server.tool(
    "listar",
    "Lee registros de CUALQUIER sección de STEL (p. ej. clients, salesEstimates, salesDeliveryNotes, ordinaryInvoices, incidents, events, assets, expenses, purchaseInvoices…; también alias en español: presupuestos, albaranes, facturas, incidencias, agenda). " +
      "Lee todas las páginas. Permite buscar texto, filtrar por fechas, elegir campos y ordenar. Para ver un registro entero usa 'ver'.",
    {
      recurso: z.string(),
      buscar: z.string().optional().describe("Texto a buscar en cualquier campo del registro"),
      desde: z.string().optional().describe("AAAA-MM-DD"),
      hasta: z.string().optional().describe("AAAA-MM-DD"),
      campo_fecha: z.string().default("date").describe("date | creation-date | utc-last-modification-date"),
      cliente_id: z.number().optional(),
      campos: z.array(z.string()).optional().describe("Campos a devolver (vacío = todos)"),
      filtros_stel: z.record(z.string(), z.string()).optional().describe("Parámetros de filtro nativos de la API de STEL"),
      limite: z.number().default(50),
    },
    async ({ recurso: r, buscar, desde, hasta, campo_fecha, cliente_id, campos, filtros_stel, limite }) => {
      try {
        const rec = recurso(r);
        let lista = await leerTodo(rec, filtros_stel || {});
        if (buscar) { const q = buscar.toLowerCase(); lista = lista.filter((x) => JSON.stringify(x).toLowerCase().includes(q)); }
        if (desde || hasta) {
          lista = lista.filter((x) => {
            const f = fecha(x[campo_fecha] ?? x.date ?? x["creation-date"]);
            return f && (!desde || f >= desde) && (!hasta || f <= hasta);
          });
        }
        if (cliente_id) lista = lista.filter((x) => x["account-id"] === cliente_id);
        lista.sort((a, b) => String(b[campo_fecha] ?? b["creation-date"] ?? "").localeCompare(String(a[campo_fecha] ?? a["creation-date"] ?? "")));
        const defecto = ["id", "full-reference", "reference", "name", "legal-name", "title", "date", "account-id", "total-amount",
          "paid-total-amount", "document-state-id", "description", "email-sent-to", "email-sent-date", "utc-last-modification-date"];
        const sel = campos?.length ? campos : defecto;
        return json({ recurso: rec, total_encontrados: lista.length, mostrando: Math.min(limite, lista.length),
          registros: lista.slice(0, limite).map((x) => pick(x, sel)) });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "ver",
    "Muestra un registro COMPLETO de cualquier sección de STEL, con todos sus campos (líneas, importes, estados, emails enviados, PDF, etc.).",
    { recurso: z.string(), id: z.number() },
    async ({ recurso: r, id }) => {
      try { return json(uno(await stel("GET", `${recurso(r)}/${id}`))); } catch (e) { return error(e); }
    }
  );

  server.tool(
    "crear",
    "Crea un registro en cualquier sección de STEL (cliente, incidencia, evento de agenda, gasto, producto, etc.) enviando los campos en formato STEL. " +
      "ANTES: enseña al usuario los datos exactos y pide su OK. Para presupuestos/albaranes/facturas es más fácil usar las herramientas específicas.",
    { recurso: z.string(), datos: z.record(z.string(), z.any()), confirmado: CONFIRMAR },
    async ({ recurso: r, datos, confirmado }) => {
      if (!confirmado) return error(new Error("No creado: falta la confirmación expresa del usuario."));
      try {
        const rec = recurso(r);
        const creado = uno(await stel("POST", rec, {}, datos));
        invalidar(rec);
        const op = registrar("crear", rec, creado?.id, null, creado);
        return json({ ok: true, operacion: op, recurso: rec, id: creado?.id, creado });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "modificar",
    "Modifica campos de un registro existente de STEL (cualquier sección). Envía solo los campos a cambiar. Guarda los valores anteriores para poder deshacer. " +
      "ANTES: enseña al usuario qué campos cambian (antes → después) y pide su OK.",
    { recurso: z.string(), id: z.number(), cambios: z.record(z.string(), z.any()), confirmado: CONFIRMAR },
    async ({ recurso: r, id, cambios, confirmado }) => {
      if (!confirmado) return error(new Error("No modificado: falta la confirmación expresa del usuario."));
      try {
        const rec = recurso(r);
        const previo = uno(await stel("GET", `${rec}/${id}`));
        const antes = Object.fromEntries(Object.keys(cambios).map((k) => [k, previo?.[k] ?? null]));
        const despues = uno(await stel("PUT", `${rec}/${id}`, {}, cambios));
        invalidar(rec);
        const op = registrar("modificar", rec, id, antes, cambios);
        return json({ ok: true, operacion: op, recurso: rec, id, antes, despues: pick(despues || {}, Object.keys(cambios)) });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "eliminar",
    "Elimina un registro de STEL. Las facturas, rectificativas y cobros NO se pueden borrar (Verifactu/contabilidad): para anular una factura se hace una rectificativa. " +
      "Guarda una copia para poder deshacer. ANTES: enseña al usuario qué se borra y pide su OK.",
    { recurso: z.string(), id: z.number(), confirmado: CONFIRMAR },
    async ({ recurso: r, id, confirmado }) => {
      if (!confirmado) return error(new Error("No eliminado: falta la confirmación expresa del usuario."));
      try {
        const rec = recurso(r);
        if (NO_BORRAR.has(rec)) throw new Error("Bloqueado: las facturas y cobros no se borran desde Claude. Usa una factura rectificativa.");
        const copia = uno(await stel("GET", `${rec}/${id}`));
        await stel("DELETE", `${rec}/${id}`);
        invalidar(rec);
        const op = registrar("eliminar", rec, id, copia, null);
        return json({ ok: true, operacion: op, eliminado: { recurso: rec, id } });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "historial_cambios",
    "Lista los cambios hechos desde Claude (crear, modificar, eliminar) con su número de operación, para revisarlos o deshacerlos. Se reinicia si el servidor se reinicia.",
    {},
    async () => json(historial.map(({ op, fecha: f, accion, recurso: rec, id, antes }) =>
      ({ op, fecha: f, accion, recurso: rec, id, valores_anteriores: accion === "modificar" ? antes : undefined })).reverse())
  );

  server.tool(
    "deshacer",
    "Deshace una operación hecha desde Claude: si se creó, la borra; si se modificó, restaura los valores anteriores; si se eliminó, la vuelve a crear (con un ID nuevo). " +
      "ANTES: explica al usuario qué se va a deshacer y pide su OK.",
    { operacion: z.number(), confirmado: CONFIRMAR },
    async ({ operacion, confirmado }) => {
      if (!confirmado) return error(new Error("No deshecho: falta la confirmación expresa del usuario."));
      try {
        const op = historial.find((h) => h.op === operacion);
        if (!op) throw new Error("Operación no encontrada (puede que el servidor se haya reiniciado).");
        if (!["crear", "modificar", "eliminar"].includes(op.accion)) throw new Error("Esta operación no se puede deshacer (un email enviado no se puede recuperar).");
        let resultado;
        if (op.accion === "crear") {
          if (NO_BORRAR.has(op.recurso)) throw new Error("No se puede borrar una factura/cobro. Haz una rectificativa.");
          await stel("DELETE", `${op.recurso}/${op.id}`);
          resultado = "Registro creado eliminado";
        } else if (op.accion === "modificar") {
          await stel("PUT", `${op.recurso}/${op.id}`, {}, op.antes);
          resultado = "Valores anteriores restaurados";
        } else if (op.accion === "eliminar") {
          const nuevo = uno(await stel("POST", op.recurso, {}, limpiar(op.antes)));
          resultado = `Registro recreado con nuevo id ${nuevo?.id}`;
        }
        invalidar(op.recurso);
        registrar("deshacer", op.recurso, op.id, null, { deshace_operacion: op.op });
        return json({ ok: true, resultado });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "cambios_recientes",
    "Todo lo que se ha creado o modificado en STEL (desde STEL, la app móvil o Claude) a partir de una fecha: documentos, clientes, incidencias, cobros, envíos por email… Ideal para 'qué ha pasado hoy/esta semana'.",
    {
      desde: z.string().describe("AAAA-MM-DD"),
      recursos: z.array(z.string()).optional().describe("Secciones a revisar (vacío = las principales)"),
    },
    async ({ desde, recursos }) => {
      try {
        const lista = (recursos?.length ? recursos : ["clients", "salesEstimates", "salesOrders", "salesDeliveryNotes",
          "ordinaryInvoices", "refundInvoices", "ordinaryInvoiceReceipts", "incidents", "workOrders", "events",
          "purchaseInvoices", "expenses", "products", "services", "assets"]).map(recurso);
        const clientes = await mapaClientes();
        const out = {};
        for (const rec of lista) {
          try {
            const regs = (await leerTodo(rec)).filter((x) => fecha(x["utc-last-modification-date"]) >= desde);
            if (!regs.length) continue;
            out[rec] = regs
              .sort((a, b) => String(b["utc-last-modification-date"]).localeCompare(String(a["utc-last-modification-date"])))
              .slice(0, 60)
              .map((x) => ({
                id: x.id, ref: x["full-reference"] || x.reference, nombre: x.name || x.title || x.description || undefined,
                cliente: x["account-id"] ? clientes.get(x["account-id"]) || x["account-id"] : undefined,
                total: x["total-amount"] !== undefined ? r2(x["total-amount"]) : undefined,
                nuevo: fecha(x["creation-date"]) >= desde,
                modificado: x["utc-last-modification-date"],
                email_enviado: x["email-sent-date"] && fecha(x["email-sent-date"]) >= desde ? x["email-sent-to"] : undefined,
              }));
          } catch (e) { out[rec] = { error: e.message.slice(0, 120) }; }
        }
        return json({ desde, cambios: out });
      } catch (e) { return error(e); }
    }
  );

  // ─────────── B. CLIENTES Y RAE ───────────

  server.tool(
    "buscar_cliente",
    "Busca clientes por nombre, razón social, NIF, email, teléfono, dirección, RAE o comentarios. Devuelve la ficha resumida con su RAE.",
    { texto: z.string() },
    async ({ texto }) => {
      try {
        const q = texto.toLowerCase();
        const res = (await leerTodo("clients")).filter((c) => !c.deleted)
          .filter((c) => JSON.stringify([nombreDe(c), c["legal-name"], c["tax-identification-number"], c.email, c.phone,
            c.phone2, c.reference, c.fax, c.comments, c["main-address"]?.["address-data"], c["main-address"]?.["city-town"]])
            .toLowerCase().includes(q))
          .slice(0, 25).map(fichaCliente);
        return json({ encontrados: res.length, clientes: res });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "informe_clientes",
    "Todos los clientes activos con ficha resumida (nombre, razón social, NIF, dirección, email, teléfonos, RAE, comentarios) y control de RAE: cuántos lo tienen y dónde no coincide entre Fax y Comentarios.",
    { solo_con_rae: z.boolean().default(false) },
    async ({ solo_con_rae }) => {
      try {
        const clientes = (await leerTodo("clients")).filter((c) => !c.deleted);
        const fichas = clientes.map(fichaCliente);
        const conRae = fichas.filter((f) => f.rae);
        const incoherentes = clientes.map((c) => ({ c, f: extraerRae(c.fax), m: extraerRae(c.comments) }))
          .filter(({ f, m }) => f && m && normRae(f) !== normRae(m))
          .map(({ c, f, m }) => ({ id: c.id, nombre: nombreDe(c), rae_fax: f, rae_comentarios: m }));
        return json({ total_clientes: fichas.length, con_rae: conRae.length, sin_rae: fichas.length - conRae.length,
          rae_distinto_fax_vs_comentarios: incoherentes, clientes: solo_con_rae ? conRae : fichas });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "buscar_articulo",
    "Busca productos y servicios del catálogo (materiales, mano de obra, desplazamientos, mantenimientos) con precio.",
    { texto: z.string() },
    async ({ texto }) => {
      try {
        const q = texto.toLowerCase();
        const [p, s] = await Promise.all([leerTodo("products"), leerTodo("services").catch(() => [])]);
        const res = [...p.map((x) => ({ ...x, _t: "producto" })), ...s.map((x) => ({ ...x, _t: "servicio" }))]
          .filter((x) => !x.deleted && JSON.stringify([x.name, x.reference, x["full-reference"], x.description]).toLowerCase().includes(q))
          .slice(0, 30)
          .map((x) => ({ id: x.id, tipo: x._t, referencia: x["full-reference"] || x.reference, nombre: x.name,
            descripcion: x.description || undefined, precio: x["sales-price"] ?? x.price, iva: x["primary-tax-percentage"] }));
        return json({ encontrados: res.length, articulos: res });
      } catch (e) { return error(e); }
    }
  );

  // ─────────── C. DOCUMENTOS DE VENTA (atajos en español) ───────────

  const crearDoc = (rec, etiqueta) => async ({ cliente_id, titulo, lineas, comentarios, confirmado }) => {
    if (!confirmado) return error(new Error(`${etiqueta} no creado: falta la confirmación expresa del usuario.`));
    try {
      const body = { "account-id": cliente_id, date: new Date().toISOString(), lines: lineasSTEL(lineas) };
      if (titulo) body.title = titulo;
      if (comentarios) body.addendum = comentarios;
      const creado = uno(await stel("POST", rec, {}, body));
      invalidar(rec);
      const op = registrar("crear", rec, creado?.id, null, creado);
      return json({ ok: true, operacion: op, mensaje: `${etiqueta} creado en STEL Order`, ...resumenDoc(creado), pdf: creado?.["pdf-path"] });
    } catch (e) { return error(e); }
  };
  const docSchema = {
    cliente_id: z.number(), titulo: z.string().optional(), lineas: z.array(LineaSchema).min(1),
    comentarios: z.string().optional().describe("Condiciones, notas o RAE visibles en el documento"),
    confirmado: CONFIRMAR,
  };

  server.tool("crear_presupuesto",
    "Crea un presupuesto en STEL. ANTES: enseña cliente, líneas, IVA y total y espera el OK del usuario.",
    docSchema, crearDoc("salesEstimates", "Presupuesto"));
  server.tool("crear_albaran",
    "Crea un albarán de venta en STEL (trabajo realizado / material). ANTES: enseña el resumen y espera el OK.",
    docSchema, crearDoc("salesDeliveryNotes", "Albarán"));
  server.tool("crear_factura",
    "Crea una factura ordinaria en STEL. Queda sujeta a Verifactu y NO se puede borrar: solo con OK expreso del usuario tras revisar el resumen.",
    docSchema, crearDoc("ordinaryInvoices", "Factura"));

  // ─────────── D. COBROS Y CONTABILIDAD ───────────

  server.tool(
    "listar_facturas_pendientes",
    "Facturas con importe pendiente de cobro, de más reciente a más antigua, con total pendiente y si se enviaron por email.",
    { cliente_id: z.number().optional() },
    async ({ cliente_id }) => {
      try {
        const [facturas, clientes] = await Promise.all([leerTodo("ordinaryInvoices"), mapaClientes()]);
        const pend = facturas.filter((f) => !f.deleted && r2(f["total-amount"]) - r2(f["paid-total-amount"]) > 0.01)
          .filter((f) => !cliente_id || f["account-id"] === cliente_id)
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .map((f) => ({ ...resumenDoc(f, clientes), pendiente: r2(f["total-amount"] - f["paid-total-amount"]) }));
        return json({ num_facturas: pend.length, total_pendiente: r2(pend.reduce((s, f) => s + f.pendiente, 0)), facturas: pend });
      } catch (e) { return error(e); }
    }
  );

  server.tool(
    "resumen_periodo",
    "Resumen de facturación de un periodo para la gestoría: nº facturas, total, cobrado, pendiente y desglose de IVA; incluye rectificativas y facturas de compra si existen.",
    { desde: z.string(), hasta: z.string() },
    async ({ desde, hasta }) => {
      try {
        const enRango = (x) => !x.deleted && fecha(x.date) >= desde && fecha(x.date) <= hasta;
        const resumir = (docs) => {
          const iva = {};
          for (const f of docs) for (const t of f["tax-breakdown"] || []) {
            const k = `${t["tax-name"]} ${t["tax-percentage"]}%`;
            iva[k] = iva[k] || { base: 0, cuota: 0 };
            iva[k].base = r2(iva[k].base + t["subtotal-amount"]);
            iva[k].cuota = r2(iva[k].cuota + t["total-amount"]);
          }
          const total = r2(docs.reduce((s, f) => s + (f["total-amount"] || 0), 0));
          const pagado = r2(docs.reduce((s, f) => s + (f["paid-total-amount"] || 0), 0));
          return { num: docs.length, total, cobrado_pagado: pagado, pendiente: r2(total - pagado), iva };
        };
        const ventas = (await leerTodo("ordinaryInvoices")).filter(enRango);
        const rect = (await leerTodo("refundInvoices").catch(() => [])).filter(enRango);
        const compras = (await leerTodo("purchaseInvoices").catch(() => [])).filter(enRango);
        return json({ desde, hasta, facturas_venta: resumir(ventas), rectificativas: resumir(rect), facturas_compra: resumir(compras) });
      } catch (e) { return error(e); }
    }
  );

  // ─────────── E. ENVIAR DOCUMENTOS POR EMAIL (desde info@dascen.com) ───────────

  server.tool(
    "enviar_documento",
    "Envía por email un presupuesto, albarán, factura (o cualquier documento de STEL con PDF) desde el correo de Dascen, con el PDF adjunto, " +
      "y deja anotado en STEL (nota interna del documento) a quién y cuándo se envió. Opcionalmente guarda el email en la ficha del cliente. " +
      "ANTES: pregunta al usuario el correo de destino, enséñale asunto y mensaje, y espera su OK.",
    {
      recurso: z.string().describe("presupuestos | albaranes | facturas | otro recurso de STEL"),
      id: z.number(),
      para: z.string().describe("Email(s) de destino, separados por comas"),
      cc: z.string().optional(),
      asunto: z.string(),
      mensaje: z.string().describe("Texto del email"),
      guardar_email_en_cliente: z.boolean().default(false).describe("true = guardar 'para' como email del cliente en STEL"),
      confirmado: CONFIRMAR,
    },
    async ({ recurso: r, id, para, cc, asunto, mensaje, guardar_email_en_cliente, confirmado }) => {
      if (!confirmado) return error(new Error("No enviado: falta la confirmación expresa del usuario."));
      try {
        const transporte = correo();
        const rec = recurso(r);
        const doc = uno(await stel("GET", `${rec}/${id}`));
        if (!doc) throw new Error("Documento no encontrado");
        const adjuntos = [];
        if (doc["pdf-path"]) {
          const pdf = await fetch(doc["pdf-path"]);
          if (pdf.ok) adjuntos.push({
            filename: `${(RECURSOS_CONOCIDOS[rec] || "Documento").replace(/[^\wáéíóúñ ]/gi, "")} ${doc["full-reference"] || doc.reference || id}.pdf`,
            content: Buffer.from(await pdf.arrayBuffer()), contentType: "application/pdf",
          });
        }
        await transporte.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER, to: para, cc, subject: asunto,
          text: mensaje, attachments: adjuntos,
        });
        // Dejar constancia en STEL
        const ahora = new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
        const nota = `[${ahora}] Enviado por email desde Claude a: ${para}${cc ? " (cc " + cc + ")" : ""} · Asunto: ${asunto}`;
        let anotado = true;
        try {
          await stel("PUT", `${rec}/${id}`, {}, { "private-comments": [doc["private-comments"], nota].filter(Boolean).join("\n") });
        } catch { anotado = false; }
        let email_guardado;
        if (guardar_email_en_cliente && doc["account-id"]) {
          const cli = uno(await stel("GET", `clients/${doc["account-id"]}`));
          await stel("PUT", `clients/${doc["account-id"]}`, {}, { email: para.split(",")[0].trim() });
          registrar("modificar", "clients", doc["account-id"], { email: cli?.email ?? null }, { email: para });
          invalidar("clients");
          email_guardado = para.split(",")[0].trim();
        }
        invalidar(rec);
        registrar("email", rec, id, null, { para, cc, asunto });
        return json({ ok: true, enviado_a: para, cc, pdf_adjunto: adjuntos.length > 0,
          anotado_en_stel: anotado, nota: anotado ? nota : "No se pudo escribir la nota en STEL", email_guardado_en_cliente: email_guardado });
      } catch (e) { return error(e); }
    }
  );

  return server;
}

// Correo saliente (SMTP de info@dascen.com) — variables en Render:
//   SMTP_HOST, SMTP_PORT (465 o 587), SMTP_USER, SMTP_PASS, SMTP_FROM (p. ej. "Elevadors Dascen <info@dascen.com>")
let _transporte;
function correo() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("El envío de emails no está configurado: faltan SMTP_HOST, SMTP_USER y SMTP_PASS en Render.");
  }
  if (!_transporte) {
    const nodemailer = require("nodemailer");
    const port = Number(process.env.SMTP_PORT || 465);
    _transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transporte;
}

// ═════════════════════════════════════════════════════════════
//  SERVIDOR WEB
// ═════════════════════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: "5mb" }));

async function manejar(req, res) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Con contraseña: https://stelorder-claude.onrender.com/mcp/TU_CONTRASEÑA
app.post("/mcp/:token", (req, res) => {
  if (!MCP_TOKEN || req.params.token !== MCP_TOKEN) return res.status(401).json({ error: "No autorizado" });
  return manejar(req, res);
});
// Sin contraseña: solo mientras MCP_TOKEN no esté configurado en Render
app.post("/mcp", (req, res) => {
  if (MCP_TOKEN) return res.status(401).json({ error: "Usa la dirección con contraseña" });
  return manejar(req, res);
});
app.get("/", (_req, res) => res.send("Conector STEL Order de Dascen activo (v3)"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor MCP escuchando en puerto " + PORT));
