import { CacheError, requireString } from './identity.js';

function names(value, field) {
  if (!Array.isArray(value)) throw new CacheError('InvalidInput', `resources.${field} must be an array`);
  const result = Array.from(value, name => requireString(name, 'resource name')).sort();
  if (new Set(result).size !== result.length) throw new CacheError('InvalidInput', `Duplicate resources.${field} name`);
  return Object.freeze(result);
}

export function resourceDeclaration(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !['requires', 'produces', 'detached'].includes(key))) {
    throw new CacheError('InvalidInput', 'resources accepts requires, produces and detached name lists');
  }
  const requires = options.requires === undefined ? Object.freeze([]) : names(options.requires, 'requires');
  const produces = names(options.produces ?? [], 'produces');
  const detached = names(options.detached ?? [], 'detached');
  if (detached.some(name => !produces.includes(name))) {
    throw new CacheError('InvalidInput', 'Detached resources must also appear in resources.produces');
  }
  return Object.freeze({ requires, produces, detached });
}

export function resourceValue(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new CacheError('InvalidResource', 'A resource must be an object');
  const name = requireString(value.name, 'resource name');
  const version = requireString(value.version, 'resource version');
  const expiresAt = value.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
    throw new CacheError('InvalidResource', 'expiresAt must be a nonnegative Unix millisecond timestamp or null');
  }
  return Object.freeze({ name, version, expiresAt });
}

export function resourceCatalog(values = []) {
  if (!Array.isArray(values)) throw new CacheError('InvalidInput', 'resources must be an array');
  const catalog = new Map();
  for (const value of values) {
    const resource = resourceValue(value);
    if (catalog.has(resource.name)) throw new CacheError('InvalidResource', `Duplicate resource ${resource.name}`);
    catalog.set(resource.name, resource);
  }
  return catalog;
}

export function dependencyList(catalog, namesToUse) {
  return namesToUse.map(name => {
    const resource = catalog.get(name);
    if (!resource) throw new CacheError('ResourceUnavailable', `Resource ${name} has not been published`, { name, phase: 'beforeExecution' });
    return resource;
  });
}

export function checkResources(resources, now, phase) {
  for (const resource of resources) {
    if (resource.expiresAt !== null && resource.expiresAt <= now) {
      throw new CacheError('ResourceExpired', `Resource ${resource.name} (${resource.version}) has expired`, { ...resource, phase });
    }
  }
}

export function resourceOutputs(spec, dependencies) {
  const produced = new Map();
  const inheritedExpiry = Math.min(Infinity, ...dependencies.map(resource => resource.expiresAt ?? Infinity));
  return {
    publish(name, value = {}) {
      if (!spec.produces.includes(name) || produced.has(name)) {
        throw new CacheError('InvalidResource', `Resource ${name} must be declared and published at most once`);
      }
      const resource = resourceValue({ ...value, name });
      const deadline = Math.min(resource.expiresAt ?? Infinity, spec.detached.includes(name) ? Infinity : inheritedExpiry);
      produced.set(name, { ...resource, expiresAt: deadline === Infinity ? null : deadline });
    },
    finish() {
      for (const name of spec.produces) {
        if (!produced.has(name)) throw new CacheError('InvalidResource', `Tool did not publish resource ${name}`);
      }
      return [...produced.values()];
    }
  };
}
