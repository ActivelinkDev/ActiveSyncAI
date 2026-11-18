import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { forkJoin } from 'rxjs';
import {
  SupridesService,
  type SupplierKey,
  type AdminSettings, type PriceMode, type MenuSyncNode,
  type CollectionMargins
} from '../suprides.service';

interface MarginNode {
  shopifyId: string;
  title: string;
  type: 'line' | 'family' | 'subfamily';
  mode: PriceMode;
  marginValue: number | null;
  inheritedValue: number;
  inheritedMode: PriceMode;
  expanded: boolean;
  children: MarginNode[];
}

@Component({
  selector: 'app-suprides-margens-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatIconModule, MatSelectModule,
    MatSlideToggleModule, MatProgressBarModule, MatTooltipModule,
    MatTabsModule
  ],
  templateUrl: './suprides-margens-dialog.html',
  styleUrls: ['./suprides-margens-dialog.scss']
})
export class SupridesMargensDialog implements OnInit {
  private svcRoot = inject(SupridesService);
  private svc = this.svcRoot.withSupplier('suprides');
  private dialogRef = inject(MatDialogRef<SupridesMargensDialog>);

  supplierIndex = 0;
  readonly suppliers: { key: SupplierKey; label: string }[] = [
    { key: 'suprides', label: 'Suprides' },
  ];
  get activeSupplier(): SupplierKey { return this.suppliers[this.supplierIndex].key; }
  get activeSupplierLabel(): string { return this.suppliers[this.supplierIndex].label; }

  loading = true;
  saving  = false;
  error   = '';
  success = false;

  tree: MarginNode[] = [];
  adminSettings: AdminSettings = { ivaRate: 23, rounding: {} };

  readonly modeOptions: { value: PriceMode; label: string }[] = [
    { value: 'percentage', label: '% Percentagem' },
    { value: 'fixed',      label: '+ Valor fixo (€)' }
  ];

  ngOnInit(): void {
    this.loadSupplierData();
  }

  onSupplierTabChange(index: number): void {
    if (index === this.supplierIndex) return;
    this.supplierIndex = index;
    this.svc = this.svcRoot.withSupplier(this.activeSupplier);
    this.loadSupplierData();
  }

  private loadSupplierData(): void {
    this.loading = true;
    this.error = '';
    this.success = false;
    forkJoin([
      this.svc.getMenuNodes(),
      this.svc.getCollectionMargins(),
      this.svc.getAdminSettings()
    ]).subscribe({
      next: ([nodes, margins, settings]) => {
        this.adminSettings = settings;
        this.tree = this._buildTree(nodes, margins);
        this.loading = false;
      },
      error: e => { this.error = e.message || 'Erro ao carregar'; this.loading = false; }
    });
  }

  private _buildTree(nodes: MenuSyncNode[], margins: CollectionMargins): MarginNode[] {
    const r = margins.rules;
    return nodes
      .filter(n => n.shopifyId)
      .map(l1 => {
        const l1Rule = r[l1.shopifyId!];
        const l1Node: MarginNode = {
          shopifyId: l1.shopifyId!,
          title: l1.title,
          type: 'line',
          mode: l1Rule?.mode ?? 'percentage',
          marginValue: l1Rule ? l1Rule.marginValue : null,
          inheritedValue: 0,
          inheritedMode: 'percentage',
          expanded: false,
          children: []
        };
        const l1Eff = l1Node.marginValue ?? 0;
        l1Node.children = (l1.children || [])
          .filter(n => n.shopifyId)
          .map(l2 => {
            const l2Rule = r[l2.shopifyId!];
            const l2Node: MarginNode = {
              shopifyId: l2.shopifyId!,
              title: l2.title,
              type: 'family',
              mode: l2Rule?.mode ?? l1Node.mode,
              marginValue: l2Rule ? l2Rule.marginValue : null,
              inheritedValue: l1Eff,
              inheritedMode: l1Node.mode,
              expanded: false,
              children: []
            };
            const l2Eff = l2Node.marginValue ?? l1Eff;
            const l2EffMode: PriceMode = l2Node.marginValue !== null ? l2Node.mode : l1Node.mode;
            l2Node.children = (l2.children || [])
              .filter(n => n.shopifyId)
              .map(l3 => {
                const l3Rule = r[l3.shopifyId!];
                return {
                  shopifyId: l3.shopifyId!,
                  title: l3.title,
                  type: 'subfamily' as const,
                  mode: l3Rule?.mode ?? l2EffMode,
                  marginValue: l3Rule ? l3Rule.marginValue : null,
                  inheritedValue: l2Eff,
                  inheritedMode: l2EffMode,
                  expanded: false,
                  children: []
                };
              });
            return l2Node;
          });
        return l1Node;
      });
  }

  recomputeInherited(): void {
    for (const l1 of this.tree) {
      const l1Eff = l1.marginValue ?? 0;
      for (const l2 of l1.children) {
        l2.inheritedValue = l1Eff;
        l2.inheritedMode  = l1.mode;
        const l2Eff: number     = l2.marginValue ?? l1Eff;
        const l2EffMode: PriceMode = l2.marginValue !== null ? l2.mode : l1.mode;
        for (const l3 of l2.children) {
          l3.inheritedValue = l2Eff;
          l3.inheritedMode  = l2EffMode;
        }
      }
    }
  }

  private _flattenTree(): CollectionMargins {
    const rules: Record<string, { mode: PriceMode; marginValue: number; _title: string }> = {};
    const visit = (n: MarginNode) => {
      if (n.marginValue !== null && n.marginValue > 0) {
        rules[n.shopifyId] = { mode: n.mode, marginValue: n.marginValue, _title: n.title };
      }
      n.children.forEach(visit);
    };
    this.tree.forEach(visit);
    return { rules };
  }

  setMargin(node: MarginNode, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const val = raw === '' ? null : Math.max(0, +raw || 0);
    node.marginValue = val === 0 ? null : val;
    this.recomputeInherited();
  }

  clearMargin(node: MarginNode): void {
    node.marginValue = null;
    node.mode = node.inheritedMode;
    this.recomputeInherited();
  }

  onModeChange(node: MarginNode): void {
    this.recomputeInherited();
  }

  getPlaceholder(node: MarginNode): string {
    return node.inheritedValue > 0 ? String(node.inheritedValue) : '0';
  }

  getSuffix(node: MarginNode): string {
    const mode = node.marginValue !== null ? node.mode : node.inheritedMode;
    return mode === 'percentage' ? '%' : '€';
  }

  toggle(node: MarginNode): void { node.expanded = !node.expanded; }
  expandAll(): void  { this.tree.forEach(n => { n.expanded = true;  n.children.forEach(c => c.expanded = true); }); }
  collapseAll(): void { this.tree.forEach(n => { n.expanded = false; n.children.forEach(c => c.expanded = false); }); }

  save(): void {
    this.saving  = true;
    this.success = false;
    this.error   = '';
    forkJoin([
      this.svc.saveCollectionMargins(this._flattenTree()),
      this.svc.saveAdminSettings(this.adminSettings)
    ]).subscribe({
      next: () => { this.saving = false; this.success = true; setTimeout(() => this.dialogRef.close(true), 800); },
      error: e => { this.saving = false; this.error = e.message || 'Erro ao guardar'; }
    });
  }

  close(): void { this.dialogRef.close(); }
}
