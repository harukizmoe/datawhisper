/**
 * Compact Skill catalog with embedding retrieval: per-description embedding cache, three ranking
 * channels (vector, lexical, name) fused with weighted Reciprocal Rank Fusion, then a threshold filter.
 *
 * Port of `agent/skill_discovery.py`. The embedding model itself is not part of this port: callers
 * pass an {@link Embedder} (the Python code used `Function.Knowledge.neural_embedder`). There is no
 * turn-based TTL in the Python implementation; the catalog is rebuilt and searched per user message.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PY_SPACE, isMapping, pyCompare, pyHead, pyRound, pyStrip } from "./py-compat.ts";

/** Embedding backend. Vectors are expected L2-normalised (cosine == dot product), as in Python. */
export type Embedder = {
  /** Identifies backend/model/dimension; a change invalidates every cached vector. */
  signature(): string;
  embedBatch(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

/** Persistent `content hash → vector` store, valid for one embedder signature. */
export type EmbeddingCacheStore = {
  load(signature: string): Record<string, number[]>;
  save(signature: string, entries: Record<string, number[]>): void;
};

export type SkillCatalogInput = { name?: string; description?: string; tags?: readonly string[] };

export type CatalogEntry = Readonly<{
  name: string;
  description: string;
  tags: readonly string[];
  text: string;
  embedding: readonly number[];
}>;

export type SkillMatch = CatalogEntry &
  Readonly<{ rrfScore: number; vectorScore: number; nameScore: number; hybridScore: number }>;

/** JSON file cache (`{"signature": ..., "entries": {...}}`), written atomically; unreadable → empty. */
export function createFileEmbeddingCache(path: string): EmbeddingCacheStore {
  return {
    load(signature) {
      try {
        const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isMapping(payload) || payload.signature !== signature) return {};
        return isMapping(payload.entries) ? (payload.entries as Record<string, number[]>) : {};
      } catch {
        return {};
      }
    },
    save(signature, entries) {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify({ signature, entries }), "utf8");
      renameSync(temp, path);
    },
  };
}

let cacheChain: Promise<unknown> = Promise.resolve();

