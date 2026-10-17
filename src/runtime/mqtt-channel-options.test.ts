import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mqttChannelParameters, resolveMqttChannel } from '@uns-kit/core';

test('bridge infrastructure/output preserve custom port and inherit authentication/TLS', () => {
  const infra = resolveMqttChannel({ host: 'one', port: 8884, protocol: 'mqtts', username: 'test-user', password: 'test-secret', ca: 'test-ca' });
  const output = resolveMqttChannel(infra, { host: 'two' });
  assert.equal(output.host, 'two');
  assert.deepEqual(mqttChannelParameters(output), { port: 8884, protocol: 'mqtts', username: 'test-user', password: 'test-secret', ca: 'test-ca' });
  assert.equal(resolveMqttChannel(infra, { port: 8885 }).port, 8885);
  assert.equal(resolveMqttChannel({ host: 'one' }).port, undefined);
});

test('bridge wires the full connection into process registration and publisher', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  assert.match(source, /new UnsProxyProcess\(processHost,\s*\{\s*\.\.\.mqttChannelParameters\(infraChannel\)/);
  assert.match(source, /createUnsMqttProxy\(\s*outputChannel.host,[\s\S]*?handover,\s*mqttChannelParameters\(outputChannel\)/);
});
