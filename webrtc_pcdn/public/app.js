'use strict';
// ============================================================
// Phase 4: Decentralized WebRTC PCDN
// ============================================================
// Key changes from Phase 3:
// - Signaling server is bootstrap-only (room discovery + initial SDP relay)
// - Topology managed entirely by peers via DataChannel Gossip
// - Link-aware networking: LOCAL/NEARBY/REMOTE/RELAY detection
// - Dynamic multi-backup connections based on network size + link diversity
// - DataChannel signal relay for connections after initial bootstrap
// ============================================================

// ============================================================
// State
// ============================================================
var socket = null;
var myPeerId = null;
var myRole = null;       // 'publisher' | 'viewer'
var myNickname = '';
var localStream = null;
var cameraStream = null;
var isScreenSharing = false;
var currentRoomId = null;
var currentRoomPwd = null;
var serverIceConfig = null;

// Connections: keyed by "peerId:role"
// Roles from our perspective:
//   'primary'       — our main upstream parent
//   'backup-0','backup-1',... — our backup upstream parents
//   'child-primary' — a child pulling from us as their primary
//   'child-backup-N'— a child pulling from us as their backup
var connections = new Map();
var pendingConnects = new Set();
var receivedStream = null;

// Topology state (local view, built from gossip)
var myNodeState = null;   // our own NodeState
var topologyMap = new Map(); // peerId -> NodeState (full network view)
var gossipVersion = 0;
var seenGossipVersions = new Set();

// Link types
var LINK_LOCAL = 'LOCAL';
var LINK_NEARBY = 'NEARBY';
var LINK_REMOTE = 'REMOTE';
var LINK_RELAY = 'RELAY';
var LINK_UNKNOWN = 'UNKNOWN';

// Link info per peer
var linkInfo = new Map(); // peerId -> { linkType, rtt, candidateType }

// Parent tracking
var primaryParentId = null;
var backupParents = [];  // array of peerId strings, ordered

// Constants
var MAX_FANOUT = 2;
var GOSSIP_INTERVAL = 5000;
var GOSSIP_TTL = 5;
var HEARTBEAT_INTERVAL = 10000;
var HEALTH_CHECK_INTERVAL = 3000;
var STALL_THRESHOLD = 3;
var RTT_PROBE_INTERVAL = 8000;
var STALE_CONN_CHECK_INTERVAL = 5000;

// Health state
var streamHealthState = { prevBytesReceived: 0, stallCount: 0, failoverInProgress: false };
function resetHealthState() { streamHealthState = { prevBytesReceived: 0, stallCount: 0, failoverInProgress: false }; }

// Network recovery state
var networkRecoveryState = {
  isRecovering: false,
  lastNetworkChange: 0,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5
};

// Rejection tracking - peers that rejected us recently (cooldown)
var rejectedPeers = {}; // peerId -> { timestamp, count }
var REJECTION_COOLDOWN = 10000; // 10 seconds cooldown after rejection

// Previous state for change detection (reduce log spam)
var prevLogState = {
  connSummary: '',
  backupStatus: '',
  gossipTargets: 0,
  noBackupReason: ''
};

// Candidate counting for batch logging
var candidateCounts = {}; // targetId:role -> count

// Dedup
var seenMsgIds = new Set();
function markSeen(id) { seenMsgIds.add(id); if (seenMsgIds.size > 300) { var it = seenMsgIds.values(); seenMsgIds.delete(it.next().value); } }

// Peer nicknames (from gossip)
var peerNicknames = {};

// ============================================================
// Helpers
// ============================================================
function connKey(peerId, role) { return peerId + ':' + role; }

// Check if a peer is in rejection cooldown
function isPeerInCooldown(peerId) {
  var rejection = rejectedPeers[peerId];
  if (!rejection) return false;
  if (Date.now() - rejection.timestamp > REJECTION_COOLDOWN) {
    delete rejectedPeers[peerId];
    return false;
  }
  return true;
}

// Mark a peer as having rejected us
function markPeerRejected(peerId) {
  var existing = rejectedPeers[peerId] || { count: 0 };
  rejectedPeers[peerId] = {
    timestamp: Date.now(),
    count: existing.count + 1
  };
  // Update topology to reflect this peer has no fanout
  var ns = topologyMap.get(peerId);
  if (ns) {
    ns.fanoutAvailable = 0;
    ns.updatedAt = Date.now();
  }
}
function getConn(peerId, role) { return connections.get(connKey(peerId, role)); }
function setConn(peerId, role, ci) { connections.set(connKey(peerId, role), ci); }
function deleteConn(peerId, role) { connections.delete(connKey(peerId, role)); }
function findConnByPeer(peerId) {
  var found = null;
  connections.forEach(function(ci, key) { if (key.indexOf(peerId + ':') === 0 && !found) found = ci; });
  return found;
}
function peerTag(peerId) {
  if (!peerId) return '无';
  var short = peerId.substring(0, 8);
  var nick = peerNicknames[peerId];
  return nick ? short + '(' + nick + ')' : short;
}
function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// How many backup connections should we have based on network size
function desiredBackupCount() {
  var size = topologyMap.size;
  if (size < 10) return 1;
  if (size <= 50) return 2;
  return 3;
}

// ============================================================
// Logging
// ============================================================
function log(msg, level) {
  level = level || 'info';
  var area = document.getElementById('logArea');
  if (!area) { console.log('[' + level + '] ' + msg); return; }
  var entry = document.createElement('div');
  entry.className = 'log-entry ' + level;
  entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  area.appendChild(entry);
  while (area.childNodes.length > 500) area.removeChild(area.firstChild);
  console.log('[' + level + '] ' + msg);
}

// ============================================================
// UI Helpers
// ============================================================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t, i) {
    t.classList.toggle('active', ['lobby','live','topology','log'][i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'topology') drawTopology();
}
function toggleCollapsible(el) { el.classList.toggle('open'); el.nextElementSibling.classList.toggle('open'); }
function showReconnectOverlay(show) {
  var el = document.getElementById('reconnectOverlay');
  if (el) el.style.display = show ? 'flex' : 'none';
  var el2 = document.getElementById('pubReconnectOverlay');
  if (el2) el2.style.display = show ? 'flex' : 'none';
}

// ============================================================
// ICE Config
// ============================================================
function getIceConfig() {
  var userTurn = document.getElementById('turnUrl').value.trim();
  var policy = document.getElementById('turnFallback').value;
  if (userTurn) {
    var servers = [];
    var userStun = document.getElementById('stunInput').value.trim();
    if (userStun) servers.push({ urls: userStun });
    servers.push({ urls: userTurn, username: document.getElementById('turnUser').value.trim(), credential: document.getElementById('turnPass').value.trim() });
    return { iceServers: servers, iceTransportPolicy: policy === 'always' ? 'relay' : 'all' };
  }
  if (serverIceConfig && serverIceConfig.iceServers) {
    return { iceServers: serverIceConfig.iceServers, iceTransportPolicy: policy === 'always' ? 'relay' : 'all' };
  }
  var stun = document.getElementById('stunInput').value.trim() || 'stun:stun.l.google.com:19302';
  return { iceServers: [{ urls: stun }], iceTransportPolicy: policy === 'always' ? 'relay' : 'all' };
}

// ============================================================
// NodeState — what each peer knows about itself
// ============================================================
function createMyNodeState() {
  return {
    peerId: myPeerId,
    nickname: myNickname,
    role: myRole,
    parentId: primaryParentId,
    backupParentIds: backupParents.slice(),
    children: getMyChildIds(),
    linkTypes: getLinkTypesObj(),
    isReady: myRole === 'publisher' ? true : (receivedStream && receivedStream.getTracks().length > 0),
    joinedAt: Date.now(),
    fanoutMax: MAX_FANOUT,
    fanoutAvailable: MAX_FANOUT - getMyChildCount(),
    updatedAt: Date.now(),
  };
}

function getMyChildIds() {
  var ids = [];
  connections.forEach(function(ci, key) {
    if (ci.role === 'child' && ci.iceState === 'connected') ids.push(ci.peerId);
  });
  return ids;
}

function getMyChildCount() {
  var count = 0;
  connections.forEach(function(ci) { if (ci.role === 'child' && (ci.iceState === 'connected' || ci.iceState === 'checking' || ci.iceState === 'new')) count++; });
  return count;
}

function getLinkTypesObj() {
  var obj = {};
  linkInfo.forEach(function(info, pid) { obj[pid] = info.linkType; });
  return obj;
}

// ============================================================
// Link-Aware Networking
// ============================================================
// Detect link type from ICE candidate pair after connection established
function detectLinkType(pc, peerId) {
  if (!pc || pc.connectionState === 'closed') return;
  pc.getStats().then(function(stats) {
    var activePair = null;
    stats.forEach(function(report) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') activePair = report;
    });
    if (!activePair) return;

    var localCandId = activePair.localCandidateId;
    var remoteCandId = activePair.remoteCandidateId;
    var localCand = null, remoteCand = null;
    stats.forEach(function(report) {
      if (report.id === localCandId) localCand = report;
      if (report.id === remoteCandId) remoteCand = report;
    });

    var lt = LINK_UNKNOWN;
    var lAddr = '', rAddr = '', lPort = '', rPort = '', lProto = '', rProto = '';
    if (localCand) {
      lAddr = localCand.address || localCand.ip || '';
      lPort = localCand.port || '';
      lProto = localCand.protocol || '';
    }
    if (remoteCand) {
      rAddr = remoteCand.address || remoteCand.ip || '';
      rPort = remoteCand.port || '';
      rProto = remoteCand.protocol || '';
    }

    if (localCand && remoteCand) {
      var lType = localCand.candidateType;
      var rType = remoteCand.candidateType;
      if (lType === 'relay' || rType === 'relay') {
        lt = LINK_RELAY;
      } else if (lType === 'host' && rType === 'host') {
        lt = LINK_LOCAL;
      } else if (lType === 'srflx' && rType === 'srflx') {
        lt = (lAddr && rAddr && lAddr === rAddr) ? LINK_NEARBY : LINK_REMOTE;
      } else {
        lt = LINK_REMOTE;
      }
    }

    var rtt = activePair.currentRoundTripTime ? activePair.currentRoundTripTime * 1000 : 0;
    if (lt === LINK_UNKNOWN || lt === LINK_REMOTE) {
      if (rtt > 0 && rtt < 5) lt = LINK_LOCAL;
      else if (rtt > 0 && rtt < 30) lt = LINK_NEARBY;
      else if (rtt > 0) lt = LINK_REMOTE;
    }

    // Derive subnet (first 3 octets for IPv4)
    var lSubnet = extractSubnet(lAddr);
    var rSubnet = extractSubnet(rAddr);

    var existing = linkInfo.get(peerId) || {};
    linkInfo.set(peerId, {
      linkType: lt, rtt: rtt,
      candidateType: (localCand ? localCand.candidateType : '?') + '/' + (remoteCand ? remoteCand.candidateType : '?'),
      localAddr: lAddr, localPort: lPort, localProto: lProto,
      remoteAddr: rAddr, remotePort: rPort, remoteProto: rProto,
      localSubnet: lSubnet, remoteSubnet: rSubnet,
      prev: existing
    });
    if (!existing.linkType || existing.linkType !== lt || !existing.localAddr) {
      // Format address display - handle empty prflx addresses gracefully
      var lAddrDisplay = lAddr ? (lAddr + ':' + lPort) : (lPort ? ':' + lPort : '');
      var rAddrDisplay = rAddr ? (rAddr + ':' + rPort) : (rPort ? ':' + rPort : '');
      var lTypeDisplay = localCand ? localCand.candidateType : '?';
      var rTypeDisplay = remoteCand ? remoteCand.candidateType : '?';
      // For prflx with no address, just show the type
      if (lTypeDisplay === 'prflx' && !lAddr) lAddrDisplay = '(prflx)';
      if (rTypeDisplay === 'prflx' && !rAddr) rAddrDisplay = '(prflx)';
      log('链路检测 ' + peerTag(peerId) + ': ' + lt +
        ' RTT=' + Math.round(rtt) + 'ms' +
        ' local=' + lTypeDisplay + ' ' + lAddrDisplay + '/' + lProto +
        ' remote=' + rTypeDisplay + ' ' + rAddrDisplay + '/' + rProto +
        ' subnet=' + lSubnet + (lSubnet === rSubnet ? '(同网段)' : '→' + rSubnet));
    }
  }).catch(function() {});
}

function extractSubnet(addr) {
  if (!addr) return '?';
  // IPv4: take first 3 octets
  var parts = addr.split('.');
  if (parts.length === 4) return parts[0] + '.' + parts[1] + '.' + parts[2] + '.x';
  // IPv6: take first 4 groups
  var v6 = addr.split(':');
  if (v6.length >= 4) return v6[0] + ':' + v6[1] + ':' + v6[2] + ':' + v6[3] + '::x';
  return addr;
}

// Score a potential parent: lower is better
// isCurrentParent: set true when scoring our existing parent (adjusts fanout calc)
function parentScore(nodeState, peerId, isCurrentParent) {
  var li = linkInfo.get(peerId);
  var linkScore = 400; // default for unknown
  if (li) {
    if (li.linkType === LINK_LOCAL) linkScore = 0;
    else if (li.linkType === LINK_NEARBY) linkScore = 100;
    else if (li.linkType === LINK_REMOTE) linkScore = 200;
    else if (li.linkType === LINK_RELAY) linkScore = 500;
  }
  var rttScore = li && li.rtt > 0 ? li.rtt : 200;
  // Prefer nodes with available fanout
  // If this is our current parent, we'd free a slot by leaving, so adjust +1
  var effectiveFanout = nodeState ? nodeState.fanoutAvailable : 0;
  if (isCurrentParent) effectiveFanout += 1;
  var fanoutPenalty = (effectiveFanout <= 0) ? 10000 : 0;
  // Prefer nodes closer to root (fewer hops) — strongly penalize deep nodes
  var depth = getNodeDepth(peerId);
  var depthPenalty = depth * 100;
  return linkScore + rttScore + fanoutPenalty + depthPenalty;
}

function getNodeDepth(peerId) {
  var depth = 0;
  var visited = new Set();
  var current = peerId;
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    var ns = topologyMap.get(current);
    if (!ns || !ns.parentId) break;
    current = ns.parentId;
    depth++;
  }
  return depth;
}

