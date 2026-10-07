import type { RuntimeCredential } from "../runtime/local-secret-references.js";

export type MqttProtocol = "mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl";

export type MqttBridgeServerConfig = {
  host: string;
  port?: number;
  protocol?: MqttProtocol;
};

export type MqttBridgeConnectProperties = {
  sessionExpiryInterval?: number;
  receiveMaximum?: number;
  maximumPacketSize?: number;
  topicAliasMaximum?: number;
  requestResponseInformation?: boolean;
  requestProblemInformation?: boolean;
  userProperties?: Record<string, string>;
};

export type MqttBridgeConnectionConfig = {
  brokerUrl?: string;
  host?: string;
  hosts?: string[];
  servers?: MqttBridgeServerConfig[];
  port?: number;
  protocol?: MqttProtocol;
  username?: RuntimeCredential;
  password?: RuntimeCredential;
  clientId?: string;
  clean?: boolean;
  keepalive?: number;
  connectTimeout?: number;
  reconnectPeriod?: number;
  reconnectOnConnackError?: boolean;
  resubscribe?: boolean;
  queueQoSZero?: boolean;
  rejectUnauthorized?: boolean;
  properties?: MqttBridgeConnectProperties;
  ca?: string;
  cert?: string;
  key?: string;
  servername?: string;
  subscribeTimeoutMs?: number;
};

export type MqttExtractionMode = "raw" | "text" | "json-path";

export type MqttValueExtraction = {
  mode: MqttExtractionMode;
  path?: string;
};

export type MqttPayloadSelector = {
  matchField: string;
  matchValue: string;
};

export type MqttBridgeSharedTargetConfig = {
  topic: string;
  asset: string;
  assetDescription?: string;
  objectType: string;
  objectTypeDescription?: string;
  objectId: string;
};

export type MqttBridgeOutputConfig = Partial<MqttBridgeSharedTargetConfig> & {
  attribute: string;
  attributeDescription?: string;
  selector?: MqttPayloadSelector;
  extraction?: MqttValueExtraction;
};

export type MqttBridgeMappingConfig = MqttBridgeSharedTargetConfig & {
  topicFilter: string;
  qos?: 0 | 1 | 2;
  dataGroup?: string;
  validityMode?: "interval" | "lifecycle";
  lifecycleEndValue?: string;
  publishInitialValue?: boolean;
  expectedIntervalMs?: number;
  outputs: MqttBridgeOutputConfig[];
};

export type MqttBridgeValueEvent = {
  topic: string;
  timestamp: string;
  qos: number;
  retain: boolean;
  payloadText: string;
  payloadBase64: string;
  payloadJson?: unknown;
  selectedValue?: unknown;
  extractedValue?: unknown;
};

export type MqttBrowseTopicsInput = {
  config: MqttBridgeConnectionConfig;
  topicFilter?: string;
  durationMs?: number;
  maxTopics?: number;
  maxPayloadBytes?: number;
};

export type MqttBrowseTopicSample = {
  topic: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  qos: number;
  retain: boolean;
  payloadText: string;
  payloadBase64: string;
  payloadJson?: unknown;
};

export type MqttBrowseDiscoveredChild = {
  nodeId: string;
  browseName: string | null;
  displayName: string | null;
  nodeClass: string;
  typeDefinition: string | null;
  referenceTypeId: string | null;
  isForward: boolean;
  hasChildren: boolean;
  templates?: MqttBrowseTemplateCandidate[];
  selector?: {
    matchField: string;
    matchValue: string;
  };
  extraction?: {
    mode: "json-path";
    path?: string;
  };
  previewValue?: unknown;
};

export type MqttBrowseTemplateCandidate = {
  label: string;
  selector?: {
    matchField: string;
    matchValue: string;
  };
  extraction: {
    mode: "json-path";
    path: string;
  };
  previewValue?: unknown;
};

export type MqttBrowseTopicNode = MqttBrowseTopicSample & {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: "Topic";
  typeDefinition: null;
  referenceTypeId: null;
  isForward: true;
  hasChildren: boolean;
  children: MqttBrowseDiscoveredChild[];
};

export type MqttBrowseTopicsResult = {
  topicFilter: string;
  durationMs: number;
  maxTopics: number;
  topics: MqttBrowseTopicNode[];
  children: MqttBrowseTopicNode[];
};
