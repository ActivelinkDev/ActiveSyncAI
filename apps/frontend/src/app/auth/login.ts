import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, MatIconModule],
  template: `
    <div class="login-page">
      <form class="login-card glass glass--strong" (ngSubmit)="submit()" autocomplete="on">
        <div class="brand">
          <div class="brand-mark"><mat-icon>sync</mat-icon></div>
          <div class="brand-text">ActiveSync<span>AI</span><small>Coisas Fixes · fornecedores → Shopify</small></div>
        </div>

        @if (auth.expiredNotice()) {
          <div class="notice">A sessão terminou. Entre outra vez para continuar.</div>
        }

        <label for="u">Utilizador</label>
        <input id="u" name="username" class="g-input" autocomplete="username" required
               [(ngModel)]="username" [disabled]="busy()" autofocus>

        <label for="p">Palavra-passe</label>
        <input id="p" name="password" class="g-input" type="password" autocomplete="current-password" required
               [(ngModel)]="password" [disabled]="busy()">

        @if (error()) { <div class="error" role="alert">{{ error() }}</div> }

        <button class="g-btn g-btn--primary full" type="submit" [disabled]="busy() || !username || !password">
          {{ busy() ? 'A entrar…' : 'Entrar' }}
        </button>

        <div class="hint"><mat-icon>lock</mat-icon>Ligação segura · só rede interna</div>
      </form>
    </div>
  `,
  styles: [`
    .login-page { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
    .login-card { width: min(400px, 100%); padding: 34px 30px; display: flex; flex-direction: column; font-family: var(--font-head); }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
    .brand-mark { width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; background: var(--brand); color: #fff; }
    .brand-text { font-weight: 800; font-size: 20px; letter-spacing: -.3px; line-height: 1; }
    .brand-text span { color: var(--brand-text); }
    .brand-text small { display: block; font-weight: 500; font-size: 12.5px; color: var(--muted); letter-spacing: 0; margin-top: 5px; }
    label { font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
    .error, .notice { margin-top: 14px; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
    .error { color: var(--bad); background: rgba(180,35,24,.06); border: 1px solid rgba(180,35,24,.18); }
    .notice { color: var(--warn); background: var(--warn-bg); border: 1px solid rgba(161,92,0,.18); margin: 0 0 4px; }
    .full { width: 100%; margin-top: 22px; min-height: 44px; }
    .hint { display: flex; gap: 6px; align-items: center; margin-top: 16px; font-size: 12.5px; color: var(--muted); }
    .hint mat-icon { font-size: 16px; width: 16px; height: 16px; }
  `],
})
export class LoginComponent {
  readonly auth = inject(AuthService);
  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const r = await this.auth.login(this.username.trim(), this.password);
    this.busy.set(false);
    this.password = '';
    if (!r.ok) this.error.set(r.message ?? 'Erro');
  }
}
