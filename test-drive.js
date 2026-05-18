const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

async function main() {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({ pageSize: 5 });
  const files = res.data.files;
  if (!files.length) {
    console.log('No se encontraron archivos.');
  } else {
    console.log('✅ Conexión exitosa. Archivos encontrados:');
    files.forEach(f => console.log(` - ${f.name} (${f.id})`));
  }
}

main().catch(console.error);