/** Builds the catalog, embedding only descriptions whose content hash is not cached. */
export async function buildSkillCatalog(
  skills: readonly SkillCatalogInput[],
  embedder: Embedder,
  cache: EmbeddingCacheStore,
): Promise<{ catalog: CatalogEntry[]; rebuilt: number; total: number }> {
  const entries: { name: string; description: string; tags: string[]; text: string; hash: string }[] = [];
  for (const skill of skills) {
    const name = skill.name || "";
    if (!name) continue;
    const description = skill.description || "";
    const tags = (skill.tags ?? []).map(String).filter(Boolean);
    const text = `${name} ${description} ${tags.join(" ")}`;
    entries.push({
      name,
      description: pyHead(description, 200),
      tags,
      text,
      hash: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }

  const run = async () => {
    const signature = embedder.signature();
    const cached = cache.load(signature);
    const stale = entries.filter((entry) => !Object.hasOwn(cached, entry.hash));
    if (stale.length > 0) {
      const vectors = await embedder.embedBatch(stale.map((entry) => entry.text));
      stale.forEach((entry, index) => {
        const vector = vectors[index];
        if (vector !== undefined) cached[entry.hash] = vector;
      });
    }
    const current: Record<string, number[]> = {};
    for (const entry of entries) if (Object.hasOwn(cached, entry.hash)) current[entry.hash] = cached[entry.hash]!;
    if (stale.length > 0 || Object.keys(current).length !== Object.keys(cached).length) cache.save(signature, current);
    return { current, rebuilt: stale.length };
  };
  const result = cacheChain.then(run);
  cacheChain = result.catch(() => undefined);
  const { current, rebuilt } = await result;

  const catalog: CatalogEntry[] = [];
  for (const { hash, ...entry } of entries) {
    const vector = current[hash];
    if (vector && vector.length > 0) catalog.push({ ...entry, embedding: vector });
  }
  catalog.sort((a, b) => pyCompare(a.name, b.name));
  return { catalog, rebuilt, total: entries.length };
}

function lexicalTokens(text: string): string[] {
  const tokens: string[] = text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  const runs: string[] = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  tokens.push(...runs);
  for (const run of runs) for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  return tokens;
}

/** Lightweight lexical overlap score. */
export function lexicalScore(query: string, text: string): number {
  const q = pyStrip((query || "").toLowerCase());
  const t = (text || "").toLowerCase();
  if (!q || !t) return 0;
  let score = 0;
  if (t.includes(q)) score += 1.2;
  const queryTokens = new Set(lexicalTokens(q));
  const textTokens = new Set(lexicalTokens(t));
  if (queryTokens.size > 0) {
    let overlap = 0;
    for (const token of queryTokens) if (textTokens.has(token)) overlap++;
    score += (0.8 * overlap) / Math.max(1, queryTokens.size);
  }
  return pyRound(score, 4);
}

const NAME_SEPARATORS = new RegExp(`[_\\-${PY_SPACE}]+`);

export function nameBonus(name: string, query: string): number {
  const nameLower = name.toLowerCase();
  const queryLower = query.toLowerCase();
  let score = 0;
  if (queryLower.includes(nameLower)) score += 2.0;
  for (const part of nameLower.split(NAME_SEPARATORS)) {
    if (part && [...part].length >= 3 && queryLower.includes(part)) {
      score += 0.8;
      break;
    }
  }
  return score;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Stable descending sort by score (`sort(key=lambda x: -x[0])`). */
function rankDescending<T>(items: readonly T[], score: (item: T) => number): [number, T][] {
  return items.map((item): [number, T] => [score(item), item]).sort((a, b) => b[0] - a[0]);
}

/** Weighted RRF: vector 3x (primary signal), name 2x (exact hit is strong), lexical 1x. */
function rrfFuse(vec: readonly CatalogEntry[], lex: readonly CatalogEntry[], name: readonly CatalogEntry[], limit: number) {
  const k = 60;
  const scores = new Map<string, number>();
  const items = new Map<string, CatalogEntry>();
  for (const [ranked, weight] of [
    [vec, 3.0],
    [lex, 1.0],
    [name, 2.0],
  ] as const) {
    ranked.forEach((item, rank) => {
      if (!item.name) return;
      scores.set(item.name, (scores.get(item.name) ?? 0) + weight / (k + rank));
      items.set(item.name, item);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, score]) => ({ ...items.get(key)!, rrfScore: pyRound(score, 6) }));
}

/** At most `limit` skills ranked by embedding + lexical + name channels with RRF and a noise threshold. */
export async function searchSkillCatalog(
  catalog: readonly CatalogEntry[],
  query: string,
  embedder: Pick<Embedder, "embedQuery">,
  limit = 5,
): Promise<SkillMatch[]> {
  const queryRaw = pyStrip(query || "");
  if (!queryRaw || catalog.length === 0) return [];
  const queryVector = await embedder.embedQuery(queryRaw);

  const vecRanked = rankDescending(catalog, (item) => (item.embedding.length > 0 ? cosine(queryVector, item.embedding) : 0));
  const lexRanked = rankDescending(catalog, (item) => lexicalScore(queryRaw, item.text || `${item.name} ${item.description}`));
  const nameRanked = rankDescending(catalog, (item) => nameBonus(item.name, queryRaw));
  const top = (ranked: [number, CatalogEntry][]) => ranked.slice(0, limit * 3).map(([, item]) => item);

  // RRF alone can bury a strong match that appears in only one or two channels, so the raw vector
  // score and the name score are added back on top of the fused rank score.
  const fused = rrfFuse(top(vecRanked), top(lexRanked), top(nameRanked), catalog.length);
  const vecLookup = new Map(vecRanked.map(([score, item]) => [item.name, score]));
  const nameLookup = new Map(nameRanked.map(([score, item]) => [item.name, score]));

  const scored: SkillMatch[] = fused.map((entry) => {
    const vs = vecLookup.get(entry.name) ?? 0;
    const ns = nameLookup.get(entry.name) ?? 0;
    return {
      ...entry,
      vectorScore: pyRound(vs, 4),
      nameScore: pyRound(ns, 4),
      hybridScore: pyRound(entry.rrfScore + vs * 1.0 + ns * 0.5, 6),
    };
  });
  scored.sort((a, b) => b.hybridScore - a.hybridScore);

  // Chit-chat typically scores 0.2-0.35 on vector with no lexical/name overlap. Filter BEFORE top-K
  // so items that pass the threshold but rank lower are not lost to truncation.
  const passed = scored.filter(
    (r) => r.vectorScore >= 0.46 || lexicalScore(queryRaw, r.text || "") >= 0.35 || r.nameScore >= 0.8,
  );
  return passed.slice(0, limit);
}

/** `- name: description` lines of the prompt's retrieved-skills block. */
export function renderSkillCatalogLines(matches: readonly Pick<SkillMatch, "name" | "description">[]): string {
  return matches.map((item) => `- ${item.name}: ${item.description}`).join("\n");
}
