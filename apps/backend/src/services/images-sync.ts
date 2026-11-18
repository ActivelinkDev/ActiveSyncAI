/**
 * Envio de imagens para a Shopify em duas fases.
 *
 * A Shopify descarrega as imagens de forma assíncrona a partir do URL da Suprides,
 * que por vezes dá timeout. Por isso:
 *   1. Enviar: por produto, retira imagens FALHADAS de tentativas anteriores e acrescenta
 *      só as que faltam (comparadas pelo nome do ficheiro), numa chamada.
 *   2. Confirmar: espera que o processamento acabe. Produto com todas as imagens READY →
 *      images_synced = 1. Imagens FAILED são retiradas e o produto fica para nova tentativa.
 *
 * Ícone genérico: quando a foto ainda não existe, o site da Suprides devolve um ícone
 * (262×262) com o nome certo, e a Shopify guarda-o. Por isso, antes de enviar, confirma-se
 * que a Suprides já tem a foto verdadeira; ícones já guardados na loja são apagados e a foto
 * é reenviada quando existir.
 */
import { getSqlite } from '../db/sqlite';
import {
  getProductImages, addProductImages, deleteProductImage, deleteImageFiles, imageKeyFromUrl, dedupeImageUrls,
  isPlaceholderImage, PLACEHOLDER_SIZE, type ShopifyImage,
} from '../suprides/api/shopify-api';

export interface ImageTarget { sku: string; productId: number; urls: string[] }

export interface ImagePlan {
  /** Imagens a acrescentar (URLs da Suprides). */
  add: string[];
  /** IDs de imagens FAILED a retirar antes de reenviar. */
  removeFailed: number[];
  /** IDs de ícones genéricos guardados no lugar da foto (a apagar). */
  removePlaceholders: number[];
  /** Todas as imagens pretendidas já estão na loja e prontas. */
  complete: boolean;
}

