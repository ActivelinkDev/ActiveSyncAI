/**
 * Envia um email de teste com a configuração de alertas do .env.
 *   npm run alert:test
 */
import "dotenv/config";
import { sendAlert, alertsConfigured } from "../services/alerts";

(async () => {
  if (!alertsConfigured()) {
    console.error("Falta configurar no .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_FROM, ALERT_TO.");
    process.exit(1);
  }
  const r = await sendAlert("test", "Teste de alertas", "Se recebeu este email, os alertas do ActiveSyncAI estão a funcionar.");
  console.log(r.sent ? `Enviado para ${process.env.ALERT_TO}.` : `Não enviado: ${r.reason}`);
  process.exit(r.sent ? 0 : 1);
})();
