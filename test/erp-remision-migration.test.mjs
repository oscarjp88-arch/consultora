import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MIGRATION = new URL(
  '../creditek/erp/migrations/20260724_remision_trazabilidad_segura.sql',
  import.meta.url,
);

test('la función de trazabilidad niega ejecución anónima explícitamente', async () => {
  const sql = await readFile(MIGRATION, 'utf8');

  assert.match(
    sql,
    /revoke\s+all\s+on\s+function\s+public\.obtener_trazabilidad_remision\(uuid\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
  );
  assert.match(
    sql,
    /grant\s+execute\s+on\s+function\s+public\.obtener_trazabilidad_remision\(uuid\)\s+to\s+authenticated\s*;/i,
  );
});
