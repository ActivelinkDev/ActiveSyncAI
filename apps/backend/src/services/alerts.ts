/**
 * Alertas por email — só em falhas.
 *
 * Configuração no .env (nunca no código):
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (0 = STARTTLS na 587, 1 = TLS na 465),
 *   SMTP_USER, SMTP_PASS, ALERT_FROM, ALERT_TO (vários separados por vírgula).
 * Sem SMTP_HOST/ALERT_TO, os alertas ficam só no log (a app funciona igual).
 *
 * O mesmo tipo de alerta é enviado no máximo uma vez por hora (evita inundar a caixa).
 * Nunca incluir credenciais nos alertas.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import os from 'os';
import { logLine } from '../utils/logger';

export type AlertKind =
  | 'sync-failed'          // importação ou sync falhou (exceção)
  | 'sync-errors'          // sync terminou com erros em produtos
  | 'sync-cancelled'
  | 'verify-mismatch'      // verificação depois do sync encontrou diferenças
  | 'service-crash'        // erro inesperado no serviço
  | 'test';

const THROTTLE_MS = 60 * 60_000;
const lastSent = new Map<AlertKind, number>();

export function alertsConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.ALERT_TO && process.env.ALERT_FROM);
}

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (transport) return transport;
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === '1' || port === 465,
    requireTLS: !(process.env.SMTP_SECURE === '1' || port === 465), // na 587 exige STARTTLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  });
  return transport;
}

/** Retira qualquer coisa que pareça uma credencial antes de enviar. */
export function scrub(text: string): string {
  return text
    .replace(/shpat_[A-Za-z0-9]+/g, 'shpat_••••')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-••••')
    .replace(/(token|password|pass|secret|authorization)(["'\s:=]+)[^\s"',}]+/gi, '$1$2••••');
}

export interface AlertResult { sent: boolean; reason?: string }

export async function sendAlert(kind: AlertKind, subject: string, details: string): Promise<AlertResult> {
  const now = Date.now();
  if (kind !== 'test' && now - (lastSent.get(kind) ?? 0) < THROTTLE_MS) {
    return { sent: false, reason: 'já enviado na última hora' };
  }
  if (!alertsConfigured()) {
    logLine(`[Alerta] (email não configurado) ${subject}`);
    return { sent: false, reason: 'email não configurado' };
  }
  const body = scrub([
    details.trim(),
    '',
    '—',
    `Servidor: ${os.hostname()}`,
    `Hora: ${new Date().toLocaleString('pt-PT')}`,
    'ActiveSyncAI — alerta automático (só em falhas).',
  ].join('\n'));
  try {
    await getTransport().sendMail({
      from: process.env.ALERT_FROM,
      to: process.env.ALERT_TO,
      subject: `[ActiveSyncAI] ${scrub(subject)}`.slice(0, 200),
      text: body,
    });
    lastSent.set(kind, now);
    logLine(`[Alerta] Email enviado: ${subject}`);
    return { sent: true };
  } catch (e: any) {
    // Nunca deixar uma falha de email partir o resto.
    logLine(`[Alerta] Falhou o envio do email (${e?.code || ''} ${e?.message || e}).`);
    return { sent: false, reason: e?.message || String(e) };
  }
}

/** Erros inesperados no serviço: alerta e deixa o serviço reiniciar (WinSW volta a arrancar). */
export function installCrashAlerts(): void {
  const onFatal = (what: string) => async (err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
    console.error(`[fatal] ${what}:`, err);
    await Promise.race([
      sendAlert('service-crash', `Erro inesperado no serviço (${what})`, `O serviço vai reiniciar.\n\n${msg.slice(0, 4000)}`),
      new Promise(r => setTimeout(r, 15_000)),
    ]);
    process.exit(1);
  };
  process.on('uncaughtException', onFatal('uncaughtException'));
  process.on('unhandledRejection', onFatal('unhandledRejection'));
}
