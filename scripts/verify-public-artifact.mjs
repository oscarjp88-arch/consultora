import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_EXTENSIONS = new Set([
  '.env', '.gs', '.pem', '.sql', '.toml', '.log', '.bak', '.py',
]);
const FORBIDDEN_NAMES = new Set([
  'credentials.json', 'token.json', 'package.json', 'package-lock.json',
  'wrangler.jsonc', 'wrangler.toml',
]);
const FORBIDDEN_CONTENT = [
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /\bWA_ACCESS_TOKEN\s*:/,
  /\bGCP_WIF_PRIVATE_KEY\s*=/,
];

async function walk(root, current = root) {
  const files = [];
  for (const entry of await readdir(current)) {
    const absolute = path.join(current, entry);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symlink forbidden: ${absolute}`);
    if (info.isDirectory()) files.push(...await walk(root, absolute));
    else files.push(absolute);
  }
  return files;
}

export async function verifyPublicArtifact(outDir) {
  for (const file of await walk(outDir)) {
    const name = path.basename(file);
    const extension = path.extname(name).toLowerCase();
    if (FORBIDDEN_NAMES.has(name) || FORBIDDEN_EXTENSIONS.has(extension)) {
      throw new Error(`Server-only file in public artifact: ${path.relative(outDir, file)}`);
    }
    if (['.html', '.js', '.json', '.txt'].includes(extension)) {
      const content = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_CONTENT) {
        if (pattern.test(content)) {
          throw new Error(`Server-only credential pattern in ${path.relative(outDir, file)}`);
        }
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPublicArtifact(path.resolve(import.meta.dirname, '../public'));
}