// Select best parent from topology, excluding self and optionally excluding some peers
function selectBestParent(excludeIds) {
  var candidates = [];
  var skipped = { notReady: 0, noFanout: 0, excluded: 0, cooldown: 0 };
  topologyMap.forEach(function(ns, pid) {
    if (pid === myPeerId) return;
    if (excludeIds && excludeIds.indexOf(pid) >= 0) { skipped.excluded++; return; }
    if (isPeerInCooldown(pid)) { skipped.cooldown++; return; }
    if (!ns.isReady) { skipped.notReady++; return; }
    if (ns.fanoutAvailable <= 0) { skipped.noFanout++; return; }
    candidates.push({ peerId: pid, ns: ns, score: parentScore(ns, pid) });
  });
  candidates.sort(function(a, b) { return a.score - b.score; });
  if (candidates.length > 0) {
    log('选父候选: top3=[' + candidates.slice(0, 3).map(function(c) {
      return peerTag(c.peerId) + '(score=' + Math.round(c.score) + ',fanout=' + c.ns.fanoutAvailable + ',depth=' + getNodeDepth(c.peerId) + ')';
    }).join(', ') + '] 跳过: excluded=' + skipped.excluded + ' notReady=' + skipped.notReady + ' noFanout=' + skipped.noFanout + ' cooldown=' + skipped.cooldown, 'debug');
  } else {
    log('选父无候选: topo=' + topologyMap.size + ' 跳过: excluded=' + skipped.excluded + ' notReady=' + skipped.notReady + ' noFanout=' + skipped.noFanout + ' cooldown=' + skipped.cooldown, 'debug');
  }
  return candidates.length > 0 ? candidates[0].peerId : null;
}

// Select backup parents with diversity (different link types, different subtrees)
function selectBackupParents(primaryId, count) {
  var exclude = [myPeerId, primaryId];
  var selected = [];
  var usedLinkTypes = new Set();
  var usedSubtrees = new Set();

  if (primaryId) {
    var pli = linkInfo.get(primaryId);
    if (pli) usedLinkTypes.add(pli.linkType);
    var pSubtree = getRootSubtree(primaryId);
    if (pSubtree) usedSubtrees.add(pSubtree);
  }

  // Build candidate list (excluding peers in cooldown)
  var candidates = [];
  topologyMap.forEach(function(ns, pid) {
    if (exclude.indexOf(pid) >= 0) return;
    if (isPeerInCooldown(pid)) return;
    if (!ns.isReady) return;
    if (ns.fanoutAvailable <= 0) return;
    var li = linkInfo.get(pid);
    var lt = li ? li.linkType : LINK_UNKNOWN;
    var subtree = getRootSubtree(pid);
    candidates.push({ peerId: pid, ns: ns, linkType: lt, subtree: subtree, score: parentScore(ns, pid) });
  });
  candidates.sort(function(a, b) { return a.score - b.score; });

  // First pass: prefer diverse link types and subtrees
  for (var i = 0; i < candidates.length && selected.length < count; i++) {
    var c = candidates[i];
    if (selected.indexOf(c.peerId) >= 0) continue;
    var diverseLink = !usedLinkTypes.has(c.linkType);
    var diverseSubtree = !usedSubtrees.has(c.subtree);
    if (diverseLink || diverseSubtree) {
      selected.push(c.peerId);
      usedLinkTypes.add(c.linkType);
      if (c.subtree) usedSubtrees.add(c.subtree);
    }
  }
  // Second pass: fill remaining slots with best available
  for (var j = 0; j < candidates.length && selected.length < count; j++) {
    if (selected.indexOf(candidates[j].peerId) < 0 && exclude.indexOf(candidates[j].peerId) < 0) {
      selected.push(candidates[j].peerId);
    }
  }
  return selected;
}

// Get which root-child subtree a node belongs to
function getRootSubtree(peerId) {
  var publisherId = null;
  topologyMap.forEach(function(ns) { if (ns.role === 'publisher') publisherId = ns.peerId; });
  if (!publisherId || peerId === publisherId) return null;
  var current = peerId;
  var visited = new Set();
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    var ns = topologyMap.get(current);
    if (!ns || !ns.parentId) break;
    if (ns.parentId === publisherId) return current; // this is the root-child
    current = ns.parentId;
  }
  return null;
}

// ============================================================
// Gossip Protocol
// ============================================================
function broadcastGossip() {
  if (!myPeerId) return;
  gossipVersion++;
  myNodeState = createMyNodeState();
  topologyMap.set(myPeerId, myNodeState);

  // Report fanout to server for better bootstrap node selection
  reportFanoutToServer();

  var gossipMsg = {
    type: 'topology-gossip',
    version: gossipVersion,
    originId: myPeerId,
    timestamp: Date.now(),
    ttl: GOSSIP_TTL,
    nodes: []
  };
  // Include all known nodes
  topologyMap.forEach(function(ns) { gossipMsg.nodes.push(ns); });

  seenGossipVersions.add(myPeerId + ':' + gossipVersion);
  // Trim seen set
  if (seenGossipVersions.size > 500) {
    var it = seenGossipVersions.values();
    for (var i = 0; i < 100; i++) seenGossipVersions.delete(it.next().value);
  }

  // Send to all direct connections with open DataChannels
  var gossipSentTo = [];
  connections.forEach(function(ci) {
    if (ci.dc && ci.dc.readyState === 'open') {
      try { ci.dc.send(JSON.stringify(gossipMsg)); gossipSentTo.push(peerTag(ci.peerId)); } catch(e) {}
    }
  });
  // Only log when target count changes
  if (gossipSentTo.length > 0 && gossipSentTo.length !== prevLogState.gossipTargets) {
    log('Gossip广播 v' + gossipVersion + ' -> ' + gossipSentTo.length + '节点 topo=' + topologyMap.size, 'debug');
    prevLogState.gossipTargets = gossipSentTo.length;
  }
}

// Report fanout status to server for better bootstrap node selection
function reportFanoutToServer() {
  if (!socket || !socket.connected) return;
  var childCount = getMyChildCount();
  var fanoutAvailable = MAX_FANOUT - childCount;
  socket.emit('reportFanout', { childCount: childCount, fanoutAvailable: fanoutAvailable });
}

function handleGossipMessage(msg, fromId) {
  var gKey = msg.originId + ':' + msg.version;
  if (seenGossipVersions.has(gKey)) return; // already seen
  seenGossipVersions.add(gKey);

  if (msg.ttl <= 0) return;

  // Merge received topology into our local view
  var updated = false;
  var mergedNodes = [];
  if (msg.nodes) {
    msg.nodes.forEach(function(ns) {
      if (ns.peerId === myPeerId) return; // don't overwrite our own state
      var existing = topologyMap.get(ns.peerId);
      if (!existing || ns.updatedAt > existing.updatedAt) {
        topologyMap.set(ns.peerId, ns);
        if (ns.nickname) peerNicknames[ns.peerId] = ns.nickname;
        mergedNodes.push(peerTag(ns.peerId));
        updated = true;
      }
    });
  }
  if (mergedNodes.length > 1) {
    // Only log when multiple nodes updated (skip single-node heartbeat updates)
    log('Gossip合并 from ' + peerTag(fromId) + ': 更新 ' + mergedNodes.length + ' 节点 [' + mergedNodes.join(', ') + '] topo=' + topologyMap.size, 'debug');
  }

  // Forward with decremented TTL
  var fwd = Object.assign({}, msg);
  fwd.ttl = msg.ttl - 1;
  if (fwd.ttl > 0) {
    connections.forEach(function(ci) {
      if (ci.peerId === fromId) return; // don't send back to sender
      if (ci.dc && ci.dc.readyState === 'open') {
        try { ci.dc.send(JSON.stringify(fwd)); } catch(e) {}
      }
    });
  }

  if (updated) {
    updateTopologyUI();
    // Check if we should adjust our backup connections
    maybeAdjustBackups();
  }
}

// Remove stale nodes from topology (not seen in gossip for a while)
function pruneTopology() {
  var now = Date.now();
  // Extend threshold during network recovery to preserve topology knowledge
  var staleThreshold = networkRecoveryState.isRecovering ? 60000 : 30000;
  var toRemove = [];
  topologyMap.forEach(function(ns, pid) {
    if (pid === myPeerId) return;
    if (now - ns.updatedAt > staleThreshold) toRemove.push(pid);
  });
  if (toRemove.length > 0) {
    log('拓扑修剪: 移除 ' + toRemove.length + ' 个过期节点 [' + toRemove.map(peerTag).join(', ') + ']' + (networkRecoveryState.isRecovering ? ' (恢复中,阈值=' + staleThreshold/1000 + 's)' : ''), 'debug');
  }
  toRemove.forEach(function(pid) {
    topologyMap.delete(pid);
    delete peerNicknames[pid];
  });
}

// ============================================================
// DataChannel Signal Relay
// ============================================================
// When two peers can't reach each other via signaling server,
// relay SDP/ICE through existing DataChannel connections.
function relaySdpSignal(targetId, data) {
  var sigType = data.type || '?';
  var sigRole = data.connRole || '-';
  // First try direct socket relay (signaling server)
  if (socket && socket.connected) {
    socket.emit('signal', { targetId: targetId, data: data });
    // Batch candidate logs - only log offer/answer immediately, count candidates
    if (sigType === 'candidate') {
      var candKey = targetId + ':' + sigRole;
      candidateCounts[candKey] = (candidateCounts[candKey] || 0) + 1;
      // Don't log individual candidates
    } else {
      // Flush any pending candidate count for this target
      var candKey = targetId + ':' + sigRole;
      if (candidateCounts[candKey]) {
        log('信令发送(socket): ' + candidateCounts[candKey] + ' candidates -> ' + peerTag(targetId) + ' role=' + sigRole, 'debug');
        delete candidateCounts[candKey];
      }
      log('信令发送(socket): ' + sigType + ' -> ' + peerTag(targetId) + ' role=' + sigRole, 'debug');
    }
    return;
  }

  // Socket is down - check if we have any usable DataChannels for relay
  var usableDcCount = 0;
  connections.forEach(function(ci) {
    if (ci.dc && ci.dc.readyState === 'open') usableDcCount++;
  });

  if (usableDcCount === 0) {
    // No socket AND no usable DataChannels - this is a network switch scenario
    // All connections are dead, need to trigger network recovery
    log('信令发送失败: socket断开且无可用DC (可能网络切换)', 'error');
    
    // Only trigger recovery once, not for every signal attempt
    if (!networkRecoveryState.isRecovering) {
      log('触发网络恢复流程...', 'warn');
      handleNetworkChange();
    }
    return;
  }

  // Fallback: relay through DataChannel
  log('信令发送(DC relay): ' + sigType + ' -> ' + peerTag(targetId) + ' role=' + sigRole + ' (socket断开, dc=' + usableDcCount + ')', 'warn');
  var relayMsg = {
    type: 'relay-signal',
    fromId: myPeerId,
    targetId: targetId,
    hops: [myPeerId],
    data: data
  };
  // Send to all connected peers — they'll forward if needed
  connections.forEach(function(ci) {
    if (ci.dc && ci.dc.readyState === 'open') {
      try { ci.dc.send(JSON.stringify(relayMsg)); } catch(e) {}
    }
  });
}

function handleRelaySignal(msg, fromDcPeerId) {
  if (msg.targetId === myPeerId) {
    // This signal is for us
    handleSignal(msg.fromId, msg.data);
    return;
  }
  // Forward to target if we have a DC connection to them
  if (msg.hops && msg.hops.length >= 5) return; // TTL exceeded
  if (msg.hops && msg.hops.indexOf(myPeerId) >= 0) return; // loop prevention
  msg.hops = (msg.hops || []).concat([myPeerId]);

  // Try direct DC to target
  var targetConn = findConnByPeer(msg.targetId);
  if (targetConn && targetConn.dc && targetConn.dc.readyState === 'open') {
    try { targetConn.dc.send(JSON.stringify(msg)); } catch(e) {}
    return;
  }
  // Flood to all other connections
  connections.forEach(function(ci) {
    if (ci.peerId === fromDcPeerId) return;
    if (ci.peerId === msg.fromId) return;
    if (ci.dc && ci.dc.readyState === 'open') {
      try { ci.dc.send(JSON.stringify(msg)); } catch(e) {}
    }
  });
}

// ============================================================
// RTT Probing via DataChannel
// ============================================================
function sendRttProbe(ci) {
  if (!ci || !ci.dc || ci.dc.readyState !== 'open') return;
  var probeId = Date.now() + '-' + Math.random().toString(36).substring(2, 6);
  ci._rttProbeTime = Date.now();
  ci._rttProbeId = probeId;
  try { ci.dc.send(JSON.stringify({ type: 'rtt-ping', probeId: probeId, ts: Date.now() })); } catch(e) {}
}

function handleRttPing(msg, fromId) {
  // Reply immediately
  var ci = findConnByPeer(fromId);
  if (ci && ci.dc && ci.dc.readyState === 'open') {
    try { ci.dc.send(JSON.stringify({ type: 'rtt-pong', probeId: msg.probeId, ts: msg.ts })); } catch(e) {}
  }
}

function handleRttPong(msg, fromId) {
  var ci = findConnByPeer(fromId);
  if (!ci) return;
  var rtt = Date.now() - msg.ts;
  var li = linkInfo.get(fromId) || { linkType: LINK_UNKNOWN, rtt: 0 };
  li.rtt = rtt;
  // Refine link type based on RTT
  if (li.linkType === LINK_UNKNOWN || li.linkType === LINK_REMOTE) {
    if (rtt < 5) li.linkType = LINK_LOCAL;
    else if (rtt < 30) li.linkType = LINK_NEARBY;
  }
  linkInfo.set(fromId, li);
}

// ============================================================
// Network Change Detection
// ============================================================
function initNetworkChangeDetection() {
  // Detect network type changes (WiFi <-> Cellular)
  if (navigator.connection) {
    navigator.connection.addEventListener('change', function() {
      log('网络类型变化: ' + navigator.connection.effectiveType + ' (' + navigator.connection.type + ')', 'warn');
      handleNetworkChange();
    });
  }

  // Detect online/offline events
  window.addEventListener('online', function() {
    log('网络恢复在线', 'warn');
    handleNetworkChange();
  });

  window.addEventListener('offline', function() {
    log('网络离线', 'error');
    showReconnectOverlay(true);
  });
}

function handleNetworkChange() {
  if (!myRole || !currentRoomId) return;
  if (networkRecoveryState.isRecovering) return;

  networkRecoveryState.lastNetworkChange = Date.now();
  networkRecoveryState.isRecovering = true;

  log('检测到网络变化，检查连接状态...', 'warn');
  showReconnectOverlay(true);

  // Give network a moment to stabilize
  setTimeout(function() {
    checkAndRecoverConnections();
  }, 1000);
}

