import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-change-password-dialog',
  standalone: true,
  imports: [FormsModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Mudar palavra-passe</h2>
    <form mat-dialog-content (ngSubmit)="save()" class="form">
      <label for="cur">Palavra-passe atual</label>
      <input id="cur" name="cur" class="g-input" type="password" autocomplete="current-password" [(ngModel)]="current" required>
      <label for="n1">Nova palavra-passe</label>
      <input id="n1" name="n1" class="g-input" type="password" autocomplete="new-password" [(ngModel)]="next" required>
      <small class="muted">Mínimo 12 caracteres. Uma frase longa é o mais seguro.</small>
      <label for="n2">Repetir a nova</label>
      <input id="n2" name="n2" class="g-input" type="password" autocomplete="new-password" [(ngModel)]="repeat" required>
      @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
      @if (done()) { <div class="ok">Palavra-passe mudada. As outras sessões foram terminadas.</div> }
      <button type="submit" hidden></button>
    </form>
    <div mat-dialog-actions align="end">
      <button class="g-btn" type="button" (click)="ref.close()">{{ done() ? 'Fechar' : 'Cancelar' }}</button>
      @if (!done()) {
        <button class="g-btn g-btn--primary" type="button" (click)="save()" [disabled]="busy()">Guardar</button>
      }
    </div>
  `,
  styles: [`
    .form { display: flex; flex-direction: column; min-width: min(360px, 80vw); }
    label { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
    .muted { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .error, .ok { margin-top: 12px; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
    .error { color: var(--bad); background: rgba(180,35,24,.06); border: 1px solid rgba(180,35,24,.18); }
    .ok { color: var(--ok); background: var(--ok-bg); }
  `],
})
export class ChangePasswordDialog {
  readonly ref = inject(MatDialogRef<ChangePasswordDialog>);
  private readonly auth = inject(AuthService);
  current = ''; next = ''; repeat = '';
  readonly busy = signal(false);
  readonly error = signal('');
  readonly done = signal(false);

  async save(): Promise<void> {
    if (this.busy() || this.done()) return;
    this.error.set('');
    if (this.next !== this.repeat) { this.error.set('As novas palavras-passe não coincidem.'); return; }
    if (this.next.length < 12) { this.error.set('A nova palavra-passe tem de ter pelo menos 12 caracteres.'); return; }
    this.busy.set(true);
    const r = await this.auth.changePassword(this.current, this.next);
    this.busy.set(false);
    this.current = this.next = this.repeat = '';
    if (r.ok) this.done.set(true); else this.error.set(r.message ?? 'Erro');
  }
}
