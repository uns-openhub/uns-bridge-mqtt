import assert from 'node:assert/strict';
import { test } from 'node:test';
const { registerManagementApiCatalog } = await import(process.env.J4_CATALOG_MODULE || '../dist/management-api-catalog.js');
test('management declarations preserve registration, dispatch and exact runtime context', async () => {
  const calls = [],
    listeners = new Map(),
    context = { marker: 'retained-context' };
  let invoked = 0;
  const api = { getProcessName: () => 'test-management', event: { on: (name, fn) => listeners.set(name, fn) } };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) api[method] = async (...args) => calls.push({ method, args });
  const handler = async (e, c) => {
    assert.equal(c, context);
    invoked++;
  };
  const serviceApis = {
    read: {
      attribute: 'state',
      description: 'Read status',
      method: 'GET',
      topic: 'system/j4',
      asset: 'runtime',
      objectType: 'service',
      objectId: 'catalog',
      handler,
    },
    write: {
      attribute: 'validate',
      description: 'Validate only',
      method: 'POST',
      topic: 'system/j4',
      asset: 'runtime',
      objectType: 'service',
      objectId: 'catalog',
      handler,
    },
  };
  const before = JSON.stringify(serviceApis);
  const r = await registerManagementApiCatalog(api, { serviceApis, context });
  assert.equal(JSON.stringify(serviceApis), before);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['get', 'post'],
  );
  for (const { args } of calls) {
    const options = args[5];
    assert.equal(options.registryTopic, 'service-endpoints');
    assert.equal(options.routeOnly, true);
    assert.deepEqual(options.serviceApi.metadata.semanticReferences, { version: 1, definitions: [] });
    assert(options.serviceApi.metadata.semanticReferenceBoundary);
    assert(options.serviceApi.description);
  }
  for (const [event, path] of [
    ['apiGetEvent', '/system/j4/runtime/service/catalog/state'],
    ['apiPostEvent', '/system/j4/runtime/service/catalog/validate'],
  ])
    await listeners.get(event)({
      req: { path },
      res: {
        status: () => {
          throw Error('Handler route lost');
        },
      },
    });
  assert.equal(invoked, 2);
  assert.equal(r.serviceApiRoutes.length, 2);
});
