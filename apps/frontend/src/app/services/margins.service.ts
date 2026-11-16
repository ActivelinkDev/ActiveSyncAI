import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';


@Injectable({ providedIn: 'root' })
export class MarginsService {
  private API = '/api/margens';

  constructor(private http: HttpClient) {}

async list() {
  return await firstValueFrom(
    this.http.get<any>(this.API).pipe(
      map(res => Array.isArray(res) ? res : (res?.items ?? []))
    )
  )}

  async save(linhas: any[]) {
    return await firstValueFrom(this.http.post(this.API, { linhas }));
  }
}
