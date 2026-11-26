'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncService } = require('../sync-service');

class TestHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createHarness() {
  const store = {};
  let queue = Promise.resolve();
  let saves = 0;
  const withStoreLock = fn => {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  };
  const service = createSyncService({
    loadStore: () => store,
    saveStore: () => { saves++; },
    withStoreLock,
    HttpError: TestHttpError,
  });
  return { store, service, get saves() { return saves; } };
}

test('conversation sync is idempotent and keeps complete message history', async () => {
  const { service, store } = createHarness();
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
    timestamp: new Date(1700000000000 + index).toISOString(),
  }));
  const snapshot = { id: 'conversation-1', title: 'History', msgs: messages };

  await Promise.all([
    service.syncConversations('uid-a', { clientConversations: [snapshot] }),
    service.syncConversations('uid-a', { clientConversations: [snapshot] }),
  ]);
  const result = service.getConversation('uid-a', 'conversation-1');

  assert.equal(result.msgs.length, 250);
  assert.equal(result.msgs[0].content, 'message 0');
  assert.equal(result.msgs[249].content, 'message 249');
  assert.equal(store.conversations['conversation-1'].owner, 'uid-a');
});

test('legacy messages receive stable IDs and account ownership is enforced', async () => {
  const { service } = createHarness();
  const snapshot = { id: 'conversation-2', title: 'Legacy', msgs: [{ role: 'user', content: 'hello' }] };
  await service.syncConversations('uid-a', { clientConversations: [snapshot] });
  await service.syncConversations('uid-a', { clientConversations: [snapshot] });

  assert.equal(service.getConversation('uid-a', 'conversation-2').msgs.length, 1);
  assert.throws(() => service.getConversation('uid-b', 'conversation-2'), { status: 403 });
  await assert.rejects(
    service.syncConversations('uid-b', { clientConversations: [snapshot] }),
    { status: 403 },
  );
});

test('attachment access and ID reuse are restricted to the owning account', async () => {
  const { service } = createHarness();
  await service.saveAttachment('uid-a', {
    id: 'att-shared',
    name: 'note.txt',
    mimeType: 'text/plain',
    kind: 'text',
    text: 'persistent attachment',
  });

  assert.equal(service.getAttachment('uid-a', 'att-shared').text, 'persistent attachment');
  assert.throws(() => service.getAttachment('uid-b', 'att-shared'), { status: 403 });
  await assert.rejects(
    service.saveAttachment('uid-b', { id: 'att-shared', text: 'replacement' }),
    { status: 403 },
  );
});

test('stale project updates do not overwrite newer versions and deletes are tombstoned', async () => {
  const { service } = createHarness();
  await service.syncProjects('uid-a', { projects: [{ id: 'project-1', version: 1, name: 'initial' }] });
  await service.syncProjects('uid-a', { projects: [{ id: 'project-1', version: 2, name: 'device A' }] });
  const stale = await service.syncProjects('uid-a', { projects: [{ id: 'project-1', version: 2, name: 'device B' }] });

  assert.deepEqual(stale.conflicts, ['project-1']);
  assert.equal(service.listProjects('uid-a')[0].name, 'device A');
  await service.syncProjects('uid-a', { deletedProjectIds: ['project-1'] });
  await service.syncProjects('uid-a', { projects: [{ id: 'project-1', version: 3, name: 'stale restore' }] });
  assert.equal(service.listProjects('uid-a').length, 0);
});

test('preferences are scoped to a user and only recognized fields are accepted', async () => {
  const { service } = createHarness();
  await service.updatePreferences('uid-a', { defaultModel: 'model-a', owner: 'uid-b' });
  assert.deepEqual(service.getPreferences('uid-a').defaultModel, 'model-a');
  assert.equal(service.getPreferences('uid-a').owner, undefined);
  assert.notEqual(service.getPreferences('uid-b').defaultModel, 'model-a');
});
