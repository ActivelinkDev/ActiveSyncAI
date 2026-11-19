import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  CampaignsService, apiError,
  type CampaignSummary, type CampaignDetail, type CampaignStatus, type CampaignsStatus, type DiscountType,
  type Discount, type FilterOptions, type ProductInfo, type ValidRange,
} from '../../services/campaigns.service';

/** Linha da tabela de produtos (pré-visualização em rascunho/agendada; valores fixados depois do início). */
interface Row {
  sku: string; name: string; brand: string;
  state: 'INCLUIDO' | 'BLOQUEADO' | 'RETIRADO';
  reason: string | null; warning: string | null;
  base: number | null; reference: number | null; promo: number | null;
  range: ValidRange | null;
  override: Discount | null;
  /** Edição da exceção. */
  editType: DiscountType; editValue: number | null; editing: boolean;
  applied: boolean;
}

interface Form { name: string; discountType: DiscountType; discountValue: number | null; startsAt: string; endsAt: string; notes: string }

const STATUS_LABEL: Record<CampaignStatus, string> = {
  RASCUNHO: 'Rascunho', AGENDADA: 'Agendada', ATIVA: 'Ativa', TERMINADA: 'Terminada', CANCELADA: 'Cancelada',
};
const REASON_LABEL: Record<string, string> = {
  SEM_PRECO: 'Sem preço gerido / fora da loja',
  SEM_DESCONTO: 'Não fica abaixo do preço mais baixo dos 30 dias',
  PREJUIZO: 'Venda com prejuízo (abaixo de custo + IVA)',
};
const WARNING_LABEL: Record<string, string> = {
  HISTORICO_CURTO: 'Menos de 30 dias de histórico de preço',
};
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
  imports: [
    CommonModule, FormsModule, MatButtonModule, MatIconModule, MatSelectModule,
    MatTooltipModule, MatProgressBarModule, MatCheckboxModule,
  ],
  templateUrl: './campaigns-dialog.html',
  styleUrls: ['./campaigns-dialog.scss'],
})
export class CampaignsDialog implements OnInit {
  private svc = inject(CampaignsService);
  private dialogRef = inject(MatDialogRef<CampaignsDialog>);

  readonly statusLabel = STATUS_LABEL;
  readonly reasonLabel = REASON_LABEL;
  readonly warningLabel = WARNING_LABEL;

  view: 'list' | 'detail' = 'list';
  loading = false;
  busy = false;
  error = '';
  info = '';

  status: CampaignsStatus | null = null;
  campaigns: CampaignSummary[] = [];

  // Detalhe
  campaign: CampaignDetail | null = null;   // null = campanha nova
  form: Form = this.emptyForm();
  rows: Row[] = [];
  rowFilter = '';
  stateFilter: '' | 'INCLUIDO' | 'BLOQUEADO' | 'RETIRADO' | 'AVISO' = '';
  rowLimit = ROW_PAGE;

  // Seleção de produtos
  showSelection = false;
  options: FilterOptions | null = null;
  sel = { brand: '', productLine: '', family: '', stockStatus: '', text: '', skus: '', onlyManaged: true };
  found: ProductInfo[] = [];
  foundTruncated = false;
  searched = false;

  ngOnInit(): void {
    void this.loadList();
    this.svc.status().then(s => (this.status = s)).catch(() => { /* aviso fica por mostrar */ });
  }

  // ── Lista ──────────────────────────────────────────────────────────────────

  async loadList(): Promise<void> {
    this.view = 'list';
    this.campaign = null;
    await this.run(async () => { this.campaigns = await this.svc.list(); }, true);
  }

  newCampaign(): void {
    this.campaign = null;
    this.form = this.emptyForm();
    this.rows = [];
    this.showSelection = false;
    this.info = '';
    this.error = '';
    this.view = 'detail';
  }

  async open(id: number): Promise<void> {
    this.info = '';
    this.error = '';
    this.showSelection = false;
    this.view = 'detail';
    await this.reload(id);
  }

  // ── Detalhe ────────────────────────────────────────────────────────────────

  get editable(): boolean { return !this.campaign || this.campaign.status === 'RASCUNHO'; }
  get overridesEditable(): boolean { return !!this.campaign && (this.campaign.status === 'RASCUNHO' || this.campaign.status === 'AGENDADA'); }
  get fixedValues(): boolean { return !!this.campaign && ['ATIVA', 'TERMINADA', 'CANCELADA'].includes(this.campaign.status) && !!this.campaign.startedAt; }

