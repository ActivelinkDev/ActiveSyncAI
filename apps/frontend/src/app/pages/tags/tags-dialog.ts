// apps/frontend/src/app/pages/tags/tags-dialog.ts
import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatAutocompleteModule } from '@angular/material/autocomplete';

import { TagsService, TagGroup, TagValue, Familia, Subfamilia, Produto, ProdutoTagValue, ProdutoTagValueWithNormalized, ProdutoInfo } from '../../services/tags.service';
import { SupridesTagsService } from '../../services/suprides-tags.service';
import { PillSelectorComponent } from './pill-selector/pill-selector';
import { MatAccordion } from "@angular/material/expansion";

interface InheritedTag    { id: number; nome: string; from: string; }
interface FamiliaGroup    { grupo: string; familias: Familia[]; }
interface SubfamiliaGroup { grupo: string; familia: string; subfamilias: Subfamilia[]; }

const API = ((window as any).ENV_API_BASE?.replace(/\/+$/, '') || 'http://localhost:3004') + '/api';
type ActiveTab = 'tags';

interface ProdSubNode {
  subfamilia: string; grupo: string; familia: string;
  expanded: boolean; produtos: Produto[]; loading: boolean; loaded: boolean;
  /** true quando só temos a contagem (placeholder), ainda não os refs reais */
  countOnly?: boolean;
}
interface ProdFamNode {
  familia: string; grupo: string;
  expanded: boolean; subs: ProdSubNode[];
}
interface ProdGrupoNode {
  nome: string;
  expanded: boolean; fams: ProdFamNode[];
}

