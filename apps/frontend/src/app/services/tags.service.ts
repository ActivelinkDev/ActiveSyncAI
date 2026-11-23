import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom, Observable } from 'rxjs';

export type TagGroup = {
  id: number;
  nome: string;
  descricao: string | null;
  unidade: string | null;
  created_at?: string;
};

export type TagValue = {
  id: number;
  value: string;
};

export type Familia = {
  grupo: string;
  familia: string;
};

export type Subfamilia = {
  grupo: string;
  familia: string;
  subfamilia: string;
};

export type Produto = {
  ref: string;
  design: string;
};

export type ProdutoTagValue = {
  tag_group_id: number;
  value: string;
};

export type ProdutoTagValueWithNormalized = {
  tag_group_id: number;
  b2b_value: string;
  populated_value: string;
  normalized_value: string;
};

export type ProdutoInfo = {
  ean: string;
  id_produto: string;
};

export type FiltroMapping = {
  word: string;
  tag_group_id: number | null;
  tag_nome: string | null;
};

export type ResultadosSubfamilia = { nome: string; total: number };
export type ResultadosFamilia    = { nome: string; subfamilias: ResultadosSubfamilia[] };
export type ResultadosGrupo      = { nome: string; familias: ResultadosFamilia[] };

@Injectable({ providedIn: 'root' })
export class TagsService {
    aiPopulateProduto(ref: string, tagGroupIds: number[], mode: 'local' | 'web' = 'local'): Promise<any> {
      return firstValueFrom(this.http.post<any>(`${this.TAGS}/ai-populate-produto`, { ref, tagGroupIds, mode }));
    }
    aiPopulateTagsProduto(ref: string): Promise<{ tags: { tag_group_id: number; value: string }[] }> {
      return firstValueFrom(this.http.post<any>(`${this.TAGS}/filtros/ai-populate-tags-produto`, { ref }));
    }
  private TAGS        = '/api/tags';
  private FAMILIAS    = '/api/familias';
  private SUBFAMILIAS = '/api/subfamilias';
  private GRUPOS      = '/api/grupos';
  private PRODUTOS    = '/api/produtos';

  constructor(private http: HttpClient) {}

  // ===== Tag Groups =====

  listGroups(): Promise<TagGroup[]> {
    return firstValueFrom(this.http.get<TagGroup[]>(`${this.TAGS}/groups`));
  }

  createGroup(nome: string, descricao: string, unidade: string): Promise<TagGroup> {
    return firstValueFrom(this.http.post<TagGroup>(`${this.TAGS}/groups`, { nome, descricao, unidade }));
  }

  updateGroup(id: number, nome: string, descricao: string, unidade: string): Promise<TagGroup> {
    return firstValueFrom(this.http.put<TagGroup>(`${this.TAGS}/groups/${id}`, { nome, descricao, unidade }));
  }

