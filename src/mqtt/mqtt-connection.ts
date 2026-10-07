import mqtt, { type IPublishPacket, type MqttClient } from "mqtt";
import type { MappingDefinition, ProtocolConnection } from "@uns-kit/bridge-core";
import { getLogger } from "@uns-kit/core";
import { redactMqttError } from "../runtime/local-secret-references.js";
import { buildMqttClientConfig } from "./mqtt-topic-browser.js";
import type {
  MqttBridgeConnectionConfig,
  MqttBridgeMappingConfig,
  MqttBridgeOutputConfig,
  MqttPayloadSelector,
  MqttBridgeValueEvent,
  MqttValueExtraction,
} from "./mqtt-types.js";

const logger = getLogger(import.meta.url);

class PayloadMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadMismatchError";
  }
}

type MappingRegistration = {
  definition: MappingDefinition<MqttBridgeMappingConfig>;
  onValue: (event: MqttBridgeValueEvent) => Promise<void>;
};

function topicMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");

  for (let index = 0; index < filterLevels.length; index += 1) {
    const filterLevel = filterLevels[index];
    const topicLevel = topicLevels[index];

    if (filterLevel === "#") {
      return index === filterLevels.length - 1;
    }

    if (filterLevel === "+") {
      if (topicLevel === undefined) {
        return false;
      }
      continue;
    }

    if (filterLevel !== topicLevel) {
      return false;
    }
  }

  return filterLevels.length === topicLevels.length;
}

function tryParseJson(payloadText: string): unknown | undefined {
  try {
    return JSON.parse(payloadText);
  } catch {
    return undefined;
  }
}

function resolveJsonPath(input: unknown, path: string): unknown {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  let current: unknown = input;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        throw new Error(`JSON path segment '${segment}' is not a valid array index`);
      }
      current = current[index];
      continue;
    }

    if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }

    return undefined;
  }

  return current;
}

function normalizeSelector(selector: MqttPayloadSelector): {
  targetPath?: string;
  matchFieldPath: string;
  matchValue: string;
} {
  const segments = selector.matchField.split(".").filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return {
      matchFieldPath: selector.matchField,
      matchValue: selector.matchValue,
    };
  }

  return {
    targetPath: segments.slice(0, -1).join("."),
    matchFieldPath: segments.at(-1) ?? selector.matchField,
    matchValue: selector.matchValue,
  };
}

function selectPayloadValue(input: unknown, selector?: MqttPayloadSelector): unknown {
  if (!selector) {
    return input;
  }

  const normalizedSelector = normalizeSelector(selector);
  const selectorTarget =
    normalizedSelector.targetPath && normalizedSelector.targetPath !== "$" && normalizedSelector.targetPath !== "."
      ? resolveJsonPath(input, normalizedSelector.targetPath)
      : input;

  const matchesSelector = (candidateTarget: unknown): boolean => {
    if (typeof candidateTarget !== "object" || candidateTarget === null) {
      return false;
    }

    const candidate = resolveJsonPath(candidateTarget, normalizedSelector.matchFieldPath);
    return String(candidate) === normalizedSelector.matchValue;
  };

  if (Array.isArray(selectorTarget)) {
    const match = selectorTarget.find((entry) => matchesSelector(entry));
    if (match === undefined) {
      throw new Error(
        `Selector did not find entry where '${normalizedSelector.matchFieldPath}' equals '${normalizedSelector.matchValue}'`,
      );
    }
    return match;
  }

  if (matchesSelector(selectorTarget)) {
    return selectorTarget;
  }

  throw new Error(
    `Selector path '${normalizedSelector.targetPath ?? "$"}' did not resolve to a matching object or array entry`,
  );
}

function resolveMappingOutputs(mapping: MqttBridgeMappingConfig): MqttBridgeOutputConfig[] {
  if (mapping.outputs.length) {
    return mapping.outputs;
  }
  throw new Error(`Mapping '${mapping.topicFilter}' requires at least one output`);
}