function checkAndRecoverConnections() {
  if (!myRole || !currentRoomId) {
    networkRecoveryState.isRecovering = false;
    return;
  }

  // Don't interfere if failover is already handling recovery
  if (failoverInProgress) {
    log('故障转移进行中，跳过网络恢复检查', 'debug');
    networkRecoveryState.isRecovering = false;
    return;
  }

  // Check if socket is connected
  var socketOk = socket && socket.connected;

  // Check if primary connection is still alive
  var primaryOk = false;
  if (primaryParentId) {
    var pc = getConn(primaryParentId, 'primary');
    if (pc && (pc.iceState === 'connected' || pc.iceState === 'completed')) {
      primaryOk = true;
    }
  }

  // Check if ANY WebRTC connection is alive (including backups)
  var anyConnAlive = false;
  var allConnsStuck = true; // All connections stuck in 'new' state
  var stuckCount = 0;
  var totalCount = 0;
  connections.forEach(function(ci) {
    totalCount++;
    if (ci.iceState === 'connected' || ci.iceState === 'completed') {
      anyConnAlive = true;
      allConnsStuck = false;
    } else if (ci.iceState !== 'new') {
      allConnsStuck = false;
    } else {
      // Check if stuck in 'new' for too long (>10s)
      var age = ci.createdAt ? (Date.now() - ci.createdAt) : 0;
      if (age > 10000) stuckCount++;
    }
  });

  // For publisher, check if we have any connected children
  if (myRole === 'publisher') {
    var hasConnectedChild = false;
    connections.forEach(function(ci) {
      if (ci.role === 'child' && (ci.iceState === 'connected' || ci.iceState === 'completed')) {
        hasConnectedChild = true;
      }
    });
    if (socketOk) {
      log('主播网络恢复: socket=' + (socketOk ? 'ok' : 'down') + ' children=' + (hasConnectedChild ? 'ok' : 'none'), 'warn');
      showReconnectOverlay(false);
      networkRecoveryState.isRecovering = false;
      // Broadcast gossip to let viewers know we're back
      broadcastGossip();
    } else {
      log('主播等待信令重连...', 'warn');
      // Socket.io will auto-reconnect and trigger autoRejoin
      networkRecoveryState.isRecovering = false;
    }
    return;
  }

  // For viewer - detailed status
  log('观众网络恢复检查: socket=' + (socketOk ? 'ok' : 'down') + ' primary=' + (primaryOk ? 'ok' : 'down') + ' anyConn=' + (anyConnAlive ? 'ok' : 'down') + ' stuck=' + stuckCount + '/' + totalCount, 'warn');

  if (socketOk && primaryOk) {
    // Everything is fine
    log('连接正常，无需恢复');
    showReconnectOverlay(false);
    networkRecoveryState.isRecovering = false;
    return;
  }

  // Detect "all connections stuck in ice=new" scenario (network switch killed everything)
  if (socketOk && totalCount > 0 && allConnsStuck && stuckCount > 0) {
    log('所有连接卡在ice=new状态，可能网络切换导致，重新获取引导节点...', 'warn');
    requestNewBootstrapAndReconnect();
    return;
  }

  if (socketOk && !primaryOk) {
    // Socket is ok but WebRTC died - need to reconnect to peers
    log('WebRTC连接断开，重新获取引导节点...', 'warn');
    requestNewBootstrapAndReconnect();
    return;
  }

  if (!socketOk) {
    // Socket is down - wait for auto-reconnect
    log('等待信令重连...', 'warn');
    networkRecoveryState.isRecovering = false;
    // Socket.io will auto-reconnect and trigger autoRejoin via 'connect' event
  }
}

function requestNewBootstrapAndReconnect() {
  if (!socket || !socket.connected) {
    log('无法获取引导节点: 信令未连接', 'error');
    networkRecoveryState.isRecovering = false;
    return;
  }

  // Close all dead connections first
  closeAllPeerConnections();
  primaryParentId = null;
  backupParents = [];

  // Request fresh bootstrap nodes from server
  socket.emit('requestBootstrap', { roomId: currentRoomId }, async function(res) {
    if (res.error) {
      // Check if room/publisher is gone
      if (res.error.indexOf('不存在') >= 0 || res.error.indexOf('无主播') >= 0) {
        log('主播已离开房间: ' + res.error, 'warn');
        alert(t('liveEnded'));
        cleanup();
        switchTab('lobby');
        return;
      }
      log('获取引导节点失败: ' + res.error, 'error');
      networkRecoveryState.isRecovering = false;
      showReconnectOverlay(false);
      return;
    }

    var bootstrapNodes = res.bootstrapNodes || [];
    var publisherOffline = res.publisherOffline;
    
    // Check if publisher is offline
    if (publisherOffline) {
      log('主播当前离线，等待重连...', 'warn');
    }
    
    log('收到 ' + bootstrapNodes.length + ' 个引导节点 (网络恢复)' + (publisherOffline ? ' [主播离线]' : ''));

    if (bootstrapNodes.length === 0) {
      if (publisherOffline) {
        log('主播离线且无可用节点，等待主播重连...', 'warn');
      } else {
        log('无可用引导节点', 'error');
      }
      networkRecoveryState.isRecovering = false;
      showReconnectOverlay(false);
      return;
    }

    // Rebuild topology from bootstrap
    bootstrapNodes.forEach(function(node) {
      var pid = node.peerId || node.socketId;
      peerNicknames[pid] = node.nickname;
      if (!topologyMap.has(pid)) {
        topologyMap.set(pid, {
          peerId: pid, nickname: node.nickname, role: node.isPublisher ? 'publisher' : 'viewer',
          parentId: null, backupParentIds: [], children: [],
          linkTypes: {}, isReady: true, joinedAt: Date.now(),
          fanoutMax: MAX_FANOUT, fanoutAvailable: MAX_FANOUT, updatedAt: Date.now()
        });
      }
    });

    // Connect to first bootstrap node as primary
    primaryParentId = bootstrapNodes[0].peerId || bootstrapNodes[0].socketId;
    log('网络恢复: 连接到 ' + peerTag(primaryParentId));
    await connectToParent(primaryParentId, 'primary');

    // Setup backups after primary connects
    setTimeout(function() {
      maybeAdjustBackups();
      networkRecoveryState.isRecovering = false;
      showReconnectOverlay(false);
    }, 3000);
  });
}

// ============================================================
// Socket.io — Minimal Bootstrap
// ============================================================
function initSocket() {
  if (socket) return;
  socket = io();
  initNetworkChangeDetection(); // Add network change detection
  socket.on('connect', function() {
    log('已连接信令服务器 id=' + socket.id);
    if (myRole && currentRoomId) {
      log('检测到信令重连，自动重新加入 room=' + currentRoomId, 'warn');
      autoRejoin();
    }
  });
  // SDP/ICE relay from signaling server (for initial connections)
  socket.on('signal', async function(d) {
    try { await handleSignal(d.fromId, d.data); } catch(e) { log('信令错误: ' + e.message, 'error'); }
  });
  socket.on('roomList', function(list) { renderRoomList(list); });
  socket.on('roomClosed', function() {
    log('房间已关闭，主播已离开', 'warn');
    alert(t('liveEndedFull'));
    cleanup();
    switchTab('lobby');
  });
  socket.on('publisherOffline', function(d) {
    log('主播暂时离线，等待重连 (' + Math.round(d.graceMs / 1000) + '秒)', 'warn');
    showReconnectOverlay(true);
  });
  socket.on('publisherReconnected', function(d) {
    log('主播已重连 ' + peerTag(d.publisherId));
    peerNicknames[d.publisherId] = d.nickname;
    showReconnectOverlay(false);
    // Try to reconnect to the new publisher
    if (myRole === 'viewer' && !primaryParentId) {
      log('尝试连接到重连的主播...', 'warn');
      primaryParentId = d.publisherId;
      topologyMap.set(d.publisherId, {
        peerId: d.publisherId, nickname: d.nickname, role: 'publisher',
        parentId: null, backupParentIds: [], children: [],
        linkTypes: {}, isReady: true, joinedAt: Date.now(),
        fanoutMax: MAX_FANOUT, fanoutAvailable: MAX_FANOUT, updatedAt: Date.now()
      });
      connectToParent(d.publisherId, 'primary');
    }
  });
  socket.on('peerJoined', function(d) {
    log('新节点加入: ' + peerTag(d.peerId) + ' (' + d.nickname + ')');
    peerNicknames[d.peerId] = d.nickname;
    // Seed topology with minimal info so backup selection can find this peer
    if (!topologyMap.has(d.peerId)) {
      topologyMap.set(d.peerId, {
        peerId: d.peerId, nickname: d.nickname, role: 'viewer',
        parentId: null, backupParentIds: [], children: [],
        linkTypes: {}, isReady: false, joinedAt: Date.now(),
        fanoutMax: MAX_FANOUT, fanoutAvailable: MAX_FANOUT, updatedAt: Date.now()
      });
      log('拓扑种子: 添加 ' + peerTag(d.peerId) + ' topo=' + topologyMap.size, 'debug');
    }
  });
  socket.on('peerLeft', function(d) {
    log('节点离开: ' + peerTag(d.peerId));
    handlePeerLeft(d.peerId);
  });
  socket.on('chatMessage', function(msg) {
    if (msg.id && seenMsgIds.has(msg.id)) return;
    if (msg.id) markSeen(msg.id);
    appendChatMessage(msg);
  });
  socket.on('reaction', function(d) { showReactionFloat(d.emoji); });
  socket.on('disconnect', function(reason) {
    log('信令断开: ' + reason, 'error');
    // Socket.io will auto-reconnect, but we need to handle the case where
    // all WebRTC connections also died (network switch scenario)
    networkRecoveryState.lastNetworkChange = Date.now();
  });
  socket.on('reconnect', function(attemptNumber) {
    log('信令重连成功 (尝试 ' + attemptNumber + ' 次)', 'warn');
  });
  socket.on('reconnect_attempt', function(attemptNumber) {
    if (attemptNumber === 1) {
      log('信令重连中...', 'warn');
    }
  });
  socket.on('reconnect_failed', function() {
    log('信令重连失败，请刷新页面', 'error');
  });
}

// ============================================================
// Peer Left Handling (decentralized)
// ============================================================
function handlePeerLeft(peerId) {
  // Remove from topology
  topologyMap.delete(peerId);
  delete peerNicknames[peerId];
  linkInfo.delete(peerId);

  // Close any connections to this peer
  var toClose = [];
  connections.forEach(function(ci, key) {
    if (ci.peerId === peerId) toClose.push(key);
  });
  if (toClose.length > 0) {
    log('关闭与 ' + peerTag(peerId) + ' 的 ' + toClose.length + ' 个连接: [' + toClose.join(', ') + ']');
  }
  toClose.forEach(function(key) {
    var ci = connections.get(key);
    if (ci) { try { ci.pc.close(); } catch(e) {} }
    connections.delete(key);
    pendingConnects.delete(key);
  });

  // If this was our primary parent, failover
  if (peerId === primaryParentId) {
    log('主父节点离开: ' + peerTag(peerId) + '，触发故障转移', 'warn');
    primaryParentId = null;
    promoteOrFindNewPrimary();
  }

  // If this was a backup parent, find replacement
  var bIdx = backupParents.indexOf(peerId);
  if (bIdx >= 0) {
    backupParents.splice(bIdx, 1);
    log('备用父节点离开: ' + peerTag(peerId) + '，寻找替代', 'warn');
    maybeAdjustBackups();
  }

  // Notify children of this peer (if we know them from topology) — they'll handle it themselves
  updateTopologyUI();
  updateIceStatusUI();
}

// ============================================================
// Failover: promote backup or find new parent
// ============================================================
var failoverInProgress = false; // Prevent race with network recovery

async function promoteOrFindNewPrimary() {
  // Prevent race condition with network recovery
  if (failoverInProgress) {
    log('故障转移已在进行中，跳过', 'debug');
    return;
  }
  failoverInProgress = true;
  
  showReconnectOverlay(true);
  resetHealthState();

  // Log all backup states for debugging
  log('故障转移开始: backups=[' + backupParents.map(function(bpId, i) {
    var bc = getConn(bpId, 'backup-' + i);
    return peerTag(bpId) + '(ice=' + (bc ? bc.iceState : 'no-conn') + ',stream=' + (bc && bc.stream ? bc.stream.getTracks().length + 'tracks' : 'none') + ')';
  }).join(', ') + ']', 'warn');

  // Try promoting first available backup
  for (var i = 0; i < backupParents.length; i++) {
    var bpId = backupParents[i];
    var bRole = 'backup-' + i;
    var bc = getConn(bpId, bRole);
    if (bc && (bc.iceState === 'connected' || bc.iceState === 'completed')) {
      log('提升备用 ' + peerTag(bpId) + ' 为主连接');
      // Re-key
      deleteConn(bpId, bRole);
      pendingConnects.delete(connKey(bpId, bRole));
      bc.role = 'primary';
      setConn(bpId, 'primary', bc);
      pendingConnects.delete(connKey(bpId, 'primary'));
      primaryParentId = bpId;
      backupParents.splice(i, 1);

      if (bc.stream && bc.stream.getTracks().length > 0) {
        receivedStream = bc.stream;
        showRemoteVideo(bpId, receivedStream);
        replaceTracksOnChildren(receivedStream);
        showReconnectOverlay(false);
        log('故障转移完成 (备用提升)');
      } else {
        log('备用连接无流，重新建立', 'warn');
        bc.pc.close(); deleteConn(bpId, 'primary');
        await connectToParent(bpId, 'primary');
      }
      // Rebuild backups
      maybeAdjustBackups();
      broadcastGossip();
      updateIceStatusUI();
      failoverInProgress = false;
      return;
    }
  }

  // No usable backup — find new parent from topology
  log('无可用备用，从拓扑中选择新父节点', 'warn');
  var excludeList = [myPeerId];
  backupParents.forEach(function(bp) { excludeList.push(bp); });
  // Also exclude any peer we already have a child connection to —
  // connecting to our own child as parent causes signaling confusion
  connections.forEach(function(ci) {
    if (ci.role === 'child' && excludeList.indexOf(ci.peerId) < 0) {
      excludeList.push(ci.peerId);
    }
  });
  var newParent = selectBestParent(excludeList);
  if (newParent) {
    primaryParentId = newParent;
    log('选择新主父节点: ' + peerTag(newParent));
    await connectToParent(newParent, 'primary');
    maybeAdjustBackups();
    broadcastGossip();
  } else {
    log('无可用父节点，等待拓扑更新...', 'error');
    // Will retry on next gossip update
  }
  showReconnectOverlay(false);
  failoverInProgress = false;
}

