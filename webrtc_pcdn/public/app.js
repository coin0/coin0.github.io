'use strict';
// ============================================================
// State
// ============================================================
var socket = null;
var myPeerId = null;
var myRole = null;
var myNickname = '';
var localStream = null;
var cameraStream = null;
var primaryParentId = null;
var backupParentId = null;
var isScreenSharing = false;
var currentTopology = { nodes: [], publisherOffline: false };
var serverIceConfig = null;
var currentRoomId = null;    // track room for auto-rejoin
var currentRoomPwd = null;   // track password for auto-rejoin

// connections keyed by "peerId:role" to support multiple connections to same peer
// e.g. "abc123:primary", "abc123:child", "abc123:backup"
var connections = new Map();
var receivedStream = null;

// Track pending outgoing connections to prevent duplicate offers
var pendingConnects = new Set(); // stores "peerId:role" keys

var seenMsgIds = new Set();
function markSeen(id) { seenMsgIds.add(id); if (seenMsgIds.size > 200) seenMsgIds.delete(seenMsgIds.values().next().value); }

// Connection key helpers
function connKey(peerId, role) { return peerId + ':' + role; }
function getConn(peerId, role) { return connections.get(connKey(peerId, role)); }
function setConn(peerId, role, ci) { connections.set(connKey(peerId, role), ci); }
function deleteConn(peerId, role) { connections.delete(connKey(peerId, role)); }
// Find any connection to a peer (for ICE status display etc)
function findConnByPeer(peerId) {
  var found = null;
  connections.forEach(function(ci, key) { if (key.indexOf(peerId + ':') === 0 && !found) found = ci; });
  return found;
}

// ============================================================
// ICE Config — merge server config with user overrides
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
  // Keep log area from growing unbounded — trim old entries
  while (area.childNodes.length > 500) area.removeChild(area.firstChild);
  area.parentElement.scrollTop = area.parentElement.scrollHeight;
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
function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function showReconnectOverlay(show) {
  var el = document.getElementById('reconnectOverlay');
  if (el) el.style.display = show ? 'flex' : 'none';
  var el2 = document.getElementById('pubReconnectOverlay');
  if (el2) el2.style.display = show ? 'flex' : 'none';
}

// ============================================================
// Socket
// ============================================================
function initSocket() {
  if (socket) return;
  socket = io();
  socket.on('connect', function() {
    log('已连接信令服务器 id=' + socket.id);
    // If we were already in a room, this is a reconnect (e.g. wifi→cellular)
    // Need to rejoin because server lost our old socket state
    if (myRole && currentRoomId) {
      log('检测到信令重连，自动重新加入房间 room='+currentRoomId+' role='+myRole, 'warn');
      autoRejoin();
    }
  });
  socket.on('signal', async function(d) { try { await handleSignal(d.fromId, d.data); } catch(e) { log('信令错误: '+e.message,'error'); } });
  socket.on('topologyUpdate', function(data) { currentTopology = data; drawTopology(); updateIceStatusUI(); });
  socket.on('roomList', function(list) { renderRoomList(list); });
  socket.on('roomStats', function(s) {
    document.getElementById('statsBar').style.display = '';
    document.getElementById('statViewers').textContent = s.viewerCount + (s.publisherOffline ? ' (主播离线)' : '');
    document.getElementById('statDepth').textContent = s.treeDepth;
    document.getElementById('statSaved').textContent = s.bandwidth.savedPercent + '%';
    document.getElementById('statPcdn').textContent = s.bandwidth.pcdn;
  });
  socket.on('roomClosed', function() { log('房间已关闭','warn'); alert('直播已结束'); cleanup(); switchTab('lobby'); });
  socket.on('publisherOffline', function(d) {
    log('主播暂时离线，等待重连 ('+Math.round(d.graceMs/1000)+'秒)','warn');
    var el = document.getElementById('viewerStatus');
    if (el && el.innerHTML.indexOf('⚠️') === -1) el.innerHTML += ' <span style="color:#f90">⚠️ 主播离线，等待重连...</span>';
  });
  socket.on('publisherReconnected', function(d) {
    log('主播已重连 '+d.newPublisherId.substring(0,8));
    var el = document.getElementById('viewerStatus');
    if (el) el.innerHTML = el.innerHTML.replace(/<span style="color:#f90">.*?<\/span>/, '');
  });
  socket.on('reassign', async function(d) {
    log('收到reassign: newParent='+(d.newParentId||'无')+' backup='+(d.backupParentId||'无')+' 原因:'+(d.reason||''),'warn');
    log('reassign前状态: primaryParentId='+(primaryParentId||'无')+' backupParentId='+(backupParentId||'无')+' conns='+connections.size);
    showReconnectOverlay(true);
    resetHealthState();
    // Close ALL parent connections (primary + backup), not just current IDs
    // This handles stale connections from previous parents
    var toClose = [];
    connections.forEach(function(conn, key) {
      if (conn.role === 'primary' || conn.role === 'backup') toClose.push(key);
    });
    toClose.forEach(function(key) {
      var conn = connections.get(key);
      if (conn) { conn.pc.close(); connections.delete(key); }
      pendingConnects.delete(key);
    });
    primaryParentId = null; backupParentId = null;
    receivedStream = null;
    if (!d.newParentId) { showReconnectOverlay(false); return; }
    primaryParentId = d.newParentId;
    await connectToParent(primaryParentId, 'primary');
    if (d.backupParentId) { backupParentId = d.backupParentId; await connectToParent(backupParentId, 'backup'); }
  });
  socket.on('promoteBackupToPrimary', async function(d) {
    log('收到promoteBackupToPrimary: newPrimaryId='+d.newPrimaryId.substring(0,8)+' 当前primary='+(primaryParentId||'无')+' 当前backup='+(backupParentId||'无'));

    // Close the old primary connection first (it's dead anyway)
    if (primaryParentId && primaryParentId !== d.newPrimaryId) {
      log('关闭旧主连接: '+primaryParentId.substring(0,8));
      closeConnByRole(primaryParentId, 'primary');
    }

    var bc = getConn(d.newPrimaryId, 'backup');
    log('查找备用连接: key='+connKey(d.newPrimaryId,'backup')+' found='+(!!bc)+' bcRole='+(bc?bc.role:'N/A')+' bcIce='+(bc?bc.iceState:'N/A')+' bcStream='+(bc&&bc.stream?bc.stream.getTracks().length+'tracks':'null'));
    resetHealthState();
    if (bc && bc.role === 'backup') {
      // Re-key: delete backup key, set as primary key
      deleteConn(d.newPrimaryId, 'backup');
      pendingConnects.delete(connKey(d.newPrimaryId, 'backup'));
      bc.role = 'primary';
      setConn(d.newPrimaryId, 'primary', bc);
      // Mark as NOT pending — this connection is already established
      pendingConnects.delete(connKey(d.newPrimaryId, 'primary'));
      primaryParentId = d.newPrimaryId; backupParentId = null;
      if (bc.stream && bc.stream.getTracks().length > 0) {
        receivedStream = bc.stream;
        showRemoteVideo(d.newPrimaryId, receivedStream);
        replaceTracksOnChildren(receivedStream);
        showReconnectOverlay(false);
        log('无缝切换完成');
      } else {
        log('备用连接无流数据，重新建立主连接','warn');
        bc.pc.close(); deleteConn(d.newPrimaryId, 'primary');
        await connectToParent(d.newPrimaryId, 'primary');
      }
      socket.emit('requestBackup', function(res) {
        log('requestBackup回调: backupParentId='+(res&&res.backupParentId?res.backupParentId.substring(0,8):'无')+' 当前backupParentId='+(backupParentId||'无'));
        if (res && res.backupParentId) {
          // Only connect if backupReassign hasn't already set this up
          if (!backupParentId || backupParentId !== res.backupParentId) {
            backupParentId = res.backupParentId;
            connectToParent(backupParentId, 'backup');
          } else {
            log('requestBackup返回与当前备用相同: ' + res.backupParentId.substring(0,8), 'warn');
          }
        }
      });
    } else {
      primaryParentId = d.newPrimaryId;
      await connectToParent(d.newPrimaryId, 'primary');
    }
  });
  socket.on('backupReassign', async function(d) {
    log('收到backupReassign: newBackupId='+(d.newBackupId?d.newBackupId.substring(0,8):'无')+' 当前backupParentId='+(backupParentId||'无'));
    // If we already have a pending or active backup to this same peer, skip
    if (d.newBackupId && d.newBackupId === backupParentId) {
      var existingBackup = getConn(d.newBackupId, 'backup');
      var isPending = pendingConnects.has(connKey(d.newBackupId, 'backup'));
      if (existingBackup || isPending) {
        log('跳过backupReassign(已有连接='+!!existingBackup+' 待连接='+isPending+'): ' + d.newBackupId.substring(0,8), 'warn');
        return;
      }
    }
    if (backupParentId && backupParentId !== d.newBackupId) { closeConnByRole(backupParentId, 'backup'); }
    backupParentId = d.newBackupId;
    if (d.newBackupId) { log('新备用节点: '+d.newBackupId.substring(0,8)); await connectToParent(d.newBackupId, 'backup'); }
  });
  socket.on('chatMessage', function(msg) { if (msg.id && seenMsgIds.has(msg.id)) return; if (msg.id) markSeen(msg.id); appendChatMessage(msg); });
  socket.on('reaction', function(d) { showReactionFloat(d.emoji); });
  socket.on('qualityWarning', function(d) { log('质量告警: RTT='+Math.round(d.rtt)+'ms 丢包='+d.packetLoss+'% - '+d.suggestion,'warn'); });
  socket.on('disconnect', function() { log('信令断开','error'); });
}

