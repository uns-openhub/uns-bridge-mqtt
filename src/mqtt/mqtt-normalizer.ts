import type { IMqttAttributeEntry, IMqttPublishRequest } from "@uns-kit/core";
import type { ISO8601 } from "@uns-kit/core/uns/uns-interfaces.js";
import type { ValueEventNormalizer } from "@uns-kit/bridge-core";
import type {
  MqttBridgeMappingConfig,
  MqttBridgeOutputConfig,
  MqttBridgeSharedTargetConfig,
  MqttBridgeValueEvent,
  MqttPayloadSelector,
  MqttValueExtraction,
} from "./mqtt-types.js";

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

function resolveOutputs(mapping: MqttBridgeMappingConfig): MqttBridgeOutputConfig[] {
  const validOutputs = mapping.outputs.filter(
    (output): output is MqttBridgeOutputConfig =>
      Boolean(output && typeof output.attribute === "string" && output.attribute.trim().length > 0),
  );
  if (validOutputs.length === 0) {
    throw new Error(`Mapping '${mapping.topicFilter}' has outputs but none with a valid attribute`);
  }
  return validOutputs;
}

export function resolveMqttTarget(mapping: MqttBridgeMappingConfig, output: MqttBridgeOutputConfig): MqttBridgeSharedTargetConfig {
  return {
    topic: output.topic ?? mapping.topic,
    asset: output.asset ?? mapping.asset,
    ...(output.assetDescription ?? mapping.assetDescription
      ? { assetDescription: output.assetDescription ?? mapping.assetDescription }
      : {}),
    objectType: output.objectType ?? mapping.objectType,
    ...(output.objectTypeDescription ?? mapping.objectTypeDescription
      ? { objectTypeDescription: output.objectTypeDescription ?? mapping.objectTypeDescription }
      : {}),
    objectId: output.objectId ?? mapping.objectId,
  };
}

function extractOutputValue(
  event: MqttBridgeValueEvent,
  selector: MqttPayloadSelector | undefined,
  extraction: MqttValueExtraction | undefined,
): unknown {
  const mode = extraction?.mode ?? "text";
  const payloadRoot = event.payloadJson ?? event.payloadText;
  const selectedValue = selector ? selectPayloadValue(payloadRoot, selector) : payloadRoot;

  if (mode === "raw") {
    return event.payloadBase64;
  }

  if (mode === "text") {
    if (typeof selectedValue === "string") {
      return selectedValue;
    }
    return JSON.stringify(selectedValue);
  }

  if (!extraction?.path) {
    throw new Error("Extraction mode 'json-path' requires path");
  }

  const value = resolveJsonPath(selectedValue, extraction.path);
  if (value === undefined) {
    throw new Error(`Extraction path '${extraction.path}' did not resolve to a value on the selected payload`);
  }
  return value;
}

function buildAttributeEntry(
  connectionId: string,
  mapping: MqttBridgeMappingConfig,
  output: MqttBridgeOutputConfig,
  event: MqttBridgeValueEvent,
): IMqttAttributeEntry {
  const value = extractOutputValue(event, output.selector, output.extraction);

  return {
    attribute: output.attribute,
    ...(output.attributeDescription ? { description: output.attributeDescription } : {}),
    ...(
      mapping.validityMode
        ? { validityMode: mapping.validityMode }
        : mapping.expectedIntervalMs
          ? { validityMode: "interval" as const }
          : {}
    ),
    ...(mapping.expectedIntervalMs ? { expectedIntervalMs: mapping.expectedIntervalMs } : {}),
    ...(mapping.lifecycleEndValue ? { lifecycleEndValue: mapping.lifecycleEndValue } : {}),
    data: {
      time: event.timestamp as ISO8601,
      value:
        typeof value === "number" || typeof value === "string"
          ? value
          : JSON.stringify(value),
      dataGroup: mapping.dataGroup ?? connectionId,
    },
  };
}

export const mqttNormalizer: ValueEventNormalizer<MqttBridgeMappingConfig, MqttBridgeValueEvent> = ({
  connectionId,
  mapping,
  event,
}) => {
  const grouped = new Map<string, { target: MqttBridgeSharedTargetConfig; attributes: IMqttAttributeEntry[] }>();

  for (const output of resolveOutputs(mapping)) {
    const target = resolveMqttTarget(mapping, output);
    const key = [
      target.topic,
      target.asset,
      target.assetDescription ?? "",
      target.objectType,
      target.objectTypeDescription ?? "",
      target.objectId,
    ].join("|");

    const group = grouped.get(key) ?? { target, attributes: [] };
    group.attributes.push(buildAttributeEntry(connectionId, mapping, output, event));
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map(({ target, attributes }) => ({
    topic: target.topic,
    asset: target.asset,
    ...(target.assetDescription ? { assetDescription: target.assetDescription } : {}),
    objectType: target.objectType,
    ...(target.objectTypeDescription ? { objectTypeDescription: target.objectTypeDescription } : {}),
    objectId: target.objectId,
    attributes,
  })) satisfies IMqttPublishRequest[];
};
