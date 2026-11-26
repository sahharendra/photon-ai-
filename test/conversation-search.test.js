'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchConversations } = require('../conversation-search');

const records = {
  'c1700000000000': {
    owner: 'user-a',
    title: 'Search implementation',
    updatedAt: '2025-01-03T00:00:00.000Z',
    messages: [{ role: 'user', content: 'Build the sidebar search.' }],
  },
  'c1700000000001': {
    owner: 'user-a',
    title: 'Planning',
    updatedAt: '2025-01-02T00:00:00.000Z',
    messages: [{ role: 'user', content: 'Review the SEARCH API design.' }],
  },
  'c1700000000002': {
    owner: 'user-b',
    title: 'Private Search',
    updatedAt: '2025-01-04T00:00:00.000Z',
    messages: [{ role: 'user', content: 'Private account details.' }],
  },
};

test('conversation search matches titles and message content case-insensitively', () => {
  const titleResult = searchConversations(records, 'user-a', 'IMPLEMENTATION');
  assert.equal(titleResult.items[0].id, 'c1700000000000');
  assert.equal(titleResult.items[0].matchType, 'title');

  const messageResult = searchConversations(records, 'user-a', 'search api');
  assert.equal(messageResult.items[0].id, 'c1700000000001');
  assert.equal(messageResult.items[0].matchType, 'message');
  assert.match(messageResult.items[0].excerpt, /SEARCH API/i);
});

test('conversation search is owner-scoped and paginates without duplicates', () => {
  const firstPage = searchConversations(records, 'user-a', 'search', { limit: 1 });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.items[0].id, 'c1700000000000');
  assert.equal(firstPage.nextCursor, '1');

  const secondPage = searchConversations(records, 'user-a', 'search', { limit: 1, cursor: Number(firstPage.nextCursor) });
  assert.equal(secondPage.items[0].id, 'c1700000000001');
  assert.equal(secondPage.nextCursor, null);

  assert.equal(searchConversations(records, 'user-a', 'private').total, 0);
  assert.equal(searchConversations(records, 'user-b', 'private').items[0].id, 'c1700000000002');
});
