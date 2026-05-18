require("dotenv").config();
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { Client } = require("@notionhq/client");
const path = require("path");

const DRIVE_FILE_ID = "1Sgl7Dx4-PNokuIduHw2lm51A9aSa-2cK";
const NOTION_PARENT_ID =
  process.env.NOTION_CREDITEK_REPORTES_ID || process.env.NOTION_PARENT_PAGE_ID;

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ─── 1. Descargar xlsx desde Google Drive ────────────────────────────────────
async function descargarArchivoXLSX() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "credentials.json"),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.get(
    { fileId: DRIVE_FILE_ID, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(response.data);
}

// ─── 2. Parsear Excel y extraer datos por tienda ─────────────────────────────
function parsearDatos(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const hoja = workbook.Sheets[workbook.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "" });

  const ventasPorTienda = {};
  const detalleFilas = [];

  for (const fila of filas) {
    const tienda = String(fila[0] || "").trim();
    const fecha = String(fila[1] || "").trim();
    const monto = typeof fila[2] === "number" ? fila[2] : 0;

    // Filas de ventas: tienda + fecha + monto numérico
    if (tienda && fecha && monto > 0) {
      if (!ventasPorTienda[tienda]) {
        ventasPorTienda[tienda] = { total: 0, registros: [] };
      }
      ventasPorTienda[tienda].total += monto;
      ventasPorTienda[tienda].registros.push({ fecha, monto });
      detalleFilas.push({ tienda, fecha, monto });
    }

    // Filas de accesorios: col5=artículo, col10=total
    const articulo = String(fila[5] || "").trim();
    const totalAcc = typeof fila[10] === "number" ? fila[10] : 0;
    if (articulo && totalAcc > 0) {
      const key = `ACCESORIOS (${articulo})`;
      if (!ventasPorTienda[key]) ventasPorTienda[key] = { total: 0, registros: [] };
      ventasPorTienda[key].total += totalAcc;
      ventasPorTienda[key].registros.push({ fecha: "ENERO", monto: totalAcc });
      detalleFilas.push({ tienda: key, fecha: "ENERO", monto: totalAcc });
    }
  }

  return { ventasPorTienda, detalleFilas };
}

function formatearPesos(num) {
  return "$ " + num.toLocaleString("es-CO");
}

// ─── 3. Crear página en Notion ────────────────────────────────────────────────
async function crearPaginaNotion(ventasPorTienda, detalleFilas) {
  const tiendas = Object.entries(ventasPorTienda).sort(
    (a, b) => b[1].total - a[1].total
  );
  const totalGeneral = tiendas.reduce((s, [, v]) => s + v.total, 0);

  // Semana actual
  const ahora = new Date();
  const semana = Math.ceil(
    ((ahora - new Date(ahora.getFullYear(), 0, 1)) / 86400000 + 1) / 7
  );
  const titulo = `Reporte Creditek - Semana ${semana} (${ahora.toLocaleDateString("es-CO")})`;

  // Construir filas de la tabla (encabezado + datos)
  const filasTabla = [
    // Encabezado
    {
      object: "block",
      type: "table_row",
      table_row: {
        cells: [
          [{ type: "text", text: { content: "Tienda" } }],
          [{ type: "text", text: { content: "Total Ventas" } }],
          [{ type: "text", text: { content: "Registros" } }],
          [{ type: "text", text: { content: "Detalle Fechas" } }],
        ],
      },
    },
    // Filas de datos
    ...tiendas.map(([tienda, datos]) => ({
      object: "block",
      type: "table_row",
      table_row: {
        cells: [
          [{ type: "text", text: { content: tienda } }],
          [{ type: "text", text: { content: formatearPesos(datos.total) } }],
          [{ type: "text", text: { content: String(datos.registros.length) } }],
          [
            {
              type: "text",
              text: {
                content: datos.registros
                  .map((r) => `${r.fecha}: ${formatearPesos(r.monto)}`)
                  .join(" | "),
              },
            },
          ],
        ],
      },
    })),
    // Fila de total
    {
      object: "block",
      type: "table_row",
      table_row: {
        cells: [
          [{ type: "text", text: { content: "TOTAL GENERAL" } }],
          [{ type: "text", text: { content: formatearPesos(totalGeneral) } }],
          [{ type: "text", text: { content: String(detalleFilas.length) } }],
          [{ type: "text", text: { content: "" } }],
        ],
      },
    },
  ];

  const response = await notion.pages.create({
    parent: { page_id: NOTION_PARENT_ID },
    properties: {
      title: { title: [{ text: { content: titulo } }] },
    },
    children: [
      {
        object: "block",
        type: "callout",
        callout: {
          rich_text: [
            {
              text: {
                content: `Generado automáticamente el ${ahora.toLocaleString("es-CO")} | Total general: ${formatearPesos(totalGeneral)} | ${tiendas.length} tiendas`,
              },
            },
          ],
          icon: { emoji: "📊" },
          color: "blue_background",
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Ventas por Tienda - Enero 2026" } }],
        },
      },
      {
        object: "block",
        type: "table",
        table: {
          table_width: 4,
          has_column_header: true,
          has_row_header: false,
          children: filasTabla,
        },
      },
    ],
  });

  return { titulo, url: response.url, totalGeneral, tiendas };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.NOTION_TOKEN) {
    console.error("Error: falta NOTION_TOKEN en .env");
    process.exit(1);
  }
  if (!NOTION_PARENT_ID) {
    console.error("Error: falta NOTION_PARENT_PAGE_ID en .env");
    process.exit(1);
  }

  console.log("📥 Descargando archivo de Google Drive...");
  const buffer = await descargarArchivoXLSX();

  console.log("📊 Procesando datos del Excel...");
  const { ventasPorTienda, detalleFilas } = parsearDatos(buffer);

  const numTiendas = Object.keys(ventasPorTienda).length;
  if (numTiendas === 0) {
    console.error("No se encontraron datos de tiendas en el archivo.");
    process.exit(1);
  }
  console.log(`   → ${numTiendas} tiendas encontradas, ${detalleFilas.length} registros`);

  console.log("📝 Creando página en Notion...");
  const { titulo, url, totalGeneral, tiendas } = await crearPaginaNotion(
    ventasPorTienda,
    detalleFilas
  );

  console.log(`\n✅ Página creada: ${titulo}`);
  console.log(`   URL: ${url}`);
  console.log(`\n📈 Resumen:`);
  tiendas.forEach(([t, d]) =>
    console.log(`   ${t.padEnd(30)} ${formatearPesos(d.total)}`)
  );
  console.log(`   ${"─".repeat(50)}`);
  console.log(`   ${"TOTAL GENERAL".padEnd(30)} ${formatearPesos(totalGeneral)}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
