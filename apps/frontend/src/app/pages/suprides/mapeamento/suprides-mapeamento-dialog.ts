import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { TagMultiSelectComponent } from '../../../shared/tag-multi-select/tag-multi-select.component';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  SupridesService,
  type SupplierKey,
  type FamiliaTree, type SyncProgress, type ShopifyMenu, type MenuSyncNode,
  type ShopifyCollectionMapping,
  type SyncFamiliasResult,
} from '../suprides.service';

interface MenuNode {
  title: string;
  shopifyId?: string;
  children: MenuNode[];
}

interface CollMapRow {
  collId: string;
  title: string;
  parentCollId?: string;
  parentTitle?: string;
  parentL1CollId?: string;
  parentL1Title?: string;
  mappedItems: string[];
  availableOptions: string[];
  hidden?: boolean;
}

interface FamiliaGroup {
  l1CollId: string;
  l1Title:  string;
  rows:     CollMapRow[];
}

interface SubfamiliaGroup {
  l2CollId: string;
  l2Title:  string;
  l1Title:  string;
  rows:     CollMapRow[];
}

type ReviewPhase = 'idle' | 'loading' | 'review' | 'progress' | 'done' | 'error';

@Component({
  selector: 'app-suprides-mapeamento-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTabsModule, MatButtonModule, MatIconModule,
    MatProgressBarModule, MatTooltipModule, DragDropModule,
    TagMultiSelectComponent
  ],
  templateUrl: './suprides-mapeamento-dialog.html',
  styleUrls: ['./suprides-mapeamento-dialog.scss']
})
export class SupridesMapeamentoDialog implements OnInit, OnDestroy {
  private svcRoot = inject(SupridesService);
  private svc = this.svcRoot.withSupplier('suprides');
  private dialogRef = inject(MatDialogRef<SupridesMapeamentoDialog>);

  supplierIndex = 0;
  readonly suppliers: { key: SupplierKey; label: string }[] = [
    { key: 'suprides', label: 'Suprides' },
    { key: 'esprinet', label: 'Esprinet' },
  ];

  get activeSupplier(): SupplierKey { return this.suppliers[this.supplierIndex].key; }
  get activeSupplierLabel(): string { return this.suppliers[this.supplierIndex].label; }
  get isEsprinet(): boolean { return this.activeSupplier === 'esprinet'; }

  loading = true;
  error = '';
  savingMapping = false;
  mappingSaved = false;
  activeTabIndex = 0;

