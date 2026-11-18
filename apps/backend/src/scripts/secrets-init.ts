/**
 * Gera SECRETS_KEY no .env (se faltar) e cifra as credenciais guardadas em claro.
 *
 *   npm run secrets:init
 *
 * A chave nunca é mostrada. Guardar uma cópia do .env num local seguro (ex.: cofre de
 * palavras-passe): sem ela, as credenciais cifradas não se recuperam (voltam a introduzir-se).
 */
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isEncrypted, SECRET_FIELDS } from "../security/secret-box";
import { dataPath } from "../utils/data-dir";

const envPath = path.resolve(process.cwd(), ".env");

function ensureKey(): boolean {
  if (process.env.SECRETS_KEY?.trim()) return false;
  const key = crypto.randomBytes(32).toString("base64");
  const prefix = fs.existsSync(envPath) && !fs.readFileSync(envPath, "utf8").endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, `${prefix}\n# Chave das credenciais cifradas em data/ (não partilhar; guardar cópia segura)\nSECRETS_KEY=${key}\n`);
  process.env.SECRETS_KEY = key;
  return true;
}

async function main() {
  const created = ensureKey();
  console.log(created ? "SECRETS_KEY criada no .env." : "SECRETS_KEY já existia.");

  // Importar só depois de a chave estar no ambiente.
  const sup = await import("../suprides/repositories/store");
  for (const [name, store] of [["suprides", sup]] as const) {
    const s = store.loadConnectionSettings() as Record<string, any>;
    const plain = SECRET_FIELDS.filter(f => typeof s[f] === "string" && s[f]);
    if (!plain.length) { console.log(`${name}: sem credenciais guardadas em data/.`); continue; }
    store.saveConnectionSettings(s);
    const check = JSON.parse(fs.readFileSync(dataPath(name, "connection-settings.json"), "utf8"));
    const ok = plain.every(f => isEncrypted(check[f]));
    console.log(`${name}: ${plain.length} credencial(is) ${ok ? "cifrada(s)" : "— ATENÇÃO: verificação falhou"}.`);
  }
}

main().catch(e => { console.error("ERRO:", e?.message ?? e); process.exit(1); });
