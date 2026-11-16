import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

const API_ROOT = ((window as any).ENV_API_BASE?.replace(/\/+$/, '') || 'http://localhost:3004') + '/api';
export type SupplierKey = 'suprides' | 'esprinet';

export interface FamiliaTree {
  product_line: string;
  familias: { family: string; subfamilias: string[] }[];
}

export type PriceMode = 'percentage' | 'fixed';

export interface PricingRule { mode: PriceMode; marginValue: number; }
export interface LinePricingRule  extends PricingRule { product_line: string; }
export interface FamilyPricingRule extends PricingRule { family: string; }
export interface SubfamiliaPricingRule extends PricingRule { subfamilia: string; }

export interface Margins {
  linePricingRules: LinePricingRule[];
  familyPricingRules: FamilyPricingRule[];
  pricingRules: SubfamiliaPricingRule[];
}

export interface Rounding { }
export interface AdminSettings { ivaRate: number; rounding: Rounding; }

export interface LineMapping { product_line: string; active: boolean; menuItem?: string; }

export interface FamilyMapping {
  product_line: string;
  family: string;
  active: boolean;
  shopifyLevel2?: string;
  shopifyLevel3?: string;
}

export interface Mappings {
  suprides?: LineMapping[];
  lineToMenu?: Record<string, string>;
  familyMappings?: FamilyMapping[];
}

export interface SyncStats {
  api: string;
  lastSyncAt: string | null;
  totals: { requested: number; synced: number; created: number; updated: number; errors: number };
  history: { timestamp: string; requested: number; synced: number; created: number; updated: number; errors: number }[];
  latestProducts: { sku: string; title: string; action: string; syncedAt: string }[];
}

export interface SyncProgress { running: boolean; total: number; done: number; errors: number; phase?: 'leitura' | 'produtos'; }
export interface SyncFamiliasResult {
  message: string; created: number; updated: number; errors: any[]; cancelled?: boolean;
  skippedNew?: number; snapshot?: string;
}
export interface LastSyncResult {
  startedAt: string; finishedAt?: string; resume: boolean;
  ok?: boolean; result?: SyncFamiliasResult; error?: string;
}
export interface CollectionMarginRule { mode: PriceMode; marginValue: number; }
export interface CollectionMargins { rules: Record<string, CollectionMarginRule>; }

export interface ShopifyMenuItem {
  id: string;
  title: string;
  type: string;
  resourceId?: string;
  url?: string;
  items: ShopifyMenuItem[];
}

export interface ShopifyMenu {
  id: string | null;
  handle: string;
  title: string;
  items: ShopifyMenuItem[];
}

export interface MenuSyncNode {
  title: string;
  shopifyId?: string;
  children: MenuSyncNode[];
}

export interface ShopifyCollectionMapping {
  menu:       Record<string, string[]>;
  familia:    Record<string, string[]>;
  subfamilia: Record<string, string[]>;
  hidden?:    Record<string, boolean>;
}

export interface SyncFamiliasAudit {
  summary: {
    proposedDerivedParents: {
      eligibleProducts: number;
      productsWithCollections: number;
      productsWithoutCollections: number;
      uniqueCollectionIds: number;
    };
  };
  review: {
    productsToSync: number;
    collections: {
      id: string;
      title: string;
      level: 'L1' | 'L2' | 'L3' | 'unknown';
      productCount: number;
    }[];
  };
}

@Injectable({ providedIn: 'root' })
export class SupridesService {
  private supplier: SupplierKey = 'suprides';

  constructor(private http: HttpClient) {}

  withSupplier(supplier: SupplierKey): SupridesService {
    const clone = new SupridesService(this.http);
    clone.supplier = supplier;
    return clone;
  }

  private get api(): string {
    return `${API_ROOT}/${this.supplier}`;
  }

  getFamilias(force = false): Observable<FamiliaTree[]> {
    return this.http.get<FamiliaTree[]>(`${this.api}/familias${force ? '?force=true' : ''}`);
  }

  getMappings(): Observable<Mappings> {
    return this.http.get<Mappings>(`${this.api}/mappings`);
  }

