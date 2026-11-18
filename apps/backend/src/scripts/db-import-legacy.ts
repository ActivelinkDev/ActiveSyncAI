/**
 * Copia os dados antigos (SQLite + ficheiros JSON + conta/registo de segurança) para o SQL Server.
 *
 *   npm run db:import-legacy              recusa se o SQL Server já tiver dados
 *   npm run db:import-legacy -- --replace apaga as tabelas de destino e volta a copiar
 *
 * Só lê os ficheiros antigos (não os apaga). Não toca no histórico de preços.
 */
import "dotenv/config";
import fs from "fs";
import { sql, type Kysely } from "kysely";
import { getMssql, closeMssql, mssqlConfigured } from "../db/mssql";
import { migrateMssql } from "../db/mssql-migrations";
import { dataPath } from "../utils/data-dir";

const REPLACE = process.argv.includes("--replace");

const TARGETS = [
  // ordem de apagar (filhos primeiro)
  "product_tags_normalized", "product_tags", "menu_tag_groups", "tag_values",
  "ai_tagged_products", "tag_groups", "products",
  "admin_settings", "connection_settings", "ai_prompts", "collection_margins", "line_mappings", "line_to_menu",
  "family_mappings", "collection_mapping", "collection_mapping_hidden", "menu_nodes", "sync_history",
  "sync_latest_products", "app_state", "app_account", "security_audit",
];

const readJson = (file: string): any => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
/** SQLite guarda datas como 'YYYY-MM-DD HH:MM:SS' (UTC) ou ISO; o SQL Server aceita ambos. */
const dt = (v: any): string | null => (v == null || v === "" ? null : String(v).replace("T", " ").replace("Z", "").slice(0, 23));

async function insertBatched(db: Kysely<any>, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).length;
  const per = Math.max(1, Math.min(1000, Math.floor(2000 / cols))); // limites: 2100 parâmetros e 1000 linhas por INSERT
  for (let i = 0; i < rows.length; i += per) await db.insertInto(table).values(rows.slice(i, i + per)).execute();
}

