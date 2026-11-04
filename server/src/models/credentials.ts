import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * API keys for user-configured providers.
 *
 * Primary backend: the OS keychain via `Bun.secrets` (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service). When the platform has none (e.g. a Linux session without a Secret Service
 * daemon), credentials go to a JSON file readable only by the user (mode 0600). `backend` tells the
 * settings UI which one is in use.
 *
 * The keychain cannot enumerate entries, so the ids of stored credentials are kept in an index file
 * next to the fallback file (ids only, never secrets).
 */
export type CredentialBackend = "keychain" | "file";

const SERVICE = "DataWhisper";

type FileShape = { version: 1; credentials: Record<string, Credential> };
type IndexShape = { version: 1; ids: string[] };

export class SecretCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly backend: CredentialBackend,
    private readonly filePath: string,
    private readonly indexPath: string,
  ) {}

  /** Probes the keychain once; falls back to the file when it is unavailable. */
  static async open(filePath: string, indexPath: string, options: { forceFile?: boolean } = {}): Promise<SecretCredentialStore> {
    const backend = options.forceFile || !(await keychainUsable()) ? "file" : "keychain";
    return new SecretCredentialStore(backend, filePath, indexPath);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (this.backend === "file") return (await this.readFile()).credentials[providerId];
    const value = await Bun.secrets.get({ service: SERVICE, name: providerId });
    return value === null ? undefined : (JSON.parse(value) as Credential);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    if (this.backend === "file") {
      return Object.entries((await this.readFile()).credentials).map(([providerId, c]) => ({ providerId, type: c.type }));
    }
    const infos: CredentialInfo[] = [];
    for (const providerId of (await this.readIndex()).ids) {
      const credential = await this.read(providerId);
      if (credential !== undefined) infos.push({ providerId, type: credential.type });
    }
    return infos;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.serialize(async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      await this.write(providerId, next);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialize(() => this.write(providerId, undefined));
  }

  private async write(providerId: string, credential: Credential | undefined): Promise<void> {
    if (this.backend === "file") {
      const data = await this.readFile();
      if (credential === undefined) delete data.credentials[providerId];
      else data.credentials[providerId] = credential;
      await writePrivateJson(this.filePath, data);
      return;
    }
    if (credential === undefined) await Bun.secrets.delete({ service: SERVICE, name: providerId });
    else await Bun.secrets.set({ service: SERVICE, name: providerId, value: JSON.stringify(credential) });
    const index = await this.readIndex();
    const ids = new Set(index.ids);
    if (credential === undefined) ids.delete(providerId);
    else ids.add(providerId);
    await writePrivateJson(this.indexPath, { version: 1, ids: [...ids].sort() } satisfies IndexShape);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readFile(): Promise<FileShape> {
    return (await readJson<FileShape>(this.filePath)) ?? { version: 1, credentials: {} };
  }

  private async readIndex(): Promise<IndexShape> {
    return (await readJson<IndexShape>(this.indexPath)) ?? { version: 1, ids: [] };
  }
}

async function keychainUsable(): Promise<boolean> {
  const probe = { service: SERVICE, name: "__probe__" };
  try {
    await Bun.secrets.set({ ...probe, value: "1" });
    await Bun.secrets.delete(probe);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomic write of a file only the user can read (0600 is a no-op on Windows; the profile dir is per-user). */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