  private static _norm(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private _menuSearch       = '';
  private _familiaSearch    = '';
  private _subfamiliaSearch = '';

  filteredMenuRows:       CollMapRow[]      = [];
  filteredFamiliaGroups:  FamiliaGroup[]    = [];
  filteredSubfamiliaGroups: SubfamiliaGroup[] = [];

  get menuSearch()       { return this._menuSearch; }
  get familiaSearch()    { return this._familiaSearch; }
  get subfamiliaSearch() { return this._subfamiliaSearch; }

  set menuSearch(v: string)       { this._menuSearch       = v; this._scheduleFilter(); }
  set familiaSearch(v: string)    { this._familiaSearch    = v; this._scheduleFilter(); }
  set subfamiliaSearch(v: string) { this._subfamiliaSearch = v; this._scheduleFilter(); }

  private _filterTimer?: ReturnType<typeof setTimeout>;

  private _scheduleFilter(): void {
    clearTimeout(this._filterTimer);
    this._filterTimer = setTimeout(() => this._rebuildFiltered(), 150);
  }

  private _rebuildFiltered(): void {
    const mq = SupridesMapeamentoDialog._norm(this._menuSearch);
    this.filteredMenuRows = mq
      ? this.menuRows.filter(r => SupridesMapeamentoDialog._norm(r.title).includes(mq))
      : this.menuRows;

    const fq = SupridesMapeamentoDialog._norm(this._familiaSearch);
    this.filteredFamiliaGroups = fq
      ? this.familiaGroups
          .map(g => {
            const groupMatches = SupridesMapeamentoDialog._norm(g.l1Title).includes(fq);
            return { l1CollId: g.l1CollId, l1Title: g.l1Title,
                     rows: groupMatches ? g.rows : g.rows.filter(r => SupridesMapeamentoDialog._norm(r.title).includes(fq)) };
          })
          .filter(g => g.rows.length > 0)
      : this.familiaGroups;
    if (fq) this.filteredFamiliaGroups.forEach(g => this.expandedFamiliaGroups.add(g.l1CollId));

    const sq = SupridesMapeamentoDialog._norm(this._subfamiliaSearch);
    this.filteredSubfamiliaGroups = sq
      ? this.subfamiliaGroups
          .map(g => {
            const groupMatches = SupridesMapeamentoDialog._norm(g.l1Title).includes(sq) ||
                                 SupridesMapeamentoDialog._norm(g.l2Title).includes(sq);
            return { l2CollId: g.l2CollId, l2Title: g.l2Title, l1Title: g.l1Title,
                     rows: groupMatches ? g.rows : g.rows.filter(r => SupridesMapeamentoDialog._norm(r.title).includes(sq)) };
          })
          .filter(g => g.rows.length > 0)
      : this.subfamiliaGroups;
    if (sq) this.filteredSubfamiliaGroups.forEach(g => this.expandedSubfamiliaGroups.add(g.l2CollId));
  }

  trackByCollId(_i: number, r: CollMapRow)     { return r.collId; }
  trackByL1CollId(_i: number, g: FamiliaGroup) { return g.l1CollId; }
  trackByL2CollId(_i: number, g: SubfamiliaGroup) { return g.l2CollId; }

  familiaTree: FamiliaTree[] = [];
  shopifyMenuData: ShopifyMenu | null = null;
  shopifyCollectionMapping: ShopifyCollectionMapping = { menu: {}, familia: {}, subfamilia: {} };

  // Mapping rows — one per Shopify collection level
  menuRows:       CollMapRow[] = [];
  familiaRows:    CollMapRow[] = [];
  subfamiliaRows: CollMapRow[] = [];

  // Suprides data available as options
  suprideLines:    string[] = [];
  suprideFamilies: string[] = [];

  // Accordion groups for Família and Subfamília tabs
  familiaGroups:    FamiliaGroup[]    = [];
  subfamiliaGroups: SubfamiliaGroup[] = [];
  expandedFamiliaGroups    = new Set<string>();
  expandedSubfamiliaGroups = new Set<string>();

  // Gerir Menu (Miller columns)
  menuNodes: MenuNode[] = [];
  selectedLinha:   MenuNode | null = null;
  selectedFamilia: MenuNode | null = null;
  menuLoading = false;
  menuSyncing = false;
  menuSaving = false;
  menuResolvingIds = false;
  menuResolveResult: { resolved: number; total: number } | null = null;
  menuReviewing = false;
  menuSyncResult: { created: number; renamed: number; deleted: number; errors: string[] } | null = null;
  menuSyncTotal = 0;
  menuSyncDone  = 0;
  menuSyncPhase = '';
  menuError  = '';
  menuLoaded = false;
  editingNode:  MenuNode | null = null;
  editingTitle = '';
  addingAt: 'linha' | 'familia' | 'subfamilia' | null = null;
  newTitle = '';

  // Review overlay
  reviewPhase: ReviewPhase = 'idle';
  syncProgress: SyncProgress = { running: false, total: 0, done: 0, errors: 0 };
  syncResult: SyncFamiliasResult | null = null;
  syncReviewLines: { collTitle: string; lines: string[]; familiaCount: number; subfamiliaCount: number; productCount?: number; level?: string }[] = [];
  syncReviewProductCount = 0;
  syncReviewEligibleCount = 0;
  syncReviewWithoutCollections = 0;
  private progressInterval?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.loadSupplierData();
  }

  onSupplierTabChange(index: number): void {
    if (index === this.supplierIndex) return;
    if (this.hasDraft && this.menuRows.length) {
      this.svc.saveShopifyCollectionMapping(this._collectMapping()).subscribe();
    }
    this.supplierIndex = index;
    this.svc = this.svcRoot.withSupplier(this.activeSupplier);
    this.loadSupplierData();
  }

