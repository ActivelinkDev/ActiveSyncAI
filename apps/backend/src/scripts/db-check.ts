/**
 * Testa a ligação ao SQL Server e confirma que o utilizador da app só vê a sua base de dados.
 *   npm run db:check
 */
import "dotenv/config";
import { sql } from "kysely";
import { getMssql, closeMssql, mssqlConfigured } from "../db/mssql";

(async () => {
  if (!mssqlConfigured()) {
    console.error("Falta configurar no .env: MSSQL_SERVER, MSSQL_INSTANCE (ou MSSQL_PORT), MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD.");
    process.exit(1);
  }
  const db = getMssql();
  try {
    const info = (await sql<any>`SELECT DB_NAME() AS base, SUSER_SNAME() AS utilizador,
        CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS versao,
        CAST(SERVERPROPERTY('Edition') AS nvarchar(100)) AS edicao,
        CAST(CONNECTIONPROPERTY('net_transport') AS nvarchar(40)) AS transporte`.execute(db)).rows[0];
    console.log(`Ligado: base ${info.base}, utilizador ${info.utilizador}, SQL Server ${info.versao} (${info.edicao}), via ${info.transporte}, ligação cifrada (MSSQL_ENCRYPT=${process.env.MSSQL_ENCRYPT ?? "1"})`);

    const roles = (await sql<any>`SELECT r.name FROM sys.database_role_members m
        JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
        WHERE m.member_principal_id = USER_ID()`.execute(db)).rows.map((r: any) => r.name);
    console.log(`Permissões nesta base: ${roles.join(", ") || "(nenhuma)"}`);

    const others = (await sql<any>`SELECT name FROM sys.databases
        WHERE database_id > 4 AND name <> DB_NAME() AND HAS_DBACCESS(name) = 1`.execute(db)).rows;
    const sysadmin = (await sql<any>`SELECT IS_SRVROLEMEMBER('sysadmin') AS s`.execute(db)).rows[0].s;
    if (others.length || sysadmin === 1) {
      console.log(`⚠️  O utilizador tem acesso a mais do que esta base (${others.length} outras${sysadmin === 1 ? ", e é sysadmin" : ""}). Rever permissões.`);
      process.exitCode = 2;
    } else {
      console.log("Isolamento OK: o utilizador não tem acesso a nenhuma outra base de dados da instância.");
    }

    // Escrita de teste (tabela temporária, desaparece no fim da sessão)
    await sql`CREATE TABLE #teste (id int); INSERT INTO #teste VALUES (1); DROP TABLE #teste;`.execute(db);
    console.log("Escrita de teste OK.");
  } catch (e: any) {
    console.error("Falhou:", e?.message ?? e);
    process.exitCode = 1;
  } finally {
    await closeMssql();
  }
})();