  deleteGroup(id: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.TAGS}/groups/${id}`));
  }

  // ===== Tag Values =====

  getGroupValues(groupId: number): Promise<TagValue[]> {
    return firstValueFrom(this.http.get<TagValue[]>(`${this.TAGS}/groups/${groupId}/values`));
  }

  populateGroupValues(groupId: number, sourceField?: string): Promise<{ found: number; added: number; usedField?: string; warning?: string }> {
    return firstValueFrom(this.http.post<any>(`${this.TAGS}/groups/${groupId}/populate`, sourceField ? { sourceField } : {}));
  }

  addGroupValue(groupId: number, value: string): Promise<{ id: number; value: string }> {
    return firstValueFrom(this.http.post<any>(`${this.TAGS}/groups/${groupId}/values`, { value }));
  }

  deleteGroupValue(valueId: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.TAGS}/values/${valueId}`));
  }

  // ===== Grupos =====

  listGrupos(): Promise<string[]> {
    return firstValueFrom(this.http.get<string[]>(this.GRUPOS));
  }

  getGrupoGroups(grupo: string): Promise<number[]> {
    const params = new HttpParams().set('grupo', grupo);
    return firstValueFrom(this.http.get<number[]>(`${this.GRUPOS}/groups`, { params }));
  }

  saveGrupoGroups(grupo: string, groupIds: number[]): Promise<any> {
    return firstValueFrom(this.http.post(`${this.GRUPOS}/groups`, { grupo, groupIds }));
  }

  getGrupoTagProductCount(grupo: string, tagGroupId: number): Promise<{ count: number }> {
    const params = new HttpParams().set('grupo', grupo).set('tagGroupId', tagGroupId);
    return firstValueFrom(this.http.get<{ count: number }>(`${this.GRUPOS}/tag-product-count`, { params }));
  }

  deleteGrupoTagProductValues(grupo: string, tagGroupId: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.GRUPOS}/tag-product-values`, { body: { grupo, tagGroupId } }));
  }

  deleteGrupoDescendantTagLinks(grupo: string, tagGroupIds: number[]): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.GRUPOS}/descendant-tag-links`, { body: { grupo, tagGroupIds } }));
  }

  // ===== Famílias =====

  listFamilias(): Promise<Familia[]> {
    return firstValueFrom(this.http.get<Familia[]>(this.FAMILIAS));
  }

  getFamiliaGroups(grupo: string, familia: string): Promise<number[]> {
    const params = new HttpParams().set('grupo', grupo).set('familia', familia);
    return firstValueFrom(this.http.get<number[]>(`${this.FAMILIAS}/groups`, { params }));
  }

  saveFamiliaGroups(grupo: string, familia: string, groupIds: number[]): Promise<any> {
    return firstValueFrom(this.http.post(`${this.FAMILIAS}/groups`, { grupo, familia, groupIds }));
  }

  getFamiliaTagProductCount(grupo: string, familia: string, tagGroupId: number): Promise<{ count: number }> {
    const params = new HttpParams().set('grupo', grupo).set('familia', familia).set('tagGroupId', tagGroupId);
    return firstValueFrom(this.http.get<{ count: number }>(`${this.FAMILIAS}/tag-product-count`, { params }));
  }

  deleteFamiliaTagProductValues(grupo: string, familia: string, tagGroupId: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.FAMILIAS}/tag-product-values`, { body: { grupo, familia, tagGroupId } }));
  }

  // ===== Subfamílias =====

  deleteFamiliaSubfamiliaTagLinks(grupo: string, familia: string, tagGroupIds: number[]): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.FAMILIAS}/subfamilia-tag-links`, { body: { grupo, familia, tagGroupIds } }));
  }

  listSubfamilias(): Promise<Subfamilia[]> {
    return firstValueFrom(this.http.get<Subfamilia[]>(this.SUBFAMILIAS));
  }

  getSubfamiliaGroups(grupo: string, familia: string, subfamilia: string): Promise<number[]> {
    const params = new HttpParams()
      .set('grupo', grupo)
      .set('familia', familia)
      .set('subfamilia', subfamilia);
    return firstValueFrom(this.http.get<number[]>(`${this.SUBFAMILIAS}/groups`, { params }));
  }

  saveSubfamiliaGroups(grupo: string, familia: string, subfamilia: string, groupIds: number[]): Promise<any> {
    return firstValueFrom(this.http.post(`${this.SUBFAMILIAS}/groups`, { grupo, familia, subfamilia, groupIds }));
  }

  getSubfamiliaTagProductCount(grupo: string, familia: string, subfamilia: string, tagGroupId: number): Promise<{ count: number }> {
    const params = new HttpParams().set('grupo', grupo).set('familia', familia).set('subfamilia', subfamilia).set('tagGroupId', tagGroupId);
    return firstValueFrom(this.http.get<{ count: number }>(`${this.SUBFAMILIAS}/tag-product-count`, { params }));
  }

  deleteSubfamiliaTagProductValues(grupo: string, familia: string, subfamilia: string, tagGroupId: number): Promise<any> {
    return firstValueFrom(this.http.delete(`${this.SUBFAMILIAS}/tag-product-values`, { body: { grupo, familia, subfamilia, tagGroupId } }));
  }

  getFamiliaExcludedGroups(grupo: string, familia: string): Promise<number[]> {
    const params = new HttpParams().set('grupo', grupo).set('familia', familia);
    return firstValueFrom(this.http.get<number[]>(`${this.FAMILIAS}/excluded-groups`, { params }));
  }

  saveFamiliaExcludedGroups(grupo: string, familia: string, excludedIds: number[]): Promise<any> {
    return firstValueFrom(this.http.post(`${this.FAMILIAS}/excluded-groups`, { grupo, familia, excludedIds }));
  }

  getSubfamiliaExcludedGroups(grupo: string, familia: string, subfamilia: string): Promise<number[]> {
    const params = new HttpParams().set('grupo', grupo).set('familia', familia).set('subfamilia', subfamilia);
    return firstValueFrom(this.http.get<number[]>(`${this.SUBFAMILIAS}/excluded-groups`, { params }));
  }

  saveSubfamiliaExcludedGroups(grupo: string, familia: string, subfamilia: string, excludedIds: number[]): Promise<any> {
    return firstValueFrom(this.http.post(`${this.SUBFAMILIAS}/excluded-groups`, { grupo, familia, subfamilia, excludedIds }));
  }

  // ===== Produtos =====

  listProdutosBySubfamilia(grupo: string, familia: string, subfamilia: string): Promise<Produto[]> {
    const params = new HttpParams()
      .set('grupo', grupo)
      .set('familia', familia)
      .set('subfamilia', subfamilia);
    return firstValueFrom(this.http.get<Produto[]>(this.PRODUTOS, { params }));
  }

  getProductTreeCounts(): Promise<{ grupo: string; familia: string; subfamilia: string; total: number }[]> {
    return firstValueFrom(this.http.get<{ grupo: string; familia: string; subfamilia: string; total: number }[]>(`${this.PRODUTOS}/tree-counts`));
  }

  getProdutoEffectiveTagIds(ref: string): Promise<number[]> {
    return firstValueFrom(this.http.get<number[]>(`${this.PRODUTOS}/${encodeURIComponent(ref)}/effective-tag-ids`));
  }

  getProdutoInfo(ref: string): Promise<ProdutoInfo> {
    return firstValueFrom(this.http.get<ProdutoInfo>(`${this.PRODUTOS}/${encodeURIComponent(ref)}/info`));
  }

  saveProdutoInfo(ref: string, info: ProdutoInfo): Promise<any> {
    return firstValueFrom(this.http.put(`${this.PRODUTOS}/${encodeURIComponent(ref)}/info`, info));
  }

  getProdutoTagValues(ref: string): Promise<ProdutoTagValue[]> {
    return firstValueFrom(this.http.get<ProdutoTagValue[]>(`${this.PRODUTOS}/${encodeURIComponent(ref)}/tag-values`));
  }

  getProdutoTagValuesWithNormalized(ref: string): Promise<ProdutoTagValueWithNormalized[]> {
    return firstValueFrom(this.http.get<ProdutoTagValueWithNormalized[]>(`${this.PRODUTOS}/${encodeURIComponent(ref)}/tag-values-with-normalized`));
  }

  saveProdutoTagValues(ref: string, values: ProdutoTagValue[]): Promise<any> {
    return firstValueFrom(this.http.put(`${this.PRODUTOS}/${encodeURIComponent(ref)}/tag-values`, values));
  }

  // ===== Filtros =====

  getFiltrosWords(): Promise<{ word: string; context: string }[]> {
    return firstValueFrom(this.http.get<{ pairs: { word: string; context: string }[] }>(`${this.TAGS}/filtros/words`))
      .then(r => r?.pairs ?? []);
  }

  getFiltrosMappings(): Promise<FiltroMapping[]> {
    return firstValueFrom(this.http.get<FiltroMapping[]>(`${this.TAGS}/filtros/mappings`));
  }

  clearAllFiltrosMappings(): Promise<{ deleted: number }> {
    return firstValueFrom(this.http.delete<{ deleted: number }>(`${this.TAGS}/filtros/mappings`));
  }

  clearAllProductTagValues(): Promise<{ deleted: number }> {
    return firstValueFrom(this.http.delete<{ deleted: number }>(`${this.TAGS}/product-tag-values`));
  }

  saveFiltroMapping(word: string, tagGroupId: number | null): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`${this.TAGS}/filtros/mappings`, { word, tag_group_id: tagGroupId })
    );
  }

  ignoreWord(word: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.TAGS}/filtros/words/${encodeURIComponent(word)}`)
    );
  }

  getIgnoredWords(): Promise<string[]> {
    return firstValueFrom(this.http.get<string[]>(`${this.TAGS}/filtros/ignored-words`));
  }

  unignoreWord(word: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.TAGS}/filtros/ignored-words/${encodeURIComponent(word)}`)
    );
  }

  // ===== Prefixos excluídos =====

  getPrefixExcludes(): Promise<string[]> {
    return firstValueFrom(this.http.get<string[]>(`${this.TAGS}/filtros/prefixes`));
  }

  addPrefixExclude(prefix: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`${this.TAGS}/filtros/prefixes`, { prefix }));
  }

  removePrefixExclude(prefix: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.TAGS}/filtros/prefixes/${encodeURIComponent(prefix)}`));
  }

  // ===== AI =====

  private _sseObservable(url: string): Observable<any> {
    const base = '';
    const absoluteUrl = url.startsWith('http') ? url : `${base}${url}`;
    return new Observable(observer => {
      const es = new EventSource(absoluteUrl);
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        observer.next(data);
        if (data.type === 'done' || data.type === 'error') { es.close(); observer.complete(); }
      };
      es.onerror = () => { es.close(); observer.error(new Error('Erro na ligação SSE')); };
      return () => es.close();
    });
  }

  aiPopulateSubfamilia(grupo: string, familia: string, subfamilia: string, mode: 'local' | 'web' = 'local'): Observable<any> {
    const skipMapped = localStorage.getItem('skipMapped') !== 'false' ? 'true' : 'false';
    return this._sseObservable(`${this.TAGS}/ai-populate-subfamilia?${new URLSearchParams({ grupo, familia, subfamilia, mode, skipMapped })}`);
  }

  aiPopulateFamilia(grupo: string, familia: string, mode: 'local' | 'web' = 'local'): Observable<any> {
    const skipMapped = localStorage.getItem('skipMapped') !== 'false' ? 'true' : 'false';
    return this._sseObservable(`${this.TAGS}/ai-populate-familia?${new URLSearchParams({ grupo, familia, mode, skipMapped })}`);
  }

  aiPopulateGrupo(grupo: string, mode: 'local' | 'web' = 'local'): Observable<any> {
    const skipMapped = localStorage.getItem('skipMapped') !== 'false' ? 'true' : 'false';
    return this._sseObservable(`${this.TAGS}/ai-populate-grupo?${new URLSearchParams({ grupo, mode, skipMapped })}`);
  }

  applyFiltrosMappings(): Observable<any> {
    return this._sseObservable(`${this.TAGS}/filtros/apply-mappings`);
  }

  aiPopulateTagsFromMapping(): Observable<any> {
    return this._sseObservable(`${this.TAGS}/filtros/ai-populate-tags`);
  }

  resetPopulateTagsProgress(): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.TAGS}/filtros/populate-tags-progress`));
  }

  aiPopulateFiltrosMappings(): Observable<any> {
    return this._sseObservable(`${this.TAGS}/ai-populate-filtros-mappings`);
  }

  extractFiltrosPairs(restart = false): Observable<any> {
    const url = restart
      ? `${this.TAGS}/filtros/extract-pairs?restart=1`
      : `${this.TAGS}/filtros/extract-pairs`;
    return this._sseObservable(url);
  }

  resetExtractProgress(): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.TAGS}/filtros/extract-progress`));
  }

  getDiscardedPairs(): Promise<{ word: string; especificacao: string | null; tag_nome: string | null }[]> {
    return firstValueFrom(this.http.get<{ word: string; especificacao: string | null; tag_nome: string | null }[]>(`${this.TAGS}/filtros/discarded`));
  }

  restoreDiscardedPair(word: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.TAGS}/filtros/discarded/${encodeURIComponent(word)}`));
  }

  buildFilterDictionary(): Observable<any> {
    return this._sseObservable(`${this.TAGS}/filtros/build-dictionary`);
  }

  getFilterDictionary(): Promise<{ total: number; entries: { id: number; canonical_name: string; synonyms: string[]; updated_at: string }[] }> {
    return firstValueFrom(this.http.get<any>(`${this.TAGS}/filtros/dictionary`));
  }

  // ===== Resultados Mapeamento =====

  getResultadosTree(): Promise<ResultadosGrupo[]> {
    return firstValueFrom(this.http.get<ResultadosGrupo[]>(`${this.TAGS}/filtros/resultados-tree`));
  }

  getResultadosProdutos(grupo: string, familia: string, subfamilia: string): Promise<Produto[]> {
    const params = new HttpParams()
      .set('grupo',      grupo)
      .set('familia',    familia)
      .set('subfamilia', subfamilia);
    return firstValueFrom(this.http.get<Produto[]>(`${this.TAGS}/filtros/resultados-produtos`, { params }));
  }

  searchProdutos(q: string): Promise<Produto[]> {
    return firstValueFrom(this.http.get<Produto[]>(`${this.TAGS}/filtros/search-produtos`, { params: new HttpParams().set('q', q) }));
  }
}
