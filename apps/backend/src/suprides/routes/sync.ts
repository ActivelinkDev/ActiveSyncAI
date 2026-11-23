import { withCatalogueLock } from '../../repositories/suprides-cache';
import { recordPricesFromShop } from '../../services/price-history';
import { syncBrandsAfterSync } from '../../services/brands-sync';
import { Router } from 'express';
import { getAllProducts, buildFamiliasFromProducts } from '../services/products-cache';
import { parseStockStatus, formatStockStatusLabel, type StockStatus } from '../api/suprides-api';
import {
  createProduct, productUpdate, variantUpdate, publishProduct,
  findCollectionId, removeProductFromCollection, fetchProductsInCollection,
  resetSyncAbort, abortSync, toMetafieldKey,
} from '../api/shopify-api';
import { sendProductImages } from '../../services/images-sync';
import { planProductWrite, contentHash, type DesiredProduct } from '../services/shopify-diff';
import { normalizeMoney, slug } from '../services/price-calc';
import { computeBasePrice, ivaMultiplierOf, marginRuleLabel, type PriceContext } from '../services/price-engine';
import { promoShopPrices } from '../services/campaign-calc';
import { loadLivePromotions, campaignAttribution, type LivePromotion } from '../repositories/campaigns';
import { loadSupridesTaxonomy, normTaxonomyValue } from '../services/taxonomy';
import {
  loadMenuItems, loadPublicMenu, loadShopifyCollectionMapping, loadStats, saveStats
} from '../repositories/store';
import { getMssql } from '../../db/mssql';
import { migrateMssql } from '../../db/mssql-migrations';
import { loadAppState, saveAppState } from '../../db/app-state';
import { loadSyncData, updateShopifyIds, type ShopifyIdUpdate } from '../repositories/sync-data';
import { buildPublicMenuTree, publishPublicMenu } from '../services/public-menu';
import { rebuildProductNodeIds } from '../services/menu-resolver';
import {
  buildActiveCollectionIndexes as _buildIndexes,
  buildDerivedCollectionIds,
  collectionHierarchyLookup as _hierarchyLookup,
  uniqueIds,
  CollectionHierarchy,
} from './sync-helpers';
import type { MenuNode, SupridesProduct } from '../types';
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

