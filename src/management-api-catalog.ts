import {
  buildServiceApiInteractions,
  registerApiInteractions,
  registerApiEvents,
  type ServiceApiRegistration,
  type UnsApiProxy,
  type RegisterApiEventsOptions,
} from '@uns-kit/api';

/** These endpoints manage runtime state using fixed transport schemas. Their
 * configured source mappings / pinned artifacts are inspected separately; an
 * endpoint's JSON field names are not live canonical definition references. */
export async function registerManagementApiCatalog<Context, ServiceApis extends Record<string, ServiceApiRegistration<unknown>>>(
  api: UnsApiProxy,
  input: { serviceApis: ServiceApis; context: Context; options?: RegisterApiEventsOptions },
) {
  const routes = Object.values(buildServiceApiInteractions<unknown, ServiceApis>(api.getProcessName(), input.serviceApis));
  for (const route of routes) {
    const payload = route.options.serviceApi;
    if (!payload || typeof payload !== 'object') throw Error('Management API catalog payload is missing.');
    route.options = {
      ...route.options,
      serviceApi: {
        ...payload,
        metadata: {
          semanticReferences: { version: 1, definitions: [] },
          semanticReferenceBoundary: 'management-schema; configured mappings inspected by authenticated config/state',
        },
      },
    };
  }
  await registerApiInteractions(api, routes);
  registerApiEvents(api, routes, input.context, input.options);
  return { serviceApiRoutes: routes, dataOfferRoutes: [], dataCatalogOffers: [] };
}