function closeConnByRole(peerId, role) {
  var ci = getConn(peerId, role);
  if (ci) { ci.pc.close(); deleteConn(peerId, role); }
  pendingConnects.delete(connKey(peerId, role));
}

// ============================================================
// Auto-rejoin after socket reconnect (e.g. network switch)
// ============================================================
function closeAllPeerConnections() {
  connections.forEach(function(conn) { try { conn.pc.close(); } catch(e){} });
  connections.clear();
  pendingConnects.clear();
  receivedStream = null;
  primaryParentId = null;
  backupParentId = null;
  resetHealthState();
}

function autoRejoin() {
  var savedRole = myRole;
  var savedRoom = currentRoomId;
  var savedPwd = currentRoomPwd;
  var savedNick = myNickname;

  // Tear down all old WebRTC connections (they're dead anyway)
  closeAllPeerConnections();
  showReconnectOverlay(true);

  if (savedRole === 'publisher') {
    // Publisher rejoin — use createRoom which handles reconnect via grace period
    socket.emit('createRoom', {
      roomId: savedRoom,
      title: document.getElementById('roomTitle').value.trim(),
      password: savedPwd,
      nickname: savedNick
    }, function(res) {
      if (res.error) {
        log('主播重连失败: ' + res.error, 'error');
        showReconnectOverlay(false);
        return;
      }
      myPeerId = res.peerId;
      myRole = 'publisher';
      if (res.iceConfig) serverIceConfig = res.iceConfig;
      log('主播重连成功 room=' + savedRoom + (res.reconnected ? ' (恢复)' : ' (新建)'));
      document.getElementById('publisherStatus').innerHTML = '房间: <span>' + savedRoom + '</span> | <span>' + savedNick + '</span>';
      showReconnectOverlay(false);
      updateIceStatusUI();
    });
  } else if (savedRole === 'viewer') {
    // Viewer rejoin
    socket.emit('joinRoom', {
      roomId: savedRoom,
      password: savedPwd,
      nickname: savedNick
    }, async function(res) {
      if (res.error) {
        log('观众重连失败: ' + res.error, 'error');
        showReconnectOverlay(false);
        return;
      }
      myPeerId = res.peerId;
      myRole = 'viewer';
      primaryParentId = res.parentId;
      backupParentId = res.backupParentId || null;
      if (res.iceConfig) serverIceConfig = res.iceConfig;
      log('观众重连成功 room=' + savedRoom + ' 主:' + res.parentId.substring(0, 8) + (backupParentId ? ' 备:' + backupParentId.substring(0, 8) : ''));
      document.getElementById('viewerStatus').innerHTML = '<span>' + savedNick + '</span> | 主: <span>' + res.parentId.substring(0, 8) + '</span>' + (backupParentId ? ' | 备: <span>' + backupParentId.substring(0, 8) + '</span>' : '');
      await connectToParent(primaryParentId, 'primary');
      if (backupParentId) await connectToParent(backupParentId, 'backup');
      showReconnectOverlay(false);
    });
  }
}

