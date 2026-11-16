import { Router } from 'express';
import { getAllProducts, buildFamiliasFromProducts } from '../services/products-cache';
import { parseStockStatus, formatStockStatusLabel, type StockStatus } from '../api/suprides-api';
import {
  findVariantBySku, createProduct, updateProduct, updateVariant,
  addProductToCollection, findCollectionId, findProductByHandle,
  fetchProductsInCollection, getCollectId, deleteCollect, setInventoryCost,
  resetSyncAbort, abortSync, reconcileProductImages,
  toMetafieldKey, updateProductMetafields, type MetafieldInput,
} from '../api/shopify-api';
import { normalizeMoney, applyMargin, applyRounding, slug } from '../services/price-calc';
import { loadSupridesTaxonomy, normTaxonomyValue } from '../services/taxonomy';
import {
  loadAdminSettings, loadMargins, loadMenuItems, loadShopifyCollectionMapping, loadStats, saveStats, loadCollectionMargins
} from '../repositories/store';
import { getSqlite } from '../../db/sqlite';
import { buildPublicMenuTree, publishPublicMenu } from '../services/public-menu';
import { rebuildProductNodeIds } from '../services/menu-resolver';
import {
  buildActiveCollectionIndexes as _buildIndexes,
  buildDerivedCollectionIds,
  collectionHierarchyLookup as _hierarchyLookup,
  collectionLevel,
  uniqueIds,
  CollectionHierarchy,
} from './sync-helpers';
import type { CollectionMargins, CollectionMarginRule } from '../types';
import fs from 'fs';
import path from 'path';
import { readAllProducts, buildSkuIndex, type SnapshotProduct } from '../api/shopify-read';
import { takeSnapshot } from '../../services/shopify-snapshot';
import { dataPath } from '../../utils/data-dir';
import { logLine } from '../../utils/logger';

function _buildBodyHtml(p: any, line: string, fam: string, sub: string): string {
  if (p.description && p.description.trim()) return p.description.trim();

  const parts: string[] = [];
  if (p.short_description && p.short_description.trim()) {
    parts.push(`<p>${p.short_description.trim()}</p>`);
  } else {
    parts.push(`<p>${[p.brand, line, fam, sub].filter(Boolean).join(' - ')}</p>`);
  }
  const meta: string[] = [];
  if (p.manufacturer) meta.push(`<strong>Fabricante:</strong> ${p.manufacturer}`);
  if (p.cor)          meta.push(`<strong>Cor:</strong> ${p.cor}`);
  if (p.weight)       meta.push(`<strong>Peso:</strong> ${p.weight} kg`);
  if (p.part_number)  meta.push(`<strong>Part Number:</strong> ${p.part_number}`);
  if (meta.length)    parts.push(`<ul>${meta.map(m => `<li>${m}</li>`).join('')}</ul>`);
  return parts.join('\n');
}

const router = Router();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let syncProgress: {
  running: boolean; total: number; done: number; errors: number; cancelled?: boolean;
  /** 'leitura' = a ler a loja (cópia de segurança/índice); 'produtos' = a enviar produtos. */
  phase?: 'leitura' | 'produtos';
} = {
  running: false, total: 0, done: 0, errors: 0
};
let syncCancelled = false;

function findCollectionMargin(
  collIds: string[],
  margins: CollectionMargins,
  hierarchyById: Map<string, CollectionHierarchy>
): CollectionMarginRule | null {
  const sorted = [...collIds].sort((a, b) => collectionLevel(b, hierarchyById) - collectionLevel(a, hierarchyById));
  for (const id of sorted) {
    const r = margins.rules[id];
    if (r && r.marginValue > 0) return r;
  }
  return null;
}

router.get('/progress', (_req, res) => {
  res.json(syncProgress);
});

router.post('/cancel', (_req, res) => {
  if (syncProgress.running) {
    syncCancelled = true;
    abortSync();
    res.json({ ok: true, message: 'Cancelamento solicitado' });
  } else {
    res.json({ ok: false, message: 'Nenhuma sincronização em curso' });
  }
});

const buildActiveCollectionIndexes = _buildIndexes;

