'use strict';

function cleanConversationTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function conversationTitle(conversation) {
  const savedTitle = cleanConversationTitle(conversation?.title);
  if (savedTitle) return savedTitle;
  const firstUserMessage = Array.isArray(conversation?.messages)
    ? conversation.messages.find(message => message?.role === 'user' && typeof message.content === 'string')
    : null;
  return cleanConversationTitle(firstUserMessage?.content) || 'Conversation';
}

function conversationTime(id, conversation) {
  const updatedAt = Date.parse(conversation?.updatedAt || '');
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(conversation?.createdAt || '');
  if (Number.isFinite(createdAt)) return createdAt;
  const idTime = /^c(\d+)$/.exec(String(id || ''));
  return idTime ? Number(idTime[1]) : 0;
}

function excerptFor(text, query) {
  const content = String(text || '').replace(/\s+/g, ' ').trim();
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return content.slice(0, 180);
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + query.length + 100);
  return `${start ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function searchConversations(records, uid, query, { limit = 20, cursor = 0 } = {}) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery || normalizedQuery.length > 120) {
    throw new TypeError('Search query must contain 1 to 120 characters.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('Search limit must be between 1 and 50.');
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError('Search cursor must be a non-negative integer.');
  }

  const needle = normalizedQuery.toLowerCase();
  const matches = Object.entries(records || {})
    .filter(([, conversation]) => conversation && conversation.owner === uid)
    .map(([id, conversation]) => {
      const title = conversationTitle(conversation);
      const titleMatches = title.toLowerCase().includes(needle);
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const matchedMessage = messages.find(message =>
        typeof message?.content === 'string' && message.content.toLowerCase().includes(needle));
      if (!titleMatches && !matchedMessage) return null;
      const timestamp = conversationTime(id, conversation);
      return {
        id,
        title,
        excerpt: titleMatches ? title : excerptFor(matchedMessage.content, normalizedQuery),
        matchType: titleMatches ? 'title' : 'message',
        updatedAt: timestamp ? new Date(timestamp).toISOString() : null,
        sortTime: timestamp,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.sortTime - a.sortTime || b.id.localeCompare(a.id));

  const items = matches.slice(cursor, cursor + limit).map(({ sortTime, ...item }) => item);
  const next = cursor + items.length;
  return {
    items,
    total: matches.length,
    nextCursor: next < matches.length ? String(next) : null,
  };
}

module.exports = { cleanConversationTitle, conversationTitle, searchConversations };
