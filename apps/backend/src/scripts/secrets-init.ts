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
import { encryptSecret, isEncrypted, SECRET_FIELDS } from "../security/secret-box";
import { getMssql, closeMssql } from "../db/mssql";

const envPath = path.resolve(process.cwd(), ".env");

function ensureKey(): boolean {
  if (process.env.SECRETS_KEY?.trim()) return false;
  const key = crypto.randomBytes(32).toString("base64");
  const prefix = fs.existsSync(envPath) && !fs.readFileSync(envPath, "utf8").endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, `${prefix}\n# Chave das credenciais cifradas no SQL Server (não partilhar; guardar cópia segura)\nSECRETS_KEY=${key}\n`);
  process.env.SECRETS_KEY = key;
  return true;
}

async function main() {
  const created = ensureKey();
  console.log(created ? "SECRETS_KEY criada no .env." : "SECRETS_KEY já existia.");

  const count = await getMssql().transaction().setIsolationLevel("serializable").execute(async db => {
    const rows = await db.selectFrom("connection_settings").select(["name", "value"])
      .where("name", "in", SECRET_FIELDS).execute();
    const plain = rows.filter(row => row.value && !isEncrypted(row.value));
    for (const row of plain) {
      await db.updateTable("connection_settings").set({ value: encryptSecret(row.value) })
        .where("name", "=", row.name).execute();
    }
    return plain.length;
  });
  console.log(`${count} credencial(is) cifrada(s) no SQL Server.`);
}

main().catch(() => { console.error("Falha ao preparar as credenciais."); process.exitCode = 1; }).finally(closeMssql);
