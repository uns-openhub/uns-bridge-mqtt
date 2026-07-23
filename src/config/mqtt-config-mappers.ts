import type { MqttBridgeConnectionConfig, MqttBridgeMappingConfig } from "../mqtt/mqtt-types.js";
import type { RuntimeConfigSnapshot } from "./runtime-config.js";

export type RawMqttConnectionConfig = RuntimeConfigSnapshot["connections"][number]["config"];
export type RawMqttMappingConfig = RuntimeConfigSnapshot["connections"][number]["mappings"][number]["config"];

export const toConnectionConfig = (input: RawMqttConnectionConfig): MqttBridgeConnectionConfig =>
  structuredClone(input) as MqttBridgeConnectionConfig;

export const toMappingConfig = (input: RawMqttMappingConfig): MqttBridgeMappingConfig => ({
  ...((structuredClone(input) as unknown) as MqttBridgeMappingConfig),
  outputs: input.outputs.map((output) => ({
    ...structuredClone(output),
    selector: output.selector ? structuredClone(output.selector) : undefined,
    extraction: output.extraction ? structuredClone(output.extraction) : undefined,
  })),
} as MqttBridgeMappingConfig);
