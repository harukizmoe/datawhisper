import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatalogEntry,
  type EmbeddingCacheStore,
  type Embedder,
  buildSkillCatalog,
  createFileEmbeddingCache,
  lexicalScore,
  nameBonus,
  renderSkillCatalogLines,
  searchSkillCatalog,
} from "../src/agent/skill-discovery.ts";
import {
  INTERNAL_ACTIONS,
  type SkillDef,
  SkillDependencyError,
  SkillError,
  SkillLoader,
  activateSkill,
  activationRecord,
  createActivation,
  filterExposedTools,
  getSkill,
  loadSkills,
  makeSkillDef,
  missingRequiredSkillTools,
  missingSkillResponseContract,
  normalizeSkillTags,
  parseSkillFile,
  renderSkillPrompt,
  skillRequiresTextOnly,
  skillSupportsAnalysisMode,
  skillToPublic,
  trustedSkillName,
} from "../src/agent/skills.ts";
import { FIXTURES, GOLDEN, REPO_ROOT, type FsSpec, materialize, relativeTo, removeFile } from "./support/fs-spec.ts";

const golden = JSON.parse(readFileSync(join(GOLDEN, "skills.json"), "utf8"));
const discovery = JSON.parse(readFileSync(join(GOLDEN, "skill-discovery.json"), "utf8"));
const skillFixtures = join(FIXTURES, "skills");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-skills-"));
  temps.push(dir);
  return dir;
}

/** Python 的 YAML 错误文本无法复现；只把它的前缀视为契约的一部分。 */
function comparableError(error: string): string {
  return error.startsWith("invalid YAML frontmatter: ") ? "invalid YAML frontmatter: " : error;
}

function pySkill(skill: SkillDef, base: string, digest = false) {
  const out: Record<string, unknown> = {
    name: skill.name,
    display_name: skill.displayName,
    description: skill.description,
    icon: skill.icon,
    allowed_tools: [...skill.allowedTools],
    tags: [...skill.tags],
    source: skill.source,
    path: relativeTo(base, skill.path),
    resources: skill.resources.map((r) => ({ kind: r.kind, relative_path: r.relativePath, path: relativeTo(base, r.path), size: r.size })),
    public: (({ displayName, ...rest }) => ({ ...rest, display_name: displayName }))(skillToPublic(skill)),
  };
  const chars = [...skill.prompt];
  if (digest || chars.length > 2000) {
    out.prompt_sha256 = new Bun.CryptoHasher("sha256").update(skill.prompt).digest("hex");
    out.prompt_chars = chars.length;
    out.prompt_head = chars.slice(0, 60).join("");
  } else out.prompt = skill.prompt;
  return out;
}

function pyDiagnostics(loader: SkillLoader, base: string) {
  return loader.diagnostics().map((d) => ({ path: relativeTo(base, d.path), source: d.source, error: comparableError(d.error) }));
}

function expectedDiagnostics(list: { path: string; source: string; error: string }[]) {
  return list.map((d) => ({ ...d, error: comparableError(d.error) }));
}

const PROBES = ["alpha", "beta", "gamma", "x", "y", "z", "u", "w", "foo", "same", "nope", "Bad-Name", ""];

function runLoader(dirs: Record<string, string | undefined>, base: string, probes: string[]) {
  const loader = new SkillLoader({ builtinDir: dirs.builtin, userDir: dirs.user, workspaceDir: dirs.workspace });
  const loaded = loader.loadAll();
  return {
    skills: [...loaded.values()].map((s) => pySkill(s, base)),
    diagnostics: pyDiagnostics(loader, base),
    get: Object.fromEntries(probes.map((n) => [n, loader.get(n) ? pySkill(loader.get(n)!, base) : null])),
    catalog: loader.catalog().map((s) => s.name),
  };
}

describe("repo skills", () => {
  const loader = new SkillLoader({ builtinDir: join(REPO_ROOT, "skills") });
  const loaded = loader.loadAll();

  test("loads the same skills, in the same order, with the same fields", () => {
    expect(golden.repo.count).toBe(29);
    expect(loaded.size).toBe(golden.repo.count);
    expect([...loaded.keys()]).toEqual(golden.repo.names);
    expect(pyDiagnostics(loader, REPO_ROOT)).toEqual(golden.repo.diagnostics);
    expect([...loaded.values()].map((s) => pySkill(s, REPO_ROOT, true))).toEqual(golden.repo.skills);
  });

  test("rendering with and without a request matches", () => {
    for (const row of golden.repo.render) {
      const rendered = renderSkillPrompt(loaded.get(row.name)!, row.request);
      expect(new Bun.CryptoHasher("sha256").update(rendered).digest("hex")).toBe(row.sha256);
    }
  });

  test("activation requests the same tools", () => {
    const known = new Set<string>(golden.known_tools);
    for (const row of golden.repo.activate) {
      const skill = loaded.get(row.name)!;
      if (row.error) expect(() => activateSkill(skill, "测试", known)).toThrow(row.error);
      else expect([...activateSkill(skill, "测试", known).requestedTools].sort()).toEqual(row.requested_tools);
    }
  });
});

