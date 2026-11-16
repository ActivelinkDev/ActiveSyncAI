import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Observable, Subscriber } from 'rxjs';
import type { TagGroup, TagValue, Familia, Subfamilia, Produto, ProdutoTagValue } from './tags.service';

type SupplierKey = 'suprides' | 'esprinet';

interface MenuTreeNode {
  shopifyId: string;
  title: string;
  level: 1 | 2 | 3;
  parentId: string | null;
  grandParentId: string | null;
  productCount: number;
  directProductCount: number;
}

// Marcador interno para entradas sintéticas "(Geral)"
const GERAL = '(Geral)';

@Injectable({ providedIn: 'root' })
export class SupridesTagsService {
  private supplier: SupplierKey = 'suprides';

  constructor(private http: HttpClient) {}

  withSupplier(supplier: SupplierKey): SupridesTagsService {
    const clone = new SupridesTagsService(this.http);
    clone.supplier = supplier;
    return clone;
  }

  private get base(): string {
    return `/api/${this.supplier}/tags`;
  }

  // ── Tag Groups (interface idêntica ao TagsService) ──────────────────────────

  listGroups(): Promise<TagGroup[]> {
    return firstValueFrom(this.http.get<TagGroup[]>(`${this.base}/groups`));
  }

  createGroup(nome: string, descricao: string, unidade: string): Promise<TagGroup> {
    return firstValueFrom(this.http.post<TagGroup>(`${this.base}/groups`, { nome, descricao, unidade }));
  }

  updateGroup(id: number, nome: string, descricao: string, unidade: string): Promise<TagGroup> {
    return firstValueFrom(this.http.put<TagGroup>(`${this.base}/groups/${id}`, { nome, descricao, unidade }));
  }