  private loadSupplierData(): void {
    this.loading = true;
    this.error = '';
    this.hasDraft = false;
    this.mappingSaved = false;
    this.activeTabIndex = 0;
    this.menuSearch = '';
    this.familiaSearch = '';
    this.subfamiliaSearch = '';
    this.selectedLinha = null;
    this.selectedFamilia = null;
    this.menuNodes = [];
    this.menuLoaded = false;
    forkJoin([
      this.svc.getFamilias(),
      this.svc.getShopifyCollectionMapping().pipe(
        catchError(() => of({ menu: {}, familia: {}, subfamilia: {} } as ShopifyCollectionMapping))
      ),
      this.svc.getShopifyMenu().pipe(catchError(() => of(null)))
    ]).subscribe({
      next: ([familias, collMapping, menu]) => {
        this.familiaTree              = familias;
        this.shopifyMenuData          = menu as ShopifyMenu | null;
        this.shopifyCollectionMapping = collMapping as ShopifyCollectionMapping;
        this._buildSupridesData();
        this._buildCollectionRows();
        if (menu) this._buildMenuNodes(menu as ShopifyMenu);
        this.loading = false;
      },
      error: (e) => {
        this.error   = e.message || 'Erro ao carregar dados';
        this.loading = false;
      }
    });
  }

  // ── Data builders ──────────────────────────────────────────────────────────────

  private _buildSupridesData(): void {
    const lineSet = new Set<string>();
    const famSet  = new Set<string>();
    for (const tree of this.familiaTree) {
      lineSet.add(tree.product_line);
      for (const fam of tree.familias) famSet.add(fam.family);
    }
    this.suprideLines    = Array.from(lineSet).sort();
    this.suprideFamilies = Array.from(famSet).sort();
  }

  private _buildCollectionRows(): void {
    const items   = this.shopifyMenuData?.items || [];
    const mapping = this.shopifyCollectionMapping;

    this.menuRows       = [];
    this.familiaRows    = [];
    this.subfamiliaRows = [];

    const hidden = mapping.hidden || {};
    for (const l1 of items) {
      const l1Id = l1.resourceId?.split('/').pop() || l1.title;
      this.menuRows.push({ collId: l1Id, title: l1.title, mappedItems: [...(mapping.menu[l1Id] || [])], availableOptions: [], hidden: !!hidden[l1Id] });

      for (const l2 of (l1.items || [])) {
        const l2Id = l2.resourceId?.split('/').pop() || l2.title;
        this.familiaRows.push({
          collId: l2Id, title: l2.title,
          parentCollId: l1Id, parentTitle: l1.title,
          mappedItems: [...(mapping.familia[l2Id] || [])], availableOptions: [],
          hidden: !!hidden[l2Id]
        });

        for (const l3 of (l2.items || [])) {
          const l3Id = l3.resourceId?.split('/').pop() || l3.title;
          this.subfamiliaRows.push({
            collId: l3Id, title: l3.title,
            parentCollId: l2Id, parentTitle: l2.title,
            parentL1CollId: l1Id, parentL1Title: l1.title,
            mappedItems: [...(mapping.subfamilia[l3Id] || [])], availableOptions: [],
            hidden: !!hidden[l3Id]
          });
        }
      }
    }

    // Build accordion groups (all expanded by default)
    this.familiaGroups = this.menuRows.map(l1 => ({
      l1CollId: l1.collId,
      l1Title:  l1.title,
      rows:     this.familiaRows.filter(r => r.parentCollId === l1.collId)
    })).filter(g => g.rows.length > 0);

    this.subfamiliaGroups = this.familiaRows.map(l2 => ({
      l2CollId: l2.collId,
      l2Title:  l2.title,
      l1Title:  l2.parentTitle || '',
      rows:     this.subfamiliaRows.filter(r => r.parentCollId === l2.collId)
    })).filter(g => g.rows.length > 0);

    this.expandedFamiliaGroups    = new Set();
    this.expandedSubfamiliaGroups = new Set();

    this._rebuildAvailableOptions();
    this._rebuildFiltered();
  }

  private _rebuildAvailableOptions(): void {
    this._rebuildTabOptions(this.menuRows,    this.suprideLines);
    this._rebuildTabOptions(this.familiaRows, this.suprideLines);
    this._rebuildSubfamiliaOptions();
  }

  private _rebuildTabOptions(rows: CollMapRow[], base: string[]): void {
    for (const row of rows) {
      const usedByOthers = new Set<string>();
      for (const other of rows) {
        if (other !== row) other.mappedItems.forEach(i => usedByOthers.add(i));
      }
      row.availableOptions = base.filter(o => !usedByOthers.has(o));
    }
  }

