const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

// ============================================================
// SSL
// ============================================================
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY = process.env.SSL_KEY || '';

let server;
if (SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
  server = https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, app);
  console.log('[SSL] HTTPS enabled');
} else {
  server = http.createServer(app);
  console.log('[SSL] No cert, falling back to HTTP');
}

const io = new Server(server, { cors: { origin: '*' }, serveClient: false });
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// TURN Config (env-based, server pushes to clients)
// ============================================================
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').filter(Boolean);
const TURN_USER = process.env.TURN_USER || '';
const TURN_PASS = process.env.TURN_PASS || '';
const TURN_CRED_TTL = parseInt(process.env.TURN_CRED_TTL || '86400'); // 24h default

function generateTurnCredentials(peerId) {
  if (TURN_SECRET) {
    // Dynamic HMAC credentials (coturn long-term with --use-auth-secret)
    const expiry = Math.floor(Date.now() / 1000) + TURN_CRED_TTL;
    const username = `${expiry}:${peerId}`;
    const hmac = crypto.createHmac('sha1', TURN_SECRET);
    hmac.update(username);
    return { username, credential: hmac.digest('base64'), ttl: TURN_CRED_TTL };
  }
  if (TURN_USER && TURN_PASS) {
    return { username: TURN_USER, credential: TURN_PASS, ttl: 0 };
  }
  return null;
}

function buildIceConfig(peerId) {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_URLS.length > 0) {
    const creds = generateTurnCredentials(peerId);
    if (creds) {
      iceServers.push({ urls: TURN_URLS, username: creds.username, credential: creds.credential });
    }
  }
  return { iceServers, credentialTtl: TURN_CRED_TTL };
}

// ============================================================
// Constants
// ============================================================
const MAX_FANOUT = 2;
const PUBLISHER_GRACE_MS = 5 * 60 * 1000; // 5 min grace period

// ============================================================
// Room State
// ============================================================
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      publisher: null,
      publisherOffline: false,   // true when publisher disconnected but grace period active
      publisherToken: null,      // token for publisher reconnect
      publisherGraceTimer: null, // timer handle
      title: '',
      password: '',
      peers: new Map(),          // socketId -> PeerInfo
      chatHistory: [],
    };
  }
  return rooms[roomId];
}

// PeerInfo: { parentId, backupParentId, childCount, isReady, nickname, stats, joinedAt }

function selectParent(room, selfId) {
  const pubId = room.publisher;
  if (pubId && pubId !== selfId && !room.publisherOffline) {
    const pubInfo = room.peers.get(pubId);
    if (pubInfo && pubInfo.childCount < MAX_FANOUT) return pubId;
  }
  const queue = [pubId];
  const visited = new Set();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const info = room.peers.get(nodeId);
    if (!info) continue;
    if (nodeId !== selfId && info.isReady && info.childCount < MAX_FANOUT) return nodeId;
    for (const [peerId, peerInfo] of room.peers) {
      if (peerInfo.parentId === nodeId && !visited.has(peerId)) queue.push(peerId);
    }
  }
  return null;
}

