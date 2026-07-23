import type { ProtocolAdapter } from "@uns-kit/bridge-core";
import { browseTopics, inferPayloadTemplates } from "./mqtt-topic-browser.js";
import { MqttConnection, extractValue } from "./mqtt-connection.js";
import type {
  MqttBrowseTopicsInput,
  MqttBridgeConnectionConfig,
  MqttBridgeMappingConfig,
  MqttBridgeValueEvent,
  MqttPayloadSelector,
  MqttValueExtraction,
} from "./mqtt-types.js";

export class MqttAdapter
  implements ProtocolAdapter<MqttBridgeConnectionConfig, MqttBridgeMappingConfig, MqttBridgeValueEvent>
{
  constructor(private readonly retry: unknown) {
    void this.retry;
  }

  async createConnection(args: {
    id: string;
    config: MqttBridgeConnectionConfig;
  }): Promise<MqttConnection> {
    return new MqttConnection(args.id, args.config);
  }

  async validateConnection(config: MqttBridgeConnectionConfig): Promise<void> {
    if (!config.brokerUrl && !config.host && !(config.hosts?.length) && !(config.servers?.length)) {
      throw new Error("MQTT connection requires brokerUrl, host, hosts, or servers");
    }
  }

  async browse(input: MqttBrowseTopicsInput) {
    return browseTopics(input as MqttBrowseTopicsInput);
  }

  previewExtraction(args: {
    payloadText?: string;
    payloadBase64?: string;
    selector?: MqttPayloadSelector;
    extraction?: MqttValueExtraction;
  }): {
    extractedValue: unknown;
    payloadText: string;
    payloadBase64: string;
    payloadJson?: unknown;
    templateSuggestions?: ReturnType<typeof inferPayloadTemplates>;
  } {
    const payloadBuffer = args.payloadBase64
      ? Buffer.from(args.payloadBase64, "base64")
      : Buffer.from(args.payloadText ?? "", "utf8");
    const payloadText = args.payloadText ?? payloadBuffer.toString("utf8");
    const { extractedValue, payloadJson } = extractValue(
      payloadBuffer,
      payloadText,
      args.selector,
      args.extraction,
    );

    return {
      extractedValue,
      payloadText,
      payloadBase64: payloadBuffer.toString("base64"),
      ...(payloadJson !== undefined ? { payloadJson } : {}),
      ...(payloadJson !== undefined ? { templateSuggestions: inferPayloadTemplates("preview", payloadJson) } : {}),
    };
  }
}
