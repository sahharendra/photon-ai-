'use strict';
// Daily plan limits and the settings migration version. Keeping these values in one module makes
// the enforced limits testable without starting the HTTP server.

const SETTINGS_VERSION = 2;
const PLAN_DAILY_LIMITS = Object.freeze({ basic: 50, pro: 200, premium: 2000 });

function canSpend(used, cost, limit) {
  const current = Number(used);
  const amount = Number(cost);
  const maximum = Number(limit);
  if (!Number.isFinite(current) || !Number.isFinite(amount) || !Number.isFinite(maximum)) return false;
  return current + amount <= maximum;
}

function remaining(used, limit) {
  const current = Number(used);
  const maximum = Number(limit);
  if (!Number.isFinite(current) || !Number.isFinite(maximum)) return 0;
  return Math.max(0, maximum - current);
}

module.exports = { SETTINGS_VERSION, PLAN_DAILY_LIMITS, canSpend, remaining };
