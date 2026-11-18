/**
 * Cria a conta (ou repõe a palavra-passe) — corre no servidor, nunca pela rede.
 *
 *   npm run auth:set-password
 *
 * Pede o utilizador e a palavra-passe sem os mostrar. Termina as sessões abertas
 * no próximo arranque (as sessões vivem em memória).
 */
import "dotenv/config";
import readline from "readline";
import { loadAccount, saveAccount, hashPassword, passwordProblem, MIN_PASSWORD_LENGTH } from "../security/password";
import { audit } from "../security/audit";

function ask(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as any;
      out._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(question); };
    }
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer); });
  });
}

async function main() {
  if (!process.stdin.isTTY) { console.error("Correr numa consola interativa."); process.exit(1); }
  const current = loadAccount();
  console.log(current ? `Conta atual: ${current.username} (palavra-passe mudada em ${current.changedAt})` : "Ainda não há conta.");

  let username = (await ask(`Utilizador${current ? ` [${current.username}]` : ""}: `)).trim() || current?.username || "";
  if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) { console.error("Utilizador inválido (3–40 letras, números, . _ -)."); process.exit(1); }

  console.log(`Palavra-passe: mínimo ${MIN_PASSWORD_LENGTH} caracteres. Recomendado: uma frase longa ou gerada num gestor de palavras-passe.`);
  const p1 = await ask("Palavra-passe: ", true);
  const problem = passwordProblem(p1, username);
  if (problem) { console.error(problem); process.exit(1); }
  const p2 = await ask("Repetir: ", true);
  if (p1 !== p2) { console.error("As palavras-passe não coincidem."); process.exit(1); }

  saveAccount({ username, passwordHash: await hashPassword(p1), changedAt: new Date().toISOString() });
  audit("password.changed", { user: username, detail: "na consola do servidor" });
  console.log("Conta guardada. Reiniciar o serviço para terminar sessões abertas.");
}

main().catch(e => { console.error("ERRO:", e?.message ?? e); process.exit(1); });
