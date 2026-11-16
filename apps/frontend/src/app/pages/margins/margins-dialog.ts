// apps/frontend/src/app/pages/margins/margins-dialog.ts
import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MarginsService } from '../../services/margins.service';
import { lastValueFrom } from 'rxjs'; // Importante para converter Observable em Promise

// Angular core
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// Angular Material
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar'; // <-- Importar ProgressBar
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTableModule } from '@angular/material/table';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-margins-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    MatExpansionModule,
    MatTableModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
  ],
  templateUrl: './margins-dialog.html',
  styleUrls: ['./margins-dialog.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarginsDialog implements OnInit {
  loading = false;
  saving = false;
  progress = 0; // Variável para a barra de progresso

  grupos: Array<{
    nome: string;
    PercGrupo: number;
    familias: Array<{
      nome: string;
      PercFam: number;
      subfamilias: Array<{
        Grupo: string;
        Familia: string;
        Subfamilia: string;
        ValorSubFam: number;
        TipoCalcPvP: 'Percentagem' | 'Valor';
      }>;
    }>;
  }> = [];

  // usado pela tabela
  readonly colunas = ['sub', 'valorSub', 'tipoCalc'];

  constructor(
    private dialogRef: MatDialogRef<MarginsDialog>,
    private service: MarginsService,
    private snackBar: MatSnackBar,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.loading = true;
    this.cdr.detectChanges();

    try {
      const data = await this.service.list(); // O service deve retornar Promise<any[]> ou Observable convertido
      // Se o service retornar Observable, usar: await lastValueFrom(this.service.list());
      this.grupos = this.agrupar(data);
    } catch (e) {
      console.error('Erro ao carregar margens:', e);
      this.snackBar.open('Erro ao carregar margens', 'Fechar', { duration: 2500 });
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  private agrupar(data: any[]): any[] {
    const grupos: Record<string, any> = {};

    for (const row of data) {
      if (!grupos[row.Grupo]) {
        grupos[row.Grupo] = {
          nome: row.Grupo,
          PercGrupo: Number(row.PercGrupo ?? 0),
          familias: [],
        };
      }

      let fam = grupos[row.Grupo].familias.find((f: any) => f.nome === row.Familia);
      if (!fam) {
        fam = {
          nome: row.Familia,
          PercFam: Number(row.PercFam ?? 0),
          subfamilias: [],
        };
        grupos[row.Grupo].familias.push(fam);
      }

      fam.subfamilias.push({
        Grupo: row.Grupo,
        Familia: row.Familia,
        Subfamilia: row.Subfamilia,
        ValorSubFam: Number(row.ValorSubFam ?? 0),
        TipoCalcPvP: (row.TipoCalcPvP as 'Percentagem' | 'Valor') ?? 'Percentagem',
      });
    }

    return Object.values(grupos);
  }

  expandGrupo(g: any) {}
  expandFamilia(g: any, f: any) {}
  trackByNome(_i: number, item: any) { return item?.nome ?? _i; }

  async guardar() {
    if (this.saving) return;
    
    this.saving = true;
    this.progress = 0;
    this.cdr.detectChanges();

    try {
      // 1. Planificar todos os dados numa única lista
      const todasAsLinhas: any[] = [];
      
      for (const g of this.grupos) {
        const percGrupo = Number(g.PercGrupo ?? 0);
        for (const f of g.familias) {
          const percFam = Number(f.PercFam ?? 0);
          for (const sub of f.subfamilias) {
            todasAsLinhas.push({
              Grupo: g.nome,
              Familia: f.nome,
              Subfamilia: sub.Subfamilia,
              PercGrupo: percGrupo,
              PercFam: percFam,
              ValorSubFam: Number(sub.ValorSubFam ?? 0),
              TipoCalcPvP: sub.TipoCalcPvP || 'Percentagem',
            });
          }
        }
      }

      // 2. Dividir em Lotes (Chunks)
      const BATCH_SIZE = 50; // Ajustar conforme necessário (50 é seguro e dá feedback visual rápido)
      const total = todasAsLinhas.length;
      
      if (total === 0) {
         this.saving = false;
         return;
      }

      const batches = [];
      for (let i = 0; i < total; i += BATCH_SIZE) {
        batches.push(todasAsLinhas.slice(i, i + BATCH_SIZE));
      }

      // 3. Enviar lote a lote
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        
        // Assumindo que this.service.save retorna um Promise. 
        // Se for Observable, usar lastValueFrom(this.service.save(batch))
        await this.service.save(batch);

        // Atualizar progresso
        this.progress = Math.round(((i + 1) / batches.length) * 100);
        this.cdr.detectChanges(); // Forçar atualização da UI
      }

      this.snackBar.open('Margens guardadas e propagadas com sucesso!', 'Fechar', {
        duration: 2000,
      });
      
      // Opcional: Fechar dialog após sucesso
      // this.dialogRef.close(true);

    } catch (e) {
      console.error('Erro ao guardar margens:', e);
      this.snackBar.open('Erro ao guardar margens. Tente novamente.', 'Fechar', {
        duration: 2500,
      });
    } finally {
      this.saving = false;
      this.progress = 0; // Reset (opcional)
      this.cdr.detectChanges();
    }
  }

  fechar() {
    this.dialogRef.close(false);
  }
}