  private _subfamiliaBaseOptions(row: CollMapRow): string[] {
    // Families filtered by the product lines mapped to the parent L2 (or L1 as fallback)
    const parentL2  = this.familiaRows.find(r => r.collId === row.parentCollId);
    const parentL1  = this.menuRows.find(r => r.collId === row.parentL1CollId);
    const lines     = parentL2?.mappedItems?.length ? parentL2.mappedItems
                    : parentL1?.mappedItems?.length ? parentL1.mappedItems
                    : [];
    if (!lines.length) return this.suprideFamilies;
    const normLines = lines.map(l => SupridesMapeamentoDialog._norm(l));
    const result = new Set<string>();
    for (const tree of this.familiaTree) {
      if (normLines.includes(SupridesMapeamentoDialog._norm(tree.product_line))) {
        for (const fam of tree.familias) result.add(fam.family);
      }
    }
    return Array.from(result).sort();
  }

  private _rebuildSubfamiliaOptions(): void {
    for (const row of this.subfamiliaRows) {
      const base    = this._subfamiliaBaseOptions(row);
      const baseSet = new Set(base);
      const usedFromPool = new Set<string>();
      for (const other of this.subfamiliaRows) {
        if (other === row) continue;
        for (const item of other.mappedItems) {
          if (baseSet.has(item)) usedFromPool.add(item);
        }
      }
      row.availableOptions = base.filter(o => !usedFromPool.has(o));
    }
  }

  onMenuRowChange(row: CollMapRow, items: string[]): void {
    row.mappedItems = items;
    this._rebuildTabOptions(this.menuRows, this.suprideLines);
    this._rebuildSubfamiliaOptions();
    this._scheduleAutoSave();
  }

  onFamiliaRowChange(row: CollMapRow, items: string[]): void {
    row.mappedItems = items;
    this._rebuildTabOptions(this.familiaRows, this.suprideLines);
    this._rebuildSubfamiliaOptions();
    this._scheduleAutoSave();
  }

  onSubfamiliaRowChange(row: CollMapRow, items: string[]): void {
    row.mappedItems = items;
    this._rebuildSubfamiliaOptions();
    this._scheduleAutoSave();
  }

  private _buildMenuNodes(menu: ShopifyMenu): void {
    this.menuNodes = (menu.items || []).map((l1: any) => ({
      title:     l1.title,
      shopifyId: l1.resourceId?.split('/').pop(),
      children:  (l1.items || []).map((l2: any) => ({
        title:     l2.title,
        shopifyId: l2.resourceId?.split('/').pop(),
        children:  (l2.items || []).map((l3: any) => ({
          title:     l3.title,
          shopifyId: l3.resourceId?.split('/').pop(),
          children:  []
        }))
      }))
    }));
    this.menuLoaded = true;
  }

  // ── Accordion methods ──────────────────────────────────────────────────────────

  expandAllFamilias(): void    { this.expandedFamiliaGroups    = new Set(this.familiaGroups.map(g => g.l1CollId)); }
  collapseAllFamilias(): void  { this.expandedFamiliaGroups    = new Set(); }
  expandAllSubfamilias(): void  { this.expandedSubfamiliaGroups = new Set(this.subfamiliaGroups.map(g => g.l2CollId)); }
  collapseAllSubfamilias(): void { this.expandedSubfamiliaGroups = new Set(); }

  toggleFamiliaGroup(id: string): void {
    this.expandedFamiliaGroups.has(id)
      ? this.expandedFamiliaGroups.delete(id)
      : this.expandedFamiliaGroups.add(id);
    // Trigger CD: replace Set reference so Angular detects the change
    this.expandedFamiliaGroups = new Set(this.expandedFamiliaGroups);
  }

  toggleSubfamiliaGroup(id: string): void {
    this.expandedSubfamiliaGroups.has(id)
      ? this.expandedSubfamiliaGroups.delete(id)
      : this.expandedSubfamiliaGroups.add(id);
    this.expandedSubfamiliaGroups = new Set(this.expandedSubfamiliaGroups);
  }

  familiaGroupMappedCount(group: FamiliaGroup): number {
    return group.rows.filter(r => r.mappedItems.length > 0).length;
  }

  subfamiliaGroupMappedCount(group: SubfamiliaGroup): number {
    return group.rows.filter(r => r.mappedItems.length > 0).length;
  }

  // ── Save ───────────────────────────────────────────────────────────────────────

