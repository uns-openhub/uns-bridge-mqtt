import type { BridgeEngine } from "@uns-kit/bridge-core";
import { getLogger } from "@uns-kit/core";
import { isDeepStrictEqual } from "node:util";
import { runtimeConfigSnapshotSchema, type RuntimeConfigSnapshot } from "../config/runtime-config.js";
import { toConnectionConfig, toMappingConfig } from "../config/mqtt-config-mappers.js";
import type { MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent } from "../mqtt/mqtt-types.js";
import { RuntimeConfigStore } from "./runtime-config-store.js";

const logger = getLogger(import.meta.url);

type ConfigSource = "startup-default" | "snapshot" | "api-apply" | "api-validate" | "api-reload";

export class RuntimeConfigManager {
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
    this.sourceStatus = {
      ...this.sourceStatus,
      source: "api-validate",
    };
    return parsed;
  }

  async applyConfig(snapshot: unknown, source: ConfigSource): Promise<RuntimeConfigSnapshot> {
    const parsed = runtimeConfigSnapshotSchema.parse(snapshot);
    this.ensureUniqueIds(parsed);

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

    this.currentConfig = appliedSnapshot;
    this.sourceStatus = {
      source,
      lastAppliedAt: appliedSnapshot.updatedAt,
    };

    await this.store.write(appliedSnapshot);
    return this.getCurrentConfig();
  }

  async reloadSnapshot(): Promise<RuntimeConfigSnapshot> {
    const snapshot = await this.store.read();
    if (!snapshot) {
      throw new Error(`Runtime snapshot '${this.store.resolvedPath}' does not exist`);
    }

    return this.applyConfig(snapshot, "api-reload");
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
