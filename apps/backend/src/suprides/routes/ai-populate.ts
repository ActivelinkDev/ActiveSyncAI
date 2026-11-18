import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { getMssql } from "../../db/mssql";
import { sql } from "kysely";
import { getProductBySku } from "../../repositories/suprides-cache";
import {
  resolveTagGroupsForNode,
  saveAiProductTags,
} from "../repositories/tags";
import { getProductsForMenuNode } from "../services/menu-resolver";
import { loadCustomPrompt, loadConnectionSettings } from "../repositories/store";

// ── Inline utilities (previously in routes/tags/shared) ──────────────────────

export interface TGV {
  id: number;
  nome: string;
  descricao?: string;
  unidade?: string;
  values: string[];
}

function matchesUnit(value: string, unidade: string): boolean {
  const u = unidade.trim();
  if (!u) return true;
  const re = new RegExp("^[\\d][\\d.,\\s]*\\s*" + u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
  return re.test(value.trim());
}

export function validateAiValues(
  aiTags: { tag_group_id: number | string; value: string }[],
  tagGroups: TGV[],
  validIds: Set<number>
): { tag_group_id: number; value: string }[] {
  const tagMap = new Map(tagGroups.map(g => [g.id, g]));
  return aiTags
    .filter(t => validIds.has(Number(t.tag_group_id)))
    .map(t => {
      const tag_group_id = Number(t.tag_group_id);
      const raw = String(t.value ?? "").trim();
      const tagDef = tagMap.get(tag_group_id);
      if (!tagDef) return { tag_group_id, value: raw };
      if (tagDef.values.length > 0) {
        const match = tagDef.values.find(v => v.toLowerCase() === raw.toLowerCase());
        return { tag_group_id, value: match ?? "" };
      }
      if (tagDef.unidade && raw && !matchesUnit(raw, tagDef.unidade)) {
        return { tag_group_id, value: "" };
      }
      return { tag_group_id, value: raw };
    });
}

export function setupSse(res: Response, req: Request): {
  send: (data: unknown) => void;
  isClosedFn: () => boolean;
} {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  req.on("close", () => { closed = true; });
  const send = (data: unknown) => { if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  return { send, isClosedFn: () => closed };
}

export function buildAiPopulateSystemPrompt(tagGroups: TGV[], categoriaLabel: string, extraInstructions = ''): string {
  const tagsJson = JSON.stringify(tagGroups.map(t => {
    const entry: Record<string, unknown> = { tag_group_id: t.id, nome: t.nome };
    if (t.descricao) entry.descricao = t.descricao;
    if (t.unidade)   entry.unidade   = t.unidade;
    if (t.values.length) entry.valores_possiveis = t.values;
    return entry;
  }));

  return "És um motor de extração de atributos técnicos de produtos.\n\n" +
    `<categoria>${categoriaLabel}</categoria>\n\n` +
    "<tags_a_preencher>\n" + tagsJson + "\n</tags_a_preencher>\n\n" +
    "<regras>\n" +
    "1. Usa TODAS as fontes disponíveis: marca, nome, cor, descricao_curta, descricao.\n" +
    "2. Só preenches se o valor for explícito ou inequivocamente inferível. Em dúvida: \"\".\n" +
    "3. NUNCA inventas valores.\n" +
    "4. Se a tag tem unidade: inclui a unidade no valor (ex: '2500W', '220V').\n" +
    "5. LISTA DE VALORES: escolhe EXATAMENTE UM valor da lista com capitalização exata.\n" +
    "</regras>\n\n" +
    "<formato_resposta>\n" +
    "JSON válido apenas. Sem markdown, sem texto extra.\n" +
    "{\"products\":[{\"ref\":\"REF1\",\"tags\":[{\"tag_group_id\":1,\"value\":\"...\"}]}]}\n" +
    "Inclui TODOS os produtos do input, mesmo sem tags (usa \"tags\":[]).\n" +
    "</formato_resposta>" +
    (extraInstructions?.trim() ? `\n\n<instrucoes_adicionais>\n${extraInstructions.trim()}\n</instrucoes_adicionais>` : '');
}

const router = Router();

const BATCH_SIZE = 4;
const MAX_TEXT   = 2500;

function sanitize(s: string | null | undefined): string {
  return (s || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").substring(0, MAX_TEXT);
}

async function fetchSpTagGroups(tagGroupIds: number[]): Promise<TGV[]> {
  const { rows } = await sql<{ id: number; nome: string; descricao?: string; unidade?: string; value: string | null }>`
    SELECT g.id, g.nome, g.descricao, g.unidade, v.value
    FROM tag_groups g LEFT JOIN tag_values v ON v.tag_group_id = g.id
    WHERE g.id IN (SELECT value FROM OPENJSON(${JSON.stringify(tagGroupIds)})) ORDER BY v.value`.execute(getMssql());
  const groups = new Map<number, TGV>();
  for (const { id, nome, descricao, unidade, value } of rows) {
    if (!groups.has(id)) groups.set(id, { id, nome, descricao, unidade, values: [] });
    if (value !== null) groups.get(id)!.values.push(value);
  }
  return tagGroupIds.flatMap(id => groups.has(id) ? [groups.get(id)!] : []);
}

// ── Core AI bulk ──────────────────────────────────────────────────────────────

async function runAiBulk(
  products:    { sku: string; name: string }[],
  tagGroups:   TGV[],
  label:       string,
  apiKey:      string,
  isClosedFn:  () => boolean,
  send:        (d: object) => void,
  skipMapped = false,
): Promise<{ populated: number; failed: number }> {
  const openai     = new OpenAI({ apiKey });
  const aiValidIds = new Set(tagGroups.map(t => t.id));
  const sysPrompt  = buildAiPopulateSystemPrompt(tagGroups, label, await loadCustomPrompt());

  let populated = 0, failed = 0, globalIdx = 0;
  send({ type: "start", total: products.length });

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    if (isClosedFn()) break;

    const batch = products.slice(i, i + BATCH_SIZE);
    type ProductDetails = { sku: string; name: string | null; brand: string | null; cor: string | null;
      description: string | null; short_description: string | null; processed: string | null };
    const { rows } = await sql<ProductDetails>`SELECT p.sku, p.name, p.brand, p.cor, p.description,
      p.short_description, done.sku AS processed FROM products p LEFT JOIN ai_tagged_products done ON p.sku = done.sku
      WHERE p.supplier = 'suprides' AND p.sku IN (SELECT value FROM OPENJSON(${JSON.stringify(batch.map(p => p.sku))}))`
      .execute(getMssql());
    const bySku = new Map(rows.map(row => [row.sku, row]));
    const batchReady: { prod: { sku: string; name: string }; row: ProductDetails }[] = [];

    for (const prod of batch) {
      globalIdx++;
      const row = bySku.get(prod.sku);
      if (skipMapped && row?.processed) {
        send({ type: "log", level: "info", ref: prod.sku, msg: `[SKIP] ${prod.sku} — já processado` });
        continue;
      }
      send({ type: "progress", current: globalIdx, total: products.length, ref: prod.sku, design: prod.name });

      if (!row) {
        send({ type: "log", level: "warn", ref: prod.sku, msg: `[SKIP] ${prod.sku} — não encontrado na BD` });
        failed++;
        continue;
      }
      batchReady.push({ prod, row });
    }

    if (!batchReady.length) continue;

    const userPayload = batchReady.map(({ prod, row }) => {
      const entry: Record<string, any> = { ref: prod.sku, design: sanitize(row.name) };
      if (row.brand)             entry.marca           = sanitize(row.brand);
      if (row.cor)               entry.cor             = sanitize(row.cor);
      if (row.short_description) entry.descricao_curta = sanitize(row.short_description);
      if (row.description)       entry.descricao       = sanitize(row.description);
      return entry;
    });

    const inputLog = userPayload
      .map(p => `${p.ref}: "${String(p.design).substring(0, 60)}"${p.marca ? ` | marca="${p.marca}"` : ''}`)
      .join(" || ");
    send({ type: "log", level: "info", ref: batchReady.map(b => b.prod.sku).join("+"), msg: `[IA-INPUT] ${inputLog}` });

    let rawContent = "";
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-5.4-nano",
          temperature: 0,
          max_completion_tokens: 4096,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user",   content: JSON.stringify(userPayload, null, 2) },
          ],
          stream: false,
        });
        rawContent = (completion.choices[0]?.message?.content ?? "").trim();
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        if (e?.status === 429) {
          const wait = (attempt + 1) * 15000;
          send({ type: "retry", ref: batchReady.map(b => b.prod.sku).join("+"), attempt: attempt + 1, waitMs: wait });
          await new Promise(r => setTimeout(r, wait));
        } else throw e;
      }
    }
    if (lastErr) {
      send({ type: "log", level: "error", ref: batchReady.map(b => b.prod.sku).join("+"), msg: `[IA-ERRO] ${lastErr?.message ?? lastErr}` });
      failed += batchReady.length;
      continue;
    }

    const rawPreview = rawContent.substring(0, 600);
    send({ type: "log", level: "info", ref: batchReady.map(b => b.prod.sku).join("+"), msg: `[IA-RAW] ${rawPreview}${rawContent.length > 600 ? "…" : ""}` });

    const cleaned   = rawContent
      .replace(/^```[^\n]*\n?/m, "").replace(/```\s*$/m, "")
      .replace(/\r?\n/g, " ").replace(/\t/g, " ").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      send({ type: "log", level: "error", ref: batchReady.map(b => b.prod.sku).join("+"), msg: "[IA-PARSE] sem JSON válido" });
      failed += batchReady.length;
      continue;
    }

    let parsed: { products: { ref: string; tags: { tag_group_id: number; value: string }[] }[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed?.products)) throw new Error("products inválido");
    } catch {
      send({ type: "log", level: "error", ref: batchReady.map(b => b.prod.sku).join("+"), msg: "[IA-PARSE] JSON inválido" });
      failed += batchReady.length;
      continue;
    }

    for (const { prod } of batchReady) {
      try {
        const prodResult = parsed.products.find(p => String(p.ref).trim() === prod.sku.trim());
        const rawTags    = prodResult?.tags ?? [];
        if (!prodResult) {
          send({ type: "log", level: "warn", ref: prod.sku, msg: `[VALIDAR] ${prod.sku} — IA não devolveu este produto` });
        }

        const values = validateAiValues(rawTags, tagGroups, aiValidIds);
        const before = rawTags.map((t: any) => `gid${t.tag_group_id}="${t.value}"`).join(", ") || "(nenhuma)";
        const after  = values.map(t => `gid${t.tag_group_id}="${t.value}"`).join(", ") || "(nenhuma)";
        send({ type: "log", level: "info", ref: prod.sku, msg: `[VALIDAR] ${prod.sku} — [${before}] → [${after}]` });

        const existing = await saveAiProductTags(prod.sku, values);
        const proposed = new Set(values.filter(tag => tag.value.trim()).map(tag => tag.tag_group_id));
        for (const { tag_group_id, value } of existing) {
          if (proposed.has(tag_group_id)) {
            send({ type: "log", level: "info", ref: prod.sku, msg: `[SKIP-TAG] gid${tag_group_id} — já existe "${value}"` });
          }
        }
        populated++;
      } catch (e: any) {
        send({ type: "log", level: "error", ref: prod.sku, msg: `[ERRO] ${prod.sku} — ${e?.message ?? e}` });
        failed++;
      }
    }

    if (i + BATCH_SIZE < products.length && !isClosedFn())
      await new Promise(r => setTimeout(r, 150));
  }

  return { populated, failed };
}

