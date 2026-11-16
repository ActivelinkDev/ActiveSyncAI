import { Router, Request, Response } from 'express';
import { getSqlite } from '../../db/sqlite';
import {
  getProductImages,
  addProductImage,
  deleteProductImage,
  dedupeProductImages,
  imageKeyFromUrl,
  resetSyncAbort,
  abortSync,
  type ShopifyImage,
} from '../api/shopify-api';

const router = Router();

interface ImageRow {
  sku: string;
  shopify_product_id: number | null;
  images: string | null;
  images_synced: number;
}

function parseImageUrls(json: string | null): string[] {
  if (!json) return [];
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map(u => (typeof u === 'string' ? u.trim() : ''))
    .filter(u => /^https?:\/\//i.test(u));
}

function dedupeKeepOrder(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

// ── GET /api/suprides/sync-images/audit ──────────────────────────────────────
// Diagnóstico sem chamar Shopify: conta produtos por categoria.
router.get('/audit', (_req: Request, res: Response) => {
  try {
    const db = getSqlite();
    const rows = db.prepare(
      `SELECT sku, shopify_product_id, images, images_synced FROM suprides_products`
    ).all() as ImageRow[];

    let total = rows.length;
    let inShopify = 0;
    let noUrlsInDb = 0;
    let withUrlsInDb = 0;
    let urlsButNotSynced = 0;
    let urlsAndSynced = 0;
    let notInShopifyButHasUrls = 0;

    const sampleNoUrls: string[] = [];
    const samplePending: string[] = [];

    for (const r of rows) {
      const urls = parseImageUrls(r.images);
      const has = urls.length > 0;
      if (r.shopify_product_id) inShopify++;

      if (!has) {
        noUrlsInDb++;
        if (sampleNoUrls.length < 20) sampleNoUrls.push(r.sku);
      } else {
        withUrlsInDb++;
        if (r.shopify_product_id) {
          if (r.images_synced === 1) urlsAndSynced++;
          else { urlsButNotSynced++; if (samplePending.length < 20) samplePending.push(r.sku); }
        } else {
          notInShopifyButHasUrls++;
        }
      }
    }

    res.json({
      total,
      inShopify,
      noUrlsInDb,
      withUrlsInDb,
      urlsAndSynced,
      urlsButNotSynced,
      notInShopifyButHasUrls,
      sample: { noUrls: sampleNoUrls, pending: samplePending },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/suprides/sync-images ───────────────────────────────────────────
// SSE: força sincronização de imagens para produtos já existentes no Shopify.
//
// Query params:
//   mode=missing  (default) — só produtos com images_synced=0
//   mode=verify             — chama Shopify e re-faz upload onde falte algum URL
//   mode=all                — re-faz upload sempre (apaga e recria — destrutivo)
//   skus=A,B,C              — limita aos SKUs indicados
//   dryRun=true             — não escreve no Shopify; devolve só o plano
//   concurrency=N           — default 4
router.post('/', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  const send = (data: object) => {
    if (!clientClosed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const mode = (String(req.query.mode || '').trim() || 'missing') as 'missing' | 'verify' | 'all';
  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const concurrency = Math.max(1, Math.min(8, Number(req.query.concurrency || req.body?.concurrency || 4)));
  const skuFilter: string[] = (() => {
    const fromQuery = String(req.query.skus || '').split(',').map(s => s.trim()).filter(Boolean);
    const fromBody  = Array.isArray(req.body?.skus) ? req.body.skus.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
    return fromQuery.length ? fromQuery : fromBody;
  })();

  if (!['missing', 'verify', 'all'].includes(mode)) {
    send({ type: 'error', message: `mode inválido: ${mode}` });
    return res.end();
  }

  resetSyncAbort();

  try {
    const db = getSqlite();
    const baseSql =
      `SELECT sku, shopify_product_id, images, images_synced
         FROM suprides_products
        WHERE shopify_product_id IS NOT NULL`;
    const rows = (skuFilter.length
      ? db.prepare(`${baseSql} AND sku IN (${skuFilter.map(() => '?').join(',')})`).all(...skuFilter)
      : db.prepare(baseSql).all()
    ) as ImageRow[];

    type Task = { sku: string; productId: number; urls: string[] };
    const tasks: Task[] = [];

    for (const r of rows) {
      const urls = dedupeKeepOrder(parseImageUrls(r.images));
      if (!urls.length) continue;
      if (mode === 'missing' && r.images_synced === 1) continue;
      tasks.push({ sku: r.sku, productId: r.shopify_product_id!, urls });
    }

    send({ type: 'start', total: tasks.length, mode, dryRun, concurrency });

    if (!tasks.length) {
      send({ type: 'done', total: 0, uploaded: 0, skipped: 0, failed: 0, message: 'Nenhum produto a processar.' });
      return res.end();
    }

    let uploaded = 0, skipped = 0, failed = 0, done = 0;
    const errors: { sku: string; error: string }[] = [];

    const queue = [...tasks];

    const worker = async () => {
      while (!clientClosed) {
        const task = queue.shift();
        if (!task) break;
        const { sku, productId, urls } = task;
        try {
          if (mode === 'verify') {
            const current: ShopifyImage[] = await getProductImages(productId);
            const currentSrcs = new Set(current.map(i => imageKeyFromUrl(i.src || '')));
            const missing = urls.filter(u => !currentSrcs.has(imageKeyFromUrl(u)));
            if (!missing.length) {
              if (current.length > 0) {
                db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(sku);
                skipped++;
                send({ type: 'log', level: 'info', sku, msg: `[OK] ${current.length} imagem(s) já presente(s)` });
              } else {
                // BD tem URLs mas Shopify está vazio — re-upload completo
                if (dryRun) {
                  send({ type: 'log', level: 'warn', sku, msg: `[PLAN] re-upload de ${urls.length} imagem(s) (Shopify vazio)` });
                } else {
                  let added = 0, addFails: string[] = [];
                  for (let i = 0; i < urls.length; i++) {
                    try { await addProductImage(productId, urls[i], i + 1); added++; }
                    catch (e: any) { addFails.push(`${urls[i]}: ${e?.message ?? e}`); }
                  }
                  if (added > 0) {
                    db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(sku);
                    uploaded++;
                    send({ type: 'log', level: 'info', sku, msg: `[UPLOAD] ${added}/${urls.length} imagem(s) (Shopify estava vazio)` });
                  } else {
                    failed++;
                    errors.push({ sku, error: addFails.join('; ') || 'addProductImage devolveu null' });
                    send({ type: 'log', level: 'error', sku, msg: `[ERRO] addProductImage falhou: ${addFails[0] ?? 'sem detalhe'}` });
                  }
                }
              }
            } else {
              if (dryRun) {
                send({ type: 'log', level: 'warn', sku, msg: `[PLAN] +${missing.length} imagem(s) em falta` });
              } else {
                let added = 0, addFails: string[] = [];
                for (let i = 0; i < missing.length; i++) {
                  try { await addProductImage(productId, missing[i], current.length + i + 1); added++; }
                  catch (e: any) { addFails.push(`${missing[i]}: ${e?.message ?? e}`); }
                }
                if (added === missing.length && added > 0) {
                  db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(sku);
                  uploaded++;
                  send({ type: 'log', level: 'info', sku, msg: `[UPLOAD] +${added} imagem(s)` });
                } else if (added > 0) {
                  uploaded++;
                  send({ type: 'log', level: 'warn', sku, msg: `[PARCIAL] ${added}/${missing.length} carregadas — ${addFails[0]}` });
                } else {
                  failed++;
                  errors.push({ sku, error: addFails.join('; ') || 'addProductImage devolveu null' });
                  send({ type: 'log', level: 'error', sku, msg: `[ERRO] ${addFails[0] ?? 'addProductImage falhou'}` });
                }
              }
            }
          } else if (mode === 'all') {
            // Destrutivo: apaga existentes e re-faz upload pela ordem do feed.
            if (dryRun) {
              const current = await getProductImages(productId);
              send({ type: 'log', level: 'warn', sku, msg: `[PLAN] substituir ${current.length} → ${urls.length} imagem(s)` });
            } else {
              const current = await getProductImages(productId);
              for (const img of current) {
                try { await deleteProductImage(productId, img.id); }
                catch (e: any) { send({ type: 'log', level: 'warn', sku, msg: `[DEL-FAIL] img ${img.id}: ${e?.message ?? e}` }); }
              }
              let added = 0, addFails: string[] = [];
              for (let i = 0; i < urls.length; i++) {
                try { await addProductImage(productId, urls[i], i + 1); added++; }
                catch (e: any) { addFails.push(`${urls[i]}: ${e?.message ?? e}`); }
              }
              if (added > 0) {
                db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(sku);
                uploaded++;
                send({ type: 'log', level: 'info', sku, msg: `[REPLACE] ${added}/${urls.length} imagem(s)` });
              } else {
                failed++;
                errors.push({ sku, error: addFails.join('; ') || 'sem upload' });
                send({ type: 'log', level: 'error', sku, msg: `[ERRO] ${addFails[0] ?? 'upload falhou'}` });
              }
            }
          } else {
            // mode = 'missing' — só envia se images_synced=0; assume Shopify ainda não tem.
            if (dryRun) {
              send({ type: 'log', level: 'warn', sku, msg: `[PLAN] upload de ${urls.length} imagem(s)` });
            } else {
              let added = 0, addFails: string[] = [];
              for (let i = 0; i < urls.length; i++) {
                try { await addProductImage(productId, urls[i], i + 1); added++; }
                catch (e: any) { addFails.push(`${urls[i]}: ${e?.message ?? e}`); }
              }
              if (added > 0) {
                db.prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(sku);
                uploaded++;
                send({ type: 'log', level: 'info', sku, msg: `[UPLOAD] ${added}/${urls.length} imagem(s)` });
              } else {
                failed++;
                errors.push({ sku, error: addFails.join('; ') || 'addProductImage devolveu null' });
                send({ type: 'log', level: 'error', sku, msg: `[ERRO] ${addFails[0] ?? 'addProductImage falhou'}` });
              }
            }
          }
        } catch (e: any) {
          if (e?.code === 'ERR_CANCELED' || e?.name === 'AbortError') break;
          failed++;
          const detail = e?.response?.data || e?.message || String(e);
          errors.push({ sku, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300) });
          send({ type: 'log', level: 'error', sku, msg: `[EXC] ${e?.message ?? e}` });
        } finally {
          done++;
          send({ type: 'progress', current: done, total: tasks.length, sku });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (clientClosed) abortSync();

    send({
      type: 'done',
      total: tasks.length,
      uploaded,
      skipped,
      failed,
      dryRun,
      errors: errors.slice(0, 50),
    });
    res.end();
  } catch (err: any) {
    send({ type: 'error', message: err?.message ?? 'Erro inesperado' });
    res.end();
  }
});

// ── POST /api/suprides/sync-images/reset-flag ────────────────────────────────
// Marca produtos como não-sincronizados para forçar re-upload na próxima sync principal.
//   skus=A,B,C  (opcional) — se omitido, reseta todos
router.post('/reset-flag', (req: Request, res: Response) => {
  try {
    const db = getSqlite();
    const skus: string[] = Array.isArray(req.body?.skus)
      ? req.body.skus.map(String).map((s: string) => s.trim()).filter(Boolean)
      : [];

    let info;
    if (skus.length) {
      info = db.prepare(
        `UPDATE suprides_products SET images_synced = 0 WHERE sku IN (${skus.map(() => '?').join(',')})`
      ).run(...skus);
    } else {
      info = db.prepare(`UPDATE suprides_products SET images_synced = 0`).run();
    }
    res.json({ updated: info.changes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/suprides/sync-images/dedupe ────────────────────────────────────
// SSE: remove imagens duplicadas (mesmo filename) dos produtos já no Shopify,
// mantendo a primeira ocorrência por posição. Não re-descarrega nada.
//
// Query params:
//   skus=A,B,C    (opcional) — limita aos SKUs indicados
//   dryRun=true             — não apaga; devolve só o plano
//   concurrency=N           — default 4
router.post('/dedupe', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });
  const send = (data: object) => { if (!clientClosed) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const concurrency = Math.max(1, Math.min(8, Number(req.query.concurrency || req.body?.concurrency || 4)));
  const skuFilter: string[] = (() => {
    const fromQuery = String(req.query.skus || '').split(',').map(s => s.trim()).filter(Boolean);
    const fromBody  = Array.isArray(req.body?.skus) ? req.body.skus.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
    return fromQuery.length ? fromQuery : fromBody;
  })();

  resetSyncAbort();

  try {
    const db = getSqlite();
    const baseSql = `SELECT sku, shopify_product_id FROM suprides_products WHERE shopify_product_id IS NOT NULL`;
    const rows = (skuFilter.length
      ? db.prepare(`${baseSql} AND sku IN (${skuFilter.map(() => '?').join(',')})`).all(...skuFilter)
      : db.prepare(baseSql).all()
    ) as { sku: string; shopify_product_id: number }[];

    send({ type: 'start', total: rows.length, dryRun, concurrency });
    if (!rows.length) {
      send({ type: 'done', total: 0, productsAffected: 0, removed: 0, message: 'Nenhum produto a processar.' });
      return res.end();
    }

    let productsAffected = 0, removedTotal = 0, failed = 0, done = 0;
    const errors: { sku: string; error: string }[] = [];
    const queue = [...rows];

    const worker = async () => {
      while (!clientClosed) {
        const row = queue.shift();
        if (!row) break;
        const { sku, shopify_product_id: productId } = row;
        try {
          if (dryRun) {
            const current = await getProductImages(productId);
            const seen = new Set<string>();
            let dupes = 0;
            for (const img of current) {
              const key = imageKeyFromUrl(img.src || '');
              if (seen.has(key)) dupes++; else seen.add(key);
            }
            if (dupes > 0) {
              productsAffected++; removedTotal += dupes;
              send({ type: 'log', level: 'warn', sku, msg: `[PLAN] remover ${dupes} duplicada(s) (manter ${seen.size})` });
            }
          } else {
            const { kept, removed } = await dedupeProductImages(productId);
            if (removed > 0) {
              productsAffected++; removedTotal += removed;
              send({ type: 'log', level: 'info', sku, msg: `[DEDUPE] removidas ${removed}, mantidas ${kept}` });
            }
          }
        } catch (e: any) {
          if (e?.code === 'ERR_CANCELED' || e?.name === 'AbortError') break;
          failed++;
          const detail = e?.response?.data || e?.message || String(e);
          errors.push({ sku, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300) });
          send({ type: 'log', level: 'error', sku, msg: `[EXC] ${e?.message ?? e}` });
        } finally {
          done++;
          send({ type: 'progress', current: done, total: rows.length, sku });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (clientClosed) abortSync();

    send({ type: 'done', total: rows.length, productsAffected, removed: removedTotal, failed, dryRun, errors: errors.slice(0, 50) });
    res.end();
  } catch (err: any) {
    send({ type: 'error', message: err?.message ?? 'Erro inesperado' });
    res.end();
  }
});

export default router;
