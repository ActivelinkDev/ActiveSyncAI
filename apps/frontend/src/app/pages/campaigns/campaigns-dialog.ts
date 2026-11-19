import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  CampaignsService, apiError,
  type CampaignSummary, type CampaignDetail, type CampaignStatus, type CampaignsStatus, type DiscountType,
  type Discount, type FilterOptions, type ProductInfo, type ValidRange, type PreviewItem,
} from '../../services/campaigns.service';

/** Produto no editor: o que se grava (sku + exceção) e o que se mostra (previsão ou valores fixados). */
interface Item {
  sku: string;
  override: Discount | null;
  product: ProductInfo | null;
  state: 'INCLUIDO' | 'BLOQUEADO' | 'RETIRADO' | null;   // null = ainda sem previsão
  reason: string | null; warning: string | null;
  base: number | null; reference: number | null; promo: number | null;
  range: ValidRange | null;
  applied: boolean;
  editing: boolean; editType: DiscountType; editValue: number | null;
}

interface Form { name: string; notes: string; discountType: DiscountType; discountValue: number | null; startsAt: string; endsAt: string }

const STATUS_LABEL: Record<CampaignStatus, string> = {
  RASCUNHO: 'Rascunho', AGENDADA: 'Agendada', ATIVA: 'Ativa', TERMINADA: 'Terminada', CANCELADA: 'Cancelada',
};
const REASON_LABEL: Record<string, string> = {
  SEM_PRECO: 'Sem preço gerido ou fora da loja',
  SEM_DESCONTO: 'Não fica abaixo do mais baixo dos 30 dias',
  PREJUIZO: 'Prejuízo (abaixo de custo + IVA)',
};
const WARNING_LABEL: Record<string, string> = { HISTORICO_CURTO: 'Menos de 30 dias de histórico de preço' };
const ROW_PAGE = 300;

/** 'YYYY-MM-DDTHH:mm' na hora local (input datetime-local) ⇄ ISO UTC. */
function toLocalInput(iso: string): string {
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  const d = new Date(v);
  return v && !isNaN(d.getTime()) ? d.toISOString() : null;
}

@Component({
  selector: 'app-campaigns-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatIconModule, MatTooltipModule, MatProgressBarModule],
  templateUrl: './campaigns-dialog.html',
  styleUrls: ['./campaigns-dialog.scss'],
})
export class CampaignsDialog implements OnInit, OnDestroy {
  private svc = inject(CampaignsService);
  private dialogRef = inject(MatDialogRef<CampaignsDialog>);

  readonly statusLabel = STATUS_LABEL;
  readonly reasonLabel = REASON_LABEL;
  readonly warningLabel = WARNING_LABEL;

  status: CampaignsStatus | null = null;
  campaigns: CampaignSummary[] = [];
  showList = true;
  listLoading = false;

  // Editor
  editorOpen = false;
  campaign: CampaignDetail | null = null;    // null = campanha nova (por gravar)
  form: Form = this.emptyForm();
  items: Item[] = [];
  dirty = false;
  loading = false;
  busy = false;
  previewing = false;
  error = '';
  info = '';

  // Tabela
  rowFilter = '';
  stateFilter: '' | 'INCLUIDO' | 'BLOQUEADO' | 'RETIRADO' | 'AVISO' = '';
  rowLimit = ROW_PAGE;

  // Acrescentar produtos
  addMode: 'filters' | 'paste' = 'filters';
  options: FilterOptions | null = null;
  sel = this.emptySelection();
  pasted = '';
  found: ProductInfo[] = [];
  foundTruncated = false;
  searched = false;

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewSeq = 0;

  ngOnInit(): void {
    void this.loadList();
    this.svc.status().then(s => (this.status = s)).catch(() => {});
    this.svc.filters().then(o => (this.options = o)).catch(e => (this.error = apiError(e)));
  }

  ngOnDestroy(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
  }

  // ── Lista ──────────────────────────────────────────────────────────────────

  async loadList(): Promise<void> {
    this.listLoading = true;
    try { this.campaigns = await this.svc.list(); }
    catch (e) { this.error = apiError(e); }
    finally { this.listLoading = false; }
  }

  private confirmLeave(): boolean {
    return !this.dirty || confirm('Há alterações por gravar. Descartar?');
  }

  newCampaign(): void {
    if (!this.confirmLeave()) return;
    this.campaign = null;
    this.form = this.emptyForm();
    this.items = [];
    this.resetEditorUi();
    this.editorOpen = true;
  }

