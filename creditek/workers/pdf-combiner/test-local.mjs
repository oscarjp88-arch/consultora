// Prueba aislada de combinarPDF() — sin Cloudflare, sin Apps Script.
// Genera un PNG mínimo válido + un PDF ficticio de 1 página en memoria,
// combina ambos y valida el resultado. Correr con: npm run test:local

import { PDFDocument } from 'pdf-lib';
import { combinarPDF } from './index.js';

// PNG 1x1 mínimo válido (imagen de prueba)
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, 'binary').toString('base64');
}

async function crearPdfFicticio() {
  const doc = await PDFDocument.create();
  doc.setTitle('PDF ficticio de prueba');
  const page = doc.addPage([300, 150]);
  page.drawText('Documento de prueba — Pieza 1', { x: 20, y: 100, size: 14 });
  const bytes = await doc.save();
  return bytesToBase64(bytes);
}

async function main() {
  console.log('── Prueba aislada: combinarPDF() ──');

  const dummyPdfBase64 = await crearPdfFicticio();

  const archivos = [
    { nombre: 'foto-prueba.png', tipo: 'imagen', base64: PNG_1X1_BASE64 },
    { nombre: 'dummy.pdf', tipo: 'pdf', base64: dummyPdfBase64 },
  ];

  const { pdfBytes, paginas } = await combinarPDF({ titulo: 'Prueba Pieza 1 — 1 imagen + 1 PDF', archivos });

  // Validación 1: encabezado %PDF
  const header = String.fromCharCode(...pdfBytes.slice(0, 4));
  const headerOk = header === '%PDF';

  // Validación 2: número de páginas reportado
  const paginasOk = paginas === 2;

  // Validación 3: recargar el PDF resultante con pdf-lib y verificar de forma independiente
  const reloaded = await PDFDocument.load(pdfBytes);
  const paginasRecargadasOk = reloaded.getPageCount() === 2;
  const tituloOk = reloaded.getTitle() === 'Prueba Pieza 1 — 1 imagen + 1 PDF';

  console.log('Encabezado %PDF:', headerOk ? 'OK' : `FALLA (${header})`);
  console.log('Páginas reportadas por combinarPDF():', paginas, paginasOk ? 'OK' : 'FALLA (esperaba 2)');
  console.log('Páginas al recargar con PDFDocument.load():', reloaded.getPageCount(), paginasRecargadasOk ? 'OK' : 'FALLA');
  console.log('Título preservado:', tituloOk ? 'OK' : `FALLA (${reloaded.getTitle()})`);
  console.log('Tamaño del PDF final:', pdfBytes.length, 'bytes');

  const todoOk = headerOk && paginasOk && paginasRecargadasOk && tituloOk;
  console.log(todoOk ? '\n✔ PRUEBA EXITOSA — PDF válido de 2 páginas' : '\n✘ PRUEBA FALLIDA');
  process.exit(todoOk ? 0 : 1);
}

main().catch(e => {
  console.error('✘ ERROR en la prueba:', e);
  process.exit(1);
});