// ============================================================
// Publisher
// ============================================================
async function startPublish() {
  var roomId = document.getElementById('roomIdInput').value.trim();
  if (!roomId) return alert('请输入房间号');
  myNickname = document.getElementById('pubNickname').value.trim() || '主播';
  initSocket();
  try {
    localStream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
    cameraStream = localStream;
    document.getElementById('localVideo').srcObject = localStream;
    log('已获取本地音视频流');
  } catch(e) { log('获取媒体失败: '+e.message,'error'); return; }

  socket.emit('createRoom', { roomId: roomId, title: document.getElementById('roomTitle').value.trim(), password: document.getElementById('roomPassword').value, nickname: myNickname }, function(res) {
    if (res.error) return log('创建房间失败: '+res.error,'error');
    myPeerId = res.peerId; myRole = 'publisher';
    currentRoomId = roomId;
    currentRoomPwd = document.getElementById('roomPassword').value;
    if (res.iceConfig) serverIceConfig = res.iceConfig;
    log('房间 '+roomId+' 创建成功'+(res.reconnected?' (重连)':''));
    document.getElementById('publisherArea').style.display = '';
    document.getElementById('noLiveArea').style.display = 'none';
    document.getElementById('publisherStatus').innerHTML = '房间: <span>'+roomId+'</span> | <span>'+myNickname+'</span>';
    switchTab('live');
  });
}
function stopPublish() { cleanup(); location.reload(); }
function getMediaConstraints() {
  var r = document.getElementById('resolutionSelect').value, fps = parseInt(document.getElementById('fpsSelect').value), v = {};
  if (r==='720'){v.width={ideal:1280};v.height={ideal:720};} else if(r==='1080'){v.width={ideal:1920};v.height={ideal:1080};}
  v.frameRate = {ideal:fps}; return {video:v,audio:true};
}

// ============================================================
// Screen Share
// ============================================================
var savedCameraTrack = null;

async function toggleScreenShare() {
  if (isScreenSharing) { stopScreenShare(); return; }
  try {
    var ss = await navigator.mediaDevices.getDisplayMedia({video:{cursor:'always'},audio:false});
    var st = ss.getVideoTracks()[0];
    savedCameraTrack = localStream.getVideoTracks()[0];
    connections.forEach(function(conn) { if(conn.role==='child'){var s=conn.pc.getSenders().find(function(x){return x.track&&x.track.kind==='video';}); if(s) s.replaceTrack(st);} });
    localStream.removeTrack(savedCameraTrack);
    localStream.addTrack(st);
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('localVideo').srcObject = localStream;
    st.onended = function(){stopScreenShare();}; isScreenSharing = true;
    document.getElementById('screenShareBanner').style.display = '';
    document.getElementById('btnScreenShare').textContent = '📷 恢复摄像头';
    log('已开始屏幕共享');
  } catch(e) { log('屏幕共享失败: '+e.message,'error'); }
}
async function stopScreenShare() {
  if (!isScreenSharing) return;
  var screenTrack = localStream.getVideoTracks()[0];
  if (screenTrack) { screenTrack.stop(); localStream.removeTrack(screenTrack); }
  var camTrack = savedCameraTrack;
  if (!camTrack || camTrack.readyState === 'ended') {
    try { var nc = await navigator.mediaDevices.getUserMedia({video:getMediaConstraints().video}); camTrack = nc.getVideoTracks()[0]; }
    catch(e) { log('恢复摄像头失败: '+e.message,'error'); isScreenSharing = false; return; }
  }
  localStream.addTrack(camTrack);
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('localVideo').srcObject = localStream;
  connections.forEach(function(conn) { if(conn.role==='child'){var s=conn.pc.getSenders().find(function(x){return x.track&&x.track.kind==='video';}); if(s) s.replaceTrack(camTrack);} });
  savedCameraTrack = null; isScreenSharing = false;
  document.getElementById('screenShareBanner').style.display = 'none';
  document.getElementById('btnScreenShare').textContent = '🖥️ 共享屏幕';
  log('已停止屏幕共享');
}
async function changeResolution() {
  if (myRole!=='publisher'||!localStream) return;
  var vt = localStream.getVideoTracks()[0];
  if (vt&&!isScreenSharing) { try{await vt.applyConstraints(getMediaConstraints().video);log('分辨率已调整');}catch(e){log('调整失败: '+e.message,'warn');} }
}

// ============================================================
// Viewer
// ============================================================
async function joinAsViewer() {
  var roomId = document.getElementById('joinRoomInput').value.trim();
  if (!roomId) return alert('请输入房间号');
  myNickname = document.getElementById('viewerNickname').value.trim() || ('观众'+Math.floor(Math.random()*1000));
  initSocket();
  socket.emit('joinRoom', { roomId:roomId, password:document.getElementById('joinPassword').value, nickname:myNickname }, async function(res) {
    if (res.error) return log('加入失败: '+res.error,'error');
    myPeerId = res.peerId; myRole = 'viewer'; primaryParentId = res.parentId; backupParentId = res.backupParentId||null;
    currentRoomId = roomId;
    currentRoomPwd = document.getElementById('joinPassword').value;
    if (res.iceConfig) serverIceConfig = res.iceConfig;
    log('已加入 '+roomId+' 主:'+res.parentId.substring(0,8)+(backupParentId?' 备:'+backupParentId.substring(0,8):''));
    document.getElementById('viewerArea').style.display = '';
    document.getElementById('noLiveArea').style.display = 'none';
    document.getElementById('viewerStatus').innerHTML = '<span>'+myNickname+'</span> | 主: <span>'+res.parentId.substring(0,8)+'</span>'+(backupParentId?' | 备: <span>'+backupParentId.substring(0,8)+'</span>':'');
    if (res.chatHistory) res.chatHistory.forEach(function(m){appendChatMessage(m);});
    if (res.publisherOffline) log('主播当前离线，等待重连...','warn');
    switchTab('live');
    await connectToParent(primaryParentId, 'primary');
    if (backupParentId) await connectToParent(backupParentId, 'backup');
  });
}
function leaveRoom() { cleanup(); location.reload(); }