function collectionTitleLookup(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: ReturnType<typeof loadMenuItems>) => {
    for (const node of nodes) {
      if (node.shopifyId) out.set(node.shopifyId, node.title);
      out.set(node.title, node.title);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(loadMenuItems());
  return out;
}

const collectionHierarchyLookup = _hierarchyLookup;


router.get('/sync-familias/audit', async (req, res) => {
  try {
    const taxonomy = await loadSupridesTaxonomy();
    const collMap = loadShopifyCollectionMapping();
    const { lineToCollIds, familyToCollIds, subToCollIds } = buildActiveCollectionIndexes(collMap);
    const titleById = collectionTitleLookup();
    const hierarchyById = collectionHierarchyLookup();
    const hidden = collMap.hidden || {};
    const sampleLimitRaw = Number(req.query.limit ?? 100);
    const sampleLimit = Number.isFinite(sampleLimitRaw) ? Math.max(0, sampleLimitRaw) : 100;

    const levelOf = (id: string): 'L1' | 'L2' | 'L3' | 'unknown' => {
      const h = hierarchyById.get(id);
      if (!h) return 'unknown';
      if (h.l2Id && h.l1Id) return 'L3';
      if (h.l1Id) return 'L2';
      return 'L1';
    };
    const refs = (ids: string[]) => ids.map(id => ({ id, title: titleById.get(id), level: levelOf(id) }));
    const currentEligibleLines = new Set(lineToCollIds.keys());
    const proposedEligibleLines = new Set([...lineToCollIds.keys(), ...familyToCollIds.keys()]);

    const emptySummary = () => ({
      eligibleProducts: 0,
      productsWithCollections: 0,
      productsWithoutCollections: 0,
      uniqueCollectionIds: 0,
    });
    const currentSummary = emptySummary();
    const proposedSummary = emptySummary();
    const derivedParentsSummary = emptySummary();
    const currentUniqueCollections = new Set<string>();
    const proposedUniqueCollections = new Set<string>();
    const derivedParentsUniqueCollections = new Set<string>();
    const derivedReviewCollections = new Map<string, { id: string; title: string; level: string; productCount: number }>();
    const sample: any[] = [];
    let changedProducts = 0;
    let onlyCurrentLinks = 0;
    let onlyProposedLinks = 0;
    let derivedChangedProducts = 0;
    let onlyCurrentVsDerivedLinks = 0;
    let onlyDerivedLinks = 0;

    for (const p of taxonomy.products) {
      const line = normTaxonomyValue(p.product_line);
      const fam = normTaxonomyValue(p.family);
      const sub = normTaxonomyValue(p.sub_family);
      const subKey = sub || fam;

      const currentEligible = currentEligibleLines.has(line);
      const proposedEligible = proposedEligibleLines.has(line);

      const currentIds = currentEligible ? uniqueIds([
        ...(lineToCollIds.get(line) || []),
        ...(familyToCollIds.get(fam) || []),
        ...(subToCollIds.get(subKey) || []),
      ]) : [];

      const proposedIds = proposedEligible ? uniqueIds([
        ...(lineToCollIds.get(line) || []),
        ...(familyToCollIds.get(line) || []),
        ...(subToCollIds.get(fam) || []),
      ]) : [];

      const derivedParentsIds = proposedEligible
        ? buildDerivedCollectionIds(line, fam, sub, collMap, { lineToCollIds, familyToCollIds, subToCollIds }, hierarchyById)
        : [];

      if (currentEligible) currentSummary.eligibleProducts++;
      if (proposedEligible) proposedSummary.eligibleProducts++;
      if (proposedEligible) derivedParentsSummary.eligibleProducts++;
      if (currentIds.length) currentSummary.productsWithCollections++;
      else if (currentEligible) currentSummary.productsWithoutCollections++;
      if (proposedIds.length) proposedSummary.productsWithCollections++;
      else if (proposedEligible) proposedSummary.productsWithoutCollections++;
      if (derivedParentsIds.length) derivedParentsSummary.productsWithCollections++;
      else if (proposedEligible) derivedParentsSummary.productsWithoutCollections++;
      currentIds.forEach(id => currentUniqueCollections.add(id));
      proposedIds.forEach(id => proposedUniqueCollections.add(id));
      derivedParentsIds.forEach(id => {
        derivedParentsUniqueCollections.add(id);
        const existing = derivedReviewCollections.get(id);
        if (existing) {
          existing.productCount++;
        } else {
          derivedReviewCollections.set(id, {
            id,
            title: titleById.get(id) || id,
            level: levelOf(id),
            productCount: 1,
          });
        }
      });

      const currentSet = new Set(currentIds);
      const proposedSet = new Set(proposedIds);
      const derivedParentsSet = new Set(derivedParentsIds);
      const onlyCurrent = currentIds.filter(id => !proposedSet.has(id));
      const onlyProposed = proposedIds.filter(id => !currentSet.has(id));
      const onlyCurrentVsDerived = currentIds.filter(id => !derivedParentsSet.has(id));
      const onlyDerived = derivedParentsIds.filter(id => !currentSet.has(id));
      if (onlyCurrentVsDerived.length || onlyDerived.length || currentEligible !== proposedEligible) {
        derivedChangedProducts++;
        onlyCurrentVsDerivedLinks += onlyCurrentVsDerived.length;
        onlyDerivedLinks += onlyDerived.length;
      }
      if (onlyCurrent.length || onlyProposed.length || onlyCurrentVsDerived.length || onlyDerived.length || currentEligible !== proposedEligible) {
        changedProducts++;
        onlyCurrentLinks += onlyCurrent.length;
        onlyProposedLinks += onlyProposed.length;
        if (sampleLimit === 0 || sample.length < sampleLimit) {
          sample.push({
            sku: p.sku,
            title: p.name || p.sku,
            product_line: line,
            family: fam,
            sub_family: sub,
            current: {
              eligible: currentEligible,
              collectionIds: currentIds,
              collections: refs(currentIds),
            },
            proposed: {
              eligible: proposedEligible,
              collectionIds: proposedIds,
              collections: refs(proposedIds),
            },
            proposedDerivedParents: {
              eligible: proposedEligible,
              collectionIds: derivedParentsIds,
              collections: refs(derivedParentsIds),
            },
            diff: {
              onlyCurrent: refs(onlyCurrent),
              onlyProposed: refs(onlyProposed),
              onlyCurrentVsDerived: refs(onlyCurrentVsDerived),
              onlyDerived: refs(onlyDerived),
            },
          });
        }
      }
    }

    currentSummary.uniqueCollectionIds = currentUniqueCollections.size;
    proposedSummary.uniqueCollectionIds = proposedUniqueCollections.size;
    derivedParentsSummary.uniqueCollectionIds = derivedParentsUniqueCollections.size;

    res.json({
      model: {
        current: {
          menu: 'Shopify L1 -> product_line',
          familia: 'Shopify L2 -> family',
          subfamilia: 'Shopify L3 -> sub_family || family',
          filter: 'Só produtos cuja product_line está mapeada em menu/L1',
        },
        proposed: {
          menu: 'Shopify L1 -> product_line',
          familia: 'Shopify L2 -> product_line',
          subfamilia: 'Shopify L3 -> family',
          filter: 'Produtos cuja product_line está mapeada em menu/L1 ou familia/L2',
        },
        proposedDerivedParents: {
          menu: 'Shopify L1 -> product_line',
          familia: 'Shopify L2 -> pai dos L3 compatíveis encontrados; L2 sem filhos pode ser destino direto por product_line',
          subfamilia: 'Shopify L3 -> family, filtrado por compatibilidade do ramo com product_line',
          filter: 'Produtos cuja product_line está mapeada em menu/L1 ou familia/L2',
        },
      },
      source: {
        products: taxonomy.products.length,
        productLines: taxonomy.productLines.size,
        families: taxonomy.families.size,
        subFamilies: taxonomy.subFamilies.size,
        warnings: taxonomy.warnings,
      },
      mapping: {
        activeKeys: {
          menu: lineToCollIds.size,
          familia: familyToCollIds.size,
          subfamilia: subToCollIds.size,
        },
        hiddenCount: Object.keys(collMap.hidden || {}).length,
      },
      summary: {
        current: currentSummary,
        proposed: proposedSummary,
        proposedDerivedParents: derivedParentsSummary,
        differences: {
          changedProducts,
          onlyCurrentLinks,
          onlyProposedLinks,
          derivedChangedProducts,
          onlyCurrentVsDerivedLinks,
          onlyDerivedLinks,
          sampleCount: sample.length,
          sampleLimit,
        },
      },
      review: {
        productsToSync: derivedParentsSummary.productsWithCollections,
        collections: Array.from(derivedReviewCollections.values())
          .sort((a, b) => a.level.localeCompare(b.level) || a.title.localeCompare(b.title)),
      },
      sample,
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Erro no audit do sync', detail: e.message });
  }
});

// Lock partilhado entre o botão (rota) e o agendamento: nunca dois syncs à loja ao mesmo tempo.
let fullSyncRunning = false;
export const isFullSyncRunning = () => fullSyncRunning;

// Resultado da última execução lançada pela rota (o sync pode demorar horas: corre em segundo plano).
let lastResult: {
  startedAt: string; finishedAt?: string; resume: boolean;
  ok?: boolean; result?: unknown; error?: string;
} | null = null;

router.post('/sync-familias', (req, res) => {
  if (fullSyncRunning) {
    res.status(409).json({ error: 'Já há uma sincronização em curso' });
    return;
  }
  const resume = req.body?.resume === true;
  const run = { startedAt: new Date().toISOString(), resume } as NonNullable<typeof lastResult>;
  lastResult = run;
  // Marca já como em curso, para o primeiro /progress do frontend não ver running=false.
  syncProgress = { running: true, total: 0, done: 0, errors: 0, phase: 'leitura' };
  runFullShopifySync({ resume })
    .then(result => { run.ok = true; run.result = result; })
    .catch((err: any) => {
      run.ok = false;
      run.error = err?.message ?? String(err);
      logLine(`[Suprides] Sync falhou: ${run.error}`);
    })
    .finally(() => { run.finishedAt = new Date().toISOString(); });
  res.status(202).json({ ok: true, message: 'Sincronização iniciada', startedAt: run.startedAt });
});

router.get('/sync-familias/last-result', (_req, res) => {
  res.json(lastResult);
});

// Simulação: mesmo cálculo do sync, sem escrever nada na Shopify.
// ?save=1 grava o plano em <DATA_DIR>/plans/plan-AAAAMMDD-HHMMSS.json (para o sync:verify).
router.post('/sync-familias/dry-run', async (req, res) => {
  if (fullSyncRunning) {
    res.status(409).json({ error: 'Já há uma sincronização em curso' });
    return;
  }
  try {
    const result: any = await runFullShopifySync({ dryRun: true });
    const save = /^(1|true|sim)$/i.test(String(req.query.save ?? ''));
    if (save && result?.plan) {
      const dir = dataPath('plans');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `plan-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify({ createdAt: d.toISOString(), ...result }, null, 1));
      result.savedPlan = file;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao sincronizar', detail: err.message });
  }
});

/**
 * Sync completo SQLite → Shopify (produtos, preço, custo, imagens, coleções, metafields, menu público).
 * Usado pela rota POST /sync-familias e pelo agendamento diário.
 */
/** O que o sync faria a um produto (modo dryRun — nada é escrito na Shopify nem em disco). */
export interface SyncPlanItem {
  sku: string;
  /** skip-new = não existe na Shopify e createNewProducts está desligado. */
  action: 'update' | 'create' | 'skip-new' | 'draft-no-cost' | 'skip-no-cost' | 'draft-unmapped';
  shopifyProductId?: number;
  status?: 'active' | 'draft';
  price?: string;
  compareAtPrice?: string | null;
  cost?: string;
  stockStatus?: string;
  marginRule?: string | null;
  collectionIds?: string[];
}

export async function runFullShopifySync(opts: {
  resume?: boolean; dryRun?: boolean;
  /** Só para testes: substitui a leitura da loja (apenas em dryRun). */
  readShop?: () => Promise<SnapshotProduct[]>;
} = {}) {
  if (fullSyncRunning) throw Object.assign(new Error('Já há uma sincronização em curso'), { code: 'BUSY' });
  fullSyncRunning = true;
  const dryRun = opts.dryRun === true;
  const plan: SyncPlanItem[] = [];
  syncCancelled = false;
  resetSyncAbort();
  syncProgress = { running: true, total: 0, done: 0, errors: 0, phase: 'leitura' };
  try {
    const resume = opts.resume === true;

    const settings = loadAdminSettings();
    const createNewProducts = settings.createNewProducts === true;
    const collMap = loadShopifyCollectionMapping();
    const indexes = buildActiveCollectionIndexes(collMap);
    const { lineToCollIds, familyToCollIds, subToCollIds } = indexes;
    const hierarchyById = collectionHierarchyLookup();

    const eligibleLines = new Set([...lineToCollIds.keys(), ...familyToCollIds.keys()]);
    if (eligibleLines.size === 0) {
      return { message: 'Nenhuma linha de produto com mapeamento ativo', created: 0, updated: 0, errors: [] };
    }

    const collMargins = loadCollectionMargins();

    const all = await getAllProducts(false);

    // Carregar shopify_node_id por SKU para fallback de produtos sem mapeamento L2/L3
    const nodeRows = getSqlite()
      .prepare("SELECT sku, shopify_node_id FROM suprides_products WHERE shopify_node_id IS NOT NULL AND shopify_node_id != ''")
      .all() as { sku: string; shopify_node_id: string }[];
    const skuNodeMap = new Map<string, string>(nodeRows.map(r => [r.sku, r.shopify_node_id]));

    const db = getSqlite();

    // Produtos já sincronizados (para modo resume)
    // Retomar: saltar só os SKUs já enviados na execução interrompida (registada em sync-run.json).
    // Se a última execução terminou (ou não há registo), "retomar" faz um sync completo.
    const runFile = dataPath('suprides', 'sync-run.json');
    let lastRun: { startedAt: string; finishedAt: string | null } | null = null;
    try { lastRun = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { /* sem registo */ }
    const resumeSince = resume && lastRun && !lastRun.finishedAt ? lastRun.startedAt : null;
    const syncedSkus = resumeSince
      ? new Set(
          (db.prepare('SELECT sku FROM suprides_products WHERE shopify_synced_at >= ?').all(resumeSince) as { sku: string }[])
            .map(r => r.sku)
        )
      : new Set<string>();
    const runStartedAt = resumeSince ?? new Date().toISOString();
    if (!dryRun) {
      fs.mkdirSync(path.dirname(runFile), { recursive: true });
      fs.writeFileSync(runFile, JSON.stringify({ startedAt: runStartedAt, finishedAt: null }, null, 1));
      if (resumeSince) logLine(`[Suprides] A retomar a execução de ${resumeSince}: ${syncedSkus.size} produtos já enviados ficam de fora`);
    }
    const markSynced = db.prepare('UPDATE suprides_products SET shopify_synced_at = ? WHERE sku = ?');

    // Pré-carregar IDs Shopify já conhecidos do SQLite (evita findVariantBySku + garante que produtos
    // previamente sincronizados continuam a ser incluídos mesmo que shopify_node_id esteja vazio)
    interface ShopifyCache { productId: number; variantId: number; inventoryItemId: number }
    const skuShopifyCache = new Map<string, ShopifyCache>();
    const skuImagesSynced = new Map<string, boolean>();
    {
      const rows = db.prepare(
        `SELECT sku, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, images_synced
         FROM suprides_products
         WHERE shopify_product_id IS NOT NULL
           AND shopify_variant_id IS NOT NULL
           AND shopify_inventory_item_id IS NOT NULL`
      ).all() as { sku: string; shopify_product_id: number; shopify_variant_id: number; shopify_inventory_item_id: number; images_synced: number }[];
      for (const r of rows) {
        skuShopifyCache.set(r.sku, {
          productId: r.shopify_product_id,
          variantId: r.shopify_variant_id,
          inventoryItemId: r.shopify_inventory_item_id,
        });
        skuImagesSynced.set(r.sku, r.images_synced === 1);
      }
      console.log(`[Suprides] Cache local Shopify: ${skuShopifyCache.size} SKUs já conhecidos`);
    }

    // Estado real da loja, lido numa só passagem. No modo real fica também gravado como
    // cópia de segurança antes de qualquer escrita (sem cópia → não se escreve nada).
    let shopProducts: SnapshotProduct[];
    let snapshotFile: string | undefined;
    if (dryRun) {
      shopProducts = await (opts.readShop ?? readAllProducts)();
    } else {
      logLine('[Suprides] A ler a loja e a guardar cópia de segurança…');
      const snap = await takeSnapshot({ reason: resume ? 'antes do sync (retomar)' : 'antes do sync' });
      shopProducts = snap.snapshot.products;
      snapshotFile = snap.file;
      logLine(`[Suprides] Cópia de segurança: ${path.basename(snap.file)} (${shopProducts.length} produtos)`);
    }
    if (syncCancelled) throw Object.assign(new Error('SYNC_CANCELLED'), { cancelled: true });

    // A loja manda: IDs da Shopify substituem os do SQLite; SKUs que já não existem na loja
    // saem da cache (um produto apagado à mão não é recriado — vira skip-new).
    {
      const { index, duplicates } = buildSkuIndex(shopProducts);
      if (duplicates.length) {
        logLine(`[Suprides] Aviso: ${duplicates.length} SKUs repetidos na loja (usado o 1.º produto): ${duplicates.slice(0, 10).join(', ')}`);
      }
      let fixed = 0, gone = 0;
      const upd = db.prepare(`UPDATE suprides_products
                              SET shopify_product_id = ?, shopify_variant_id = ?, shopify_inventory_item_id = ?
                              WHERE sku = ?`);
      const clear = db.prepare(`UPDATE suprides_products
                                SET shopify_product_id = NULL, shopify_variant_id = NULL, shopify_inventory_item_id = NULL
                                WHERE sku = ?`);
      const apply = db.transaction(() => {
        for (const sku of [...skuShopifyCache.keys()]) {
          if (!index.has(sku)) {
            skuShopifyCache.delete(sku);
            gone++;
            if (!dryRun) clear.run(sku);
          }
        }
        for (const [sku, e] of index) {
          const c = skuShopifyCache.get(sku);
          if (!c || c.productId !== e.productId || c.variantId !== e.variantId || c.inventoryItemId !== e.inventoryItemId) {
            skuShopifyCache.set(sku, e);
            fixed++;
            if (!dryRun) upd.run(e.productId, e.variantId, e.inventoryItemId, sku);
          }
        }
      });
      apply();
      console.log(`[Suprides] Índice da loja: ${index.size} SKUs; ${fixed} IDs acertados, ${gone} SKUs da cache já não existem na loja`);
    }

    // Sincronizar produtos com mapeamento L2/L3 activo, shopify_node_id como fallback,
    // ou já previamente sincronizados ao Shopify (para garantir actualizações).
    // Produtos já na Shopify fora das linhas mapeadas (linha não mapeada ou vazia na Suprides):
    // - sem stock → só passam a draft;
    // - com stock → preço/custo/stock atualizados, com a margem das coleções que JÁ têm na loja
    //   (as coleções não são alteradas).
    const draftOnlySkus = new Set<string>();
    const shopCollectionSkus = new Set<string>();
    const shopBySku = new Map<string, SnapshotProduct>();
    const shopById = new Map<number, SnapshotProduct>(shopProducts.map(sp => [sp.productId, sp]));
    for (const sp of shopProducts) if (sp.sku && !shopBySku.has(sp.sku)) shopBySku.set(sp.sku, sp);
    const filtrados = all.filter(p => {
      if (resume && syncedSkus.has(p.sku)) return false;
      const line = normTaxonomyValue((p.product_line || '').trim());
      if (!eligibleLines.has(line)) {
        if (!skuShopifyCache.has(p.sku)) return false;
        const semStock = ((p.stock_status as string) || parseStockStatus(p.stock)) === 'sem_stock';
        if (semStock) draftOnlySkus.add(p.sku);
        else shopCollectionSkus.add(p.sku);
        return true;
      }
      const fam = normTaxonomyValue((p.family || '').trim());
      const sub = normTaxonomyValue((p.sub_family || '').trim());
      const collectionIds = buildDerivedCollectionIds(line, fam, sub, collMap, indexes, hierarchyById);
      if (collectionIds.some(id => !!(hierarchyById.get(id)?.l1Id))) return true;
      return skuNodeMap.has(p.sku) || skuShopifyCache.has(p.sku);
    });

    if (filtrados.length === 0) {
      return { message: 'Nenhum produto encontrado para as linhas mapeadas', created: 0, updated: 0, errors: [] };
    }

    // Carregar tags normalizadas (preferência) ou brutas como fallback
    const normalizedCount = (db.prepare('SELECT COUNT(*) as n FROM sp_product_tag_values_normalized').get() as any).n;
    const aiTagRows = normalizedCount > 0
      ? db.prepare(`
          SELECT n.product_ref AS sku, tg.nome AS group_name, n.normalized_value AS value
          FROM sp_product_tag_values_normalized n
          JOIN sp_tag_groups tg ON tg.id = n.tag_group_id
          WHERE n.normalized_value IS NOT NULL AND n.normalized_value != ''
        `).all() as { sku: string; group_name: string; value: string }[]
      : db.prepare(`
          SELECT ptv.sku, tg.nome AS group_name, ptv.value
          FROM sp_product_tag_values ptv
          JOIN sp_tag_groups tg ON tg.id = ptv.tag_group_id
          WHERE ptv.value IS NOT NULL AND ptv.value != ''
        `).all() as { sku: string; group_name: string; value: string }[];

    console.log(`[Suprides] Metafields: ${normalizedCount > 0 ? 'normalizados' : 'brutos (corre Normalizar para melhorar)'} — ${aiTagRows.length} registos`);

    const skuTagMap = new Map<string, { group: string; value: string }[]>();
    for (const row of aiTagRows) {
      if (!skuTagMap.has(row.sku)) skuTagMap.set(row.sku, []);
      skuTagMap.get(row.sku)!.push({ group: row.group_name, value: row.value });
    }

    console.log(`[Suprides] ${filtrados.length} produtos a sincronizar`);
    syncProgress = { running: true, total: filtrados.length, done: 0, errors: 0, phase: 'produtos' };

    let created = 0, updated = 0;
    const skippedNew: string[] = [];     // não existem na Shopify e createNewProducts está desligado
    let noMarginRule = 0;                // preço calculado sem regra de margem (custo + IVA)
    const belowCostVat: { sku: string; price: string; cost: string }[] = []; // preço final < custo + IVA
    const errors: { sku: string; error: unknown }[] = [];
    // Produtos sem preço de custo: nunca publicar com preço inventado.
    const noCostHidden: string[] = [];   // já existiam na Shopify → passados a draft
    const noCostSkipped: string[] = [];  // não existiam → não criados
    const draftedUnmapped: string[] = []; // sem stock, fora das linhas mapeadas → draft
    const syncedAt = new Date().toISOString();

    // Acumula IDs de coleções que têm pelo menos um produto ativo (stock > 0)
    const activeCollectionIdSet = new Set<string>();

    // Cache de resolução collId → numId partilhado entre workers (promise-based para evitar duplicados)
    const resolvedCollIdCache = new Map<string, Promise<number | null>>();
    const resolveNumericCollId = (cid: string): Promise<number | null> => {
      const n = Number(cid);
      if (n) return Promise.resolve(n);
      if (!resolvedCollIdCache.has(cid)) resolvedCollIdCache.set(cid, findCollectionId(cid));
      return resolvedCollIdCache.get(cid)!;
    };

    const ivaMultiplier = 1 + ((settings.ivaRate ?? 23) / 100);

    const throwIfCancelled = () => {
      if (syncCancelled) throw Object.assign(new Error('SYNC_CANCELLED'), { cancelled: true });
    };

    const touchedLog: { sku: string; title: string; action: 'updated' | 'created' }[] = [];
    const markDone = (p: any, action: 'updated' | 'created') => {
      if (action === 'updated') updated++; else created++;
      touchedLog.push({ sku: p.sku, title: p.name || p.sku, action });
      if (touchedLog.length > 200) touchedLog.shift();
    };

    const processProduct = async (p: any) => {
      const line = (p.product_line || '').trim();
      const fam  = (p.family       || '').trim();
      const sub  = (p.sub_family   || '').trim();

      if (draftOnlySkus.has(p.sku)) {
        const known = skuShopifyCache.get(p.sku)!;
        if (dryRun) {
          plan.push({ sku: p.sku, action: 'draft-unmapped', shopifyProductId: known.productId, status: 'draft', stockStatus: 'sem_stock' });
          return;
        }
        throwIfCancelled();
        await updateProduct(known.productId, { status: 'draft', published_at: null });
        await updateProductMetafields(known.productId, [
          { namespace: 'custom', key: 'stock_status', value: formatStockStatusLabel('sem_stock') },
        ]).catch((e: any) => console.warn(`[Suprides] metafields SKU ${p.sku}:`, e?.message));
        draftedUnmapped.push(p.sku);
        return;
      }

      // Custo = só o preço de compra. O PVPR é preço de venda (com IVA) e nunca serve de custo.
      const cost = p.price != null && String(p.price) !== ''
        ? (parseFloat(normalizeMoney(String(p.price))) || 0)
        : 0;
      if (cost <= 0) {
        const known = skuShopifyCache.get(p.sku);
        if (dryRun) {
          plan.push({ sku: p.sku, action: known ? 'draft-no-cost' : 'skip-no-cost', shopifyProductId: known?.productId, status: known ? 'draft' : undefined });
          return;
        }
        if (known) {
          throwIfCancelled();
          await updateProduct(known.productId, { status: 'draft', published_at: null });
          noCostHidden.push(p.sku);
        } else {
          noCostSkipped.push(p.sku);
        }
        return;
      }
      const costPrice = cost.toFixed(2);
      // Fora do mapeamento: coleções atuais da loja (só para a margem; não se acrescentam).
      const shopCurrent = shopCollectionSkus.has(p.sku) ? shopBySku.get(p.sku) : undefined;
      let collectionIds = shopCurrent
        ? [...shopCurrent.collectionIds]
        : buildDerivedCollectionIds(line, fam, sub, collMap, indexes, hierarchyById);
      if (!shopCurrent && !collectionIds.some(id => !!(hierarchyById.get(id)?.l1Id))) {
        const nodeId = skuNodeMap.get(p.sku);
        if (nodeId) collectionIds = [nodeId];
      }
      const rule = findCollectionMargin(collectionIds, collMargins, hierarchyById);
      let basePrice = cost;
      if (rule) basePrice = applyMargin(basePrice, rule.mode, rule.marginValue);
      const finalPrice = applyRounding(basePrice * ivaMultiplier, settings.rounding);

      // pvpr do fornecedor: passa direto, sem IVA. Só mostrar se maior que o nosso preço final.
      const pvprRaw = p.pvpr ? parseFloat(normalizeMoney(p.pvpr)) || 0 : 0;
      const price   = finalPrice.toFixed(2);
      const pvpr    = pvprRaw > finalPrice ? pvprRaw.toFixed(2) : undefined;

      const stockStatus = (p.stock_status as string) || parseStockStatus(p.stock);
      const title  = p.name || p.sku || 'Produto';
      // Disponível / brevemente / sob encomenda ficam visíveis; sem stock fica escondido.
      const status = stockStatus === 'sem_stock' ? 'draft' : 'active';

      const aiTagEntries = skuTagMap.get(p.sku) ?? [];
      const metafields: MetafieldInput[] = [
        { namespace: 'custom', key: 'stock_status', value: formatStockStatusLabel(stockStatus as StockStatus) },
        ...aiTagEntries.map(({ group, value }) => ({
          namespace: 'filtros',
          key: toMetafieldKey(group),
          value,
        })),
      ];

      const imageUrls: string[] = (Array.isArray(p.images) ? p.images : [])
        .map((src: unknown) => (typeof src === 'string' ? src.trim() : ''))
        .filter((src: string) => /^https?:\/\//i.test(src));
      const body_html = _buildBodyHtml(p, line, fam, sub);
      const weightGrams = p.weight ? Math.round(parseFloat(String(p.weight)) * 1000) : undefined;

      // published_at garante que produtos activos ficam visíveis nos canais de venda
      const published_at = status === 'active' ? new Date().toISOString() : null;
      const basePayload = {
        title, vendor: p.brand ?? 'Suprides',
        product_type: shopCurrent && !line ? shopCurrent.productType : line, // linha vazia não apaga o tipo da loja
        body_html, tags: '', status, published_at,
      };

      // O índice da loja (lido no início) diz se o produto existe; sem ele não se cria nada.
      const known = skuShopifyCache.get(p.sku);
      if (!known && !createNewProducts) {
        skippedNew.push(p.sku);
        if (dryRun) {
          plan.push({
            sku: p.sku, action: 'skip-new', status, price, compareAtPrice: pvpr ?? null, cost: costPrice, stockStatus,
            marginRule: rule ? `${rule.mode}:${rule.marginValue}` : null, collectionIds,
          });
        }
        return;
      }

      if (!rule) noMarginRule++;
      if (finalPrice < cost * ivaMultiplier - 0.005) belowCostVat.push({ sku: p.sku, price, cost: costPrice });

      // Acumular coleções de produtos visíveis para o menu público
      if (status === 'active') {
        for (const cid of collectionIds) activeCollectionIdSet.add(cid);
      }

      if (dryRun) {
        plan.push({
          sku: p.sku,
          action: known ? 'update' : 'create',
          shopifyProductId: known?.productId,
          status, price, compareAtPrice: pvpr ?? null, cost: costPrice, stockStatus,
          marginRule: rule ? `${rule.mode}:${rule.marginValue}` : null,
          collectionIds,
        });
        return;
      }

      throwIfCancelled();

      // Usar cache local antes de chamar API (evita findVariantBySku na maioria dos casos)
      const cached = skuShopifyCache.get(p.sku);
      let shopifyProductId: number | undefined;
      let shopifyVariantId: number | undefined;
      let shopifyInventoryItemId: number | undefined;

      if (cached) {
        shopifyProductId    = cached.productId;
        shopifyVariantId    = cached.variantId;
        shopifyInventoryItemId = cached.inventoryItemId;
        throwIfCancelled();
        await updateProduct(shopifyProductId, basePayload);
        throwIfCancelled();
        await updateVariant(shopifyVariantId, {
          price, compare_at_price: pvpr ?? null, barcode: p.ean,
          ...(weightGrams !== undefined ? { weight: weightGrams, weight_unit: 'g' } : {})
        });
        // Custo igual ao que a loja já tem (cópia lida no início) → não reenviar.
        const shopCost = shopById.get(shopifyProductId)?.cost;
        const costUnchanged = shopCost != null && Math.abs(Number(shopCost) - Number(costPrice)) < 0.005;
        if (shopifyInventoryItemId && costPrice !== null && !costUnchanged) {
          try { await setInventoryCost(shopifyInventoryItemId, costPrice); } catch (ce: any) { console.warn('[Suprides] setInventoryCost falhou:', ce?.message); }
        }
        markDone(p, 'updated');
      } else {
        // Produto ainda não conhecido — verificar no Shopify
        const existingVar = await findVariantBySku(p.sku);

        if (existingVar) {
          shopifyProductId    = existingVar.product_id;
          shopifyVariantId    = existingVar.id;
          shopifyInventoryItemId = existingVar.inventory_item_id;
          throwIfCancelled();
          await updateProduct(shopifyProductId!, basePayload);
          throwIfCancelled();
          await updateVariant(shopifyVariantId!, {
            price, compare_at_price: pvpr ?? null, barcode: p.ean,
            ...(weightGrams !== undefined ? { weight: weightGrams, weight_unit: 'g' } : {})
          });
          if (shopifyInventoryItemId && costPrice !== null) {
            try { await setInventoryCost(shopifyInventoryItemId, costPrice); } catch (ce: any) { console.warn('[Suprides] setInventoryCost falhou:', ce?.message); }
          }
          markDone(p, 'updated');
        } else {
          const productHandle = slug(`${title}-${p.sku}`);
          let fallbackProduct: any = null;
          throwIfCancelled();
          try {
            const created_ = await createProduct({
              ...basePayload, handle: productHandle,
              variants: [{
                sku: p.sku, barcode: p.ean, price, compare_at_price: pvpr ?? null,
                ...(weightGrams !== undefined ? { weight: weightGrams, weight_unit: 'g' } : {})
              }]
            });
            shopifyProductId    = created_.id;
            shopifyVariantId    = created_.variants?.[0]?.id;
            shopifyInventoryItemId = created_.variants?.[0]?.inventory_item_id;
            if (shopifyInventoryItemId && costPrice !== null) {
              try { await setInventoryCost(shopifyInventoryItemId, costPrice); } catch (ce: any) { console.warn('[Suprides] setInventoryCost falhou:', ce?.message); }
            }
            markDone(p, 'created');
          } catch (createErr: any) {
            if ((createErr as any).cancelled) throw createErr;
            // 422 = produto ou handle já existe — tentar encontrar e atualizar
            if (createErr?.response?.status === 422 || String(createErr?.message).includes('422')) {
              try {
                fallbackProduct = await findProductByHandle(productHandle);
                if (!fallbackProduct) {
                  const v2 = await findVariantBySku(p.sku);
                  if (v2) fallbackProduct = { id: v2.product_id, variants: [{ id: v2.id, inventory_item_id: v2.inventory_item_id }] };
                }
              } catch { /* fallback silencioso — vai lançar createErr abaixo */ }
            }
            if (!fallbackProduct) throw createErr;
          }
          if (fallbackProduct) {
            shopifyProductId = fallbackProduct.id;
            const existingVariant = fallbackProduct.variants?.[0];
            shopifyVariantId    = existingVariant?.id;
            shopifyInventoryItemId = existingVariant?.inventory_item_id;
            throwIfCancelled();
            await updateProduct(shopifyProductId!, basePayload);
            if (existingVariant) {
              throwIfCancelled();
              await updateVariant(existingVariant.id, {
                price, compare_at_price: pvpr ?? null, barcode: p.ean,
                ...(weightGrams !== undefined ? { weight: weightGrams, weight_unit: 'g' } : {})
              });
              if (existingVariant.inventory_item_id && costPrice !== null) {
                try { await setInventoryCost(existingVariant.inventory_item_id, costPrice); } catch (ce: any) { console.warn('[Suprides] setInventoryCost falhou:', ce?.message); }
              }
            }
            markDone(p, 'updated');
          }
        }
      }

      throwIfCancelled();
      if (shopifyProductId) {
        getSqlite()
          .prepare(`UPDATE suprides_products
                    SET shopify_product_id = ?,
                        shopify_variant_id = ?,
                        shopify_inventory_item_id = ?
                    WHERE sku = ?`)
          .run(shopifyProductId, shopifyVariantId ?? null, shopifyInventoryItemId ?? null, p.sku);
        // Actualizar cache em memória para próxima iteração se re-usado
        if (shopifyVariantId && shopifyInventoryItemId) {
          skuShopifyCache.set(p.sku, { productId: shopifyProductId, variantId: shopifyVariantId, inventoryItemId: shopifyInventoryItemId });
        }

        // Imagens: reconciliação idempotente. Lê as imagens reais do Shopify e
        // adiciona só as que faltam (comparadas por filename), nunca reenvia o
        // conjunto inteiro — elimina a duplicação dos syncs anteriores.
        if (imageUrls.length > 0 && skuImagesSynced.get(p.sku) !== true) {
          try {
            const { complete } = await reconcileProductImages(shopifyProductId, imageUrls);
            if (complete) {
              getSqlite().prepare('UPDATE suprides_products SET images_synced = 1 WHERE sku = ?').run(p.sku);
              skuImagesSynced.set(p.sku, true);
            }
          } catch (imgErr: any) {
            console.warn(`[Suprides] reconcile imagens SKU ${p.sku}:`, imgErr?.message);
          }
        }

        // Coleções onde o produto já está (segundo a cópia lida no início) não se reenviam.
        const alreadyIn = new Set(shopById.get(shopifyProductId)?.collectionIds ?? []);
        await Promise.all([
          ...(shopCurrent ? [] : collectionIds.filter(cid => !alreadyIn.has(cid))).map(async cid => {
            const numId = await resolveNumericCollId(cid);
            if (numId) await addProductToCollection(shopifyProductId!, numId);
          }),
          metafields.length
            ? updateProductMetafields(shopifyProductId, metafields).catch((e: any) =>
                console.warn(`[Suprides] metafields SKU ${p.sku}:`, e?.message)
              )
            : Promise.resolve(),
        ]);
      }
    };

    const CONCURRENCY = 5;
    const queue = [...filtrados];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          if (syncCancelled) break;
          const p = queue.shift();
          if (!p) break;
          try {
            await processProduct(p);
            if (!dryRun) markSynced.run(new Date().toISOString(), p.sku);
          } catch (e: any) {
            if (e?.cancelled || e?.code === 'ERR_CANCELED') break;
            const errDetail = e?.response?.data || e?.message || String(e);
            if (errors.length === 0) {
              console.error('[Suprides Sync] PRIMEIRO ERRO:', JSON.stringify({ sku: p?.sku, status: e?.response?.status, detail: errDetail }, null, 2));
            }
            errors.push({ sku: p?.sku, error: errDetail });
            syncProgress.errors++;
          }
          syncProgress.done++;
        }
      })
    );

    // Produtos ativos na loja em que este sync não toca (linha não mapeada, outro fornecedor, SKU desconhecido…).
    const touchedIds = new Set<number>();
    for (const p of filtrados) {
      const k = skuShopifyCache.get(p.sku);
      if (k) touchedIds.add(k.productId);
    }
    const untouchedActive = shopProducts.filter(sp => sp.status === 'ACTIVE' && !touchedIds.has(sp.productId));
    const checks = {
      noMarginRule,
      belowCostVat: belowCostVat.length,
      belowCostVatSample: belowCostVat.slice(0, 20),
      untouchedActive: untouchedActive.length,
      untouchedActiveSample: untouchedActive.slice(0, 20).map(sp => ({ sku: sp.sku, title: sp.title, vendor: sp.vendor })),
    };

    if (dryRun) {
      const count = (a: SyncPlanItem['action']) => plan.filter(x => x.action === a).length;
      const sent = plan.filter(x => x.action === 'update' || x.action === 'create' || x.action.startsWith('draft-'));
      return {
        dryRun: true,
        message: `Simulação: ${plan.length} produtos avaliados (nada foi escrito na loja)`,
        eligible: filtrados.length,
        createNewProducts,
        shopProducts: shopProducts.length,
        summary: {
          update: count('update'), create: count('create'), skipNew: count('skip-new'),
          draftNoCost: count('draft-no-cost'), skipNoCost: count('skip-no-cost'), draftUnmapped: count('draft-unmapped'),
          active: sent.filter(x => x.status === 'active').length,
          draft: sent.filter(x => x.status === 'draft').length,
          activeCollections: activeCollectionIdSet.size,
        },
        checks,
        errors,
        plan,
      };
    }

    const stats = loadStats();
    stats.lastSyncAt = syncedAt;
    stats.totals.requested += filtrados.length;
    stats.totals.synced    += created + updated;
    stats.totals.created   += created;
    stats.totals.updated   += updated;
    stats.totals.errors    += errors.length;
    stats.history.push({ timestamp: syncedAt, requested: filtrados.length, synced: created + updated, created, updated, errors: errors.length });
    if (stats.history.length > 50) stats.history = stats.history.slice(-50);
    stats.latestProducts = [
      ...touchedLog.slice(-20).reverse().map(t => ({ ...t, syncedAt })),
      ...stats.latestProducts
    ].slice(0, 50);
    saveStats(stats);

    // Gerar e (opcionalmente) publicar menu público
    const publicMenuFile = buildPublicMenuTree([...activeCollectionIdSet]);

    // Reconstruir shopify_node_id agora que o menu público está actualizado
    try {
      const { updated: nodeUpdated } = rebuildProductNodeIds();
      console.log(`[Suprides] shopify_node_id reconstruídos: ${nodeUpdated} produtos`);
    } catch (e: any) {
      console.warn('[Suprides] rebuildProductNodeIds falhou:', e?.message);
    }

    let menuPublishWarning: string | undefined;

    const shouldPublish = (settings as any).autoPublishPublicMenu !== false;
    if (shouldPublish && !syncCancelled) {
      try {
        const menuHandle = (settings as any).publicMenuHandle || 'menu-publico';
        const menuTitle  = (settings as any).publicMenuTitle  || 'Menu Público';
        const pubResult = await publishPublicMenu(menuHandle, menuTitle);
        if (!pubResult.ok) {
          menuPublishWarning = `Menu público gerado mas não publicado: ${pubResult.errors.join('; ')}`;
          console.warn('[Suprides] Publicação menu público falhou:', pubResult.errors);
        }
      } catch (menuErr: any) {
        menuPublishWarning = `Falha ao publicar menu público: ${menuErr?.message}`;
        console.warn('[Suprides] Exceção ao publicar menu público:', menuErr?.message);
      }
    }

    const wasCancelled = syncCancelled;
    syncCancelled = false;
    if (!wasCancelled) {
      fs.writeFileSync(runFile, JSON.stringify({ startedAt: runStartedAt, finishedAt: new Date().toISOString() }, null, 1));
    }
    if (noCostHidden.length || noCostSkipped.length) {
      console.warn(`[Suprides] Sem preço de custo: ${noCostHidden.length} passados a draft, ${noCostSkipped.length} não criados`);
    }
    logLine(
      `[Suprides] Sync ${wasCancelled ? 'cancelado' : 'concluído'}: ${updated} atualizados, ${created} criados, ` +
      `${skippedNew.length} novos ignorados, ${errors.length} erros`
    );
    return {
      message: wasCancelled ? `Cancelado após ${created + updated} produtos` : `Sincronizado: ${created + updated} produtos`,
      created, updated, errors, cancelled: wasCancelled,
      skippedNew: skippedNew.length,
      snapshot: snapshotFile ? path.basename(snapshotFile) : undefined,
      checks,
      noCost: { hidden: noCostHidden, skipped: noCostSkipped },
      draftedUnmapped,
      publicMenu: {
        publicNodes: publicMenuFile.stats.publicNodes,
        hiddenNodes: publicMenuFile.stats.hiddenNodes,
        activeCollections: publicMenuFile.stats.activeCollectionIds.length,
        warning: menuPublishWarning,
      },
    };
  } catch (err: any) {
    if (err?.cancelled || err?.code === 'ERR_CANCELED') {
      syncCancelled = false;
      return { message: 'Cancelado antes de enviar produtos', created: 0, updated: 0, errors: [], cancelled: true };
    }
    throw err;
  } finally {
    syncProgress.running = false;
    fullSyncRunning = false;
  }
}

// Endpoint de limpeza: remove collects errados sem apagar produtos.
// dryRun=true (default) apenas lista o que seria removido.
// collectionIds: limitar a coleções específicas; se omitido, verifica todas as mapeadas.
router.post('/reconcile-removes', async (req, res) => {
  // excludeFamilies: remover sempre estes families das collectionIds indicadas, mesmo que algoritmo diga ok
  const { dryRun = true, collectionIds: targetIds, excludeFamilies } = req.body as {
    dryRun?: boolean; collectionIds?: string[]; excludeFamilies?: string[];
  };
  try {
    const all = await getAllProducts(false);
    const skuToProduct = new Map(all.map((p: any) => [p.sku, p]));

    const collMap = loadShopifyCollectionMapping();
    const indexes = buildActiveCollectionIndexes(collMap);
    const hierarchyById = collectionHierarchyLookup();
    const titleById = collectionTitleLookup();
    const hidden = collMap.hidden || {};

    const allMapped = [
      ...Object.keys(collMap.menu || {}),
      ...Object.keys(collMap.familia || {}),
      ...Object.keys(collMap.subfamilia || {}),
    ].filter(id => !hidden[id]);

    const collsToCheck = targetIds ? targetIds.filter(id => !hidden[id]) : allMapped;

    const toRemove: { collectionId: string; collectionTitle: string; productId: number; sku: string; line: string; family: string }[] = [];
    let checked = 0;

    for (const collId of collsToCheck) {
      const numId = Number(collId);
      if (!numId) continue;
      const products = await fetchProductsInCollection(numId);
      checked += products.length;

      for (const sp of products) {
        const { id: productId, sku } = sp;
        if (!sku) continue;
        const lp = skuToProduct.get(sku);
        if (!lp) continue;
        const line = ((lp as any).product_line || '').trim();
        const fam  = ((lp as any).family || '').trim();
        const sub  = ((lp as any).sub_family || '').trim();
        const forcedOut = excludeFamilies?.includes(fam);
        const correct = new Set(buildDerivedCollectionIds(line, fam, sub, collMap, indexes, hierarchyById));
        if (forcedOut || !correct.has(collId)) {
          toRemove.push({ collectionId: collId, collectionTitle: titleById.get(collId) || collId, productId, sku, line, family: fam });
        }
      }
    }

    if (dryRun) {
      const byCollection: Record<string, { title: string; families: Record<string, number>; total: number }> = {};
      for (const item of toRemove) {
        if (!byCollection[item.collectionId]) byCollection[item.collectionId] = { title: item.collectionTitle, families: {}, total: 0 };
        byCollection[item.collectionId].families[item.family] = (byCollection[item.collectionId].families[item.family] || 0) + 1;
        byCollection[item.collectionId].total++;
      }
      return res.json({ dryRun: true, checked, toRemoveCount: toRemove.length, byCollection, items: toRemove.slice(0, 300) });
    }

    let removed = 0;
    const errors: string[] = [];
    for (const item of toRemove) {
      try {
        const cid = await getCollectId(item.productId, Number(item.collectionId));
        if (cid) { await deleteCollect(cid); removed++; }
      } catch (e: any) {
        errors.push(`${item.sku} / ${item.collectionTitle}: ${e?.message}`);
      }
    }
    res.json({ dryRun: false, checked, removed, errors: errors.slice(0, 50) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync-familias-cache', async (_req, res) => {
  try {
    const all = await getAllProducts(true);
    res.json(buildFamiliasFromProducts(all));
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar cache', detail: err.message });
  }
});

// Sync rápido — só estado de stock. Não toca em títulos, imagens, preços nem coleções.
// Para cada produto já com shopify_product_id atualiza:
//   - status do produto (active / draft) consoante o stock_status
//   - metafield custom.stock_status
// Lê o stock_status que o sync da cache (API → SQLite) gravou. Produtos ainda não
// criados no Shopify são ignorados (usar /sync-familias para os criar).
router.post('/sync-stock', async (_req, res) => {
  if (fullSyncRunning) {
    res.status(409).json({ error: 'Há um sync completo em curso' });
    return;
  }
  try {
    const rows = getSqlite().prepare(
      `SELECT sku, shopify_product_id, stock_status, stock
       FROM suprides_products
       WHERE shopify_product_id IS NOT NULL`
    ).all() as { sku: string; shopify_product_id: number; stock_status: string | null; stock: number | null }[];

    if (rows.length === 0) {
      return res.json({ message: 'Nenhum produto sincronizado ao Shopify', updated: 0, errors: [] });
    }

    let updated = 0;
    const errors: { sku: string; error: unknown }[] = [];

    const processOne = async (r: typeof rows[number]) => {
      const stockStatus = r.stock_status || parseStockStatus(r.stock != null ? String(r.stock) : undefined);
      const status = stockStatus === 'sem_stock' ? 'draft' : 'active';
      await updateProduct(r.shopify_product_id, {
        status,
        published_at: status === 'active' ? new Date().toISOString() : null,
      });
      await updateProductMetafields(r.shopify_product_id, [
        { namespace: 'custom', key: 'stock_status', value: formatStockStatusLabel(stockStatus as StockStatus) },
      ]);
      updated++;
    };

    const CONCURRENCY = 5;
    const queue = [...rows];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          const r = queue.shift();
          if (!r) break;
          try {
            await processOne(r);
          } catch (e: any) {
            errors.push({ sku: r.sku, error: e?.response?.data || e?.message || String(e) });
          }
        }
      })
    );

    res.json({ message: `Stock sincronizado: ${updated} produtos`, updated, errors });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao sincronizar stock', detail: err.message });
  }
});

export default router;