describe("static fixture directories", () => {
  for (const c of golden.static_cases) {
    test(c.id, () => {
      const dirs = Object.fromEntries(Object.entries(c.dirs as Record<string, string>).map(([k, v]) => [k, join(skillFixtures, v)]));
      const actual = runLoader(dirs, skillFixtures, PROBES);
      expect(actual.skills).toEqual(c.skills);
      expect(actual.diagnostics).toEqual(expectedDiagnostics(c.diagnostics));
      expect(actual.get).toEqual(c.get);
      expect(actual.catalog).toEqual(c.catalog);
    });
  }

  test("parseSkillFile result or error for every fixture file", () => {
    expect(golden.parse_cases.length).toBeGreaterThan(90);
    for (const c of golden.parse_cases) {
      const path = join(skillFixtures, c.path);
      if (c.error !== undefined) {
        let message = "";
        try {
          parseSkillFile(path);
        } catch (error) {
          expect(error).toBeInstanceOf(SkillError);
          message = (error as Error).message;
        }
        expect({ path: c.path, error: comparableError(message) }).toEqual({ path: c.path, error: comparableError(c.error) });
      } else expect({ path: c.path, skill: pySkill(parseSkillFile(path), skillFixtures) }).toEqual({ path: c.path, skill: c.skill });
    }
  });

  test("fixture counts: valid and invalid files", () => {
    const valid = golden.static_cases.find((c: { id: string }) => c.id === "valid");
    expect(valid.skills.length).toBeGreaterThanOrEqual(15);
    expect(valid.diagnostics.map((d: { error: string }) => d.error)).toContain("skill prompt is required");
  });
});

describe("dynamic trees", () => {
  for (const c of golden.dynamic) {
    test(c.id, () => {
      const root = tempDir();
      materialize(root, c.files);
      const dirs = Object.fromEntries(Object.entries(c.dirs as Record<string, string>).map(([k, v]) => [k, join(root, v)]));
      const actual = runLoader(dirs, root, []);
      expect(actual.skills).toEqual(c.skills);
      expect(actual.diagnostics).toEqual(expectedDiagnostics(c.diagnostics));
    });
  }

  test("hot reload: get() re-parses, broken or renamed edits fall back to the cache", () => {
    const hot = golden.hot_reload;
    const root = tempDir();
    materialize(root, hot.files);
    const loader = new SkillLoader({ builtinDir: join(root, "b") });
    const results = hot.ops.map((op: { op: string; name?: string; path?: string; entry?: unknown }) => {
      if (op.op === "load") return [...loader.loadAll().keys()];
      if (op.op === "get") {
        const skill = loader.get(op.name!);
        return skill ? pySkill(skill, root) : null;
      }
      if (op.op === "write") materialize(root, { [op.path!]: op.entry } as FsSpec);
      else removeFile(root, op.path!);
      return null;
    });
    expect(results).toEqual(hot.results);
  });

  test("invalid UTF-8 is a per-file diagnostic (Python crashes the whole load here)", () => {
    const root = tempDir();
    materialize(root, {
      "bad/SKILL.md": { b64: Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]).toString("base64") },
      "good/SKILL.md": "---\nname: good\ndescription: d\n---\nbody\n",
    });
    const loader = new SkillLoader({ builtinDir: root });
    expect([...loader.loadAll().keys()]).toEqual(["good"]);
    expect(loader.diagnostics()[0]!.error).toStartWith("cannot read skill file:");
  });

  test("loadSkills / getSkill facades", () => {
    const dirs = { builtinDir: join(skillFixtures, "layers/builtin"), workspaceDir: join(skillFixtures, "layers/workspace") };
    expect([...loadSkills(dirs).keys()]).toEqual(["x", "y", "z", "w"]);
    expect(getSkill("z", dirs)?.source).toBe("workspace");
    expect(getSkill("nope", dirs)).toBeUndefined();
  });
});

