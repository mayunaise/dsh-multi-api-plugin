/**
 * Route discovery: which credential reference each provider route resolves.
 *
 * This is what makes the plugin work for *any* provider rather than a baked-in
 * list. The harness already publishes, per route, the settings namespace and the
 * path whose profile object names the credential reference
 * (`LlmConfigurableProvider`); reading that directory and then the settings
 * section behind it yields `route → reference` without knowing anything about a
 * particular adapter — a shipped catalog route, a hand-declared gateway, or a
 * route some other adapter registers later all look the same here.
 *
 * @module dsh-multi-api-plugin/discovery
 */

/**
 * @typedef {object} RouteRef
 * @property {string} provider - the provider route key a request names.
 * @property {string} ref - the credential reference that route resolves.
 */

/**
 * Read the credential reference out of one route's profile.
 *
 * @param {{ get: (ns: string) => unknown }} settings - the settings service.
 * @param {{ settingsNs: string, settingsPath?: readonly string[] }} entry - a directory entry.
 * @returns {string | undefined} the reference, or undefined when the profile names none.
 */
function profileRef(settings, entry) {
  let profile = settings.get(entry.settingsNs)
  for (const segment of entry.settingsPath ?? []) {
    if (profile === null || typeof profile !== 'object') return undefined
    profile = profile[segment]
  }
  const ref = profile?.apiKeyEnv
  return typeof ref === 'string' && ref !== '' ? ref : undefined
}

/**
 * Build the route → reference map the rotation runtime uses.
 *
 * A route the directory describes but whose profile names no reference is simply
 * absent: it authenticates from provider-native ambient discovery, so there is
 * nothing to rotate. Explicit configuration wins over discovery, which is how a
 * route whose adapter registers no directory entry still gets in-request
 * failover.
 *
 * @param {object} spec - dependencies.
 * @param {{ listConfigurableProviders: () => readonly any[] }} spec.llm - the llm service.
 * @param {{ get: (ns: string) => unknown }} spec.settings - the settings service.
 * @param {Record<string, { ref?: string }>} [spec.routes] - explicit route connections.
 * @returns {Map<string, string>} provider route → credential reference.
 */
export function discoverRoutes({ llm, settings, routes = {} }) {
  const found = new Map()
  for (const entry of llm.listConfigurableProviders()) {
    const ref = profileRef(settings, entry)
    if (ref !== undefined && ref !== '') found.set(entry.provider, ref)
  }
  for (const [provider, spec] of Object.entries(routes)) {
    if (typeof spec?.ref === 'string' && spec.ref !== '') found.set(provider, spec.ref)
  }
  return found
}