async function main() {
  if (!mssqlConfigured()) throw new Error("SQL Server não configurado (MSSQL_* no .env).");
  const db = getMssql();
  await migrateMssql(db);

  const sqlitePath = dataPath("suprides", "suprides.db");
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite não encontrado: ${sqlitePath}`);
  // Só o importador legado precisa do leitor SQLite integrado no Node 22.13+.
  const { DatabaseSync } = await import("node:sqlite");
  const lite = new DatabaseSync(sqlitePath, { readOnly: true });
  const all = (q: string) => lite.prepare(q).all() as any[];
  const counts: Record<string, number> = {};

  try {
    await db.transaction().setIsolationLevel("serializable").execute(async trx => {
      for (const table of TARGETS) {
        if (!REPLACE && await trx.selectFrom(table).select(sql.lit(1).as("present")).top(1).executeTakeFirst()) {
          throw new Error(`A tabela ${table} já contém dados. A importação inicial exige uma base vazia.`);
        }
      }
      if (REPLACE) {
        for (const table of ["products", "line_mappings", "line_to_menu", "family_mappings", "collection_mapping"]) {
          if (await trx.selectFrom(table).select("supplier").where("supplier", "!=", "suprides").top(1).executeTakeFirst()) {
            throw new Error("A base contém outros fornecedores. A substituição integral não é possível.");
          }
        }
        for (const table of TARGETS) await trx.deleteFrom(table).execute();
      }

      // ── Produtos ──
      const products = all(`SELECT * FROM suprides_products ORDER BY id`).map(r => ({
        supplier: "suprides", sku: r.sku, ean: r.ean, part_number: r.part_number, brand: r.brand, product_line: r.product_line,
        family: r.family, sub_family: r.sub_family, name: r.name, price: r.price, pvpr: r.pvpr, stock: r.stock,
        images: r.images, weight: r.weight, cor: r.cor, description: r.description, manufacturer: r.manufacturer,
        short_description: r.short_description, imported_at: dt(r.imported_at) ?? dt(new Date().toISOString()),
        updated_at: dt(r.updated_at) ?? dt(new Date().toISOString()), shopify_node_id: r.shopify_node_id,
        shopify_product_id: r.shopify_product_id, shopify_variant_id: r.shopify_variant_id,
        shopify_inventory_item_id: r.shopify_inventory_item_id, images_synced: r.images_synced ?? 0,
        stock_status: r.stock_status, removed_at: dt(r.removed_at), shopify_synced_at: dt(r.shopify_synced_at),
        shopify_content_hash: r.shopify_content_hash,
      }));
      await insertBatched(trx, "products", products); counts.produtos = products.length;

      // ── Tags (mantém os IDs dos grupos, porque as outras tabelas apontam para eles) ──
      const groups = all(`SELECT * FROM sp_tag_groups`);
      // SET IDENTITY_INSERT só vale dentro do mesmo pedido: SET + INSERT juntos.
      for (const g of groups) {
        await sql`SET IDENTITY_INSERT tag_groups ON;
          INSERT INTO tag_groups (id, nome, descricao, unidade, created_at)
          VALUES (${g.id}, ${g.nome}, ${g.descricao}, ${g.unidade}, ${dt(g.created_at)});
          SET IDENTITY_INSERT tag_groups OFF;`.execute(trx);
      }
      counts.grupos_tags = groups.length;
      const tv = all(`SELECT tag_group_id, value FROM sp_tag_values`);
      await insertBatched(trx, "tag_values", tv); counts.valores_tags = tv.length;
      const ptv = all(`SELECT sku, tag_group_id, value, updated_at FROM sp_product_tag_values`).map(r => ({ ...r, updated_at: dt(r.updated_at) }));
      await insertBatched(trx, "product_tags", ptv); counts.tags_produtos = ptv.length;
      const mtg = all(`SELECT shopify_id, tag_group_id FROM sp_menu_tag_groups`);
      await insertBatched(trx, "menu_tag_groups", mtg); counts.tags_menu = mtg.length;
      const ptvn = all(`SELECT product_ref, tag_group_id, normalized_value, updated_at FROM sp_product_tag_values_normalized`).map(r => ({ ...r, updated_at: dt(r.updated_at) }));
      await insertBatched(trx, "product_tags_normalized", ptvn); counts.tags_normalizadas = ptvn.length;
      const done = all(`SELECT sku, MAX(processed_at) AS processed_at FROM sp_populate_tags_done GROUP BY sku`).map(r => ({ ...r, processed_at: dt(r.processed_at) }));
      await insertBatched(trx, "ai_tagged_products", done); counts.tags_ia_processados = done.length;

      // ── Configuração (JSON) ──
      const sup = (f: string) => readJson(dataPath("suprides", f));

      const admin = sup("admin-settings.json") ?? {};
      await trx.insertInto("admin_settings").values({
        id: 1, iva_rate: admin.ivaRate ?? 23,
        rounding_above_unit_to_999: Number(admin.rounding?.aboveUnitTo999 ?? true),
        rounding_below_unit_to_499: Number(admin.rounding?.belowUnitTo499 ?? true),
        auto_publish_public_menu: admin.autoPublishPublicMenu == null ? null : admin.autoPublishPublicMenu ? 1 : 0,
        create_new_products: admin.createNewProducts == null ? null : admin.createNewProducts ? 1 : 0,
        public_menu_handle: admin.publicMenuHandle ?? null, public_menu_title: admin.publicMenuTitle ?? null,
      }).execute();

      const conn = sup("connection-settings.json") ?? {};
      await insertBatched(trx, "connection_settings", Object.entries(conn).map(([name, value]) => ({ name, value: value == null ? null : String(value) })));
      counts.ligacoes = Object.keys(conn).length;

      const prompt = sup("custom-prompt.json");
      if (prompt?.instructions) { await trx.insertInto("ai_prompts").values({ name: "suprides_instructions", text: prompt.instructions }).execute(); }

      const cm = sup("collection-margins.json")?.rules ?? {};
      await insertBatched(trx, "collection_margins", Object.entries<any>(cm).map(([collection_id, r], position) => ({ collection_id, mode: r.mode, margin_value: r.marginValue, title: r._title ?? null, position })));
      counts.margens_colecoes = Object.keys(cm).length;

      const mp = sup("mappings.json") ?? {};
      await insertBatched(trx, "line_mappings", (mp.suprides ?? []).map((l: any, i: number) => ({ supplier: "suprides", product_line: l.product_line, active: l.active === false ? 0 : 1, menu_item: l.menuItem ?? null, position: i })));
      await insertBatched(trx, "line_to_menu", Object.entries<any>(mp.lineToMenu ?? {}).map(([product_line, menu_target], position) => ({ supplier: "suprides", product_line, menu_target: String(menu_target), position })));
      await insertBatched(trx, "family_mappings", (mp.familyMappings ?? []).map((f: any, i: number) => ({ supplier: "suprides", product_line: f.product_line, family: f.family, active: f.active === false ? 0 : 1, shopify_level2: f.shopifyLevel2 ?? null, shopify_level3: f.shopifyLevel3 ?? null, position: i })));
      counts.linhas = (mp.suprides ?? []).length; counts.familias = (mp.familyMappings ?? []).length;

      const scm = sup("shopify-collection-mapping.json") ?? {};
      const cmRows: any[] = [];
      for (const level of ["menu", "familia", "subfamilia"]) {
        Object.entries<any>(scm[level] ?? {}).forEach(([key, ids], sourcePosition) => {
          [...new Set<string>((ids ?? []).map(String))].forEach((id, i) => cmRows.push({ supplier: "suprides", level, source_key: key, source_position: sourcePosition, collection_id: id, position: i }));
        });
      }
      await insertBatched(trx, "collection_mapping", cmRows); counts.mapeamento_colecoes = cmRows.length;
      const hidden = Object.entries<any>(scm.hidden ?? {}).filter(([, v]) => v).map(([hidden_key]) => ({ hidden_key }));
      await insertBatched(trx, "collection_mapping_hidden", hidden); counts.ocultos = hidden.length;

      // Menus (árvore): insere nível a nível para obter os IDs dos pais.
      const insertTree = async (menu: string, nodes: any[], parentId: number | null) => {
        for (let i = 0; i < (nodes ?? []).length; i++) {
          const n = nodes[i];
          const r: any = await trx.insertInto("menu_nodes").values({ menu, parent_id: parentId, position: i, title: n.title ?? "", shopify_id: n.shopifyId ?? null }).output("inserted.id").executeTakeFirst();
          counts[`menu_${menu}`] = (counts[`menu_${menu}`] ?? 0) + 1;
          await insertTree(menu, n.children ?? [], r.id);
        }
      };
      await insertTree("main", sup("menu-items.json")?.nodes ?? [], null);
      const pub = sup("public-menu-items.json");
      await insertTree("public", pub?.nodes ?? [], null);

      const stats = sup("sync-stats.json");
      if (stats) {
        await insertBatched(trx, "sync_history", (stats.history ?? []).map((h: any) => ({ ran_at: dt(h.timestamp), requested: h.requested ?? 0, synced: h.synced ?? 0, created: h.created ?? 0, updated: h.updated ?? 0, errors: h.errors ?? 0 })));
        await insertBatched(trx, "sync_latest_products", (stats.latestProducts ?? []).map((p: any, i: number) => ({ position: i, sku: p.sku, title: p.title ?? null, action: p.action ?? null, synced_at: dt(p.syncedAt) })));
        counts.historico_syncs = (stats.history ?? []).length;
      }
      const state: [string, unknown][] = [
        ["sync_stats", stats ? { api: stats.api, lastSyncAt: stats.lastSyncAt, totals: stats.totals } : null],
        ["sync_run", sup("sync-run.json")],
        ["public_menu_stats", pub?.stats ?? null],
        ["scheduler_state", readJson(dataPath("scheduler-state.json"))],
      ];
      await insertBatched(trx, "app_state", state.filter(([, v]) => v != null).map(([name, v]) => ({ name, value: JSON.stringify(v) })));

      // ── Segurança ──
      const acc = readJson(dataPath("security", "account.json"));
      if (acc?.username) { await trx.insertInto("app_account").values({ username: acc.username, password_hash: acc.passwordHash, changed_at: dt(acc.changedAt) }).execute(); counts.conta = 1; }
      const auditFile = dataPath("logs", "security-audit.log");
      if (fs.existsSync(auditFile)) {
        const rows = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          .map((a: any) => ({ ts: dt(a.ts), event: String(a.event).slice(0, 40), ip: a.ip ?? null, username: a.user ?? null, detail: a.detail ?? null }));
        await insertBatched(trx, "security_audit", rows); counts.registo_seguranca = rows.length;
      }
    });
  } finally { lite.close(); }
  console.log("Copiado para o SQL Server:");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
}

main().catch(e => { console.error("Falhou:", e?.message ?? e); process.exitCode = 1; }).finally(() => closeMssql());