describe("prompt rendering and activation", () => {
  test("renderSkillPrompt matches for every fixture and request", () => {
    expect(golden.render.length).toBeGreaterThan(80);
    for (const row of golden.render) {
      expect(renderSkillPrompt(parseSkillFile(join(skillFixtures, row.fixture)), row.request)).toBe(row.output);
    }
  });

  const known = new Set<string>(golden.known_tools);
  test("activateSkill", () => {
    for (const row of golden.activate) {
      const skill = parseSkillFile(join(skillFixtures, row.fixture));
      if (row.error) {
        expect(() => activateSkill(skill, "do it", known)).toThrow(SkillDependencyError);
        expect(() => activateSkill(skill, "do it", known)).toThrow(row.error);
      } else {
        const activation = activateSkill(skill, "do it", known);
        expect(activation.name).toBe(row.ok.name);
        expect(activation.prompt).toBe(row.ok.prompt);
        expect([...activation.requestedTools].sort()).toEqual(row.ok.requested_tools);
        expect(activation.resources.map((r) => r.relativePath)).toEqual(row.ok.resources);
      }
    }
  });

  test("filterExposedTools only ever reduces an authorized set", () => {
    for (const row of golden.filters) {
      const activation = activateSkill(parseSkillFile(join(skillFixtures, row.fixture)), "", known);
      expect([...filterExposedTools(activation, new Set(row.exposed))].sort()).toEqual(row.result);
    }
  });

  test("tag normalisation, SkillDef validation and analysis modes", () => {
    for (const row of golden.tags) {
      if (row.error) expect(() => normalizeSkillTags(row.value)).toThrow(row.error);
      else expect(normalizeSkillTags(row.value)).toEqual(row.ok);
    }
    for (const row of golden.defs) {
      const k = row.kwargs;
      const fields = { name: k.name, description: k.description, prompt: k.prompt, path: "x.md", allowedTools: k.allowed_tools, tags: k.tags, source: k.source };
      // 生成器省略的键取 dataclass 默认值，与 Python 一致。
      const make = () => makeSkillDef(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as typeof fields);
      if (row.error) expect(make).toThrow(row.error);
      else {
        const def = make();
        for (const [mode, expected] of Object.entries(row.modes)) expect(skillSupportsAnalysisMode(def, mode)).toBe(expected as boolean);
      }
    }
    const modeSkill = makeSkillDef({ name: "m", description: "d", prompt: "p", path: "m.md", tags: ["mode-business", "mode-ml"] });
    for (const [mode, expected] of Object.entries(golden.modes)) expect(skillSupportsAnalysisMode(modeSkill, mode)).toBe(expected as boolean);
  });
});

describe("agent.py skill policy", () => {
  test("required tools and text-only mode", () => {
    for (const row of golden.policy.missing) {
      expect(missingRequiredSkillTools(row.skill, new Set(row.successful))).toEqual(row.missing);
      expect(skillRequiresTextOnly(row.skill, new Set(row.successful))).toBe(row.text_only);
    }
  });

  test("regression final-answer contract", () => {
    for (const row of golden.policy.contract) {
      expect(missingSkillResponseContract(row.skill, row.content)).toEqual(row.missing);
    }
  });

  test("trusted skill name: builtin keeps its name, workflow shares one token, user/workspace get none", () => {
    const make = (source: "builtin" | "user" | "workspace" | "workflow") =>
      makeSkillDef({ name: "export", description: "d", prompt: "p", path: "x.md", source });
    expect(trustedSkillName(make("builtin"))).toBe("export");
    expect(trustedSkillName(make("workflow"))).toBe("workflow");
    expect(trustedSkillName(make("user"))).toBe("");
    expect(trustedSkillName(make("workspace"))).toBe("");
  });

  test("activation context is mutually exclusive", () => {
    expect(Object.keys(INTERNAL_ACTIONS).sort()).toEqual(golden.internal_actions);
    for (const row of golden.activation) {
      const kwargs = Object.fromEntries(
        Object.entries({ skillName: row.kwargs.skill_name, commandName: row.kwargs.command_name, internalAction: row.kwargs.internal_action }).filter(([, v]) => v !== undefined),
      );
      if (row.error) expect(() => createActivation(kwargs)).toThrow(row.error);
      else {
        const record = activationRecord(createActivation(kwargs));
        expect({ kind: record.kind, name: record.name, skill_name: record.skillName, command_name: record.commandName, internal_action: record.internalAction }).toEqual(row.record);
      }
    }
  });
});