  deleteGroup(id: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.base}/groups/${id}`));
  }

  // ── Tag Values ──────────────────────────────────────────────────────────────

  getGroupValues(groupId: number): Promise<TagValue[]> {
    return firstValueFrom(this.http.get<TagValue[]>(`${this.base}/groups/${groupId}/values`));
  }

  addGroupValue(groupId: number, value: string): Promise<{ id: number; value: string }> {
    return firstValueFrom(this.http.post<any>(`${this.base}/groups/${groupId}/values`, { value }));
  }

  deleteGroupValue(valueId: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.base}/values/${valueId}`));
  }

  // ── Menu tree → interface grupo/familia/subfamilia ──────────────────────────
  // L1 → grupos, L2 → familias (grupo = shopifyId do L1 pai),
  // L3 → subfamilias (grupo = shopifyId L1, familia = shopifyId L2)

  private _menuTreeCache: MenuTreeNode[] | null = null;

  private async getMenuTree(): Promise<MenuTreeNode[]> {
    if (!this._menuTreeCache) {
      this._menuTreeCache = await firstValueFrom(
        this.http.get<MenuTreeNode[]>(`${this.base}/menu/tree`)
      );
    }
    return this._menuTreeCache!;
  }

  /** Invalida o cache local do menu tree (chamar após rebuild) */
  invalidateMenuCache(): void {
    this._menuTreeCache = null;
  }

  async listGrupos(): Promise<string[]> {
    const tree = await this.getMenuTree();
    return tree.filter(n => n.level === 1).map(n => n.title);
  }

  async listFamilias(): Promise<Familia[]> {
    const tree = await this.getMenuTree();
    const l1ByShopifyId = new Map(tree.filter(n => n.level === 1).map(n => [n.shopifyId, n.title]));
    const result: Familia[] = [];

    // Famílias reais (L2)
    for (const n of tree.filter(n => n.level === 2 && n.parentId)) {
      result.push({
        grupo:   l1ByShopifyId.get(n.parentId!) ?? n.parentId!,
        familia: n.title,
      } as Familia);
    }

    // Famílias sintéticas "(Geral)" para L1 com produtos directos
    for (const n of tree.filter(n => n.level === 1 && n.directProductCount > 0)) {
      result.push({ grupo: n.title, familia: GERAL } as Familia);
    }

    return result;
  }

  async listSubfamilias(): Promise<Subfamilia[]> {
    const tree = await this.getMenuTree();
    const byId = new Map(tree.map(n => [n.shopifyId, n]));
    const result: Subfamilia[] = [];

    // Subfamílias reais (L3)
    for (const n of tree.filter(n => n.level === 3 && n.parentId)) {
      const l2 = n.parentId ? byId.get(n.parentId) : null;
      const l1 = l2?.parentId ? byId.get(l2.parentId) : null;
      result.push({
        grupo:      l1?.title ?? n.grandParentId ?? '',
        familia:    l2?.title ?? n.parentId ?? '',
        subfamilia: n.title,
      } as Subfamilia);
    }

    // Subfamílias sintéticas "(Geral)" para L2 com produtos directos
    for (const n of tree.filter(n => n.level === 2 && n.directProductCount > 0 && n.parentId)) {
      const l1 = byId.get(n.parentId!);
      result.push({
        grupo:      l1?.title ?? '',
        familia:    n.title,
        subfamilia: GERAL,
      } as Subfamilia);
    }

    // Subfamílias sintéticas "(Geral)/(Geral)" para L1 com produtos directos
    for (const n of tree.filter(n => n.level === 1 && n.directProductCount > 0)) {
      result.push({
        grupo:      n.title,
        familia:    GERAL,
        subfamilia: GERAL,
      } as Subfamilia);
    }

    return result;
  }

  // ── Helpers: resolução de shopifyId a partir do título ─────────────────────

  private async resolveShopifyId(
    level: 1 | 2 | 3,
    grupo: string,
    familia?: string,
    subfamilia?: string
  ): Promise<string | null> {
    const tree = await this.getMenuTree();

    // Entradas sintéticas "(Geral)": resolvem para o nó pai correspondente
    if (familia === GERAL) {
      // Família sintética de L1 → resolver para o L1
      return tree.find(n => n.level === 1 && n.title === grupo)?.shopifyId ?? null;
    }
    if (subfamilia === GERAL) {
      // Subfamília sintética de L2 → resolver para o L2
      const l1 = tree.find(n => n.level === 1 && n.title === grupo);
      if (!l1) return null;
      return tree.find(n => n.level === 2 && n.title === familia && n.parentId === l1.shopifyId)?.shopifyId ?? null;
    }

    if (level === 1) {
      return tree.find(n => n.level === 1 && n.title === grupo)?.shopifyId ?? null;
    }
    if (level === 2) {
      const l1 = tree.find(n => n.level === 1 && n.title === grupo);
      if (!l1) return null;
      return tree.find(n => n.level === 2 && n.title === familia && n.parentId === l1.shopifyId)?.shopifyId ?? null;
    }
    if (level === 3) {
      const l1 = tree.find(n => n.level === 1 && n.title === grupo);
      const l2 = l1 ? tree.find(n => n.level === 2 && n.title === familia && n.parentId === l1.shopifyId) : null;
      if (!l2) return null;
      return tree.find(n => n.level === 3 && n.title === subfamilia && n.parentId === l2.shopifyId)?.shopifyId ?? null;
    }
    return null;
  }

  // ── Tag group assignments por nó de menu ────────────────────────────────────

  async getGrupoGroups(grupo: string): Promise<number[]> {
    const id = await this.resolveShopifyId(1, grupo);
    if (!id) return [];
    return firstValueFrom(this.http.get<{ id: number }[]>(`${this.base}/menu/${id}/groups`))
      .then(rows => rows.map(r => r.id));
  }

  async saveGrupoGroups(grupo: string, groupIds: number[]): Promise<any> {
    const id = await this.resolveShopifyId(1, grupo);
    if (!id) return;
    return firstValueFrom(this.http.put(`${this.base}/menu/${id}/groups`, { tag_group_ids: groupIds }));
  }

  async getFamiliaGroups(grupo: string, familia: string): Promise<number[]> {
    const id = await this.resolveShopifyId(2, grupo, familia);
    if (!id) return [];
    return firstValueFrom(this.http.get<{ id: number }[]>(`${this.base}/menu/${id}/groups`))
      .then(rows => rows.map(r => r.id));
  }

  async saveFamiliaGroups(grupo: string, familia: string, groupIds: number[]): Promise<any> {
    const id = await this.resolveShopifyId(2, grupo, familia);
    if (!id) return;
    return firstValueFrom(this.http.put(`${this.base}/menu/${id}/groups`, { tag_group_ids: groupIds }));
  }

  async getSubfamiliaGroups(grupo: string, familia: string, subfamilia: string): Promise<number[]> {
    const id = await this.resolveShopifyId(3, grupo, familia, subfamilia);
    if (!id) return [];
    return firstValueFrom(this.http.get<{ id: number }[]>(`${this.base}/menu/${id}/groups`))
      .then(rows => rows.map(r => r.id));
  }

  async saveSubfamiliaGroups(grupo: string, familia: string, subfamilia: string, groupIds: number[]): Promise<any> {
    const id = await this.resolveShopifyId(3, grupo, familia, subfamilia);
    if (!id) return;
    return firstValueFrom(this.http.put(`${this.base}/menu/${id}/groups`, { tag_group_ids: groupIds }));
  }

  // ── Product tag values ──────────────────────────────────────────────────────

  async getProdutoEffectiveTagIds(ref: string): Promise<number[]> {
    const data = await firstValueFrom(
      this.http.get<{ effectiveTagGroupIds: number[]; values: any[] }>(`${this.base}/product/${encodeURIComponent(ref)}/tag-values`)
    );
    return data.effectiveTagGroupIds ?? [];
  }

  async getProdutoTagValues(ref: string): Promise<ProdutoTagValue[]> {
    const data = await firstValueFrom(
      this.http.get<{ effectiveTagGroupIds: number[]; values: ProdutoTagValue[] }>(`${this.base}/product/${encodeURIComponent(ref)}/tag-values`)
    );
    return data.values ?? [];
  }

  saveProdutoTagValues(ref: string, values: ProdutoTagValue[]): Promise<any> {
    return Promise.all(
      values.map(v => firstValueFrom(
        this.http.put(`${this.base}/product/${encodeURIComponent(ref)}/tag-values`, { tag_group_id: v.tag_group_id, value: v.value })
      ))
    );
  }

  // Produtos por nó de menu (para a árvore de produtos)
  async listProdutosBySubfamilia(grupo: string, familia: string, subfamilia: string): Promise<Produto[]> {
    // Entradas sintéticas "(Geral)" usam directOnly=true
    const isGeral = subfamilia === GERAL || familia === GERAL;
    const id = await this.resolveShopifyId(3, grupo, familia, subfamilia);
    if (!id) return [];
    const url = `${this.base}/menu/${encodeURIComponent(id)}/products${isGeral ? '?directOnly=true' : ''}`;
    return firstValueFrom(this.http.get<Produto[]>(url));
  }

  // Contagens por nó (usadas na buildProdutosTree)
  async getProductTreeCounts(): Promise<{ grupo: string; familia: string; subfamilia: string; total: number }[]> {
    const tree = await this.getMenuTree();
    const byId = new Map(tree.map(n => [n.shopifyId, n]));
    const result: { grupo: string; familia: string; subfamilia: string; total: number }[] = [];

    for (const n of tree) {
      if (n.level === 3 && n.productCount > 0) {
        const l2 = n.parentId ? byId.get(n.parentId) : null;
        const l1 = l2?.parentId ? byId.get(l2.parentId) : null;
        result.push({ grupo: l1?.title ?? '', familia: l2?.title ?? '', subfamilia: n.title, total: n.productCount });
      } else if (n.level === 2 && n.directProductCount > 0) {
        const l1 = n.parentId ? byId.get(n.parentId) : null;
        result.push({ grupo: l1?.title ?? '', familia: n.title, subfamilia: GERAL, total: n.directProductCount });
      } else if (n.level === 1 && n.directProductCount > 0) {
        result.push({ grupo: n.title, familia: GERAL, subfamilia: GERAL, total: n.directProductCount });
      }
    }

    return result;
  }

  // ── getProdutoTagValuesWithNormalized — sem normalização na Suprides ─────────

  async getProdutoTagValuesWithNormalized(ref: string): Promise<any[]> {
    const data = await firstValueFrom(
      this.http.get<{ effectiveTagGroupIds: number[]; values: any[] }>(`${this.base}/product/${encodeURIComponent(ref)}/tag-values`)
    );
    return (data.values ?? []).map(v => ({
      tag_group_id:     v.tag_group_id,
      b2b_value:        '',
      populated_value:  v.value,
      normalized_value: v.normalized_value ?? v.value,
    }));
  }

  // ── Stubs — funcionalidades não disponíveis / não aplicáveis ─────────────────

  clearAllProductTagValues(): Promise<{ deleted: number }> {
    return firstValueFrom(this.http.delete<{ deleted: number }>(`${this.base}/product-tag-values`));
  }

  resetPopulateTagsProgress(): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.base}/populate-tags-progress`));
  }

  getProdutoInfo(ref: string): Promise<any> {
    return firstValueFrom(
      this.http.get<any>(`${this.base}/product/${encodeURIComponent(ref)}/info`)
    ).catch(() => ({ ean: '', id_produto: '' }));
  }

  saveProdutoInfo(_ref: string, _info: any): Promise<any> { return Promise.resolve(); }

  searchProdutos(q: string): Promise<Produto[]> {
    return firstValueFrom(
      this.http.get<Produto[]>(`${this.base}/products/search?q=${encodeURIComponent(q)}`)
    ).catch(() => []);
  }

  getFamiliaExcludedGroups(_g: string, _f: string): Promise<number[]> { return Promise.resolve([]); }
  saveFamiliaExcludedGroups(_g: string, _f: string, _ids: number[]): Promise<any> { return Promise.resolve(); }
  getSubfamiliaExcludedGroups(_g: string, _f: string, _s: string): Promise<number[]> { return Promise.resolve([]); }
  saveSubfamiliaExcludedGroups(_g: string, _f: string, _s: string, _ids: number[]): Promise<any> { return Promise.resolve(); }

  deleteGrupoDescendantTagLinks(_g: string, _ids: number[]): Promise<any> { return Promise.resolve(); }
  deleteFamiliaSubfamiliaTagLinks(_g: string, _f: string, _ids: number[]): Promise<any> { return Promise.resolve(); }

  getGrupoTagProductCount(_g: string, _id: number): Promise<{ count: number }> { return Promise.resolve({ count: 0 }); }
  getFamiliaTagProductCount(_g: string, _f: string, _id: number): Promise<{ count: number }> { return Promise.resolve({ count: 0 }); }
  getSubfamiliaTagProductCount(_g: string, _f: string, _s: string, _id: number): Promise<{ count: number }> { return Promise.resolve({ count: 0 }); }

  deleteGrupoTagProductValues(_g: string, _id: number): Promise<any> { return Promise.resolve(); }
  deleteFamiliaTagProductValues(_g: string, _f: string, _id: number): Promise<any> { return Promise.resolve(); }
  deleteSubfamiliaTagProductValues(_g: string, _f: string, _s: string, _id: number): Promise<any> { return Promise.resolve(); }

  aiPopulateProduto(ref: string, tagGroupIds: number[], _mode?: string): Promise<any> {
    return firstValueFrom(
      this.http.post<any>(`${this.base}/ai-populate-produto`, { ref, tagGroupIds })
    );
  }

  aiPopulateTagsProduto(_ref: string): Promise<any> { return Promise.resolve({ tags: [] }); }

  aiPopulateSubfamilia(grupo: string, familia: string, subfamilia: string, _mode?: string): Observable<any> {
    return this._sseObservable(async () => {
      const isGeral   = subfamilia === GERAL || familia === GERAL;
      const shopifyId = await this.resolveShopifyId(3, grupo, familia, subfamilia);
      if (!shopifyId) throw new Error('Nó de menu não encontrado para esta subfamília');
      const skip  = localStorage.getItem('skipMapped') === 'true';
      const label = [grupo, familia, subfamilia].filter(s => s !== GERAL).join(' › ');
      return `${this.base}/ai-populate-subfamilia?shopifyId=${encodeURIComponent(shopifyId)}&directOnly=${isGeral}&skipMapped=${skip}&label=${encodeURIComponent(label)}`;
    });
  }

  aiPopulateFamilia(grupo: string, familia: string, _mode?: string): Observable<any> {
    return this._sseObservable(async () => {
      const isGeral   = familia === GERAL;
      const shopifyId = await this.resolveShopifyId(2, grupo, familia);
      if (!shopifyId) throw new Error('Nó de menu não encontrado para esta família');
      const skip  = localStorage.getItem('skipMapped') === 'true';
      const label = [grupo, familia].filter(s => s !== GERAL).join(' › ');
      return `${this.base}/ai-populate-familia?shopifyId=${encodeURIComponent(shopifyId)}&directOnly=${isGeral}&skipMapped=${skip}&label=${encodeURIComponent(label)}`;
    });
  }

  aiPopulateGrupo(grupo: string, _mode?: string): Observable<any> {
    return this._sseObservable(async () => {
      const shopifyId = await this.resolveShopifyId(1, grupo);
      if (!shopifyId) throw new Error('Nó de menu não encontrado para este grupo');
      const skip = localStorage.getItem('skipMapped') === 'true';
      return `${this.base}/ai-populate-grupo?shopifyId=${encodeURIComponent(shopifyId)}&skipMapped=${skip}&label=${encodeURIComponent(grupo)}`;
    });
  }

  private _sseObservable(urlFn: () => Promise<string>): Observable<any> {
    return new Observable((observer: Subscriber<any>) => {
      let es: EventSource | null = null;
      urlFn().then(url => {
        es = new EventSource(url);
        es.onmessage = (e) => {
          const data = JSON.parse(e.data);
          observer.next(data);
          if (data.type === 'done' || data.type === 'error') {
            es!.close();
            observer.complete();
          }
        };
        es.onerror = () => {
          es?.close();
          observer.error({ message: 'Ligação SSE perdida' });
        };
      }).catch(err => observer.error(err));
      return () => { es?.close(); };
    });
  }

  populateGroupValues(_id: number): Promise<any> { return Promise.resolve({ found: 0, added: 0 }); }

  getFiltrosWords(): Promise<any[]> { return Promise.resolve([]); }
  getFiltrosMappings(): Promise<any[]> { return Promise.resolve([]); }
  clearAllFiltrosMappings(): Promise<{ deleted: number }> { return Promise.resolve({ deleted: 0 }); }
  saveFiltroMapping(_w: string, _id: number | null): Promise<void> { return Promise.resolve(); }
  ignoreWord(_w: string): Promise<void> { return Promise.resolve(); }
  getIgnoredWords(): Promise<string[]> { return Promise.resolve([]); }
  unignoreWord(_w: string): Promise<void> { return Promise.resolve(); }
  getPrefixExcludes(): Promise<string[]> { return Promise.resolve([]); }
  addPrefixExclude(_p: string): Promise<void> { return Promise.resolve(); }
  removePrefixExclude(_p: string): Promise<void> { return Promise.resolve(); }
  extractFiltrosPairs(): Observable<any> { return new Observable(o => o.complete()); }
  resetExtractProgress(): Promise<void> { return Promise.resolve(); }
  applyFiltrosMappings(): Observable<any> { return new Observable(o => o.complete()); }
  aiPopulateTagsFromMapping(): Observable<any> { return new Observable(o => o.complete()); }
  aiPopulateFiltrosMappings(): Observable<any> { return new Observable(o => o.complete()); }
  buildFilterDictionary(): Observable<any> { return new Observable(o => o.complete()); }
  getFilterDictionary(): Promise<any> { return Promise.resolve({ total: 0, entries: [] }); }
  getResultadosTree(): Promise<any[]> { return Promise.resolve([]); }
  getResultadosProdutos(_g: string, _f: string, _s: string): Promise<any[]> { return Promise.resolve([]); }
  getDiscardedPairs(): Promise<any[]> { return Promise.resolve([]); }
  restoreDiscardedPair(_w: string): Promise<void> { return Promise.resolve(); }

  setSource(s: string): void {
    if (s === 'suprides' || s === 'esprinet') {
      this.supplier = s;
      this.invalidateMenuCache();
    }
  }
}
