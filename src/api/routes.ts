import {
  defineDataCatalogField,
  defineDataCatalogQueryParam,
  defineDataCatalogSchema,
  defineServiceApi,
  type ServiceApiRegistration,
} from "@uns-kit/api";
import {
  createBridgeManagementServiceApis,
  type BridgeEngine,
} from "@uns-kit/bridge-core";
import type { IPostEndpointOptions } from "@uns-kit/core/uns/uns-interfaces.js";
import { z } from "zod";
import {
  extractionModeValues,
  runtimeConfigSnapshotSchema,
  runtimeConnectionConfigSchema,
  runtimeMappingConfigSchema,
  type RuntimeConfigSnapshot,
} from "../config/runtime-config.js";
import { MqttAdapter } from "../mqtt/mqtt-adapter.js";
import type { MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent } from "../mqtt/mqtt-types.js";
import { devicePreviewBodySchema, deviceAppendBodySchema } from "../runtime/reviewed-device.js";
import { withValidationErrors } from "./validation-error.js";
import { RuntimeConfigManager } from "../runtime/runtime-config-manager.js";

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

type BridgeServiceHandler = (event: { req: any; res: any }) => Promise<void>;

const browseRequestSchema = defineDataCatalogSchema({
  id: "mqtt-browse-topics-request",
  title: "MQTT Browse Topics Request",
  contentType: "application/json",
  fields: [
    defineDataCatalogField("brokerUrl", "string", "Broker URL", {
      path: "config.brokerUrl",
      example: "mqtt://localhost:1883",
    }),
    defineDataCatalogField("host", "string", "MQTT host", {
      path: "config.host",
      example: "localhost",
    }),
    defineDataCatalogField("port", "number", "MQTT port", {
      path: "config.port",
      example: 1883,
    }),
    defineDataCatalogField("protocol", "string", "MQTT protocol", {
      path: "config.protocol",
      example: "mqtt",
      enumValues: ["mqtt", "mqtts", "ws", "wss", "tcp", "ssl"],
    }),
    defineDataCatalogField("topicFilter", "string", "Topic filter to sample", {
      example: "factory/#",
    }),
    defineDataCatalogField("durationMs", "number", "Sampling duration in milliseconds", {
      example: 3000,
    }),
    defineDataCatalogField("maxTopics", "number", "Maximum distinct topics to return", {
      example: 100,
    }),
    defineDataCatalogField("maxPayloadBytes", "number", "Maximum payload sample size in bytes", {
      example: 2048,
    }),
  ],
  examplePayloads: [browseRequestExample],
});

const extractPreviewRequestSchema = defineDataCatalogSchema({
  id: "mqtt-extract-preview-request",
  title: "MQTT Extraction Preview Request",
  contentType: "application/json",
  fields: [
    defineDataCatalogField("payloadText", "string", "UTF-8 payload text", {
      example: extractPreviewExample.payloadText,
    }),
    defineDataCatalogField("payloadBase64", "string", "Binary payload as base64", {
      example: "eyJmb28iOiJiYXIifQ==",
    }),
    defineDataCatalogField("matchField", "string", "Selector field path", {
      path: "selector.matchField",
      example: "values.id",
    }),
    defineDataCatalogField("matchValue", "string", "Selector match value", {
      path: "selector.matchValue",
      example: "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
    }),
    defineDataCatalogField("mode", "string", "Extraction mode", {
      path: "extraction.mode",
      example: "json-path",
      enumValues: EXTRACTION_MODE_ENUM,
    }),
    defineDataCatalogField("path", "string", "Extraction path", {
      path: "extraction.path",
      example: "v",
    }),
  ],
  examplePayloads: [extractPreviewExample],
});

function parseBody<TSchema extends z.ZodTypeAny>(event: { req: any }, schema: TSchema): z.output<TSchema> {
  return schema.parse(event.req.body ?? {});
}

function cloneConfig(snapshot: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  return structuredClone(snapshot);
}

