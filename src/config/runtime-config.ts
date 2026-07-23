import { z } from "zod";

export const mqttProtocolValues = ["mqtt", "mqtts", "ws", "wss", "tcp", "ssl"] as const;
export const mqttProtocolSchema = z.enum(mqttProtocolValues);

export const mqttServerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  protocol: mqttProtocolSchema.optional(),
});

export const mqttPropertiesSchema = z.object({
  sessionExpiryInterval: z.number().int().nonnegative().optional(),
  receiveMaximum: z.number().int().positive().optional(),
  maximumPacketSize: z.number().int().positive().optional(),
  topicAliasMaximum: z.number().int().nonnegative().optional(),
  requestResponseInformation: z.boolean().optional(),
  requestProblemInformation: z.boolean().optional(),
  userProperties: z.record(z.string()).optional(),
});

export const runtimeConnectionConfigSchema = z.object({
  brokerUrl: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  hosts: z.array(z.string().min(1)).optional(),
  servers: z.array(mqttServerSchema).optional(),
  port: z.number().int().positive().optional(),
  protocol: mqttProtocolSchema.optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clean: z.boolean().optional(),
  keepalive: z.number().int().positive().optional(),
  connectTimeout: z.number().int().positive().optional(),
  reconnectPeriod: z.number().int().nonnegative().optional(),
  reconnectOnConnackError: z.boolean().optional(),
  resubscribe: z.boolean().optional(),
  queueQoSZero: z.boolean().optional(),
  rejectUnauthorized: z.boolean().optional(),
  properties: mqttPropertiesSchema.optional(),
  ca: z.string().min(1).optional(),
  cert: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  servername: z.string().min(1).optional(),
  subscribeTimeoutMs: z.number().int().positive().optional(),
});

export const extractionModeValues = ["raw", "text", "json-path"] as const;
export const extractionModeSchema = z.enum(extractionModeValues);

export const extractionConfigSchema = z.object({
  mode: extractionModeSchema.default("text"),
  path: z.string().min(1).optional(),
});

export const payloadSelectorSchema = z.object({
  matchField: z.string().min(1),
  matchValue: z.string().min(1),
});

export const runtimeMappingOutputSchema = z.object({
  topic: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  assetDescription: z.string().min(1).optional(),
  objectType: z.string().min(1).optional(),
  objectTypeDescription: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  attribute: z.string().min(1),
  attributeDescription: z.string().min(1).optional(),
  selector: payloadSelectorSchema.optional(),
  extraction: extractionConfigSchema.optional(),
});

export const runtimeMappingConfigSchema = z.object({
  topicFilter: z.string().min(1),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  topic: z.string().min(1),
  asset: z.string().min(1),
  assetDescription: z.string().min(1).optional(),
  objectType: z.string().min(1),
  objectTypeDescription: z.string().min(1).optional(),
  objectId: z.string().min(1),
  dataGroup: z.string().min(1).optional(),
  validityMode: z.enum(["interval", "lifecycle"]).optional(),
  lifecycleEndValue: z.string().min(1).optional(),
  publishInitialValue: z.boolean().optional(),
  expectedIntervalMs: z.number().int().positive().optional(),
  outputs: z.array(runtimeMappingOutputSchema).min(1),
});

export const runtimeConnectionEntrySchema = z.object({
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
    .default([]),
});

export const runtimeConfigSnapshotSchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string().datetime().optional(),
  connections: z.array(runtimeConnectionEntrySchema).default([]),
});

export type RuntimeConfigSnapshot = z.infer<typeof runtimeConfigSnapshotSchema>;