/** Decide o que fazer a um produto a partir das imagens que tem na loja (puro, testável). */
export function planImages(urls: string[], current: ShopifyImage[]): ImagePlan {
  const desired = dedupeImageUrls(urls.filter(u => /^https?:\/\//i.test(u)));
  const failed = current.filter(i => i.status === 'FAILED');
  const placeholders = current.filter(i => i.status !== 'FAILED' && isPlaceholderImage(i));
  const ok = current.filter(i => i.status !== 'FAILED' && !isPlaceholderImage(i));
  const okKeys = new Set(ok.map(i => imageKeyFromUrl(i.src)));
  const add = desired.filter(u => !okKeys.has(imageKeyFromUrl(u)));
  const desiredKeys = new Set(desired.map(imageKeyFromUrl));
  const pending = ok.some(i => desiredKeys.has(imageKeyFromUrl(i.src)) && i.status !== 'READY');
  return {
    add, removeFailed: failed.map(i => i.id), removePlaceholders: placeholders.map(i => i.id),
    complete: add.length === 0 && !pending && placeholders.length === 0,
  };
}

/** Largura e altura de um JPEG/PNG/WebP a partir dos bytes (null se não reconhecer). */
export function imageDimensions(b: Buffer): { width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** O ficheiro descarregado é o ícone genérico da Suprides? */
export function isPlaceholderBytes(b: Buffer): boolean {
  const d = imageDimensions(b);
  return !!d && d.width === PLACEHOLDER_SIZE && d.height === PLACEHOLDER_SIZE && b.length < 4000;
}

/** 'real' se a Suprides já tem a foto; 'placeholder' se devolve o ícone; 'error' se não respondeu. */
export async function checkSourceImage(url: string, tries = 3): Promise<'real' | 'placeholder' | 'error'> {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { if (res.status === 404) return 'error'; continue; }
      const b = Buffer.from(await res.arrayBuffer());
      return isPlaceholderBytes(b) ? 'placeholder' : 'real';
    } catch { /* corte a meio: tenta outra vez */ }
  }
  return 'error';
}

export interface ImagesRunResult {
  checked: number; alreadyComplete: number; sent: number; imagesAdded: number;
  confirmed: number; failedImages: number; stillProcessing: number;
  /** Ícones genéricos apagados da loja. */
  placeholdersRemoved: number;
  /** Fotos que a Suprides ainda não tem (devolve o ícone) — ficam para outra execução. */
  notReadyAtSource: number;
  errors: { sku: string; error: string }[];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Fase 1 para um produto: apaga imagens falhadas e ícones genéricos, envia as fotos em falta
 * que a Suprides já tem. Só marca images_synced = 1 se o produto já estava completo; caso
 * contrário fica a 0 e a confirmação (images:run) trata do resto.
 */
export async function sendProductImages(t: ImageTarget, opts: {
  dryRun?: boolean; checkSource?: (url: string) => Promise<'real' | 'placeholder' | 'error'>;
} = {}): Promise<{ complete: boolean; added: number; placeholdersRemoved: number; notReadyAtSource: number }> {
  const checkSource = opts.checkSource ?? checkSourceImage;
  const db = getSqlite();
  const plan = planImages(t.urls, await getProductImages(t.productId));
  if (plan.complete) {
    if (!opts.dryRun) db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(t.sku);
    return { complete: true, added: 0, placeholdersRemoved: 0, notReadyAtSource: 0 };
  }
  // Só se envia o que a Suprides já tem como foto verdadeira.
  const ready: string[] = [];
  let notReadyAtSource = 0;
  for (const u of plan.add) {
    if ((await checkSource(u)) === 'real') ready.push(u); else notReadyAtSource++;
  }
  if (!opts.dryRun) {
    db.prepare('UPDATE suprides_products SET images_synced = 0 WHERE sku = ?').run(t.sku);
    for (const id of plan.removeFailed) await deleteProductImage(t.productId, id);
    if (plan.removePlaceholders.length) await deleteImageFiles(plan.removePlaceholders);
    if (ready.length) await addProductImages(t.productId, ready);
  }
  return { complete: false, added: ready.length, placeholdersRemoved: plan.removePlaceholders.length, notReadyAtSource };
}

export async function runImagesSync(targets: ImageTarget[], opts: {
  dryRun?: boolean; concurrency?: number; confirmWaitMs?: number; log?: (m: string) => void;
  /** Para testes: substitui a verificação da foto na Suprides. */
  checkSource?: (url: string) => Promise<'real' | 'placeholder' | 'error'>;
} = {}): Promise<ImagesRunResult> {
  const log = opts.log ?? (() => {});
  const checkSource = opts.checkSource ?? checkSourceImage;
  const markDone = getSqlite().prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?');
  const res: ImagesRunResult = {
    checked: 0, alreadyComplete: 0, sent: 0, imagesAdded: 0, confirmed: 0, failedImages: 0, stillProcessing: 0,
    placeholdersRemoved: 0, notReadyAtSource: 0, errors: [],
  };
  const toConfirm: ImageTarget[] = [];

  // Fase 1 — enviar
  const queue = [...targets];
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const r = await sendProductImages(t, { dryRun: opts.dryRun, checkSource });
        res.checked++;
        res.placeholdersRemoved += r.placeholdersRemoved;
        res.notReadyAtSource += r.notReadyAtSource;
        if (r.complete) { res.alreadyComplete++; continue; }
        if (r.added) { res.sent++; res.imagesAdded += r.added; if (!opts.dryRun) toConfirm.push(t); }
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
        const placeholders = current.filter(i => i.status === 'READY' && isPlaceholderImage(i));
        if (failed.length || placeholders.length) {
          for (const f of failed) await deleteProductImage(t.productId, f.id);
          if (placeholders.length) await deleteImageFiles(placeholders.map(p => p.id));
          res.failedImages += failed.length;
          res.placeholdersRemoved += placeholders.length;
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