// ============================================================
// Replace tracks on all child connections (after failover)
// ============================================================
function replaceTracksOnChildren(newStream) {
  if (!newStream) return;
  connections.forEach(function(conn) {
    if (conn.role !== 'child') return;
    var senders = conn.pc.getSenders();
    newStream.getTracks().forEach(function(track) {
      var sender = senders.find(function(s) { return s.track && s.track.kind === track.kind; });
      if (sender) { sender.replaceTrack(track).catch(function(e) { log('替换子节点轨道失败: '+e.message,'warn'); }); }
    });
  });
}

// ============================================================
// WebRTC: Connect to parent (primary or backup)
// ============================================================
async function connectToParent(targetId, role) {
  var key = connKey(targetId, role);

  // If we already have a pending connect for this exact peer+role, skip
  if (pendingConnects.has(key)) {
    log('跳过重复连接请求: ' + targetId.substring(0, 8) + ' role=' + role, 'warn');
    return;
  }

  // If existing connection is already connected/completed, skip
  var existing = getConn(targetId, role);
  if (existing) {
    var existingIce = existing.pc.iceConnectionState;
    var existingSig = existing.pc.signalingState;
    if (existingIce === 'connected' || existingIce === 'completed') {
      log('跳过连接(已连接): ' + targetId.substring(0, 8) + ' role=' + role + ' ice=' + existingIce, 'warn');
      return;
    }
    // Also skip if signaling is stable (answer already set) and ICE is checking
    if (existingSig === 'stable' && (existingIce === 'checking' || existingIce === 'new')) {
      log('跳过连接(信令已完成,等待ICE): ' + targetId.substring(0, 8) + ' role=' + role + ' ice=' + existingIce + ' sig=' + existingSig, 'warn');
      return;
    }
    log('关闭旧连接并重建: ' + targetId.substring(0, 8) + ' role=' + role + ' ice=' + existingIce + ' sig=' + existingSig, 'warn');
    existing.pc.close();
    deleteConn(targetId, role);
  }

  pendingConnects.add(key);
  var config = getIceConfig();
  var pc = new RTCPeerConnection(config);
  var ci = { pc:pc, role:role, dc:null, iceState:'new', stats:{}, stream:null, peerId:targetId, createdAt:Date.now() };
  setConn(targetId, role, ci);
  pc.addTransceiver('video',{direction:'recvonly'}); pc.addTransceiver('audio',{direction:'recvonly'});
  var dc = pc.createDataChannel('chat',{ordered:true}); ci.dc = dc;
  dc.onopen = function(){log('DataChannel('+role+') 打开');};
  dc.onmessage = function(e){handleDcMessage(JSON.parse(e.data),targetId);};
  pc.onicecandidate = function(e){ if(e.candidate) socket.emit('signal',{targetId:targetId,data:{type:'candidate',candidate:e.candidate,connRole:role}}); };
  pc.oniceconnectionstatechange = function(){
    ci.iceState = pc.iceConnectionState;
    log('ICE('+role+') '+targetId.substring(0,8)+': '+pc.iceConnectionState);
    updateIceStatusUI();
    // Clear pending flag once connection settles
    if (pc.iceConnectionState==='connected'||pc.iceConnectionState==='completed'||pc.iceConnectionState==='failed'||pc.iceConnectionState==='closed') {
      pendingConnects.delete(key);
    }
    if (pc.iceConnectionState==='failed'){log('ICE失败，重启...','warn');pc.restartIce();}
    if (role==='primary'&&(pc.iceConnectionState==='connected'||pc.iceConnectionState==='completed')) showReconnectOverlay(false);
  };
  pc.ontrack = function(e){
    log('收到轨道('+role+'): '+e.track.kind+' from '+targetId.substring(0,8));
    var remoteStream = (e.streams && e.streams[0]) ? e.streams[0] : null;
    if (remoteStream) { ci.stream = remoteStream; }
    else { if (!ci.stream) ci.stream = new MediaStream(); ci.stream.addTrack(e.track); }
    if (role==='primary') {
      receivedStream = ci.stream; showRemoteVideo(targetId, receivedStream);
      replaceTracksOnChildren(receivedStream);
      if (ci.stream.getVideoTracks().length>0 && ci.stream.getAudioTracks().length>0) { socket.emit('peerReady'); log('已标记为可转发节点'); }
    }
  };
  var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  // Include connRole so the remote side can tag the answer correctly
  socket.emit('signal',{targetId:targetId,data:{type:'offer',sdp:pc.localDescription,connRole:role}});
  log('发送 offer('+role+') -> '+targetId.substring(0,8)+' [key='+key+', sigState='+pc.signalingState+', pending='+pendingConnects.size+', conns='+connections.size+']');
}

