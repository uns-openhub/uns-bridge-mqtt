import type { BridgeEngine } from "@uns-kit/bridge-core";
import { getLogger } from "@uns-kit/core";
import { createHash } from "node:crypto";
import { BridgeConfigConflictError, BridgeValidationError } from "../api/validation-error.js";
import { devicePreviewBodySchema, type ReviewedDevice } from "./reviewed-device.js";
import { isDeepStrictEqual } from "node:util";
import { runtimeConfigSnapshotSchema, type RuntimeConfigSnapshot } from "../config/runtime-config.js";
import { toConnectionConfig, toMappingConfig } from "../config/mqtt-config-mappers.js";
import type { MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent } from "../mqtt/mqtt-types.js";
import { RuntimeConfigStore } from "./runtime-config-store.js";

import { resolveMqttCredentials } from "./local-secret-references.js";

const logger = getLogger(import.meta.url);

type ConfigSource = "startup-default" | "snapshot" | "api-apply" | "api-validate" | "api-reload";

export class RuntimeConfigManager {
  private mutationTail: Promise<void> = Promise.resolve();
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
  private configRevision(): string {
    return createHash("sha256").update(JSON.stringify(this.currentConfig)).digest("hex");
  }
  private mergeNewDevice(value: ReviewedDevice): RuntimeConfigSnapshot {
    const input = devicePreviewBodySchema.parse(value);
    const snapshot = this.getCurrentConfig();
    if (snapshot.connections.some(c => c.id.toLowerCase() === input.connection.id.toLowerCase())) {
      throw new BridgeValidationError([{ path: ["connection", "id"], message: "A connection with this name already exists." }]);
    }
    const targets = new Set<string>();
    const collect = (m: RuntimeConfigSnapshot["connections"][number]["mappings"][number]) =>
      m.config.outputs.map(o => [(o.topic ?? m.config.topic).replace(/\/+$/, ""), o.asset ?? m.config.asset,
        o.objectType ?? m.config.objectType, o.objectId ?? m.config.objectId, o.attribute].join("/").toLowerCase());
    for (const c of snapshot.connections) for (const m of c.mappings) for (const target of collect(m)) targets.add(target);
    const ids = new Set<string>();
    for (const [i, m] of input.mappings.entries()) {
      if (ids.has(m.id.toLowerCase())) throw new BridgeValidationError([{path:["mappings",i,"id"],message:"Mapping ID is repeated."}]);
      ids.add(m.id.toLowerCase());
      for (const target of collect(m)) {
        if (targets.has(target)) throw new BridgeValidationError([{path:["mappings",i,"config","outputs"],message:"A UNS attribute already has a bridge mapping."}]);
        targets.add(target);
      }
    }
    snapshot.connections.push({ ...input.connection, start: false, mappings: input.mappings });
    return runtimeConfigSnapshotSchema.parse(snapshot);
  }
  async previewNewDevice(device: ReviewedDevice): Promise<{ revision: string; id: string; count: number; outputCount: number }> {
    const revision = this.configRevision();
    const next = this.mergeNewDevice(device);
    const added = next.connections[next.connections.length - 1]!;
    return { revision, id: added.id, count: added.mappings.length, outputCount: added.mappings.reduce((n, m) => n + m.config.outputs.length, 0) };
  }
  appendReviewedDevice(device: ReviewedDevice, expectedRevision: string): Promise<{ id: string; count: number; start: false }> {
    // Clone before waiting: caller edits must not change the reviewed request in the queue.
    const input = devicePreviewBodySchema.parse(device);
    return this.exclusive(async () => {
      if (expectedRevision !== this.configRevision()) throw new BridgeConfigConflictError();
      const next = this.mergeNewDevice(input);
      const added = next.connections[next.connections.length - 1]!;
      await this.engine.addConnection({id: added.id, config: toConnectionConfig(added.config), start: false});
      try {
        for (const m of added.mappings) await this.engine.addMapping(added.id, {id:m.id,config:toMappingConfig(m.config)});
        next.updatedAt = new Date().toISOString();
        await this.store.write(next);
      } catch (error) {
        await this.engine.removeConnection(added.id);
        throw error;
      }
      this.currentConfig = next;
      await this.reconcilePublisher(next);
      this.sourceStatus = {source:"api-apply",lastAppliedAt:next.updatedAt};
      return {id:added.id,count:added.mappings.length,start:false};
    });
  }
  mutateConfig(mutate: (snapshot: RuntimeConfigSnapshot) => RuntimeConfigSnapshot): Promise<RuntimeConfigSnapshot> {
    return this.exclusive(() => this.applyValidatedConfig(mutate(this.getCurrentConfig()), "api-apply"));
  }

