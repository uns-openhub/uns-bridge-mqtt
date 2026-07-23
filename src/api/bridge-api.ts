import { getLogger } from "@uns-kit/core";
import type {
  IGetEndpointOptions,
  IPostEndpointOptions,
  UnsEvents,
} from "@uns-kit/core/uns/uns-interfaces.js";
import { buildUnsRoutePath } from "@uns-kit/core/uns/uns-path.js";
import type { UnsApiProxy } from "@uns-kit/api";
import { z } from "zod";
import {
  createBridgeManagementApiRoutes,
  type BridgeEngine,
  type BridgeManagementApiRoutes,
  type BridgeManagementGetHandler,
  type BridgeManagementGetRouteDefinition,
  type BridgeManagementPostHandler,
  type BridgeManagementPostRouteDefinition,
} from "@uns-kit/bridge-core";
import {
  extractionModeValues,
  runtimeConfigSnapshotSchema,
  runtimeConnectionConfigSchema,
  runtimeMappingConfigSchema,
  type RuntimeConfigSnapshot,
} from "../config/runtime-config.js";
import { MqttAdapter } from "../mqtt/mqtt-adapter.js";
import type { MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent } from "../mqtt/mqtt-types.js";
import { RuntimeConfigManager } from "../runtime/runtime-config-manager.js";

const logger = getLogger(import.meta.url);

const SYSTEM_TOPIC = "system/bridge/mqtt/";
const SERVICE_ASSET = "runtime";
const SERVICE_OBJECT_TYPE = "service";
const EXPLORE_TAGS = ["Explore"];
const EXTRACTION_MODE_ENUM = [...extractionModeValues];

const runtimeConfigApplyExample = {
  version: 1,
  connections: [
    {
      id: "broker-a",
      start: true,
      config: {
        host: "localhost",
        port: 1883,
        protocol: "mqtt",
        clientId: "uns-bridge-mqtt-broker-a",
      },
      mappings: [
        {
          id: "direct-field-temperature",
          config: {
            topicFilter: "factory/line1/machine1/simple",
            topic: "enterprise/site/area/line/",
            asset: "line-1-machine-1",
            objectType: "machine",
            objectId: "main",
            dataGroup: "mqtt-broker-a",
            expectedIntervalMs: 1000,
            outputs: [{ attribute: "temperature", extraction: { mode: "json-path", path: "value" } }],
          },
        },
        {
          id: "array-match-operation-hours",
          config: {
            topicFilter: "factory/line1/machine1/telemetry",
            topic: "enterprise/site/area/line/",
            asset: "line-1-machine-1",
            objectType: "machine",
            objectId: "main",
            dataGroup: "mqtt-broker-a",
            expectedIntervalMs: 1000,
            outputs: [{
              attribute: "operation-hours-total-s",
              selector: {
                matchField: "values.id",
                matchValue: "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
              },
              extraction: { mode: "json-path", path: "v" },
            }],
          },
        },
      ],
    },
  ],
} satisfies RuntimeConfigSnapshot;

const browseRequestExample = {
  config: {
    host: "localhost",
    port: 1883,
    protocol: "mqtt",
  },
  topicFilter: "factory/#",
  durationMs: 3000,
  maxTopics: 100,
  maxPayloadBytes: 2048,
};

const extractPreviewExample = {
  payloadText:
    "{\"timestamp\":1777011568734,\"values\":[{\"id\":\"OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s\",\"v\":27,\"q\":true,\"t\":1777011567252}]}",
  selector: {
    matchField: "values.id",
    matchValue: "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
  },
  extraction: {
    mode: "json-path",
    path: "v",
  },
};

const connectionEntryExample = runtimeConfigApplyExample.connections[0]!;
const mappingEntryExample = connectionEntryExample.mappings[1]!;

const connectionIdQuerySchema = z.object({
  id: z.string().min(1),
});