// ============================================================
// WebRTC: Handle signals
// ============================================================
async function handleSignal(fromId, data) {
  if (data.type==='offer') {
    // Someone is connecting to us as a child — they want to pull our stream
    // The connRole in the offer tells us what role THEY are playing (primary/backup)
    // From our perspective, they are a 'child'. Use their connRole to disambiguate.
    var childTag = data.connRole || 'primary'; // what role the requester plays
    var ourKey = 'child-' + childTag; // e.g. "child-primary" or "child-backup"
    log('收到 offer from '+fromId.substring(0,8)+' (我是父节点, 对方角色:'+childTag+', key='+connKey(fromId,ourKey)+')');

    // Close any existing connection with same key
    var existingChild = getConn(fromId, ourKey);
    if (existingChild) {
      log('关闭旧子连接: '+connKey(fromId,ourKey)+' iceState='+existingChild.iceState, 'warn');
      existingChild.pc.close(); deleteConn(fromId, ourKey);
    }

    var config = getIceConfig(); var pc = new RTCPeerConnection(config);
    var ci = {pc:pc, role:'child', dc:null, iceState:'new', stats:{}, peerId:fromId, childTag:childTag};
    setConn(fromId, ourKey, ci);
    pc.onicecandidate = function(e){ if(e.candidate) socket.emit('signal',{targetId:fromId,data:{type:'candidate',candidate:e.candidate,connRole:ourKey}}); };
    pc.oniceconnectionstatechange = function(){ ci.iceState=pc.iceConnectionState; log('ICE(子-'+childTag+') '+fromId.substring(0,8)+': '+pc.iceConnectionState); updateIceStatusUI(); };
    pc.ondatachannel = function(e){ ci.dc=e.channel; e.channel.onmessage=function(ev){handleDcMessage(JSON.parse(ev.data),fromId);}; };
    var stream = myRole==='publisher'?localStream:receivedStream;
    if (stream && stream.getTracks().length > 0) { stream.getTracks().forEach(function(t){pc.addTrack(t,stream);}); log('添加 '+stream.getTracks().length+' 轨道 -> '+fromId.substring(0,8)); }
    else { log('无可发送流 -> '+fromId.substring(0,8),'warn'); }
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    var answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    log('发送 answer -> '+fromId.substring(0,8)+' connRole='+childTag+' [sigState='+pc.signalingState+']');
    socket.emit('signal',{targetId:fromId,data:{type:'answer',sdp:pc.localDescription,connRole:childTag}});
  } else if (data.type==='answer') {
    // Answer for our outgoing connection — connRole tells us which of our connections this is for
    var role = data.connRole || 'primary';
    var c = getConn(fromId, role);
    log('收到 answer from '+fromId.substring(0,8)+' connRole='+role+' 查找key='+connKey(fromId,role)+' found='+(!!c)+' sigState='+(c?c.pc.signalingState:'N/A'));
    if (c) {
      // Guard: only set remote answer if we're actually waiting for one
      if (c.pc.signalingState === 'have-local-offer') {
        await c.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        log('设置answer成功: ' + fromId.substring(0,8) + ' role=' + role + ' [sigState='+c.pc.signalingState+']');
      } else {
        log('跳过answer(状态=' + c.pc.signalingState + '): ' + fromId.substring(0,8) + ' role=' + role, 'warn');
      }
    } else {
      // Debug: dump all connection keys to help diagnose
      var allKeys = [];
      connections.forEach(function(ci, key) { allKeys.push(key+'('+ci.pc.signalingState+')'); });
      log('收到answer但找不到连接: '+fromId.substring(0,8)+' role='+role+' 所有连接=['+allKeys.join(', ')+']','warn');
    }
  } else if (data.type==='candidate') {
    // ICE candidate — find the right connection
    var cRole = data.connRole || 'primary';
    var c2 = getConn(fromId, cRole);
    // Also try child keys if not found
    if (!c2) c2 = getConn(fromId, 'child-' + cRole);
    if (!c2) {
      // Fallback: try any connection to this peer
      connections.forEach(function(ci, key) { if (!c2 && key.indexOf(fromId + ':') === 0) c2 = ci; });
    }
    if (c2) { await c2.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
  }
}

// ============================================================
// DataChannel
// ============================================================
function handleDcMessage(msg, fromId) {
  if (msg.type==='chat') { if(seenMsgIds.has(msg.id))return; markSeen(msg.id); appendChatMessage(msg); if(msg.direction==='down')broadcastDc(msg,fromId); }
  else if (msg.type==='reaction') { var rid=msg.id||(msg.from+'-'+msg.emoji+'-'+(msg.ts||0)); if(seenMsgIds.has(rid))return; markSeen(rid); showReactionFloat(msg.emoji); if(msg.direction==='down')broadcastDc(msg,fromId); }
}
function broadcastDc(msg, excludeId) {
  connections.forEach(function(conn, key) {
    if (conn.role==='child' && conn.peerId!==excludeId && conn.dc && conn.dc.readyState==='open') conn.dc.send(JSON.stringify(msg));
  });
}

// ============================================================
// Chat / Reactions
// ============================================================
function sendChat() { var i=document.getElementById('chatInput'),m=i.value.trim(); if(!m||!socket)return; i.value=''; socket.emit('chatMessage',{message:m,nickname:myNickname}); }
function appendChatMessage(msg) {
  var c=document.getElementById('chatMessages');
  if(msg.id&&c.querySelector('[data-id="'+msg.id+'"]'))return;
  var d=document.createElement('div'); d.className='chat-msg'; if(msg.id)d.dataset.id=msg.id;
  d.innerHTML='<span class="nick">'+escHtml(msg.nickname)+'</span><span class="time">'+new Date(msg.timestamp).toLocaleTimeString()+'</span><br>'+escHtml(msg.message);
  c.appendChild(d); c.scrollTop=c.scrollHeight;
}
function sendReaction(emoji) { if(!socket)return; socket.emit('reaction',{emoji:emoji}); showReactionFloat(emoji); }
function showReactionFloat(emoji) {
  var c=document.getElementById('reactionFloat'),el=document.createElement('div');
  el.className='reaction-anim'; el.textContent=emoji; el.style.left=Math.random()*40+'px';
  c.appendChild(el); setTimeout(function(){el.remove();},2000);
}

// ============================================================
// ICE Status UI
// ============================================================
function updateIceStatusUI() {
  // Viewer ICE status (parent connections)
  var c=document.getElementById('iceStatus'); if(c) {
    c.innerHTML='';
    connections.forEach(function(conn, key) {
      if (conn.role === 'child') return; // skip child conns in viewer panel
      var st=conn.iceState||'new',color='#888';
      if(st==='connected'||st==='completed')color='#0f9'; else if(st==='checking'||st==='new')color='#ff0'; else if(st==='failed'||st==='disconnected'||st==='closed')color='#f33';
      var rl=conn.role==='primary'?'↑主':conn.role==='backup'?'↑备':'↓子';
      var pid = conn.peerId || key.split(':')[0];
      var b=document.createElement('div'); b.className='ice-badge'; b.style.background=color+'22'; b.style.color=color;
      b.innerHTML='<span class="dot" style="background:'+color+'"></span>'+rl+' '+pid.substring(0,6)+' '+st;
      if(st==='failed'){var btn=document.createElement('button');btn.className='btn btn-sm btn-warn';btn.textContent='重连';btn.style.marginLeft='4px';btn.onclick=(function(x){return function(){x.pc.restartIce();};})(conn);b.appendChild(btn);}
      c.appendChild(b);
    });
  }

  // Host (publisher) child connection status
  var hc=document.getElementById('hostIceStatus'); if(hc) {
    var childCount = 0;
    var html = '';
    connections.forEach(function(conn, key) {
      if (conn.role !== 'child') return;
      childCount++;
      var st=conn.iceState||'new',color='#888';
      if(st==='connected'||st==='completed')color='#0f9'; else if(st==='checking'||st==='new')color='#ff0'; else if(st==='failed'||st==='disconnected'||st==='closed')color='#f33';
      var pid = conn.peerId || key.split(':')[0];
      var tag = conn.childTag ? '('+conn.childTag+')' : '';
      html += '<div class="ice-badge" style="background:'+color+'22;color:'+color+'"><span class="dot" style="background:'+color+'"></span>↓子 '+pid.substring(0,6)+' '+tag+' '+st+'</div>';
    });
    hc.innerHTML = childCount > 0 ? html : '<span style="color:var(--muted);font-size:12px">暂无子节点</span>';
  }
}

// ============================================================
// Room List / Video UI
// ============================================================
function renderRoomList(list) {
  var c=document.getElementById('roomList');
  if(!list||list.length===0){c.innerHTML='<div style="color:var(--muted);font-size:13px">暂无直播房间</div>';return;}
  c.innerHTML='';
  list.forEach(function(r){
    var card=document.createElement('div'); card.className='room-card';
    var off=r.publisherOffline?' <span style="color:#f90">⚠️离线</span>':'';
    card.innerHTML='<div class="room-title">'+(r.hasPassword?'🔒 ':'')+escHtml(r.title)+off+'</div><div class="room-meta">主播: '+escHtml(r.publisherName)+' · 👥 '+r.viewerCount+' · 🌳 深度'+r.treeDepth+'</div>';
    card.onclick=function(){document.getElementById('joinRoomInput').value=r.roomId;};
    c.appendChild(card);
  });
}
function showRemoteVideo(peerId, stream) {
  var v=document.getElementById('remoteVideo');
  if(!v) return;
  if(v.srcObject!==stream) { v.srcObject=stream; }
  var playPromise = v.play();
  if (playPromise !== undefined) {
    playPromise.catch(function(err) {
      log('视频自动播放被阻止: '+err.message+' (点击页面任意位置恢复)','warn');
      function resumePlay() { v.play().catch(function(){}); document.removeEventListener('touchstart', resumePlay); document.removeEventListener('click', resumePlay); }
      document.addEventListener('touchstart', resumePlay, {once:true});
      document.addEventListener('click', resumePlay, {once:true});
    });
  }
  var btn = document.getElementById('btnUnmute');
  if (btn) btn.textContent = v.muted ? '🔊 开启声音' : '🔇 静音';
  var l=document.getElementById('remoteVideoLabel'); if(l)l.innerHTML='连接自: <span style="color:var(--accent2)">'+peerId.substring(0,8)+'...</span>';
}
function unmuteVideo() {
  var v = document.getElementById('remoteVideo'); if (!v) return;
  v.muted = !v.muted;
  var btn = document.getElementById('btnUnmute');
  if (btn) btn.textContent = v.muted ? '🔊 开启声音' : '🔇 静音';
  if (!v.muted) v.play().catch(function(){});
}

// ============================================================
// Topology Canvas Drawing
// ============================================================
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
  var topo = currentTopology;
  var nodes = topo.nodes || topo;
  if (!nodes || nodes.length === 0) { ctx.fillStyle='#555'; ctx.font='14px sans-serif'; ctx.textAlign='center'; ctx.fillText('暂无拓扑数据',W/2,H/2); return; }
  var root = null;
  for (var ni=0;ni<nodes.length;ni++){if(nodes[ni].isPublisher){root=nodes[ni];break;}} if(!root)return;
  var nodeMap = {};
  nodes.forEach(function(n){nodeMap[n.id]={id:n.id,parentId:n.parentId,backupParentId:n.backupParentId,isPublisher:n.isPublisher,isReady:n.isReady,childCount:n.childCount,nickname:n.nickname,stats:n.stats,children:[],x:0,y:0};});
  nodes.forEach(function(n){if(n.parentId&&nodeMap[n.parentId])nodeMap[n.parentId].children.push(n.id);});
  var levels=[],queue=[{id:root.id,level:0}],visited={};
  while(queue.length>0){var item=queue.shift();if(visited[item.id])continue;visited[item.id]=true;if(!levels[item.level])levels[item.level]=[];levels[item.level].push(item.id);var nd=nodeMap[item.id];if(nd)nd.children.forEach(function(cid){queue.push({id:cid,level:item.level+1});});}
  var levelH=Math.min(80,(H-60)/Math.max(levels.length,1)),nodeRadius=20;
  levels.forEach(function(ids,lvl){var y=40+lvl*levelH,spacing=W/(ids.length+1);ids.forEach(function(id,i){var nd=nodeMap[id];if(nd){nd.x=spacing*(i+1);nd.y=y;}});});
  // Primary edges
  ctx.strokeStyle='#334';ctx.lineWidth=2;
  nodes.forEach(function(n){if(n.parentId&&nodeMap[n.parentId]&&nodeMap[n.id]){var p=nodeMap[n.parentId],ch=nodeMap[n.id];ctx.beginPath();ctx.setLineDash([]);ctx.moveTo(p.x,p.y+nodeRadius);ctx.lineTo(ch.x,ch.y-nodeRadius);ctx.stroke();}});
  // Backup edges (dashed)
  ctx.strokeStyle='#f9044488';ctx.lineWidth=1.5;
  nodes.forEach(function(n){if(n.backupParentId&&nodeMap[n.backupParentId]&&nodeMap[n.id]){var bp=nodeMap[n.backupParentId],ch=nodeMap[n.id];ctx.beginPath();ctx.setLineDash([4,4]);ctx.moveTo(bp.x,bp.y+nodeRadius);ctx.lineTo(ch.x,ch.y-nodeRadius);ctx.stroke();}});
  ctx.setLineDash([]);
  // Nodes
  nodes.forEach(function(n){var nd=nodeMap[n.id];if(!nd)return;var color='#3498db';if(n.isPublisher)color=topo.publisherOffline?'#555':'#e94560';else if(n.childCount>0)color='#27ae60';if(!n.isReady&&!n.isPublisher)color='#f39c12';ctx.beginPath();ctx.arc(nd.x,nd.y,nodeRadius,0,Math.PI*2);ctx.fillStyle=color+'33';ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#fff';ctx.font='14px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';var icon=n.isPublisher?(topo.publisherOffline?'⏸':'📡'):(n.childCount>0?'🔁':'👤');ctx.fillText(icon,nd.x,nd.y);ctx.fillStyle='#aaa';ctx.font='10px sans-serif';ctx.textBaseline='top';var label=n.nickname||n.id.substring(0,6);var meTag=n.id===myPeerId?' (我)':'';ctx.fillText(label+meTag,nd.x,nd.y+nodeRadius+4);if(n.stats&&n.stats.rtt){ctx.fillStyle=n.stats.rtt>500?'#f33':'#888';ctx.font='9px sans-serif';ctx.fillText(Math.round(n.stats.rtt)+'ms',nd.x,nd.y+nodeRadius+16);}});
  canvas._nodes = nodeMap;
}

// Click on canvas node for detail
document.addEventListener('click', function(e) {
  var canvas=document.getElementById('topoCanvas'),detail=document.getElementById('nodeDetail');
  if(!canvas||!canvas._nodes){if(detail)detail.style.display='none';return;}
  if(e.target!==canvas){if(detail)detail.style.display='none';return;}
  var rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,found=null;
  for(var id in canvas._nodes){var nd=canvas._nodes[id],dx=nd.x-x,dy=nd.y-y;if(Math.sqrt(dx*dx+dy*dy)<24){found=nd;break;}}
  if(!found){if(detail)detail.style.display='none';return;}
  detail.style.display='';detail.style.left=(e.clientX+10)+'px';detail.style.top=(e.clientY+10)+'px';
  document.getElementById('nodeDetailTitle').textContent=found.isPublisher?'📡 主播节点':'👤 观众节点';
  var conn=findConnByPeer(found.id),iceState=conn?conn.iceState:'N/A',statsHtml='';
  if(found.stats){statsHtml='<div class="detail-row">RTT: <span>'+(found.stats.rtt?Math.round(found.stats.rtt)+'ms':'N/A')+'</span></div><div class="detail-row">丢包: <span>'+(found.stats.packetLoss!=null?found.stats.packetLoss+'%':'N/A')+'</span></div>';}
  document.getElementById('nodeDetailBody').innerHTML='<div class="detail-row">Peer ID: <span>'+found.id.substring(0,12)+'...</span></div><div class="detail-row">昵称: <span>'+escHtml(found.nickname||'N/A')+'</span></div><div class="detail-row">父节点: <span>'+(found.parentId?found.parentId.substring(0,8):'无 (根)')+'</span></div><div class="detail-row">备用父节点: <span>'+(found.backupParentId?found.backupParentId.substring(0,8):'无')+'</span></div><div class="detail-row">子节点数: <span>'+found.childCount+'</span></div><div class="detail-row">ICE状态: <span>'+iceState+'</span></div><div class="detail-row">就绪: <span>'+(found.isReady?'✅':'⏳')+'</span></div>'+statsHtml;
});

// ============================================================
// Stream health monitoring
// ============================================================
var HEALTH_CHECK_INTERVAL = 3000;
var STALL_THRESHOLD = 3;
var streamHealthState = { prevBytesReceived: 0, stallCount: 0, failoverInProgress: false };
function resetHealthState() { streamHealthState.prevBytesReceived=0; streamHealthState.stallCount=0; streamHealthState.failoverInProgress=false; }

async function checkStreamHealth() {
  if (!socket||!myPeerId||myRole!=='viewer') return;
  if (streamHealthState.failoverInProgress) return;
  var primaryConn = primaryParentId ? getConn(primaryParentId, 'primary') : null;
  if (!primaryConn||!primaryConn.pc||primaryConn.pc.connectionState==='closed') return;
  var iceState=primaryConn.pc.iceConnectionState;
  if (iceState!=='connected'&&iceState!=='completed'){resetHealthState();return;}
  try {
    var stats=await primaryConn.pc.getStats(); var totalBytes=0,hasInbound=false;
    stats.forEach(function(report){if(report.type==='inbound-rtp'&&report.kind==='video'){totalBytes+=report.bytesReceived||0;hasInbound=true;}});
    if(!hasInbound)return;
    if(streamHealthState.prevBytesReceived>0&&totalBytes<=streamHealthState.prevBytesReceived){
      streamHealthState.stallCount++;
      log('流量停滞检测 ('+streamHealthState.stallCount+'/'+STALL_THRESHOLD+') bytes='+totalBytes,'warn');
      if(streamHealthState.stallCount>=STALL_THRESHOLD){log('主连接流量持续停滞，触发故障转移','error');triggerStreamFailover();}
    } else { if(streamHealthState.stallCount>0)streamHealthState.stallCount=0; }
    streamHealthState.prevBytesReceived=totalBytes;
  } catch(e){}
}

async function triggerStreamFailover() {
  if(streamHealthState.failoverInProgress)return;
  streamHealthState.failoverInProgress=true;
  log('触发故障转移: primaryParentId='+(primaryParentId||'无')+' backupParentId='+(backupParentId||'无'),'error');
  showReconnectOverlay(true);
  // Strategy 1: promote backup
  if(backupParentId){
    var backupConn=getConn(backupParentId,'backup');
    log('故障转移检查备用: backupConn='+(!!backupConn)+' iceState='+(backupConn?backupConn.pc.iceConnectionState:'N/A'));
    if(backupConn&&backupConn.pc&&(backupConn.pc.iceConnectionState==='connected'||backupConn.pc.iceConnectionState==='completed')){
      log('故障转移: 提升备用连接 '+backupParentId.substring(0,8)+' 为主连接');
      var oldPrimary=primaryParentId;
      closeConnByRole(oldPrimary,'primary');
      // Re-key backup -> primary
      deleteConn(backupParentId,'backup');
      backupConn.role='primary';
      var newPrimary=backupParentId;
      primaryParentId=newPrimary; backupParentId=null;
      setConn(newPrimary,'primary',backupConn);
      if(backupConn.stream&&backupConn.stream.getTracks().length>0){
        receivedStream=backupConn.stream; showRemoteVideo(newPrimary,receivedStream); replaceTracksOnChildren(receivedStream);
      } else {
        log('备用连接无流数据，重新建立连接','warn');
        backupConn.pc.close(); deleteConn(newPrimary,'primary');
        await connectToParent(newPrimary,'primary');
      }
      socket.emit('promoteBackup',{oldPrimaryId:oldPrimary,newPrimaryId:newPrimary},function(res){
        if(res&&res.newBackupId){
          if (!backupParentId || backupParentId !== res.newBackupId) {
            backupParentId=res.newBackupId;connectToParent(backupParentId,'backup');
          }
        }
      });
      showReconnectOverlay(false); resetHealthState(); log('故障转移完成 (备用提升)'); return;
    }
  }
  // Strategy 2: request reassign
  log('故障转移: 无可用备用连接，请求服务器重新分配');
  closeConnByRole(primaryParentId,'primary');
  primaryParentId=null; receivedStream=null;
  socket.emit('requestReassign',{reason:'stream-stalled'});
  resetHealthState();
}

// ============================================================
// Stats collection & reporting
// ============================================================
setInterval(function() {
  if(!socket||!myPeerId)return;

  // Periodic connection state dump
  var connSummary = [];
  connections.forEach(function(conn, key) {
    connSummary.push(key.split(':').map(function(p,i){return i===0?p.substring(0,8):p;}).join(':') + '=' + conn.iceState + '/' + conn.pc.signalingState);
  });
  if (connSummary.length > 0) {
    log('连接状态: role='+myRole+' primary='+(primaryParentId?primaryParentId.substring(0,8):'无')+' backup='+(backupParentId?backupParentId.substring(0,8):'无')+' pending='+pendingConnects.size+' conns=['+connSummary.join(', ')+']', 'debug');
  }

  // Cleanup stale connections: stuck at 'new' ICE state for >15s, or disconnected/failed for >10s
  var now = Date.now();
  var staleKeys = [];
  connections.forEach(function(conn, key) {
    if (conn.role === 'child') return; // don't clean up child connections here
    var age = conn.createdAt ? (now - conn.createdAt) : 0;
    if (conn.iceState === 'new' && age > 15000) {
      staleKeys.push(key);
    } else if ((conn.iceState === 'failed' || conn.iceState === 'closed') && age > 10000) {
      staleKeys.push(key);
    }
  });
  staleKeys.forEach(function(key) {
    var conn = connections.get(key);
    if (conn) {
      log('清理过期连接: '+key+' iceState='+conn.iceState+' age='+Math.round((now-(conn.createdAt||0))/1000)+'s','warn');
      conn.pc.close();
      connections.delete(key);
      pendingConnects.delete(key);
    }
  });

  connections.forEach(function(conn){
    if(!conn.pc||conn.pc.connectionState==='closed')return;
    conn.pc.getStats().then(function(stats){
      var rtt=0,packetLoss=0,jitter=0,bytesReceived=0,bytesSent=0;
      stats.forEach(function(report){
        if(report.type==='candidate-pair'&&report.state==='succeeded')rtt=(report.currentRoundTripTime||0)*1000;
        if(report.type==='inbound-rtp'){packetLoss=report.packetsLost||0;jitter=(report.jitter||0)*1000;bytesReceived+=report.bytesReceived||0;}
        if(report.type==='outbound-rtp')bytesSent+=report.bytesSent||0;
      });
      conn.stats={rtt:rtt,packetLoss:packetLoss,jitter:jitter,bytesReceived:bytesReceived,bytesSent:bytesSent};
    }).catch(function(){});
  });
  var primaryConn=primaryParentId?getConn(primaryParentId,'primary'):null;
  if(primaryConn&&primaryConn.stats)socket.emit('reportStats',primaryConn.stats);
  checkStreamHealth();
}, HEALTH_CHECK_INTERVAL);

// ============================================================
// Cleanup
// ============================================================
function cleanup() {
  connections.forEach(function(conn){conn.pc.close();});
  connections.clear();
  pendingConnects.clear();
  if(localStream){localStream.getTracks().forEach(function(t){t.stop();});localStream=null;}
  receivedStream=null; primaryParentId=null; backupParentId=null;
  currentRoomId=null; currentRoomPwd=null;
  if(socket){socket.disconnect();socket=null;}
  myRole=null; myPeerId=null;
}

window.addEventListener('resize',function(){if(document.getElementById('tab-topology').classList.contains('active'))drawTopology();});