function toBrowseInput(input: z.output<typeof browseBodySchema>): Parameters<MqttAdapter["browse"]>[0] {
  return {
    config: {
      ...(input.config.brokerUrl ? { brokerUrl: input.config.brokerUrl } : {}),
      ...(input.config.host ? { host: input.config.host } : {}),
      ...(input.config.hosts ? { hosts: input.config.hosts } : {}),
      ...(input.config.servers
        ? {
            servers: input.config.servers.map((server) => ({
              host: server.host,
              ...(server.port !== undefined ? { port: server.port } : {}),
              ...(server.protocol ? { protocol: server.protocol } : {}),
            })),
          }
        : {}),
      ...(input.config.port !== undefined ? { port: input.config.port } : {}),
      ...(input.config.protocol ? { protocol: input.config.protocol } : {}),
      ...(input.config.username ? { username: input.config.username } : {}),
      ...(input.config.password ? { password: input.config.password } : {}),
      ...(input.config.clientId ? { clientId: input.config.clientId } : {}),
      ...(input.config.clean !== undefined ? { clean: input.config.clean } : {}),
      ...(input.config.keepalive !== undefined ? { keepalive: input.config.keepalive } : {}),
      ...(input.config.connectTimeout !== undefined ? { connectTimeout: input.config.connectTimeout } : {}),
      ...(input.config.reconnectPeriod !== undefined ? { reconnectPeriod: input.config.reconnectPeriod } : {}),
      ...(input.config.reconnectOnConnackError !== undefined
        ? { reconnectOnConnackError: input.config.reconnectOnConnackError }
        : {}),
      ...(input.config.resubscribe !== undefined ? { resubscribe: input.config.resubscribe } : {}),
      ...(input.config.queueQoSZero !== undefined ? { queueQoSZero: input.config.queueQoSZero } : {}),
      ...(input.config.rejectUnauthorized !== undefined ? { rejectUnauthorized: input.config.rejectUnauthorized } : {}),
      ...(input.config.properties
        ? {
            properties: {
              ...(input.config.properties.sessionExpiryInterval !== undefined
                ? { sessionExpiryInterval: input.config.properties.sessionExpiryInterval }
                : {}),
              ...(input.config.properties.receiveMaximum !== undefined
                ? { receiveMaximum: input.config.properties.receiveMaximum }
                : {}),
              ...(input.config.properties.maximumPacketSize !== undefined
                ? { maximumPacketSize: input.config.properties.maximumPacketSize }
                : {}),
              ...(input.config.properties.topicAliasMaximum !== undefined
                ? { topicAliasMaximum: input.config.properties.topicAliasMaximum }
                : {}),
              ...(input.config.properties.requestResponseInformation !== undefined
                ? { requestResponseInformation: input.config.properties.requestResponseInformation }
                : {}),
              ...(input.config.properties.requestProblemInformation !== undefined
                ? { requestProblemInformation: input.config.properties.requestProblemInformation }
                : {}),
              ...(input.config.properties.userProperties ? { userProperties: input.config.properties.userProperties } : {}),
            },
          }
        : {}),
      ...(input.config.ca ? { ca: input.config.ca } : {}),
      ...(input.config.cert ? { cert: input.config.cert } : {}),
      ...(input.config.key ? { key: input.config.key } : {}),
      ...(input.config.servername ? { servername: input.config.servername } : {}),
      ...(input.config.subscribeTimeoutMs !== undefined ? { subscribeTimeoutMs: input.config.subscribeTimeoutMs } : {}),
    },
    ...(input.topicFilter ? { topicFilter: input.topicFilter } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.maxTopics !== undefined ? { maxTopics: input.maxTopics } : {}),
    ...(input.maxPayloadBytes !== undefined ? { maxPayloadBytes: input.maxPayloadBytes } : {}),
  };
}