// ── Bulk SSE helper (usado pelos 3 endpoints de nível) ────────────────────────

async function handleBulkSse(
  req:        Request,
  res:        Response,
  directOnly: boolean,
): Promise<void> {
  const shopifyId  = String(req.query.shopifyId || "").trim();
  const skipMapped = req.query.skipMapped === "true";
  const label      = String(req.query.label || shopifyId).trim();

  const { send, isClosedFn } = setupSse(res, req);

  if (!shopifyId) { send({ type: "error", message: "shopifyId é obrigatório" }); res.end(); return; }

  const apiKey = (await loadConnectionSettings()).openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) { send({ type: "error", message: "OPENAI_API_KEY não configurada no servidor." }); res.end(); return; }

  try {
    const rows = await getProductsForMenuNode(shopifyId, directOnly);
    const products = rows.map(row => ({ sku: row.sku, name: row.name ?? row.sku }));
    if (!products.length) {
      send({ type: "done", total: 0, populated: 0, failed: 0, reason: "Nenhum produto neste nó de menu." });
      res.end(); return;
    }

    const tagGroupIds = await resolveTagGroupsForNode(shopifyId);
    if (!tagGroupIds.length) {
      send({ type: "done", total: products.length, populated: 0, failed: 0, reason: "Nenhuma tag definida para este nó (nem nos seus ancestrais). Define tags nos separadores Grupos/Famílias/Subfamílias." });
      res.end(); return;
    }

    const tagGroups = await fetchSpTagGroups(tagGroupIds);
    if (!tagGroups.length) {
      send({ type: "done", total: products.length, populated: 0, failed: 0, reason: "Tags não encontradas na base de dados." });
      res.end(); return;
    }

    const { populated, failed } = await runAiBulk(products, tagGroups, label, apiKey, isClosedFn, send, skipMapped);
    send({ type: "done", total: products.length, populated, failed });
    res.end();
  } catch (err: any) {
    send({ type: "error", message: err.message || "Erro interno do servidor" });
    res.end();
  }
}

