import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

const API = '' + '/api';

interface DashSummary {
  totalProducts:    number;
  syncedProducts:   number;
  productsWithTags: number;
  tagCoverage:      number;
  lastSync:         string | null;
  lastSyncStatus:   'ok' | 'error' | null;
  byProductLine:    { name: string; count: number }[];
  byFamily:         { name: string; count: number }[];
}

interface SchedulerRun {
  trigger: string; startedAt: string; finishedAt?: string; ok: boolean; step?: string; error?: string;
  import?: { saved: number; total: number; removed: number; removalSkipped: boolean };
  shopify?: { created: number; updated: number; errors: number; noCostHidden: number; noCostSkipped: number; cancelled?: boolean };
}

interface SchedulerStatus {
  enabled: boolean; time: string; nextRunAt: string | null; running: boolean;
  importRunning: boolean; shopifySyncRunning: boolean; lastRun: SchedulerRun | null;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, MatProgressSpinnerModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  @ViewChild('donutCanvas') donutCanvas!: ElementRef<HTMLCanvasElement>;

  loading = true;
  data: DashSummary | null = null;
  private chart: Chart | null = null;

  get syncedPct(): number {
    if (!this.data || !this.data.totalProducts) return 0;
    return Math.round((this.data.syncedProducts / this.data.totalProducts) * 100);
  }

  get tagRingOffset(): number {
    const r = 54;
    const circ = 2 * Math.PI * r;
    return circ - (circ * (this.data?.tagCoverage ?? 0)) / 100;
  }

  get syncRingOffset(): number {
    const r = 54;
    const circ = 2 * Math.PI * r;
    return circ - (circ * this.syncedPct) / 100;
  }

  get lastSyncLabel(): string {
    if (!this.data?.lastSync) return 'Nunca';
    const d = new Date(this.data.lastSync);
    return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  sched: SchedulerStatus | null = null;

  get schedActivity(): string {
    const s = this.sched;
    if (!s) return '—';
    if (s.running) return 'Ciclo agendado em curso';
    if (s.importRunning) return 'Importação em curso';
    if (s.shopifySyncRunning) return 'Sync Shopify em curso';
    return 'Parado';
  }

  get lastRunSummary(): string {
    const r = this.sched?.lastRun;
    if (!r) return '';
    if (!r.ok) return r.error ? `Erro${r.step ? ' em ' + r.step : ''}: ${r.error}` : 'Sem detalhe';
    const parts: string[] = [];
    if (r.import) parts.push(`${r.import.saved} importados, ${r.import.removed} retirados`);
    if (r.shopify) parts.push(`${r.shopify.updated} atualizados, ${r.shopify.errors} erros`);
    return parts.join(' · ');
  }

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void { this.load(); }

  ngOnDestroy(): void { this.chart?.destroy(); }

  load(): void {
    this.loading = true;
    this.chart?.destroy();
    this.chart = null;
    this.http.get<DashSummary>(`${API}/dashboard/summary`).subscribe({
      next: d => {
        this.data = d;
        this.loading = false;
        this.cdr.detectChanges();
        setTimeout(() => this.buildChart(), 0);
      },
      error: () => { this.loading = false; this.cdr.detectChanges(); },
    });
    this.http.get<SchedulerStatus>(`${API}/scheduler/status`).subscribe({
      next: s => { this.sched = s; this.cdr.detectChanges(); },
      error: () => { this.sched = null; this.cdr.detectChanges(); },
    });
  }

  private buildChart(): void {
    if (!this.donutCanvas || !this.data?.byProductLine?.length) return;
    const lines = this.data.byProductLine.slice(0, 10);
    const colors = [
      '#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6',
      '#06B6D4','#F97316','#84CC16','#EC4899','#6B7280',
    ];
    this.chart = new Chart(this.donutCanvas.nativeElement, {
      type: 'doughnut',
      data: {
        labels: lines.map(l => l.name),
        datasets: [{ data: lines.map(l => l.count), backgroundColor: colors, borderWidth: 0 }],
      },
      options: {
        cutout: '72%',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} produtos` } } },
        animation: { duration: 600 },
      },
    });
  }
}
