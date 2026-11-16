import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { getSqlite } from "../../db/sqlite";
import {
  resolveTagGroupsForNode,
  upsertProductTagValue,
  isPopulateDone,
  markPopulateDone,
  getProductTagValues,
} from "../../suprides/repositories/tags";
import { getAncestors, getDescendants } from "../services/menu-resolver";
import { loadCustomPrompt, loadConnectionSettings } from "../repositories/store";
import {
  buildAiPopulateSystemPrompt,
  setupSse,
  validateAiValues,
  type TGV,
} from "../../suprides/routes/ai-populate";

const router = Router();
const SUPPLIER = "esprinet";
const BATCH_SIZE = 4;
const MAX_TEXT = 2500;

function sanitize(s: string | null | undefined): string {
  return (s || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").substring(0, MAX_TEXT);
}

function fetchSpTagGroups(tagGroupIds: number[]): TGV[] {
  const db = getSqlite();
  const groups: TGV[] = [];
  for (const id of tagGroupIds) {
    const g = db.prepare(
      "SELECT id, nome, descricao, unidade FROM sp_tag_groups WHERE id = ? AND supplier = ?"
    ).get(id, SUPPLIER) as any;
    if (!g) continue;
    const vals = db.prepare(
      "SELECT value FROM sp_tag_values WHERE tag_group_id = ? ORDER BY value"
    ).all(id) as { value: string }[];
    groups.push({
      id: g.id,
      nome: g.nome,
      descricao: g.descricao,
      unidade: g.unidade ?? null,
      values: vals.map(v => v.value),
    });
  }
  return groups;
}

function getProductsForNode(shopifyId: string, directOnly: boolean): { sku: string; name: string }[] {
  const db = getSqlite();
  if (directOnly) {
    return db.prepare(
      "SELECT sku, COALESCE(name, sku) AS name FROM esprinet_products WHERE shopify_node_id = ? ORDER BY name"
    ).all(shopifyId) as { sku: string; name: string }[];
  }
  const ids = getDescendants(shopifyId);
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(
    `SELECT sku, COALESCE(name, sku) AS name FROM esprinet_products WHERE shopify_node_id IN (${ph}) ORDER BY name`
  ).all(...ids) as { sku: string; name: string }[];
}

async function runAiBulk(
  products: { sku: string; name: string }[],
  tagGroups: TGV[],
  label: string,
  apiKey: string,
  isClosedFn: () => boolean,
  send: (d: object) => void,
  skipMapped = false,
): Promise<{ populated: number; failed: number }> {
  const openai = new OpenAI({ apiKey });
  const aiValidIds = new Set(tagGroups.map(t => t.id));
  const sysPrompt = buildAiPopulateSystemPrompt(tagGroups, label, loadCustomPrompt());
  const db = getSqlite();
  let populated = 0;
  let failed = 0;
  let globalIdx = 0;
  send({ type: "start", total: products.length });

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    if (isClosedFn()) break;
    const batch = products.slice(i, i + BATCH_SIZE);
    const batchReady: { prod: { sku: string; name: string }; row: any }[] = [];

    for (const prod of batch) {
      globalIdx++;
      if (skipMapped && isPopulateDone(prod.sku, SUPPLIER)) {
        send({ type: "log", level: "info", ref: prod.sku, msg: `[SKIP] ${prod.sku} ja processado` });
        continue;
      }
      send({ type: "progress", current: globalIdx, total: products.length, ref: prod.sku, design: prod.name });
      const row = db.prepare(
        "SELECT brand, name, cor, description, short_description FROM esprinet_products WHERE sku = ?"
      ).get(prod.sku) as any;
      if (!row) {
        failed++;
        continue;
      }
      batchReady.push({ prod, row });
    }

    if (!batchReady.length) continue;

    const userPayload = batchReady.map(({ prod, row }) => {
      const entry: Record<string, any> = { ref: prod.sku, design: sanitize(row.name) };
      if (row.brand) entry.marca = sanitize(row.brand);
      if (row.cor) entry.cor = sanitize(row.cor);
      if (row.short_description) entry.descricao_curta = sanitize(row.short_description);
      if (row.description) entry.descricao = sanitize(row.description);
      return entry;
    });

    let rawContent = "";
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-5.4-nano",
        temperature: 0,
        max_completion_tokens: 4096,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: JSON.stringify(userPayload, null, 2) },
        ],
      });
      rawContent = (completion.choices[0]?.message?.content ?? "").trim();
    } catch (e: any) {
      send({ type: "log", level: "error", ref: batchReady.map(b => b.prod.sku).join("+"), msg: `[IA-ERRO] ${e?.message ?? e}` });
      failed += batchReady.length;
      continue;
    }

    const cleaned = rawContent.replace(/^```[^\n]*\n?/m, "").replace(/```\s*$/m, "").replace(/\r?\n/g, " ").replace(/\t/g, " ").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      failed += batchReady.length;
      continue;
    }

    let parsed: { products: { ref: string; tags: { tag_group_id: number; value: string }[] }[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed?.products)) throw new Error("products invalido");
    } catch {
      failed += batchReady.length;
      continue;
    }

    for (const { prod } of batchReady) {
      try {
        const prodResult = parsed.products.find(p => String(p.ref).trim() === prod.sku.trim());
        const values = validateAiValues(prodResult?.tags ?? [], tagGroups, aiValidIds);
        const existing = getProductTagValues(prod.sku);
        const existingMap = new Map(existing.map(e => [e.tag_group_id, e.value]));
        for (const { tag_group_id, value } of values) {
          if (!value.trim() || existingMap.has(tag_group_id)) continue;
          upsertProductTagValue(prod.sku, tag_group_id, value);
        }
        markPopulateDone(prod.sku, SUPPLIER);
        populated++;
      } catch {
        failed++;
      }
    }
  }

  return { populated, failed };
}

