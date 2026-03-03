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
// TURN Config
// ============================================================
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').filter(Boolean);
const TURN_USER = process.env.TURN_USER || '';
const TURN_PASS = process.env.TURN_PASS || '';
const TURN_CRED_TTL = parseInt(process.env.TURN_CRED_TTL || '86400');

function generateTurnCredentials(peerId) {
  if (TURN_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + TURN_CRED_TTL;
    const username = `${expiry}:${peerId}`;
    const hmac = crypto.createHmac('sha1', TURN_SECRET);
    hmac.update(username);
    return { username, credential: hmac.digest('base64'), ttl: TURN_CRED_TTL };
  }
  if (TURN_USER && TURN_PASS) return { username: TURN_USER, credential: TURN_PASS, ttl: 0 };
  return null;
}

function buildIceConfig(peerId) {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_URLS.length > 0) {
    const creds = generateTurnCredentials(peerId);
    if (creds) iceServers.push({ urls: TURN_URLS, username: creds.username, credential: creds.credential });
  }
  return { iceServers, credentialTtl: TURN_CRED_TTL };
}

// ============================================================
// Phase 4: Minimal Centralized State
// ============================================================
// The server only stores:
//   - Room metadata (title, password, publisher info)
//   - Active node list (peerId, nickname, lastSeen) — NO topology
// Topology is managed entirely by peers via DataChannel Gossip.
// ============================================================

const PUBLISHER_GRACE_MS = 5 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 30000; // remove node if no heartbeat for 30s
const MAX_BOOTSTRAP_NODES = 6;

const rooms = {};
const MAX_FANOUT = 2; // Must match client-side MAX_FANOUT

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      publisher: null,          // { peerId, socketId, nickname, createdAt }
      publisherOffline: false,
      publisherGraceTimer: null,
      title: '',
      password: '',
      activeNodes: new Map(),   // socketId -> { peerId, nickname, lastSeen, socketId, childCount, fanoutAvailable }
      chatHistory: [],
    };
  }
  return rooms[roomId];
}

// Return up to N bootstrap nodes (prefer publisher + mix of recently active)
// Phase 4 enhancement: prioritize nodes with available fanout capacity
function getBootstrapNodes(room, excludeSocketId) {
  const nodes = [];
  
  // Collect all candidate nodes with their fanout info
  const candidates = [];
  
  // Add publisher if online
  if (room.publisher && !room.publisherOffline && room.publisher.socketId !== excludeSocketId) {
    const pubInfo = room.activeNodes.get(room.publisher.socketId);
    const fanoutAvailable = pubInfo ? (pubInfo.fanoutAvailable !== undefined ? pubInfo.fanoutAvailable : MAX_FANOUT) : MAX_FANOUT;
    candidates.push({ 
      peerId: room.publisher.peerId, 
      socketId: room.publisher.socketId, 
      nickname: room.publisher.nickname, 
      isPublisher: true,
      fanoutAvailable: fanoutAvailable,
      lastSeen: pubInfo ? pubInfo.lastSeen : Date.now()
    });
  }
  
  // Add other active nodes
  for (const [sid, info] of room.activeNodes) {
    if (sid === excludeSocketId) continue;
    if (room.publisher && sid === room.publisher.socketId) continue; // already added
    const fanoutAvailable = info.fanoutAvailable !== undefined ? info.fanoutAvailable : MAX_FANOUT;
    candidates.push({
      peerId: info.peerId,
      socketId: info.socketId,
      nickname: info.nickname,
      isPublisher: false,
      fanoutAvailable: fanoutAvailable,
      lastSeen: info.lastSeen
    });
  }
  
  // Sort candidates: prioritize nodes with available fanout, then by recency
  candidates.sort((a, b) => {
    // First: nodes with fanout > 0 come before nodes with fanout = 0
    if (a.fanoutAvailable > 0 && b.fanoutAvailable <= 0) return -1;
    if (b.fanoutAvailable > 0 && a.fanoutAvailable <= 0) return 1;
    // Second: among nodes with fanout, prefer higher fanout
    if (a.fanoutAvailable !== b.fanoutAvailable) return b.fanoutAvailable - a.fanoutAvailable;
    // Third: prefer more recent nodes
    return b.lastSeen - a.lastSeen;
  });
  
  // Take top candidates, but shuffle a bit to distribute load
  const topCandidates = candidates.slice(0, MAX_BOOTSTRAP_NODES);
  if (topCandidates.length > 2) {
    // Shuffle among nodes with similar fanout to distribute load
    for (let i = Math.min(topCandidates.length - 1, 4); i > 0; i--) {
      // Only shuffle if fanout is similar (within 1)
      const j = Math.floor(Math.random() * (i + 1));
      if (Math.abs(topCandidates[i].fanoutAvailable - topCandidates[j].fanoutAvailable) <= 1) {
        [topCandidates[i], topCandidates[j]] = [topCandidates[j], topCandidates[i]];
      }
    }
  }
  
  // Build result
  for (const c of topCandidates) {
    nodes.push({ 
      peerId: c.peerId, 
      socketId: c.socketId, 
      nickname: c.nickname, 
      isPublisher: c.isPublisher,
      fanoutAvailable: c.fanoutAvailable
    });
  }
  
  return nodes;
}