  private _collectMapping(): ShopifyCollectionMapping {
    const m: ShopifyCollectionMapping = {
      menu: {},
      familia: { ...this.shopifyCollectionMapping.familia },
      hidden: { ...(this.shopifyCollectionMapping.hidden || {}) },
      subfamilia: { ...this.shopifyCollectionMapping.subfamilia }
    };
    for (const r of this.menuRows) {
      if (r.mappedItems.length) m.menu[r.collId] = r.mappedItems;
      if (r.hidden) m.hidden![r.collId] = true;
      else delete m.hidden![r.collId];
    }
    for (const r of this.familiaRows) {
      if (r.mappedItems.length) m.familia[r.collId] = r.mappedItems;
      else delete m.familia[r.collId];
      if (r.hidden) m.hidden![r.collId] = true;
      else delete m.hidden![r.collId];
    }
    for (const r of this.subfamiliaRows) {
      if (r.mappedItems.length) m.subfamilia[r.collId] = r.mappedItems;
      else delete m.subfamilia[r.collId];
      if (r.hidden) m.hidden![r.collId] = true;
      else delete m.hidden![r.collId];
    }
    if (!Object.keys(m.hidden!).length) delete m.hidden;
    return m;
  }

  cascadeToast = '';
  private _toastTimer?: ReturnType<typeof setTimeout>;

