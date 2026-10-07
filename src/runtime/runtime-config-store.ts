import { access, mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runtimeConfigSnapshotSchema, type RuntimeConfigSnapshot } from "../config/runtime-config.js";

export class RuntimeConfigStore {
  constructor(private readonly filePath: string) {}

  get resolvedPath(): string {
    return path.resolve(this.filePath);
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<RuntimeConfigSnapshot | null> {
    if (!(await this.exists())) {
      return null;
    }

    const content = await readFile(this.resolvedPath, "utf8");
    return runtimeConfigSnapshotSchema.parse(JSON.parse(content));
  }

  async write(snapshot: RuntimeConfigSnapshot): Promise<void> {
    const directory = path.dirname(this.resolvedPath);
    await mkdir(directory, { recursive: true });
    const temporary = this.resolvedPath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), {encoding:"utf8",mode:0o600,flag:"wx"});
      await rename(temporary, this.resolvedPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