export function extractValue(
  payload: Buffer,
  payloadText: string,
  selector?: MqttPayloadSelector,
  extraction?: MqttValueExtraction,
): {
  extractedValue: unknown;
  payloadJson?: unknown;
} {
  const mode = extraction?.mode ?? "text";
  const payloadBase = mode === "raw" ? payload.toString("base64") : payloadText;
  if (mode === "raw") {
    return { extractedValue: payloadBase };
  }

  const needsJsonPayload = Boolean(selector) || mode === "json-path";
  const payloadJson = needsJsonPayload ? tryParseJson(payloadText) : undefined;
  if (needsJsonPayload && payloadJson === undefined) {
    throw new PayloadMismatchError("Payload is not valid JSON");
  }

  const selectedValue = selector ? selectPayloadValue(payloadJson, selector) : payloadJson ?? payloadText;
  if (mode === "text") {
    return {
      extractedValue:
        typeof selectedValue === "string" ? selectedValue : JSON.stringify(selectedValue),
      ...(payloadJson !== undefined ? { payloadJson } : {}),
    };
  }

  if (!extraction?.path) {
    throw new Error("Extraction mode 'json-path' requires path");
  }

  const extractedValue = resolveJsonPath(selectedValue, extraction.path);
  if (extractedValue === undefined) {
    throw new Error(`Extraction path '${extraction.path}' did not resolve to a value on the selected payload`);
  }

  return {
    extractedValue,
    ...(payloadJson !== undefined ? { payloadJson } : {}),
  };
}

function endClient(client: MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(false, {}, () => {
      resolve();
    });
  });
}

