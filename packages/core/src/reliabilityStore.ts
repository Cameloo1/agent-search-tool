import type { NormalizedChunk } from "@agent-search/shared";
import { SOURCE_TYPE_WEIGHTS } from "@agent-search/shared";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ReliabilityOutcome = "confirmed" | "contradicted" | "repeated" | "observed";

export interface SourceReliabilityRecord {
  source_name: string;
  domain: string;
  alpha: number;
  beta: number;
  score: number;
  observations: number;
}

export interface SourceReliabilityStore {
  initialize(): Promise<void>;
  getRecord(sourceName: string, domain: string, prior: number): Promise<SourceReliabilityRecord>;
  update(sourceName: string, domain: string, outcome: ReliabilityOutcome, prior: number): Promise<SourceReliabilityRecord>;
  close?(): Promise<void>;
}

export class InMemoryReliabilityStore implements SourceReliabilityStore {
  private readonly records = new Map<string, SourceReliabilityRecord>();

  async initialize(): Promise<void> {}

  async getRecord(sourceName: string, domain: string, prior: number): Promise<SourceReliabilityRecord> {
    const key = recordKey(sourceName, domain);
    const existing = this.records.get(key);
    if (existing) return existing;
    const created = createPriorRecord(sourceName, domain, prior);
    this.records.set(key, created);
    return created;
  }

  async update(sourceName: string, domain: string, outcome: ReliabilityOutcome, prior: number): Promise<SourceReliabilityRecord> {
    const current = await this.getRecord(sourceName, domain, prior);
    const next = applyOutcome(current, outcome);
    this.records.set(recordKey(sourceName, domain), next);
    return next;
  }
}

export class SQLiteReliabilityStore implements SourceReliabilityStore {
  private db?: any;

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const sqlite = await dynamicImport("node:sqlite");
    this.db = new sqlite.DatabaseSync(this.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_reliability (
        source_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        alpha REAL NOT NULL,
        beta REAL NOT NULL,
        observations INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_name, domain)
      );
    `);
  }

  async getRecord(sourceName: string, domain: string, prior: number): Promise<SourceReliabilityRecord> {
    this.assertDb();
    const row = this.db
      .prepare("SELECT source_name, domain, alpha, beta, observations FROM source_reliability WHERE source_name = ? AND domain = ?")
      .get(sourceName, domain);
    if (row) return rowToRecord(row);
    const created = createPriorRecord(sourceName, domain, prior);
    this.upsert(created);
    return created;
  }

  async update(sourceName: string, domain: string, outcome: ReliabilityOutcome, prior: number): Promise<SourceReliabilityRecord> {
    const current = await this.getRecord(sourceName, domain, prior);
    const next = applyOutcome(current, outcome);
    this.upsert(next);
    return next;
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  private upsert(record: SourceReliabilityRecord): void {
    this.assertDb();
    this.db
      .prepare(
        `INSERT INTO source_reliability (source_name, domain, alpha, beta, observations, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_name, domain)
         DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta, observations = excluded.observations, updated_at = excluded.updated_at`
      )
      .run(record.source_name, record.domain, record.alpha, record.beta, record.observations, new Date().toISOString());
  }

  private assertDb(): void {
    if (!this.db) throw new Error("SQLiteReliabilityStore.initialize() must be called before use.");
  }
}

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

export async function createReliabilityStore(path?: string): Promise<SourceReliabilityStore> {
  if (!path) {
    const store = new InMemoryReliabilityStore();
    await store.initialize();
    return store;
  }
  try {
    const store = new SQLiteReliabilityStore(path);
    await store.initialize();
    return store;
  } catch {
    const store = new InMemoryReliabilityStore();
    await store.initialize();
    return store;
  }
}

export async function applyReliabilityScores(
  chunks: NormalizedChunk[],
  store: SourceReliabilityStore,
  domain: string
): Promise<NormalizedChunk[]> {
  const adjusted: NormalizedChunk[] = [];
  for (const chunk of chunks) {
    const prior = SOURCE_TYPE_WEIGHTS[chunk.metadata.source_type] ?? chunk._internal.source_weight;
    const record = await store.getRecord(chunk.metadata.source_name, domain, prior);
    adjusted.push({
      ...chunk,
      _internal: {
        ...chunk._internal,
        source_weight: Math.max(0.05, Math.min(1, (chunk._internal.source_weight + record.score) / 2))
      }
    });
  }
  return adjusted;
}

export async function observeSelectedChunks(
  chunks: NormalizedChunk[],
  store: SourceReliabilityStore,
  domain: string,
  outcome: ReliabilityOutcome = "observed"
): Promise<void> {
  for (const chunk of chunks) {
    const prior = SOURCE_TYPE_WEIGHTS[chunk.metadata.source_type] ?? chunk._internal.source_weight;
    await store.update(chunk.metadata.source_name, domain, outcome, prior);
  }
}

function createPriorRecord(sourceName: string, domain: string, prior: number): SourceReliabilityRecord {
  const clamped = Math.max(0.05, Math.min(0.95, prior));
  const strength = 6;
  const alpha = clamped * strength;
  const beta = (1 - clamped) * strength;
  return {
    source_name: sourceName,
    domain,
    alpha,
    beta,
    score: alpha / (alpha + beta),
    observations: 0
  };
}

function applyOutcome(record: SourceReliabilityRecord, outcome: ReliabilityOutcome): SourceReliabilityRecord {
  const deltas = {
    confirmed: [1, 0],
    contradicted: [0, 1],
    repeated: [0.2, 0.1],
    observed: [0.05, 0.05]
  } satisfies Record<ReliabilityOutcome, [number, number]>;
  const [alphaDelta, betaDelta] = deltas[outcome];
  const alpha = record.alpha + alphaDelta;
  const beta = record.beta + betaDelta;
  return {
    ...record,
    alpha,
    beta,
    score: alpha / (alpha + beta),
    observations: record.observations + 1
  };
}

function rowToRecord(row: Record<string, unknown>): SourceReliabilityRecord {
  const alpha = Number(row.alpha);
  const beta = Number(row.beta);
  return {
    source_name: String(row.source_name),
    domain: String(row.domain),
    alpha,
    beta,
    score: alpha / (alpha + beta),
    observations: Number(row.observations)
  };
}

function recordKey(sourceName: string, domain: string): string {
  return `${sourceName}:${domain}`;
}