const connectionCreateBodySchema = z.object({
  id: z.string().min(1),
  start: z.boolean().optional(),
  config: runtimeConnectionConfigSchema,
  mappings: z
    .array(
      z.object({
        id: z.string().min(1),
        config: runtimeMappingConfigSchema,
      }),
    )
    .optional(),
});

const connectionUpdateBodySchema = z.object({
  id: z.string().min(1),
  start: z.boolean().optional(),
  config: runtimeConnectionConfigSchema,
});

const connectionControlBodySchema = z.object({
  id: z.string().min(1),
});

const mappingCreateBodySchema = z.object({
  connectionId: z.string().min(1),
  mapping: z.object({
    id: z.string().min(1),
    config: runtimeMappingConfigSchema,
  }),
});

const mappingDeleteBodySchema = z.object({
  connectionId: z.string().min(1),
  mappingId: z.string().min(1),
});

const browseBodySchema = z.object({
  config: runtimeConnectionConfigSchema,
  topicFilter: z.string().min(1).optional(),
  durationMs: z.number().int().positive().max(60000).optional(),
  maxTopics: z.number().int().positive().max(1000).optional(),
  maxPayloadBytes: z.number().int().positive().max(65536).optional(),
});

const extractPreviewBodySchema = z.object({
  payloadText: z.string().optional(),
  payloadBase64: z.string().optional(),
  extraction: z
    .object({
      mode: z.enum(extractionModeValues).default("text"),
      path: z.string().min(1).optional(),
    })
    .optional(),
  selector: z
    .object({
      matchField: z.string().min(1),
      matchValue: z.string().min(1),
    })
    .optional(),
});

type ConnectionCreateBody = z.output<typeof connectionCreateBodySchema>;
type ConnectionUpdateBody = z.output<typeof connectionUpdateBodySchema>;
type ConnectionControlBody = z.output<typeof connectionControlBodySchema>;
type MappingCreateBody = z.output<typeof mappingCreateBodySchema>;
type MappingDeleteBody = z.output<typeof mappingDeleteBodySchema>;

type ExploreGetRouteDefinition = BridgeManagementGetRouteDefinition;
type ExplorePostRouteDefinition = BridgeManagementPostRouteDefinition;

export const healthPath = buildUnsRoutePath(
  SYSTEM_TOPIC,
  SERVICE_ASSET,
  SERVICE_OBJECT_TYPE,
  "bridge",
  "health",
).slice(1);

function createRoutePath(route: {
  topic: string;
  asset: string;
  objectType: string;
  objectId: string;
  attribute: string;
}): string {
  return buildUnsRoutePath(route.topic, route.asset, route.objectType, route.objectId, route.attribute).slice(1);
}

function normalizeReqPath(path?: string): string | undefined {
  return path?.replace(/^\/+|\/+$/g, "");
}

function cloneConfig(snapshot: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  return structuredClone(snapshot);
}

function parseRequestBody<TSchema extends z.ZodTypeAny>(
  event: UnsEvents["apiPostEvent"],
  schema: TSchema,
): z.output<TSchema> {
  return schema.parse(event.req.body ?? {});
}

function parseQuery<TSchema extends z.ZodTypeAny>(
  event: UnsEvents["apiGetEvent"],
  schema: TSchema,
): z.output<TSchema> {
  return schema.parse(event.req.query ?? {});
}

