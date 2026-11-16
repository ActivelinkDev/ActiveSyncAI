import path from "path";

/**
 * Pasta raiz dos dados (SQLite + configs JSON).
 * - DATA_DIR no .env (recomendado em servidor, caminho absoluto); ou
 * - apps/backend/data, resolvido a partir deste ficheiro (funciona em src/ e dist/),
 *   independentemente da pasta onde o processo é arrancado.
 */
export const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "..", "data");

export function dataPath(...parts: string[]): string {
  return path.join(DATA_ROOT, ...parts);
}