  private _showCascadeToast(msg: string): void {
    this.cascadeToast = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.cascadeToast = '', 3000);
  }

  toggleActive(row: CollMapRow): void {
    row.hidden = !row.hidden;
    if (this.menuRows.includes(row)) this._cascadeMenuToggle(row);
    this._scheduleAutoSave();
  }

  private _cascadeMenuToggle(menuRow: CollMapRow): void {
    const hide = menuRow.hidden;
    let count = 0;

    for (const r of this.familiaRows) {
      if (r.parentCollId !== menuRow.collId) continue;
      if (!hide && r.mappedItems.length === 0) continue;
      r.hidden = hide;
      count++;
    }
    for (const r of this.subfamiliaRows) {
      if (r.parentL1CollId !== menuRow.collId) continue;
      if (!hide && r.mappedItems.length === 0) continue;
      r.hidden = hide;
      count++;
    }

    if (count > 0) {
      const acao = hide ? 'desativadas' : 'ativadas';
      this._showCascadeToast(`${count} família(s)/subfamília(s) ${acao} automaticamente`);
    }
  }

  activateAll(rows: CollMapRow[]): void   { rows.forEach(r => r.hidden = false); this._scheduleAutoSave(); }
  deactivateAll(rows: CollMapRow[]): void { rows.forEach(r => r.hidden = true);  this._scheduleAutoSave(); }

  // ── Auto-save ao servidor (debounced) ─────────────────────────────────────────

  private _autoSaveTimer?: ReturnType<typeof setTimeout>;
  autoSaving = false;
  hasDraft = false;

  private _scheduleAutoSave(): void {
    clearTimeout(this._autoSaveTimer);
    this.hasDraft = true;
    this._autoSaveTimer = setTimeout(() => this._autoSave(), 1500);
  }

  private _autoSave(): void {
    if (!this.menuRows.length) return;
    this.autoSaving = true;
    this.svc.saveShopifyCollectionMapping(this._collectMapping()).subscribe({
      next:  () => { this.autoSaving = false; this.hasDraft = false; },
      error: () => { this.autoSaving = false; }
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this._autoSaveTimer);
    clearTimeout(this._filterTimer);
    clearTimeout(this._toastTimer);
    // Flush imediato ao fechar apenas se existe uma alteração pendente.
    if (this.hasDraft && this.menuRows.length) {
      this.svc.saveShopifyCollectionMapping(this._collectMapping()).subscribe();
    }
  }

  // ── Contadores para o ecrã de revisão ─────────────────────────────────────────

  get activeMenuCount():       number { return this.menuRows.filter(r => !r.hidden).length; }
  get activeFamiliaCount():    number { return this.familiaRows.filter(r => !r.hidden).length; }
  get activeSubfamiliaCount(): number { return this.subfamiliaRows.filter(r => !r.hidden).length; }
  get totalNodeCount():        number { return this.menuNodes.reduce((s, l) => s + 1 + l.children.reduce((s2, f) => s2 + 1 + f.children.length, 0), 0); }

  private _isUsedElsewhere(item: string, currentRow: CollMapRow, allRows: CollMapRow[]): boolean {
    return allRows.some(r => r !== currentRow && r.mappedItems.includes(item));
  }

  onTryAdd(item: string, row: CollMapRow, allRows: CollMapRow[], onConfirmed: (r: CollMapRow, items: string[]) => void): void {
    const isDuplicate = this._isUsedElsewhere(item, row, allRows);
    if (isDuplicate) {
      const ok = window.confirm(`Quer realmente definir a mesma categoria "${item}" duas vezes?`);
      if (!ok) return;
    }
    if (!row.mappedItems.includes(item)) {
      onConfirmed(row, [...row.mappedItems, item]);
    }
  }

  save(): void {
    this.savingMapping = true;
    clearTimeout(this._autoSaveTimer);
    this.svc.saveShopifyCollectionMapping(this._collectMapping()).subscribe({
      next:  () => {
        this.savingMapping = false;
        this.hasDraft = false;
        this.mappingSaved = true;
        setTimeout(() => this.mappingSaved = false, 2500);
      },
      error: e  => { this.error = e.message || 'Erro ao guardar'; this.savingMapping = false; }
    });
  }

  // ── Review / Sync (produtos Suprides) ─────────────────────────────────────────

  startReview(): void {
    this.syncResult = null;
    this.error = '';
    this.reviewPhase = 'loading';
    clearTimeout(this._autoSaveTimer);
    this.svc.saveShopifyCollectionMapping(this._collectMapping()).subscribe({
      next: () => {
        this.hasDraft = false;
        this.svc.getSyncFamiliasAudit(0).subscribe({
          next: (audit) => {
            this.syncReviewProductCount = audit.review.productsToSync;
            this.syncReviewEligibleCount = audit.summary.proposedDerivedParents.eligibleProducts;
            this.syncReviewWithoutCollections = audit.summary.proposedDerivedParents.productsWithoutCollections;
            this.syncReviewLines = (audit.review.collections || []).map(c => ({
              collTitle: c.title,
              lines: [`${c.productCount} produto(s)`],
              familiaCount: 0,
              subfamiliaCount: 0,
              productCount: c.productCount,
              level: c.level
            }));
            this.reviewPhase = 'review';
          },
          error: (e) => { this.error = e.message || 'Erro ao preparar revisão'; this.reviewPhase = 'error'; }
        });
      },
      error: e => { this.error = e.message || 'Erro ao guardar antes da revisão'; this.reviewPhase = 'error'; }
    });
  }

  confirmAndSync(resume = false): void {
    this.reviewPhase  = 'loading';
    this.syncProgress = { running: true, total: 0, done: 0, errors: 0 };
    this.svc.saveShopifyCollectionMapping(this._collectMapping()).subscribe({
      next: () => {
        this._launchSync(resume);
      },
      error: e => { this.error = e.message; this.reviewPhase = 'error'; }
    });
  }

  resumeSync(): void {
    this.syncProgress = { running: true, total: 0, done: 0, errors: 0 };
    this._launchSync(true);
  }

  // O backend responde 202 e corre o sync em segundo plano; acompanha-se por /progress
  // e, quando termina, lê-se o resultado em /sync-familias/last-result.
  private _launchSync(resume: boolean): void {
    this.reviewPhase = 'progress';
    this.svc.startSyncFamilias(resume).subscribe({
      next: () => this._startProgressPolling(),
      error: (e) => {
        this.error = e?.status === 409 ? 'Já há uma sincronização em curso' : (e?.error?.error || e.message || 'Erro');
        this.reviewPhase = 'error';
      }
    });
  }

  private _startProgressPolling(): void {
    this._clearProgressPolling();
    let waitingResult = false;
    this.progressInterval = setInterval(() => {
      if (waitingResult) {
        this.svc.getLastSyncResult().subscribe(r => {
          if (!r?.finishedAt) return; // ainda a fechar
          this._clearProgressPolling();
          if (r.ok && r.result) { this.syncResult = r.result; this.reviewPhase = 'done'; }
          else { this.error = r.error || 'Erro no sync'; this.reviewPhase = 'error'; }
        });
        return;
      }
      this.svc.getSyncProgress().subscribe(p => {
        this.syncProgress = p;
        if (!p.running) waitingResult = true;
      });
    }, 1000);
  }

  private _clearProgressPolling(): void {
    if (this.progressInterval) { clearInterval(this.progressInterval); this.progressInterval = undefined; }
  }

  get progressPercent(): number {
    if (!this.syncProgress.total) return 0;
    return Math.round((this.syncProgress.done / this.syncProgress.total) * 100);
  }

  cancellingSync = false;

  cancelSync(): void {
    this.cancellingSync = true;
    this.svc.cancelSync().subscribe({
      next:  () => { this.cancellingSync = false; },
      error: () => { this.cancellingSync = false; }
    });
  }

  cancelReview(): void {
    this._clearProgressPolling();
    this.reviewPhase = 'idle';
  }

  onTabChange(index: number): void { this.activeTabIndex = index; }

  // ── Stats ──────────────────────────────────────────────────────────────────────

  get totalMappedCount(): number {
    return this.menuRows.filter(r => r.mappedItems.length).length
         + this.familiaRows.filter(r => r.mappedItems.length).length
         + this.subfamiliaRows.filter(r => r.mappedItems.length).length;
  }

  // ── Gerir Menu (Miller columns) ────────────────────────────────────────────────

  reloadMenu(): void {
    this.selectedLinha   = null;
    this.selectedFamilia = null;
    this.editingNode     = null;
    this.addingAt        = null;
    this.menuLoaded      = false;
    this.menuLoading     = true;
    this.menuError       = '';
    this.menuSyncResult  = null;
    this.svc.getShopifyMenu().subscribe({
      next:  (menu) => { this._buildMenuNodes(menu); this.menuLoading = false; },
      error: (e)    => { this.menuError = e.message || 'Erro ao carregar menu'; this.menuLoading = false; }
    });
  }

  selectLinha(node: MenuNode): void {
    if (this.editingNode) return;
    this.selectedLinha   = node;
    this.selectedFamilia = null;
    this.addingAt = null;
  }

  selectFamilia(node: MenuNode): void {
    if (this.editingNode) return;
    this.selectedFamilia = node;
    this.addingAt = null;
  }

  startEdit(node: MenuNode): void { this.editingNode = node; this.editingTitle = node.title; this.addingAt = null; }

  confirmEdit(): void {
    if (this.editingNode && this.editingTitle.trim()) this.editingNode.title = this.editingTitle.trim();
    this.editingNode = null;
    this.persistMenuDraft();
  }

  cancelEdit(): void { this.editingNode = null; }

  startAdd(level: 'linha' | 'familia' | 'subfamilia'): void {
    this.addingAt = level; this.newTitle = ''; this.editingNode = null;
  }

  confirmAdd(): void {
    const t = this.newTitle.trim();
    if (!t) { this.cancelAdd(); return; }
    if      (this.addingAt === 'linha'      )                         this.menuNodes.push({ title: t, children: [] });
    else if (this.addingAt === 'familia'    && this.selectedLinha   ) this.selectedLinha.children.push({ title: t, children: [] });
    else if (this.addingAt === 'subfamilia' && this.selectedFamilia ) this.selectedFamilia.children.push({ title: t, children: [] });
    this.cancelAdd();
    this.persistMenuDraft();
  }

  cancelAdd(): void { this.addingAt = null; this.newTitle = ''; }

  removeLinha(node: MenuNode): void {
    this.menuNodes = this.menuNodes.filter(n => n !== node);
    if (this.selectedLinha === node) { this.selectedLinha = null; this.selectedFamilia = null; }
    this.persistMenuDraft();
  }

  removeFamilia(node: MenuNode): void {
    if (!this.selectedLinha) return;
    this.selectedLinha.children = this.selectedLinha.children.filter(n => n !== node);
    if (this.selectedFamilia === node) this.selectedFamilia = null;
    this.persistMenuDraft();
  }

  removeSubfamilia(node: MenuNode): void {
    if (!this.selectedFamilia) return;
    this.selectedFamilia.children = this.selectedFamilia.children.filter(n => n !== node);
    this.persistMenuDraft();
  }

  dropLinha(event: CdkDragDrop<MenuNode[]>): void {
    moveItemInArray(this.menuNodes, event.previousIndex, event.currentIndex);
    this.persistMenuDraft();
  }

  dropFamilia(event: CdkDragDrop<MenuNode[]>): void {
    if (!this.selectedLinha) return;
    moveItemInArray(this.selectedLinha.children, event.previousIndex, event.currentIndex);
    this.persistMenuDraft();
  }

  dropSubfamilia(event: CdkDragDrop<MenuNode[]>): void {
    if (!this.selectedFamilia) return;
    moveItemInArray(this.selectedFamilia.children, event.previousIndex, event.currentIndex);
    this.persistMenuDraft();
  }

  openSyncReview(): void {
    this.menuReviewing = true;
    this.menuError = '';
  }

  cancelSyncReview(): void {
    this.menuReviewing = false;
  }

  resolveMenuIds(): void {
    this.menuResolvingIds = true;
    this.menuResolveResult = null;
    this.svc.resolveMenuIds().subscribe({
      next: (res) => {
        this.menuResolvingIds = false;
        this.menuResolveResult = res;
        // Reload menu so dialog shows the updated shopifyIds
        if (res.resolved > 0) {
          this.svc.getShopifyMenu().subscribe({
            next: (menu) => {
              if (menu) this._buildMenuNodes(menu as any);
            }
          });
        }
      },
      error: (e) => { this.menuError = e.message || 'Erro ao resolver IDs'; this.menuResolvingIds = false; }
    });
  }

  confirmSync(): void {
    this.menuReviewing  = false;
    this.menuSyncing    = true;
    this.menuSyncResult = null;
    this.menuSyncTotal  = 0;
    this.menuSyncDone   = 0;
    this.menuSyncPhase  = 'A iniciar…';
    const nodes = this.collectMenuNodes();
    this.svc.syncShopifyMenu(nodes).subscribe({
      next: (evt) => {
        if (evt.type === 'start') {
          this.menuSyncTotal = evt.total ?? 0;
          this.menuSyncPhase = 'A verificar coleções…';
        } else if (evt.type === 'progress') {
          this.menuSyncDone  = evt.done  ?? this.menuSyncDone;
          this.menuSyncTotal = evt.total ?? this.menuSyncTotal;
          this.menuSyncPhase = evt.phase === 'menu-update'
            ? 'A enviar menu ao Shopify…'
            : 'A verificar coleções…';
        } else if (evt.type === 'done') {
          this.menuSyncing    = false;
          this.menuSyncPhase  = '';
          this.menuSyncResult = { created: evt.created ?? 0, renamed: evt.renamed ?? 0, deleted: 0, errors: evt.errors ?? [] };
        } else if (evt.type === 'error') {
          this.menuError   = evt.message || 'Erro ao sincronizar menu';
          this.menuSyncing = false;
          this.menuSyncPhase = '';
        }
      },
      error: (e) => { this.menuError = e.message || 'Erro ao sincronizar menu'; this.menuSyncing = false; this.menuSyncPhase = ''; }
    });
  }

  get menuSyncPercent(): number {
    if (!this.menuSyncTotal) return 0;
    return Math.min(100, Math.round((this.menuSyncDone / this.menuSyncTotal) * 100));
  }

  private collectMenuNodes(): MenuSyncNode[] {
    return this.menuNodes.map(l1 => ({
      title: l1.title, shopifyId: l1.shopifyId,
      children: l1.children.map(l2 => ({
        title: l2.title, shopifyId: l2.shopifyId,
        children: l2.children.map(l3 => ({ title: l3.title, shopifyId: l3.shopifyId, children: [] }))
      }))
    }));
  }

  private persistMenuDraft(): void {
    this.menuSaving = true;
    this.menuError = '';
    this.svc.saveShopifyMenu(this.collectMenuNodes()).subscribe({
      next: () => { this.menuSaving = false; },
      error: (e) => {
        this.menuSaving = false;
        this.menuError = e.message || 'Erro ao guardar menu local';
      }
    });
  }

  // ── Misc ───────────────────────────────────────────────────────────────────────

  closeDialog(): void { this.dialogRef.close(); }

  refreshCache(): void {
    this.loading = true;
    const request = this.isEsprinet ? this.svc.getFamilias(true) : this.svc.refreshFamiliasCache();
    request.subscribe({
      next: (familias) => {
        this.familiaTree = familias;
        this._buildSupridesData();
        this._buildCollectionRows();
        this.loading = false;
      },
      error: e => { this.error = e.message; this.loading = false; }
    });
  }
}