  private async reload(id: number): Promise<void> {
    await this.run(async () => {
      const c = await this.svc.get(id);
      this.campaign = c;
      this.form = {
        name: c.name, discountType: c.discountType, discountValue: c.discountValue,
        startsAt: toLocalInput(c.startsAt), endsAt: toLocalInput(c.endsAt), notes: c.notes ?? '',
      };
      if (c.status === 'RASCUNHO' || c.status === 'AGENDADA' || !c.startedAt) {
        const preview = c.products.length ? await this.svc.preview(id) : [];
        this.rows = preview.map(p => this.row({
          sku: p.sku, product: p.product, state: p.state, reason: p.blockReason, warning: p.warning,
          base: p.base, reference: p.reference, promo: p.promo, range: p.range, override: p.override, applied: false,
        }));
      } else {
        this.rows = c.products.map(p => this.row({
          sku: p.sku, product: p.product, state: p.state, reason: p.blockReason ?? p.removedReason, warning: p.warning,
          base: p.basePrice, reference: p.referencePrice, promo: p.promoPrice, range: null, override: p.override,
          applied: !!p.appliedAt && !p.revertedAt,
        }));
      }
      this.rowLimit = ROW_PAGE;
    }, true);
  }

  private row(r: {
    sku: string; product: ProductInfo | null; state: Row['state']; reason: string | null; warning: string | null;
    base: number | null; reference: number | null; promo: number | null; range: ValidRange | null;
    override: Discount | null; applied: boolean;
  }): Row {
    return {
      sku: r.sku, name: r.product?.name ?? '—', brand: r.product?.brand ?? '',
      state: r.state, reason: r.reason, warning: r.warning,
      base: r.base, reference: r.reference, promo: r.promo, range: r.range, override: r.override,
      editType: r.override?.type ?? this.form.discountType, editValue: r.override?.value ?? null, editing: false,
      applied: r.applied,
    };
  }

  get counts() {
    const c = { INCLUIDO: 0, BLOQUEADO: 0, RETIRADO: 0, AVISO: 0 };
    for (const r of this.rows) { c[r.state]++; if (r.warning) c.AVISO++; }
    return c;
  }

  get visibleRows(): Row[] {
    const t = this.rowFilter.trim().toLowerCase();
    return this.rows.filter(r =>
      (!this.stateFilter || (this.stateFilter === 'AVISO' ? !!r.warning : r.state === this.stateFilter)) &&
      (!t || r.sku.toLowerCase().includes(t) || r.name.toLowerCase().includes(t) || r.brand.toLowerCase().includes(t)));
  }

  private formInput() {
    const startsAt = fromLocalInput(this.form.startsAt), endsAt = fromLocalInput(this.form.endsAt);
    if (!this.form.name.trim()) throw new Error('Falta o nome.');
    if (!this.form.discountValue || this.form.discountValue <= 0) throw new Error('O desconto tem de ser maior que zero.');
    if (!startsAt || !endsAt) throw new Error('Faltam as datas de início e fim.');
    if (endsAt <= startsAt) throw new Error('O fim tem de ser depois do início.');
    return {
      name: this.form.name.trim(), discountType: this.form.discountType, discountValue: Number(this.form.discountValue),
      startsAt, endsAt, notes: this.form.notes.trim() || null,
    };
  }

  async save(): Promise<void> {
    await this.run(async () => {
      const input = this.formInput();
      if (!this.campaign) {
        const { id } = await this.svc.create(input);
        await this.reload(id);
        this.info = 'Campanha criada. Acrescenta os produtos.';
        this.showSelection = true;
        void this.loadOptions();
      } else {
        await this.svc.update(this.campaign.id, input);
        await this.reload(this.campaign.id);
        this.info = 'Guardado.';
      }
    });
  }

