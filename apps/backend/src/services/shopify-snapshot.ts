/**
 * Cópia de segurança (só leitura) do estado dos produtos na Shopify, gravada em
 * <DATA_DIR>/snapshots/shopify-AAAAMMDD-HHMMSS.json. Guarda as últimas KEEP cópias.
 */
import fs from 'fs';
import path from 'path';
import { dataPath } from '../utils/data-dir';
import {
  readAllProducts, shopifyStoreAndToken, SHOPIFY_READ_API_VERSION, type SnapshotProduct,
} from '../suprides/api/shopify-read';

export const SNAPSHOT_KEEP = 14;

export interface SnapshotFile {
  takenAt: string;
  store: string;
  apiVersion: string;
  reason?: string;
  products: SnapshotProduct[];
}

export function snapshotsDir(): string {
  return dataPath('snapshots');
}

function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Apaga as cópias mais antigas, deixando as últimas `keep`. */
export function pruneSnapshots(keep = SNAPSHOT_KEEP, dir = snapshotsDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /^shopify-\d{8}-\d{6}\.json$/.test(f)).sort();
  const remove = files.slice(0, Math.max(0, files.length - keep));
  for (const f of remove) fs.unlinkSync(path.join(dir, f));
  return remove;
}

export async function takeSnapshot(opts: { reason?: string; onProgress?: (n: number) => void } = {}): Promise<{ file: string; snapshot: SnapshotFile }> {
  const { store } = await shopifyStoreAndToken();
  const products = await readAllProducts(opts.onProgress);
  const snapshot: SnapshotFile = {
    takenAt: new Date().toISOString(),
    store,
    apiVersion: SHOPIFY_READ_API_VERSION,
    reason: opts.reason,
    products,
  };
  const dir = snapshotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shopify-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 1));
  pruneSnapshots();
  return { file, snapshot };
}

export function loadSnapshot(file: string): SnapshotFile {
  const resolved = fs.existsSync(file) ? file : path.join(snapshotsDir(), file);
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as SnapshotFile;
}