// ── GET /ai-populate-subfamilia ───────────────────────────────────────────────

router.get("/ai-populate-subfamilia", (req: Request, res: Response) => {
  const directOnly = req.query.directOnly === "true";
  return handleBulkSse(req, res, directOnly);
});

// ── GET /ai-populate-familia ──────────────────────────────────────────────────

router.get("/ai-populate-familia", (req: Request, res: Response) => {
  const directOnly = req.query.directOnly === "true";
  return handleBulkSse(req, res, directOnly);
});

// ── GET /ai-populate-grupo ────────────────────────────────────────────────────

router.get("/ai-populate-grupo", (req: Request, res: Response) => {
  return handleBulkSse(req, res, false);
});

// ── POST /ai-populate-produto (single product, devolve sugestões) ─────────────

router.post("/ai-populate-produto", async (req: Request, res: Response) => {
  const ref         = String(req.body.ref || "").trim();
  const tagGroupIds: number[] = Array.isArray(req.body.tagGroupIds)
    ? req.body.tagGroupIds.map(Number).filter((n: number) => n > 0)
    : [];

  if (!ref)             return res.status(400).json({ error: "ref é obrigatório" });
  if (!tagGroupIds.length) return res.status(400).json({ error: "tagGroupIds é obrigatório" });

  const apiKey = (await loadConnectionSettings()).openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY não configurada no servidor." });

  try {
      const row = await getProductBySku(ref);
    if (!row) return res.status(404).json({ error: "Produto não encontrado" });

    const tagGroups = await fetchSpTagGroups(tagGroupIds);
    if (!tagGroups.length) return res.status(400).json({ error: "Nenhuma tag válida encontrada" });

    const diagLogs: { level: string; msg: string }[] = [];
    const dlog = (level: string, msg: string) => diagLogs.push({ level, msg });

    const sysPrompt = buildAiPopulateSystemPrompt(tagGroups, ref, await loadCustomPrompt());

    const userEntry: Record<string, any> = { ref, design: sanitize(row.name) };
    if (row.brand)             userEntry.marca           = sanitize(row.brand);
    if (row.cor)               userEntry.cor             = sanitize(row.cor);
    if (row.short_description) userEntry.descricao_curta = sanitize(row.short_description);
    if (row.description)       userEntry.descricao       = sanitize(row.description);

    dlog("info", `[IA-INPUT] ${ref}: design="${String(row.name || "").substring(0, 80)}"${row.brand ? ` | marca="${row.brand}"` : ""}`);
    dlog("info", `[IA-TAGS] ${tagGroups.length} tag(s): ${tagGroups.map(t => `"${t.nome}"(gid${t.id})`).join(", ")}`);

    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-nano",
      temperature: 0,
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user",   content: JSON.stringify([userEntry], null, 2) },
      ],
    });

    const raw = (completion.choices[0]?.message?.content ?? "").trim();
    dlog("info", `[IA-RAW] ${raw.substring(0, 500)}${raw.length > 500 ? "…" : ""}`);

    let parsed: { products: { ref: string; tags: { tag_group_id: number; value: string }[] }[] };
    try {
      const jsonStr = raw
        .replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "")
        .replace(/\r?\n/g, " ").replace(/\t/g, " ").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      dlog("error", `[IA-PARSE] JSON inválido: ${raw.substring(0, 200)}`);
      return res.status(502).json({ error: "Resposta da IA inválida. Tenta novamente.", logs: diagLogs });
    }

    if (!Array.isArray(parsed?.products)) {
      dlog("error", "[IA-PARSE] Campo 'products' ausente ou inválido");
      return res.status(502).json({ error: "Formato de resposta da IA inválido.", logs: diagLogs });
    }

    const aiValidIds = new Set(tagGroups.map(t => t.id));
    const prodResult = parsed.products.find(p => String(p.ref).trim() === ref.trim());
    const rawTags    = prodResult?.tags ?? [];
    if (!prodResult) dlog("warn", "[VALIDAR] IA não devolveu este produto");

    const result = validateAiValues(rawTags, tagGroups, aiValidIds);
    dlog("info", `[VALIDAR] [${rawTags.map((t: any) => `gid${t.tag_group_id}="${t.value}"`).join(", ")}] → [${result.map(t => `gid${t.tag_group_id}="${t.value}"`).join(", ")}]`);

    res.json({ tags: result, logs: diagLogs, model_used: "gpt-5.4-nano" });
  } catch (err: any) {
    if (err?.status === 401) return res.status(503).json({ error: "API key da OpenAI inválida." });
    if (err?.status === 429) return res.status(429).json({ error: "Limite de chamadas da OpenAI atingido." });
    console.error("[suprides/ai-populate] erro:", err);
    res.status(500).json({ error: err.message || "Erro interno do servidor" });
  }
});

export default router;
