import {
  upsertProductsBatch, countProducts, countActiveProducts, markMissingAsRemoved, withCatalogueLock, SupridesProduct,
} from "../../repositories/suprides-cache";
import { getProducts, parseStock, parseStockStatus } from "../api/suprides-api";
import { normalizeMoney } from "./price-calc";
import { rebuildProductNodeIds } from "./menu-resolver";
import { loadPublicMenu } from "../repositories/store";
import { logLine } from "../../utils/logger";

export type ImportEvent =
  | { type: "start"; message: string }
  | { type: "progress" | "log"; message: string; saved?: number }
  | { type: "done"; message: string; inserted: number; total: number; removed: number }
  | { type: "error"; message: string };

export interface ImportResult {
  saved: number;
  total: number;
  removed: number;
  removalSkipped: boolean;
}

const PAGE_SIZE = 100;
const WAVE_SIZE = 5;                 // páginas em paralelo por onda (5 × 100 = 500 produtos)
const PAGE_RETRIES = 3;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
// Travão: se a importação trouxer menos do que isto dos produtos ativos, não marca nada
// como retirado (provável resposta incompleta da API, não uma limpeza real do catálogo).
const MIN_SEEN_RATIO = 0.85;

let importRunning = false;
export const isImportRunning = () => importRunning;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function cleanHtml(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value);
  return str
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, " ")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .trim() || null;
}

export function mapApiProduct(p: any): SupridesProduct {
  return {
    sku:               String(p.sku ?? ""),
    ean:               p.ean          ? String(p.ean)          : null,
    part_number:       p.part_number  ? String(p.part_number)  : null,
    brand:             p.brand        ? String(p.brand)        : null,
    product_line:      p.product_line ? String(p.product_line) : null,
    family:            p.Family ?? p.family ? String(p.Family ?? p.family) : null,
    sub_family:        p.sub_family   ? String(p.sub_family)   : null,
    name:              p.name         ? String(p.name)         : null,
    price:             p.price != null ? (parseFloat(normalizeMoney(String(p.price))) || null) : null,
    pvpr:              p.pvpr  != null ? (parseFloat(normalizeMoney(String(p.pvpr)))  || null) : null,
    stock:             parseStock(p.stock != null ? String(p.stock) : undefined),
    stock_status:      parseStockStatus(p.stock != null ? String(p.stock) : undefined),
    images:            Array.isArray(p.images) && p.images.length > 0
                         ? JSON.stringify(p.images.map(String).filter(Boolean))
                         : null,
    weight:            p.weight != null ? Number(p.weight) : null,
    cor:               p.cor          ? String(p.cor)          : null,
    description:       cleanHtml(p.description),
    manufacturer:      p.manufacturer ? String(p.manufacturer) : null,
    short_description: cleanHtml(p.short_description),
  };
}

type PageFetcher = (page: number, limit: number) => Promise<any[]>;

async function fetchPageWithRetry(page: number, fetchPage: PageFetcher = getProducts): Promise<any[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt++) {
    try {
      const batch = await fetchPage(page, PAGE_SIZE);
      if (!Array.isArray(batch)) throw new Error(`Resposta inesperada da API na página ${page}`);
      return batch;
    } catch (err) {
      lastErr = err;
      if (attempt < PAGE_RETRIES - 1) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  const msg = (lastErr as any)?.message ?? String(lastErr);
  throw new Error(`Página ${page} falhou após ${PAGE_RETRIES} tentativas: ${msg}`);
}

/**
 * Importa o catálogo completo da API Suprides para o SQL Server.
 * - Uma página que falhe (após retries) aborta a importação: os produtos já gravados
 *   ficam atualizados, mas nada é marcado como retirado.
 * - SKUs ausentes são marcados como retirados (sem stock), nunca apagados.
 */
export async function runSupridesImport(
  emit: (e: ImportEvent) => void = () => {},
  /** fetchPage: só para testes (substitui a chamada à API). */
  opts: { allowLargeRemoval?: boolean; fetchPage?: PageFetcher } = {},
): Promise<ImportResult> {
  if (importRunning) throw Object.assign(new Error("Importação Suprides já em curso"), { code: "BUSY" });
  importRunning = true;

  const say = (e: ImportEvent) => {
    emit(e);
    if (e.type !== "progress") logLine(`[Suprides import] ${e.message}`);
  };

  try {
    return await withCatalogueLock(importCatalogue);
  } catch (err: any) {
    say({ type: "error", message: err?.message ?? "Erro desconhecido na importação" });
    throw err;
  } finally {
    importRunning = false;
  }

  async function importCatalogue() {
    say({ type: "start", message: "A iniciar importação da API Suprides…" });

    const activeBefore = await countActiveProducts();
    const seenSkus = new Set<string>();
    let waveStart = 1;
    let totalSaved = 0;
    let done = false;

    while (!done) {
      const pages = Array.from({ length: WAVE_SIZE }, (_, i) => waveStart + i);
      say({
        type: "progress",
        saved: totalSaved,
        message: `A buscar páginas ${pages[0]}–${pages[pages.length - 1]}…`,
      });

      // Lança se alguma página falhar definitivamente.
      const results = await Promise.all(pages.map(pg => fetchPageWithRetry(pg, opts.fetchPage)));

      const waveMapped: SupridesProduct[] = [];
      // Processa todas as páginas da onda (como antes); uma página curta marca o fim.
      for (const batch of results) {
        waveMapped.push(...batch.map(mapApiProduct).filter(p => p.sku.length > 0));
        if (batch.length < PAGE_SIZE) done = true;
      }

      if (waveMapped.length > 0) {
        await upsertProductsBatch(waveMapped);
        waveMapped.forEach(p => seenSkus.add(p.sku));
        totalSaved += waveMapped.length;
        say({ type: "log", saved: totalSaved, message: `Guardados ${waveMapped.length} produtos (total: ${totalSaved})` });
      }

      waveStart += WAVE_SIZE;
    }

    let removed = 0;
    let removalSkipped = false;
    // allowLargeRemoval: confirmação humana de que o catálogo encolheu mesmo (uso pontual).
    if (!opts.allowLargeRemoval && activeBefore > 0 && seenSkus.size < activeBefore * MIN_SEEN_RATIO) {
      removalSkipped = true;
      say({
        type: "log",
        message: `ATENÇÃO: a API devolveu ${seenSkus.size} produtos para ${activeBefore} ativos (< ${MIN_SEEN_RATIO * 100}%). ` +
                 `Nenhum produto foi marcado como retirado. Se o catálogo encolheu mesmo, repetir com ?allowLargeRemoval=1.`,
      });
    } else {
      removed = await markMissingAsRemoved(seenSkus);
      if (removed > 0) say({ type: "log", message: `${removed} produtos deixaram de vir na API: marcados como retirados (sem stock).` });
    }

    const total = await countProducts();
    const publicMenu = await loadPublicMenu();
    if (publicMenu.nodes && publicMenu.nodes.length > 0) {
      const { updated } = await rebuildProductNodeIds();
      say({ type: "log", message: `Node IDs reconstruídos: ${updated} produtos mapeados ao menu.` });
    } else {
      say({ type: "log", message: "Menu público vazio — shopify_node_id não reconstruído (corre Sync Shopify)." });
    }

    say({ type: "done", inserted: totalSaved, total, removed, message: `Concluído — ${totalSaved} produtos importados.` });
    return { saved: totalSaved, total, removed, removalSkipped };
  }
}