describe("skill discovery", () => {
  const vectors = discovery.texts as Record<string, number[]>;
  const signature = { current: "sig-a" };
  const batches: number[] = [];
  const embedder: Embedder = {
    signature: () => signature.current,
    async embedBatch(texts) {
      batches.push(texts.length);
      return texts.map((t) => {
        const v = vectors[t];
        if (!v) throw new Error(`no golden vector for text: ${t.slice(0, 60)}`);
        return v;
      });
    },
    async embedQuery(text) {
      const v = vectors[text];
      if (!v) throw new Error(`no golden vector for query: ${text.slice(0, 60)}`);
      return v;
    },
  };

  function memoryStore(): EmbeddingCacheStore & { saves: number; entries: Record<string, number[]>; signature: string | null } {
    const state = { saves: 0, entries: {} as Record<string, number[]>, signature: null as string | null };
    return Object.assign(state, {
      load: (sig: string) => (state.signature === sig ? { ...state.entries } : {}),
      save: (sig: string, entries: Record<string, number[]>) => {
        state.saves++;
        state.signature = sig;
        state.entries = { ...entries };
      },
    });
  }

  function pyMatch(match: CatalogEntry & Record<string, unknown>) {
    return {
      name: match.name,
      description: match.description,
      tags: [...match.tags],
      text: match.text,
      rrf_score: match.rrfScore,
      vector_score: match.vectorScore,
      name_score: match.nameScore,
      hybrid_score: match.hybridScore,
    };
  }

  test("catalog entries match", async () => {
    const { catalog, total } = await buildSkillCatalog(discovery.corpus, embedder, memoryStore());
    // Python 只丢弃空名称；纯空白名称会被保留。
    expect(total).toBe(discovery.corpus.length - 1);
    expect(total).toBe(discovery.catalog.length);
    expect(catalog.map((c) => ({ name: c.name, description: c.description, tags: [...c.tags], text: c.text }))).toEqual(discovery.catalog);
    for (const entry of catalog) expect(entry.embedding).toEqual(vectors[entry.text]!);
  });

  test("ranking over the query corpus matches", async () => {
    const { catalog } = await buildSkillCatalog(discovery.corpus, embedder, memoryStore());
    expect(discovery.searches.length).toBeGreaterThan(80);
    let nonEmpty = 0;
    for (const row of discovery.searches) {
      const results = await searchSkillCatalog(row.catalog_empty ? [] : catalog, row.query, embedder, row.limit);
      expect({ query: row.query, limit: row.limit, results: results.map((r) => pyMatch(r as never)) }).toEqual({ query: row.query, limit: row.limit, results: row.results });
      if (results.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });

  test("lexical score and name bonus match", () => {
    for (const row of discovery.lexical) expect(lexicalScore(row.query, row.text)).toBe(row.score);
    for (const row of discovery.name_bonus) expect(nameBonus(row.name, row.query)).toBe(row.score);
  });

  test("embedding cache: only changed descriptions are re-embedded and stale entries pruned", async () => {
    const store = memoryStore();
    for (const step of discovery.cache_sequence) {
      signature.current = step.signature;
      batches.length = 0;
      const savesBefore = store.saves;
      const { catalog, rebuilt, total } = await buildSkillCatalog(step.inputs, embedder, store);
      expect({ label: step.label, rebuilt, total, batches: [...batches], catalog: catalog.map((c) => c.name) }).toEqual({
        label: step.label,
        rebuilt: step.rebuilt,
        total: step.total,
        batches: step.batches,
        catalog: step.catalog,
      });
      expect({ label: step.label, saved: store.saves > savesBefore }).toEqual({ label: step.label, saved: step.rewritten });
      if (step.cache_entries !== null) {
        expect(store.signature).toBe(step.cache_signature);
        expect(Object.keys(store.entries).length).toBe(step.cache_entries);
      }
    }
    signature.current = "sig-a";
  });

  test("file cache store round-trips and ignores a foreign signature or garbage", () => {
    const path = join(tempDir(), "nested", "cache.json");
    const store = createFileEmbeddingCache(path);
    expect(store.load("s")).toEqual({});
    store.save("s", { h1: [0.5, 0.25] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ signature: "s", entries: { h1: [0.5, 0.25] } });
    expect(store.load("s")).toEqual({ h1: [0.5, 0.25] });
    expect(store.load("other")).toEqual({});
    writeFileSync(path, "{not json");
    expect(store.load("s")).toEqual({});
    writeFileSync(path, JSON.stringify({ signature: "s", entries: [1] }));
    expect(store.load("s")).toEqual({});
  });

  test("catalog lines for the prompt", () => {
    expect(renderSkillCatalogLines([{ name: "a", description: "da" }, { name: "b", description: "db" }])).toBe("- a: da\n- b: db");
  });
});
