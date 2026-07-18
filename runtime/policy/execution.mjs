const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const METHOD_RISK = new Map([
  ['GET', 0],
  ['HEAD', 0],
  ['OPTIONS', 0],
  ['POST', 25],
  ['PUT', 30],
  ['PATCH', 30],
  ['DELETE', 60],
  ['TRACE', 100],
]);

const LEVEL_FLOORS = new Map([
  ['safe', 0],
  ['medium', 26],
  ['high', 51],
  ['critical', 76],
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === 'string' && /\S/u.test(value);
}

function isTrimmedNonBlankString(value) {
  return isNonBlankString(value) && value === value.trim();
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function riskLevel(score) {
  if (score <= 25) return 'safe';
  if (score <= 50) return 'medium';
  if (score <= 75) return 'high';
  return 'critical';
}

function normalizedMethod(operation) {
  return typeof operation?.method === 'string'
    ? operation.method.toUpperCase()
    : 'UNKNOWN';
}

function stableStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => (
    typeof value === 'string' && value.length > 0
  )))].sort();
}

function sourceRiskFloor(risk) {
  if (!isObject(risk)) return 0;

  const score = Number.isFinite(risk.score)
    ? Math.max(0, Math.min(100, Math.ceil(risk.score)))
    : 0;
  const levelFloor = LEVEL_FLOORS.get(risk.level) ?? 0;
  return Math.max(score, levelFloor);
}

function hasPrivilegedRole(operation) {
  return stableStrings(operation?.auth?.allowedRoles).some((role) => (
    /^(?:admin|administrator|owner|root|superuser|super-admin)$/iu.test(role)
  ));
}

function requiredConfirmation(operation) {
  return Array.isArray(operation?.parameters) && operation.parameters.some((parameter) => (
    isObject(parameter)
      && parameter.required === true
      && typeof parameter.name === 'string'
      && /^(?:confirm|confirmation)$/iu.test(parameter.name)
  ));
}

