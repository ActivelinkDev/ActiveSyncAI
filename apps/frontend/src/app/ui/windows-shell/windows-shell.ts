import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';

import { MaterialModule } from '../../material.module';
import { MatDialog } from '@angular/material/dialog';
import { PreferencesDialog } from '../../pages/preferences/preferences-dialog';
import { TagsDialog } from '../../pages/tags/tags-dialog';
import { SupridesMapeamentoDialog } from '../../pages/suprides/mapeamento/suprides-mapeamento-dialog';
import { SupridesMargensDialog } from '../../pages/suprides/margens/suprides-margens-dialog';
import { interval, Subscription } from 'rxjs';

declare global {
  interface Window {
    electronWindow?: {
      minimize: () => void;
      toggleMaximize: () => Promise<boolean>;
      close: () => void;
    };
    electronAPI?: {
      minimize: () => void;
      toggleMaximize: () => Promise<boolean>;
      close: () => void;
    };
  }
}

const API = ((window as any).ENV_API_BASE?.replace(/\/+$/, '') || 'http://localhost:3004') + '/api';

@Component({
  selector: 'app-windows-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, MaterialModule],
  templateUrl: './windows-shell.html',
  styleUrls: ['./windows-shell.scss']
})
export class WindowsShellComponent implements OnInit, OnDestroy {
  maximized = false;
  syncing = false;
  syncDone = 0;
  syncTotal = 0;

  logs: string[] = [];
  showLogs = false;
  shopifyStore = '';
  private evtSource?: EventSource;
  private sub?: Subscription;

  constructor(private dialog: MatDialog) {}

  ngOnInit(): void {
    this.sub = interval(1000).subscribe(() => {});

    fetch(`${API}/system/info`)
      .then(r => (r.ok ? r.json() : null))
      .then(info => { if (info?.shopifyStore) this.shopifyStore = info.shopifyStore; })
      .catch(() => { /* a barra de estado fica com '—' */ });

    this.evtSource = new EventSource(`${API}/logs/stream`);
    this.evtSource.onmessage = (event) => {
      this.logs.push(event.data);
      if (this.logs.length > 300) this.logs.shift();
      if (event.data.includes('Sincronização concluída') || event.data.includes('sync done')) {
        this.syncing = false;
      }
    };
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.evtSource?.close();
    this._cacheEs?.close();
  }

  toggleLogs(): void { this.showLogs = !this.showLogs; }
  clearLogs(): void { this.logs = []; }

  private _cacheEs: EventSource | null = null;

  syncSuprides(): void {
    if (this.syncing) return;
    this.syncing = true;
    this.syncDone = 0;
    this.syncTotal = 0;
    this._cacheEs?.close();

    const es = new EventSource(`${API}/suprides/cache/sync`);
    this._cacheEs = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.saved != null)   this.syncDone = data.saved;
        if (data.inserted != null) this.syncDone = data.inserted;
        if (data.type === 'done' || data.type === 'error') {
          this.syncing = false;
          es.close();
          this._cacheEs = null;
        }
      } catch {}
    };

    es.onerror = () => {
      this.syncing = false;
      es.close();
      this._cacheEs = null;
    };
  }

  openPreferences(): void {
    this.dialog.open(PreferencesDialog, {
      width: '760px', maxWidth: '98vw', panelClass: 'b2b-dialog'
    });
  }

  openFiltrosTags(): void {
    this.dialog.open(TagsDialog, {
      width: '90vw', maxWidth: '95vw', panelClass: 'b2b-dialog'
    });
  }

  openSupridesMapeamento(): void {
    this.dialog.open(SupridesMapeamentoDialog, {
      width: '98vw', height: '92vh',
      maxWidth: '100vw', maxHeight: '92vh',
      panelClass: ['b2b-dialog', 'suprides-mapeamento-dialog']
    });
  }

  openSupridesMargens(): void {
    this.dialog.open(SupridesMargensDialog, {
      width: '860px', maxWidth: '96vw', height: '90vh',
      panelClass: ['b2b-dialog', 'suprides-margens-dialog']
    });
  }

  minimize(): void { window.electronWindow?.minimize?.(); }

  async toggleMaximize(): Promise<void> {
    if (!window.electronWindow?.toggleMaximize) return;
    this.maximized = await window.electronWindow.toggleMaximize();
  }

  close(): void { window.electronWindow?.close?.(); }
}
