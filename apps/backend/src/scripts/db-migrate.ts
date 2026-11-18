/** Aplica as migrações do SQL Server.  npm run db:migrate */
import "dotenv/config";
import { migrateMssql } from "../db/mssql-migrations";
import { closeMssql, mssqlConfigured } from "../db/mssql";

(async () => {
  if (!mssqlConfigured()) { console.error("SQL Server não configurado (MSSQL_* no .env)."); process.exit(1); }
  try {
    const { applied } = await migrateMssql();
    console.log(applied.length ? `Migrações aplicadas: ${applied.join(", ")}` : "Base de dados já atualizada.");
  } catch (e: any) { console.error("Falhou:", e?.message ?? e); process.exitCode = 1; }
  finally { await closeMssql(); }
})();
