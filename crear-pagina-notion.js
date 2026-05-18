const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ID de la página padre donde se creará el reporte (configurable por variable de entorno)
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;

const filas = [
  {
    tienda: "Creditek Centro",
    ventas: "$1,250,000",
    observaciones: "Meta alcanzada. Buen desempeño en accesorios.",
  },
  {
    tienda: "Creditek Norte",
    ventas: "$980,000",
    observaciones: "Por debajo de meta. Reforzar equipo de ventas.",
  },
  {
    tienda: "Creditek Sur",
    ventas: "$1,410,000",
    observaciones: "Superó meta. Campaña de financiamiento exitosa.",
  },
];

function crearFilaTabla(tienda, ventas, observaciones) {
  return {
    object: "block",
    type: "table_row",
    table_row: {
      cells: [
        [{ type: "text", text: { content: tienda } }],
        [{ type: "text", text: { content: ventas } }],
        [{ type: "text", text: { content: observaciones } }],
      ],
    },
  };
}

async function crearPaginaReporte() {
  if (!process.env.NOTION_TOKEN) {
    console.error("Error: falta la variable de entorno NOTION_TOKEN");
    process.exit(1);
  }
  if (!PARENT_PAGE_ID) {
    console.error("Error: falta la variable de entorno NOTION_PARENT_PAGE_ID");
    process.exit(1);
  }

  console.log("Creando página en Notion...");

  const response = await notion.pages.create({
    parent: { page_id: PARENT_PAGE_ID },
    properties: {
      title: {
        title: [{ text: { content: "Reporte Creditek - Semana 20" } }],
      },
    },
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Resumen de Ventas por Tienda" } }],
        },
      },
      {
        object: "block",
        type: "table",
        table: {
          table_width: 3,
          has_column_header: true,
          has_row_header: false,
          children: [
            // Fila de encabezados
            {
              object: "block",
              type: "table_row",
              table_row: {
                cells: [
                  [{ type: "text", text: { content: "Tienda" } }],
                  [{ type: "text", text: { content: "Ventas del día" } }],
                  [{ type: "text", text: { content: "Observaciones" } }],
                ],
              },
            },
            // Filas de datos
            ...filas.map((f) =>
              crearFilaTabla(f.tienda, f.ventas, f.observaciones)
            ),
          ],
        },
      },
    ],
  });

  console.log(`Página creada exitosamente.`);
  console.log(`ID: ${response.id}`);
  console.log(`URL: ${response.url}`);
}

crearPaginaReporte().catch((err) => {
  console.error("Error al crear la página:", err.message);
  process.exit(1);
});
