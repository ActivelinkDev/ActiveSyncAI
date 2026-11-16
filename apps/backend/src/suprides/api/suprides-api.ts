import axios from 'axios';
import type { SupridesProduct } from '../types';
import { loadConnectionSettings } from '../repositories/store';

function getSupridesCredentials() {
  const s = loadConnectionSettings();
  return {
    url:   s.supridesUrl   || process.env.SUPRIDES_URL   || '',
    user:  s.supridesUser  || process.env.SUPRIDES_USER  || '',
    pass:  s.supridesPass  || process.env.SUPRIDES_PASS  || '',
    token: s.supridesToken || process.env.SUPRIDES_TOKEN || '',
  };
}

export async function getProducts(
  page = 1,
  limit = 100,
  ean?: string,
  name?: string
): Promise<SupridesProduct[]> {
  const { url: SUPRIDES_URL, user: SUPRIDES_USER, pass: SUPRIDES_PASS, token: SUPRIDES_TOKEN } = getSupridesCredentials();
  const params: Record<string, unknown> = { user: SUPRIDES_USER, password: SUPRIDES_PASS, page, limit };
  if (ean)  params.EAN  = ean;
  if (name) params.name = name;

  const response = await axios.get<SupridesProduct[] | [{ status: string; message: string }]>(
    SUPRIDES_URL,
    {
      params,
      headers: { Authorization: `Bearer ${SUPRIDES_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 200_000,
    }
  );

  const data = response.data;
  if (Array.isArray(data) && data.length > 0 && (data[0] as any).status === 'ERROR') {
    throw new Error(`Suprides API: ${(data[0] as any).message}`);
  }

  return data as SupridesProduct[];
}

export function parseStock(stockStr?: string): number {
  if (!stockStr) return 0;
  const s = String(stockStr).toLowerCase().trim();

  if (s.includes('esgotado') || s.includes('brevemente') || s.includes('encomenda')) return 0;
  if (s.includes('> 10') || s.includes('>10')) return 20;
  if (s.includes('< 10') || s.includes('<10')) return 5;
  if (s.includes('< 2')  || s.includes('<2'))  return 1;
  if (s.includes('disponív') || s.includes('disponiv')) return 10;
  if (s.includes('reduzido')) return 1;

  const m = stockStr.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

export type StockStatus = 'disponivel' | 'brevemente' | 'sob_encomenda' | 'sem_stock';

// Label legível enviado ao Shopify (metafield custom.stock_status). É este valor
// que aparece como opção de filtro na loja, por isso tem de estar formatado.
const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  disponivel:    'Disponível',
  brevemente:    'Brevemente',
  sob_encomenda: 'Sob Encomenda',
  sem_stock:     'Sem Stock',
};

export function formatStockStatusLabel(status: StockStatus): string {
  return STOCK_STATUS_LABELS[status] ?? 'Sem Stock';
}

/**
 * Estado semântico do stock, preservado a partir do texto da API.
 * O parseStock() colapsa "brevemente"/"encomenda"/"esgotado" todos em 0 — esta
 * função mantém a distinção para a loja saber o que mostrar.
 */
export function parseStockStatus(stockStr?: string): StockStatus {
  if (!stockStr) return 'sem_stock';
  const s = String(stockStr).toLowerCase().trim();

  if (s.includes('esgotado'))   return 'sem_stock';
  if (s.includes('encomenda'))  return 'sob_encomenda';
  if (s.includes('brevemente')) return 'brevemente';
  if (s.includes('disponív') || s.includes('disponiv')) return 'disponivel';
  if (s.includes('reduzido')) return 'disponivel';

  const m = s.match(/(\d+)/);
  if (m) return parseInt(m[1], 10) > 0 ? 'disponivel' : 'sem_stock';

  return 'sem_stock';
}
