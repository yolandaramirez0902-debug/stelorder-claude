const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const STEL_API_KEY = "x0Uw2muYvHJAiOMfFtXkG7aR36eQCcBIURCHTs0B
";

function createServer() {
  const server = new McpServer({ name: "stelorder-mcp", version: "1.0.0" });

  server.tool(
    "listar_facturas_pendientes",
    "Lista las facturas de venta pendientes de cobro en STEL Order",
    {},
    async () => {
      const res = await fetch("https://app.stelorder.com/app/ws/invoicing/sales_invoices?paid=false", {
        headers: { "Authorization": "Bearer " + STEL_API_KEY }
      });
      const data = await res.text();
      return { content: [{ type: "text", text: data }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor MCP escuchando en puerto " + PORT));
