'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const serverPath = path.join(ROOT, 'server.js');
let code = fs.readFileSync(serverPath, 'utf8');

const oldStr = `if (pathname === '/api/admin/payments/config' && req.method === 'PUT') {
        const body = await readBody(req);
        const data = loadStore();
        data.settings = normalizeSettings(data.settings);
        if (typeof body.enabled === 'boolean') data.settings.cashfree.enabled = body.enabled;
        if (body.mode === 'sandbox' || body.mode === 'production') data.settings.cashfree.mode = body.mode;
        appendAdminAuditLog(data, { actor: isLocalAdminBypass(req) ? 'local-admin' : ADMIN_EMAIL, action: 'update_payment_gateway', details: { enabled: data.settings.cashfree.enabled, mode: data.settings.cashfree.mode } });
        saveStore();
        const gwStatus = cashfree.getGatewayStatus(data);
        return reply(res, 200, { success: true, data: { ...gwStatus } });
      }`;

const newStr = `if (pathname === '/api/admin/payments/config' && req.method === 'PUT') {
        const body = await readBody(req);
        const data = loadStore();
        data.settings = normalizeSettings(data.settings);
        if (typeof body.enabled === 'boolean') data.settings.cashfree.enabled = body.enabled;
        if (body.mode === 'sandbox' || body.mode === 'production') {
          data.settings.cashfree.mode = body.mode;
          process.env.CASHFREE_ENVIRONMENT = body.mode;
        }

        const envFile = resolveEnvFile(ROOT);
        if (body.clientId !== undefined && String(body.clientId).trim() !== '') {
          const cid = String(body.clientId).trim();
          process.env.CASHFREE_CLIENT_ID = cid;
          upsertEnvValue(envFile, 'CASHFREE_CLIENT_ID', cid);
        }
        if (body.clientSecret !== undefined && String(body.clientSecret).trim() !== '') {
          const csec = String(body.clientSecret).trim();
          process.env.CASHFREE_CLIENT_SECRET = csec;
          upsertEnvValue(envFile, 'CASHFREE_CLIENT_SECRET', csec);
        }
        if (body.webhookSecret !== undefined && String(body.webhookSecret).trim() !== '') {
          const wsec = String(body.webhookSecret).trim();
          process.env.CASHFREE_WEBHOOK_SECRET = wsec;
          upsertEnvValue(envFile, 'CASHFREE_WEBHOOK_SECRET', wsec);
        }
        if (body.mode) {
          upsertEnvValue(envFile, 'CASHFREE_ENVIRONMENT', body.mode);
        }

        appendAdminAuditLog(data, {
          actor: isLocalAdminBypass(req) ? 'local-admin' : ADMIN_EMAIL,
          action: 'update_payment_gateway',
          details: { enabled: data.settings.cashfree.enabled, mode: data.settings.cashfree.mode },
        });
        saveStore();
        const gwStatus = cashfree.getGatewayStatus(data);
        return reply(res, 200, { success: true, data: { ...gwStatus } });
      }`;

const codeN = code.replace(/\r\n/g, '\n');
const oldN = oldStr.replace(/\r\n/g, '\n');
if (codeN.includes(oldN)) {
  const replaced = codeN.replace(oldN, newStr.replace(/\r\n/g, '\n'));
  fs.writeFileSync(serverPath, replaced.replace(/\n/g, '\r\n'), 'utf8');
  console.log('Successfully updated server.js PUT /api/admin/payments/config');
} else {
  console.error('Could not find matching string in server.js');
  process.exit(1);
}
