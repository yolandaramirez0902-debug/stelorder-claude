const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN (todo se guarda en Render > Environment)
//   STEL_API_KEY  → clave de la API de STEL Order
//   MCP_TOKEN     → contraseña del conector (opcional pero recomendada)
// ─────────────────────────────────────────────────────────────
const STEL_API_KEY = process.env.STEL_API_KEY;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const BASE = "https://app.stelorder.com/app/";

const RECURSOS = {
  presupuestos: "salesEstimates",
  albaranes: "salesDeliveryNotes",
  facturas: "ordinaryInvoices",
};

// ───────────── Llamadas a STEL ─────────────
async function stel(method, path, params = {}, body) {
  const url = new URL(BASE + path);
  url.searchParams.set("APIKEY", STEL_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`STEL respondió ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Lee todas las páginas (STEL devuelve 100 por defecto, máximo 500 por petición)
const cache = new Map();
async function leerTodo(path, maxPaginas = 20) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < 2 * 60 * 1000) return hit.data;

  const todos = [];
  const vistos = new Set();
  for (let p = 0; p < maxPaginas; p++) {
    const pagina = await stel("GET", path, { limit: 500, start: p * 500 });
    if (!Array.isArray(pagina) || pagina.length === 0) break;
    let nuevos = 0;
    for (const x of pagina) {
      if (!vistos.has(x.id)) { vistos.add(x.id); todos.push(x); nuevos++; }
    }
    if (nuevos === 0 || pagina.length < 500) break; // última página
  }
  cache.set(path, { t: Date.now(), data: todos });
  return todos;
}

// ───────────── Ayudas para resumir ─────────────
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fecha = (d) => (d ? String(d).slice(0, 10) : null);
const nombreDe = (c) =>
  c?.name || c?.["legal-name"] || c?.["commercial-name"] || c?.["full-name"] || `Cliente ${c?.id}`;

async function mapaClientes() {
  const clientes = await leerTodo("clients");
  return new Map(clientes.map((c) => [c.id, nombreDe(c)]));
}

function resumenDoc(d, clientes) {
  return {
    id: d.id,
    referencia: d.reference,
    fecha: fecha(d.date),
    cliente: clientes?.get(d["account-id"]) || d["account-id"],
    cliente_id: d["account-id"],
    titulo: d.title || undefined,
    total: r2(d["total-amount"]),
    cobrado: d["paid-total-amount"] !== undefined ? r2(d["paid-total-amount"]) : undefined,
    pdf: d["pdf-path"] || undefined,
  };
}

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const error = (e) => ({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });

// Líneas en formato STEL
const LineaSchema = z.object({
  articulo_id: z.number().optional().describe("ID del artículo o servicio de STEL (usa buscar_articulo)"),
  descripcion: z.string().optional().describe("Texto de la línea (obligatorio si no hay articulo_id)"),
  unidades: z.number().default(1),
  precio: z.number().optional().describe("Precio unitario sin IVA. Si se omite, se usa el del artículo"),
  iva: z.number().default(21).describe("21 general; 10 en obras de reparación/renovación de vivienda que cumplan requisitos"),
  descuento: z.number().optional().describe("% de descuento"),
});

function lineasSTEL(lineas) {
  return lineas.map((l, i) => {
    const out = {
      "line-type": "ITEM",
      order: i,
      units: l.unidades,
      "primary-tax-percentage": l.iva,
    };
    if (l.articulo_id) out["item-id"] = l.articulo_id;
    if (l.descripcion) { out["item-name"] = l.descripcion; out["item-description"] = l.descripcion; }
    if (l.precio !== undefined) out["item-base-price"] = l.precio;
    if (l.descuento) out["discount-percentage"] = l.descuento;
    return out;
  });
}

// ─────────────────────────────────────────────────────────────
// HERRAMIENTAS
// ─────────────────────────────────────────────────────────────
function createServer() {
  const server = new McpServer({ name: "stelorder-dascen", version: "2.0.0" });

  // 1. Facturas pendientes de cobro (las de verdad)
  server.tool(
    "listar_facturas_pendientes",
    "Facturas de venta con importe pendiente de cobro (total > cobrado), de más reciente a más antigua, con totales.",
    { cliente_id: z.number().optional().describe("Filtrar por un cliente concreto") },
    async ({ cliente_id }) => {
      try {
        const [facturas, clientes] = await Promise.all([leerTodo("ordinaryInvoices"), mapaClientes()]);
        const pendientes = facturas
          .filter((f) => r2(f["total-amount"]) - r2(f["paid-total-amount"]) > 0.01)
          .filter((f) => !cliente_id || f["account-id"] === cliente_id)
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .map((f) => ({ ...resumenDoc(f, clientes), pendiente: r2(f["total-amount"] - f["paid-total-amount"]) }));
        const total = r2(pendientes.reduce((s, f) => s + f.pendiente, 0));
        return json({ num_facturas: pendientes.length, total_pendiente: total, facturas: pendientes });
      } catch (e) { return error(e); }
    }
  );

  // 2. Listar presupuestos / albaranes / facturas
  server.tool(
    "listar_documentos",
    "Lista presupuestos, albaranes o facturas en resumen, más recientes primero. Permite filtrar por fechas y cliente.",
    {
      tipo: z.enum(["presupuestos", "albaranes", "facturas"]),
      desde: z.string().optional().describe("AAAA-MM-DD"),
      hasta: z.string().optional().describe("AAAA-MM-DD"),
      cliente_id: z.number().optional(),
      limite: z.number().default(30),
    },
    async ({ tipo, desde, hasta, cliente_id, limite }) => {
      try {
        const [docs, clientes] = await Promise.all([leerTodo(RECURSOS[tipo]), mapaClientes()]);
        const lista = docs
          .filter((d) => (!desde || fecha(d.date) >= desde) && (!hasta || fecha(d.date) <= hasta))
          .filter((d) => !cliente_id || d["account-id"] === cliente_id)
          .sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return json({ total_encontrados: lista.length, mostrando: Math.min(limite, lista.length),
          documentos: lista.slice(0, limite).map((d) => resumenDoc(d, clientes)) });
      } catch (e) { return error(e); }
    }
  );

  // 3. Ver un documento con sus líneas
  server.tool(
    "ver_documento",
    "Detalle de un presupuesto, albarán o factura: cliente, líneas, impuestos, totales y PDF.",
    { tipo: z.enum(["presupuestos", "albaranes", "facturas"]), id: z.number() },
    async ({ tipo, id }) => {
      try {
        const d = await stel("GET", `${RECURSOS[tipo]}/${id}`);
        const doc = Array.isArray(d) ? d[0] : d;
        const clientes = await mapaClientes();
        return json({
          ...resumenDoc(doc, clientes),
          impuestos: doc["tax-breakdown"],
          comentarios: doc.addendum || undefined,
          lineas: (doc.lines || []).filter((l) => !l.deleted).map((l) => ({
            articulo_id: l["item-id"], referencia: l["item-reference"], nombre: l["item-name"],
            descripcion: l["item-description"] || undefined, unidades: l.units,
            precio: l["item-base-price"], descuento: l["discount-percentage"] || undefined,
            iva: l["primary-tax-percentage"], total: l["total-amount"],
          })),
        });
      } catch (e) { return error(e); }
    }
  );

  // 4. Buscar clientes
  server.tool(
    "buscar_cliente",
    "Busca clientes (comunidades, empresas, particulares) por nombre, NIF, email o teléfono.",
    { texto: z.string() },
    async ({ texto }) => {
      try {
        const q = texto.toLowerCase();
        const clientes = await leerTodo("clients");
        const res = clientes
          .filter((c) => JSON.stringify([nombreDe(c), c["tax-identification-number"], c.email, c.phone, c.reference])
            .toLowerCase().includes(q))
          .slice(0, 20)
          .map((c) => ({ id: c.id, nombre: nombreDe(c), nif: c["tax-identification-number"],
            email: c.email, telefono: c.phone || c["phone-1"], referencia: c.reference }));
        return json({ encontrados: res.length, clientes: res });
      } catch (e) { return error(e); }
    }
  );

  // 5. Buscar artículos y servicios
  server.tool(
    "buscar_articulo",
    "Busca productos y servicios del catálogo (materiales, mano de obra, desplazamientos) con su precio.",
    { texto: z.string() },
    async ({ texto }) => {
      try {
        const q = texto.toLowerCase();
        const [productos, servicios] = await Promise.all([
          leerTodo("products"),
          leerTodo("services").catch(() => []),
        ]);
        const res = [...productos.map((p) => ({ ...p, _tipo: "producto" })), ...servicios.map((s) => ({ ...s, _tipo: "servicio" }))]
          .filter((p) => JSON.stringify([p.name, p.reference, p.description]).toLowerCase().includes(q))
          .slice(0, 25)
          .map((p) => ({ id: p.id, tipo: p._tipo, referencia: p.reference, nombre: p.name,
            precio: p["sales-price"] ?? p["base-price"] ?? p.price, coste: p["purchase-price"] }));
        return json({ encontrados: res.length, articulos: res });
      } catch (e) { return error(e); }
    }
  );

  // 6. Crear presupuesto (borrador)
  server.tool(
    "crear_presupuesto",
    "Crea un presupuesto en STEL Order. Antes de llamarla, enseña al usuario cliente, líneas, IVA y total y espera su OK.",
    {
      cliente_id: z.number(),
      titulo: z.string().optional(),
      lineas: z.array(LineaSchema).min(1),
      comentarios: z.string().optional().describe("Condiciones, plazos, notas visibles para el cliente"),
    },
    async ({ cliente_id, titulo, lineas, comentarios }) => {
      try {
        const body = { "account-id": cliente_id, date: new Date().toISOString(), lines: lineasSTEL(lineas) };
        if (titulo) body.title = titulo;
        if (comentarios) body.addendum = comentarios;
        const creado = await stel("POST", "salesEstimates", {}, body);
        cache.delete("salesEstimates");
        return json({ ok: true, mensaje: "Presupuesto creado en STEL Order", ...resumenDoc(Array.isArray(creado) ? creado[0] : creado) });
      } catch (e) { return error(e); }
    }
  );

  // 7. Crear albarán
  server.tool(
    "crear_albaran",
    "Crea un albarán de venta en STEL Order (trabajo realizado / material entregado). Confirma con el usuario antes.",
    {
      cliente_id: z.number(),
      titulo: z.string().optional(),
      lineas: z.array(LineaSchema).min(1),
      comentarios: z.string().optional(),
    },
    async ({ cliente_id, titulo, lineas, comentarios }) => {
      try {
        const body = { "account-id": cliente_id, date: new Date().toISOString(), lines: lineasSTEL(lineas) };
        if (titulo) body.title = titulo;
        if (comentarios) body.addendum = comentarios;
        const creado = await stel("POST", "salesDeliveryNotes", {}, body);
        cache.delete("salesDeliveryNotes");
        return json({ ok: true, mensaje: "Albarán creado en STEL Order", ...resumenDoc(Array.isArray(creado) ? creado[0] : creado) });
      } catch (e) { return error(e); }
    }
  );

  // 8. Crear factura (con doble confirmación por Verifactu)
  server.tool(
    "crear_factura",
    "Crea una factura ordinaria en STEL Order. IMPORTANTE: las facturas quedan sujetas a Verifactu y no se pueden borrar libremente. " +
      "Solo llamar después de que el usuario haya revisado el resumen y escrito explícitamente que la emita; pasar confirmado=true.",
    {
      cliente_id: z.number(),
      titulo: z.string().optional(),
      lineas: z.array(LineaSchema).min(1),
      comentarios: z.string().optional(),
      confirmado: z.boolean().describe("true solo si el usuario ha confirmado expresamente esta factura"),
    },
    async ({ cliente_id, titulo, lineas, comentarios, confirmado }) => {
      if (!confirmado) return error(new Error("Factura no creada: falta la confirmación expresa del usuario."));
      try {
        const body = { "account-id": cliente_id, date: new Date().toISOString(), lines: lineasSTEL(lineas) };
        if (titulo) body.title = titulo;
        if (comentarios) body.addendum = comentarios;
        const creado = await stel("POST", "ordinaryInvoices", {}, body);
        cache.delete("ordinaryInvoices");
        return json({ ok: true, mensaje: "Factura creada en STEL Order", ...resumenDoc(Array.isArray(creado) ? creado[0] : creado) });
      } catch (e) { return error(e); }
    }
  );

  // 9. Resumen para la gestoría
  server.tool(
    "resumen_periodo",
    "Resumen de facturación de un periodo: nº de facturas, base, IVA, total, cobrado y pendiente. Útil para la gestoría.",
    { desde: z.string().describe("AAAA-MM-DD"), hasta: z.string().describe("AAAA-MM-DD") },
    async ({ desde, hasta }) => {
      try {
        const facturas = (await leerTodo("ordinaryInvoices"))
          .filter((f) => fecha(f.date) >= desde && fecha(f.date) <= hasta);
        const iva = {};
        for (const f of facturas) for (const t of f["tax-breakdown"] || []) {
          const k = `${t["tax-name"]} ${t["tax-percentage"]}%`;
          iva[k] = iva[k] || { base: 0, cuota: 0 };
          iva[k].base = r2(iva[k].base + t["subtotal-amount"]);
          iva[k].cuota = r2(iva[k].cuota + t["total-amount"]);
        }
        const total = r2(facturas.reduce((s, f) => s + f["total-amount"], 0));
        const cobrado = r2(facturas.reduce((s, f) => s + (f["paid-total-amount"] || 0), 0));
        return json({ desde, hasta, num_facturas: facturas.length, total_facturado: total,
          cobrado, pendiente: r2(total - cobrado), desglose_impuestos: iva });
      } catch (e) { return error(e); }
    }
  );

  // 10. Consulta libre (solo lectura) para revisar campos de la API
  server.tool(
    "consultar_api",
    "Consulta de SOLO LECTURA a cualquier recurso de la API de STEL (p. ej. 'clients', 'products', 'salesEstimates/123'). " +
      "Devuelve como máximo 3 registros completos. Uso técnico para revisar campos.",
    { ruta: z.string(), parametros: z.record(z.string(), z.string()).optional() },
    async ({ ruta, parametros }) => {
      try {
        if (!/^[A-Za-z]+(\/\d+)?$/.test(ruta)) throw new Error("Ruta no válida");
        const d = await stel("GET", ruta, parametros || {});
        return json(Array.isArray(d) ? { registros: d.length, muestra: d.slice(0, 3) } : d);
      } catch (e) { return error(e); }
    }
  );

  return server;
}

// ─────────────────────────────────────────────────────────────
// SERVIDOR WEB
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

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

// Sin contraseña: solo funciona mientras MCP_TOKEN no esté configurado en Render
app.post("/mcp", (req, res) => {
  if (MCP_TOKEN) return res.status(401).json({ error: "Usa la dirección con contraseña" });
  return manejar(req, res);
});

app.get("/", (_req, res) => res.send("Conector STEL Order de Dascen activo"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor MCP escuchando en puerto " + PORT));