  async open(id: number): Promise<void> {
    if (this.campaign?.id === id && this.editorOpen) return;
    if (!this.confirmLeave()) return;
    this.resetEditorUi();
    this.editorOpen = true;
    await this.load(id);
  }

  private resetEditorUi(): void {
    this.dirty = false;
    this.error = '';
    this.info = '';
    this.rowFilter = '';
    this.stateFilter = '';
    this.rowLimit = ROW_PAGE;
    this.found = [];
    this.searched = false;
    this.pasted = '';
  }

  // ── Editor ─────────────────────────────────────────────────────────────────

  get isDraft(): boolean { return !this.campaign || this.campaign.status === 'RASCUNHO'; }
  /** Valores já fixados (a campanha começou). */
  get fixedValues(): boolean { return !!this.campaign?.startedAt; }
  get overridesEditable(): boolean { return this.isDraft || this.campaign?.status === 'AGENDADA'; }

  private async load(id: number): Promise<void> {
    this.loading = true;
    this.error = '';
    try {
      const c = await this.svc.get(id);
      this.campaign = c;
      this.form = {
        name: c.name, notes: c.notes ?? '', discountType: c.discountType, discountValue: c.discountValue,
        startsAt: toLocalInput(c.startsAt), endsAt: toLocalInput(c.endsAt),
      };
      this.items = c.products.map(p => this.item(p.sku, p.override, p.product, c.startedAt ? {
        state: p.state, reason: p.blockReason ?? p.removedReason, warning: p.warning,
        base: p.basePrice, reference: p.referencePrice, promo: p.promoPrice, range: null,
        applied: !!p.appliedAt && !p.revertedAt,
      } : null));
      this.dirty = false;
      if (!c.startedAt) await this.refreshPreview();
    } catch (e) {
      this.error = apiError(e);
    } finally {
      this.loading = false;
    }
  }

  private item(sku: string, override: Discount | null, product: ProductInfo | null,
                v: Pick<Item, 'state' | 'reason' | 'warning' | 'base' | 'reference' | 'promo' | 'range' | 'applied'> | null): Item {
    return {
      sku, override, product,
      state: v?.state ?? null, reason: v?.reason ?? null, warning: v?.warning ?? null,
      base: v?.base ?? product?.basePrice ?? null, reference: v?.reference ?? null, promo: v?.promo ?? null,
      range: v?.range ?? null, applied: v?.applied ?? false,
      editing: false, editType: override?.type ?? 'PERCENT', editValue: override?.value ?? null,
    };
  }

