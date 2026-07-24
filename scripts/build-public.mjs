import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_TREES = [
  'creditek/agentes',
  'creditek/assets',
  'creditek/data',
];

const PUBLIC_FILES = [
  'index.html',
  'creditek/convenios/index.html',
  'creditek/legal/index.html',
  'creditek/portal/index.html',
];

const ERP_EXTENSIONS = new Set(['.html', '.js']);

async function copyFileFromRoot(rootDir, outDir, relative) {
  const source = path.join(rootDir, relative);
  const destination = path.join(outDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

export async function buildPublic(rootDir, outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const relative of PUBLIC_FILES) {
    await copyFileFromRoot(rootDir, outDir, relative);
  }

  for (const relative of PUBLIC_TREES) {
    await cp(path.join(rootDir, relative), path.join(outDir, relative), {
      recursive: true,
      filter: source => !path.basename(source).startsWith('.'),
    });
  }

  const erpDir = path.join(rootDir, 'creditek/erp');
  for (const entry of await readdir(erpDir)) {
    const source = path.join(erpDir, entry);
    if (!(await stat(source)).isFile()) continue;
    if (!ERP_EXTENSIONS.has(path.extname(entry))) continue;
    await copyFileFromRoot(rootDir, outDir, `creditek/erp/${entry}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(import.meta.dirname, '..');
  await buildPublic(rootDir, path.join(rootDir, 'public'));
}