// Select a backup parent different from primary, preferring diverse subtree
function selectBackupParent(room, selfId, primaryId) {
  const queue = [room.publisher];
  const visited = new Set();
  // Find which subtree primary is in (child index of root)
  let primarySubtree = null;
  for (const [pid, info] of room.peers) {
    if (info.parentId === room.publisher && pid !== selfId) {
      // Check if primaryId is in this subtree
      if (pid === primaryId || isDescendant(room, pid, primaryId)) {
        primarySubtree = pid;
        break;
      }
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const info = room.peers.get(nodeId);
    if (!info) continue;
    // Skip self, primary, and offline publisher
    if (nodeId === selfId || nodeId === primaryId) { addChildren(room, nodeId, queue, visited); continue; }
    if (nodeId === room.publisher && room.publisherOffline) { addChildren(room, nodeId, queue, visited); continue; }
    if (info.isReady && info.childCount < MAX_FANOUT) {
      // Prefer node NOT in same subtree as primary
      if (primarySubtree && !isDescendant(room, primarySubtree, nodeId) && nodeId !== primarySubtree) {
        return nodeId;
      }
    }
    addChildren(room, nodeId, queue, visited);
  }
  // Fallback: any available node
  for (const [pid, info] of room.peers) {
    if (pid !== selfId && pid !== primaryId && info.isReady && info.childCount < MAX_FANOUT) {
      if (pid === room.publisher && room.publisherOffline) continue;
      return pid;
    }
  }
  return null;
}

function addChildren(room, nodeId, queue, visited) {
  for (const [pid, info] of room.peers) {
    if (info.parentId === nodeId && !visited.has(pid)) queue.push(pid);
  }
}

function isDescendant(room, ancestorId, targetId) {
  const visited = new Set();
  const queue = [ancestorId];
  while (queue.length > 0) {
    const nid = queue.shift();
    if (visited.has(nid)) continue;
    visited.add(nid);
    if (nid === targetId) return true;
    for (const [pid, info] of room.peers) {
      if (info.parentId === nid && !visited.has(pid)) queue.push(pid);
    }
  }
  return false;
}

function getTreeDepth(room) {
  if (!room.publisher) return 0;
  let maxDepth = 0;
  function dfs(nodeId, depth) {
    if (depth > maxDepth) maxDepth = depth;
    for (const [peerId, info] of room.peers) {
      if (info.parentId === nodeId) dfs(peerId, depth + 1);
    }
  }
  dfs(room.publisher, 0);
  return maxDepth;
}

function buildTopology(room) {
  const nodes = [];
  for (const [peerId, info] of room.peers) {
    nodes.push({
      id: peerId,
      parentId: info.parentId,
      backupParentId: info.backupParentId || null,
      childCount: info.childCount,
      isPublisher: peerId === room.publisher,
      isReady: info.isReady,
      nickname: info.nickname || peerId.substring(0, 8),
      stats: info.stats || null,
      isRelay: info.isReady && peerId !== room.publisher,
    });
  }
  return { nodes, publisherOffline: room.publisherOffline };
}

function buildRoomList() {
  const list = [];
  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room.publisher && !room.publisherOffline) continue;
    const pubInfo = room.publisher ? room.peers.get(room.publisher) : null;
    list.push({
      roomId,
      title: room.title || roomId,
      hasPassword: !!room.password,
      viewerCount: Math.max(0, room.peers.size - (room.publisher ? 1 : 0)),
      publisherName: pubInfo ? pubInfo.nickname : '(离线)',
      publisherOffline: room.publisherOffline,
      treeDepth: getTreeDepth(room),
    });
  }
  return list;
}

function calcBandwidthSaving(viewerCount) {
  if (viewerCount <= 0) return { direct: 0, pcdn: 0, savedPercent: 0 };
  const direct = viewerCount;
  const pcdn = Math.min(viewerCount, MAX_FANOUT);
  const savedPercent = ((direct - pcdn) / direct * 100);
  return { direct, pcdn, savedPercent: Math.round(savedPercent * 10) / 10 };
}

function emitRoomStats(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const viewerCount = Math.max(0, room.peers.size - (room.publisher ? 1 : 0));
  io.to(roomId).emit('roomStats', {
    viewerCount,
    treeDepth: getTreeDepth(room),
    bandwidth: calcBandwidthSaving(viewerCount),
    publisherOffline: room.publisherOffline,
  });
}

