'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const adminPath = path.join(ROOT, 'admin.html');
let admin = fs.readFileSync(adminPath, 'utf8');

const oldCard = `<div class="gw-card" id="cashfree-gateway-card"><div class="gw-head"><div><h3 style="margin:0;font-size:15px">Cashfree Payment Gateway</h3><small class="muted">Credit Card &amp; UPI Checkout · Secrets stay backend-only</small></div><div class="actions"><span id="gw-status-pill" class="pill no">Checking...</span><button id="gw-test-conn" type="button">Test connection</button></div></div><div class="gw-meta"><span>Client ID: <strong id="gw-masked-key">Not set</strong></span><span>Environment: <strong id="gw-key-mode">—</strong></span><span>Webhook Secret: <strong id="gw-webhook-status">Not set</strong></span><span>Webhook URL: <code>/api/payments/webhook</code></span><span>Last Webhook: <strong id="gw-last-webhook">None yet</strong></span><span>Last Connection Check: <strong id="gw-last-check">Never</strong></span></div><form id="gw-config-form" class="settings-grid" style="align-items:end"><div class="field"><label for="gw-enabled">Gateway status</label><select id="gw-enabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field"><label for="gw-mode">Gateway mode</label><select id="gw-mode"><option value="sandbox">Sandbox (Test)</option><option value="production">Production (Live)</option></select></div><div class="field"><button id="gw-save-btn" type="submit">Save Gateway Settings</button></div></form><div id="gw-state" class="status" hidden style="margin-top:10px"></div></div>`;

const newCard = `<div class="gw-card" id="cashfree-gateway-card"><div class="gw-head"><div><h3 style="margin:0;font-size:15px">Cashfree Payments</h3><small class="muted">Credit Card &amp; UPI Checkout · Secrets stay backend-only</small></div><div class="actions"><span id="gw-status-pill" class="pill no">Checking...</span><button id="gw-test-conn" type="button">Test connection</button></div></div><div class="gw-meta"><span>Provider: <strong>Cashfree Payments</strong></span><span>Environment: <strong id="gw-key-mode">SANDBOX</strong></span><span>Client ID: <strong id="gw-masked-key">Not set</strong></span><span>Client Secret: <strong id="gw-secret-status">Not set</strong></span><span>Webhook Secret: <strong id="gw-webhook-status">Not set</strong></span><span>Credit Card: <strong id="gw-card-status">Enabled</strong></span><span>UPI: <strong id="gw-upi-status">Enabled</strong></span><span>Webhook URL: <code>/api/payments/webhook</code></span><span>Last Webhook: <strong id="gw-last-webhook">None yet</strong></span><span>Last Connection Check: <strong id="gw-last-check">Never</strong></span></div><form id="gw-config-form" class="settings-grid" style="align-items:end"><div class="field"><label for="gw-client-id">Client ID</label><input id="gw-client-id" type="text" placeholder="Enter Cashfree Client ID" autocomplete="off"></div><div class="field"><label for="gw-client-secret">Client Secret</label><input id="gw-client-secret" type="password" placeholder="Enter Client Secret" autocomplete="off"></div><div class="field"><label for="gw-webhook-secret">Webhook Secret</label><input id="gw-webhook-secret" type="password" placeholder="Optional Webhook Secret" autocomplete="off"></div><div class="field"><label for="gw-enabled">Gateway status</label><select id="gw-enabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field"><label for="gw-mode">Environment</label><select id="gw-mode"><option value="sandbox">Sandbox (Test)</option><option value="production">Production (Live)</option></select></div><div class="field"><button id="gw-save-btn" type="submit">Save Gateway Settings</button></div></form><div id="gw-state" class="status" hidden style="margin-top:10px"></div></div>`;

const oldRender = `function renderGatewayConfig(gw){
  if(!gw)return;
  const pill=$('gw-status-pill');
  if(pill){
   pill.className='pill '+(gw.ready?'ok':'no');
   pill.textContent=gw.ready?('Ready ('+gw.mode.toUpperCase()+')'):!gw.configured?'Credentials Not Set':!gw.enabled?'Disabled':'Check Config';
  }
  $('gw-masked-key').textContent=gw.maskedClientId||gw.maskedKeyId||'Not set';
  $('gw-key-mode').textContent=gw.keyMode?gw.keyMode.toUpperCase():(gw.mode?gw.mode.toUpperCase():'NONE');
  $('gw-webhook-status').textContent=gw.webhookConfigured?'Configured':'Not set';
  $('gw-last-webhook').textContent=gw.lastWebhookAt?(dateTime(gw.lastWebhookAt)+(gw.lastWebhookEvent?' ('+gw.lastWebhookEvent+')':'')):'None yet';
  $('gw-last-check').textContent=gw.lastConnectionCheck?(gw.lastConnectionCheck.ok?'OK · '+dateTime(gw.lastConnectionCheck.at):'Failed · '+(gw.lastConnectionCheck.message||gw.lastConnectionCheck.code)):'Never';
  $('gw-enabled').value=gw.enabled!==false?'true':'false';
  $('gw-mode').value=gw.mode==='live'?'live':'test';
 }`;