  private currentConfig: RuntimeConfigSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connections: [],
  };

  private sourceStatus: {
    source: ConfigSource;
    lastAppliedAt: string | undefined;
  } = {
    source: "startup-default",
    lastAppliedAt: undefined,
  };

  constructor(
    private readonly engine: BridgeEngine<MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent>,
    private readonly store: RuntimeConfigStore,
    private readonly reconcilePublisher: (snapshot: RuntimeConfigSnapshot) => Promise<void> = async () => undefined,
    private readonly preparePublisher: (snapshot: RuntimeConfigSnapshot) => Promise<void> = async () => undefined,
  ) {}

  async initializeFromSnapshot(): Promise<RuntimeConfigSnapshot> {
    const snapshot = await this.store.read();
    if (!snapshot) {
      logger.info(`No runtime snapshot found at '${this.store.resolvedPath}', starting with empty config`);
      return this.getCurrentConfig();
    }

    return this.applyConfig(snapshot, "snapshot");
  }

  getCurrentConfig(): RuntimeConfigSnapshot {
    return structuredClone(this.currentConfig);
  }

  async validateConfig(snapshot: unknown): Promise<RuntimeConfigSnapshot> {
    const parsed = runtimeConfigSnapshotSchema.parse(snapshot);
    this.ensureUniqueIds(parsed);
    return parsed;
  }

  applyConfig(snapshot: unknown, source: ConfigSource): Promise<RuntimeConfigSnapshot> {
    const captured = structuredClone(snapshot);
    return this.exclusive(() => this.applyValidatedConfig(captured, source));
  }
  private async applyValidatedConfig(snapshot: unknown, source: ConfigSource): Promise<RuntimeConfigSnapshot> {
    const parsed = runtimeConfigSnapshotSchema.parse(snapshot);
    this.ensureUniqueIds(parsed);

    // Preflight before stopping, updating or removing any existing connection.
    for (const connection of parsed.connections) if (connection.start) resolveMqttCredentials(connection.config);

    await this.preparePublisher(parsed);
    try {
      const currentById = new Map(this.currentConfig.connections.map((connection) => [connection.id, connection]));
      const desiredById = new Map(parsed.connections.map((connection) => [connection.id, connection]));

      for (const currentConnection of this.currentConfig.connections) {
        if (!desiredById.has(currentConnection.id)) {
          logger.info(`Removing connection '${currentConnection.id}' from runtime config`);
          await this.engine.removeConnection(currentConnection.id);
        }
      }

      for (const desiredConnection of parsed.connections) {
        const existingConnection = currentById.get(desiredConnection.id);
        const shouldStart = desiredConnection.start ?? false;

        if (!existingConnection) {
          logger.info(`Adding connection '${desiredConnection.id}' to runtime config`);
          await this.engine.addConnection({
            id: desiredConnection.id,
            config: toConnectionConfig(desiredConnection.config),
            start: false,
          });
        } else if (!shouldStart && existingConnection.start) {
          logger.info(`Stopping connection '${desiredConnection.id}' before applying stopped config`);
          await this.engine.stopConnection(desiredConnection.id);
        }

        if (existingConnection && !isDeepStrictEqual(existingConnection.config, desiredConnection.config)) {
          logger.info(`Updating connection '${desiredConnection.id}' in runtime config`);
          await this.engine.updateConnection(desiredConnection.id, toConnectionConfig(desiredConnection.config));
        }

        const currentMappings = new Map((existingConnection?.mappings ?? []).map((mapping) => [mapping.id, mapping]));
        const desiredMappings = new Map(desiredConnection.mappings.map((mapping) => [mapping.id, mapping]));

        for (const currentMapping of existingConnection?.mappings ?? []) {
          if (!desiredMappings.has(currentMapping.id)) {
            logger.info(`Removing mapping '${currentMapping.id}' from connection '${desiredConnection.id}'`);
            await this.engine.removeMapping(desiredConnection.id, currentMapping.id);
          }
        }

        for (const desiredMapping of desiredConnection.mappings) {
          if (!currentMappings.has(desiredMapping.id)) {
            logger.info(`Adding mapping '${desiredMapping.id}' to connection '${desiredConnection.id}'`);
            await this.engine.addMapping(desiredConnection.id, {
              id: desiredMapping.id,
              config: toMappingConfig(desiredMapping.config),
            });
          } else if (!isDeepStrictEqual(currentMappings.get(desiredMapping.id)?.config, desiredMapping.config)) {
            logger.info(`Updating mapping '${desiredMapping.id}' on connection '${desiredConnection.id}'`);
            await this.engine.updateMapping(desiredConnection.id, desiredMapping.id, toMappingConfig(desiredMapping.config));
          }
        }

        if (shouldStart) {
          await this.engine.startConnection(desiredConnection.id);
        } else {
          await this.engine.stopConnection(desiredConnection.id);
        }
      }

      const appliedSnapshot: RuntimeConfigSnapshot = {
        ...parsed,
        updatedAt: new Date().toISOString(),
      };

      await this.store.write(appliedSnapshot);
      this.currentConfig = appliedSnapshot;
      this.sourceStatus = {
        source,
        lastAppliedAt: appliedSnapshot.updatedAt,
      };

      await this.reconcilePublisher(appliedSnapshot);
      return this.getCurrentConfig();
    } catch (error) {
      await this.reconcilePublisher(this.getCurrentConfig());
      throw error;
    }
  }

  reloadSnapshot(): Promise<RuntimeConfigSnapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.store.read();
      if (!snapshot) throw new Error("Runtime snapshot does not exist.");
      return this.applyValidatedConfig(snapshot, "api-reload");
    });
  }

  async getSourceStatus(): Promise<{
    source: ConfigSource;
    lastAppliedAt: string | undefined;
    snapshotPath: string;
    snapshotExists: boolean;
  }> {
    return {
      ...this.sourceStatus,
      snapshotPath: this.store.resolvedPath,
      snapshotExists: await this.store.exists(),
    };
  }

  private ensureUniqueIds(snapshot: RuntimeConfigSnapshot): void {
    const connectionIds = new Set<string>();
    for (const connection of snapshot.connections) {
      if (connectionIds.has(connection.id)) {
        throw new Error(`Duplicate connection id '${connection.id}'`);
      }
      connectionIds.add(connection.id);

      const mappingIds = new Set<string>();
      for (const mapping of connection.mappings) {
        if (mappingIds.has(mapping.id)) {
          throw new Error(`Duplicate mapping id '${mapping.id}' in connection '${connection.id}'`);
        }
        mappingIds.add(mapping.id);
      }
    }
  }
}