  async schedule(): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    const n = this.counts;
    const valid = this.status?.validFrom ? new Date(this.status.validFrom) : null;
    const early = valid && new Date(c.startsAt) < valid
      ? `\n\nATENÇÃO: começa antes de ${valid.toLocaleDateString('pt-PT')} — ainda não há 30 dias de histórico de preços.` : '';
    if (!confirm(`Agendar "${c.name}"?\n\n${n.INCLUIDO} produto(s) em promoção, ${n.BLOQUEADO} bloqueado(s).\n` +
      `No início, os valores são recalculados e enviados para a loja.${early}`)) return;
    await this.run(async () => { await this.svc.schedule(c.id); await this.reload(c.id); this.info = 'Campanha agendada.'; });
  }

  async unschedule(): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    await this.run(async () => { await this.svc.unschedule(c.id); await this.reload(c.id); this.info = 'Voltou a rascunho.'; });
  }

  async cancel(): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    const msg = c.status === 'ATIVA'
      ? `Cancelar "${c.name}"? Os preços base são repostos na loja dentro de um minuto.`
      : `Cancelar "${c.name}"?`;
    if (!confirm(msg)) return;
    await this.run(async () => { await this.svc.cancel(c.id); await this.reload(c.id); this.info = 'Campanha cancelada.'; });
  }

  async remove(): Promise<void> {
    const c = this.campaign;
    if (!c || !confirm(`Apagar o rascunho "${c.name}"?`)) return;
    await this.run(async () => { await this.svc.remove(c.id); await this.loadList(); });
  }

  // ── Produtos ───────────────────────────────────────────────────────────────

  toggleSelection(): void {
    this.showSelection = !this.showSelection;
    if (this.showSelection) void this.loadOptions();
  }

  private async loadOptions(): Promise<void> {
    if (this.options) return;
    try { this.options = await this.svc.filters(); } catch (e) { this.error = apiError(e); }
  }

  async search(): Promise<void> {
    await this.run(async () => {
      const r = await this.svc.select({ ...this.sel });
      this.found = r.products;
      this.foundTruncated = r.truncated;
      this.searched = true;
    });
  }

  get newFound(): ProductInfo[] {
    const have = new Set(this.rows.map(r => r.sku));
    return this.found.filter(p => !have.has(p.sku));
  }

  async addFound(): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    const skus = [...this.rows.map(r => r.sku), ...this.newFound.map(p => p.sku)];
    await this.run(async () => {
      const r = await this.svc.setProducts(c.id, skus);
      await this.reload(c.id);
      this.found = [];
      this.searched = false;
      this.info = `${r.count} produto(s) na campanha.` + (r.unknown.length ? ` Desconhecidos: ${r.unknown.slice(0, 10).join(', ')}` : '');
    });
  }

  async removeRow(row: Row): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    await this.run(async () => {
      await this.svc.setProducts(c.id, this.rows.filter(r => r !== row).map(r => r.sku));
      await this.reload(c.id);
    });
  }

  async removeVisibleBlocked(): Promise<void> {
    const c = this.campaign;
    const blocked = new Set(this.rows.filter(r => r.state === 'BLOQUEADO').map(r => r.sku));
    if (!c || !blocked.size || !confirm(`Retirar da campanha os ${blocked.size} produto(s) bloqueado(s)?`)) return;
    await this.run(async () => {
      await this.svc.setProducts(c.id, this.rows.filter(r => !blocked.has(r.sku)).map(r => r.sku));
      await this.reload(c.id);
    });
  }

  editOverride(row: Row): void {
    row.editing = true;
    row.editType = row.override?.type ?? this.form.discountType;
    row.editValue = row.override?.value ?? null;
  }

  async saveOverride(row: Row, clear = false): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    const override: Discount | null = clear || !row.editValue ? null : { type: row.editType, value: Number(row.editValue) };
    await this.run(async () => { await this.svc.setOverride(c.id, row.sku, override); await this.reload(c.id); });
  }

  rangeText(r: ValidRange | null): string {
    if (!r) return 'Sem promoção possível';
    return `${r.minPercent.toFixed(2)}–${r.maxPercent.toFixed(2)} % · ${this.eur(r.minAmount)}–${this.eur(r.maxAmount)}`;
  }

  discountText(d: { type: DiscountType; value: number } | null): string {
    if (!d) return '';
    return d.type === 'PERCENT' ? `${d.value} %` : this.eur(d.value);
  }

  eur(v: number | null | undefined): string {
    return v == null ? '—' : v.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
  }

  date(iso: string | null | undefined): string {
    return iso ? new Date(iso).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }

  back(): void { void this.loadList(); }
  close(): void { this.dialogRef.close(); }

  private emptyForm(): Form {
    const start = new Date(Date.now() + 86_400_000); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 7 * 86_400_000); end.setHours(23, 59, 0, 0);
    return { name: '', discountType: 'PERCENT', discountValue: 10, startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(end.toISOString()), notes: '' };
  }

  /** Corre uma ação com indicador de ocupado e mensagem de erro. */
  private async run(fn: () => Promise<void>, asLoading = false): Promise<void> {
    if (asLoading) this.loading = true; else this.busy = true;
    this.error = '';
    try { await fn(); }
    catch (e) { this.error = apiError(e); }
    finally { if (asLoading) this.loading = false; else this.busy = false; }
  }
}