// ============================================================
// Dynamic Backup Adjustment
// ============================================================
function maybeAdjustBackups() {
  if (myRole !== 'viewer' || !primaryParentId) return;
  var desired = desiredBackupCount();
  var current = backupParents.length;

  if (current >= desired) {
    var backupStatus = current + '/' + desired + ':' + backupParents.join(',');
    if (backupStatus !== prevLogState.backupStatus) {
      log('备用连接充足: ' + current + '/' + desired + ' [' + backupParents.map(peerTag).join(', ') + ']', 'debug');
      prevLogState.backupStatus = backupStatus;
    }
    return;
  }

  // Only log "不足" when status actually changes
  var insufficientStatus = 'insufficient:' + current + '/' + desired;
  if (insufficientStatus !== prevLogState.backupStatus) {
    log('备用连接不足: ' + current + '/' + desired + '，寻找新备用', 'debug');
  }
  prevLogState.backupStatus = insufficientStatus;

  // Exclude: self, primary, existing backups, AND any peer whose backup is us
  // (prevents mutual backup: A backs up B while B backs up A — circular and useless)
  var excludeIds = [myPeerId, primaryParentId].concat(backupParents);

  // Also exclude peers that list us as their parent (they depend on us for primary stream)
  // For backup: allow mutual backup (A↔B) as a last resort — in small networks it's the only option
  var dependentExcluded = [];
  var mutualBackupExcluded = [];
  topologyMap.forEach(function(ns, pid) {
    if (ns.parentId === myPeerId) { excludeIds.push(pid); dependentExcluded.push(peerTag(pid) + '(child-of-us)'); }
    if (ns.backupParentIds && ns.backupParentIds.indexOf(myPeerId) >= 0) { mutualBackupExcluded.push(pid); }
  });

  // Also exclude peers we already have ANY child connection to (primary or backup)
  // Creating a backup connection to someone who is our child causes key collisions
  var childExcluded = [];
  connections.forEach(function(ci) {
    if (ci.role === 'child' && excludeIds.indexOf(ci.peerId) < 0) {
      excludeIds.push(ci.peerId);
      childExcluded.push(peerTag(ci.peerId) + '(' + (ci.childTag || 'child') + ')');
    }
  });

  if (dependentExcluded.length > 0 || childExcluded.length > 0) {
    log('备用排除: 依赖=[' + dependentExcluded.join(',') + '] 子节点=[' + childExcluded.join(',') + ']', 'debug');
  }

  // First pass: exclude mutual-backup peers (prefer non-circular backups)
  var firstPassExclude = excludeIds.concat(mutualBackupExcluded);
  var newBackups = selectBackupParents(primaryParentId, desired - current);

  // Filter out mutual-backup peers from first pass
  var filteredBackups = newBackups.filter(function(bpId) {
    return firstPassExclude.indexOf(bpId) < 0;
  });

  // If no candidates without mutual backup, allow mutual backup as fallback
  if (filteredBackups.length === 0 && mutualBackupExcluded.length > 0) {
    log('无非互备候选，允许互备: [' + mutualBackupExcluded.map(peerTag).join(',') + ']', 'debug');
    filteredBackups = newBackups.filter(function(bpId) {
      return excludeIds.indexOf(bpId) < 0;
    });
  }

  filteredBackups.forEach(function(bpId) {
    if (backupParents.indexOf(bpId) >= 0) { log('跳过已有备用: ' + peerTag(bpId), 'debug'); return; }
    var bIdx = backupParents.length;
    backupParents.push(bpId);
    log('建立备用连接 backup-' + bIdx + ': ' + peerTag(bpId));
    connectToParent(bpId, 'backup-' + bIdx);
  });

  if (filteredBackups.length === 0) {
    // Key on exclude/mutual counts only — topo size fluctuates and causes spam
    var noBackupReason = 'exclude=' + excludeIds.length + ',mutual=' + mutualBackupExcluded.length;
    if (noBackupReason !== prevLogState.noBackupReason) {
      log('无可用备用候选 (拓扑=' + topologyMap.size + '节点, 排除=' + excludeIds.length + ', 互备排除=' + mutualBackupExcluded.length + ')', 'debug');
      prevLogState.noBackupReason = noBackupReason;
    }
  } else {
    prevLogState.noBackupReason = ''; // Reset when we find backups
  }
}

// ============================================================
// WebRTC: Connect to parent (primary or backup-N)
// ============================================================
async function connectToParent(targetId, role) {
  var key = connKey(targetId, role);
  if (pendingConnects.has(key)) { log('跳过重复连接: ' + peerTag(targetId) + ' role=' + role, 'warn'); return; }

  var existing = getConn(targetId, role);
  if (existing) {
    var eIce = existing.pc.iceConnectionState;
    if (eIce === 'connected' || eIce === 'completed') { log('跳过(已连接): ' + peerTag(targetId) + ' ' + role, 'warn'); return; }
    if (existing.pc.signalingState === 'stable' && (eIce === 'checking' || eIce === 'new')) { log('跳过(等待ICE): ' + peerTag(targetId) + ' ' + role, 'warn'); return; }
    existing.pc.close(); deleteConn(targetId, role);
  }

  pendingConnects.add(key);
  var config = getIceConfig();
  log('创建PeerConnection(' + role + ') -> ' + peerTag(targetId) + ' iceServers=' + config.iceServers.length + ' policy=' + (config.iceTransportPolicy || 'all'), 'debug');
  var pc = new RTCPeerConnection(config);
  var ci = { pc: pc, role: role, dc: null, iceState: 'new', stats: {}, stream: null, peerId: targetId, createdAt: Date.now() };
  setConn(targetId, role, ci);

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  var dc = pc.createDataChannel('data', { ordered: true });
  ci.dc = dc;
  dc.onopen = function() {
    log('DataChannel(' + role + ') 打开 -> ' + peerTag(targetId));
    // Detect link type once connected
    detectLinkType(pc, targetId);
    // Send RTT probe
    sendRttProbe(ci);
    // Request topology from this peer
    try { dc.send(JSON.stringify({ type: 'request-topology' })); } catch(e) {}
  };
  dc.onmessage = function(e) { handleDcMessage(JSON.parse(e.data), targetId); };
  dc.onclose = function() { log('DataChannel(' + role + ') 关闭 -> ' + peerTag(targetId), 'warn'); };
  dc.onerror = function(e) { log('DataChannel(' + role + ') 错误 -> ' + peerTag(targetId) + ': ' + (e.error ? e.error.message : 'unknown'), 'error'); };

  pc.onicecandidate = function(e) {
    if (e.candidate) relaySdpSignal(targetId, { type: 'candidate', candidate: e.candidate, connRole: role });
  };

  pc.oniceconnectionstatechange = function() {
    ci.iceState = pc.iceConnectionState;
    log('ICE(' + role + ') ' + peerTag(targetId) + ': ' + pc.iceConnectionState + ' (conn=' + pc.connectionState + ', sig=' + pc.signalingState + ')');
    updateIceStatusUI();
    if (pc.iceConnectionState === 'disconnected') { ci.disconnectedAt = ci.disconnectedAt || Date.now(); }
    else { ci.disconnectedAt = null; }
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      pendingConnects.delete(key);
      detectLinkType(pc, targetId);
      // Flush pending candidate count log
      var candKey = targetId + ':' + role;
      if (candidateCounts[candKey]) {
        log('信令发送(socket): ' + candidateCounts[candKey] + ' candidates -> ' + peerTag(targetId) + ' role=' + role, 'debug');
        delete candidateCounts[candKey];
      }
      if (role === 'primary') showReconnectOverlay(false);
    }
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
      pendingConnects.delete(key);
    }
    if (pc.iceConnectionState === 'failed') { log('ICE失败 ' + peerTag(targetId) + '，重启...', 'warn'); pc.restartIce(); }
  };

  pc.ontrack = function(e) {
    log('收到轨道(' + role + '): ' + e.track.kind + ' from ' + peerTag(targetId));
    var remoteStream = (e.streams && e.streams[0]) ? e.streams[0] : null;
    if (remoteStream) { ci.stream = remoteStream; }
    else { if (!ci.stream) ci.stream = new MediaStream(); ci.stream.addTrack(e.track); }
    if (role === 'primary') {
      receivedStream = ci.stream;
      showRemoteVideo(targetId, receivedStream);
      replaceTracksOnChildren(receivedStream);
      if (ci.stream.getVideoTracks().length > 0 && ci.stream.getAudioTracks().length > 0) {
        // Mark ourselves as ready in topology
        if (myNodeState) myNodeState.isReady = true;
        broadcastGossip();
        log('已标记为可转发节点');
      }
    }
  };

  var offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  relaySdpSignal(targetId, { type: 'offer', sdp: pc.localDescription, connRole: role });
  log('发送 offer(' + role + ') -> ' + peerTag(targetId) + ' [key=' + key + ']');
}

