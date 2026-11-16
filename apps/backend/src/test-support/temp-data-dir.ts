/**
 * Importar PRIMEIRO num ficheiro de teste que use SQLite ou configs JSON:
 * aponta DATA_DIR para uma pasta temporária antes de qualquer módulo ler o caminho.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'activesync-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
fs.mkdirSync(path.join(TEST_DATA_DIR, 'suprides'), { recursive: true });

export function writeConfig(file: string, data: unknown): void {
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'suprides', file), JSON.stringify(data, null, 2));
}

export function removeTestDataDir(): void {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ficheiros ainda abertos no Windows */ }
}
