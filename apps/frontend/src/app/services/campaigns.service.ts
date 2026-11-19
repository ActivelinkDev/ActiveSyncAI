import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type CampaignStatus = 'RASCUNHO' | 'AGENDADA' | 'ATIVA' | 'TERMINADA' | 'CANCELADA';
export type DiscountType = 'PERCENT' | 'AMOUNT';
export interface Discount { type: DiscountType; value: number }

export interface CampaignInput {
  name: string; discountType: DiscountType; discountValue: number;
  /** ISO (UTC). */
  startsAt: string; endsAt: string; notes?: string | null;
}

export interface Campaign extends CampaignInput {
  id: number; status: CampaignStatus; createdAt: string;
  scheduledAt: string | null; startedAt: string | null; endedAt: string | null;
}

export interface CampaignSummary extends Campaign { products: number; included: number; blocked: number; withdrawn: number }

export interface ProductInfo {
  sku: string; name: string | null; brand: string | null; productLine: string | null; family: string | null;
  stockStatus: string | null; cost: number | null; basePrice: number | null; inShop: boolean;
}

export interface CampaignProduct {
  sku: string; state: 'INCLUIDO' | 'BLOQUEADO' | 'RETIRADO';
  blockReason: string | null; warning: string | null; override: Discount | null;
  basePrice: number | null; referencePrice: number | null; promoPrice: number | null; costAtStart: number | null;
  appliedAt: string | null; revertedAt: string | null; removedAt: string | null; removedReason: string | null;
  product: ProductInfo | null;
}

export interface CampaignDetail extends Campaign { products: CampaignProduct[] }

export interface ValidRange { minAmount: number; maxAmount: number; minPercent: number; maxPercent: number }

export interface PreviewItem {
  sku: string; state: 'INCLUIDO' | 'BLOQUEADO'; blockReason: string | null; warning: string | null;
  base: number | null; reference: number | null; promo: number | null; cost: number | null;
  discount: Discount; override: Discount | null; range: ValidRange | null; product: ProductInfo | null;
}

export interface CampaignsStatus { tickerEnabled: boolean; historySince: string | null; validFrom: string | null }
export interface FilterOptions { brands: string[]; productLines: string[]; families: string[]; stockStatuses: string[] }
export interface SelectionFilters {
  brand?: string; productLine?: string; family?: string; stockStatus?: string; text?: string; skus?: string; onlyManaged?: boolean;
}

/** Mensagem legível de um erro da API. */
export function apiError(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'Sem ligação ao servidor.';
    return e.error?.error || `Erro ${e.status}`;
  }
  return (e as any)?.message || 'Erro inesperado';
}

@Injectable({ providedIn: 'root' })
export class CampaignsService {
  private http = inject(HttpClient);
  private API = '/api/campanhas';

  status() { return firstValueFrom(this.http.get<CampaignsStatus>(`${this.API}/status`)); }
  filters() { return firstValueFrom(this.http.get<FilterOptions>(`${this.API}/filtros`)); }
  select(f: SelectionFilters) {
    return firstValueFrom(this.http.post<{ products: ProductInfo[]; truncated: boolean }>(`${this.API}/selecao`, f));
  }

  list() { return firstValueFrom(this.http.get<CampaignSummary[]>(this.API)); }
  get(id: number) { return firstValueFrom(this.http.get<CampaignDetail>(`${this.API}/${id}`)); }
  create(c: CampaignInput) { return firstValueFrom(this.http.post<{ id: number }>(this.API, c)); }
  update(id: number, c: CampaignInput) { return firstValueFrom(this.http.put<{ ok: true }>(`${this.API}/${id}`, c)); }
  remove(id: number) { return firstValueFrom(this.http.delete<{ ok: true }>(`${this.API}/${id}`)); }

  setProducts(id: number, skus: string[]) {
    return firstValueFrom(this.http.put<{ count: number; unknown: string[] }>(`${this.API}/${id}/produtos`, { skus }));
  }
  setOverride(id: number, sku: string, override: Discount | null) {
    return firstValueFrom(this.http.put<{ ok: true }>(`${this.API}/${id}/produtos/${encodeURIComponent(sku)}/excecao`, override ?? {}));
  }
  preview(id: number) { return firstValueFrom(this.http.get<PreviewItem[]>(`${this.API}/${id}/previsao`)); }

  schedule(id: number) { return firstValueFrom(this.http.post<{ ok: true }>(`${this.API}/${id}/agendar`, {})); }
  unschedule(id: number) { return firstValueFrom(this.http.post<{ ok: true }>(`${this.API}/${id}/desagendar`, {})); }
  cancel(id: number) { return firstValueFrom(this.http.post<{ ok: true }>(`${this.API}/${id}/cancelar`, {})); }
}
