const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const MAX_FANOUT = 2;

// Room state
// { roomId: { publisher, title, password, peers: Map<socketId, PeerInfo>, chatHistory: [] } }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      publisher: null,
      title: '',
      password: '',
      peers: new Map(),
      chatHistory: [],
    };
  }
  return rooms[roomId];
}

function selectParent(room, selfId) {
  const pubId = room.publisher;
  if (pubId && pubId !== selfId) {
    const pubInfo = room.peers.get(pubId);
    if (pubInfo && pubInfo.childCount < MAX_FANOUT) return pubId;
  }
  // BFS for shallowest node with capacity
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
      childCount: info.childCount,
      isPublisher: peerId === room.publisher,
      isReady: info.isReady,
      nickname: info.nickname || peerId.substring(0, 8),
    });
  }
  return nodes;
}

function buildRoomList() {
  const list = [];
  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room.publisher) continue;
    const pubInfo = room.peers.get(room.publisher);
    list.push({
      roomId,
      title: room.title || roomId,
      hasPassword: !!room.password,
      viewerCount: room.peers.size - 1,
      publisherName: pubInfo ? pubInfo.nickname : 'unknown',
      treeDepth: getTreeDepth(room),
    });
  }
  return list;
}

function calcBandwidthSaving(viewerCount) {
  if (viewerCount <= 0) return { direct: 0, pcdn: 0, savedPercent: 0 };
  const direct = viewerCount;
  const pcdn = Math.min(viewerCount, MAX_FANOUT);
  const savedPercent = viewerCount > 0 ? ((direct - pcdn) / direct * 100) : 0;
  return { direct, pcdn, savedPercent: Math.round(savedPercent * 10) / 10 };
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  let currentRoom = null;
  let currentRole = null;

  // Send room list on connect
  socket.emit('roomList', buildRoomList());

  socket.on('getRoomList', (callback) => {
    callback(buildRoomList());
  });

  socket.on('createRoom', ({ roomId, title, password, nickname }, callback) => {
    const room = getRoom(roomId);
    if (room.publisher) return callback({ error: '房间已有主播' });
    room.publisher = socket.id;
    room.title = title || roomId;
    room.password = password || '';
    room.peers.set(socket.id, { parentId: null, childCount: 0, isReady: true, nickname: nickname || '主播' });
    socket.join(roomId);
    currentRoom = roomId;
    currentRole = 'publisher';
    console.log(`[createRoom] ${socket.id} created room ${roomId}`);
    callback({ success: true, peerId: socket.id });
    io.to(roomId).emit('topologyUpdate', buildTopology(room));
    io.emit('roomList', buildRoomList());
  });

  socket.on('joinRoom', ({ roomId, password, nickname }, callback) => {
    const room = getRoom(roomId);
    if (!room.publisher) return callback({ error: '房间不存在或无主播' });
    if (room.password && room.password !== password) return callback({ error: '房间密码错误' });

    room.peers.set(socket.id, { parentId: null, childCount: 0, isReady: false, nickname: nickname || `观众${socket.id.substring(0,4)}` });
    socket.join(roomId);
    currentRoom = roomId;
    currentRole = 'viewer';

    const parentId = selectParent(room, socket.id);
    if (!parentId) return callback({ error: '无可用父节点，请稍后重试' });

    const myInfo = room.peers.get(socket.id);
    myInfo.parentId = parentId;
    const parentInfo = room.peers.get(parentId);
    parentInfo.childCount++;

    console.log(`[joinRoom] ${socket.id} joined room ${roomId}, parent=${parentId}`);
    callback({ success: true, peerId: socket.id, parentId, chatHistory: room.chatHistory.slice(-50) });
    io.to(roomId).emit('topologyUpdate', buildTopology(room));
    io.to(roomId).emit('roomStats', {
      viewerCount: room.peers.size - 1,
      treeDepth: getTreeDepth(room),
      bandwidth: calcBandwidthSaving(room.peers.size - 1),
    });
    io.emit('roomList', buildRoomList());
  });

  socket.on('peerReady', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (info) {
      info.isReady = true;
      console.log(`[peerReady] ${socket.id} is now ready to relay`);
      io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
    }
  });

  // Chat message via signaling server (fallback / initial broadcast)
  socket.on('chatMessage', ({ message, nickname }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const msg = {
      id: Date.now() + '-' + socket.id.substring(0, 4),
      from: socket.id,
      nickname: nickname || socket.id.substring(0, 8),
      message,
      timestamp: Date.now(),
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 50) room.chatHistory.shift();
    io.to(currentRoom).emit('chatMessage', msg);
  });

  // Emoji reaction
  socket.on('reaction', ({ emoji }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('reaction', { from: socket.id, emoji });
  });

  // WebRTC signaling relay
  socket.on('signal', ({ targetId, data }) => {
    io.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  // Report connection stats from client
  socket.on('reportStats', (stats) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const info = room.peers.get(socket.id);
    if (info) {
      info.stats = stats; // { rtt, connectionType, bitrate, resolution }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (currentRole === 'publisher') {
      io.to(currentRoom).emit('roomClosed');
      delete rooms[currentRoom];
      io.emit('roomList', buildRoomList());
      return;
    }

    const myInfo = room.peers.get(socket.id);
    if (!myInfo) return;

    if (myInfo.parentId) {
      const parentInfo = room.peers.get(myInfo.parentId);
      if (parentInfo) parentInfo.childCount--;
    }

    const orphans = [];
    for (const [peerId, peerInfo] of room.peers) {
      if (peerInfo.parentId === socket.id) orphans.push(peerId);
    }

    room.peers.delete(socket.id);

    for (const orphanId of orphans) {
      const orphanInfo = room.peers.get(orphanId);
      if (!orphanInfo) continue;
      orphanInfo.parentId = null;
      orphanInfo.isReady = false;
      orphanInfo.childCount = 0; // reset since children will also be orphaned or reassigned

      const newParent = selectParent(room, orphanId);
      if (newParent) {
        orphanInfo.parentId = newParent;
        const newParentInfo = room.peers.get(newParent);
        if (newParentInfo) newParentInfo.childCount++;
        io.to(orphanId).emit('reassign', { newParentId: newParent });
        console.log(`[reassign] ${orphanId} -> ${newParent}`);
      } else {
        io.to(orphanId).emit('reassign', { newParentId: null });
      }
    }

    io.to(currentRoom).emit('topologyUpdate', buildTopology(room));
    io.to(currentRoom).emit('roomStats', {
      viewerCount: room.peers.size - 1,
      treeDepth: getTreeDepth(room),
      bandwidth: calcBandwidthSaving(room.peers.size - 1),
    });
    io.emit('roomList', buildRoomList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
