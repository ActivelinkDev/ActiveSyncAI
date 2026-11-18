import { Router } from "express";
import { sql } from "kysely";
import { getMssql } from "../db/mssql";
import { loadStats } from "../suprides/repositories/store";

const router = Router();

router.get("/summary", async (_req, res) => {
  try {
    const db = getMssql();
    const [counts, lines, families, stats] = await Promise.all([
      sql<{ total: number; synced: number; withTags: number }>`
        SELECT COUNT(*) AS total, COUNT(shopify_product_id) AS synced,
          (SELECT COUNT(DISTINCT t.sku) FROM product_tags t JOIN products p ON p.sku = t.sku
            WHERE p.supplier = 'suprides') AS withTags
        FROM products WHERE supplier = 'suprides'
      `.execute(db),
      sql<{ name: string; count: number }>`
        SELECT TOP (12) COALESCE(product_line, N'Sem linha') AS name, COUNT(*) AS count
        FROM products WHERE supplier = 'suprides' GROUP BY product_line ORDER BY count DESC, product_line
      `.execute(db),
      sql<{ name: string; count: number }>`
        SELECT TOP (10) COALESCE(family, N'Sem família') AS name, COUNT(*) AS count
        FROM products WHERE supplier = 'suprides' GROUP BY family ORDER BY count DESC, family
      `.execute(db),
      loadStats(),
    ]);
    const { total, synced, withTags } = counts.rows[0];
    const byProductLine = lines.rows;
    const byFamily = families.rows;
    const tagCoverage = total > 0 ? Math.round((withTags / total) * 100) : 0;
    const lastSync = stats.lastSyncAt;
    let lastSyncStatus: 'ok' | 'error' | null = null;
    if (lastSync && stats.history.length > 0) {
      const last = stats.history[stats.history.length - 1];
      lastSyncStatus = last.synced > 0 ? 'ok' : 'error';
    }

    res.json({
      totalProducts:   total,
      syncedProducts:  synced,
      productsWithTags: withTags,
      tagCoverage,
      lastSync,
      lastSyncStatus,
      byProductLine,
      byFamily,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