const newRender = `function renderGatewayConfig(gw){
  if(!gw)return;
  const pill=$('gw-status-pill');
  const isConn=Boolean(gw.lastConnectionCheck&&gw.lastConnectionCheck.ok);
  if(pill){
   pill.className='pill '+(isConn&&gw.ready?'ok':!gw.configured?'no':!gw.enabled?'no':isConn?'ok':'no');
   pill.textContent=!gw.configured?'Not Configured':!gw.enabled?'Disabled':isConn?('Connected ('+(gw.mode||'sandbox').toUpperCase()+')'):'Disconnected';
  }
  if($('gw-masked-key')) $('gw-masked-key').textContent=gw.maskedClientId||gw.maskedKeyId||'Not Configured';
  if($('gw-secret-status')) $('gw-secret-status').textContent=gw.clientSecretConfigured||gw.configured?'Configured':'Not Configured';
  if($('gw-key-mode')) $('gw-key-mode').textContent=(gw.mode||'sandbox').toUpperCase();
  if($('gw-webhook-status')) $('gw-webhook-status').textContent=gw.webhookConfigured?'Configured':'Not Configured';
  if($('gw-card-status')) $('gw-card-status').textContent=gw.enabled!==false?'Enabled':'Disabled';
  if($('gw-upi-status')) $('gw-upi-status').textContent=gw.enabled!==false?'Enabled':'Disabled';
  if($('gw-last-webhook')) $('gw-last-webhook').textContent=gw.lastWebhookAt?(dateTime(gw.lastWebhookAt)+(gw.lastWebhookEvent?' ('+gw.lastWebhookEvent+')':'')):'None yet';
  if($('gw-last-check')) $('gw-last-check').textContent=gw.lastConnectionCheck?(gw.lastConnectionCheck.ok?'Connected · '+dateTime(gw.lastConnectionCheck.at):'Failed · '+(gw.lastConnectionCheck.message||gw.lastConnectionCheck.code)):'Never';
  if($('gw-enabled')) $('gw-enabled').value=gw.enabled!==false?'true':'false';
  if($('gw-mode')) $('gw-mode').value=gw.mode==='production'?'production':'sandbox';
 }`;

const oldSubmit = `$('gw-config-form').addEventListener('submit',async event=>{
   event.preventDefault();const btn=$('gw-save-btn');btn.disabled=true;showGwMsg('');
   const mode=$('gw-mode').value;
   if(mode==='live'&&!confirm('Switch Cashfree gateway to LIVE mode? Real charges require Live keys and verified Cashfree activation.')){btn.disabled=false;return}
   try{
    const gw=await request('/api/admin/payments/config','PUT',{enabled:$('gw-enabled').value==='true',mode});
    renderGatewayConfig(gw);showGwMsg('Gateway configuration saved ('+(gw.mode==='live'?'LIVE':'TEST')+' mode).',false);
   }catch(e){showGwMsg(e.message||'Could not save gateway config.',true)}finally{btn.disabled=false}
  });`;

const newSubmit = `$('gw-config-form').addEventListener('submit',async event=>{
   event.preventDefault();const btn=$('gw-save-btn');btn.disabled=true;showGwMsg('');
   const mode=$('gw-mode').value;
   if(mode==='production'&&!confirm('Switch Cashfree gateway to PRODUCTION mode? Real charges require Live keys and verified Cashfree activation.')){btn.disabled=false;return}
   try{
    const payload={enabled:$('gw-enabled').value==='true',mode};
    const cid=$('gw-client-id')?$('gw-client-id').value.trim():'';
    const csec=$('gw-client-secret')?$('gw-client-secret').value.trim():'';
    const wsec=$('gw-webhook-secret')?$('gw-webhook-secret').value.trim():'';
    if(cid)payload.clientId=cid;
    if(csec)payload.clientSecret=csec;
    if(wsec)payload.webhookSecret=wsec;
    const gw=await request('/api/admin/payments/config','PUT',payload);
    renderGatewayConfig(gw);
    if($('gw-client-secret')) $('gw-client-secret').value='';
    if($('gw-webhook-secret')) $('gw-webhook-secret').value='';
    showGwMsg('Gateway configuration saved ('+(gw.mode==='production'?'PRODUCTION':'SANDBOX')+' mode).',false);
   }catch(e){showGwMsg(e.message||'Could not save gateway config.',true)}finally{btn.disabled=false}
  });`;

let adminN = admin.replace(/\r\n/g, '\n');
const oldCardN = oldCard.replace(/\r\n/g, '\n');
const oldRenderN = oldRender.replace(/\r\n/g, '\n');
const oldSubmitN = oldSubmit.replace(/\r\n/g, '\n');

if (adminN.includes(oldCardN)) {
  adminN = adminN.replace(oldCardN, newCard.replace(/\r\n/g, '\n'));
  console.log('Replaced card in admin.html');
} else {
  console.log('Card not matched exactly, trying fuzzy search');
  const cardStart = adminN.indexOf('id="cashfree-gateway-card"');
  if (cardStart !== -1) {
    const cardDivStart = adminN.lastIndexOf('<div class="gw-card"', cardStart);
    const cardEnd = adminN.indexOf('</div><div class="users-kpis"', cardStart) + 6;
    adminN = adminN.substring(0, cardDivStart) + newCard.replace(/\r\n/g, '\n') + adminN.substring(cardEnd);
    console.log('Replaced card in admin.html by bounds');
  }
}

const renderStart = adminN.indexOf('function renderGatewayConfig');
if (renderStart !== -1) {
  const renderEnd = adminN.indexOf('async function loadGatewayConfig', renderStart);
  adminN = adminN.substring(0, renderStart) + newRender.replace(/\r\n/g, '\n') + '\n ' + adminN.substring(renderEnd);
  console.log('Replaced renderGatewayConfig in admin.html');
}

const submitStart = adminN.indexOf("$('gw-config-form').addEventListener('submit'");
if (submitStart !== -1) {
  const submitEnd = adminN.indexOf("$('gw-test-conn').addEventListener('click'", submitStart);
  adminN = adminN.substring(0, submitStart) + newSubmit.replace(/\r\n/g, '\n') + '\n ' + adminN.substring(submitEnd);
  console.log('Replaced submit in admin.html');
}

fs.writeFileSync(adminPath, adminN.replace(/\n/g, '\r\n'), 'utf8');
console.log('admin.html updated successfully');
