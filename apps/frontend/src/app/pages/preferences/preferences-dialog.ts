import { Component, OnInit, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MaterialModule } from '../../material.module';
import { TagsService } from '../../services/tags.service';

@Component({
  selector: 'app-danger-confirm-dialog',
  standalone: true,
  imports: [CommonModule, MaterialModule],
  template: `
    <div class="dc-wrap">
      <div class="dc-icon-ring">
        <mat-icon>warning</mat-icon>
      </div>
      <div class="dc-title">Tens a certeza absoluta?</div>
      <div class="dc-body" [innerHTML]="data.body"></div>
      <div class="dc-actions">
        <button class="dc-cancel" (click)="close(false)">Cancelar</button>
        <button class="dc-delete" (click)="close(true)">
          <mat-icon>delete_forever</mat-icon>
          {{ data.confirmLabel ?? 'Apagar tudo' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .dc-wrap { padding: 32px 28px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; width: 400px; max-width: 92vw; box-sizing: border-box; }
    .dc-icon-ring { width: 68px; height: 68px; border-radius: 50%; background: #fee2e2; border: 3px solid #fca5a5; display: flex; align-items: center; justify-content: center; margin-bottom: 18px; }
    .dc-icon-ring mat-icon { font-size: 36px !important; width: 36px !important; height: 36px !important; color: #dc2626; }
    .dc-title { font-size: 18px; font-weight: 800; color: #1d1d1f; margin-bottom: 12px; letter-spacing: -0.2px; }
    .dc-body { font-size: 13.5px; color: rgba(0,0,0,.58); line-height: 1.65; margin-bottom: 26px; }
    ::ng-deep .dc-body strong { color: #dc2626; font-weight: 700; }
    .dc-actions { display: flex; gap: 10px; width: 100%; }
    .dc-cancel { flex: 1; height: 42px; border: 1px solid rgba(0,0,0,.12); background: #fff; border-radius: 10px; font-size: 13.5px; font-weight: 600; cursor: pointer; color: rgba(0,0,0,.65); transition: background .12s; }
    .dc-cancel:hover { background: #f5f5f7; }
    .dc-delete { flex: 2; height: 42px; border: none; background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); border-radius: 10px; font-size: 13.5px; font-weight: 700; cursor: pointer; color: #fff; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 3px 14px rgba(220,38,38,.45); }
    .dc-delete mat-icon { font-size: 17px !important; width: 17px !important; height: 17px !important; }
  `]
})
export class DangerConfirmDialogComponent {
  constructor(
    private dialogRef: MatDialogRef<DangerConfirmDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: { body: string; confirmLabel?: string },
  ) {}
  close(result: boolean): void { this.dialogRef.close(result); }
}

const API = '' + '/api';

@Component({
  selector: 'app-preferences-dialog',
  standalone: true,
  imports: [CommonModule, MaterialModule, FormsModule, MatSlideToggleModule],
  templateUrl: './preferences-dialog.html',
  styleUrls: ['./preferences-dialog.scss']
})
export class PreferencesDialog implements OnInit {
  section: 'b2cSync' | 'words' | 'forcartags' | 'prompt' | 'ligacoes' = 'b2cSync';
  skipMapped = localStorage.getItem('skipMapped') === 'true';

  // ===== Tags: Palavras excluídas =====
  excludedWords: string[] = [];
  excludedPrefixes: string[] = [];
  wordsLoading = false;

  loadWords(): void {
    if (this.wordsLoading) return;
    this.wordsLoading = true;
    Promise.all([
      this.tagsService.getIgnoredWords(),
      this.tagsService.getPrefixExcludes(),
    ]).then(([words, prefixes]) => {
      this.excludedWords    = words;
      this.excludedPrefixes = prefixes;
      this.wordsLoading = false;
    }).catch(() => { this.wordsLoading = false; });
  }

  removeExcludedWord(word: string): void {
    this.excludedWords = this.excludedWords.filter(w => w !== word);
    this.tagsService.unignoreWord(word).catch(() => {
      this.excludedWords = [...this.excludedWords, word];
    });
  }

  removeExcludedPrefix(prefix: string): void {
    this.excludedPrefixes = this.excludedPrefixes.filter(p => p !== prefix);
    this.tagsService.removePrefixExclude(prefix).catch(() => {
      this.excludedPrefixes = [...this.excludedPrefixes, prefix];
    });
  }

  // ===== Syncs B2C =====
  supridesRunning = false;
  supridesLogs: { type: string; message: string; ts: Date }[] = [];
  private _supridesEs: EventSource | null = null;
  rebuildingNodeIds = false;

  syncSuprides(): void {
    if (this.supridesRunning) return;
    this.supridesRunning = true;
    this.supridesLogs = [];
    this._supridesEs?.close();

    const es = new EventSource(`${API}/suprides/cache/sync`);
    this._supridesEs = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      this.supridesLogs.push({ type: data.type, message: data.message, ts: new Date() });
      if (data.type === 'done' || data.type === 'error') {
        this.supridesRunning = false;
        es.close();
        this._supridesEs = null;
      }
    };

