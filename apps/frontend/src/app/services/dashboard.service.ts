import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type DashboardSummary = {
  totais: { totalSt:number; totalStobs:number; totalMap:number; ativosErp:number };
  ativosPorNivel: { nivel: number; count: number }[];
  produtosPorGrupo: { label: string; value: number }[];
  novosPorDia: { date: string; value: number }[];
  mappingQualidade: { completos:number; incompletos:number };
};

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private API = '/api/dashboard';
  constructor(private http: HttpClient) {}

  async getSummary(): Promise<DashboardSummary> {
    return await firstValueFrom(this.http.get<DashboardSummary>(`${this.API}/summary`));
  }
}