function buildRoomList() {
  const list = [];
  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room.publisher && !room.publisherOffline) continue;
    list.push({
      roomId,
      title: room.title || roomId,
      hasPassword: !!room.password,
      viewerCount: Math.max(0, room.activeNodes.size - (room.publisher ? 1 : 0)),
      publisherName: room.publisher ? room.publisher.nickname : '(离线)',
      publisherOffline: room.publisherOffline,
    });
  }
  return list;
}

// ============================================================
// Socket Handlers — Minimal Bootstrap + SDP Relay
// ============================================================
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  let currentRoom = null;
  let currentRole = null;

  socket.emit('roomList', buildRoomList());

  socket.on('requestTurnConfig', (callback) => {
    const config = buildIceConfig(socket.id);
    if (typeof callback === 'function') callback(config);
    else socket.emit('turnConfig', config);
  });

  socket.on('getRoomList', (callback) => { callback(buildRoomList()); });

  // ---- Create Room (Publisher) ----
  socket.on('createRoom', ({ roomId, title, password, nickname }, callback) => {
    const room = getRoom(roomId);

    // Handle publisher reconnect during grace period
    if (room.publisherOffline && room.publisher) {
      if (room.publisherGraceTimer) { clearTimeout(room.publisherGraceTimer); room.publisherGraceTimer = null; }
      const oldSocketId = room.publisher.socketId;
      // Remove old entry from activeNodes
      room.activeNodes.delete(oldSocketId);
      room.publisher = { peerId: socket.id, socketId: socket.id, nickname: nickname || '主播', createdAt: Date.now() };
      room.publisherOffline = false;
      room.activeNodes.set(socket.id, { peerId: socket.id, socketId: socket.id, nickname: nickname || '主播', lastSeen: Date.now(), childCount: 0, fanoutAvailable: MAX_FANOUT });
      socket.join(roomId);
      currentRoom = roomId; currentRole = 'publisher';
      console.log(`[publisher-reconnect] ${socket.id} room=${roomId}`);
      // Notify all peers that publisher is back — they handle topology via gossip
      io.to(roomId).emit('publisherReconnected', { publisherId: socket.id, nickname: nickname || '主播' });
      callback({ success: true, peerId: socket.id, reconnected: true, iceConfig: buildIceConfig(socket.id), bootstrapNodes: getBootstrapNodes(room, socket.id) });
      io.emit('roomList', buildRoomList());
      return;
    }

    if (room.publisher && !room.publisherOffline) {
      return callback({ error: '房间已有主播' });
    }

    room.publisher = { peerId: socket.id, socketId: socket.id, nickname: nickname || '主播', createdAt: Date.now() };
    room.publisherOffline = false;
    room.title = title || roomId;
    room.password = password || '';
    room.activeNodes.set(socket.id, { peerId: socket.id, socketId: socket.id, nickname: nickname || '主播', lastSeen: Date.now(), childCount: 0, fanoutAvailable: MAX_FANOUT });
    socket.join(roomId);
    currentRoom = roomId; currentRole = 'publisher';
    console.log(`[createRoom] ${socket.id} room=${roomId}`);
    callback({ success: true, peerId: socket.id, iceConfig: buildIceConfig(socket.id), bootstrapNodes: [] });
    io.emit('roomList', buildRoomList());
  });

  // ---- Join Room (Viewer) ----
  socket.on('joinRoom', ({ roomId, password, nickname }, callback) => {
    const room = getRoom(roomId);
    if (!room.publisher && !room.publisherOffline) return callback({ error: '房间不存在或无主播' });
    if (room.password && room.password !== password) return callback({ error: '房间密码错误' });

    const nick = nickname || `观众${socket.id.substring(0, 4)}`;
    room.activeNodes.set(socket.id, { peerId: socket.id, socketId: socket.id, nickname: nick, lastSeen: Date.now(), childCount: 0, fanoutAvailable: MAX_FANOUT });
    socket.join(roomId);
    currentRoom = roomId; currentRole = 'viewer';

    const bootstrapNodes = getBootstrapNodes(room, socket.id);
    const bootstrapInfo = bootstrapNodes.map(n => `${n.socketId.substring(0,8)}(f=${n.fanoutAvailable}${n.isPublisher ? ',pub' : ''})`).join(', ');
    console.log(`[joinRoom] ${socket.id} room=${roomId} bootstraps=${bootstrapNodes.length} [${bootstrapInfo}]`);
    callback({
      success: true, peerId: socket.id,
      bootstrapNodes,
      chatHistory: room.chatHistory.slice(-50),
      iceConfig: buildIceConfig(socket.id),
      publisherOffline: room.publisherOffline,
    });
    // Notify existing peers about new node (so they can update their active list)
    socket.to(roomId).emit('peerJoined', { peerId: socket.id, nickname: nick });
    io.emit('roomList', buildRoomList());
  });

  // ---- Heartbeat: keep node in active list ----
  socket.on('heartbeat', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.activeNodes.get(socket.id);
    if (info) {
      info.lastSeen = Date.now();
    } else {
      console.log(`[heartbeat-orphan] ${socket.id} not in activeNodes of room=${currentRoom}`);
    }
  });

  // ---- SDP/ICE Relay: only for initial connection establishment ----
  // Once DataChannel is up, peers relay signals through DC.
  socket.on('signal', ({ targetId, data }) => {
    const sigType = data && data.type ? data.type : 'unknown';
    const connRole = data && data.connRole ? data.connRole : '-';
    console.log(`[signal-relay] ${socket.id} -> ${targetId} type=${sigType} role=${connRole}`);
    io.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  // ---- Chat (still via signaling for simplicity — could move to DC later) ----
  socket.on('chatMessage', ({ message, nickname }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const msg = {
      id: Date.now() + '-' + socket.id.substring(0, 4),
      from: socket.id, nickname: nickname || socket.id.substring(0, 8),
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

  // ---- Request Bootstrap Nodes (for network recovery) ----
  socket.on('requestBootstrap', ({ roomId }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback({ error: '房间不存在' });
    if (!room.publisher && !room.publisherOffline) return callback({ error: '房间无主播' });

    const bootstrapNodes = getBootstrapNodes(room, socket.id);
    console.log(`[requestBootstrap] ${socket.id} room=${roomId} bootstraps=${bootstrapNodes.length} pubOffline=${room.publisherOffline}`);
    callback({ success: true, bootstrapNodes, publisherOffline: room.publisherOffline });
  });

  // ---- Report Fanout Status (for load balancing) ----
  socket.on('reportFanout', ({ childCount, fanoutAvailable }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.activeNodes.get(socket.id);
    if (info) {
      info.childCount = childCount;
      info.fanoutAvailable = fanoutAvailable;
      info.lastSeen = Date.now();
      // console.log(`[reportFanout] ${socket.id} children=${childCount} fanout=${fanoutAvailable}`);
    }
  });

  // ---- Disconnect ----
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason} room=${currentRoom} role=${currentRole}`);
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (currentRole === 'publisher') {
      room.publisherOffline = true;
      console.log(`[publisher-offline] room=${currentRoom}, grace=${PUBLISHER_GRACE_MS}ms`);
      io.to(currentRoom).emit('publisherOffline', { graceMs: PUBLISHER_GRACE_MS });
      room.publisherGraceTimer = setTimeout(() => {
        console.log(`[publisher-grace-expired] room=${currentRoom}`);
        io.to(currentRoom).emit('roomClosed');
        delete rooms[currentRoom];
        io.emit('roomList', buildRoomList());
      }, PUBLISHER_GRACE_MS);
    }

    room.activeNodes.delete(socket.id);
    // Notify peers so they can update their local state
    socket.to(currentRoom).emit('peerLeft', { peerId: socket.id });
    io.emit('roomList', buildRoomList());
  });
});

// ============================================================
// Periodic cleanup: remove stale nodes that missed heartbeats
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of Object.entries(rooms)) {
    for (const [sid, info] of room.activeNodes) {
      if (now - info.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        // Don't remove publisher during grace period
        if (room.publisher && room.publisher.socketId === sid && room.publisherOffline) continue;
        console.log(`[heartbeat-timeout] removing ${sid} from room ${roomId}`);
        room.activeNodes.delete(sid);
        io.to(roomId).emit('peerLeft', { peerId: sid });
      }
    }
    // Clean up empty rooms (no publisher, no viewers)
    if (!room.publisher && room.activeNodes.size === 0 && !room.publisherOffline) {
      delete rooms[roomId];
      io.emit('roomList', buildRoomList());
    }
  }
}, 15000);

// Periodic room state dump for debugging
setInterval(() => {
  const roomIds = Object.keys(rooms);
  if (roomIds.length === 0) return;
  roomIds.forEach(rid => {
    const r = rooms[rid];
    if (!r) return;
    const pubStatus = r.publisher ? (r.publisherOffline ? 'offline' : 'online') : 'none';
    const nodeList = [];
    for (const [sid, info] of r.activeNodes) {
      const age = Math.round((Date.now() - info.lastSeen) / 1000);
      const fanout = info.fanoutAvailable !== undefined ? info.fanoutAvailable : '?';
      nodeList.push(`${sid.substring(0,8)}(${info.nickname},f=${fanout},${age}s)`);
    }
    console.log(`[room-state] ${rid}: pub=${pubStatus} nodes=${r.activeNodes.size} [${nodeList.join(', ')}]`);
  });
}, 30000);

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
const proto = SSL_CERT && SSL_KEY ? 'https' : 'http';
server.listen(PORT, () => {
  console.log(`Signaling server running on ${proto}://0.0.0.0:${PORT}`);
  console.log('[Phase 4] Minimal bootstrap server — no topology storage');
  if (TURN_URLS.length > 0) console.log(`[TURN] Configured: ${TURN_URLS.join(', ')}`);
  else console.log('[TURN] No TURN servers configured');
});