@Component({
  selector: 'app-tags-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatTabsModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatProgressSpinnerModule,
    MatDividerModule, MatTooltipModule, MatAutocompleteModule, PillSelectorComponent
],
  templateUrl: './tags-dialog.html',
  styleUrls: ['./tags-dialog.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})

export class TagsDialog implements OnInit, OnDestroy {
    tagsSource: 'suprides' | 'esprinet' = 'suprides';
    supplierIndex = 0;
    readonly supplierTabs: { key: 'suprides' | 'esprinet'; label: string }[] = [
      { key: 'suprides', label: 'Suprides' },
      { key: 'esprinet', label: 'Esprinet' },
    ];

    get activeSupplierLabel(): string {
      return this.supplierTabs[this.supplierIndex].label;
    }

    tagGroups: TagGroup[] = [];
    tagsLoading = false;
    tagsSaving = false;
    aiPopulatingProduto = false;
    aiProdutoProgress   = 0;
    aiProdutoStartTime  = 0;
    private _aiProdutoTimer: any = null;
    aiProdutoSuggestion: Record<number, string> = {};
    showLogs = false;
    aiMode: 'local' = 'local'; // Força sempre local
    activeTab: ActiveTab = 'tags';
    toggleAiMode() {
      // Modo web desativado
      // Opcional: mostrar um aviso/snackbar se tentarem ativar
      this.snackBar.open('Modo Web: work in progress', 'Fechar', { duration: 3000 });
    }

    get aiProdutoEta(): string {
      if (!this.aiPopulatingProduto || !this.aiProdutoStartTime) {
        return '~5s';
      }
      const maxSec     = 5;
      const elapsedSec = Math.floor((Date.now() - this.aiProdutoStartTime) / 1000);
      const remaining  = Math.max(0, maxSec - elapsedSec);
      return remaining > 0 ? `~${remaining}s` : '⚡';
    }

    calcEta(current: number, total: number, startMs: number): string {
      if (current < 2 || !startMs) return '';
      const elapsed  = Date.now() - startMs;
      const perItem  = elapsed / current;
      const remSecs  = Math.round((total - current) * perItem / 1000);
      if (remSecs <= 0) return '⚡';
      if (remSecs < 60)  return `~${remSecs}s`;
      const m = Math.floor(remSecs / 60);
      const s = remSecs % 60;
      return s > 0 ? `~${m}m${s}s` : `~${m}m`;
    }

    async aiPopulateProduto() {
      if (!this.selectedProduto) return;
      this.aiPopulatingProduto = true;
      this.aiProdutoProgress   = 8;
      this.aiProdutoStartTime  = Date.now();
      this.aiLogs              = [];
      this.aiLogsExpanded      = true;
      this.cdr.detectChanges();

      // Animar barra de progresso simulada até ~82%
      const step = 0.08;
      this._aiProdutoTimer = setInterval(() => {
        if (this.aiProdutoProgress < 82) {
          this.aiProdutoProgress = Math.min(82, this.aiProdutoProgress + (82 - this.aiProdutoProgress) * step + 0.15);
          this.cdr.detectChanges();
        }
      }, 300);

      try {
        const tagGroupIds = this.produtoEffectiveTags.map(t => t.id);
        const res = await this.activeService.aiPopulateProduto(this.selectedProduto.ref, tagGroupIds, 'local');

        if (Array.isArray(res?.logs)) {
          this.aiLogs = res.logs;
          this.cdr.detectChanges();
        }

        const tags = Array.isArray(res?.tags) ? res.tags : (Array.isArray(res) ? res : null);
        if (tags && tags.length > 0) {
          for (const tag of tags) {
            this.aiProdutoSuggestion[tag.tag_group_id] = tag.value;
            // Only fill if the tag is currently empty — never overwrite existing values
            if (!this.produtoTagValues[tag.tag_group_id]?.trim() && tag.value?.trim()) {
              this.produtoTagValues[tag.tag_group_id] = tag.value;
            }
          }
          await this.saveProduto();
        } else {
          this.snackBar.open('A IA não devolveu sugestões para este produto.', 'Fechar', { duration: 3000 });
        }
      } catch (err: any) {
        if (Array.isArray(err?.error?.logs)) {
          this.aiLogs = err.error.logs;
          this.cdr.detectChanges();
        }
        this.snackBar.open(err?.error?.error || 'Erro ao popular produto com IA', 'Fechar', { duration: 4000 });
      } finally {
        clearInterval(this._aiProdutoTimer);
        this._aiProdutoTimer  = null;
        this.aiProdutoProgress = 100;
        this.cdr.detectChanges();
        await new Promise<void>(r => setTimeout(r, 450));
        this.aiPopulatingProduto = false;
        this.aiProdutoProgress   = 0;
        this.cdr.detectChanges();
      }
    }

  private _aiSub:       Subscription | null = null;
  private _aiSubGrupo:  Subscription | null = null;
  private _aiSubFamilia: Subscription | null = null;
  loading = false;
  saving  = false;

  // ===== Tab navigation =====
  // Tab indices: Filtros=0, Tags=1, Grupos=2, Famílias=3, Subfamílias=4, Produtos=5
  currentTabIndex = 0;

  // ===== Tags =====
  tags: TagGroup[] = [];
  tagValues: Record<number, TagValue[]> = {};
  populatingId:   number | null = null;
  editingTagId:   number | null = null;
  tagForm: { nome: string; descricao: string; unidade: string } = { nome: '', descricao: '', unidade: '' };
  savingTag = false;

  newValueInputs: Record<number, string> = {};
  addingValueId:  number | null = null;
  populateSource: Record<number, string> = {};

  readonly SOURCE_OPTIONS = [
    { value: '',           label: 'Auto (padrão "Nome: valor")' },
    { value: 'usr1',       label: 'Marca (usr1)' },
    { value: 'usr2',       label: 'Ref. Fornecedor (usr2)' },
    { value: 'fornecedor', label: 'Fornecedor' },
    { value: 'familia',    label: 'Família' },
    { value: 'design',     label: 'Nome do produto' },
  ];

  // ===== Raw data =====
  grupos: string[] = [];
  familias: Familia[] = [];
  subfamilias: Subfamilia[] = [];

  // ===== Search strings =====
  searchGrupo      = '';
  searchFamilia    = '';
  searchSubfamilia = '';

  // ===== Grupos =====
  selectedGrupo:       string | null = null;
  grupoTagIds:         number[]      = [];
  grupoOriginalTagIds: number[]      = [];
  loadingGrupo         = false;
  grupoUnsaved         = false;
  aiPopulatingGrupo    = false;
  aiProgressGrupo: { current: number; total: number; ref: string; design: string } | null = null;
  aiStartTimeGrupo     = 0;

  // ===== Famílias =====
  selectedFamilia:           Familia | null = null;
  familiaTagIds:             number[]       = [];
  familiaOriginalTagIds:     number[]       = [];
  familiaInherited:          InheritedTag[] = [];
  familiaExcludedIds:        Set<number>    = new Set();
  familiaOriginalExcludedIds: Set<number>   = new Set();
  loadingFamilia         = false;
  familiaUnsaved         = false;
  aiPopulatingFamilia    = false;
  aiProgressFamilia: { current: number; total: number; ref: string; design: string } | null = null;
  aiStartTimeFamilia     = 0;

  // ===== Subfamílias =====
  selectedSubfamilia:             Subfamilia | null = null;
  subfamiliaTagIds:               number[]          = [];
  subfamiliaOriginalTagIds:       number[]          = [];
  subfamiliaInherited:            InheritedTag[]    = [];
  subfamiliaAncestorExcludedIds:  Set<number>       = new Set();
  subfamiliaExcludedIds:          Set<number>       = new Set();
  subfamiliaOriginalExcludedIds:  Set<number>       = new Set();
  loadingSubfamilia         = false;
  subfamiliaUnsaved         = false;

  // ===== Produtos Tree =====
  produtosTree: ProdGrupoNode[] = [];
  produtosTreeBuilt = false;
  produtoEditMode = false;
  private _produtoTagValuesSnapshot: Record<number, string> = {};

  // ===== Produtos =====
  produtos:          Produto[]             = [];
  selectedProduto:   Produto | null        = null;
  produtoEffectiveTagIds: number[]         = [];
  produtoB2BTagValues: Record<number, string> = {};
  produtoTagValues:  Record<number, string> = {};
  produtoNormalizedTagValues: Record<number, string> = {};
  produtoViewMode:   'populated' | 'normalized' = 'populated';
  showOnlyChanged    = false;
  produtoInfo:       ProdutoInfo           = { ean: '', id_produto: '' };
  loadingProdutos    = false;
  loadingProdutoTags = false;
  savingProduto      = false;
  aiPopulating       = false;
  aiProgress: { current: number; total: number; ref: string; design: string } | null = null;
  aiStartTime        = 0;
  produtoUnsaved     = false;
  searchProduto      = '';

  // ===== AI Logs =====
  aiLogs: { level: string; msg: string }[] = [];
  aiLogsExpanded = true;

  get aiLogsWarnCount(): number {
    return this.aiLogs.filter(l => l.level === 'warn' || l.level === 'error').length;
  }
  private _searchProdutoTimer: any = null;

  constructor(
    private dialogRef:       MatDialogRef<TagsDialog>,
    private service:         TagsService,
    private supridesService: SupridesTagsService,
    private snackBar:        MatSnackBar,
    public  cdr:             ChangeDetectorRef,
    private dialog:          MatDialog,
    private http:            HttpClient,
  ) {}

  get activeService(): TagsService | SupridesTagsService {
    return this.supridesService;
  }

  async ngOnInit() {
    // Interceptar fecho por backdrop e Escape para poder mostrar confirmação
    this.dialogRef.disableClose = true;
    this.dialogRef.backdropClick().subscribe(() => this.fechar());
    this.dialogRef.keydownEvents().subscribe(e => { if (e.key === 'Escape') this.fechar(); });

    await this.loadActiveSource();
  }

  async onSupplierTabChange(index: number) {
    if (index === this.supplierIndex) return;
    this.supplierIndex = index;
    this.tagsSource = this.supplierTabs[index].key;
    this.supridesService.setSource(this.tagsSource);
    await this.loadActiveSource();
  }

  private resetSelections(): void {
    this.currentTabIndex = 0;
    this.selectedGrupo = null;
    this.selectedFamilia = null;
    this.selectedSubfamilia = null;
    this.selectedProduto = null;
    this.grupoTagIds = [];
    this.familiaTagIds = [];
    this.subfamiliaTagIds = [];
    this.produtoEffectiveTagIds = [];
    this.produtos = [];
    this.produtosTree = [];
    this.produtosTreeBuilt = false;
    this.searchGrupo = '';
    this.searchFamilia = '';
    this.searchSubfamilia = '';
    this.searchProduto = '';
  }

  private async loadActiveSource() {
    this.loading = true;
    this.resetSelections();
    this.cdr.detectChanges();
    try {
      const [tags, grupos, familias, subfamilias] = await Promise.all([
        this.activeService.listGroups(),
        this.activeService.listGrupos(),
        this.activeService.listFamilias(),
        this.activeService.listSubfamilias(),
      ]);
      this.tags = tags;
      this.grupos = grupos;
      this.familias = familias;
      this.subfamilias = subfamilias;
    } catch {
      this.snackBar.open('Erro ao carregar dados', 'Fechar', { duration: 2500 });
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  // ─── Tab navigation ───────────────────────────────────────────────────────
  // Tab indices: Tags=0, Grupos=1, Famílias=2, Subfamílias=3, Produtos=4

  onTabChange(index: number) {
    const prev = this.currentTabIndex;
    if (prev === 1 && this.grupoUnsaved)
      this.snackBar.open('Grupo com tags não guardadas', 'OK', { duration: 2500, panelClass: 'snack-warn' });
    if (prev === 2 && this.familiaUnsaved)
      this.snackBar.open('Família com tags não guardadas', 'OK', { duration: 2500, panelClass: 'snack-warn' });
    if (prev === 3 && this.subfamiliaUnsaved)
      this.snackBar.open('Subfamília com tags não guardadas', 'OK', { duration: 2500, panelClass: 'snack-warn' });
    if (prev === 4 && this.produtoUnsaved)
      this.snackBar.open('Produto com valores não guardados', 'OK', { duration: 2500, panelClass: 'snack-warn' });

    this.currentTabIndex = index;

    if (index === 2 && this.selectedGrupo) {
      const group = this.familiaGroups.find(fg => fg.grupo === this.selectedGrupo);
      if (group?.familias.length && !this.isFamiliaSelected(group.familias[0])) {
        this.selectFamilia(group.familias[0]);
      }
    }

    if (index === 3 && this.selectedFamilia) {
      const group = this.subfamiliaGroups.find(sfg =>
        sfg.grupo === this.selectedFamilia!.grupo &&
        sfg.familia === this.selectedFamilia!.familia
      );
      if (group?.subfamilias.length && !this.isSubfamiliaSelected(group.subfamilias[0])) {
        this.selectSubfamilia(group.subfamilias[0]);
      }
    }

    if (index === 4) {
      if (!this.produtosTreeBuilt) this.buildProdutosTree();
      this.searchProduto = '';
      this.produtos = [];
      if (this.selectedSubfamilia) this._expandToSubfamilia(this.selectedSubfamilia);
    }

    this.cdr.detectChanges();
  }

  // ─── Filtered & grouped lists ─────────────────────────────────────────────

  get filteredGrupos(): string[] {
    const t = this.searchGrupo.toLowerCase();
    return t ? this.grupos.filter(g => g.toLowerCase().includes(t)) : this.grupos;
  }

  get familiaGroups(): FamiliaGroup[] {
    const t = this.searchFamilia.toLowerCase();
    const list = t
      ? this.familias.filter(f =>
          f.familia.toLowerCase().includes(t) || f.grupo.toLowerCase().includes(t))
      : this.familias;

    const map = new Map<string, Familia[]>();
    for (const f of list) {
      if (!map.has(f.grupo)) map.set(f.grupo, []);
      map.get(f.grupo)!.push(f);
    }
    const groups = Array.from(map.entries()).map(([grupo, familias]) => ({ grupo, familias }));

    if (this.selectedGrupo) {
      groups.sort((a, b) =>
        a.grupo === this.selectedGrupo ? -1 : b.grupo === this.selectedGrupo ? 1 : 0
      );
    }
    return groups;
  }

  get subfamiliaGroups(): SubfamiliaGroup[] {
    const t = this.searchSubfamilia.toLowerCase();
    const list = t
      ? this.subfamilias.filter(sf =>
          sf.subfamilia.toLowerCase().includes(t) ||
          sf.familia.toLowerCase().includes(t)    ||
          sf.grupo.toLowerCase().includes(t))
      : this.subfamilias;

    const map = new Map<string, Map<string, Subfamilia[]>>();
    for (const sf of list) {
      if (!map.has(sf.grupo)) map.set(sf.grupo, new Map());
      const fmap = map.get(sf.grupo)!;
      if (!fmap.has(sf.familia)) fmap.set(sf.familia, []);
      fmap.get(sf.familia)!.push(sf);
    }

    const result: SubfamiliaGroup[] = [];
    for (const [grupo, fmap] of map) {
      for (const [familia, subfamilias] of fmap) {
        result.push({ grupo, familia, subfamilias });
      }
    }

    if (this.selectedFamilia) {
      const sg = this.selectedFamilia;
      result.sort((a, b) => {
        const aMatch = a.grupo === sg.grupo && a.familia === sg.familia;
        const bMatch = b.grupo === sg.grupo && b.familia === sg.familia;
        return aMatch ? -1 : bMatch ? 1 : 0;
      });
    }
    return result;
  }

  onSearchChange() { this.cdr.detectChanges(); }

  // ─── Tag name autocomplete ─────────────────────────────────────────────────

  get tagSuggestions(): TagGroup[] {
    const q = (this.tagForm.nome || '').trim().toLowerCase();
    if (!q) return [];
    return this.tags.filter(t => t.nome.toLowerCase().startsWith(q));
  }

  get tagNomeExact(): boolean {
    const q = (this.tagForm.nome || '').trim().toLowerCase();
    if (!q || this.editingTagId !== null) return false;
    return this.tags.some(t => t.nome.toLowerCase() === q);
  }

  tagDisplayFn(nome: string): string { return nome; }
  onTagNomeChange() { this.cdr.detectChanges(); }

  // ─── Grupos ───────────────────────────────────────────────────────────────

  async selectGrupo(nome: string) {
    this.selectedGrupo       = nome;
    this.grupoTagIds         = [];
    this.grupoOriginalTagIds = [];
    this.grupoUnsaved        = false;
    this.loadingGrupo        = true;
    this.cdr.detectChanges();
    try {
      this.grupoTagIds         = await this.activeService.getGrupoGroups(nome);
      this.grupoOriginalTagIds = [...this.grupoTagIds];
    }
    catch { /* leave empty */ }
    finally { this.loadingGrupo = false; this.cdr.detectChanges(); }
  }

  onGrupoSelectionChange(ids: number[]) { this.grupoTagIds = ids; this.grupoUnsaved = true; }

  async saveGrupo() {
    if (!this.selectedGrupo) return;
    const removed = this.grupoOriginalTagIds.filter(id => !this.grupoTagIds.includes(id));
    if (removed.length) {
      const confirmed = await this._confirmRemovedTags(removed,
        (id) => this.activeService.getGrupoTagProductCount(this.selectedGrupo!, id));
      if (!confirmed) {
        this.grupoTagIds = [...this.grupoOriginalTagIds];
        this.cdr.detectChanges();
        return;
      }
    }
    this.saving = true; this.cdr.detectChanges();
    try {
      await this.activeService.saveGrupoGroups(this.selectedGrupo, this.grupoTagIds);
      if (removed.length) {
        await this.activeService.deleteGrupoDescendantTagLinks(this.selectedGrupo, removed);
      }
      for (const id of removed)
        await this.activeService.deleteGrupoTagProductValues(this.selectedGrupo!, id);
      this.grupoOriginalTagIds = [...this.grupoTagIds];
      this.grupoUnsaved = false;
      // Refresh inherited tags on família/subfamília if they belong to this grupo
      if (this.selectedFamilia?.grupo === this.selectedGrupo) {
        this.familiaInherited = this.grupoTagIds.map(id => ({
          id, from: 'Grupo', nome: this.tags.find(t => t.id === id)?.nome ?? `#${id}`
        }));
        this.familiaTagIds = this.familiaTagIds.filter(id => !removed.includes(id));
        this.familiaOriginalTagIds = this.familiaOriginalTagIds.filter(id => !removed.includes(id));
        this.familiaExcludedIds = new Set([...this.familiaExcludedIds].filter(id => !removed.includes(id)));
        this.familiaOriginalExcludedIds = new Set([...this.familiaOriginalExcludedIds].filter(id => !removed.includes(id)));
      }
      if (this.selectedSubfamilia?.grupo === this.selectedGrupo) {
        const merged = new Map<number, string>();
        this.grupoTagIds.forEach(id => merged.set(id, 'Grupo'));
        (await this.activeService.getFamiliaGroups(this.selectedSubfamilia.grupo, this.selectedSubfamilia.familia))
          .forEach(id => merged.set(id, 'Família'));
        this.subfamiliaInherited = Array.from(merged.entries())
          .map(([id, from]) => ({ id, from, nome: this.tags.find(t => t.id === id)?.nome ?? `#${id}` }));
        this.subfamiliaTagIds = this.subfamiliaTagIds.filter(id => !removed.includes(id));
        this.subfamiliaOriginalTagIds = this.subfamiliaOriginalTagIds.filter(id => !removed.includes(id));
        this.subfamiliaExcludedIds = new Set([...this.subfamiliaExcludedIds].filter(id => !removed.includes(id)));
        this.subfamiliaOriginalExcludedIds = new Set([...this.subfamiliaOriginalExcludedIds].filter(id => !removed.includes(id)));
      }
      this.snackBar.open('Tags do grupo guardadas', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao guardar', 'Fechar', { duration: 2500 }); }
    finally { this.saving = false; this.cdr.detectChanges(); }
  }

  // ─── Famílias ─────────────────────────────────────────────────────────────

  get tagsForFamiliaPillSelector(): TagGroup[] {
    const inheritedIds = new Set(this.familiaInherited.map(t => t.id));
    return this.tags.filter(t => !inheritedIds.has(t.id));
  }

  get tagsForSubfamiliaPillSelector(): TagGroup[] {
    const inheritedIds = new Set(this.subfamiliaInherited.map(t => t.id));
    return this.tags.filter(t => !inheritedIds.has(t.id));
  }

  async selectFamilia(f: Familia) {
    this.selectedFamilia            = f;
    this.familiaTagIds              = [];
    this.familiaOriginalTagIds      = [];
    this.familiaInherited           = [];
    this.familiaExcludedIds         = new Set();
    this.familiaOriginalExcludedIds = new Set();
    this.familiaUnsaved             = false;
    this.loadingFamilia             = true;
    this.cdr.detectChanges();
    try {
      const [fIds, gIds, exIds] = await Promise.all([
        this.activeService.getFamiliaGroups(f.grupo, f.familia),
        this.activeService.getGrupoGroups(f.grupo),
        this.activeService.getFamiliaExcludedGroups(f.grupo, f.familia).catch(() => [] as number[]),
      ]);
      this.familiaTagIds              = fIds;
      this.familiaOriginalTagIds      = [...fIds];
      this.familiaExcludedIds         = new Set(exIds);
      this.familiaOriginalExcludedIds = new Set(exIds);
      this.familiaInherited           = gIds.map(id => ({
        id, from: 'Grupo', nome: this.tags.find(t => t.id === id)?.nome ?? `#${id}`
      }));
    } catch { /* leave empty */ }
    finally { this.loadingFamilia = false; this.cdr.detectChanges(); }
  }

  toggleFamiliaExclude(id: number) {
    const s = new Set(this.familiaExcludedIds);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.familiaExcludedIds = s;
    this.familiaUnsaved = true;
    this.cdr.detectChanges();
  }

  onFamiliaSelectionChange(ids: number[]) { this.familiaTagIds = ids; this.familiaUnsaved = true; }

  async saveFamilia() {
    if (!this.selectedFamilia) return;
    const removed = this.familiaOriginalTagIds.filter(id => !this.familiaTagIds.includes(id));
    if (removed.length) {
      const { grupo, familia } = this.selectedFamilia;
      const confirmed = await this._confirmRemovedTags(removed,
        (id) => this.activeService.getFamiliaTagProductCount(grupo, familia, id));
      if (!confirmed) {
        this.familiaTagIds = [...this.familiaOriginalTagIds];
        this.cdr.detectChanges();
        return;
      }
    }
    this.saving = true; this.cdr.detectChanges();
    try {
      await Promise.all([
        this.activeService.saveFamiliaGroups(
          this.selectedFamilia.grupo, this.selectedFamilia.familia, this.familiaTagIds),
        this.activeService.saveFamiliaExcludedGroups(
          this.selectedFamilia.grupo, this.selectedFamilia.familia, Array.from(this.familiaExcludedIds)),
      ]);
      if (removed.length) {
        await this.activeService.deleteFamiliaSubfamiliaTagLinks(
          this.selectedFamilia.grupo, this.selectedFamilia.familia, removed);
      }
      for (const id of removed)
        await this.activeService.deleteFamiliaTagProductValues(this.selectedFamilia.grupo, this.selectedFamilia.familia, id);
      this.familiaOriginalTagIds      = [...this.familiaTagIds];
      this.familiaOriginalExcludedIds = new Set(this.familiaExcludedIds);
      this.familiaUnsaved = false;
      // Refresh subfamiliaInherited if selected subfamília belongs to this família
      if (this.selectedSubfamilia?.grupo === this.selectedFamilia.grupo &&
          this.selectedSubfamilia?.familia === this.selectedFamilia.familia) {
        const merged = new Map<number, string>();
        (await this.activeService.getGrupoGroups(this.selectedFamilia.grupo))
          .forEach(id => merged.set(id, 'Grupo'));
        this.familiaTagIds.forEach(id => merged.set(id, 'Família'));
        this.subfamiliaAncestorExcludedIds = new Set(this.familiaExcludedIds);
        this.subfamiliaInherited = Array.from(merged.entries())
          .map(([id, from]) => ({ id, from, nome: this.tags.find(t => t.id === id)?.nome ?? `#${id}` }));
        this.subfamiliaTagIds = this.subfamiliaTagIds.filter(id => !removed.includes(id));
        this.subfamiliaOriginalTagIds = this.subfamiliaOriginalTagIds.filter(id => !removed.includes(id));
        this.subfamiliaExcludedIds = new Set([...this.subfamiliaExcludedIds].filter(id => !removed.includes(id)));
        this.subfamiliaOriginalExcludedIds = new Set([...this.subfamiliaOriginalExcludedIds].filter(id => !removed.includes(id)));
      }
      this.snackBar.open('Tags da família guardadas', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao guardar', 'Fechar', { duration: 2500 }); }
    finally { this.saving = false; this.cdr.detectChanges(); }
  }

  isFamiliaSelected(f: Familia): boolean {
    return !!this.selectedFamilia &&
      this.selectedFamilia.grupo === f.grupo &&
      this.selectedFamilia.familia === f.familia;
  }

  // ─── Confirmação de tags removidas ───────────────────────────────────────

  private async _confirmRemovedTags(
    removedIds: number[],
    countFn: (id: number) => Promise<{ count: number }>
  ): Promise<boolean> {
    const counts = await Promise.all(removedIds.map(id => countFn(id)));
    const totalProducts = counts.reduce((s, r) => s + r.count, 0);
    const tagNames = removedIds
      .map(id => this.tags.find(t => t.id === id)?.nome ?? `#${id}`)
      .join(', ');
    const msg = totalProducts > 0
      ? `Existem ${totalProducts} produto(s) com valor para a(s) tag(s): ${tagNames}.\nDeseja apagar a tag mesmo assim?`
      : `A(s) tag(s) "${tagNames}" serão removidas.\nDeseja apagar?`;
    return confirm(msg);
  }

  // ─── Subfamílias ──────────────────────────────────────────────────────────

  async selectSubfamilia(sf: Subfamilia) {
    this.selectedSubfamilia             = sf;
    this.subfamiliaTagIds               = [];
    this.subfamiliaOriginalTagIds       = [];
    this.subfamiliaInherited            = [];
    this.subfamiliaAncestorExcludedIds  = new Set();
    this.subfamiliaExcludedIds          = new Set();
    this.subfamiliaOriginalExcludedIds  = new Set();
    this.subfamiliaUnsaved              = false;
    this.loadingSubfamilia      = true;
    this.produtos               = [];
    this.selectedProduto        = null;
    this.produtoEffectiveTagIds = [];
    this.produtoB2BTagValues    = {};
    this.produtoTagValues       = {};
    this.produtoNormalizedTagValues = {};
    this.produtoUnsaved         = false;
    this.cdr.detectChanges();
    try {
      const [sfIds, fIds, gIds, familyExIds, exIds] = await Promise.all([
        this.activeService.getSubfamiliaGroups(sf.grupo, sf.familia, sf.subfamilia),
        this.activeService.getFamiliaGroups(sf.grupo, sf.familia),
        this.activeService.getGrupoGroups(sf.grupo),
        this.activeService.getFamiliaExcludedGroups(sf.grupo, sf.familia).catch(() => [] as number[]),
        this.activeService.getSubfamiliaExcludedGroups(sf.grupo, sf.familia, sf.subfamilia).catch(() => [] as number[]),
      ]);
      this.subfamiliaTagIds               = sfIds;
      this.subfamiliaOriginalTagIds       = [...sfIds];
      this.subfamiliaAncestorExcludedIds  = new Set(familyExIds);
      this.subfamiliaExcludedIds          = new Set(exIds);
      this.subfamiliaOriginalExcludedIds  = new Set(exIds);
      const merged = new Map<number, string>();
      gIds.forEach(id => merged.set(id, 'Grupo'));
      fIds.forEach(id => merged.set(id, 'Família'));
      this.subfamiliaInherited = Array.from(merged.entries())
        .map(([id, from]) => ({ id, from, nome: this.tags.find(t => t.id === id)?.nome ?? `#${id}` }));
    } catch { /* leave empty */ }
    finally { this.loadingSubfamilia = false; this.cdr.detectChanges(); }
  }

  isSubfamiliaTagExcluded(id: number): boolean {
    if (this.subfamiliaExcludedIds.has(id)) return true;
    if (this.subfamiliaTagIds.includes(id)) return false;
    return this.subfamiliaAncestorExcludedIds.has(id);
  }

  toggleSubfamiliaExclude(id: number) {
    if (this.subfamiliaAncestorExcludedIds.has(id)) {
      const next = new Set(this.subfamiliaTagIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      this.subfamiliaTagIds = Array.from(next);
      this.subfamiliaUnsaved = true;
      this.cdr.detectChanges();
      return;
    }
    const s = new Set(this.subfamiliaExcludedIds);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.subfamiliaExcludedIds = s;
    this.subfamiliaUnsaved = true;
    this.cdr.detectChanges();
  }

  onSubfamiliaSelectionChange(ids: number[]) { this.subfamiliaTagIds = ids; this.subfamiliaUnsaved = true; }

  async saveSubfamilia() {
    if (!this.selectedSubfamilia) return;
    const removed = this.subfamiliaOriginalTagIds.filter(id => !this.subfamiliaTagIds.includes(id));
    if (removed.length) {
      const { grupo, familia, subfamilia } = this.selectedSubfamilia;
      const confirmed = await this._confirmRemovedTags(removed,
        (id) => this.activeService.getSubfamiliaTagProductCount(grupo, familia, subfamilia, id));
      if (!confirmed) {
        this.subfamiliaTagIds = [...this.subfamiliaOriginalTagIds];
        this.cdr.detectChanges();
        return;
      }
    }
    this.saving = true; this.cdr.detectChanges();
    try {
      await Promise.all([
        this.activeService.saveSubfamiliaGroups(
          this.selectedSubfamilia.grupo, this.selectedSubfamilia.familia,
          this.selectedSubfamilia.subfamilia, this.subfamiliaTagIds),
        this.activeService.saveSubfamiliaExcludedGroups(
          this.selectedSubfamilia.grupo, this.selectedSubfamilia.familia,
          this.selectedSubfamilia.subfamilia, Array.from(this.subfamiliaExcludedIds)),
      ]);
      for (const id of removed)
        await this.activeService.deleteSubfamiliaTagProductValues(
          this.selectedSubfamilia.grupo, this.selectedSubfamilia.familia,
          this.selectedSubfamilia.subfamilia, id);
      this.subfamiliaOriginalTagIds      = [...this.subfamiliaTagIds];
      this.subfamiliaOriginalExcludedIds = new Set(this.subfamiliaExcludedIds);
      this.subfamiliaUnsaved = false;
      this.snackBar.open('Tags da subfamília guardadas', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao guardar', 'Fechar', { duration: 2500 }); }
    finally { this.saving = false; this.cdr.detectChanges(); }
  }

  isSubfamiliaSelected(sf: Subfamilia): boolean {
    return !!this.selectedSubfamilia &&
      this.selectedSubfamilia.grupo === sf.grupo &&
      this.selectedSubfamilia.familia === sf.familia &&
      this.selectedSubfamilia.subfamilia === sf.subfamilia;
  }

  // ─── Tags CRUD ────────────────────────────────────────────────────────────

  startEditTag(t: TagGroup) {
    this.editingTagId = t.id;
    this.tagForm = { nome: t.nome, descricao: t.descricao ?? '', unidade: t.unidade ?? '' };
    this.cdr.detectChanges();
  }

  cancelEditTag() {
    this.editingTagId = null;
    this.tagForm = { nome: '', descricao: '', unidade: '' };
    this.cdr.detectChanges();
  }

  async saveTag() {
    const nome = this.tagForm.nome.trim();
    if (!nome) { this.snackBar.open('O nome é obrigatório', 'Fechar', { duration: 2000 }); return; }
    this.savingTag = true; this.cdr.detectChanges();
    try {
      if (this.editingTagId === null) {
        const t = await this.activeService.createGroup(nome, this.tagForm.descricao, this.tagForm.unidade);
        this.tags = [...this.tags, t];
      } else {
        const t = await this.activeService.updateGroup(this.editingTagId, nome, this.tagForm.descricao, this.tagForm.unidade);
        this.tags = this.tags.map(x => x.id === t.id ? t : x);
      }
      this.cancelEditTag();
      this.snackBar.open('Tag guardada', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao guardar', 'Fechar', { duration: 2500 }); }
    finally { this.savingTag = false; this.cdr.detectChanges(); }
  }

  async deleteTag(t: TagGroup) {
    if (!confirm(`Eliminar a tag "${t.nome}"?`)) return;
    try {
      await this.activeService.deleteGroup(t.id);
      this.tags = this.tags.filter(x => x.id !== t.id);
      delete this.tagValues[t.id];
      this.cdr.detectChanges();
      this.snackBar.open('Tag eliminada', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao eliminar', 'Fechar', { duration: 2500 }); }
  }

  // ─── Tag Values ───────────────────────────────────────────────────────────

  async loadTagValues(t: TagGroup) {
    if (this.tagValues[t.id] !== undefined) return;
    try { this.tagValues[t.id] = await this.activeService.getGroupValues(t.id); }
    catch { this.tagValues[t.id] = []; }
    finally { this.cdr.detectChanges(); }
  }

  async populateTag(t: TagGroup) {
    this.populatingId = t.id; this.cdr.detectChanges();
    try {
      const src = this.populateSource[t.id] || undefined;
      const result = await this.activeService.populateGroupValues(t.id, src);
      this.tagValues[t.id] = await this.activeService.getGroupValues(t.id);
      const msg = result.warning
        ?? (result.added > 0
            ? `+${result.added} novo(s) valor(es) adicionado(s) de ${result.found} encontrado(s)`
            : `Nenhum valor novo — ${result.found} já existente(s)`);
      this.snackBar.open(msg, 'Fechar', { duration: 4500 });
    } catch { this.snackBar.open('Erro ao popular', 'Fechar', { duration: 2500 }); }
    finally { this.populatingId = null; this.cdr.detectChanges(); }
  }

  async addValue(t: TagGroup) {
    const val = (this.newValueInputs[t.id] || '').trim();
    if (!val) return;
    this.addingValueId = t.id; this.cdr.detectChanges();
    try {
      const v = await this.activeService.addGroupValue(t.id, val);
      if (!this.tagValues[t.id]) this.tagValues[t.id] = [];
      this.tagValues[t.id] = [...this.tagValues[t.id], v];
      this.newValueInputs[t.id] = '';
    } catch (err: any) {
      const msg = err?.error?.error === 'Valor já existe' ? 'Esse valor já existe' : 'Erro ao adicionar valor';
      this.snackBar.open(msg, 'Fechar', { duration: 2000 });
    }
    finally { this.addingValueId = null; this.cdr.detectChanges(); }
  }

  async deleteValue(tagId: number, valueId: number) {
    try {
      await this.activeService.deleteGroupValue(valueId);
      this.tagValues[tagId] = (this.tagValues[tagId] ?? []).filter(v => v.id !== valueId);
      this.cdr.detectChanges();
    } catch { this.snackBar.open('Erro ao remover valor', 'Fechar', { duration: 2000 }); }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  familiaKey(_i: number, f: Familia)         { return `${f.grupo}|||${f.familia}`; }
  subfamiliaKey(_i: number, sf: Subfamilia)  { return `${sf.grupo}|||${sf.familia}|||${sf.subfamilia}`; }

  // ─── Breadcrumb navigation ────────────────────────────────────────────────

  navigateToGrupo(nome: string) {
    if (this.familiaUnsaved || this.subfamiliaUnsaved)
      this.snackBar.open('Tags não guardadas', 'OK', { duration: 2500, panelClass: 'snack-warn' });
    this.selectGrupo(nome);
    this.currentTabIndex = 1;
    this.cdr.detectChanges();
  }

  navigateToFamilia(grupo: string, familia: string) {
    if (this.subfamiliaUnsaved)
      this.snackBar.open('Tags não guardadas', 'OK', { duration: 2500, panelClass: 'snack-warn' });
    const f = this.familias.find(x => x.grupo === grupo && x.familia === familia);
    if (f) this.selectFamilia(f);
    this.currentTabIndex = 2;
    this.cdr.detectChanges();
  }

  // ─── Produtos ─────────────────────────────────────────────────────────────

  get produtoEffectiveTags(): TagGroup[] {
    if (!this.produtoEffectiveTagIds.length) return [];
    const effectiveIds = new Set(this.produtoEffectiveTagIds);
    return this.tags.filter(t => effectiveIds.has(t.id));
  }

  get produtoFilledCount(): number {
    return this.produtoEffectiveTags.filter(t => !!this.produtoTagValues[t.id]?.trim()).length;
  }

  // ─── Toggle Originais / Normalizados ─────────────────────────────────────

  getDisplayValue(tagId: number): string {
    if (this.produtoViewMode === 'normalized') {
      return this.produtoNormalizedTagValues[tagId] ?? this.produtoTagValues[tagId] ?? '';
    }
    return this.produtoTagValues[tagId] ?? '';
  }

  isTagChanged(tagId: number): boolean {
    const orig = this.produtoTagValues[tagId] ?? '';
    const norm = this.produtoNormalizedTagValues[tagId] ?? '';
    return orig !== '' && norm !== '' && orig !== norm;
  }

  get changedTagIds(): Set<number> {
    const s = new Set<number>();
    for (const tag of this.produtoEffectiveTags) {
      if (this.isTagChanged(tag.id)) s.add(tag.id);
    }
    return s;
  }

  get changedTagCount(): number {
    return this.changedTagIds.size;
  }

  get visibleProdutoEffectiveTags(): TagGroup[] {
    if (!this.showOnlyChanged) return this.produtoEffectiveTags;
    const changed = this.changedTagIds;
    return this.produtoEffectiveTags.filter(t => changed.has(t.id));
  }

  setViewMode(mode: 'populated' | 'normalized') {
    this.produtoViewMode = mode;
    this.cdr.detectChanges();
  }

  toggleShowOnlyChanged() {
    this.showOnlyChanged = !this.showOnlyChanged;
    this.cdr.detectChanges();
  }

  get filteredProdutos(): Produto[] {
    return this.produtos;
  }

  onSearchProdutoChange() {
    clearTimeout(this._searchProdutoTimer);
    this._searchProdutoTimer = setTimeout(() => this.loadProdutos(), 350);
    this.cdr.detectChanges();
  }

  async loadProdutos() {
    const q = this.searchProduto.trim();
    if (q.length < 2) {
      this.produtos = [];
      this.cdr.detectChanges();
      return;
    }
    this.loadingProdutos = true;
    this.cdr.detectChanges();
    try {
      this.produtos = await this.activeService.searchProdutos(q);
    } catch { this.produtos = []; }
    finally { this.loadingProdutos = false; this.cdr.detectChanges(); }
  }

  async selectProduto(p: Produto) {
    this.selectedProduto    = p;
    this.produtoEffectiveTagIds = [];
    this.produtoUnsaved     = false;
    this.produtoEditMode    = false;
    this.produtoViewMode    = 'populated';
    this.showOnlyChanged    = false;
    this._produtoTagValuesSnapshot = {};
    this.loadingProdutoTags = true;
    this.produtoInfo        = { ean: '', id_produto: '' };
    this.cdr.detectChanges();

    const b2bVals: Record<number, string> = {};
    const vals: Record<number, string> = {};
    const normVals: Record<number, string> = {};
    try {
      const [effectiveTagIds, saved, info] = await Promise.all([
        this.activeService.getProdutoEffectiveTagIds(p.ref),
        this.activeService.getProdutoTagValuesWithNormalized(p.ref),
        this.activeService.getProdutoInfo(p.ref),
      ]);
      this.produtoEffectiveTagIds = effectiveTagIds;
      this.produtoEffectiveTags.forEach(t => { b2bVals[t.id] = ''; vals[t.id] = ''; normVals[t.id] = ''; });
      saved.forEach((v: ProdutoTagValueWithNormalized) => {
        if (!(v.tag_group_id in vals)) return;
        b2bVals[v.tag_group_id]  = v.b2b_value;
        vals[v.tag_group_id]     = v.populated_value;
        normVals[v.tag_group_id] = v.normalized_value;
      });
      this.produtoInfo = info;
    } catch { /* leave empty */ }
    this.produtoB2BTagValues        = b2bVals;
    this.produtoTagValues           = vals;
    this.produtoNormalizedTagValues = normVals;
    this.loadingProdutoTags         = false;
    this.cdr.detectChanges();
  }

  onProdutoTagChange() { this.produtoUnsaved = true; this.cdr.detectChanges(); }

  async clearProdutoTags() {
    if (!this.selectedProduto || !this.produtoEffectiveTags.length) return;
    const confirmed = window.confirm(`Limpar todos os valores das tags do produto "${this.selectedProduto.design}"?`);
    if (!confirmed) return;
    this.savingProduto = true; this.cdr.detectChanges();
    try {
      const empty: ProdutoTagValue[] = this.produtoEffectiveTags.map(t => ({ tag_group_id: t.id, value: '' }));
      await this.activeService.saveProdutoTagValues(this.selectedProduto.ref, empty);
      this.produtoUnsaved = false;
      this.produtoEditMode = false;
      this._produtoTagValuesSnapshot = {};
      await this.selectProduto(this.selectedProduto);
      this.snackBar.open('Tags limpas', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao limpar tags', 'Fechar', { duration: 2500 }); }
    finally { this.savingProduto = false; this.cdr.detectChanges(); }
  }

  async saveProduto() {
    if (!this.selectedProduto) return;
    this.savingProduto = true; this.cdr.detectChanges();
    try {
      const values: ProdutoTagValue[] = this.produtoEffectiveTags.map(t => ({
        tag_group_id: t.id,
        value: (() => {
          const populated = (this.produtoTagValues[t.id] ?? '').trim();
          const b2b = (this.produtoB2BTagValues[t.id] ?? '').trim();
          return populated === b2b ? '' : populated;
        })(),
      }));
      await Promise.all([
        this.activeService.saveProdutoTagValues(this.selectedProduto.ref, values),
        this.activeService.saveProdutoInfo(this.selectedProduto.ref, this.produtoInfo),
      ]);
      this.produtoUnsaved = false;
      await this.selectProduto(this.selectedProduto);
      this.snackBar.open('Valores guardados', 'Fechar', { duration: 1500 });
    } catch { this.snackBar.open('Erro ao guardar', 'Fechar', { duration: 2500 }); }
    finally { this.savingProduto = false; this.cdr.detectChanges(); }
  }

  // ─── Produtos Tree ────────────────────────────────────────────────────────

  buildProdutosTree() {
    const grupoMap = new Map<string, Map<string, ProdSubNode[]>>();
    for (const sf of this.subfamilias) {
      if (!grupoMap.has(sf.grupo)) grupoMap.set(sf.grupo, new Map());
      const famMap = grupoMap.get(sf.grupo)!;
      if (!famMap.has(sf.familia)) famMap.set(sf.familia, []);
      famMap.get(sf.familia)!.push({
        subfamilia: sf.subfamilia, grupo: sf.grupo, familia: sf.familia,
        expanded: false, produtos: [], loading: false, loaded: false,
      });
    }
    this.produtosTree = Array.from(grupoMap.entries()).map(([nome, famMap]) => ({
      nome,
      expanded: false,
      fams: Array.from(famMap.entries()).map(([familia, subs]) => ({
        familia, grupo: nome, expanded: false, subs,
      })),
    }));
    this.produtosTreeBuilt = true;
    // Carrega todos os produtos em paralelo (para os contadores ficarem disponíveis)
    this._eagerLoadAllSubProdutos();
  }

  private _expandToSubfamilia(sf: Subfamilia) {
    for (const g of this.produtosTree) {
      if (g.nome !== sf.grupo) { g.expanded = false; continue; }
      g.expanded = true;
      for (const f of g.fams) {
        if (f.familia !== sf.familia) { f.expanded = false; continue; }
        f.expanded = true;
        for (const s of f.subs) {
          if (s.subfamilia === sf.subfamilia) s.expanded = true;
        }
      }
    }
    this.cdr.detectChanges();
  }

  private _eagerLoadAllSubProdutos() {
    // Carrega contagens de todos os produtos (vaiwww=1) numa única query agregada
    // em vez de N requests paralelos — muito mais rápido.
    this.activeService.getProductTreeCounts().then(counts => {
      // Indexar por "grupo|familia|subfamilia" para lookup O(1)
      const idx = new Map<string, number>();
      for (const c of counts) {
        idx.set(`${c.grupo}|${c.familia}|${c.subfamilia}`, c.total);
      }
      for (const g of this.produtosTree) {
        for (const f of g.fams) {
          for (const s of f.subs) {
            const key   = `${s.grupo}|${s.familia}|${s.subfamilia}`;
            const total = idx.get(key) ?? 0;
            // Usar placeholders para mostrar os contadores imediatamente.
            // Os produtos reais são carregados ao expandir o nó (toggleSubNode).
            s.produtos  = new Array(total).fill({ ref: '', design: '' }) as any;
            s.loaded    = true;
            s.countOnly = true;
            s.loading   = false;
          }
        }
      }
      this.cdr.markForCheck();
    }).catch(() => {
      // Falha silenciosa: os contadores ficam a 0, os produtos carregam ao expandir
      this.cdr.markForCheck();
    });
  }

  prodFamTotal(f: ProdFamNode): number {
    return f.subs.reduce((a, s) => a + (s.loaded ? s.produtos.length : 0), 0);
  }

  prodGrupoTotal(g: ProdGrupoNode): number {
    return g.fams.reduce((a, f) => a + this.prodFamTotal(f), 0);
  }

  toggleGrupoNode(g: ProdGrupoNode) { g.expanded = !g.expanded; this.cdr.detectChanges(); }
  toggleFamNode(f: ProdFamNode) { f.expanded = !f.expanded; this.cdr.detectChanges(); }

  async toggleSubNode(s: ProdSubNode) {
    s.expanded = !s.expanded;
    // Carrega produtos reais se ainda não foram carregados (ou só temos a contagem)
    if (s.expanded && !s.loading && (!s.loaded || s.countOnly)) {
      s.loading = true;
      this.cdr.detectChanges();
      try {
        s.produtos  = await this.activeService.listProdutosBySubfamilia(s.grupo, s.familia, s.subfamilia);
        s.loaded    = true;
        s.countOnly = false;
      } catch { s.produtos = []; s.loaded = true; s.countOnly = false; }
      finally { s.loading = false; this.cdr.detectChanges(); }
    }
    this.cdr.detectChanges();
  }

  toggleProdutoEditMode() {
    if (!this.produtoEditMode) {
      this._produtoTagValuesSnapshot = { ...this.produtoTagValues };
      this.produtoEditMode = true;
    } else {
      // Cancelar — restaurar snapshot
      this.produtoTagValues = { ...this._produtoTagValuesSnapshot };
      this.produtoUnsaved = false;
      this.produtoEditMode = false;
      this._produtoTagValuesSnapshot = {};
    }
    this.cdr.detectChanges();
  }

  aiPopulateSubfamilia() {
    if (!this.selectedSubfamilia) return;
    this.aiPopulating  = true;
    this.aiProgress    = null;
    this.aiLogs        = [];
    this.aiLogsExpanded = true;
    this.aiStartTime   = Date.now();
    this.cdr.detectChanges();

    const { grupo, familia, subfamilia } = this.selectedSubfamilia;
    this._aiSub = this.activeService.aiPopulateSubfamilia(grupo, familia, subfamilia, this.aiMode).subscribe({
      next: async (event: any) => {
        if (event.type === 'log') {
          this.aiLogs = [...this.aiLogs.slice(-199), { level: event.level ?? 'info', msg: event.msg ?? '' }];
          this.cdr.detectChanges();
        } else if (event.type === 'progress') {
          this.aiProgress = { current: event.current, total: event.total, ref: event.ref, design: event.design };
          this.cdr.detectChanges();
        } else if (event.type === 'done') {
          if (this.selectedProduto) await this.selectProduto(this.selectedProduto);
          const { populated, total, failed, reason } = event;
          if (reason) {
            this.snackBar.open(reason, 'Fechar', { duration: 9000, panelClass: 'snack-warn' });
          } else if (failed > 0) {
            this.snackBar.open(`IA populou ${populated}/${total} produto(s) — ${failed} com erro`, 'Fechar', { duration: 6000, panelClass: 'snack-warn' });
          } else {
            this.snackBar.open(`IA populou ${populated}/${total} produto(s) com sucesso ✓`, 'Fechar', { duration: 5000 });
          }
        } else if (event.type === 'error') {
          this.snackBar.open(event.message || 'Erro na IA', 'Fechar', { duration: 5000 });
        }
      },
      error: () => {
        this.snackBar.open('Erro ao contactar a IA. Verifica a configuração da API key.', 'Fechar', { duration: 5000 });
        this.aiPopulating = false;
        this.aiProgress = null;
        this.cdr.detectChanges();
      },
      complete: () => {
        this.aiPopulating = false;
        this.aiProgress = null;
        this._aiSub = null;
        this.cdr.detectChanges();
      },
    });
  }

  cancelAiPopulate() {
    this._aiSub?.unsubscribe();
    this._aiSub = null;
    this.aiPopulating = false;
    this.aiProgress = null;
    this.cdr.detectChanges();
  }

  aiPopulateFamiliaBtn() {
    if (!this.selectedFamilia) return;
    this.aiPopulatingFamilia = true;
    this.aiProgressFamilia   = null;
    this.aiLogs              = [];
    this.aiLogsExpanded      = true;
    this.aiStartTimeFamilia  = Date.now();
    this.cdr.detectChanges();

    const { grupo, familia } = this.selectedFamilia;
    this._aiSubFamilia = this.activeService.aiPopulateFamilia(grupo, familia, this.aiMode).subscribe({
      next: async (event: any) => {
        if (event.type === 'log') {
          this.aiLogs = [...this.aiLogs.slice(-199), { level: event.level ?? 'info', msg: event.msg ?? '' }];
          this.cdr.detectChanges();
        } else if (event.type === 'progress') {
          this.aiProgressFamilia = { current: event.current, total: event.total, ref: event.ref, design: event.design };
          this.cdr.detectChanges();
        } else if (event.type === 'done') {
          if (this.selectedProduto) await this.selectProduto(this.selectedProduto);
          const { populated, total, failed, reason } = event;
          if (reason) this.snackBar.open(reason, 'Fechar', { duration: 5000 });
          else if (failed > 0) this.snackBar.open(`IA populou ${populated}/${total} produto(s) — ${failed} com erro`, 'Fechar', { duration: 6000, panelClass: 'snack-warn' });
          else this.snackBar.open(`IA populou ${populated}/${total} produto(s) com sucesso ✓`, 'Fechar', { duration: 5000 });
        } else if (event.type === 'error') {
          this.snackBar.open(event.message || 'Erro na IA', 'Fechar', { duration: 5000 });
        }
      },
      error: () => {
        this.snackBar.open('Erro ao contactar a IA. Verifica a configuração da API key.', 'Fechar', { duration: 5000 });
        this.aiPopulatingFamilia = false;
        this.aiProgressFamilia = null;
        this.cdr.detectChanges();
      },
      complete: () => {
        this.aiPopulatingFamilia = false;
        this.aiProgressFamilia = null;
        this._aiSubFamilia = null;
        this.cdr.detectChanges();
      },
    });
  }

  cancelAiPopulateFamilia() {
    this._aiSubFamilia?.unsubscribe();
    this._aiSubFamilia = null;
    this.aiPopulatingFamilia = false;
    this.aiProgressFamilia = null;
    this.cdr.detectChanges();
  }

  aiPopulateGrupoBtn() {
    if (!this.selectedGrupo) return;
    this.aiPopulatingGrupo  = true;
    this.aiProgressGrupo    = null;
    this.aiLogs             = [];
    this.aiLogsExpanded     = true;
    this.aiStartTimeGrupo   = Date.now();
    this.cdr.detectChanges();

    const grupo = this.selectedGrupo;
    this._aiSubGrupo = this.activeService.aiPopulateGrupo(grupo, this.aiMode).subscribe({
      next: async (event: any) => {
        if (event.type === 'log') {
          this.aiLogs = [...this.aiLogs.slice(-199), { level: event.level ?? 'info', msg: event.msg ?? '' }];
          this.cdr.detectChanges();
        } else if (event.type === 'progress') {
          this.aiProgressGrupo = { current: event.current, total: event.total, ref: event.ref, design: event.design };
          this.cdr.detectChanges();
        } else if (event.type === 'done') {
          if (this.selectedProduto) await this.selectProduto(this.selectedProduto);
          const { populated, total, failed, reason } = event;
          if (reason) this.snackBar.open(reason, 'Fechar', { duration: 5000 });
          else if (failed > 0) this.snackBar.open(`IA populou ${populated}/${total} produto(s) — ${failed} com erro`, 'Fechar', { duration: 6000, panelClass: 'snack-warn' });
          else this.snackBar.open(`IA populou ${populated}/${total} produto(s) com sucesso ✓`, 'Fechar', { duration: 5000 });
        } else if (event.type === 'error') {
          this.snackBar.open(event.message || 'Erro na IA', 'Fechar', { duration: 5000 });
        }
      },
      error: () => {
        this.snackBar.open('Erro ao contactar a IA. Verifica a configuração da API key.', 'Fechar', { duration: 5000 });
        this.aiPopulatingGrupo = false;
        this.aiProgressGrupo = null;
        this.cdr.detectChanges();
      },
      complete: () => {
        this.aiPopulatingGrupo = false;
        this.aiProgressGrupo = null;
        this._aiSubGrupo = null;
        this.cdr.detectChanges();
      },
    });
  }

  cancelAiPopulateGrupo() {
    this._aiSubGrupo?.unsubscribe();
    this._aiSubGrupo = null;
    this.aiPopulatingGrupo = false;
    this.aiProgressGrupo = null;
    this.cdr.detectChanges();
  }

  ngOnDestroy() { this._aiSub?.unsubscribe(); this._aiSubGrupo?.unsubscribe(); this._aiSubFamilia?.unsubscribe(); }

  fechar() {
    if (this.aiPopulating || this.aiPopulatingGrupo || this.aiPopulatingFamilia) {
      const confirmed = window.confirm('Está a popular produtos com IA. Deseja realmente sair?');
      if (!confirmed) return;
      this.cancelAiPopulate();
      this.cancelAiPopulateGrupo();
      this.cancelAiPopulateFamilia();
    }
    this.dialogRef.close();
  }

  // ===== Normalização de tags =====
    normalizarTags(): void {
    if (!confirm('Normalizar todos os valores de tags dos produtos?')) return;
    const url = `${API}/${this.tagsSource}/tags/normalize`;
    this.http.post<{ total: number; saved: number; ignored: number }>(url, {}).subscribe({
      next: (r) => this.snackBar.open(`Normalização concluída — ${r.saved} valores guardados (${r.ignored} ignorados)`, 'Fechar', { duration: 4000 }),
      error: () => this.snackBar.open('Erro ao normalizar tags', 'Fechar', { duration: 3000 }),
    });
  }

}