function collectionTitleLookup(menu: MenuNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: MenuNode[]) => {
    for (const node of nodes) {
      if (node.shopifyId) out.set(node.shopifyId, node.title);
      out.set(node.title, node.title);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(menu);
  return out;
}

const collectionHierarchyLookup = _hierarchyLookup;


router.get('/sync-familias/audit', async (req, res) => {
  try {
    const taxonomy = await loadSupridesTaxonomy();
    const [collMap, menu] = await Promise.all([loadShopifyCollectionMapping(), loadMenuItems()]);
    const { lineToCollIds, familyToCollIds, subToCollIds } = buildActiveCollectionIndexes(collMap);
    const titleById = collectionTitleLookup(menu);
    const hierarchyById = collectionHierarchyLookup(menu);
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
  runFullShopifySync({ resume }, () => {
    lastResult = run;
    res.status(202).json({ ok: true, message: 'Sincronização iniciada', startedAt: run.startedAt });
  }).then(result => { run.ok = true; run.result = result; })
    .catch((err: any) => {
      run.ok = false;
      run.error = err?.message ?? String(err);
      if (!res.headersSent) res.status(err?.code === 'BUSY' ? 409 : 500).json({ error: run.error });
      logLine(`[Suprides] Sync falhou: ${run.error}`);
    }).finally(() => { run.finishedAt = new Date().toISOString(); });
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
 * Sync completo SQL Server → Shopify (produtos, preço, custo, imagens, coleções, metafields, menu público).
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
  /** Campos que seriam enviados (vazio = nada muda na loja). */
  changes?: string[];
}

interface SyncOptions {
  resume?: boolean; dryRun?: boolean;
  /** Simular com uma cópia da loja ou com dados de teste em memória. */
  readShop?: () => Promise<SnapshotProduct[]>;
  readLocal?: typeof loadSyncData;
  /** Não enviar imagens neste sync (ficam por enviar; ver /sync-images). */
  skipImages?: boolean;
  /** Promoções em vigor (testes); por omissão lidas do SQL Server (nenhuma com readLocal). */
  readPromotions?: () => Promise<Map<string, LivePromotion>>;
}

export function runFullShopifySync(opts: SyncOptions = {}, onStart?: () => void) {
  if (opts.dryRun) return runSync(opts, onStart);
  // Histórico de preços (regra dos 30 dias) depois de qualquer sync real, também cancelado ou
  // com erro a meio: pode já ter havido preços enviados. Ainda dentro do lock, antes de outro sync.
  return withCatalogueLock(async () => {
    // O sync grava colunas recentes (ex.: products.base_price): garantir o esquema, também
    // quando corre fora do backend (npm run sync:run).
    await migrateMssql();
    try {
      return await runSync(opts, onStart);
    } finally {
      const shop = await recordPricesFromShop('SYNC', 'sync completo', undefined, () => campaignAttribution());
      // Marcas da homepage (metaobjects "marca"): só as que têm produtos à venda.
      await syncBrandsAfterSync(shop);
    }
  });
}

async function runSync(opts: SyncOptions, onStart?: () => void) {
  if (fullSyncRunning) throw Object.assign(new Error('Já há uma sincronização em curso'), { code: 'BUSY' });
  fullSyncRunning = true;
  const dryRun = opts.dryRun === true;
  const plan: SyncPlanItem[] = [];
  syncCancelled = false;
  resetSyncAbort();
  syncProgress = { running: true, total: 0, done: 0, errors: 0, phase: 'leitura' };
  try {
    onStart?.();
    const resume = opts.resume === true;

    const { settings, collMap, menu, collMargins, products: all, states, tags } =
      await (dryRun && opts.readLocal ? opts.readLocal : loadSyncData)();
    const createNewProducts = settings.createNewProducts === true;
    // Promoções em vigor (campanha ATIVA, produto INCLUIDO): preço promocional + preço riscado = referência dos 30 dias.
    const promotions = await (opts.readPromotions ?? (opts.readLocal ? async () => new Map<string, LivePromotion>() : () => loadLivePromotions()))();
    const indexes = buildActiveCollectionIndexes(collMap);
    const { lineToCollIds, familyToCollIds, subToCollIds } = indexes;
    const hierarchyById = collectionHierarchyLookup(menu);

    const eligibleLines = new Set([...lineToCollIds.keys(), ...familyToCollIds.keys()]);
    if (eligibleLines.size === 0) {
      return { message: 'Nenhuma linha de produto com mapeamento ativo', created: 0, updated: 0, errors: [] };
    }

    const skuNodeMap = new Map<string, string>();
    const skuContentHash = new Map<string, string>();
    interface ShopifyCache { productId: number; variantId: number; inventoryItemId: number }
    const skuShopifyCache = new Map<string, ShopifyCache>();
    const skuImagesSynced = new Map<string, boolean>();
    const supplierSkus = new Set<string>();
    for (const r of states) {
      supplierSkus.add(r.sku);
      if (r.shopify_node_id) skuNodeMap.set(r.sku, r.shopify_node_id);
      if (r.shopify_content_hash) skuContentHash.set(r.sku, r.shopify_content_hash);
      if (r.shopify_product_id && r.shopify_variant_id && r.shopify_inventory_item_id) {
        skuShopifyCache.set(r.sku, {
          productId: Number(r.shopify_product_id), variantId: Number(r.shopify_variant_id),
          inventoryItemId: Number(r.shopify_inventory_item_id),
        });
        skuImagesSynced.set(r.sku, r.images_synced === 1);
      }
    }

    type SyncRun = { startedAt: string; finishedAt: string | null };
    const lastRun = resume ? await loadAppState<SyncRun | null>('sync_run', null) : null;
    const resumeSince = lastRun && !lastRun.finishedAt ? lastRun.startedAt : null;
    const syncedSkus = new Set<string>();
    if (resumeSince) {
      const rows = await getMssql().selectFrom('products').select('sku')
        .where('shopify_synced_at', '>=', resumeSince).execute();
      for (const r of rows) syncedSkus.add(r.sku);
    }
    const runStartedAt = resumeSince ?? new Date().toISOString();
    if (!dryRun) {
      await saveAppState('sync_run', { startedAt: runStartedAt, finishedAt: null });
      if (resumeSince) logLine(`[Suprides] A retomar a execução de ${resumeSince}: ${syncedSkus.size} produtos já enviados ficam de fora`);
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

    // A loja manda: IDs da Shopify substituem os do catálogo; SKUs que já não existem na loja
    // saem da cache (um produto apagado à mão não é recriado — vira skip-new).
    {
      const { index, duplicates } = buildSkuIndex(shopProducts);
      if (duplicates.length) {
        logLine(`[Suprides] Aviso: ${duplicates.length} SKUs repetidos na loja (usado o 1.º produto): ${duplicates.slice(0, 10).join(', ')}`);
      }
      let fixed = 0, gone = 0;
      const updates: ShopifyIdUpdate[] = [];
      for (const sku of skuShopifyCache.keys()) {
        if (index.has(sku)) continue;
        skuShopifyCache.delete(sku);
        gone++;
        updates.push({ sku, productId: null, variantId: null, inventoryItemId: null });
      }
      for (const [sku, e] of index) {
        const c = skuShopifyCache.get(sku);
        if (c && c.productId === e.productId && c.variantId === e.variantId && c.inventoryItemId === e.inventoryItemId) continue;
        skuShopifyCache.set(sku, e);
        fixed++;
        if (supplierSkus.has(sku)) updates.push({ sku, productId: e.productId, variantId: e.variantId, inventoryItemId: e.inventoryItemId });
      }
      if (!dryRun) await updateShopifyIds(updates);
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
    const eligible = all.filter(p => {
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

    if (eligible.length === 0) {
      if (!dryRun) await saveAppState('sync_run', { startedAt: runStartedAt, finishedAt: new Date().toISOString() });
      return { message: 'Nenhum produto encontrado para as linhas mapeadas', created: 0, updated: 0, errors: [] };
    }

    const filtrados = eligible.filter(p => !syncedSkus.has(p.sku));
    const skuTagMap = new Map<string, { group: string; value: string }[]>();
    for (const row of tags) {
      if (!skuTagMap.has(row.sku)) skuTagMap.set(row.sku, []);
      skuTagMap.get(row.sku)!.push({ group: row.group_name, value: row.value });
    }

    console.log(`[Suprides] ${filtrados.length} produtos a sincronizar`);
    syncProgress = { running: true, total: filtrados.length, done: 0, errors: 0, phase: 'produtos' };

    let created = 0, updated = 0;
    const skippedNew: string[] = [];     // não existem na Shopify e createNewProducts está desligado
    let noMarginRule = 0;                // preço calculado sem regra de margem (custo + IVA)
    let unchanged = 0;                   // produtos existentes em que nada muda (nada enviado)

    // Imagens: acrescenta só as que faltam e que a Suprides já tem (não o ícone genérico).
    // Só fica marcado quando tudo está pronto na loja; o resto é confirmado por images:run.
    // Um erro aqui não falha o produto.
    const syncImages = async (sku: string, productId: number, urls: string[]) => {
      try {
        const { complete } = await sendProductImages({ sku, productId, urls });
        if (complete) skuImagesSynced.set(sku, true);
      } catch (imgErr: any) {
        console.warn(`[Suprides] imagens SKU ${sku}:`, imgErr?.message);
      }
    };
    const belowCostVat: { sku: string; price: string; cost: string }[] = []; // preço final < custo + IVA
    const errors: { sku: string; error: unknown }[] = [];
    // Produtos sem preço de custo: nunca publicar com preço inventado.
    const noCostHidden: string[] = [];   // já existiam na Shopify → passados a draft
    const noCostSkipped: string[] = [];  // não existiam → não criados
    const draftedUnmapped: string[] = []; // sem stock, fora das linhas mapeadas → draft
    const syncedAt = new Date().toISOString();

    // Acumula IDs de coleções que têm pelo menos um produto ativo (stock > 0)
    const activeCollectionIdSet = new Set<string>();

    const productCollections = (p: SupridesProduct, line: string, family: string, sub: string, shopCurrent?: SnapshotProduct) => {
      if (shopCurrent) return [...shopCurrent.collectionIds];
      const ids = buildDerivedCollectionIds(line, family, sub, collMap, indexes, hierarchyById);
      const nodeId = skuNodeMap.get(p.sku);
      if (nodeId && !ids.some(id => hierarchyById.get(id)?.l1Id)) return [nodeId];
      return ids;
    };

    // A retoma precisa das coleções dos produtos já enviados para reconstruir o menu completo.
    for (const p of eligible) {
      if (!syncedSkus.has(p.sku) || !skuShopifyCache.has(p.sku)) continue;
      if ((p.stock_status || parseStockStatus(p.stock)) === 'sem_stock') continue;
      if (!(parseFloat(normalizeMoney(String(p.price ?? ''))) > 0)) continue;
      const shopCurrent = shopCollectionSkus.has(p.sku) ? shopBySku.get(p.sku) : undefined;
      for (const id of productCollections(p, p.product_line || '', p.family || '', p.sub_family || '', shopCurrent)) {
        activeCollectionIdSet.add(id);
      }
    }

    // Cache de resolução collId → numId partilhado entre workers (promise-based para evitar duplicados)
    const resolvedCollIdCache = new Map<string, Promise<number | null>>();
    const resolveNumericCollId = (cid: string): Promise<number | null> => {
      const n = Number(cid);
      if (n) return Promise.resolve(n);
      if (!resolvedCollIdCache.has(cid)) resolvedCollIdCache.set(cid, findCollectionId(cid));
      return resolvedCollIdCache.get(cid)!;
    };

    const ivaMultiplier = ivaMultiplierOf(settings.ivaRate);
    const priceCtx: PriceContext = { margins: collMargins, hierarchyById, ivaRate: settings.ivaRate ?? 23, rounding: settings.rounding };
    // Preço base de cada SKU processado (gravado em products.base_price no sync real).
    // null = o sync não gere o preço (sem custo; fora do mapeamento e sem stock).
    const basePrices = new Map<string, { price: number; rule: string | null } | null>();

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

      // Rascunho sem mais nada (sem stock fora do mapeamento, ou sem custo): só estado (+ stock).
      const sendDraftOnly = async (productId: number, stockLabel?: string): Promise<string[]> => {
        const cur = shopById.get(productId);
        const input: Record<string, unknown> = {};
        const changes: string[] = [];
        if (!cur || cur.status !== 'DRAFT') { input.status = 'DRAFT'; changes.push('status'); }
        if (stockLabel && (cur?.stockStatus ?? '') !== stockLabel) {
          input.metafields = [{ namespace: 'custom', key: 'stock_status', value: stockLabel, type: 'single_line_text_field' }];
          changes.push('stock_status');
        }
        if (!dryRun && changes.length) {
          throwIfCancelled();
          await productUpdate(productId, input);
        }
        return changes;
      };

      if (draftOnlySkus.has(p.sku)) {
        basePrices.set(p.sku, null);
        const known = skuShopifyCache.get(p.sku)!;
        const changes = await sendDraftOnly(known.productId, formatStockStatusLabel('sem_stock'));
        if (!changes.length) unchanged++;
        if (dryRun) {
          plan.push({ sku: p.sku, action: 'draft-unmapped', shopifyProductId: known.productId, status: 'draft', stockStatus: 'sem_stock', changes });
          return;
        }
        draftedUnmapped.push(p.sku);
        return;
      }

      // Custo = só o preço de compra. O PVPR é preço de venda (com IVA) e nunca serve de custo.
      const cost = p.price != null && String(p.price) !== ''
        ? (parseFloat(normalizeMoney(String(p.price))) || 0)
        : 0;
      if (cost <= 0) {
        basePrices.set(p.sku, null);
        const known = skuShopifyCache.get(p.sku);
        const changes = known ? await sendDraftOnly(known.productId) : [];
        if (dryRun) {
          plan.push({ sku: p.sku, action: known ? 'draft-no-cost' : 'skip-no-cost', shopifyProductId: known?.productId, status: known ? 'draft' : undefined, changes });
          return;
        }
        if (known) noCostHidden.push(p.sku);
        else noCostSkipped.push(p.sku);
        return;
      }
      const costPrice = cost.toFixed(2);
      // Fora do mapeamento: coleções atuais da loja (só para a margem; não se acrescentam).
      const shopCurrent = shopCollectionSkus.has(p.sku) ? shopBySku.get(p.sku) : undefined;
      const collectionIds = productCollections(p, line, fam, sub, shopCurrent);
      // Motor de preço: margem da coleção mais profunda → IVA → arredondamento, nunca abaixo de custo + IVA.
      const { rule, price: finalPrice } = computeBasePrice(cost, collectionIds, priceCtx);
      basePrices.set(p.sku, { price: finalPrice, rule: marginRuleLabel(rule) });

      // Sem preço riscado fora de campanha (regra dos 30 dias / Omnibus, decisão 19/11): o PVPR do
      // fornecedor nunca foi um preço praticado na loja. Continua guardado em products.msrp.
      // Em promoção: o menor entre o promocional fixado e o base atual; riscado = referência dos 30 dias.
      let price = finalPrice.toFixed(2);
      let compareAtPrice: string | null = null;
      const promo = promotions.get(p.sku);
      if (promo) {
        const s = promoShopPrices(promo.promoPrice, promo.referencePrice, finalPrice);
        price = s.price.toFixed(2);
        compareAtPrice = s.compareAtPrice == null ? null : s.compareAtPrice.toFixed(2);
      }

      const stockStatus = (p.stock_status as string) || parseStockStatus(p.stock);
      const title  = p.name || p.sku || 'Produto';
      // Disponível / brevemente / sob encomenda ficam visíveis; sem stock fica escondido.
      const status = stockStatus === 'sem_stock' ? 'draft' : 'active';

      const filtros = (skuTagMap.get(p.sku) ?? []).map(({ group, value }) => ({
        namespace: 'filtros', key: toMetafieldKey(group), value,
      }));

      const imageUrls: string[] = (Array.isArray(p.images) ? p.images : [])
        .map((src: unknown) => (typeof src === 'string' ? src.trim() : ''))
        .filter((src: string) => /^https?:\/\//i.test(src));
      const weightGrams = p.weight ? Math.round(parseFloat(String(p.weight)) * 1000) : undefined;

      // O índice da loja (lido no início) diz se o produto existe; sem ele não se cria nada.
      const known = skuShopifyCache.get(p.sku);
      if (!known && !createNewProducts) {
        skippedNew.push(p.sku);
        if (dryRun) {
          plan.push({
            sku: p.sku, action: 'skip-new', status, price, compareAtPrice, cost: costPrice, stockStatus,
            marginRule: marginRuleLabel(rule), collectionIds,
          });
        }
        return;
      }

      if (!rule) noMarginRule++;
      if (Number(price) < cost * ivaMultiplier - 0.005) belowCostVat.push({ sku: p.sku, price, cost: costPrice });

      // Acumular coleções de produtos visíveis para o menu público
      if (status === 'active') {
        for (const cid of collectionIds) activeCollectionIdSet.add(cid);
      }

      // Coleções por ID numérico (os nós antigos podem vir por título).
      const numericCollectionIds = async (): Promise<string[]> => {
        if (shopCurrent) return [];               // fora do mapeamento: não se mexe nas coleções
        const out: string[] = [];
        for (const cid of collectionIds) {
          if (/^\d+$/.test(cid)) { out.push(cid); continue; }
          if (dryRun) continue;
          const n = await resolveNumericCollId(cid);
          if (n) out.push(String(n));
        }
        return out;
      };

      const desired: DesiredProduct = {
        title,
        descriptionHtml: _buildBodyHtml(p, line, fam, sub),
        vendor: p.brand ?? 'Suprides',
        productType: shopCurrent && !line ? shopCurrent.productType : line, // linha vazia não apaga o tipo da loja
        status: status === 'active' ? 'ACTIVE' : 'DRAFT',
        stockStatusLabel: formatStockStatusLabel(stockStatus as StockStatus),
        filtros,
        collectionIds: await numericCollectionIds(),
        price,
        compareAtPrice,
        barcode: p.ean || null,
        cost: costPrice,
        weightGrams,
      };

      if (!known) {
        // Criar (só com createNewProducts ligado).
        if (dryRun) {
          plan.push({
            sku: p.sku, action: 'create', status, price, compareAtPrice, cost: costPrice, stockStatus,
            marginRule: marginRuleLabel(rule), collectionIds,
          });
          return;
        }
        throwIfCancelled();
        const createdIds = await createProduct({
          title: desired.title, descriptionHtml: desired.descriptionHtml, vendor: desired.vendor,
          productType: desired.productType, handle: slug(`${title}-${p.sku}`), status: desired.status,
          sku: p.sku, price, compareAtPrice: desired.compareAtPrice, barcode: desired.barcode, cost: costPrice,
          weightGrams, collectionIds: desired.collectionIds,
          metafields: [{ namespace: 'custom', key: 'stock_status', value: desired.stockStatusLabel }, ...filtros],
        });
        if (desired.status === 'ACTIVE') await publishProduct(createdIds.productId);
        await getMssql().updateTable('products').set({
          shopify_product_id: createdIds.productId, shopify_variant_id: createdIds.variantId,
          shopify_inventory_item_id: createdIds.inventoryItemId, shopify_content_hash: contentHash(desired),
        }).where('sku', '=', p.sku).execute();
        skuShopifyCache.set(p.sku, { productId: createdIds.productId, variantId: createdIds.variantId, inventoryItemId: createdIds.inventoryItemId });
        markDone(p, 'created');
        if (!opts.skipImages && imageUrls.length) await syncImages(p.sku, createdIds.productId, imageUrls);
        return;
      }

      const cur = shopById.get(known.productId)!;
      const w = planProductWrite(desired, cur, skuContentHash.get(p.sku) ?? null);
      if (!w.changes.length) unchanged++;

      if (dryRun) {
        plan.push({
          sku: p.sku, action: 'update', shopifyProductId: known.productId,
          status, price, compareAtPrice, cost: costPrice, stockStatus,
          marginRule: marginRuleLabel(rule),
          collectionIds, changes: w.changes,
        });
        return;
      }

      throwIfCancelled();
      if (w.product) await productUpdate(known.productId, w.product);
      if (w.variant) { throwIfCancelled(); await variantUpdate(known.productId, known.variantId, w.variant); }
      if (w.publish) { throwIfCancelled(); await publishProduct(known.productId); }
      if (w.product && w.contentHash !== skuContentHash.get(p.sku)) {
        await getMssql().updateTable('products').set({ shopify_content_hash: w.contentHash })
          .where('sku', '=', p.sku).execute();
        skuContentHash.set(p.sku, w.contentHash);
      }
      markDone(p, 'updated');

      if (!opts.skipImages && imageUrls.length > 0 && skuImagesSynced.get(p.sku) !== true) {
        await syncImages(p.sku, known.productId, imageUrls);
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
            if (!dryRun) {
              const base = basePrices.get(p.sku);
              const now = new Date().toISOString();
              await getMssql().updateTable('products').set({
                shopify_synced_at: now,
                ...(base !== undefined ? {
                  base_price: base ? base.price.toFixed(2) : null,
                  base_margin_rule: base?.rule ?? null,
                  base_price_at: now,
                } : {}),
              }).where('sku', '=', p.sku).execute();
            }
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
          unchanged,
          changesByField: plan.reduce((m, x) => { for (const c of x.changes || []) m[c] = (m[c] || 0) + 1; return m; }, {} as Record<string, number>),
          active: sent.filter(x => x.status === 'active').length,
          draft: sent.filter(x => x.status === 'draft').length,
          activeCollections: activeCollectionIdSet.size,
        },
        checks,
        errors,
        plan,
      };
    }

    if (filtrados.length) {
      const stats = await loadStats();
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
      await saveStats(stats);
    }

    // Gerar e (opcionalmente) publicar menu público
    const completed = !syncCancelled && !errors.length;
    const publicMenuFile = completed ? await buildPublicMenuTree([...activeCollectionIdSet]) : await loadPublicMenu();

    // Reconstruir shopify_node_id agora que o menu público está actualizado
    try {
      if (completed) {
        const { updated: nodeUpdated } = await rebuildProductNodeIds();
        console.log(`[Suprides] shopify_node_id reconstruídos: ${nodeUpdated} produtos`);
      }
    } catch (e: any) {
      console.warn('[Suprides] rebuildProductNodeIds falhou:', e?.message);
    }

    let menuPublishWarning: string | undefined;

    const shouldPublish = settings.autoPublishPublicMenu !== false;
    if (shouldPublish && completed && !syncCancelled) {
      try {
        const menuHandle = settings.publicMenuHandle || 'menu-publico';
        const menuTitle  = settings.publicMenuTitle  || 'Menu Público';
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
    if (!wasCancelled && !errors.length) {
      await saveAppState('sync_run', { startedAt: runStartedAt, finishedAt: new Date().toISOString() });
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
    const all = await getAllProducts();
    const skuToProduct = new Map(all.map((p: any) => [p.sku, p]));

    const [collMap, menu] = await Promise.all([loadShopifyCollectionMapping(), loadMenuItems()]);
    const indexes = buildActiveCollectionIndexes(collMap);
    const hierarchyById = collectionHierarchyLookup(menu);
    const titleById = collectionTitleLookup(menu);
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
        await removeProductFromCollection(item.productId, Number(item.collectionId));
        removed++;
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
    const all = await getAllProducts();
    res.json(buildFamiliasFromProducts(all));
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar cache', detail: err.message });
  }
});

async function syncStock() {
  const shop = await readAllProducts();
  const byId = new Map(shop.map(sp => [sp.productId, sp]));
  const stored = await getMssql().selectFrom('products')
    .select(['sku', 'shopify_product_id', 'stock_status', 'stock'])
    .where('shopify_product_id', 'is not', null).execute();
  const rows = stored.map(r => ({ sku: String(r.sku), stock_status: r.stock_status, stock: r.stock, shopify_product_id: Number(r.shopify_product_id) }))
    .filter(r => byId.has(r.shopify_product_id));

  if (rows.length === 0) {
    return { message: 'Nenhum produto sincronizado ao Shopify', updated: 0, errors: [] };
  }

  let updated = 0;
  const errors: { sku: string; error: unknown }[] = [];

  const processOne = async (r: typeof rows[number]) => {
    const cur = byId.get(r.shopify_product_id)!;
    const stockStatus = r.stock_status || parseStockStatus(r.stock != null ? String(r.stock) : undefined);
    const status = stockStatus === 'sem_stock' ? 'DRAFT' : 'ACTIVE';
    const label = formatStockStatusLabel(stockStatus as StockStatus);
    const input: Record<string, unknown> = {};
    if (cur.status !== status) input.status = status;
    if ((cur.stockStatus ?? '') !== label) {
      input.metafields = [{ namespace: 'custom', key: 'stock_status', value: label, type: 'single_line_text_field' }];
    }
    if (!Object.keys(input).length) return;
    await productUpdate(r.shopify_product_id, input);
    if (status === 'ACTIVE' && !cur.publishedAt) await publishProduct(r.shopify_product_id);
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

  return { message: `Stock sincronizado: ${updated} produtos alterados`, updated, errors };
}

// Sync rápido — só estado de stock. Não toca em títulos, imagens, preços nem coleções.
// Lê a loja e, para cada produto já na Shopify, envia só o que mudou:
//   - status do produto (ACTIVE / DRAFT) consoante o stock_status (publica se reativar);
//   - metafield custom.stock_status.
// Lê o stock_status que a importação (API → SQL Server) gravou.
router.post('/sync-stock', async (_req, res) => {
  if (fullSyncRunning) {
    res.status(409).json({ error: 'Há um sync em curso' });
    return;
  }
  fullSyncRunning = true;
  try {
    res.json(await withCatalogueLock(syncStock));
  } catch (err: any) {
    res.status(err.code === 'BUSY' ? 409 : 500).json({ error: 'Erro ao sincronizar stock', detail: err.message });
  } finally {
    fullSyncRunning = false;
  }
});

export default router;
