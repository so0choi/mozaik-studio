import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface JobRow {
  id: string;
  owner: string;
  filename: string;
  createdAt: string; // ISO
}

export class JobRepo {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      filename TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, createdAt)');
  }

  insert(row: JobRow) {
    this.db
      .prepare('INSERT INTO jobs (id, owner, filename, createdAt) VALUES (@id, @owner, @filename, @createdAt)')
      .run(row);
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  listByOwner(owner: string): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs WHERE owner = ? ORDER BY createdAt DESC')
      .all(owner) as JobRow[];
  }

  listOlderThan(iso: string): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs WHERE createdAt < ?').all(iso) as JobRow[];
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  close() {
    if (this.db.open) this.db.close();
  }
}
