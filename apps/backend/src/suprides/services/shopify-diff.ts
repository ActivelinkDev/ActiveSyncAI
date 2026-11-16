/**
 * Sync por diferenças: compara o que o produto devia ser com o estado lido da loja
 * (cópia no início do sync) e devolve só o que tem de ser enviado.
 *
 * - Estado, stock (metafield), preço, preço riscado, EAN, custo, peso e coleções:
 *   comparados com a loja.
 * - Conteúdo (título, descrição, marca, tipo, filtros): a Shopify reescreve o HTML da
 *   descrição, por isso compara-se com um hash do que foi enviado da última vez
 *   (coluna shopify_content_hash). Sem hash → envia-se.
 */
import crypto from 'crypto';
import type { SnapshotProduct } from '../api/shopify-read';

export interface DesiredMetafield { namespace: string; key: string; value: string }

export interface DesiredProduct {
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: 'ACTIVE' | 'DRAFT';
  /** custom.stock_status (label legível). */
  stockStatusLabel: string;
  /** filtros.* (tags da IA). */
  filtros: DesiredMetafield[];
  /** IDs numéricos de coleções onde o produto tem de estar (nunca se retira de coleções). */
  collectionIds: string[];
  price?: string;
  compareAtPrice?: string | null;
  barcode?: string | null;
  cost?: string;
  weightGrams?: number;
}

export interface ProductWritePlan {
  /** Input de productUpdate (sem id), ou null se nada mudou no produto. */
  product: Record<string, unknown> | null;
  /** Input de productVariantsBulkUpdate (sem id), ou null se nada mudou na variante. */
  variant: Record<string, unknown> | null;
  /** Passa a ativo e não está publicado na Loja online. */
  publish: boolean;
  /** Novo hash de conteúdo (gravar depois de enviar com sucesso). */
  contentHash: string;
  /** Campos alterados (para o dry-run e logs). */
  changes: string[];
}

export function contentHash(d: Pick<DesiredProduct, 'title' | 'descriptionHtml' | 'vendor' | 'productType' | 'filtros'>): string {
  const filtros = [...d.filtros].sort((a, b) => (a.namespace + a.key).localeCompare(b.namespace + b.key));
  return crypto.createHash('sha1')
    .update(JSON.stringify([d.title, d.descriptionHtml, d.vendor, d.productType, filtros]))
    .digest('hex');
}

const money = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const GRAMS_PER: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, POUNDS: 453.59237, OUNCES: 28.349523125 };
export const toGrams = (w: SnapshotProduct['weight']): number | null =>
  w ? Math.round(w.value * (GRAMS_PER[w.unit] ?? 1) * 1000) / 1000 : null;

const gid = (type: string, id: string | number) => `gid://shopify/${type}/${id}`;

export function planProductWrite(
  desired: DesiredProduct,
  current: SnapshotProduct,
  lastContentHash: string | null,
): ProductWritePlan {
  const changes: string[] = [];
  const product: Record<string, unknown> = {};
  const hash = contentHash(desired);

  const contentChanged = hash !== lastContentHash;
  const stockChanged = (current.stockStatus ?? '') !== desired.stockStatusLabel;
  if (contentChanged) {
    product.title = desired.title;
    product.descriptionHtml = desired.descriptionHtml;
    product.vendor = desired.vendor;
    product.productType = desired.productType;
    product.tags = '';
    changes.push('conteudo');
  }
  if (contentChanged || stockChanged) {
    product.metafields = [
      { namespace: 'custom', key: 'stock_status', value: desired.stockStatusLabel, type: 'single_line_text_field' },
      ...(contentChanged ? desired.filtros.map(m => ({ ...m, type: 'single_line_text_field' })) : []),
    ];
    if (stockChanged) changes.push('stock_status');
  }
  if (current.status !== desired.status) {
    product.status = desired.status;
    changes.push('status');
  }
  const have = new Set(current.collectionIds);
  const join = desired.collectionIds.filter(id => /^\d+$/.test(id) && !have.has(id));
  if (join.length) {
    product.collectionsToJoin = join.map(id => gid('Collection', id));
    changes.push('colecoes');
  }

  const variant: Record<string, unknown> = {};
  const inventoryItem: Record<string, unknown> = {};
  if (desired.price !== undefined && money(desired.price) !== money(current.price)) {
    variant.price = desired.price;
    changes.push('preco');
  }
  if (desired.compareAtPrice !== undefined && money(desired.compareAtPrice) !== money(current.compareAtPrice)) {
    variant.compareAtPrice = desired.compareAtPrice;
    changes.push('preco_riscado');
  }
  if (desired.barcode && desired.barcode !== (current.barcode ?? '')) {
    variant.barcodes = [{ value: desired.barcode }];
    changes.push('ean');
  }
  if (desired.cost !== undefined && money(desired.cost) !== money(current.cost)) {
    inventoryItem.cost = desired.cost;
    changes.push('custo');
  }
  if (desired.weightGrams !== undefined) {
    const cur = toGrams(current.weight);
    if (cur == null || Math.abs(cur - desired.weightGrams) > 0.5) {
      inventoryItem.measurement = { weight: { value: desired.weightGrams, unit: 'GRAMS' } };
      changes.push('peso');
    }
  }
  if (Object.keys(inventoryItem).length) variant.inventoryItem = inventoryItem;

  const publish = desired.status === 'ACTIVE' && !current.publishedAt;
  if (publish) changes.push('publicar');

  return {
    product: Object.keys(product).length ? product : null,
    variant: Object.keys(variant).length ? variant : null,
    publish,
    contentHash: hash,
    changes,
  };
}