// ============================================================
// WebRTC: Handle incoming signals
// ============================================================
async function handleSignal(fromId, data) {
  if (data.type === 'offer') {
    // Someone wants to pull stream from us
    var childTag = data.connRole || 'primary';
    var ourKey = 'child-' + childTag;

    // Glare detection: if we also have a pending outgoing connection to this peer
    // with the same role, resolve by comparing peer IDs (lower ID is "polite" and yields)
    var mirrorKey = connKey(fromId, childTag);
    if (pendingConnects.has(mirrorKey)) {
      if (myPeerId < fromId) {
        // We are polite — drop our outgoing offer, accept theirs
        log('Offer冲突(我让步): 关闭我方offer ' + mirrorKey, 'warn');
        var ourOutgoing = getConn(fromId, childTag);
        if (ourOutgoing) { ourOutgoing.pc.close(); deleteConn(fromId, childTag); }
        pendingConnects.delete(mirrorKey);
      } else {
        // We are impolite — ignore their offer, keep ours
        log('Offer冲突(对方让步): 忽略来自 ' + peerTag(fromId) + ' 的offer', 'warn');
        return;
      }
    }

    // Mutual backup prevention: if we already have an outgoing connection to this peer
    // as our backup (we're pulling from them), reject their offer to pull from us with
    // the same role — UNLESS there are no alternative backup candidates available.
    // Instead of a hard threshold (topologyMap.size > 3), we count how many non-mutual
    // backup candidates the remote peer could use. If alternatives exist, reject; otherwise allow.
    var existingOutgoing = getConn(fromId, childTag);
    if (existingOutgoing && existingOutgoing.role !== 'child') {
      var outIce = existingOutgoing.pc.iceConnectionState;
      if (outIce === 'connected' || outIce === 'completed' || outIce === 'checking' || outIce === 'new') {
        // Count how many alternative backup candidates the remote peer has
        // (nodes that are not us, not the remote peer, not the remote peer's primary, and have fanout)
        var remoteNs = topologyMap.get(fromId);
        var remotePrimaryId = remoteNs ? remoteNs.parentId : null;
        var altCandidates = 0;
        topologyMap.forEach(function(ns, pid) {
          if (pid === myPeerId || pid === fromId) return;
          if (pid === remotePrimaryId) return;
          if (ns.isReady && ns.fanoutAvailable > 0) altCandidates++;
        });
        if (altCandidates > 0) {
          log('拒绝互备offer: 我已有到 ' + peerTag(fromId) + ' 的 ' + childTag + ' 连接(ice=' + outIce + ')，对方有 ' + altCandidates + ' 个替代候选 (topo=' + topologyMap.size + ')', 'warn');
          return;
        } else {
          log('允许互备offer(无替代候选): ' + peerTag(fromId) + ' ' + childTag + ' altCandidates=0 (topo=' + topologyMap.size + ')', 'debug');
        }
      }
    }

    // Fanout limit check: reject if we're at capacity
    // Count current child connections (excluding the one we might be replacing)
    var currentChildCount = 0;
    connections.forEach(function(ci, key) {
      if (ci.role === 'child' && ci.peerId !== fromId) {
        // Only count active or pending connections
        if (ci.iceState === 'connected' || ci.iceState === 'completed' || ci.iceState === 'checking' || ci.iceState === 'new') {
          currentChildCount++;
        }
      }
    });
    
    if (currentChildCount >= MAX_FANOUT) {
      // At capacity - find alternative parents for the requester
      var alternativeParents = [];
      topologyMap.forEach(function(ns, pid) {
        if (pid === myPeerId || pid === fromId) return;
        if (ns.isReady && ns.fanoutAvailable > 0) {
          alternativeParents.push(peerTag(pid));
        }
      });
      
      // Always reject when at capacity - this enforces proper tree distribution
      log('拒绝offer(扇出已满): ' + peerTag(fromId) + ' 当前子节点=' + currentChildCount + '/' + MAX_FANOUT + ' 可选父节点=[' + alternativeParents.slice(0, 3).join(',') + ']', 'warn');
      // Send rejection message so the requester knows to try elsewhere
      relaySdpSignal(fromId, { type: 'reject', reason: 'fanout-full', connRole: childTag, alternatives: alternativeParents.slice(0, 5) });
      return;
    }

    log('收到 offer from ' + peerTag(fromId) + ' (角色:' + childTag + ', key=' + connKey(fromId, ourKey) + ')');

    var existingChild = getConn(fromId, ourKey);
    if (existingChild) {
      log('关闭旧子连接: ' + connKey(fromId, ourKey), 'warn');
      existingChild.pc.close(); deleteConn(fromId, ourKey);
    }

    var config = getIceConfig();
    var pc = new RTCPeerConnection(config);
    var ci = { pc: pc, role: 'child', dc: null, iceState: 'new', stats: {}, peerId: fromId, childTag: childTag, createdAt: Date.now() };
    setConn(fromId, ourKey, ci);

    pc.onicecandidate = function(e) {
      if (e.candidate) relaySdpSignal(fromId, { type: 'candidate', candidate: e.candidate, connRole: ourKey });
    };
    pc.oniceconnectionstatechange = function() {
      ci.iceState = pc.iceConnectionState;
      log('ICE(子-' + childTag + ') ' + peerTag(fromId) + ': ' + pc.iceConnectionState);
      if (pc.iceConnectionState === 'disconnected') { ci.disconnectedAt = ci.disconnectedAt || Date.now(); }
      else { ci.disconnectedAt = null; }
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        detectLinkType(pc, fromId);
        // Broadcast updated fanout availability immediately
        broadcastGossip();
      }
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        // Child disconnected - broadcast updated fanout availability
        broadcastGossip();
      }
      updateIceStatusUI();
    };
    pc.ondatachannel = function(e) {
      ci.dc = e.channel;
      e.channel.onmessage = function(ev) { handleDcMessage(JSON.parse(ev.data), fromId); };
      e.channel.onclose = function() { log('DataChannel(子-' + childTag + ') 关闭 <- ' + peerTag(fromId), 'warn'); };
      e.channel.onerror = function(err) { log('DataChannel(子-' + childTag + ') 错误 <- ' + peerTag(fromId) + ': ' + (err.error ? err.error.message : 'unknown'), 'error'); };
    };

    var stream = myRole === 'publisher' ? localStream : receivedStream;
    if (stream && stream.getTracks().length > 0) {
      stream.getTracks().forEach(function(t) { pc.addTrack(t, stream); });
      log('添加 ' + stream.getTracks().length + ' 轨道 -> ' + peerTag(fromId));
    } else {
      log('无可发送流 -> ' + peerTag(fromId), 'warn');
    }

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    // Flush queued ICE candidates
    if (ci._candidateQueue && ci._candidateQueue.length > 0) {
      for (var qi = 0; qi < ci._candidateQueue.length; qi++) {
        await pc.addIceCandidate(new RTCIceCandidate(ci._candidateQueue[qi]));
      }
      ci._candidateQueue = [];
    }
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('发送 answer -> ' + peerTag(fromId) + ' connRole=' + childTag);
    relaySdpSignal(fromId, { type: 'answer', sdp: pc.localDescription, connRole: childTag });

  } else if (data.type === 'answer') {
    var role = data.connRole || 'primary';
    var c = getConn(fromId, role);
    log('收到 answer from ' + peerTag(fromId) + ' role=' + role + ' found=' + (!!c) + ' sig=' + (c ? c.pc.signalingState : 'N/A'));
    if (c) {
      if (c.pc.signalingState === 'have-local-offer') {
        await c.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        // Flush queued ICE candidates
        if (c._candidateQueue && c._candidateQueue.length > 0) {
          for (var qi = 0; qi < c._candidateQueue.length; qi++) {
            await c.pc.addIceCandidate(new RTCIceCandidate(c._candidateQueue[qi]));
          }
          c._candidateQueue = [];
        }
        log('设置answer成功: ' + peerTag(fromId) + ' role=' + role);
      } else {
        log('跳过answer(状态=' + c.pc.signalingState + '): ' + peerTag(fromId), 'warn');
      }
    } else {
      var allKeys = [];
      connections.forEach(function(ci, key) { allKeys.push(key); });
      log('answer找不到连接: ' + peerTag(fromId) + ' role=' + role + ' conns=[' + allKeys.join(', ') + ']', 'warn');
    }

  } else if (data.type === 'candidate') {
    var cRole = data.connRole || 'primary';
    var c2 = null;
    // When we have both an outgoing connection (e.g. backup-0) and an incoming child
    // connection (e.g. child-backup-0) to the same peer, candidates from that peer
    // for role "backup-0" should go to OUR child-backup-0 (we're the child in their view).
    // So check child- prefix FIRST to avoid routing to the wrong PeerConnection.
    var childKey = 'child-' + cRole;
    c2 = getConn(fromId, childKey);
    if (!c2) c2 = getConn(fromId, cRole);
    if (!c2) { connections.forEach(function(ci, key) { if (!c2 && key.indexOf(fromId + ':') === 0) c2 = ci; }); }
    if (c2) {
      // Queue candidates if remote description not yet set
      if (!c2.pc.remoteDescription) {
        if (!c2._candidateQueue) c2._candidateQueue = [];
        c2._candidateQueue.push(data.candidate);
        log('ICE候选排队: ' + peerTag(fromId) + ' role=' + cRole + ' queue=' + c2._candidateQueue.length + ' (等待remoteDesc)', 'debug');
      } else {
        await c2.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } else {
      log('ICE候选丢弃: 找不到连接 ' + peerTag(fromId) + ' role=' + cRole, 'warn');
    }

  } else if (data.type === 'reject') {
    // Our connection request was rejected (e.g., target at fanout capacity)
    var rejRole = data.connRole || 'primary';
    log('连接被拒绝: ' + peerTag(fromId) + ' role=' + rejRole + ' reason=' + data.reason, 'warn');
    
    // Mark this peer as rejected (cooldown)
    markPeerRejected(fromId);
    
    // Close the pending connection
    var rejConn = getConn(fromId, rejRole);
    if (rejConn) {
      rejConn.pc.close();
      deleteConn(fromId, rejRole);
    }
    pendingConnects.delete(connKey(fromId, rejRole));
    
    // If this was our primary, try to find an alternative
    if (rejRole === 'primary' && fromId === primaryParentId) {
      primaryParentId = null;
      log('主连接被拒绝，寻找替代父节点...', 'warn');
      
      // Try alternatives suggested by the rejecting peer (skip those in cooldown)
      if (data.alternatives && data.alternatives.length > 0) {
        for (var i = 0; i < data.alternatives.length; i++) {
          var altTag = data.alternatives[i];
          var altId = null;
          topologyMap.forEach(function(ns, pid) {
            if (peerTag(pid) === altTag || pid.indexOf(altTag.split('(')[0]) === 0) {
              if (ns.isReady && ns.fanoutAvailable > 0 && !isPeerInCooldown(pid)) altId = pid;
            }
          });
          if (altId) {
            log('尝试替代父节点: ' + peerTag(altId));
            primaryParentId = altId;
            connectToParent(altId, 'primary');
            return;
          }
        }
      }
      
      // No suggested alternatives worked, use normal parent selection (excluding cooldown peers)
      var excludeIds = [myPeerId, fromId];
      // Add all peers in cooldown to exclude list
      Object.keys(rejectedPeers).forEach(function(pid) {
        if (isPeerInCooldown(pid) && excludeIds.indexOf(pid) < 0) {
          excludeIds.push(pid);
        }
      });
      
      var newParent = selectBestParent(excludeIds);
      if (newParent) {
        primaryParentId = newParent;
        log('选择新主父节点: ' + peerTag(newParent));
        connectToParent(newParent, 'primary');
      } else {
        // No parent available - wait for cooldown to expire and retry
        log('所有节点已满或在冷却中，等待 ' + (REJECTION_COOLDOWN / 1000) + ' 秒后重试...', 'warn');
        showReconnectOverlay(true);
        setTimeout(function() {
          if (!primaryParentId) {
            // Clear old rejections and try again
            var now = Date.now();
            Object.keys(rejectedPeers).forEach(function(pid) {
              if (now - rejectedPeers[pid].timestamp > REJECTION_COOLDOWN) {
                delete rejectedPeers[pid];
              }
            });
            
            var retryParent = selectBestParent([myPeerId]);
            if (retryParent) {
              primaryParentId = retryParent;
              log('冷却结束，重试连接到: ' + peerTag(retryParent));
              connectToParent(retryParent, 'primary');
              showReconnectOverlay(false);
            } else {
              // Still no parent - request fresh bootstrap from server
              log('仍无可用父节点，请求新引导节点...', 'warn');
              requestNewBootstrapAndReconnect();
            }
          }
        }, REJECTION_COOLDOWN);
      }
    }
    
    // If this was a backup, try to find another backup (with cooldown consideration)
    var backupIdx = backupParents.indexOf(fromId);
    if (backupIdx >= 0) {
      backupParents.splice(backupIdx, 1);
      log('备用连接被拒绝，寻找替代...', 'warn');
      // Don't immediately retry - let maybeAdjustBackups handle it with cooldown
      setTimeout(function() {
        maybeAdjustBackups();
      }, 2000);
    }
  }
}

// ============================================================
// DataChannel Message Handler
// ============================================================
function handleDcMessage(msg, fromId) {
  if (msg.type === 'topology-gossip') { handleGossipMessage(msg, fromId); }
  else if (msg.type === 'relay-signal') { handleRelaySignal(msg, fromId); }
  else if (msg.type === 'rtt-ping') { handleRttPing(msg, fromId); }
  else if (msg.type === 'rtt-pong') { handleRttPong(msg, fromId); }
  else if (msg.type === 'request-topology') { sendTopologyResponse(fromId); }
  else if (msg.type === 'topology-response') { handleTopologyResponse(msg); }
  else if (msg.type === 'chat') {
    if (seenMsgIds.has(msg.id)) return; markSeen(msg.id);
    appendChatMessage(msg);
    if (msg.direction === 'down') broadcastDc(msg, fromId);
  }
  else if (msg.type === 'reaction') {
    var rid = msg.id || (msg.from + '-' + msg.emoji + '-' + (msg.ts || 0));
    if (seenMsgIds.has(rid)) return; markSeen(rid);
    showReactionFloat(msg.emoji);
    if (msg.direction === 'down') broadcastDc(msg, fromId);
  }
  else if (msg.type === 'node-leaving') { handlePeerLeft(msg.peerId); }
  else if (msg.type === 'quality-alert') { handleQualityAlert(msg, fromId); }
  else { log('DC未知消息类型: ' + msg.type + ' from ' + peerTag(fromId), 'debug'); }
}

function sendTopologyResponse(targetPeerId) {
  var ci = findConnByPeer(targetPeerId);
  if (!ci || !ci.dc || ci.dc.readyState !== 'open') return;
  var nodes = [];
  topologyMap.forEach(function(ns) { nodes.push(ns); });
  try { ci.dc.send(JSON.stringify({ type: 'topology-response', nodes: nodes })); } catch(e) {}
}

function handleTopologyResponse(msg) {
  if (!msg.nodes) return;
  var merged = 0;
  msg.nodes.forEach(function(ns) {
    if (ns.peerId === myPeerId) return;
    var existing = topologyMap.get(ns.peerId);
    if (!existing || ns.updatedAt > existing.updatedAt) {
      topologyMap.set(ns.peerId, ns);
      if (ns.nickname) peerNicknames[ns.peerId] = ns.nickname;
      merged++;
    }
  });
  log('拓扑响应: 收到 ' + msg.nodes.length + ' 节点, 合并 ' + merged + ', 总计 ' + topologyMap.size, 'debug');
  updateTopologyUI();
  // Now that we have topology, adjust backups if needed
  if (myRole === 'viewer') maybeAdjustBackups();
}

function broadcastDc(msg, excludeId) {
  connections.forEach(function(conn) {
    if (conn.role === 'child' && conn.peerId !== excludeId && conn.dc && conn.dc.readyState === 'open') {
      try { conn.dc.send(JSON.stringify(msg)); } catch(e) {}
    }
  });
}

// ============================================================
// Quality Alert (adaptive scheduling)
// ============================================================
function handleQualityAlert(msg, fromId) {
  // A parent is telling us their quality is degrading
  if (msg.severity === 'severe' && fromId === primaryParentId) {
    log('父节点 ' + peerTag(fromId) + ' 严重质量下降，切换到备用', 'warn');
    promoteOrFindNewPrimary();
  } else if (msg.severity === 'moderate') {
    log('父节点 ' + peerTag(fromId) + ' 中度质量下降，准备备用连接', 'warn');
    maybeAdjustBackups();
  }
}

function replaceTracksOnChildren(newStream) {
  if (!newStream) return;
  var replaced = 0, total = 0;
  connections.forEach(function(conn) {
    if (conn.role !== 'child') return;
    total++;
    var senders = conn.pc.getSenders();
    newStream.getTracks().forEach(function(track) {
      var sender = senders.find(function(s) { return s.track && s.track.kind === track.kind; });
      if (sender) { sender.replaceTrack(track).catch(function(e) { log('替换子轨道失败: ' + peerTag(conn.peerId) + ' ' + e.message, 'warn'); }); replaced++; }
    });
  });
  if (total > 0) log('替换子节点轨道: ' + replaced + ' tracks across ' + total + ' children', 'debug');
}

// ============================================================
// Publisher
// ============================================================
async function startPublish() {
  var roomId = document.getElementById('roomIdInput').value.trim();
  if (!roomId) return alert(t('enterRoomId'));
  myNickname = document.getElementById('pubNickname').value.trim() || t('defaultPublisher');
  initSocket();
  try {
    localStream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
    cameraStream = localStream;
    document.getElementById('localVideo').srcObject = localStream;
    log('已获取本地音视频流');
  } catch(e) { log('获取媒体失败: ' + e.message, 'error'); return; }

  socket.emit('createRoom', {
    roomId: roomId,
    title: document.getElementById('roomTitle').value.trim(),
    password: document.getElementById('roomPassword').value,
    nickname: myNickname
  }, function(res) {
    if (res.error) return log('创建房间失败: ' + res.error, 'error');
    myPeerId = res.peerId;
    myRole = 'publisher';
    currentRoomId = roomId;
    currentRoomPwd = document.getElementById('roomPassword').value;
    if (res.iceConfig) serverIceConfig = res.iceConfig;

    // Initialize our node in topology
    myNodeState = createMyNodeState();
    topologyMap.set(myPeerId, myNodeState);
    peerNicknames[myPeerId] = myNickname;

    log('房间 ' + roomId + ' 创建成功' + (res.reconnected ? ' (重连)' : ''));
    document.getElementById('publisherArea').style.display = '';
    document.getElementById('noLiveArea').style.display = 'none';
    document.getElementById('publisherStatus').innerHTML = t('roomLabel') + ': <span>' + roomId + '</span> | <span>' + myNickname + '</span>';
    switchTab('live');
    startPeriodicTasks();
  });
}

function stopPublish() { cleanup(); location.reload(); }

function getMediaConstraints() {
  var r = document.getElementById('resolutionSelect').value;
  var fps = parseInt(document.getElementById('fpsSelect').value);
  var v = {};
  if (r === '720') { v.width = { ideal: 1280 }; v.height = { ideal: 720 }; }
  else if (r === '1080') { v.width = { ideal: 1920 }; v.height = { ideal: 1080 }; }
  v.frameRate = { ideal: fps };
  return { video: v, audio: true };
}

// ============================================================
// Screen Share
// ============================================================
var savedCameraTrack = null;

async function toggleScreenShare() {
  if (isScreenSharing) { stopScreenShare(); return; }
  try {
    var ss = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
    var st = ss.getVideoTracks()[0];
    savedCameraTrack = localStream.getVideoTracks()[0];
    connections.forEach(function(conn) {
      if (conn.role === 'child') {
        var s = conn.pc.getSenders().find(function(x) { return x.track && x.track.kind === 'video'; });
        if (s) s.replaceTrack(st);
      }
    });
    localStream.removeTrack(savedCameraTrack);
    localStream.addTrack(st);
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('localVideo').srcObject = localStream;
    st.onended = function() { stopScreenShare(); };
    isScreenSharing = true;
    document.getElementById('screenShareBanner').style.display = '';
    document.getElementById('btnScreenShare').textContent = t('screenShareRestore');
    log('已开始屏幕共享');
  } catch(e) { log('屏幕共享失败: ' + e.message, 'error'); }
}

