import { mkdirSync, openSync, closeSync, lstatSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
export class AgentStore {
    database;
    constructor(file) {
        const require = createRequire(import.meta.url);
        const { DatabaseSync } = require('node:sqlite');
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        try {
            closeSync(openSync(file, 'wx', 0o600));
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        if (!lstatSync(file).isFile())
            throw new Error('Agent database must be a regular file.');
        if (process.platform !== 'win32')
            chmodSync(file, 0o600);
        this.database = new DatabaseSync(file);
        this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_feedback ON feedback (json_extract(data, '$.runId'));
      CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_safety_events (
        seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, at INTEGER NOT NULL,
        state TEXT NOT NULL, approval_id TEXT, currency TEXT, maximum INTEGER, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tool_safety_usage ON tool_safety_events (agent_id, state);
      CREATE UNIQUE INDEX IF NOT EXISTS tool_safety_approval_events
        ON tool_safety_events (approval_id, state) WHERE approval_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS tool_safety_no_update BEFORE UPDATE ON tool_safety_events
        BEGIN SELECT RAISE(ABORT, 'Tool safety journal is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS tool_safety_no_delete BEFORE DELETE ON tool_safety_events
        BEGIN SELECT RAISE(ABORT, 'Tool safety journal is append-only'); END;
      CREATE INDEX IF NOT EXISTS agent_runs ON runs (json_extract(data, '$.agentId'));
      CREATE INDEX IF NOT EXISTS run_queue ON runs (json_extract(data, '$.status'), json_extract(data, '$.createdAt'));
      CREATE INDEX IF NOT EXISTS routine_due ON routines (json_extract(data, '$.nextAt'));
      CREATE INDEX IF NOT EXISTS quote_expiry ON quotes (json_extract(data, '$.expiresAt'));
    `);
    }
    get db() {
        if (!this.database)
            throw new Error('Agent database is closed.');
        return this.database;
    }
    close() {
        this.database?.close();
        this.database = undefined;
    }
    bind(identity) {
        this.db.prepare("INSERT OR IGNORE INTO metadata (id, value) VALUES ('network', ?)").run(identity);
        if (this.db.prepare("SELECT value FROM metadata WHERE id = 'network'").get()?.value !== identity) {
            this.close();
            throw new Error('Agent database belongs to a different network, account, or currency.');
        }
    }
    transaction(operation) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    get(table, id) {
        const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
        return row ? JSON.parse(String(row.data)) : undefined;
    }
    set(table, value) {
        this.db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`)
            .run(value.id, JSON.stringify(value));
        return value;
    }
    query(sql, ...params) {
        return this.db.prepare(sql).all(...params).map(row => JSON.parse(String(row.data)));
    }
    run(sql, ...params) {
        this.db.prepare(sql).run(...params);
    }
    totals(agentId) {
        const row = this.db.prepare(`
      SELECT coalesce(sum(json_extract(data, '$.paid')), 0) AS paid,
             coalesce(sum(json_extract(data, '$.reserved')), 0) AS reserved
      FROM runs WHERE json_extract(data, '$.agentId') = ?
    `).get(agentId);
        return { paid: Number(row.paid), reserved: Number(row.reserved) };
    }
}