    es.onerror = () => {
      if (this.supridesRunning) {
        this.supridesLogs.push({ type: 'error', message: 'Ligação SSE perdida', ts: new Date() });
        this.supridesRunning = false;
      }
      es.close();
      this._supridesEs = null;
    };
  }

  rebuildNodeIds(): void {
    if (this.rebuildingNodeIds) return;
    this.rebuildingNodeIds = true;
    this.http.post<{ updated: number }>(`${API}/suprides/tags/menu/rebuild-node-ids`, {}).subscribe({
      next: (r) => {
        this.rebuildingNodeIds = false;
        this.snackBar.open(`Node IDs reconstruídos — ${r.updated} produtos mapeados`, 'Fechar', { duration: 4000 });
      },
      error: (e) => {
        this.rebuildingNodeIds = false;
        this.snackBar.open(e?.error?.error || 'Erro ao reconstruir Node IDs', 'Fechar', { duration: 4000 });
      },
    });
  }

  // ===== Ligações =====
  conn = { shopifyStore: '', shopifyToken: '', shopifyLocationId: '', supridesUrl: '', supridesUser: '', supridesPass: '', supridesToken: '', openaiApiKey: '' };
  /** As credenciais nunca vêm inteiras do servidor: só "••••abcd". Os campos ficam vazios = manter. */
  connMask: Record<string, string> = {};
  readonly secretFields = ['shopifyToken', 'supridesPass', 'supridesToken', 'openaiApiKey'] as const;
  connLoading = false;
  connSaving  = false;

  secretPlaceholder(key: string): string {
    const m = this.connMask[key];
    return m ? `${m} (definido — deixar vazio para manter)` : 'não definido';
  }

  loadConn(): void {
    if (this.connLoading) return;
    this.connLoading = true;
    this.http.get<Record<string, any>>(`${API}/suprides/admin/connection`).subscribe({
      next: (r) => {
        const next: any = { ...this.conn };
        for (const k of Object.keys(this.conn)) {
          if ((this.secretFields as readonly string[]).includes(k)) {
            this.connMask[k] = r[`${k}Set`] ? String(r[k] || '••••') : '';
            next[k] = '';
          } else {
            next[k] = r[k] ?? '';
          }
        }
        this.conn = next;
        this.connLoading = false;
      },
      error: () => { this.connLoading = false; },
    });
  }

  saveConn(): void {
    if (this.connSaving) return;
    this.connSaving = true;
    this.http.put(`${API}/suprides/admin/connection`, this.conn).subscribe({
      next: () => { this.connSaving = false; this.snackBar.open('Ligações guardadas ✓', 'Fechar', { duration: 2500 }); this.loadConn(); },
      error: () => { this.connSaving = false; this.snackBar.open('Erro ao guardar', 'Fechar', { duration: 3000 }); },
    });
  }

  // ===== Prompt AI =====
  customPromptInstructions = '';
  promptLoading = false;
  promptSaving  = false;

  loadCustomPrompt(): void {
    if (this.promptLoading) return;
    this.promptLoading = true;
    this.http.get<{ instructions: string }>(`${API}/suprides/admin/custom-prompt`).subscribe({
      next: (r) => { this.customPromptInstructions = r.instructions ?? ''; this.promptLoading = false; },
      error: () => { this.promptLoading = false; },
    });
  }

  saveCustomPrompt(): void {
    if (this.promptSaving) return;
    this.promptSaving = true;
    this.http.post(`${API}/suprides/admin/custom-prompt`, { instructions: this.customPromptInstructions }).subscribe({
      next: () => { this.promptSaving = false; this.snackBar.open('Prompt guardado ✓', 'Fechar', { duration: 2500 }); },
      error: () => { this.promptSaving = false; this.snackBar.open('Erro ao guardar prompt', 'Fechar', { duration: 3000 }); },
    });
  }

  constructor(
    private http: HttpClient,
    private ref: MatDialogRef<PreferencesDialog>,
    private tagsService: TagsService,
    private snackBar: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.skipMapped = localStorage.getItem('skipMapped') === 'true';
    this.http.get<{ createNewProducts?: boolean }>(`${API}/suprides/admin/settings`).subscribe({
      next: s => { this.createNewProducts = s.createNewProducts === true; },
      error: () => {},
    });
  }

  // ===== Sync: criação de produtos novos =====
  createNewProducts = false;
  adminSettingsSaving = false;

  toggleCreateNewProducts(val: boolean): void {
    const previous = this.createNewProducts;
    this.createNewProducts = val;
    this.adminSettingsSaving = true;
    this.http.put(`${API}/suprides/admin/settings`, { createNewProducts: val }).subscribe({
      next: () => {
        this.adminSettingsSaving = false;
        this.snackBar.open(val ? 'O sync vai criar produtos novos' : 'O sync só atualiza produtos existentes', 'OK', { duration: 3000 });
      },
      error: () => {
        this.adminSettingsSaving = false;
        this.createNewProducts = previous;
        this.snackBar.open('Erro ao guardar a definição', 'OK', { duration: 4000 });
      },
    });
  }

  toggleSkipMapped(val: boolean): void {
    this.skipMapped = val;
    localStorage.setItem('skipMapped', String(val));
  }

  close(): void {
    this._supridesEs?.close();
    this.ref.close(false);
  }
}