async function stopScreenShare() {
  if (!isScreenSharing) return;
  var screenTrack = localStream.getVideoTracks()[0];
  if (screenTrack) { screenTrack.stop(); localStream.removeTrack(screenTrack); }
  var camTrack = savedCameraTrack;
  if (!camTrack || camTrack.readyState === 'ended') {
    try { var nc = await navigator.mediaDevices.getUserMedia({ video: getMediaConstraints().video }); camTrack = nc.getVideoTracks()[0]; }
    catch(e) { log('恢复摄像头失败: ' + e.message, 'error'); isScreenSharing = false; return; }
  }
  localStream.addTrack(camTrack);
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('localVideo').srcObject = localStream;
  connections.forEach(function(conn) {
    if (conn.role === 'child') {
      var s = conn.pc.getSenders().find(function(x) { return x.track && x.track.kind === 'video'; });
      if (s) s.replaceTrack(camTrack);
    }
  });
  savedCameraTrack = null; isScreenSharing = false;
  document.getElementById('screenShareBanner').style.display = 'none';
  document.getElementById('btnScreenShare').textContent = t('screenShare');
  log('已停止屏幕共享');
}

async function changeResolution() {
  if (myRole !== 'publisher' || !localStream) return;
  var vt = localStream.getVideoTracks()[0];
  if (vt && !isScreenSharing) {
    try { await vt.applyConstraints(getMediaConstraints().video); log('分辨率已调整'); }
    catch(e) { log('调整失败: ' + e.message, 'warn'); }
  }
}

// ============================================================
// Viewer — Decentralized Join
// ============================================================
var isJoining = false; // Prevent duplicate join attempts

async function joinAsViewer() {
  var roomId = document.getElementById('joinRoomInput').value.trim();
  if (!roomId) return alert(t('enterRoomId'));
  
  // Prevent duplicate join attempts (e.g., double-click)
  if (isJoining) {
    log('正在加入中，请稍候...', 'warn');
    return;
  }
  if (myRole === 'viewer' && currentRoomId === roomId) {
    log('已在房间中', 'warn');
    return;
  }
  
  isJoining = true;
  myNickname = document.getElementById('viewerNickname').value.trim() || (t('defaultViewer') + Math.floor(Math.random() * 1000));
  initSocket();

  socket.emit('joinRoom', {
    roomId: roomId,
    password: document.getElementById('joinPassword').value,
    nickname: myNickname
  }, async function(res) {
    isJoining = false; // Reset flag
    
    if (res.error) {
      log('加入失败: ' + res.error, 'error');
      // If room doesn't exist or no host, show dialog and stay in lobby
      if (res.error.indexOf('不存在') >= 0 || res.error.indexOf('无主播') >= 0) {
        alert(t('roomNotExist'));
      } else {
        alert(t('joinFailed') + res.error);
      }
      return;
    }
    
    // Prevent processing if we already joined (race condition)
    if (myRole === 'viewer' && currentRoomId === roomId && primaryParentId) {
      log('已加入房间，忽略重复回调', 'warn');
      return;
    }
    
    myPeerId = res.peerId;
    myRole = 'viewer';
    currentRoomId = roomId;
    currentRoomPwd = document.getElementById('joinPassword').value;
    if (res.iceConfig) serverIceConfig = res.iceConfig;

    // Initialize our node in topology
    myNodeState = createMyNodeState();
    topologyMap.set(myPeerId, myNodeState);
    peerNicknames[myPeerId] = myNickname;

    if (res.chatHistory) res.chatHistory.forEach(function(m) { appendChatMessage(m); });
    if (res.publisherOffline) log('主播当前离线，等待重连...', 'warn');

    document.getElementById('viewerArea').style.display = '';
    document.getElementById('noLiveArea').style.display = 'none';
    switchTab('live');

    // Phase 4: Connect to bootstrap nodes to get topology, then pick best parent
    var bootstrapNodes = res.bootstrapNodes || [];
    log('收到 ' + bootstrapNodes.length + ' 个引导节点');

    if (bootstrapNodes.length === 0) {
      log('无引导节点可用', 'error');
      return;
    }

    // Seed topology with bootstrap nodes info
    bootstrapNodes.forEach(function(node) {
      var pid = node.peerId || node.socketId;
      peerNicknames[pid] = node.nickname;
      if (!topologyMap.has(pid)) {
        topologyMap.set(pid, {
          peerId: pid, nickname: node.nickname, role: node.isPublisher ? 'publisher' : 'viewer',
          parentId: null, backupParentIds: [], children: [],
          linkTypes: {}, isReady: true, joinedAt: Date.now(),
          fanoutMax: MAX_FANOUT, fanoutAvailable: MAX_FANOUT, updatedAt: Date.now()
        });
      }
    });

    // Select best parent from bootstrap nodes based on fanout availability
    // Server now sends fanoutAvailable info, so we can make smarter choices
    var selectedParent = null;
    
    // Sort bootstrap nodes by fanout availability (higher first)
    var sortedNodes = bootstrapNodes.slice().sort(function(a, b) {
      var aFanout = a.fanoutAvailable !== undefined ? a.fanoutAvailable : MAX_FANOUT;
      var bFanout = b.fanoutAvailable !== undefined ? b.fanoutAvailable : MAX_FANOUT;
      // Prefer nodes with available fanout
      if (aFanout > 0 && bFanout <= 0) return -1;
      if (bFanout > 0 && aFanout <= 0) return 1;
      // Among nodes with fanout, prefer non-publisher (to distribute load from root)
      if (aFanout > 0 && bFanout > 0) {
        if (!a.isPublisher && b.isPublisher) return -1;
        if (a.isPublisher && !b.isPublisher) return 1;
      }
      return bFanout - aFanout;
    });
    
    // Log bootstrap node fanout info for debugging
    log('引导节点: ' + sortedNodes.map(function(n) {
      return peerTag(n.peerId || n.socketId) + '(fanout=' + (n.fanoutAvailable !== undefined ? n.fanoutAvailable : '?') + (n.isPublisher ? ',pub' : '') + ')';
    }).join(', '), 'debug');
    
    // Select first node with available fanout
    for (var i = 0; i < sortedNodes.length; i++) {
      var node = sortedNodes[i];
      var fanout = node.fanoutAvailable !== undefined ? node.fanoutAvailable : MAX_FANOUT;
      if (fanout > 0) {
        selectedParent = node;
        break;
      }
    }
    
    // Fallback to first node if all are at capacity (will get rejected and retry)
    if (!selectedParent && sortedNodes.length > 0) {
      selectedParent = sortedNodes[0];
      log('所有节点已满，尝试连接 ' + peerTag(selectedParent.peerId || selectedParent.socketId) + ' (可能被拒绝)', 'warn');
    }
    
    if (!selectedParent) {
      log('无可用引导节点', 'error');
      return;
    }
    
    var parentType = selectedParent.isPublisher ? '主播' : '观众';
    var parentFanout = selectedParent.fanoutAvailable !== undefined ? selectedParent.fanoutAvailable : '?';
    log('选择 ' + parentType + ' 作为初始父节点: ' + peerTag(selectedParent.peerId || selectedParent.socketId) + ' (fanout=' + parentFanout + ')');
    
    primaryParentId = selectedParent.peerId || selectedParent.socketId;
    peerNicknames[primaryParentId] = selectedParent.nickname;

    document.getElementById('viewerStatus').innerHTML = '<span>' + myNickname + '</span> | ' + t('primaryLabel') + ': <span>' + peerTag(primaryParentId) + '</span>';

    await connectToParent(primaryParentId, 'primary');

    // After a short delay, check topology and maybe optimize parent + add backups
    setTimeout(function() {
      optimizeParentIfBetter();
      maybeAdjustBackups();
    }, 5000);

    startPeriodicTasks();
  });
}

function leaveRoom() {
  // Notify peers we're leaving
  var leaveMsg = { type: 'node-leaving', peerId: myPeerId };
  connections.forEach(function(ci) {
    if (ci.dc && ci.dc.readyState === 'open') {
      try { ci.dc.send(JSON.stringify(leaveMsg)); } catch(e) {}
    }
  });
  cleanup();
  location.reload();
}

// ============================================================
// Periodic parent optimization
// ============================================================
function optimizeParentIfBetter() {
  if (myRole !== 'viewer' || !primaryParentId) return;

  var currentNs = topologyMap.get(primaryParentId);
  
  // If connected to publisher and publisher has capacity, stay (it's the root)
  // But if publisher is at capacity, we should migrate to help distribute load
  if (currentNs && currentNs.role === 'publisher') {
    if (currentNs.fanoutAvailable > 0) {
      // Publisher has capacity, stay connected
      return;
    }
    // Publisher is at capacity - check if there's a better option
    log('主播已满(fanout=' + currentNs.fanoutAvailable + ')，检查是否有更优父节点...', 'debug');
  }

  var currentScore = parentScore(currentNs, primaryParentId, true); // true = is current parent
  var excludeIds = [myPeerId].concat(backupParents);
  var bestId = selectBestParent(excludeIds);
  if (!bestId || bestId === primaryParentId) {
    log('父节点优化: 无更优选择 (当前=' + peerTag(primaryParentId) + ' score=' + Math.round(currentScore) + ')', 'debug');
    return;
  }
  var bestNs = topologyMap.get(bestId);
  var bestScore = parentScore(bestNs, bestId, false);
  log('父节点优化: 当前=' + peerTag(primaryParentId) + '(score=' + Math.round(currentScore) + ',role=' + (currentNs ? currentNs.role : '?') + ',fanout=' + (currentNs ? currentNs.fanoutAvailable : '?') + ') 最优=' + peerTag(bestId) + '(score=' + Math.round(bestScore) + ',role=' + (bestNs ? bestNs.role : '?') + ',fanout=' + (bestNs ? bestNs.fanoutAvailable : '?') + ') 阈值=' + Math.round(currentScore * 0.8), 'debug');
  // Only switch if 20% better (avoid flapping)
  if (bestScore < currentScore * 0.8) {
    log('发现更优父节点: ' + peerTag(bestId) + ' (score=' + Math.round(bestScore) + ' vs ' + Math.round(currentScore) + ')，迁移中');
    migrateToNewParent(bestId);
  }
}

async function migrateToNewParent(newParentId) {
  // Connect to new parent first, then disconnect old
  var oldPrimary = primaryParentId;
  log('迁移开始: ' + peerTag(oldPrimary) + ' -> ' + peerTag(newParentId));
  primaryParentId = newParentId;
  await connectToParent(newParentId, 'primary');

  // Wait for connection to establish before closing old
  setTimeout(function() {
    var newConn = getConn(newParentId, 'primary');
    var newIce = newConn ? newConn.iceState : 'no-conn';
    log('迁移检查: ' + peerTag(newParentId) + ' ice=' + newIce, 'debug');
    if (newConn && (newConn.iceState === 'connected' || newConn.iceState === 'completed')) {
      // New connection is good, close old
      if (oldPrimary && oldPrimary !== newParentId) {
        closeConnByRole(oldPrimary, 'primary');
        log('已迁移: ' + peerTag(oldPrimary) + ' -> ' + peerTag(newParentId));
      }
      broadcastGossip();
    } else {
      // New connection failed, revert
      log('迁移失败，恢复旧连接', 'warn');
      primaryParentId = oldPrimary;
      closeConnByRole(newParentId, 'primary');
    }
  }, 5000);
}

function closeConnByRole(peerId, role) {
  var ci = getConn(peerId, role);
  if (ci) { ci.pc.close(); deleteConn(peerId, role); }
  pendingConnects.delete(connKey(peerId, role));
}

// ============================================================
// Auto-rejoin after socket reconnect
// ============================================================
function closeAllPeerConnections() {
  connections.forEach(function(conn) { try { conn.pc.close(); } catch(e) {} });
  connections.clear();
  pendingConnects.clear();
  receivedStream = null;
  primaryParentId = null;
  backupParents = [];
  resetHealthState();
}

function autoRejoin() {
  var savedRole = myRole;
  var savedRoom = currentRoomId;
  var savedPwd = currentRoomPwd;
  var savedNick = myNickname;
  log('自动重连: role=' + savedRole + ' room=' + savedRoom + ' nick=' + savedNick, 'warn');
  // Block network recovery from interfering while we're doing our own reconnection
  networkRecoveryState.isRecovering = true;
  closeAllPeerConnections();
  showReconnectOverlay(true);

  if (savedRole === 'publisher') {
    socket.emit('createRoom', {
      roomId: savedRoom,
      title: document.getElementById('roomTitle').value.trim(),
      password: savedPwd,
      nickname: savedNick
    }, function(res) {
      if (res.error) { log('主播重连失败: ' + res.error, 'error'); networkRecoveryState.isRecovering = false; showReconnectOverlay(false); return; }
      myPeerId = res.peerId; myRole = 'publisher';
      if (res.iceConfig) serverIceConfig = res.iceConfig;
      myNodeState = createMyNodeState();
      topologyMap.set(myPeerId, myNodeState);
      log('主播重连成功 room=' + savedRoom);
      networkRecoveryState.isRecovering = false;
      showReconnectOverlay(false);
      broadcastGossip();
    });
  } else if (savedRole === 'viewer') {
    socket.emit('joinRoom', {
      roomId: savedRoom, password: savedPwd, nickname: savedNick
    }, async function(res) {
      if (res.error) { log('观众重连失败: ' + res.error, 'error'); networkRecoveryState.isRecovering = false; showReconnectOverlay(false); return; }
      myPeerId = res.peerId; myRole = 'viewer';
      if (res.iceConfig) serverIceConfig = res.iceConfig;
      myNodeState = createMyNodeState();
      topologyMap.set(myPeerId, myNodeState);

      var bootstrapNodes = res.bootstrapNodes || [];
      if (bootstrapNodes.length > 0) {
        primaryParentId = bootstrapNodes[0].peerId || bootstrapNodes[0].socketId;
        peerNicknames[primaryParentId] = bootstrapNodes[0].nickname;
        await connectToParent(primaryParentId, 'primary');
        setTimeout(function() { maybeAdjustBackups(); }, 3000);
      }
      log('观众重连成功 room=' + savedRoom);
      networkRecoveryState.isRecovering = false;
      showReconnectOverlay(false);
    });
  }
}

// ============================================================
// Stream Health Monitoring
// ============================================================
function checkStreamHealth() {
  if (!socket || !myPeerId || myRole !== 'viewer') return;
  if (streamHealthState.failoverInProgress) return;
  var primaryConn = primaryParentId ? getConn(primaryParentId, 'primary') : null;
  if (!primaryConn || !primaryConn.pc || primaryConn.pc.connectionState === 'closed') return;
  var iceState = primaryConn.pc.iceConnectionState;
  if (iceState !== 'connected' && iceState !== 'completed') { resetHealthState(); return; }

  primaryConn.pc.getStats().then(function(stats) {
    var totalBytes = 0, hasInbound = false;
    stats.forEach(function(report) {
      if (report.type === 'inbound-rtp' && report.kind === 'video') { totalBytes += report.bytesReceived || 0; hasInbound = true; }
    });
    if (!hasInbound) return;
    if (streamHealthState.prevBytesReceived > 0 && totalBytes <= streamHealthState.prevBytesReceived) {
      streamHealthState.stallCount++;
      log('流量停滞 (' + streamHealthState.stallCount + '/' + STALL_THRESHOLD + ') bytes=' + totalBytes + ' primary=' + peerTag(primaryParentId) + ' ice=' + iceState, 'warn');
      if (streamHealthState.stallCount >= STALL_THRESHOLD) {
        log('主连接流量停滞，触发故障转移', 'error');
        streamHealthState.failoverInProgress = true;
        promoteOrFindNewPrimary();
      }
    } else {
      if (streamHealthState.stallCount > 0) streamHealthState.stallCount = 0;
    }
    streamHealthState.prevBytesReceived = totalBytes;
  }).catch(function() {});
}

