#!/usr/bin/env node
/**
 * Procura segredos e dados de operação em ficheiros versionados.
 *
 *   node tools/check-secrets.mjs           ficheiros versionados + novos não ignorados (árvore de trabalho)
 *   node tools/check-secrets.mjs --staged  só o conteúdo em stage (usado pelo hook pre-commit)
 *
 * Para aceitar uma linha concreta, acrescentar o comentário `check-secrets: ignore` nessa linha.
 * Sai com código 1 se encontrar alguma coisa.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const staged = process.argv.includes("--staged");

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = (staged
  ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
  : git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
).split("\0").filter(Boolean);

const SKIP_FILE = /(^|\/)(package-lock\.json|tools\/check-secrets\.mjs)$|\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|eot|pdf|xlsx?|db|sqlite)$/i;

// Valores que são claramente exemplos/placeholders.
const PLACEHOLDER = /(example|exemplo|a-minha-loja|your-|placeholder|\.\.\.|…|xxx)/i;

const RULES = [
  { name: "token Shopify",      re: /shp(at|ss|ca|pa)_[A-Za-z0-9]{8,}/g },
  { name: "chave OpenAI",       re: /(?<![A-Za-z0-9])sk-(proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "palavra-passe/token em literal",
    re: /\b(pass(word)?|passwd|pwd|senha|secret|token|api[_-]?key)\b["']?\s*[:=]\s*["'][^"'\s]{4,}["']/gi },
  { name: "IP privado",         re: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g },
  { name: "domínio myshopify",  re: /\b[a-z0-9][a-z0-9-]*\.myshopify\.com\b/gi },
  { name: "email",              re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

const EMAIL_OK = /@(example\.(com|org)|empresa\.pt|users\.noreply\.github\.com|anthropic\.com)$/i;

function readContent(file) {
  if (staged) {
    try { return execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
    catch { return null; }
  }
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

const findings = [];

for (const file of files) {
  if (SKIP_FILE.test(file)) continue;
  const content = readContent(file);
  if (content == null || content.includes("\0")) continue; // binário

  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("check-secrets: ignore")) return;
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        const hit = m[0];
        if (PLACEHOLDER.test(hit)) continue;
        if (rule.name === "email" && EMAIL_OK.test(hit)) continue;
        findings.push({ file, line: i + 1, rule: rule.name, hit: hit.length > 60 ? hit.slice(0, 60) + "…" : hit });
      }
    }
  });
}

if (findings.length === 0) {
  console.log(`check-secrets: OK (${files.length} ficheiros${staged ? " em stage" : ""})`);
  process.exit(0);
}

console.error(`check-secrets: ${findings.length} ocorrência(s):`);
for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.hit}`);
console.error("\nRemover, ou marcar a linha com `check-secrets: ignore` se for intencional.");
process.exit(1);