  saveMappings(data: Mappings): Observable<Mappings> {
    return this.http.put<Mappings>(`${this.api}/mappings`, data);
  }

  getMargins(): Observable<Margins> {
    return this.http.get<Margins>(`${this.api}/margins`);
  }

  saveMargins(data: Margins): Observable<Margins> {
    return this.http.put<Margins>(`${this.api}/margins`, data);
  }

  getAdminSettings(): Observable<AdminSettings> {
    return this.http.get<AdminSettings>(`${this.api}/admin/settings`);
  }

  saveAdminSettings(data: AdminSettings): Observable<AdminSettings> {
    return this.http.put<AdminSettings>(`${this.api}/admin/settings`, data);
  }

  getSyncStats(): Observable<SyncStats> {
    return this.http.get<SyncStats>(`${this.api}/admin/sync-stats`);
  }

  resetSyncStats(): Observable<SyncStats> {
    return this.http.post<SyncStats>(`${this.api}/admin/sync-stats/reset`, {});
  }

  getSyncProgress(): Observable<SyncProgress> {
    return this.http.get<SyncProgress>(`${this.api}/progress`);
  }

  /** Lança o sync em segundo plano (202). O resultado lê-se em getLastSyncResult(). */
  startSyncFamilias(resume = false): Observable<{ ok: boolean; message: string; startedAt: string }> {
    return this.http.post<any>(`${this.api}/sync-familias`, { resume });
  }

  getLastSyncResult(): Observable<LastSyncResult | null> {
    return this.http.get<LastSyncResult | null>(`${this.api}/sync-familias/last-result`);
  }

  getSyncFamiliasAudit(limit = 0): Observable<SyncFamiliasAudit> {
    return this.http.get<SyncFamiliasAudit>(`${this.api}/sync-familias/audit?limit=${limit}`);
  }

  cancelSync(): Observable<{ ok: boolean; message: string }> {
    return this.http.post<any>(`${this.api}/cancel`, {});
  }

  refreshFamiliasCache(): Observable<FamiliaTree[]> {
    return this.http.post<FamiliaTree[]>(`${this.api}/sync-familias-cache`, {});
  }

  getMenuNodes(): Observable<MenuSyncNode[]> {
    return this.http.get<MenuSyncNode[]>(`${this.api}/menu/nodes`);
  }

  getCollectionMargins(): Observable<CollectionMargins> {
    return this.http.get<CollectionMargins>(`${this.api}/margins/collection`);
  }

  saveCollectionMargins(data: CollectionMargins): Observable<CollectionMargins> {
    return this.http.put<CollectionMargins>(`${this.api}/margins/collection`, data);
  }

  getShopifyMenu(): Observable<ShopifyMenu> {
    return this.http.get<ShopifyMenu>(`${this.api}/menu`);
  }

  saveShopifyMenu(nodes: MenuSyncNode[]): Observable<{ nodes: MenuSyncNode[] }> {
    return this.http.put<{ nodes: MenuSyncNode[] }>(`${this.api}/menu`, { nodes });
  }

  syncShopifyMenu(nodes: MenuSyncNode[]): Observable<{ type: string; phase?: string; done?: number; total?: number; created?: number; renamed?: number; errors?: string[]; message?: string }> {
    const url = `${this.api}/menu/sync`;
    return new Observable(obs => {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes })
      }).then(async res => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.trim();
            if (line.startsWith('data: ')) {
              try { obs.next(JSON.parse(line.slice(6))); } catch { /* ignore malformed */ }
            }
          }
        }
        obs.complete();
      }).catch(e => obs.error(e));
    });
  }

  resolveMenuIds(): Observable<{ resolved: number; total: number }> {
    return this.http.post<any>(`${this.api}/menu/resolve-ids`, {});
  }

  getShopifyCollectionMapping(): Observable<ShopifyCollectionMapping> {
    return this.http.get<ShopifyCollectionMapping>(`${this.api}/collection-mapping`);
  }

  saveShopifyCollectionMapping(data: ShopifyCollectionMapping): Observable<ShopifyCollectionMapping> {
    return this.http.put<ShopifyCollectionMapping>(`${this.api}/collection-mapping`, data);
  }
}
