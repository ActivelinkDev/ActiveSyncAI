/**
 * Envio de imagens para a Shopify em duas fases.
 *
 * A Shopify descarrega as imagens de forma assíncrona a partir do URL da Suprides,
 * que por vezes dá timeout. Por isso:
 *   1. Enviar: por produto, retira imagens FALHADAS de tentativas anteriores e acrescenta
 *      só as que faltam (comparadas pelo nome do ficheiro), numa chamada.
 *   2. Confirmar: espera que o processamento acabe. Produto com todas as imagens READY →
 *      images_synced = 1. Imagens FAILED são retiradas e o produto fica para nova tentativa.
 */
import { getSqlite } from '../db/sqlite';
import {
  getProductImages, addProductImages, deleteProductImage, imageKeyFromUrl, dedupeImageUrls,
} from '../suprides/api/shopify-api';

export interface ImageTarget { sku: string; productId: number; urls: string[] }

export interface ImagePlan {
  /** Imagens a acrescentar (URLs da Suprides). */
  add: string[];
  /** IDs de imagens FAILED a retirar antes de reenviar. */
  removeFailed: number[];
  /** Todas as imagens pretendidas já estão na loja e prontas. */
  complete: boolean;
}

/** Decide o que fazer a um produto a partir das imagens que tem na loja (puro, testável). */
export function planImages(urls: string[], current: { id: number; src: string; status?: string }[]): ImagePlan {
  const desired = dedupeImageUrls(urls.filter(u => /^https?:\/\//i.test(u)));
  const failed = current.filter(i => i.status === 'FAILED');
  const ok = current.filter(i => i.status !== 'FAILED');
  const okKeys = new Set(ok.map(i => imageKeyFromUrl(i.src)));
  const add = desired.filter(u => !okKeys.has(imageKeyFromUrl(u)));
  const desiredKeys = new Set(desired.map(imageKeyFromUrl));
  const pending = ok.some(i => desiredKeys.has(imageKeyFromUrl(i.src)) && i.status !== 'READY');
  return { add, removeFailed: failed.map(i => i.id), complete: add.length === 0 && !pending };
}

export interface ImagesRunResult {
  checked: number; alreadyComplete: number; sent: number; imagesAdded: number;
  confirmed: number; failedImages: number; stillProcessing: number;
  errors: { sku: string; error: string }[];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function runImagesSync(targets: ImageTarget[], opts: {
  dryRun?: boolean; concurrency?: number; confirmWaitMs?: number; log?: (m: string) => void;
} = {}): Promise<ImagesRunResult> {
  const log = opts.log ?? (() => {});
  const db = getSqlite();
  const markDone = db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?');
  const res: ImagesRunResult = {
    checked: 0, alreadyComplete: 0, sent: 0, imagesAdded: 0, confirmed: 0, failedImages: 0, stillProcessing: 0, errors: [],
  };
  const toConfirm: ImageTarget[] = [];

  // Fase 1 — enviar
  const queue = [...targets];
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const plan = planImages(t.urls, await getProductImages(t.productId));
        res.checked++;
        if (plan.complete) {
          res.alreadyComplete++;
          if (!opts.dryRun) markDone.run(t.sku);
          continue;
        }
        if (opts.dryRun) { if (plan.add.length) { res.sent++; res.imagesAdded += plan.add.length; } continue; }
        for (const id of plan.removeFailed) await deleteProductImage(t.productId, id);
        if (plan.add.length) {
          await addProductImages(t.productId, plan.add);
          res.sent++;
          res.imagesAdded += plan.add.length;
        }
        toConfirm.push(t);
      } catch (e: any) {
        res.errors.push({ sku: t.sku, error: e?.message ?? String(e) });
      }
      if (res.checked % 50 === 0) log(`Imagens: ${res.checked}/${targets.length} verificados, ${res.sent} com imagens enviadas`);
    }
  }));
  if (opts.dryRun || !toConfirm.length) return res;

  // Fase 2 — confirmar (a Shopify processa em segundo plano)
  const deadline = Date.now() + (opts.confirmWaitMs ?? 10 * 60_000);
  let pending = toConfirm;
  while (pending.length && Date.now() < deadline) {
    await sleep(20_000);
    const next: ImageTarget[] = [];
    for (const t of pending) {
      try {
        const current = await getProductImages(t.productId);
        const failed = current.filter(i => i.status === 'FAILED');
        if (failed.length) {
          for (const f of failed) await deleteProductImage(t.productId, f.id);
          res.failedImages += failed.length;
          continue;                              // fica images_synced = 0 → nova tentativa noutra execução
        }
        if (planImages(t.urls, current).complete) { markDone.run(t.sku); res.confirmed++; }
        else next.push(t);
      } catch (e: any) {
        res.errors.push({ sku: t.sku, error: e?.message ?? String(e) });
      }
    }
    pending = next;
    log(`Imagens: confirmação — ${res.confirmed} prontos, ${res.failedImages} imagens falhadas, ${pending.length} ainda em processamento`);
  }
  res.stillProcessing = pending.length;
  return res;
}