// ============================================================
// Periodic Tasks
// ============================================================
var periodicTimers = [];

function startPeriodicTasks() {
  // Gossip broadcast
  periodicTimers.push(setInterval(function() {
    if (!myPeerId) return;
    broadcastGossip();
    pruneTopology();
  }, GOSSIP_INTERVAL));

  // Heartbeat to signaling server
  periodicTimers.push(setInterval(function() {
    if (socket && socket.connected) socket.emit('heartbeat');
  }, HEARTBEAT_INTERVAL));

  // Health check + stats + stale cleanup
  periodicTimers.push(setInterval(function() {
    if (!myPeerId) return;
    checkStreamHealth();
    collectStats();
    cleanupStaleConnections();
    // RTT probes
    connections.forEach(function(ci) { if (ci.iceState === 'connected') sendRttProbe(ci); });
  }, HEALTH_CHECK_INTERVAL));

  // Parent optimization (every 30s)
  periodicTimers.push(setInterval(function() {
    optimizeParentIfBetter();
  }, 30000));

  // Room status check (every 30s) - detect if host left while we were disconnected
  periodicTimers.push(setInterval(function() {
    if (!myPeerId || myRole !== 'viewer' || !currentRoomId) return;
    if (!socket || !socket.connected) return;
    checkRoomStatus();
  }, 30000));

  // Connection state dump (only log on change)
  periodicTimers.push(setInterval(function() {
    if (!myPeerId) return;
    var connSummary = [];
    connections.forEach(function(conn, key) { connSummary.push(key + '=' + conn.iceState + (conn.stream ? '(' + conn.stream.getTracks().length + 't)' : '') + (conn.dc ? '[dc=' + conn.dc.readyState + ']' : '[no-dc]')); });
    var summaryStr = connSummary.join(', ');
    if (connSummary.length > 0 && summaryStr !== prevLogState.connSummary) {
      log('连接状态: role=' + myRole + ' primary=' + peerTag(primaryParentId) + ' backups=[' + backupParents.map(peerTag).join(',') + '] topo=' + topologyMap.size + '节点 pending=' + pendingConnects.size + ' conns=[' + summaryStr + ']', 'debug');
      prevLogState.connSummary = summaryStr;
    }
    // Update viewer status bar
    if (myRole === 'viewer') {
      var el = document.getElementById('viewerStatus');
      if (el) {
        el.innerHTML = '<span>' + myNickname + '</span> | ' + t('primaryLabel') + ': <span>' + peerTag(primaryParentId) + '</span>' +
          (backupParents.length > 0 ? ' | ' + t('backupLabel') + ': <span>' + backupParents.map(peerTag).join(', ') + '</span>' : '') +
          ' | ' + t('topoLabel') + ': <span>' + topologyMap.size + t('nodesLabel') + '</span>';
      }
    }
  }, 5000));
}

// Check if room/host still exists (handles case where we missed roomClosed event)
function checkRoomStatus() {
  socket.emit('getRoomList', function(list) {
    var roomExists = list.some(function(r) { return r.roomId === currentRoomId; });
    if (!roomExists) {
      log('房间已不存在，主播已离开', 'warn');
      alert(t('liveEnded'));
      cleanup();
      switchTab('lobby');
    }
  });
}

function collectStats() {
  connections.forEach(function(conn) {
    if (!conn.pc || conn.pc.connectionState === 'closed') return;
    conn.pc.getStats().then(function(stats) {
      var rtt = 0, packetLoss = 0, jitter = 0, bytesReceived = 0, bytesSent = 0;
      stats.forEach(function(report) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') rtt = (report.currentRoundTripTime || 0) * 1000;
        if (report.type === 'inbound-rtp') { packetLoss = report.packetsLost || 0; jitter = (report.jitter || 0) * 1000; bytesReceived += report.bytesReceived || 0; }
        if (report.type === 'outbound-rtp') bytesSent += report.bytesSent || 0;
      });
      conn.stats = { rtt: rtt, packetLoss: packetLoss, jitter: jitter, bytesReceived: bytesReceived, bytesSent: bytesSent };
    }).catch(function() {});
  });
}

function cleanupStaleConnections() {
  var now = Date.now();
  var staleKeys = [];
  var allStuck = true;
  var stuckInNewCount = 0;
  var totalConns = 0;
  
  connections.forEach(function(conn, key) {
    totalConns++;
    var age = conn.createdAt ? (now - conn.createdAt) : 0;
    if (conn.iceState === 'new' && age > 15000) {
      staleKeys.push(key);
      stuckInNewCount++;
    }
    else if (conn.iceState === 'disconnected') {
      if (!conn.disconnectedAt) conn.disconnectedAt = now;
      else if (now - conn.disconnectedAt > 15000) staleKeys.push(key);
      allStuck = false;
    }
    else if ((conn.iceState === 'failed' || conn.iceState === 'closed') && age > 10000) staleKeys.push(key);
    else if (conn.disconnectedAt && conn.iceState !== 'disconnected') conn.disconnectedAt = null;
    
    // Track if any connection is healthy or actively negotiating
    // 'checking' means ICE is actively working, not stuck
    if (conn.iceState === 'connected' || conn.iceState === 'completed' || conn.iceState === 'checking') {
      allStuck = false;
    }
  });
  
  staleKeys.forEach(function(key) {
    var conn = connections.get(key);
    if (conn) {
      var age = conn.createdAt ? Math.round((now - conn.createdAt) / 1000) : '?';
      var discAge = conn.disconnectedAt ? Math.round((now - conn.disconnectedAt) / 1000) : '-';
      log('清理过期连接: ' + key + ' ice=' + conn.iceState + ' age=' + age + 's discAge=' + discAge + 's peer=' + peerTag(conn.peerId), 'warn');
      conn.pc.close(); connections.delete(key); pendingConnects.delete(key);
      
      // If this was our primary, failover
      if (conn.peerId === primaryParentId && conn.role === 'primary') {
        primaryParentId = null;
        promoteOrFindNewPrimary();
      }
      
      // If this was a backup connection, remove from backupParents array
      if (conn.role && conn.role.indexOf('backup') === 0) {
        var bIdx = backupParents.indexOf(conn.peerId);
        if (bIdx >= 0) {
          backupParents.splice(bIdx, 1);
          log('从备用列表移除: ' + peerTag(conn.peerId), 'debug');
        }
      }
    }
  });
  if (staleKeys.length > 0) updateIceStatusUI();
  
  // Network recovery check: if viewer has no healthy connections and socket is up,
  // trigger recovery (handles case where network change event wasn't fired)
  // But don't trigger if we have peers in cooldown (we're waiting for retry)
  // Also don't trigger if failover is already in progress
  var peersInCooldown = Object.keys(rejectedPeers).filter(function(pid) { return isPeerInCooldown(pid); }).length;
  if (myRole === 'viewer' && totalConns > 0 && allStuck && !networkRecoveryState.isRecovering && !failoverInProgress && peersInCooldown === 0) {
    var socketOk = socket && socket.connected;
    if (socketOk) {
      log('检测到所有连接异常 (stuck=' + stuckInNewCount + '/' + totalConns + ')，触发网络恢复', 'warn');
      handleNetworkChange();
    }
  }
}

// ============================================================
// Chat / Reactions
// ============================================================
function sendChat() {
  var i = document.getElementById('chatInput'), m = i.value.trim();
  if (!m || !socket) return; i.value = '';
  socket.emit('chatMessage', { message: m, nickname: myNickname });
}
function appendChatMessage(msg) {
  var c = document.getElementById('chatMessages');
  if (msg.id && c.querySelector('[data-id="' + msg.id + '"]')) return;
  var d = document.createElement('div'); d.className = 'chat-msg'; if (msg.id) d.dataset.id = msg.id;
  d.innerHTML = '<span class="nick">' + escHtml(msg.nickname) + '</span><span class="time">' + new Date(msg.timestamp).toLocaleTimeString() + '</span><br>' + escHtml(msg.message);
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}
function sendReaction(emoji) { if (!socket) return; socket.emit('reaction', { emoji: emoji }); showReactionFloat(emoji); }

function copyLogs() {
  var area = document.getElementById('logArea');
  if (!area) return;
  var header = '--- ' + (myNickname || 'unknown') + ' (' + (myRole || '?') + ') | peer=' + (myPeerId ? myPeerId.substring(0, 8) : '?') + ' | room=' + (currentRoomId || '?') + ' | ' + new Date().toLocaleString() + ' ---\n';
  var text = header;
  area.querySelectorAll('.log-entry').forEach(function(el) { text += el.textContent + '\n'; });
  navigator.clipboard.writeText(text).then(function() {
    showCopyToast(area.childNodes.length);
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showCopyToast(area.childNodes.length); } catch(e) { log('复制失败: ' + e.message, 'error'); }
    document.body.removeChild(ta);
  });
}