  /** Qualquer mudança no rascunho: marca por gravar e atualiza a previsão (com pausa de 400 ms). */
  changed(): void {
    if (!this.isDraft) return;
    this.dirty = true;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 400);
  }

  private async refreshPreview(): Promise<void> {
    if (this.fixedValues || !this.items.length) return;
    const startsAt = fromLocalInput(this.form.startsAt);
    const value = Number(this.form.discountValue);
    if (!startsAt || !(value > 0)) return;
    const seq = ++this.previewSeq;
    this.previewing = true;
    try {
      const preview = await this.svc.previewDraft(
        { discountType: this.form.discountType, discountValue: value, startsAt },
        this.items.map(i => ({ sku: i.sku, override: i.override })));
      if (seq !== this.previewSeq) return;     // chegou uma previsão mais recente
      const bySku = new Map<string, PreviewItem>(preview.map(p => [p.sku, p]));
      for (const it of this.items) {
        const p = bySku.get(it.sku);
        if (!p) continue;
        Object.assign(it, {
          state: p.state, reason: p.blockReason, warning: p.warning, base: p.base,
          reference: p.reference, promo: p.promo, range: p.range, product: p.product ?? it.product,
        });
      }
    } catch (e) {
      if (seq === this.previewSeq) this.error = apiError(e);
    } finally {
      if (seq === this.previewSeq) this.previewing = false;
    }
  }

  setDiscountType(t: DiscountType): void {
    if (!this.isDraft || this.form.discountType === t) return;
    this.form.discountType = t;
    this.changed();
  }

  private formInput() {
    const startsAt = fromLocalInput(this.form.startsAt), endsAt = fromLocalInput(this.form.endsAt);
    if (!this.form.name.trim()) throw new Error('Falta o nome.');
    if (!this.form.discountValue || this.form.discountValue <= 0) throw new Error('O desconto tem de ser maior que zero.');
    if (this.form.discountType === 'PERCENT' && this.form.discountValue >= 100) throw new Error('O desconto em % tem de ser menor que 100.');
    if (!startsAt || !endsAt) throw new Error('Faltam as datas de início e fim.');
    if (endsAt <= startsAt) throw new Error('O fim tem de ser depois do início.');
    return {
      name: this.form.name.trim(), discountType: this.form.discountType, discountValue: Number(this.form.discountValue),
      startsAt, endsAt, notes: this.form.notes.trim() || null,
    };
  }

  /** Grava dados + produtos + exceções. Devolve o id. */
  private async persist(): Promise<number> {
    const input = this.formInput();
    let id = this.campaign?.id;
    if (id == null) id = (await this.svc.create(input)).id;
    else await this.svc.update(id, input);
    const r = await this.svc.saveItems(id, this.items.map(i => ({ sku: i.sku, override: i.override })));
    if (r.unknown.length) this.info = `Referências desconhecidas não gravadas: ${r.unknown.slice(0, 10).join(', ')}`;
    return id;
  }

  async saveDraft(): Promise<void> {
    await this.act(async () => {
      const id = await this.persist();
      await this.load(id);
      await this.loadList();
      this.info ||= 'Rascunho gravado.';
    });
  }

  async discard(): Promise<void> {
    if (this.dirty && !confirm('Descartar as alterações por gravar?')) return;
    if (this.campaign) {
      this.resetEditorUi();
      await this.load(this.campaign.id);
    } else {
      this.editorOpen = false;
      this.dirty = false;
      this.items = [];
    }
  }

  async schedule(): Promise<void> {
    const n = this.counts;
    if (!n.INCLUIDO) { this.error = 'Nenhum produto entra na promoção.'; return; }
    const startsAt = fromLocalInput(this.form.startsAt);
    const valid = this.status?.validFrom ? new Date(this.status.validFrom) : null;
    const early = valid && startsAt && new Date(startsAt) < valid
      ? `\n\nComeça antes de ${valid.toLocaleDateString('pt-PT')}: a referência usa o histórico que existe (menos de 30 dias).` : '';
    if (!confirm(`Agendar "${this.form.name}"?\n\n${n.INCLUIDO} produto(s) em promoção, ${n.BLOQUEADO} bloqueado(s).\n` +
      `No arranque os valores são recalculados e enviados para a loja.${early}`)) return;
    await this.act(async () => {
      const id = this.dirty || !this.campaign ? await this.persist() : this.campaign.id;
      await this.svc.schedule(id);
      await this.load(id);
      await this.loadList();
      this.info = 'Campanha agendada.';
    });
  }

  async unschedule(): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    await this.act(async () => { await this.svc.unschedule(c.id); await this.load(c.id); await this.loadList(); this.info = 'Voltou a rascunho.'; });
  }

  async cancel(): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    const msg = c.status === 'ATIVA'
      ? `Cancelar "${c.name}"? Os preços normais voltam à loja dentro de um minuto.`
      : `Cancelar "${c.name}"?`;
    if (!confirm(msg)) return;
    await this.act(async () => { await this.svc.cancel(c.id); await this.load(c.id); await this.loadList(); this.info = 'Campanha cancelada.'; });
  }

  async remove(): Promise<void> {
    const c = this.campaign;
    if (!c || !confirm(`Apagar o rascunho "${c.name}"?`)) return;
    await this.act(async () => {
      await this.svc.remove(c.id);
      this.campaign = null;
      this.editorOpen = false;
      this.dirty = false;
      await this.loadList();
    });
  }

  // ── Produtos ───────────────────────────────────────────────────────────────

  get counts() {
    const c = { INCLUIDO: 0, BLOQUEADO: 0, RETIRADO: 0, AVISO: 0 };
    for (const r of this.items) { if (r.state) c[r.state]++; if (r.warning) c.AVISO++; }
    return c;
  }

  get visibleItems(): Item[] {
    const t = this.rowFilter.trim().toLowerCase();
    return this.items.filter(r =>
      (!this.stateFilter || (this.stateFilter === 'AVISO' ? !!r.warning : r.state === this.stateFilter)) &&
      (!t || r.sku.toLowerCase().includes(t) || (r.product?.name ?? '').toLowerCase().includes(t)
        || (r.product?.brand ?? '').toLowerCase().includes(t)));
  }

  async search(): Promise<void> {
    await this.act(async () => {
      const r = await this.svc.select({
        brand: this.sel.brand, productLine: this.sel.productLine, family: this.sel.family, subFamily: this.sel.subFamily,
        stockStatus: this.sel.stockStatus, text: this.sel.text, onlyManaged: this.sel.onlyInShop,
      });
      this.found = r.products;
      this.foundTruncated = r.truncated;
      this.searched = true;
    });
  }

  clearFilters(): void {
    this.sel = this.emptySelection();
    this.found = [];
    this.searched = false;
  }

  get newFound(): ProductInfo[] {
    const have = new Set(this.items.map(r => r.sku));
    return this.found.filter(p => !have.has(p.sku));
  }

  addFound(): void {
    this.addProducts(this.newFound);
    this.found = [];
    this.searched = false;
  }

  async addPasted(): Promise<void> {
    const skus = [...new Set(this.pasted.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
    if (!skus.length) return;
    await this.act(async () => {
      const r = await this.svc.select({ skus: skus.join('\n'), onlyManaged: false });
      const known = new Set(r.products.map(p => p.sku));
      this.addProducts(r.products);
      const unknown = skus.filter(s => !known.has(s));
      this.info = `${r.products.length} referência(s) acrescentada(s).` + (unknown.length ? ` Desconhecidas: ${unknown.slice(0, 10).join(', ')}` : '');
      this.pasted = '';
    });
  }

  private addProducts(products: ProductInfo[]): void {
    const have = new Set(this.items.map(r => r.sku));
    const add = products.filter(p => !have.has(p.sku)).map(p => this.item(p.sku, null, p, null));
    if (!add.length) return;
    this.items = [...this.items, ...add];
    this.changed();
  }

  removeItem(it: Item): void {
    this.items = this.items.filter(r => r !== it);
    this.changed();
  }

  removeBlocked(): void {
    const n = this.items.filter(r => r.state === 'BLOQUEADO').length;
    if (!n || !confirm(`Retirar os ${n} produto(s) bloqueado(s)?`)) return;
    this.items = this.items.filter(r => r.state !== 'BLOQUEADO');
    this.changed();
  }

  editOverride(it: Item): void {
    it.editing = true;
    it.editType = it.override?.type ?? this.form.discountType;
    it.editValue = it.override?.value ?? null;
  }

  async applyOverride(it: Item, clear = false): Promise<void> {
    const override: Discount | null = clear || !it.editValue ? null : { type: it.editType, value: Number(it.editValue) };
    if (this.isDraft) {
      it.override = override;
      it.editing = false;
      this.changed();
      return;
    }
    // Agendada: grava logo (já não há rascunho por gravar).
    const c = this.campaign!;
    await this.act(async () => { await this.svc.setOverride(c.id, it.sku, override); await this.load(c.id); });
  }

  // ── Formatação ─────────────────────────────────────────────────────────────

  rangeText(r: ValidRange | null): string {
    if (!r) return 'Sem promoção possível';
    return `${this.pct(r.minPercent)}–${this.pct(r.maxPercent)} · ${this.eur(r.minAmount)}–${this.eur(r.maxAmount)}`;
  }
  discountText(t: DiscountType, v: number | null | undefined): string {
    if (v == null) return '—';
    return t === 'PERCENT' ? `-${this.pct(v)}` : `-${this.eur(v)}`;
  }
  pct(v: number): string { return `${v.toLocaleString('pt-PT', { maximumFractionDigits: 2 })} %`; }
  eur(v: number | null | undefined): string {
    return v == null ? '—' : v.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
  }
  date(iso: string | null | undefined): string {
    return iso ? new Date(iso).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }
  get previewAt(): string {
    const s = fromLocalInput(this.form.startsAt);
    return s ? this.date(new Date(Math.max(Date.parse(s), Date.now())).toISOString()) : '—';
  }

  close(): void {
    if (!this.confirmLeave()) return;
    this.dialogRef.close();
  }

  private emptyForm(): Form {
    const start = new Date(Date.now() + 86_400_000); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 3 * 86_400_000); end.setHours(23, 59, 0, 0);
    return { name: '', notes: '', discountType: 'PERCENT', discountValue: null, startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(end.toISOString()) };
  }

  private emptySelection() {
    return { productLine: '', family: '', subFamily: '', brand: '', stockStatus: '', text: '', onlyInShop: true };
  }

  /** Corre uma ação com indicador de ocupado e mensagem de erro. */
  private async act(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = '';
    this.info = '';
    try { await fn(); }
    catch (e) { this.error = apiError(e); }
    finally { this.busy = false; }
  }
}
