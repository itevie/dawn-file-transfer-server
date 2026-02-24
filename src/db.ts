import Database from "better-sqlite3";
import path from "node:path";
import fs, { existsSync } from "node:fs";
import config from "./config";

let dbPath = config.dataPath + "/data.db";
console.log(`Path is ${dbPath}`);

if (!existsSync(path.dirname(dbPath)))
  fs.mkdirSync(dbPath, { recursive: true });

export const db = new Database(dbPath);

// db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export interface DawnFile {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  added_at: string;
}

export interface AccessCode {
  code: string;
  file: string;
  added_at: string;
  expires: number;
}

export interface AccessLink {
  code: string;
  file: string;
  added_at: string;
  expires: number;
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      added_at TEXT NOT NULL,
      size INT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_codes (
      code TEXT PRIMARY KEY,
      file TEXT REFERENCES files(id) NOT NULL,
      added_at TEXT NOT NULL,
      expires INT NOT NULL,
      FOREIGN KEY(file) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS access_links (
      code TEXT PRIMARY KEY,
      file TEXT REFERENCES files(id) NOT NULL,
      added_at TEXT NOT NULL,
      expires INT NOT NULL,
      FOREIGN KEY(file) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_access_codes_file ON access_codes(file);
    CREATE INDEX IF NOT EXISTS idx_access_links_file ON access_links(file);
  `);
}