async function handleBulkSse(req: Request, res: Response, directOnly: boolean): Promise<void> {
  const shopifyId = String(req.query.shopifyId || "").trim();
  const skipMapped = req.query.skipMapped === "true";
  const label = String(req.query.label || shopifyId).trim();
  const { send, isClosedFn } = setupSse(res, req);

  if (!shopifyId) { send({ type: "error", message: "shopifyId e obrigatorio" }); res.end(); return; }
  const apiKey = loadConnectionSettings().openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) { send({ type: "error", message: "OPENAI_API_KEY nao configurada no servidor." }); res.end(); return; }

  try {
    const products = getProductsForNode(shopifyId, directOnly);
    if (!products.length) {
      send({ type: "done", total: 0, populated: 0, failed: 0, reason: "Nenhum produto neste no de menu." });
      res.end(); return;
    }
    const tagGroupIds = resolveTagGroupsForNode(shopifyId, SUPPLIER, getAncestors(shopifyId));
    if (!tagGroupIds.length) {
      send({ type: "done", total: products.length, populated: 0, failed: 0, reason: "Nenhuma tag definida para este no." });
      res.end(); return;
    }
    const tagGroups = fetchSpTagGroups(tagGroupIds);
    const { populated, failed } = await runAiBulk(products, tagGroups, label, apiKey, isClosedFn, send, skipMapped);
    send({ type: "done", total: products.length, populated, failed });
    res.end();
  } catch (err: any) {
    send({ type: "error", message: err.message || "Erro interno do servidor" });
    res.end();
  }
}

router.get("/ai-populate-subfamilia", (req: Request, res: Response) => handleBulkSse(req, res, req.query.directOnly === "true"));
router.get("/ai-populate-familia", (req: Request, res: Response) => handleBulkSse(req, res, req.query.directOnly === "true"));
router.get("/ai-populate-grupo", (req: Request, res: Response) => handleBulkSse(req, res, false));

router.post("/ai-populate-produto", async (req: Request, res: Response) => {
  const ref = String(req.body.ref || "").trim();
  const tagGroupIds: number[] = Array.isArray(req.body.tagGroupIds)
    ? req.body.tagGroupIds.map(Number).filter((n: number) => n > 0)
    : [];
  if (!ref) return res.status(400).json({ error: "ref e obrigatorio" });
  if (!tagGroupIds.length) return res.status(400).json({ error: "tagGroupIds e obrigatorio" });

  const apiKey = loadConnectionSettings().openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY nao configurada no servidor." });

  try {
    const row = getSqlite().prepare(
      "SELECT brand, name, cor, description, short_description FROM esprinet_products WHERE sku = ?"
    ).get(ref) as any;
    if (!row) return res.status(404).json({ error: "Produto nao encontrado" });

    const tagGroups = fetchSpTagGroups(tagGroupIds);
    const sysPrompt = buildAiPopulateSystemPrompt(tagGroups, ref, loadCustomPrompt());
    const userEntry: Record<string, any> = { ref, design: sanitize(row.name) };
    if (row.brand) userEntry.marca = sanitize(row.brand);
    if (row.cor) userEntry.cor = sanitize(row.cor);
    if (row.short_description) userEntry.descricao_curta = sanitize(row.short_description);
    if (row.description) userEntry.descricao = sanitize(row.description);

    const completion = await new OpenAI({ apiKey }).chat.completions.create({
      model: "gpt-5.4-nano",
      temperature: 0,
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: JSON.stringify([userEntry], null, 2) },
      ],
    });
    const raw = (completion.choices[0]?.message?.content ?? "").trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").replace(/\r?\n/g, " ").replace(/\t/g, " ").trim();
    const parsed = JSON.parse(jsonStr);
    const aiValidIds = new Set(tagGroups.map(t => t.id));
    const prodResult = parsed.products?.find((p: any) => String(p.ref).trim() === ref.trim());
    res.json({ tags: validateAiValues(prodResult?.tags ?? [], tagGroups, aiValidIds), logs: [], model_used: "gpt-5.4-nano" });
  } catch (err: any) {
    if (err?.status === 401) return res.status(503).json({ error: "API key da OpenAI invalida." });
    if (err?.status === 429) return res.status(429).json({ error: "Limite de chamadas da OpenAI atingido." });
    res.status(500).json({ error: err.message || "Erro interno do servidor" });
  }
});

export default router;