function operationEvidence(operation) {
  return [operation?.path, operation?.summary]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Recomputes risk from execution evidence. Source risk is a one-way floor: it
 * can raise this result, but it can never lower evidence-derived risk.
 */
export function computeRisk(operation) {
  const method = normalizedMethod(operation);
  const reasons = [];
  const addReason = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  let score = METHOD_RISK.get(method) ?? 100;

  if (!READ_METHODS.has(method)) addReason(`method:${method}`);

  const authState = operation?.auth?.state;
  if (authState !== 'public' && authState !== 'required') {
    score += 15;
    addReason('auth:unknown');
  }

  const sideEffects = operation?.sideEffects;
  const sideEffectClasses = stableStrings(sideEffects?.classes);
  if (sideEffects?.state !== 'known') {
    score = 100;
    addReason('side-effects:unknown');
  } else if (sideEffectClasses.length > 0) {
    score += 5;
    for (const effectClass of sideEffectClasses) {
      addReason(`side-effect:${effectClass}`);
    }
  }

  const evidence = `${operationEvidence(operation)} ${sideEffectClasses.join(' ')}`;
  if (/\b(?:purge|reset)\b/u.test(evidence)) {
    score += 20;
    addReason('effect:purge-or-reset');
  }
  if (/\b(?:bulk|remove[ -]all)\b/u.test(evidence)) {
    score += 15;
    addReason('effect:bulk');
  }
  if (/\bcascade(?:s|d|ing)?\b/u.test(evidence)) {
    score += 10;
    addReason('effect:cascade');
  }
  if (/\bdelete\b/u.test(operationEvidence(operation))) {
    score += 15;
    addReason('effect:delete');
  }

  if (operation?.deleteMode === 'hard') {
    score += 15;
    addReason('delete-mode:hard');
  } else if (operation?.deleteMode === 'unknown') {
    score += 15;
    addReason('delete-mode:unknown');
  }

  if (hasPrivilegedRole(operation)) {
    score += 10;
    addReason('auth:privileged');
  }

  if (requiredConfirmation(operation)) {
    score += 15;
    addReason('confirmation:required');
  }

  if (!READ_METHODS.has(method)
      && !isNonBlankString(operation?.rollback)) {
    score += 15;
    addReason('rollback:missing');
  }

  for (const reason of stableStrings(operation?.risk?.reasons)) {
    addReason(`source:${reason}`);
  }
  score = Math.max(score, sourceRiskFloor(operation?.risk));
  score = Math.max(0, Math.min(100, Math.ceil(score)));

  return deepFreeze({ score, level: riskLevel(score), reasons });
}

function resolveOrigin(subject, config) {
  const approvedOrigins = new Set(
    stableStrings(config?.approvedOrigins),
  );
  const services = Array.isArray(config?.services)
    ? config.services.filter((service) => (
      isObject(service)
        && typeof service.name === 'string'
        && service.name.length > 0
        && approvedOrigins.has(service.approvedOrigin)
    ))
    : [];

  const requestedId = typeof subject?.originId === 'string'
    ? subject.originId
    : subject?.service;
  if (typeof requestedId === 'string' && requestedId.length > 0) {
    const matching = services.filter((service) => service.name === requestedId);
    return matching.length === 1 ? matching[0].name : null;
  }

  if (services.length === 1) return services[0].name;
  if (services.length === 0 && approvedOrigins.size === 1) return 'default';
  return null;
}

function resolveParameters(subject) {
  if (!Array.isArray(subject?.parameters)) return { complete: false, values: {} };

  const values = {};
  for (const parameter of subject.parameters) {
    if (!isObject(parameter)
        || typeof parameter.location !== 'string'
        || typeof parameter.name !== 'string') {
      return { complete: false, values: {} };
    }

    if (hasOwn(parameter, 'example') && parameter.example !== undefined) {
      values[`${parameter.location}:${parameter.name}`] = structuredClone(parameter.example);
    } else if (parameter.required === true) {
      return { complete: false, values: {} };
    }
  }
  return { complete: true, values };
}

function resolveRoles(subject) {
  const authState = subject?.auth?.state;
  const allowedRoles = stableStrings(subject?.auth?.allowedRoles)
    .filter((role) => role !== 'unauthenticated');
  const known = authState === 'public'
    || (authState === 'required' && allowedRoles.length > 0);
  return {
    known,
    roles: [...allowedRoles, 'unauthenticated'],
  };
}

function decision({ subjectId, action, reasonCode, risk, originId, roles, parameterValues }) {
  return deepFreeze({
    subjectId,
    action,
    reasonCode,
    riskScore: risk.score,
    riskLevel: risk.level,
    originId,
    roles,
    parameterValues: action === 'execute' ? parameterValues : {},
  });
}

function operationDecision(operation, risk, originId, roles, parameters, action, reasonCode) {
  return decision({
    subjectId: operation?.id ?? null,
    action,
    reasonCode,
    risk,
    originId,
    roles: roles.roles,
    parameterValues: parameters.values,
  });
}

function responsesAreKnown(operation) {
  return isObject(operation?.responses) && Object.keys(operation.responses).length > 0;
}

/**
 * Produces one explicit decision for an operation. The HTTP method, not
 * source-provided mutation metadata, determines whether mutation gates apply.
 */
export function planOperation({ operation, config, sandboxAcknowledged } = {}) {
  const method = normalizedMethod(operation);
  const mutation = !READ_METHODS.has(method);
  const risk = computeRisk(operation);
  const originId = resolveOrigin(operation, config);
  const roles = resolveRoles(operation);
  const parameters = resolveParameters(operation);
  const skip = (reasonCode) => operationDecision(
    operation,
    risk,
    originId,
    roles,
    parameters,
    'skip',
    reasonCode,
  );

  if (!mutation) {
    if (operation?.sideEffects?.state !== 'known') {
      return skip('READ_BLOCKED_UNKNOWN_EFFECTS');
    }
    if (originId === null) return skip('READ_BLOCKED_ORIGIN');
    if (!parameters.complete) return skip('READ_BLOCKED_PARAMETERS');
    if (!roles.known) return skip('READ_BLOCKED_UNKNOWN_AUTH');
    if (!responsesAreKnown(operation)) return skip('READ_BLOCKED_RESPONSES');
    return operationDecision(
      operation,
      risk,
      originId,
      roles,
      parameters,
      'execute',
      'READ_APPROVED',
    );
  }

  if (config?.allowMutations !== true) return skip('MUTATION_BLOCKED_DISABLED');
  if (!isTrimmedNonBlankString(operation?.id)
      || !Array.isArray(config?.mutationAllowlist)
      || !config.mutationAllowlist.includes(operation.id)) {
    return skip('MUTATION_BLOCKED_ALLOWLIST');
  }
  if (operation?.sideEffects?.state !== 'known') {
    return skip('MUTATION_BLOCKED_UNKNOWN_EFFECTS');
  }
  if (!isNonBlankString(operation?.rollback)) {
    return skip('MUTATION_BLOCKED_ROLLBACK');
  }
  if (config?.targetEnvironment !== 'development' && config?.targetEnvironment !== 'test') {
    return skip('MUTATION_BLOCKED_ENVIRONMENT');
  }
  if (originId === null) return skip('MUTATION_BLOCKED_ORIGIN');
  if (sandboxAcknowledged !== true) return skip('MUTATION_BLOCKED_ACKNOWLEDGEMENT');
  if (!roles.known) return skip('MUTATION_BLOCKED_UNKNOWN_AUTH');
  if (!parameters.complete) return skip('MUTATION_BLOCKED_PARAMETERS');

  return operationDecision(
    operation,
    risk,
    originId,
    roles,
    parameters,
    'execute',
    'MUTATION_APPROVED',
  );
}

function planRoute(route, config) {
  const risk = deepFreeze({ score: 0, level: 'safe', reasons: [] });
  const originId = resolveOrigin(route, config);
  const roles = resolveRoles(route);
  const parameters = resolveParameters(route);
  let action = 'execute';
  let reasonCode = 'ROUTE_APPROVED';

  if (originId === null) {
    action = 'skip';
    reasonCode = 'ROUTE_BLOCKED_ORIGIN';
  } else if (!parameters.complete) {
    action = 'skip';
    reasonCode = 'ROUTE_BLOCKED_PARAMETERS';
  } else if (!roles.known) {
    action = 'skip';
    reasonCode = 'ROUTE_BLOCKED_UNKNOWN_AUTH';
  }

  return decision({
    subjectId: route?.id ?? null,
    action,
    reasonCode,
    risk,
    originId,
    roles: roles.roles,
    parameterValues: parameters.values,
  });
}

function buildRoleUniverse({ manifest, config, operations, routes }) {
  const configuredRoles = isObject(config?.roles) ? Object.keys(config.roles) : [];
  const manifestRoles = [
    ...(Array.isArray(manifest?.operations) ? manifest.operations : []),
    ...(Array.isArray(manifest?.routes) ? manifest.routes : []),
  ].flatMap((subject) => stableStrings(subject?.auth?.allowedRoles));
  const decisionRoles = [...operations, ...routes]
    .flatMap((entry) => stableStrings(entry?.roles));

  return stableStrings([
    ...configuredRoles,
    ...manifestRoles,
    ...decisionRoles,
  ]).filter((role) => role !== 'unauthenticated');
}

/** Builds a complete, immutable policy ledger without filtering skipped work. */
export function buildExecutionPlan({ manifest, config, mode, sandboxAcknowledged } = {}) {
  const operations = Array.isArray(manifest?.operations)
    ? manifest.operations.map((operation) => planOperation({
      operation,
      config,
      sandboxAcknowledged,
    }))
    : [];
  const routes = Array.isArray(manifest?.routes)
    ? manifest.routes.map((route) => planRoute(route, config))
    : [];

  const roleUniverse = buildRoleUniverse({ manifest, config, operations, routes });

  return deepFreeze({ mode, roleUniverse, operations, routes });
}
