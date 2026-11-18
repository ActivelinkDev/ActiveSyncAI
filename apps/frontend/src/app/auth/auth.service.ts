import { Injectable, signal } from '@angular/core';

export type AuthState = 'checking' | 'out' | 'in';

export interface LoginResult { ok: boolean; message?: string }

/**
 * Sessão do utilizador. O cookie de sessão é HttpOnly (o JavaScript não o vê):
 * o estado vem de /api/auth/me e de qualquer resposta 401 da API.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly state = signal<AuthState>('checking');
  readonly username = signal<string>('');
  readonly expiredNotice = signal<boolean>(false);

  constructor() {
    this.watchFetch();
  }

  async check(): Promise<void> {
    try {
      const r = await fetch('/api/auth/me', { cache: 'no-store' });
      if (r.ok) {
        const me = await r.json();
        this.username.set(me.username);
        this.state.set('in');
      } else {
        this.state.set('out');
      }
    } catch {
      this.state.set('out');
    }
  }

  async login(username: string, password: string): Promise<LoginResult> {
    let r: Response;
    try {
      r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      return { ok: false, message: 'Sem ligação ao servidor.' };
    }
    if (r.ok) {
      const me = await r.json();
      this.username.set(me.username);
      this.expiredNotice.set(false);
      this.state.set('in');
      return { ok: true };
    }
    const body = await r.json().catch(() => ({}));
    if (r.status === 429) {
      const s = Number(body.retryAfterSeconds) || 60;
      return { ok: false, message: `Demasiadas tentativas. Tente de novo dentro de ${s >= 120 ? Math.ceil(s / 60) + ' minutos' : s + ' segundos'}.` };
    }
    if (r.status === 503) return { ok: false, message: 'A conta ainda não foi configurada no servidor.' };
    if (r.status === 401) return { ok: false, message: 'Utilizador ou palavra-passe incorretos.' };
    return { ok: false, message: 'Não foi possível entrar. Tente de novo.' };
  }

  async logout(): Promise<void> {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* sai na mesma */ }
    this.username.set('');
    this.state.set('out');
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<LoginResult> {
    const r = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }).catch(() => null);
    if (!r) return { ok: false, message: 'Sem ligação ao servidor.' };
    if (r.ok) return { ok: true };
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) return { ok: false, message: 'A palavra-passe atual está errada.' };
    if (r.status === 429) return { ok: false, message: 'Demasiadas tentativas. Aguarde um pouco.' };
    return { ok: false, message: body.message || 'Não foi possível mudar a palavra-passe.' };
  }

  /** Chamado quando a API responde 401 (sessão expirada ou terminada). */
  sessionLost(): void {
    if (this.state() === 'in') {
      this.expiredNotice.set(true);
      this.state.set('out');
    }
  }

  /** Qualquer fetch para /api que devolva 401 termina a sessão na interface. */
  private watchFetch(): void {
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (res.status === 401 && /\/api\//.test(url) && !/\/api\/auth\/(login|me|password)/.test(url)) {
        this.sessionLost();
      }
      return res;
    };
  }
}
