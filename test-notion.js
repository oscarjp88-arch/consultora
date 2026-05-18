require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function main() {
  const response = await notion.search({ query: '' });
  console.log('✅ Conexión exitosa. Páginas encontradas:', response.results.length);
  response.results.forEach(page => {
    const title = page.properties?.title?.title?.[0]?.plain_text || 
                  page.properties?.Name?.title?.[0]?.plain_text || 
                  'Sin título';
    console.log(` - ${title}`);
  });
}

main().catch(console.error);