function toPreviewInput(
  input: z.output<typeof extractPreviewBodySchema>,
): Parameters<MqttAdapter["previewExtraction"]>[0] {
  return {
    ...(input.payloadText !== undefined ? { payloadText: input.payloadText } : {}),
    ...(input.payloadBase64 !== undefined ? { payloadBase64: input.payloadBase64 } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.extraction
      ? {
          extraction: {
            mode: input.extraction.mode,
            ...(input.extraction.path !== undefined ? { path: input.extraction.path } : {}),
          },
        }
      : {}),
  };
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
            username: { oneOf: [{type:"string",description:"Legacy local-only credential"}, {type:"object",additionalProperties:false,required:["provider","key"],properties:{provider:{type:"string",enum:["env"]},key:{type:"string",pattern:"^UNS_RUNTIME_SECRET_[A-Z][A-Z0-9_]{0,95}$"}}}], example:{provider:"env",key:"UNS_RUNTIME_SECRET_MQTT_USER"} },
            password: { oneOf: [{type:"string",description:"Legacy local-only credential"}, {type:"object",additionalProperties:false,required:["provider","key"],properties:{provider:{type:"string",enum:["env"]},key:{type:"string",pattern:"^UNS_RUNTIME_SECRET_[A-Z][A-Z0-9_]{0,95}$"}}}], example:{provider:"env",key:"UNS_RUNTIME_SECRET_MQTT_PASSWORD"} },
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
                        example: "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
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
      example: runtimeConfigApplyExample.connections[0],
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
            username: { oneOf: [{type:"string",description:"Legacy local-only credential"}, {type:"object",additionalProperties:false,required:["provider","key"],properties:{provider:{type:"string",enum:["env"]},key:{type:"string",pattern:"^UNS_RUNTIME_SECRET_[A-Z][A-Z0-9_]{0,95}$"}}}], example:{provider:"env",key:"UNS_RUNTIME_SECRET_MQTT_USER"} },
            password: { oneOf: [{type:"string",description:"Legacy local-only credential"}, {type:"object",additionalProperties:false,required:["provider","key"],properties:{provider:{type:"string",enum:["env"]},key:{type:"string",pattern:"^UNS_RUNTIME_SECRET_[A-Z][A-Z0-9_]{0,95}$"}}}], example:{provider:"env",key:"UNS_RUNTIME_SECRET_MQTT_PASSWORD"} },
            clientId: { type: "string", example: "uns-bridge-mqtt-broker-a" },
          },
        },
      },
      example: {
        id: "broker-a",
        start: true,
        config: runtimeConfigApplyExample.connections[0]!.config,
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
                      example: "OPC_UA.S7-1500.ServerInterfaces.Server interface_1.OPERATION_HOURS.Total_s",
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
        mapping: runtimeConfigApplyExample.connections[0]!.mappings[1],
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

function upsertConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionCreateBody): RuntimeConfigSnapshot {
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
}

function updateConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionUpdateBody): RuntimeConfigSnapshot {
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
}

function deleteConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionControlBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  nextConfig.connections = nextConfig.connections.filter((connection) => connection.id !== body.id);
  return nextConfig;
}

function startConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionControlBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.id);
  if (!connection) {
    throw new Error(`Connection '${body.id}' does not exist`);
  }
  connection.start = true;
  return nextConfig;
}

function stopConnection(snapshot: RuntimeConfigSnapshot, body: ConnectionControlBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.id);
  if (!connection) {
    throw new Error(`Connection '${body.id}' does not exist`);
  }
  connection.start = false;
  return nextConfig;
}

function upsertMapping(snapshot: RuntimeConfigSnapshot, body: MappingCreateBody): RuntimeConfigSnapshot {
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
}

function updateMapping(snapshot: RuntimeConfigSnapshot, body: MappingCreateBody): RuntimeConfigSnapshot {
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
}

function deleteMapping(snapshot: RuntimeConfigSnapshot, body: MappingDeleteBody): RuntimeConfigSnapshot {
  const nextConfig = cloneConfig(snapshot);
  const connection = nextConfig.connections.find((entry) => entry.id === body.connectionId);
  if (!connection) {
    throw new Error(`Connection '${body.connectionId}' does not exist`);
  }
  connection.mappings = connection.mappings.filter((mapping) => mapping.id !== body.mappingId);
  return nextConfig;
}