// ============================================================
// Socket Handlers
// ============================================================
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  let currentRoom = null;
  let currentRole = null;

  // Push room list + TURN config on connect
  socket.emit('roomList', buildRoomList());

  socket.on('requestTurnConfig', (callback) => {
    const config = buildIceConfig(socket.id);
    if (typeof callback === 'function') callback(config);
    else socket.emit('turnConfig', config);
  });

  socket.on('getRoomList', (callback) => {
    callback(buildRoomList());
  });

  // ---- Create Room (Publisher) ----
  socket.on('createRoom', ({ roomId, title, password, nickname }, callback) => {
    const room = getRoom(roomId);
    if (room.publisher && !room.publisherOffline) {
      return callback({ error: '房间已有主播' });
    }

    // If publisher is reconnecting to an offline room
    if (room.publisherOffline) {
      return handlePublisherReconnect(socket, room, roomId, nickname, callback);
    }

    const token = crypto.randomBytes(16).toString('hex');
    room.publisher = socket.id;
    room.publisherToken = token;
    room.publisherOffline = false;
    room.title = title || roomId;
    room.password = password || '';
    room.peers.set(socket.id, {
      parentId: null, childCount: 0, isReady: true,
      nickname: nickname || '主播', stats: null, joinedAt: Date.now(),
      backupParentId: null,
    });
    socket.join(roomId);
    currentRoom = roomId;
    currentRole = 'publisher';
    console.log(`[createRoom] ${socket.id} room=${roomId}`);
    callback({ success: true, peerId: socket.id, publisherToken: token, iceConfig: buildIceConfig(socket.id) });
    io.to(roomId).emit('topologyUpdate', buildTopology(room));
    io.emit('roomList', buildRoomList());
  });

  function handlePublisherReconnect(sock, room, roomId, nickname, callback) {
    // Clear grace timer
    if (room.publisherGraceTimer) {
      clearTimeout(room.publisherGraceTimer);
      room.publisherGraceTimer = null;
    }

    const oldPubId = room.publisher;
    room.publisher = sock.id;
    room.publisherOffline = false;

    // Transfer peer entry
    if (oldPubId && room.peers.has(oldPubId)) {
      room.peers.delete(oldPubId);
    }
    room.peers.set(sock.id, {
      parentId: null, childCount: 0, isReady: true,
      nickname: nickname || '主播', stats: null, joinedAt: Date.now(),
      backupParentId: null,
    });

    sock.join(roomId);
    currentRoom = roomId;
    currentRole = 'publisher';

    // Reassign direct children of old publisher to new publisher
    for (const [peerId, info] of room.peers) {
      if (info.parentId === oldPubId) {
        info.parentId = sock.id;
        const pubInfo = room.peers.get(sock.id);
        if (pubInfo) pubInfo.childCount++;
        io.to(peerId).emit('reassign', { newParentId: sock.id, reason: 'publisher-reconnect' });
      }
      if (info.backupParentId === oldPubId) {
        info.backupParentId = sock.id;
        io.to(peerId).emit('backupReassign', { newBackupId: sock.id });
      }
    }

    const token = crypto.randomBytes(16).toString('hex');
    room.publisherToken = token;

    console.log(`[publisher-reconnect] ${sock.id} room=${roomId}`);
    callback({ success: true, peerId: sock.id, publisherToken: token, reconnected: true, iceConfig: buildIceConfig(sock.id) });
    io.to(roomId).emit('publisherReconnected', { newPublisherId: sock.id });
    io.to(roomId).emit('topologyUpdate', buildTopology(room));
    emitRoomStats(roomId);
    io.emit('roomList', buildRoomList());
  }

  // ---- Join Room (Viewer) ----
  socket.on('joinRoom', ({ roomId, password, nickname }, callback) => {
    const room = getRoom(roomId);
    if (!room.publisher && !room.publisherOffline) {
      return callback({ error: '房间不存在或无主播' });
    }
    if (room.password && room.password !== password) {
      return callback({ error: '房间密码错误' });
    }

    room.peers.set(socket.id, {
      parentId: null, backupParentId: null, childCount: 0, isReady: false,
      nickname: nickname || `观众${socket.id.substring(0,4)}`,
      stats: null, joinedAt: Date.now(),
    });
    socket.join(roomId);
    currentRoom = roomId;
    currentRole = 'viewer';

    const primaryId = selectParent(room, socket.id);
    if (!primaryId) return callback({ error: '无可用父节点，请稍后重试' });

    const myInfo = room.peers.get(socket.id);
    myInfo.parentId = primaryId;
    const parentInfo = room.peers.get(primaryId);
    if (parentInfo) parentInfo.childCount++;

    // Try to find a backup parent
    const backupId = selectBackupParent(room, socket.id, primaryId);
    myInfo.backupParentId = backupId;

    console.log(`[joinRoom] ${socket.id} room=${roomId} primary=${primaryId} backup=${backupId}`);
    callback({
      success: true, peerId: socket.id, parentId: primaryId, backupParentId: backupId,
      chatHistory: room.chatHistory.slice(-50),
      iceConfig: buildIceConfig(socket.id),
      publisherOffline: room.publisherOffline,
    });
    io.to(roomId).emit('topologyUpdate', buildTopology(room));
    emitRoomStats(roomId);
    io.emit('roomList', buildRoomList());
  });

  socket.on('peerReady', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (info) {
      info.isReady = true;
      console.log(`[peerReady] ${socket.id}`);
      io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
    }
  });

  // ---- Chat ----
  socket.on('chatMessage', ({ message, nickname }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const msg = {
      id: Date.now() + '-' + socket.id.substring(0, 4),
      from: socket.id,
      nickname: nickname || socket.id.substring(0, 8),
      message, timestamp: Date.now(),
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 50) room.chatHistory.shift();
    io.to(currentRoom).emit('chatMessage', msg);
  });

  socket.on('reaction', ({ emoji }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('reaction', { from: socket.id, emoji });
  });

  // ---- Signaling ----
  socket.on('signal', ({ targetId, data }) => {
    io.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  // ---- Stats reporting from clients ----
  socket.on('reportStats', (stats) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (info) {
      info.stats = stats;
      // Check quality thresholds and notify if degraded
      if (stats.rtt > 500 || stats.packetLoss > 5) {
        socket.emit('qualityWarning', {
          rtt: stats.rtt, packetLoss: stats.packetLoss,
          suggestion: stats.rtt > 500 ? '延迟过高，建议切换上游' : '丢包率过高',
        });
      }
    }
  });

  // ---- Request backup parent ----
  socket.on('requestBackup', (callback) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (!info) return;
    const backupId = selectBackupParent(room, socket.id, info.parentId);
    info.backupParentId = backupId;
    if (typeof callback === 'function') callback({ backupParentId: backupId });
  });

  // ---- Promote backup to primary ----
  socket.on('promoteBackup', ({ oldPrimaryId, newPrimaryId }, callback) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (!info) return;

    // Decrement old parent's child count
    if (oldPrimaryId) {
      const oldParent = room.peers.get(oldPrimaryId);
      if (oldParent) oldParent.childCount = Math.max(0, oldParent.childCount - 1);
    }

    info.parentId = newPrimaryId;
    info.backupParentId = null;

    // Request a new backup
    const newBackup = selectBackupParent(room, socket.id, newPrimaryId);
    info.backupParentId = newBackup;

    console.log(`[promoteBackup] ${socket.id} new primary=${newPrimaryId} new backup=${newBackup}`);
    if (typeof callback === 'function') callback({ newBackupId: newBackup });
    io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
  });

  // ---- Client-initiated reassign (stream stalled) ----
  socket.on('requestReassign', ({ reason }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (!info) return;

    console.log(`[requestReassign] ${socket.id} reason=${reason} oldParent=${info.parentId}`);

    // Decrement old parent's child count
    if (info.parentId) {
      const oldParent = room.peers.get(info.parentId);
      if (oldParent) oldParent.childCount = Math.max(0, oldParent.childCount - 1);
    }

    info.parentId = null;
    info.backupParentId = null;
    info.isReady = false;

    // Find a new parent (excluding the old dead one if possible)
    const newParent = selectParent(room, socket.id);
    if (newParent) {
      info.parentId = newParent;
      const np = room.peers.get(newParent);
      if (np) np.childCount++;
      const newBackup = selectBackupParent(room, socket.id, newParent);
      info.backupParentId = newBackup;
      socket.emit('reassign', { newParentId: newParent, backupParentId: newBackup, reason: reason || 'stream-stalled' });
      console.log(`[requestReassign] ${socket.id} -> new parent=${newParent} backup=${newBackup}`);
    } else {
      socket.emit('reassign', { newParentId: null, reason: 'no-parent' });
    }

    io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
    emitRoomStats(currentRoom);
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    // === Publisher disconnect: enter grace period ===
    if (currentRole === 'publisher') {
      room.publisherOffline = true;
      console.log(`[publisher-offline] room=${currentRoom}, grace=${PUBLISHER_GRACE_MS}ms`);
      io.to(currentRoom).emit('publisherOffline', { graceMs: PUBLISHER_GRACE_MS });

      room.publisherGraceTimer = setTimeout(() => {
        // Grace expired, tear down room
        console.log(`[publisher-grace-expired] room=${currentRoom}`);
        io.to(currentRoom).emit('roomClosed');
        delete rooms[currentRoom];
        io.emit('roomList', buildRoomList());
      }, PUBLISHER_GRACE_MS);

      io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
      emitRoomStats(currentRoom);
      io.emit('roomList', buildRoomList());
      return;
    }

    // === Viewer disconnect ===
    const myInfo = room.peers.get(socket.id);
    if (!myInfo) return;

    if (myInfo.parentId) {
      const parentInfo = room.peers.get(myInfo.parentId);
      if (parentInfo) parentInfo.childCount = Math.max(0, parentInfo.childCount - 1);
    }

    // Collect orphaned children (primary parent was this node)
    const orphans = [];
    for (const [peerId, peerInfo] of room.peers) {
      if (peerInfo.parentId === socket.id) orphans.push(peerId);
    }

    // Collect nodes that had this as backup
    const backupOrphans = [];
    for (const [peerId, peerInfo] of room.peers) {
      if (peerInfo.backupParentId === socket.id) backupOrphans.push(peerId);
    }

    room.peers.delete(socket.id);

    // Reassign primary orphans — tell them to try their backup first
    for (const orphanId of orphans) {
      const orphanInfo = room.peers.get(orphanId);
      if (!orphanInfo) continue;

      if (orphanInfo.backupParentId && room.peers.has(orphanInfo.backupParentId)) {
        // Promote backup to primary
        const backupId = orphanInfo.backupParentId;
        orphanInfo.parentId = backupId;
        orphanInfo.backupParentId = null;
        const backupInfo = room.peers.get(backupId);
        if (backupInfo) backupInfo.childCount++;
        io.to(orphanId).emit('promoteBackupToPrimary', { newPrimaryId: backupId });
        console.log(`[promote-backup] ${orphanId} backup ${backupId} -> primary`);

        // Find new backup
        const newBackup = selectBackupParent(room, orphanId, backupId);
        orphanInfo.backupParentId = newBackup;
        if (newBackup) io.to(orphanId).emit('backupReassign', { newBackupId: newBackup });
      } else {
        // No backup, do traditional reassign
        orphanInfo.parentId = null;
        orphanInfo.isReady = false;
        const newParent = selectParent(room, orphanId);
        if (newParent) {
          orphanInfo.parentId = newParent;
          const np = room.peers.get(newParent);
          if (np) np.childCount++;
          io.to(orphanId).emit('reassign', { newParentId: newParent, reason: 'parent-left' });
          console.log(`[reassign] ${orphanId} -> ${newParent}`);
        } else {
          io.to(orphanId).emit('reassign', { newParentId: null, reason: 'no-parent' });
        }
      }
    }

    // Reassign backup orphans
    for (const boid of backupOrphans) {
      const boInfo = room.peers.get(boid);
      if (!boInfo) continue;
      const newBackup = selectBackupParent(room, boid, boInfo.parentId);
      boInfo.backupParentId = newBackup;
      io.to(boid).emit('backupReassign', { newBackupId: newBackup });
    }

    io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
    emitRoomStats(currentRoom);
    io.emit('roomList', buildRoomList());
  });
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
const proto = SSL_CERT && SSL_KEY ? 'https' : 'http';
server.listen(PORT, () => {
  console.log(`Signaling server running on ${proto}://0.0.0.0:${PORT}`);
  if (TURN_URLS.length > 0) console.log(`[TURN] Configured: ${TURN_URLS.join(', ')}`);
  else console.log('[TURN] No TURN servers configured (set TURN_URLS env var)');
});