function showCopyToast(count) {
  var existing = document.getElementById('copyToast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'copyToast';
  toast.textContent = t('copiedLogs').replace('{0}', count);
  toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#0f9;border:1px solid #0f9;padding:8px 20px;border-radius:6px;font-size:14px;z-index:99999;pointer-events:none;opacity:1;transition:opacity 0.5s';
  document.body.appendChild(toast);
  setTimeout(function() { toast.style.opacity = '0'; }, 1500);
  setTimeout(function() { toast.remove(); }, 2100);
}
function showReactionFloat(emoji) {
  var c = document.getElementById('reactionFloat'), el = document.createElement('div');
  el.className = 'reaction-anim'; el.textContent = emoji;
  el.style.left = (Math.random() * 80 - 40) + 'px';
  c.appendChild(el); setTimeout(function() { el.remove(); }, 2000);
}

// ============================================================
// ICE Status UI
// ============================================================
function updateIceStatusUI() {
  // Viewer ICE status
  var c = document.getElementById('iceStatus');
  if (c) {
    c.innerHTML = '';
    connections.forEach(function(conn, key) {
      if (conn.role === 'child') return;
      var st = conn.iceState || 'new', color = '#888';
      if (st === 'connected' || st === 'completed') color = '#0f9';
      else if (st === 'checking' || st === 'new') color = '#ff0';
      else if (st === 'failed' || st === 'disconnected' || st === 'closed') color = '#f33';
      var rl = conn.role === 'primary' ? '↑主' : conn.role.indexOf('backup') === 0 ? '↑备' : '?';
      var li = linkInfo.get(conn.peerId);
      var linkLabel = li ? ' [' + li.linkType + ']' : '';
      var b = document.createElement('div'); b.className = 'ice-badge'; b.style.background = color + '22'; b.style.color = color;
      b.innerHTML = '<span class="dot" style="background:' + color + '"></span>' + rl + ' ' + peerTag(conn.peerId) + ' ' + st + linkLabel;
      c.appendChild(b);
    });
  }

  // Host child connections
  var hc = document.getElementById('hostIceStatus');
  if (hc) {
    var childCount = 0, html = '';
    connections.forEach(function(conn, key) {
      if (conn.role !== 'child') return;
      childCount++;
      var st = conn.iceState || 'new', color = '#888';
      if (st === 'connected' || st === 'completed') color = '#0f9';
      else if (st === 'checking' || st === 'new') color = '#ff0';
      else if (st === 'failed' || st === 'disconnected' || st === 'closed') color = '#f33';
      var li = linkInfo.get(conn.peerId);
      var linkLabel = li ? ' [' + li.linkType + ']' : '';
      var tag = conn.childTag ? '(' + conn.childTag + ')' : '';
      html += '<div class="ice-badge" style="background:' + color + '22;color:' + color + '"><span class="dot" style="background:' + color + '"></span>↓子 ' + peerTag(conn.peerId) + ' ' + tag + ' ' + st + linkLabel + '</div>';
    });
    hc.innerHTML = childCount > 0 ? html : '<span style="color:var(--muted);font-size:12px">' + t('noChildNodes') + '</span>';
  }
}

function updateTopologyUI() {
  // Update stats bar from topology data
  var viewerCount = Math.max(0, topologyMap.size - 1);
  var el = document.getElementById('statsBar');
  if (el && myRole) {
    el.style.display = '';
    document.getElementById('statViewers').textContent = viewerCount;
    document.getElementById('statDepth').textContent = getMaxTreeDepth();
    var saved = viewerCount > 0 ? Math.round((1 - MAX_FANOUT / viewerCount) * 1000) / 10 : 0;
    if (saved < 0) saved = 0;
    document.getElementById('statSaved').textContent = saved + '%';
    document.getElementById('statPcdn').textContent = Math.min(viewerCount, MAX_FANOUT);
  }
  // Count link types
  var linkCounts = {};
  linkInfo.forEach(function(li) { linkCounts[li.linkType] = (linkCounts[li.linkType] || 0) + 1; });
  var linkSummary = [];
  for (var lt in linkCounts) linkSummary.push(lt + ':' + linkCounts[lt]);
  var linkEl = document.getElementById('statLinks');
  if (linkEl) linkEl.textContent = linkSummary.join(' ') || '-';

  drawTopology();
}

function getMaxTreeDepth() {
  var publisherId = null;
  topologyMap.forEach(function(ns) { if (ns.role === 'publisher') publisherId = ns.peerId; });
  if (!publisherId) return 0;
  var maxD = 0;
  function dfs(pid, d) {
    if (d > maxD) maxD = d;
    topologyMap.forEach(function(ns) { if (ns.parentId === pid) dfs(ns.peerId, d + 1); });
  }
  dfs(publisherId, 0);
  return maxD;
}

// ============================================================
// Room List
// ============================================================
function renderRoomList(list) {
  var c = document.getElementById('roomList');
  if (!list || list.length === 0) { c.innerHTML = '<div style="color:var(--muted);font-size:13px">' + t('noRooms') + '</div>'; return; }
  c.innerHTML = '';
  list.forEach(function(r) {
    var card = document.createElement('div'); card.className = 'room-card';
    var off = r.publisherOffline ? ' <span style="color:#f90">' + t('roomCardOffline') + '</span>' : '';
    card.innerHTML = '<div class="room-title">' + (r.hasPassword ? '🔒 ' : '') + escHtml(r.title) + off + '</div><div class="room-meta">' + t('roomCardHost') + ': ' + escHtml(r.publisherName) + ' · 👥 ' + r.viewerCount + '</div>';
    card.onclick = function() { document.getElementById('joinRoomInput').value = r.roomId; };
    c.appendChild(card);
  });
}

function showRemoteVideo(peerId, stream) {
  var v = document.getElementById('remoteVideo');
  if (!v) return;
  if (v.srcObject !== stream) v.srcObject = stream;
  var playPromise = v.play();
  if (playPromise !== undefined) {
    playPromise.catch(function(err) {
      log('视频自动播放被阻止: ' + err.message, 'warn');
      function resumePlay() { v.play().catch(function() {}); document.removeEventListener('touchstart', resumePlay); document.removeEventListener('click', resumePlay); }
      document.addEventListener('touchstart', resumePlay, { once: true });
      document.addEventListener('click', resumePlay, { once: true });
    });
  }
  var btn = document.getElementById('btnUnmute');
  if (btn) btn.textContent = v.muted ? t('unmute') : t('mute');
  var l = document.getElementById('remoteVideoLabel');
  if (l) l.innerHTML = t('connectedFrom') + ': <span style="color:var(--accent2)">' + peerTag(peerId) + '</span>';
}

function unmuteVideo() {
  var v = document.getElementById('remoteVideo'); if (!v) return;
  v.muted = !v.muted;
  var btn = document.getElementById('btnUnmute');
  if (btn) btn.textContent = v.muted ? t('unmute') : t('mute');
  if (!v.muted) v.play().catch(function() {});
}

// ============================================================
// Topology Canvas Drawing (Phase 4: link-type colored edges)
// ============================================================
var LINK_COLORS = {};
LINK_COLORS[LINK_LOCAL] = '#0f9';
LINK_COLORS[LINK_NEARBY] = '#39f';
LINK_COLORS[LINK_REMOTE] = '#888';
LINK_COLORS[LINK_RELAY] = '#f33';
LINK_COLORS[LINK_UNKNOWN] = '#555';

function drawTopology() {
  var canvas = document.getElementById('topoCanvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = 400 * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = '400px';
  ctx.scale(dpr, dpr);
  var W = rect.width, H = 400;
  ctx.clearRect(0, 0, W, H);

  // Build node list from topology map
  var nodes = [];
  topologyMap.forEach(function(ns) { nodes.push(ns); });
  if (nodes.length === 0) { ctx.fillStyle = '#555'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无拓扑数据', W / 2, H / 2); return; }

  var root = null;
  for (var ni = 0; ni < nodes.length; ni++) { if (nodes[ni].role === 'publisher') { root = nodes[ni]; break; } }
  if (!root) return;

  var nodeMap = {};
  nodes.forEach(function(n) {
    nodeMap[n.peerId] = {
      id: n.peerId, parentId: n.parentId, backupParentIds: n.backupParentIds || [],
      role: n.role, isReady: n.isReady, fanoutAvailable: n.fanoutAvailable,
      nickname: n.nickname, children: [], x: 0, y: 0
    };
  });
  nodes.forEach(function(n) { if (n.parentId && nodeMap[n.parentId]) nodeMap[n.parentId].children.push(n.peerId); });

  // BFS layout
  var levels = [], queue = [{ id: root.peerId, level: 0 }], visited = {};
  while (queue.length > 0) {
    var item = queue.shift();
    if (visited[item.id]) continue; visited[item.id] = true;
    if (!levels[item.level]) levels[item.level] = [];
    levels[item.level].push(item.id);
    var nd = nodeMap[item.id];
    if (nd) nd.children.forEach(function(cid) { queue.push({ id: cid, level: item.level + 1 }); });
  }
  // Add orphans (no parent, not root)
  nodes.forEach(function(n) {
    if (!visited[n.peerId]) {
      if (!levels[levels.length]) levels.push([]);
      levels[levels.length - 1].push(n.peerId);
      visited[n.peerId] = true;
    }
  });

  var levelH = Math.min(80, (H - 60) / Math.max(levels.length, 1)), nodeRadius = 20;
  levels.forEach(function(ids, lvl) {
    var y = 40 + lvl * levelH, spacing = W / (ids.length + 1);
    ids.forEach(function(id, i) { var nd = nodeMap[id]; if (nd) { nd.x = spacing * (i + 1); nd.y = y; } });
  });

  // Draw primary edges with link-type colors
  nodes.forEach(function(n) {
    if (n.parentId && nodeMap[n.parentId] && nodeMap[n.peerId]) {
      var p = nodeMap[n.parentId], ch = nodeMap[n.peerId];
      var li = linkInfo.get(n.peerId);
      var lt = li ? li.linkType : LINK_UNKNOWN;
      ctx.strokeStyle = LINK_COLORS[lt] || '#555';
      ctx.lineWidth = lt === LINK_LOCAL ? 3 : 2;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y + nodeRadius); ctx.lineTo(ch.x, ch.y - nodeRadius); ctx.stroke();
      // Edge label: link type + subnet + candidate types
      if (li) {
        var mx = (p.x + ch.x) / 2, my = (p.y + ch.y) / 2;
        ctx.fillStyle = LINK_COLORS[lt] || '#888'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var edgeLabel = lt;
        if (li.candidateType) edgeLabel += ' ' + li.candidateType;
        ctx.fillText(edgeLabel, mx + 5, my - 6);
        // Subnet line
        if (li.remoteSubnet && li.remoteSubnet !== '?') {
          ctx.fillStyle = '#666'; ctx.font = '8px sans-serif';
          ctx.fillText(li.remoteSubnet, mx + 5, my + 5);
        }
      }
    }
  });

  // Draw backup edges (dashed, colored by link type)
  nodes.forEach(function(n) {
    var bpIds = n.backupParentIds || [];
    bpIds.forEach(function(bpId) {
      if (nodeMap[bpId] && nodeMap[n.peerId]) {
        var bp = nodeMap[bpId], ch = nodeMap[n.peerId];
        var li = linkInfo.get(bpId);
        var lt = li ? li.linkType : LINK_UNKNOWN;
        ctx.strokeStyle = (LINK_COLORS[lt] || '#f90') + '88';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(bp.x, bp.y + nodeRadius); ctx.lineTo(ch.x, ch.y - nodeRadius); ctx.stroke();
        // Backup edge label (smaller, offset to avoid overlap)
        if (li) {
          var mx = (bp.x + ch.x) / 2, my = (bp.y + ch.y) / 2;
          ctx.fillStyle = (LINK_COLORS[lt] || '#888') + 'aa'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(lt + (li.candidateType ? ' ' + li.candidateType : ''), mx - 5, my - 4);
        }
      }
    });
  });
  ctx.setLineDash([]);

  // Draw nodes
  nodes.forEach(function(n) {
    var nd = nodeMap[n.peerId]; if (!nd) return;
    var color = '#3498db';
    if (n.role === 'publisher') color = '#e94560';
    else if (nd.children.length > 0) color = '#27ae60';
    if (!n.isReady && n.role !== 'publisher') color = '#f39c12';

    ctx.beginPath(); ctx.arc(nd.x, nd.y, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = color + '33'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

    // Link type indicator ring
    var li = linkInfo.get(n.peerId);
    if (li && li.linkType !== LINK_UNKNOWN) {
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nodeRadius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = LINK_COLORS[li.linkType] + '66'; ctx.lineWidth = 1; ctx.stroke();
    }

    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var icon = n.role === 'publisher' ? '📡' : (nd.children.length > 0 ? '🔁' : '👤');
    ctx.fillText(icon, nd.x, nd.y);
    ctx.fillStyle = '#aaa'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top';
    var label = n.nickname || n.peerId.substring(0, 6);
    var meTag = n.peerId === myPeerId ? ' (我)' : '';
    ctx.fillText(label + meTag, nd.x, nd.y + nodeRadius + 4);
    // RTT label
    if (li && li.rtt > 0) {
      ctx.fillStyle = li.rtt > 500 ? '#f33' : '#888';
      ctx.font = '9px sans-serif';
      ctx.fillText(Math.round(li.rtt) + 'ms', nd.x, nd.y + nodeRadius + 16);
    }
  });

  canvas._nodes = nodeMap;
}

// Click on canvas node for detail
document.addEventListener('click', function(e) {
  var canvas = document.getElementById('topoCanvas'), detail = document.getElementById('nodeDetail');
  if (!canvas || !canvas._nodes) { if (detail) detail.style.display = 'none'; return; }
  if (e.target !== canvas) { if (detail) detail.style.display = 'none'; return; }
  var rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, found = null;
  for (var id in canvas._nodes) {
    var nd = canvas._nodes[id], dx = nd.x - x, dy = nd.y - y;
    if (Math.sqrt(dx * dx + dy * dy) < 24) { found = nd; break; }
  }
  if (!found) { if (detail) detail.style.display = 'none'; return; }
  detail.style.display = ''; detail.style.left = (e.clientX + 10) + 'px'; detail.style.top = (e.clientY + 10) + 'px';
  document.getElementById('nodeDetailTitle').textContent = found.role === 'publisher' ? t('publisherNode') : t('viewerNode');
  var ns = topologyMap.get(found.id);
  var li = linkInfo.get(found.id);
  var conn = findConnByPeer(found.id);
  var iceState = conn ? conn.iceState : 'N/A';
  var statsHtml = '';
  if (conn && conn.stats && conn.stats.rtt) {
    statsHtml = '<div class="detail-row">RTT: <span>' + Math.round(conn.stats.rtt) + 'ms</span></div>' +
      '<div class="detail-row">' + t('detailLoss') + ': <span>' + (conn.stats.packetLoss || 0) + '</span></div>';
  }
  document.getElementById('nodeDetailBody').innerHTML =
    '<div class="detail-row">Peer ID: <span>' + found.id.substring(0, 12) + '...</span></div>' +
    '<div class="detail-row">' + t('detailNickname') + ': <span>' + escHtml(found.nickname || 'N/A') + '</span></div>' +
    '<div class="detail-row">' + t('detailParent') + ': <span>' + (found.parentId ? peerTag(found.parentId) : t('noParent')) + '</span></div>' +
    '<div class="detail-row">' + t('detailBackupParent') + ': <span>' + (found.backupParentIds && found.backupParentIds.length > 0 ? found.backupParentIds.map(peerTag).join(', ') : t('none')) + '</span></div>' +
    '<div class="detail-row">' + t('detailChildren') + ': <span>' + found.children.length + '</span></div>' +
    '<div class="detail-row">' + t('detailFanout') + ': <span>' + (ns ? ns.fanoutAvailable : 'N/A') + '</span></div>' +
    '<div class="detail-row">ICE: <span>' + iceState + '</span></div>' +
    '<div class="detail-row">' + t('detailLink') + ': <span>' + (li ? li.linkType + ' (' + Math.round(li.rtt || 0) + 'ms)' : 'N/A') + '</span></div>' +
    '<div class="detail-row">' + t('detailCandidate') + ': <span>' + (li ? li.candidateType : 'N/A') + '</span></div>' +
    '<div class="detail-row">' + t('detailLocal') + ': <span>' + (li && li.localAddr ? li.localAddr + ':' + li.localPort + '/' + li.localProto : 'N/A') + '</span></div>' +
    '<div class="detail-row">' + t('detailRemote') + ': <span>' + (li && li.remoteAddr ? li.remoteAddr + ':' + li.remotePort + '/' + li.remoteProto : 'N/A') + '</span></div>' +
    '<div class="detail-row">' + t('detailSubnet') + ': <span>' + (li && li.localSubnet ? li.localSubnet + (li.localSubnet === li.remoteSubnet ? ' (' + t('same') + ')' : ' → ' + li.remoteSubnet) : 'N/A') + '</span></div>' +
    '<div class="detail-row">' + t('detailReady') + ': <span>' + (ns && ns.isReady ? '✅' : '⏳') + '</span></div>' +
    statsHtml;
});

// ============================================================
// Cleanup
// ============================================================
function cleanup() {
  periodicTimers.forEach(function(t) { clearInterval(t); });
  periodicTimers = [];
  connections.forEach(function(conn) { conn.pc.close(); });
  connections.clear();
  pendingConnects.clear();
  topologyMap.clear();
  linkInfo.clear();
  if (localStream) { localStream.getTracks().forEach(function(t) { t.stop(); }); localStream = null; }
  receivedStream = null; primaryParentId = null; backupParents = [];
  currentRoomId = null; currentRoomPwd = null;
  if (socket) { socket.disconnect(); socket = null; }
  myRole = null; myPeerId = null; myNodeState = null;
  isJoining = false; // Reset join flag
  failoverInProgress = false; // Reset failover flag
}

window.addEventListener('resize', function() {
  if (document.getElementById('tab-topology').classList.contains('active')) drawTopology();
});

// ============================================================
// Copy Invite Link
// ============================================================
function copyInviteLink() {
  if (!currentRoomId) return;
  var url = location.origin + location.pathname + '?room=' + encodeURIComponent(currentRoomId);
  if (currentRoomPwd) url += '&pwd=' + encodeURIComponent(currentRoomPwd);
  if (currentLang === 'en') url += '&lang=en';
  navigator.clipboard.writeText(url).then(function() {
    log('Invite link copied: ' + url);
    showToast(t('inviteCopied'));
  }).catch(function() {
    prompt(t('inviteCopyPrompt'), url);
  });
}

function showToast(msg) {
  var el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#27ae60;color:#fff;padding:10px 24px;border-radius:8px;font-size:14px;z-index:9999;opacity:0;transition:opacity .3s';
  document.body.appendChild(el);
  requestAnimationFrame(function() { el.style.opacity = '1'; });
  setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, 2000);
}

// ============================================================
// Direct Join via URL Parameters (mobile sharing)
// ============================================================
// URL format: ?room=room1            — auto-join as viewer
//             ?room=room1&pwd=123    — auto-join with password
//             ?room=room1&nick=Tom   — auto-join with custom nickname
// Auto-generates a viewer name like "观众A3K7" if nick is not provided.
// ============================================================
(function autoJoinFromUrl() {
  var params = new URLSearchParams(window.location.search);
  var room = params.get('room');
  if (!room) return;

  var pwd = params.get('pwd') || '';
  var nick = params.get('nick') || (t('defaultViewer') + Math.floor(Math.random() * 10000));

  // Fill form fields so the rest of the flow works normally
  document.getElementById('joinRoomInput').value = room;
  document.getElementById('joinPassword').value = pwd;
  document.getElementById('viewerNickname').value = nick;

  // Auto-join after a short delay to let socket.io script load
  setTimeout(function() {
    log('通过链接直接加入: room=' + room + ' nick=' + nick);
    joinAsViewer();
  }, 300);
})();