export class MqttConnection
  implements ProtocolConnection<MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent>
{
  private client: MqttClient | undefined;
  private readonly mappings = new Map<string, MappingRegistration>();
  private state: "stopped" | "starting" | "running" | "stopping" | "reconnecting" | "error" = "stopped";
  private connected = false;
  private message: string | undefined;
  private updatedAt = new Date().toISOString();
  private activeFilters = new Set<string>();

  constructor(
    private readonly id: string,
    private config: MqttBridgeConnectionConfig,
  ) {}

  async start(): Promise<void> {
    if (this.client && this.connected) {
      this.state = "running";
      this.touch();
      return;
    }

    const { url, options, details } = buildMqttClientConfig(this.config);
    this.state = "starting";
    this.connected = false;
    this.touch();

    const client = mqtt.connect(url, options);
    this.client = client;

    client.on("connect", async () => {
      this.state = "running";
      this.connected = true;
      this.message = undefined;
      this.touch();

      try {
        await this.subscribeAllMappings();
      } catch (error) {
        this.state = "error";
        this.message = redactMqttError(error, this.config);
        this.touch();
      }
    });

    client.on("reconnect", () => {
      this.state = "reconnecting";
      this.connected = false;
      this.touch();
    });

    client.on("offline", () => {
      this.state = "reconnecting";
      this.connected = false;
      this.touch();
    });

    client.on("close", () => {
      this.connected = false;
      if (this.state !== "stopping" && this.state !== "stopped") {
        this.state = "reconnecting";
      }
      this.touch();
    });

    client.on("error", (error) => {
      this.state = "error";
      this.connected = false;
      this.message = redactMqttError(error, this.config);
      this.touch();
      logger.error(`MQTT connection '${this.id}' error: ${this.message}`);
    });

    client.on("message", (topic, payload, packet) => {
      void this.handleMessage(topic, payload, packet);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for MQTT connection '${this.id}'`));
      }, this.config.connectTimeout ?? 10000);

      const onConnect = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        client.off("connect", onConnect);
        client.off("error", onError);
      };

      client.on("connect", onConnect);
      client.on("error", onError);
    }).catch(async (error) => {
      this.state = "error";
      this.connected = false;
      this.message = redactMqttError(error, this.config);
      this.touch();
      await endClient(client);
      throw new Error(redactMqttError(error, this.config));
    });

    logger.info(`Started MQTT connection '${this.id}'`, details);
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    this.touch();
    if (this.client) {
      await endClient(this.client);
      this.client.removeAllListeners();
      this.client = undefined;
    }
    this.activeFilters.clear();
    this.connected = false;
    this.state = "stopped";
    this.message = undefined;
    this.touch();
  }

  async updateConfig(config: MqttBridgeConnectionConfig): Promise<void> {
    this.config = config;
    if (this.client) {
      await this.stop();
      await this.start();
    }
  }

  async getStatus(): Promise<{
    state: "stopped" | "starting" | "running" | "stopping" | "reconnecting" | "error";
    connected: boolean;
    updatedAt: string;
    message?: string;
    details?: Record<string, unknown>;
  }> {
    return {
      state: this.state,
      connected: this.connected,
      updatedAt: this.updatedAt,
      ...(this.message ? { message: this.message } : {}),
      details: {
        mappingCount: this.mappings.size,
        subscribedFilters: [...this.activeFilters.values()],
      },
    };
  }

  async addMapping(
    mapping: MappingDefinition<MqttBridgeMappingConfig>,
    onValue: (event: MqttBridgeValueEvent) => Promise<void>,
  ): Promise<void> {
    this.mappings.set(mapping.id, { definition: mapping, onValue });
    if (this.client && this.connected) {
      await this.subscribeFilter(mapping.config.topicFilter, mapping.config.qos);
    }
  }

  async updateMapping(mappingId: string, mapping: MqttBridgeMappingConfig): Promise<void> {
    const existing = this.mappings.get(mappingId);
    if (!existing) {
      throw new Error(`Mapping '${mappingId}' does not exist on MQTT connection '${this.id}'`);
    }

    const previousFilter = existing.definition.config.topicFilter;
    existing.definition = { id: mappingId, config: mapping };

    if (this.client && this.connected) {
      if (previousFilter !== mapping.topicFilter && !this.hasFilter(previousFilter, mappingId)) {
        await this.unsubscribeFilter(previousFilter);
      }
      await this.subscribeFilter(mapping.topicFilter, mapping.qos);
    }
  }

  async removeMapping(mappingId: string): Promise<void> {
    const existing = this.mappings.get(mappingId);
    if (!existing) {
      return;
    }

    this.mappings.delete(mappingId);

    if (this.client && this.connected && !this.hasFilter(existing.definition.config.topicFilter, mappingId)) {
      await this.unsubscribeFilter(existing.definition.config.topicFilter);
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.mappings.clear();
  }

  private async handleMessage(topic: string, payload: Buffer, packet: IPublishPacket): Promise<void> {
    const timestamp = new Date().toISOString();
    const payloadText = payload.toString("utf8");

    for (const mapping of this.mappings.values()) {
      if (!topicMatches(mapping.definition.config.topicFilter, topic)) {
        continue;
      }

      try {
        const outputs = resolveMappingOutputs(mapping.definition.config);
        const needsJsonPayload =
          outputs.some((output) => output.selector || output.extraction?.mode === "json-path");
        const payloadJson = needsJsonPayload ? tryParseJson(payloadText) : undefined;
        if (needsJsonPayload && payloadJson === undefined) {
          throw new PayloadMismatchError("Payload is not valid JSON");
        }
        await mapping.onValue({
          topic,
          timestamp,
          qos: packet.qos ?? 0,
          retain: packet.retain ?? false,
          payloadText,
          payloadBase64: payload.toString("base64"),
          ...(payloadJson !== undefined ? { payloadJson } : {}),
        });
      } catch (error) {
        const message = redactMqttError(error, this.config);
        if (error instanceof PayloadMismatchError) {
          logger.warn(
            `Skipping MQTT message for mapping '${mapping.definition.id}' on topic '${topic}': payload not as expected (${message})`,
          );
          continue;
        }

        logger.error(`Failed to process MQTT message for mapping '${mapping.definition.id}': ${message}`);
      }
    }
  }

  private async subscribeAllMappings(): Promise<void> {
    for (const { definition } of this.mappings.values()) {
      await this.subscribeFilter(definition.config.topicFilter, definition.config.qos);
    }
  }

  private async subscribeFilter(filter: string, qos: 0 | 1 | 2 | undefined): Promise<void> {
    if (!this.client || this.activeFilters.has(filter)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.client?.subscribe(filter, { qos: qos ?? 0 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.activeFilters.add(filter);
    this.touch();
  }

  private async unsubscribeFilter(filter: string): Promise<void> {
    if (!this.client || !this.activeFilters.has(filter)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.client?.unsubscribe(filter, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.activeFilters.delete(filter);
    this.touch();
  }

  private hasFilter(filter: string, exceptMappingId?: string): boolean {
    for (const [mappingId, registration] of this.mappings.entries()) {
      if (mappingId === exceptMappingId) {
        continue;
      }
      if (registration.definition.config.topicFilter === filter) {
        return true;
      }
    }
    return false;
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}