export function createServiceApis(
  engine: BridgeEngine<MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent>,
  adapter: MqttAdapter,
  runtimeConfigManager: RuntimeConfigManager,
): Record<string, ServiceApiRegistration<BridgeServiceHandler>> {
  const managementServiceApis = createBridgeManagementServiceApis<
    MqttBridgeConnectionConfig,
    MqttBridgeMappingConfig,
    MqttBridgeValueEvent,
    RuntimeConfigSnapshot,
    ConnectionCreateBody,
    ConnectionUpdateBody,
    ConnectionControlBody,
    MappingCreateBody,
    MappingDeleteBody
  >({
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
      upsertConnection,
      updateConnection,
      deleteConnection,
      startConnection,
      stopConnection,
      upsertMapping,
      updateMapping,
      deleteMapping,
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

  // Preserve bridge-core registrations/auth metadata; capture CRUD snapshots inside the manager queue.
  const mutations: Array<[string, z.ZodType<any>, (snapshot: RuntimeConfigSnapshot, body: any) => RuntimeConfigSnapshot]> = [
    ["connectionCreate", connectionCreateBodySchema, upsertConnection],
    ["connectionUpdate", connectionUpdateBodySchema, updateConnection],
    ["connectionDelete", connectionControlBodySchema, deleteConnection],
    ["connectionStart", connectionControlBodySchema, startConnection],
    ["connectionStop", connectionControlBodySchema, stopConnection],
    ["mappingCreate", mappingCreateBodySchema, upsertMapping],
    ["mappingUpdate", mappingCreateBodySchema, updateMapping],
    ["mappingDelete", mappingDeleteBodySchema, deleteMapping],
  ];
  for (const [key, schema, mutate] of mutations) {
    const registration = managementServiceApis[key]!;
    registration.handler = async event => {
      const input = schema.parse(event.req.body ?? {});
      event.res.json(await runtimeConfigManager.mutateConfig(snapshot => mutate(snapshot, input)));
    };
  }
  const apis = {
    ...managementServiceApis,
    previewDevice: defineServiceApi<BridgeServiceHandler>({
      topic: SYSTEM_TOPIC, asset: SERVICE_ASSET, objectType: SERVICE_OBJECT_TYPE,
      objectId: "devices", attribute: "preview-add", method: "POST", tags: ["Configuration"],
      description: "Validate one new stopped MQTT device without broker or configuration changes",
      requestBody: { required:true,contentType:"application/json",schemas:[defineDataCatalogSchema({
        id:"mqtt-reviewed-device-preview",title:"Reviewed MQTT device",contentType:"application/json",fields:[
          defineDataCatalogField("connection","object","New anonymous broker connection",{required:true}),
          defineDataCatalogField("mappings","array","Mappings for one explicit UNS device",{required:true}),
        ],
      })]},
      handler: async event => { event.res.json(await runtimeConfigManager.previewNewDevice(devicePreviewBodySchema.parse(event.req.body ?? {}))); },
    }),
    appendReviewedDevice: defineServiceApi<BridgeServiceHandler>({
      topic: SYSTEM_TOPIC, asset: SERVICE_ASSET, objectType: SERVICE_OBJECT_TYPE,
      objectId: "devices", attribute: "append-reviewed", method: "POST", tags: ["Configuration"],
      description: "Add one stopped MQTT device only if the reviewed configuration revision is current",
      requestBody: { required:true,contentType:"application/json",schemas:[defineDataCatalogSchema({
        id:"mqtt-reviewed-device-append",title:"Append reviewed MQTT device",contentType:"application/json",fields:[
          defineDataCatalogField("connection","object","Reviewed anonymous broker connection",{required:true}),
          defineDataCatalogField("mappings","array","Reviewed mappings for one explicit UNS device",{required:true}),
          defineDataCatalogField("expectedRevision","string","SHA-256 revision returned by preview",{required:true}),
        ],
      })]},
      handler: async event => {
        const {expectedRevision, ...device} = deviceAppendBodySchema.parse(event.req.body ?? {});
        event.res.json(await runtimeConfigManager.appendReviewedDevice(device, expectedRevision));
      },
    }),
    browseTopics: defineServiceApi<BridgeServiceHandler>({
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "browse",
      attribute: "topics",
      method: "POST",
      description:
        "Temporarily connect to an MQTT broker, subscribe to a topic filter, and return observed topics with payload samples",
      tags: EXPLORE_TAGS,
      requestBody: {
        required: true,
        description: "Temporary MQTT connection settings and browse window",
        contentType: "application/json",
        schemas: [browseRequestSchema],
      },
      handler: async (event) => {
        const input = parseBody(event, browseBodySchema);
        event.res.json(await adapter.browse(toBrowseInput(input)));
      },
    }),
    previewExtraction: defineServiceApi<BridgeServiceHandler>({
      topic: SYSTEM_TOPIC,
      asset: SERVICE_ASSET,
      objectType: SERVICE_OBJECT_TYPE,
      objectId: "browse",
      attribute: "extract-preview",
      method: "POST",
      description: "Preview how an MQTT payload extraction configuration resolves the UNS value",
      tags: EXPLORE_TAGS,
      requestBody: {
        required: true,
        description: "Sample payload plus extraction config",
        contentType: "application/json",
        schemas: [extractPreviewRequestSchema],
      },
      handler: async (event) => {
        const input = parseBody(event, extractPreviewBodySchema);
        event.res.json(adapter.previewExtraction(toPreviewInput(input)));
      },
    }),
  };
  return Object.fromEntries(Object.entries(apis).map(([key, registration]) => [key, {...registration, handler: withValidationErrors(registration.handler)}]));
}
