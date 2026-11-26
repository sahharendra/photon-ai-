'use strict';
/**
 * PHOTON AI - Cross-Device Data Synchronization & Persistent Storage Service
 *
 * Provides:
 * - Centralized backend persistence for conversations, messages, attachments, projects, and preferences
 * - Multi-device synchronization with incremental timestamp & version tracking
 * - Real-time SSE broadcasting to all active sessions of the same authenticated user
 * - Idempotency & deduplication for concurrent message submission and offline recovery
 * - Strict user-isolation enforcing ownership on every resource
 */

const crypto = require('node:crypto');

function createSyncService({
  loadStore,
  saveStore,
  withStoreLock,
  HttpError,
  logger = console,
}) {
  // In-memory registry of active SSE client connections: Map<uid, Set<http.ServerResponse>>
  const activeSseSubscribers = new Map();

  function getFreshStore() {
    return typeof loadStore === 'function' ? loadStore() : {};
  }

  function ensureUserContainers(s, uid) {
    if (!s.conversations) s.conversations = {};
    if (!s.deletedConversations) s.deletedConversations = {};
    if (!s.deletedConversations[uid]) s.deletedConversations[uid] = {};
    if (!s.chatAttachments) s.chatAttachments = {};
    if (!s.projects) s.projects = {};
    if (!s.projects[uid]) s.projects[uid] = [];
    if (!s.deletedProjects) s.deletedProjects = {};
    if (!s.deletedProjects[uid]) s.deletedProjects[uid] = {};
    if (!s.userPreferences) s.userPreferences = {};
    if (!s.userPreferences[uid]) {
      s.userPreferences[uid] = {
        defaultModel: null,
        activeConversationId: null,
        activeGenCat: 'text',
        theme: 'dark',
        updatedAt: new Date().toISOString(),
      };
    }
  }

  function mutateUser(uid, fn) {
    const mutate = () => {
      const s = getFreshStore();
      ensureUserContainers(s, uid);
      const result = fn(s);
      if (typeof saveStore === 'function') saveStore();
      return result;
    };
    return typeof withStoreLock === 'function' ? withStoreLock(mutate) : mutate();
  }

  /**
   * Normalize a message object for cross-device consistency
   */
  function normalizeMessage(m, index = 0, conversationId = 'legacy', createdAt = null) {
    if (!m || typeof m !== 'object') return null;
    const role = (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user';
    const content = typeof m.content === 'string' ? m.content : '';
    const timestampValue = m.timestamp || m.createdAt;
    const baseTime = Date.parse(createdAt || 0);
    const timestamp = timestampValue || new Date((Number.isFinite(baseTime) ? baseTime : 0) + index).toISOString();
    const fallbackId = crypto.createHash('sha256')
      .update(`${conversationId}\0${index}\0${role}\0${content}`)
      .digest('hex').slice(0, 32);
    const id = m.id || m.request_id || `msg_${fallbackId}`;

    const norm = {
      id,
      role,
      content,
      timestamp,
    };

    if (m.request_id) norm.request_id = m.request_id;
    if (m.reply_to_request_id) norm.reply_to_request_id = m.reply_to_request_id;
    if (m.model) norm.model = m.model;
    if (m.provider) norm.provider = m.provider;
    if (m.fallback) norm.fallback = m.fallback;
    if (m.kind) norm.kind = m.kind;
    if (m.imageAssetId) norm.imageAssetId = m.imageAssetId;
    if (m.image && !(m.imageAssetId && String(m.image).startsWith('data:image/'))) norm.image = m.image;
    if (m.videoUrl || m.video) norm.videoUrl = m.videoUrl || m.video;
    if (m.prompt) norm.prompt = m.prompt;
    if (m.originalPrompt) norm.originalPrompt = m.originalPrompt;
    if (m.enhancedPrompt) norm.enhancedPrompt = m.enhancedPrompt;
    if (m.wasEnhanced !== undefined) norm.wasEnhanced = m.wasEnhanced;
    if (m.aspectRatio) norm.aspectRatio = m.aspectRatio;
    if (m.dimensions) norm.dimensions = m.dimensions;

    if (Array.isArray(m.attachments) && m.attachments.length) {
      norm.attachments = m.attachments.filter(a => a && a.id).map(a => ({
        id: a.id,
        name: a.name || 'file',
        mimeType: a.mimeType || 'application/octet-stream',
        size: Number(a.size) || 0,
        kind: a.kind || 'inline',
        url: a.url || `/api/attachments/${a.id}`,
      }));
    } else {
      norm.attachments = [];
    }

    return norm;
  }

  /**
   * Merge two arrays of messages cleanly avoiding duplicates
   */
  function mergeMessages(existingMsgs = [], incomingMsgs = [], conversationId = 'legacy', createdAt = null) {
    const map = new Map();
    const existingNorm = existingMsgs.map((m, i) => normalizeMessage(m, i, conversationId, createdAt)).filter(Boolean);
    const incomingNorm = incomingMsgs.map((m, i) => normalizeMessage(m, i, conversationId, createdAt)).filter(Boolean);

    for (const m of existingNorm) {
      const key = m.request_id || m.id || `${m.role}:${m.timestamp}:${m.content.slice(0, 40)}`;
      map.set(key, m);
    }

    for (const m of incomingNorm) {
      const key = m.request_id || m.id || `${m.role}:${m.timestamp}:${m.content.slice(0, 40)}`;
      if (map.has(key)) {
        // Merge fields, preferring non-empty content / attachments
        const cur = map.get(key);
        map.set(key, {
          ...cur,
          ...m,
          attachments: (m.attachments && m.attachments.length) ? m.attachments : (cur.attachments || []),
          image: m.image || cur.image || null,
          videoUrl: m.videoUrl || cur.videoUrl || null,
        });
      } else {
        map.set(key, m);
      }
    }

    const merged = Array.from(map.values());
    merged.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
    return merged;
  }

  /**
   * Format a conversation for public API response
   */
  function formatConversation(c) {
    if (!c) return null;
    return {
      id: c.id,
      title: c.title || 'New chat',
      model: c.model || null,
      pin: Boolean(c.pin),
      pid: c.pid || null,
      version: Number(c.version) || 1,
      createdAt: c.createdAt || c.updatedAt || new Date().toISOString(),
      updatedAt: c.updatedAt || new Date().toISOString(),
      msgs: Array.isArray(c.messages) ? c.messages.map((m, i) => normalizeMessage(m, i, c.id, c.createdAt)).filter(Boolean) : [],
    };
  }

  /**
   * List all conversations owned by a user
   */
  function listConversations(uid, { since = 0, full = false } = {}) {
    const s = getFreshStore();
    ensureUserContainers(s, uid);

    const sinceMs = since ? (typeof since === 'string' ? Date.parse(since) : Number(since)) : 0;
    const deletedMap = s.deletedConversations[uid] || {};

    const list = Object.values(s.conversations || {})
      .filter(c => c && c.owner === uid && !deletedMap[c.id])
      .filter(c => {
        if (!sinceMs) return true;
        const up = Date.parse(c.updatedAt || c.createdAt || 0);
        return Number.isFinite(up) && up >= sinceMs;
      })
      .map(formatConversation)
      .sort((a, b) => {
        if (a.pin !== b.pin) return a.pin ? -1 : 1;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });

    return list;
  }

  /**
   * Get a single conversation with full message history
   */
  function getConversation(uid, conversationId) {
    const s = getFreshStore();
    ensureUserContainers(s, uid);

    const c = s.conversations[conversationId];
    if (!c || (s.deletedConversations[uid] && s.deletedConversations[uid][conversationId])) {
      throw new HttpError(404, 'conversation_not_found', 'Conversation not found.');
    }
    if (c.owner !== uid) {
      throw new HttpError(403, 'conversation_forbidden', 'You do not have access to this conversation.');
    }

    return formatConversation(c);
  }

  /**
   * Upsert a conversation (create or update title, pin, messages)
   */
  async function upsertConversation(uid, data = {}, { sourceRes = null } = {}) {
    const convId = String(data.id || '').trim();
    if (!convId || !/^[A-Za-z0-9_-]{1,120}$/.test(convId)) {
      throw new HttpError(400, 'invalid_conversation_id', 'Valid conversation ID is required.');
    }

    const conv = await mutateUser(uid, s => {
      const prior = s.conversations[convId];
      if (prior && prior.owner !== uid) {
        throw new HttpError(403, 'conversation_forbidden', 'You cannot modify this conversation.');
      }

      if (s.deletedConversations[uid][convId]) delete s.deletedConversations[uid][convId];

      const now = new Date().toISOString();
      const incomingMsgs = Array.isArray(data.msgs) ? data.msgs : (Array.isArray(data.messages) ? data.messages : []);
      const createdAt = prior?.createdAt || data.createdAt || now;
      const conv = {
        id: convId,
        owner: uid,
        title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 100) : (prior?.title || 'New chat'),
        model: data.model !== undefined ? data.model : (prior?.model || null),
        pin: data.pin !== undefined ? Boolean(data.pin) : Boolean(prior?.pin),
        pid: data.pid !== undefined ? data.pid : (prior?.pid || null),
        version: (Number(prior?.version) || 0) + 1,
        createdAt,
        updatedAt: now,
        messages: mergeMessages(prior?.messages || [], incomingMsgs, convId, createdAt),
        requests: prior?.requests || {},
      };
      s.conversations[convId] = conv;
      return conv;
    });

    const formatted = formatConversation(conv);
    broadcast(uid, 'conversation_updated', { conversation: formatted }, sourceRes);
    return formatted;
  }

  /**
   * Delete a conversation
   */
  async function deleteConversation(uid, conversationId, { sourceRes = null } = {}) {
    await mutateUser(uid, s => {
      const c = s.conversations[conversationId];
      if (c) {
        if (c.owner !== uid) {
          throw new HttpError(403, 'conversation_forbidden', 'You cannot delete this conversation.');
        }
        delete s.conversations[conversationId];
      }
      s.deletedConversations[uid][conversationId] = new Date().toISOString();
    });

    broadcast(uid, 'conversation_deleted', { conversationId }, sourceRes);
    return { deleted: true, conversationId };
  }

  /**
   * Bidirectional sync for conversations:
   * Merges incoming client conversations with server conversations and returns all updates
   */
  async function syncConversations(uid, { clientConversations = [], deletedConversationIds = [], lastSyncTime = 0 } = {}, { sourceRes = null } = {}) {
    const now = new Date().toISOString();
    const conflicts = [];
    await mutateUser(uid, s => {
      for (const clientC of clientConversations) {
        if (!clientC || !clientC.id || !/^[A-Za-z0-9_-]{1,120}$/.test(clientC.id)) continue;
        const cid = clientC.id;
        if (s.deletedConversations[uid][cid]) continue;
        const serverC = s.conversations[cid];
        if (serverC && serverC.owner !== uid) {
          throw new HttpError(403, 'conversation_forbidden', 'A conversation in this sync belongs to another account.');
        }
        const createdAt = serverC?.createdAt || clientC.createdAt || now;
        const mergedMessages = mergeMessages(
          serverC?.messages || [],
          clientC.msgs || clientC.messages || [],
          cid,
          createdAt,
        );
        const clientVersion = Number(clientC.version) || 0;
        const serverVersion = Number(serverC?.version) || 0;
        const metadataChanged = serverC && (
          (typeof clientC.title === 'string' && clientC.title !== serverC.title) ||
          (clientC.model !== undefined && clientC.model !== serverC.model) ||
          (clientC.pin !== undefined && Boolean(clientC.pin) !== Boolean(serverC.pin)) ||
          (clientC.pid !== undefined && clientC.pid !== serverC.pid)
        );
        if (serverC && clientVersion < serverVersion && metadataChanged) conflicts.push(cid);
        const acceptClientMetadata = !serverC || clientVersion >= serverVersion;
        const next = {
          id: cid,
          owner: uid,
          title: acceptClientMetadata && typeof clientC.title === 'string' ? clientC.title.slice(0, 100) : (serverC?.title || 'New chat'),
          model: acceptClientMetadata && clientC.model !== undefined ? clientC.model : (serverC?.model || null),
          pin: acceptClientMetadata && clientC.pin !== undefined ? Boolean(clientC.pin) : Boolean(serverC?.pin),
          pid: acceptClientMetadata && clientC.pid !== undefined ? clientC.pid : (serverC?.pid || null),
          version: Math.max(serverVersion, clientVersion) + 1,
          createdAt,
          updatedAt: now,
          messages: mergedMessages,
          requests: serverC?.requests || {},
        };
        s.conversations[cid] = next;
      }
      for (const id of deletedConversationIds) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) continue;
        const existing = s.conversations[id];
        if (existing && existing.owner !== uid) {
          throw new HttpError(403, 'conversation_forbidden', 'A deleted conversation in this sync belongs to another account.');
        }
        delete s.conversations[id];
        s.deletedConversations[uid][id] = new Date().toISOString();
      }
    });

    const s = getFreshStore();
    ensureUserContainers(s, uid);
    const deletedMap = s.deletedConversations[uid] || {};
    const conversations = listConversations(uid);
    const deletedIds = Object.keys(deletedMap);

    return {
      conversations,
      deletedIds,
      conflicts,
      serverTime: Date.now(),
      isoTime: now,
    };
  }

  /**
   * Save attachment data centrally in the store
   */
  async function saveAttachment(uid, data = {}) {
    const id = String(data.id || `att_${crypto.randomUUID()}`).trim();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new HttpError(400, 'invalid_attachment_id', 'Attachment ID is invalid.');
    const content = typeof data.data === 'string' ? data.data : (typeof data.dataUrl === 'string' ? data.dataUrl : (typeof data.text === 'string' ? data.text : ''));
    if (Buffer.byteLength(content, 'utf8') > 12 * 1024 * 1024) {
      throw new HttpError(413, 'attachment_too_large', 'Attachments must be no larger than 12 MB.');
    }
    const att = await mutateUser(uid, s => {
      const existing = s.chatAttachments[id];
      if (existing && existing.owner !== uid) {
        throw new HttpError(403, 'attachment_forbidden', 'This attachment ID belongs to another account.');
      }
      const record = {
        id,
        owner: uid,
        name: String(data.name || 'attachment').slice(0, 120),
        mimeType: String(data.mimeType || 'application/octet-stream').slice(0, 80),
        size: Number(data.size) || Buffer.byteLength(content, 'utf8'),
        kind: String(data.kind || 'inline').slice(0, 40),
        dataUrl: typeof data.dataUrl === 'string' && typeof data.data !== 'string' ? data.dataUrl : null,
        data: typeof data.data === 'string' ? data.data : null,
        text: typeof data.text === 'string' ? data.text : null,
        conversationId: data.conversationId || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      s.chatAttachments[id] = record;
      return record;
    });

    return {
      id: att.id,
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      kind: att.kind,
      url: `/api/attachments/${att.id}`,
    };
  }

  /**
   * Retrieve an attachment verifying user ownership
   */
  function getAttachment(uid, id) {
    const s = getFreshStore();
    ensureUserContainers(s, uid);

    const att = s.chatAttachments[id];
    if (!att) {
      throw new HttpError(404, 'attachment_not_found', 'Attachment not found.');
    }
    if (att.owner !== uid) {
      throw new HttpError(403, 'attachment_forbidden', 'You cannot access this attachment.');
    }

    return att;
  }

  /**
   * Projects CRUD
   */
  function listProjects(uid) {
    const s = getFreshStore();
    ensureUserContainers(s, uid);
    return (s.projects[uid] || []).map(p => ({ ...p }));
  }

  async function saveProject(uid, data = {}, { sourceRes = null } = {}) {
    const id = String(data.id || `proj_${Date.now()}`).trim();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new HttpError(400, 'invalid_project_id', 'Project ID is invalid.');
    const pObj = await mutateUser(uid, s => {
      const list = s.projects[uid] || [];
      const idx = list.findIndex(p => p.id === id);
      const prior = idx >= 0 ? list[idx] : null;
      const now = new Date().toISOString();
      const next = {
        id,
        owner: uid,
        name: String(data.name || 'Untitled Project').slice(0, 80),
        desc: String(data.desc || '').slice(0, 500),
        instr: String(data.instr || '').slice(0, 2000),
        files: Array.isArray(data.files) ? data.files : [],
        version: (Number(prior?.version) || 0) + 1,
        updatedAt: now,
        createdAt: prior?.createdAt || now,
      };
      if (idx >= 0) list[idx] = next;
      else list.unshift(next);
      s.projects[uid] = list;
      return next;
    });

    broadcast(uid, 'project_updated', { project: pObj }, sourceRes);
    return pObj;
  }

  async function deleteProject(uid, id, { sourceRes = null } = {}) {
    await mutateUser(uid, s => {
      s.projects[uid] = (s.projects[uid] || []).filter(p => p.id !== id);
      s.deletedProjects[uid][id] = new Date().toISOString();
    });

    broadcast(uid, 'project_deleted', { projectId: id }, sourceRes);
    return { deleted: true, id };
  }

  async function syncProjects(uid, { projects = [], deletedProjectIds = [] } = {}, { sourceRes = null } = {}) {
    const conflicts = [];
    await mutateUser(uid, s => {
      const current = s.projects[uid] || [];
      for (const incoming of projects) {
        if (!incoming || typeof incoming.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(incoming.id)) continue;
        if (s.deletedProjects[uid][incoming.id]) continue;
        const index = current.findIndex(p => p.id === incoming.id);
        const prior = index >= 0 ? current[index] : null;
        const incomingVersion = Number(incoming.version) || 1;
        if (prior && incomingVersion <= (Number(prior.version) || 1)) {
          const incomingContent = JSON.stringify({ name: incoming.name, desc: incoming.desc, instr: incoming.instr, files: incoming.files });
          const priorContent = JSON.stringify({ name: prior.name, desc: prior.desc, instr: prior.instr, files: prior.files });
          if (incomingContent !== priorContent) conflicts.push(incoming.id);
          continue;
        }
        const now = new Date().toISOString();
        const next = {
          id: incoming.id,
          owner: uid,
          name: String(incoming.name || 'Untitled Project').slice(0, 80),
          desc: String(incoming.desc || '').slice(0, 500),
          instr: String(incoming.instr || '').slice(0, 2000),
          files: Array.isArray(incoming.files) ? incoming.files : [],
          version: prior ? (Number(prior.version) || 1) + 1 : 1,
          createdAt: prior?.createdAt || now,
          updatedAt: now,
        };
        if (prior) current[index] = next;
        else current.unshift(next);
      }
      for (const id of deletedProjectIds) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) continue;
        const index = current.findIndex(project => project.id === id);
        if (index >= 0) current.splice(index, 1);
        s.deletedProjects[uid][id] = new Date().toISOString();
      }
      s.projects[uid] = current;
    });
    const list = listProjects(uid);
    if (list.length) broadcast(uid, 'projects_updated', { projects: list }, sourceRes);
    return { projects: list, conflicts };
  }

  /**
   * Preferences CRUD
   */
  function getPreferences(uid) {
    const s = getFreshStore();
    ensureUserContainers(s, uid);
    return { ...s.userPreferences[uid] };
  }

  async function updatePreferences(uid, patch = {}, { sourceRes = null } = {}) {
    const safePatch = {};
    if (patch.defaultModel !== undefined) {
      if (patch.defaultModel !== null && (typeof patch.defaultModel !== 'string' || patch.defaultModel.length > 200)) {
        throw new HttpError(400, 'invalid_preferences', 'Default model preference is invalid.');
      }
      safePatch.defaultModel = patch.defaultModel;
    }
    if (patch.activeConversationId !== undefined) {
      if (patch.activeConversationId !== null && (typeof patch.activeConversationId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(patch.activeConversationId))) {
        throw new HttpError(400, 'invalid_preferences', 'Active conversation preference is invalid.');
      }
      safePatch.activeConversationId = patch.activeConversationId;
    }
    if (patch.activeGenCat !== undefined) {
      if (!['text', 'image', 'video', 'code'].includes(patch.activeGenCat)) {
        throw new HttpError(400, 'invalid_preferences', 'Active generation category is invalid.');
      }
      safePatch.activeGenCat = patch.activeGenCat;
    }
    if (patch.theme !== undefined) {
      if (!['dark', 'light', 'system'].includes(patch.theme)) {
        throw new HttpError(400, 'invalid_preferences', 'Theme preference is invalid.');
      }
      safePatch.theme = patch.theme;
    }
    const updated = await mutateUser(uid, s => {
      const cur = s.userPreferences[uid] || {};
      const next = { ...cur, ...safePatch, updatedAt: new Date().toISOString() };
      s.userPreferences[uid] = next;
      return next;
    });

    broadcast(uid, 'preferences_updated', { preferences: updated }, sourceRes);
    return updated;
  }

  /**
   * Real-time Server-Sent Events (SSE) Cross-Device Hub
   */
  function handleSseConnection(uid, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (!activeSseSubscribers.has(uid)) {
      activeSseSubscribers.set(uid, new Set());
    }
    const clientSet = activeSseSubscribers.get(uid);
    clientSet.add(res);

    // Initial handshake
    const handshake = JSON.stringify({
      serverTime: Date.now(),
      isoTime: new Date().toISOString(),
      activeSessions: clientSet.size,
    });
    res.write(`event: connected\ndata: ${handshake}\n\n`);

    // Keepalive ping interval every 25s
    const pingTimer = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      } catch (_) {
        clearInterval(pingTimer);
      }
    }, 25000);

    res.on('close', () => {
      clearInterval(pingTimer);
      clientSet.delete(res);
      if (clientSet.size === 0) {
        activeSseSubscribers.delete(uid);
      }
    });
  }

  /**
   * Broadcast an event to all active sessions of a user (optionally excluding the sending device)
   */
  function broadcast(uid, eventName, data = {}, excludeRes = null) {
    const clientSet = activeSseSubscribers.get(uid);
    if (!clientSet || clientSet.size === 0) return;

    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const clientRes of clientSet) {
      if (clientRes === excludeRes) continue;
      try {
        if (!clientRes.writableEnded) {
          clientRes.write(payload);
        }
      } catch (err) {
        logger.warn('Could not write SSE to subscriber:', err.message);
        clientSet.delete(clientRes);
      }
    }
  }

  return {
    listConversations,
    getConversation,
    upsertConversation,
    deleteConversation,
    syncConversations,
    saveAttachment,
    getAttachment,
    listProjects,
    saveProject,
    deleteProject,
    syncProjects,
    getPreferences,
    updatePreferences,
    handleSseConnection,
    broadcast,
    normalizeMessage,
    mergeMessages,
  };
}

module.exports = {
  createSyncService,
};