async function executeHandler<TEvent extends UnsEvents["apiGetEvent"] | UnsEvents["apiPostEvent"]>(
  event: TEvent,
  handler: ((event: TEvent) => Promise<void> | void) | undefined,
  method: "GET" | "POST",
  reqPath: string | undefined,
): Promise<void> {
  if (!handler) {
    event.res.status(404).send("API handler not found");
    return;
  }

  try {
    await handler(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Bridge ${method} handler error [${reqPath}]: ${message}`);
    event.res.status(500).json({ error: message });
  }
}

function createConnectionCreateRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Connection entry to create or update. Existing mappings are preserved when mappings is omitted.",
    required: true,
    schema: {
      type: "object",
      required: ["id", "config"],
      properties: {
        id: { type: "string", example: "broker-a" },
        start: { type: "boolean", example: true },
        config: {
          type: "object",
          properties: {
            brokerUrl: { type: "string", example: "mqtt://localhost:1883" },
            host: { type: "string", example: "localhost" },
            port: { type: "number", example: 1883 },
            protocol: { type: "string", enum: ["mqtt", "mqtts", "ws", "wss", "tcp", "ssl"], example: "mqtt" },
            username: { type: "string", example: "operator" },
            password: { type: "string", example: "secret" },
            clientId: { type: "string", example: "uns-bridge-mqtt-broker-a" },
            clean: { type: "boolean", example: true },
            reconnectPeriod: { type: "number", example: 1000 },
            rejectUnauthorized: { type: "boolean", example: true },
          },
        },
        mappings: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "config"],
            properties: {
              id: { type: "string", example: "machine-temp" },
              config: {
                type: "object",
                required: ["topicFilter", "topic", "asset", "objectType", "objectId", "attribute"],
                properties: {
                  topicFilter: { type: "string", example: "factory/line1/machine1/telemetry" },
                  qos: { type: "number", enum: [0, 1, 2], example: 0 },
                  topic: { type: "string", example: "enterprise/site/area/line/" },
                  asset: { type: "string", example: "line-1-machine-1" },
                  objectType: { type: "string", example: "machine" },
                  objectId: { type: "string", example: "main" },
                  attribute: { type: "string", example: "temperature" },
                  dataGroup: { type: "string", example: "mqtt-broker-a" },
                  validityMode: { type: "string", enum: ["interval", "lifecycle"], example: "interval" },
                  lifecycleEndValue: { type: "string", example: "STOPPED" },
                  publishInitialValue: { type: "boolean", example: false },
                  expectedIntervalMs: { type: "number", example: 1000 },
                  selector: {
                    type: "object",
                    properties: {
                      matchField: { type: "string", example: "values.id" },
                      matchValue: {
                        type: "string",
                        example:
                          "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
                      },
                    },
                  },
                  extraction: {
                    type: "object",
                    properties: {
                      mode: { type: "string", enum: EXTRACTION_MODE_ENUM, example: "json-path" },
                      path: { type: "string", example: "v" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      example: connectionEntryExample,
    },
  };
}

function createConnectionUpdateRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Existing connection id plus replacement connection config",
    required: true,
    schema: {
      type: "object",
      required: ["id", "config"],
      properties: {
        id: { type: "string", example: "broker-a" },
        start: { type: "boolean", example: true },
        config: {
          type: "object",
          properties: {
            brokerUrl: { type: "string", example: "mqtt://localhost:1883" },
            host: { type: "string", example: "localhost" },
            port: { type: "number", example: 1883 },
            protocol: { type: "string", enum: ["mqtt", "mqtts", "ws", "wss", "tcp", "ssl"], example: "mqtt" },
            username: { type: "string", example: "operator" },
            password: { type: "string", example: "secret" },
            clientId: { type: "string", example: "uns-bridge-mqtt-broker-a" },
          },
        },
      },
      example: {
        id: "broker-a",
        start: true,
        config: connectionEntryExample.config,
      },
    },
  };
}

function createConnectionControlRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Connection id",
    required: true,
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", example: "broker-a" },
      },
      example: { id: "broker-a" },
    },
  };
}

function createMappingRequestBody(description: string): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description,
    required: true,
    schema: {
      type: "object",
      required: ["connectionId", "mapping"],
      properties: {
        connectionId: { type: "string", example: "broker-a" },
        mapping: {
          type: "object",
          required: ["id", "config"],
          properties: {
            id: { type: "string", example: "machine-temp" },
            config: {
              type: "object",
              required: ["topicFilter", "topic", "asset", "objectType", "objectId", "attribute"],
              properties: {
                topicFilter: { type: "string", example: "factory/line1/machine1/telemetry" },
                qos: { type: "number", enum: [0, 1, 2], example: 0 },
                topic: { type: "string", example: "enterprise/site/area/line/" },
                asset: { type: "string", example: "line-1-machine-1" },
                objectType: { type: "string", example: "machine" },
                objectId: { type: "string", example: "main" },
                attribute: { type: "string", example: "temperature" },
                dataGroup: { type: "string", example: "mqtt-broker-a" },
                validityMode: { type: "string", enum: ["interval", "lifecycle"], example: "interval" },
                expectedIntervalMs: { type: "number", example: 1000 },
                selector: {
                  type: "object",
                  properties: {
                    matchField: { type: "string", example: "values.id" },
                    matchValue: {
                      type: "string",
                      example:
                        "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
                    },
                  },
                },
                extraction: {
                  type: "object",
                  properties: {
                      mode: { type: "string", enum: EXTRACTION_MODE_ENUM, example: "json-path" },
                    path: { type: "string", example: "v" },
                  },
                },
              },
            },
          },
        },
      },
      example: {
        connectionId: "broker-a",
        mapping: mappingEntryExample,
      },
    },
  };
}

function createMappingDeleteRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "Connection id plus mapping id",
    required: true,
    schema: {
      type: "object",
      required: ["connectionId", "mappingId"],
      properties: {
        connectionId: { type: "string", example: "broker-a" },
        mappingId: { type: "string", example: "machine-temp" },
      },
      example: {
        connectionId: "broker-a",
        mappingId: "machine-temp",
      },
    },
  };
}

function createConfigSnapshotRequestBody(description: string): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description,
    required: true,
    schema: {
      type: "object",
      required: ["version", "connections"],
      properties: {
        version: { type: "number", enum: [1], example: 1 },
        updatedAt: { type: "string", format: "date-time", example: "2026-04-24T08:00:00.000Z" },
        connections: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "config"],
            properties: {
              id: { type: "string", example: "broker-a" },
              start: { type: "boolean", example: true },
              config: { type: "object" },
              mappings: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      example: runtimeConfigApplyExample,
    },
  };
}

function createConfigReloadRequestBody(): NonNullable<IPostEndpointOptions["requestBody"]> {
  return {
    description: "No body required",
    required: false,
    schema: {
      type: "object",
      example: {},
    },
  };
}

export function createBridgeApiRoutes(
  engine: BridgeEngine<MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent>,
  adapter: MqttAdapter,
  runtimeConfigManager: RuntimeConfigManager,
): BridgeManagementApiRoutes {
  const managementRoutes = createBridgeManagementApiRoutes({
    namespace: {
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
    },
    engine,
    runtimeConfigManager,
    schemas: {
      connectionIdQuerySchema,
      connectionCreateBodySchema,
      connectionUpdateBodySchema,
      connectionControlBodySchema,
      mappingCreateBodySchema,
      mappingDeleteBodySchema,
      runtimeConfigSnapshotSchema,
    },
    mutations: {
      upsertConnection: (snapshot, body: ConnectionCreateBody) => {
        const nextConfig = cloneConfig(snapshot);
        const index = nextConfig.connections.findIndex((connection) => connection.id === body.id);
        if (index >= 0) {
          const existingConnection = nextConfig.connections[index];
          if (!existingConnection) {
            throw new Error(`Connection '${body.id}' does not exist`);
          }
          nextConfig.connections[index] = {
            ...existingConnection,
            config: body.config,
            ...(body.start !== undefined ? { start: body.start } : {}),
            ...(body.mappings !== undefined ? { mappings: body.mappings } : {}),
          };
        } else {
          nextConfig.connections.push({
            ...body,
            mappings: body.mappings ?? [],
          });
        }
        return nextConfig;
      },
      updateConnection: (snapshot, body: ConnectionUpdateBody) => {
        const nextConfig = cloneConfig(snapshot);
        const index = nextConfig.connections.findIndex((connection) => connection.id === body.id);
        if (index < 0) {
          throw new Error(`Connection '${body.id}' does not exist`);
        }
        const existingConnection = nextConfig.connections[index];
        if (!existingConnection) {
          throw new Error(`Connection '${body.id}' does not exist`);
        }
        nextConfig.connections[index] = {
          ...existingConnection,
          config: body.config,
          ...(body.start !== undefined ? { start: body.start } : {}),
        };
        return nextConfig;
      },
      deleteConnection: (snapshot, body: ConnectionControlBody) => {
        const nextConfig = cloneConfig(snapshot);
        nextConfig.connections = nextConfig.connections.filter((connection) => connection.id !== body.id);
        return nextConfig;
      },
      startConnection: (snapshot, body: ConnectionControlBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.id);
        if (!connection) {
          throw new Error(`Connection '${body.id}' does not exist`);
        }
        connection.start = true;
        return nextConfig;
      },
      stopConnection: (snapshot, body: ConnectionControlBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.id);
        if (!connection) {
          throw new Error(`Connection '${body.id}' does not exist`);
        }
        connection.start = false;
        return nextConfig;
      },
      upsertMapping: (snapshot, body: MappingCreateBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
        if (!connection) {
          throw new Error(`Connection '${body.connectionId}' does not exist`);
        }
        const mappingIndex = connection.mappings.findIndex((mapping) => mapping.id === body.mapping.id);
        if (mappingIndex >= 0) {
          connection.mappings[mappingIndex] = body.mapping;
        } else {
          connection.mappings.push(body.mapping);
        }
        return nextConfig;
      },
      updateMapping: (snapshot, body: MappingCreateBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
        if (!connection) {
          throw new Error(`Connection '${body.connectionId}' does not exist`);
        }
        const mappingIndex = connection.mappings.findIndex((mapping) => mapping.id === body.mapping.id);
        if (mappingIndex < 0) {
          throw new Error(`Mapping '${body.mapping.id}' does not exist on connection '${body.connectionId}'`);
        }
        connection.mappings[mappingIndex] = body.mapping;
        return nextConfig;
      },
      deleteMapping: (snapshot, body: MappingDeleteBody) => {
        const nextConfig = cloneConfig(snapshot);
        const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
        if (!connection) {
          throw new Error(`Connection '${body.connectionId}' does not exist`);
        }
        connection.mappings = connection.mappings.filter((mapping) => mapping.id !== body.mappingId);
        return nextConfig;
      },
    },
    swagger: {
      connectionCreateRequestBody: createConnectionCreateRequestBody(),
      connectionUpdateRequestBody: createConnectionUpdateRequestBody(),
      connectionControlRequestBody: createConnectionControlRequestBody(),
      mappingCreateRequestBody: createMappingRequestBody("Connection id plus mapping entry"),
      mappingUpdateRequestBody: createMappingRequestBody("Connection id plus replacement mapping entry"),
      mappingDeleteRequestBody: createMappingDeleteRequestBody(),
      configApplyRequestBody: createConfigSnapshotRequestBody("Full runtime config snapshot"),
      configValidateRequestBody: createConfigSnapshotRequestBody("Full runtime config snapshot"),
      configReloadRequestBody: createConfigReloadRequestBody(),
    },
    tags: {
      health: ["Health"],
      status: ["Status"],
      connections: ["Connections"],
      mappings: ["Mappings"],
      configuration: ["Configuration"],
    },
  });

  const apiGetRoutes = {
    ...managementRoutes.apiGetRoutes,
  } satisfies Record<string, ExploreGetRouteDefinition>;

  const apiPostRoutes = {
    ...managementRoutes.apiPostRoutes,
    browseTopics: {
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "browse",
      attribute: "topics",
      options: {
        apiDescription: "Temporarily connect to an MQTT broker, subscribe to a topic filter, and return observed topics with payload samples",
        tags: EXPLORE_TAGS,
        requestBody: {
          description: "Temporary MQTT connection settings and browse window",
          required: true,
          schema: {
            type: "object",
            required: ["config"],
            properties: {
              config: {
                type: "object",
                properties: {
                  brokerUrl: { type: "string", example: "mqtt://localhost:1883" },
                  host: { type: "string", example: "localhost" },
                  port: { type: "number", example: 1883 },
                  protocol: { type: "string", enum: ["mqtt", "mqtts", "ws", "wss", "tcp", "ssl"], example: "mqtt" },
                  username: { type: "string", example: "operator" },
                  password: { type: "string", example: "secret" },
                  clientId: { type: "string", example: "browse-mqtt-topics" },
                },
              },
              topicFilter: { type: "string", example: "factory/#" },
              durationMs: { type: "number", example: 3000 },
              maxTopics: { type: "number", example: 100 },
              maxPayloadBytes: { type: "number", example: 2048 },
            },
            example: browseRequestExample,
          },
        },
      } satisfies IPostEndpointOptions,
      handler: async (event) => {
        const input = parseRequestBody(event, browseBodySchema);
        event.res.json(await adapter.browse(input as Parameters<MqttAdapter["browse"]>[0]));
      },
    },
    previewExtraction: {
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "browse",
      attribute: "extract-preview",
      options: {
        apiDescription: "Preview how an MQTT payload extraction configuration resolves the UNS value",
        tags: EXPLORE_TAGS,
        requestBody: {
          description: "Sample payload plus extraction config",
          required: true,
          schema: {
            type: "object",
            properties: {
              payloadText: { type: "string", example: extractPreviewExample.payloadText },
              payloadBase64: { type: "string", example: "eyJmb28iOiJiYXIifQ==" },
              extraction: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: EXTRACTION_MODE_ENUM, example: "json-path" },
                  path: { type: "string", example: "v" },
                },
              },
              selector: {
                type: "object",
                properties: {
                  matchField: { type: "string", example: "values.id" },
                  matchValue: {
                    type: "string",
                    example:
                      "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
                  },
                },
              },
            },
            example: extractPreviewExample,
          },
        },
      } satisfies IPostEndpointOptions,
      handler: async (event) => {
        const input = parseRequestBody(event, extractPreviewBodySchema);
        event.res.json(adapter.previewExtraction(input as Parameters<MqttAdapter["previewExtraction"]>[0]));
      },
    },
  } satisfies Record<string, ExplorePostRouteDefinition>;

  return {
    apiGetRoutes,
    apiPostRoutes,
    apiGetRouteHandlers: Object.fromEntries(
      Object.values(apiGetRoutes).map((route) => [createRoutePath(route), route.handler as BridgeManagementGetHandler]),
    ) as Record<string, BridgeManagementGetHandler>,
    apiPostRouteHandlers: Object.fromEntries(
      Object.values(apiPostRoutes).map((route) => [createRoutePath(route), route.handler as BridgeManagementPostHandler]),
    ) as Record<string, BridgeManagementPostHandler>,
  };
}

export function registerBridgeApiEvents(
  apiInput: UnsApiProxy,
  apiGetRouteHandlers: Record<string, BridgeManagementGetHandler>,
  apiPostRouteHandlers: Record<string, BridgeManagementPostHandler>,
): void {
  apiInput.event.on("apiGetEvent", async (event: UnsEvents["apiGetEvent"]) => {
    const reqPath = normalizeReqPath(event.req.path);
    const handler = reqPath ? apiGetRouteHandlers[reqPath] : undefined;
    await executeHandler(event, handler, "GET", reqPath);
  });

  apiInput.event.on("apiPostEvent", async (event: UnsEvents["apiPostEvent"]) => {
    const reqPath = normalizeReqPath(event.req.path);
    const handler = reqPath ? apiPostRouteHandlers[reqPath] : undefined;
    await executeHandler(event, handler, "POST", reqPath);
  });
}
