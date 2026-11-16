import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { dataPath } from "../utils/data-dir";

const DB_DIR = dataPath("suprides");
const DB_PATH = path.join(DB_DIR, "suprides.db");

let _db: Database.Database | null = null;

export function getSqlite(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");

  return _db;
}

export function closeSqlite(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
