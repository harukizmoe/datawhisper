import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * 用户配置的 provider 的 API key。
 *
 * 主后端：通过 `Bun.secrets` 使用操作系统钥匙串（macOS Keychain、Windows Credential Manager、
 * Linux Secret Service）。平台没有钥匙串时（例如没有 Secret Service 守护进程的 Linux 会话），
 * 凭据写入仅当前用户可读的 JSON 文件（权限 0600）。`backend` 告诉设置界面当前使用的是哪一个。
 *
 * 钥匙串无法枚举条目，因此已存凭据的 id 保存在回退文件旁边的索引文件中（只存 id，绝不存密钥）。
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

  /** 探测一次钥匙串是否可用；不可用时回退到文件存储。 */
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

/** 以原子方式写入仅当前用户可读的文件（0600 在 Windows 上无效；用户配置目录本身按用户隔离）。 */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
