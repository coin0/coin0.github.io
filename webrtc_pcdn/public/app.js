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

var connections = new Map(); // peerId -> { pc, role, dc, iceState, stats, stream }
var receivedStream = null;

var seenMsgIds = new Set();
function markSeen(id) { seenMsgIds.add(id); if (seenMsgIds.size > 200) seenMsgIds.delete(seenMsgIds.values().next().value); }

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
  var entry = document.createElement('div');
  entry.className = 'log-entry ' + level;
  entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  area.appendChild(entry);
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
function showReconnectOverlay(show) { var el = document.getElementById('reconnectOverlay'); if (el) el.style.display = show ? 'flex' : 'none'; }

// ============================================================
// Socket
// ============================================================
function initSocket() {
  if (socket) return;
  socket = io();
  socket.on('connect', function() { log('已连接信令服务器 id=' + socket.id); });
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
    log('父节点变更: '+(d.newParentId||'无')+' 原因:'+(d.reason||''),'warn');
    showReconnectOverlay(true);
    resetHealthState();
    if (primaryParentId && connections.has(primaryParentId)) { connections.get(primaryParentId).pc.close(); connections.delete(primaryParentId); }
    if (backupParentId && connections.has(backupParentId)) { connections.get(backupParentId).pc.close(); connections.delete(backupParentId); backupParentId = null; }
    receivedStream = null;
    if (!d.newParentId) { showReconnectOverlay(false); return; }
    primaryParentId = d.newParentId;
    await connectToParent(primaryParentId, 'primary');
    if (d.backupParentId) { backupParentId = d.backupParentId; await connectToParent(backupParentId, 'backup'); }
  });
  socket.on('promoteBackupToPrimary', async function(d) {
    log('备用连接提升为主连接: '+d.newPrimaryId.substring(0,8));
    resetHealthState();
    var bc = connections.get(d.newPrimaryId);
    if (bc && bc.role === 'backup') {
      bc.role = 'primary'; primaryParentId = d.newPrimaryId; backupParentId = null;
      if (bc.stream && bc.stream.getTracks().length > 0) {
        receivedStream = bc.stream;
        showRemoteVideo(d.newPrimaryId, receivedStream);
        replaceTracksOnChildren(receivedStream);
        showReconnectOverlay(false);
        log('无缝切换完成');
      } else {
        // Backup connection exists but has no stream — reconnect as primary
        log('备用连接无流数据，重新建立主连接','warn');
        bc.pc.close(); connections.delete(d.newPrimaryId);
        await connectToParent(d.newPrimaryId, 'primary');
      }
      socket.emit('requestBackup', function(res) {
        if (res && res.backupParentId) { backupParentId = res.backupParentId; connectToParent(backupParentId, 'backup'); }
      });
    } else {
      // No backup connection object at all — full reconnect
      primaryParentId = d.newPrimaryId;
      await connectToParent(d.newPrimaryId, 'primary');
    }
  });
  socket.on('backupReassign', async function(d) {
    if (backupParentId && connections.has(backupParentId)) { connections.get(backupParentId).pc.close(); connections.delete(backupParentId); }
    backupParentId = d.newBackupId;
    if (d.newBackupId) { log('新备用节点: '+d.newBackupId.substring(0,8)); await connectToParent(d.newBackupId, 'backup'); }
  });
  socket.on('chatMessage', function(msg) { if (msg.id && seenMsgIds.has(msg.id)) return; if (msg.id) markSeen(msg.id); appendChatMessage(msg); });
  socket.on('reaction', function(d) { showReactionFloat(d.emoji); });
  socket.on('qualityWarning', function(d) { log('质量告警: RTT='+Math.round(d.rtt)+'ms 丢包='+d.packetLoss+'% - '+d.suggestion,'warn'); });
  socket.on('disconnect', function() { log('信令断开','error'); });
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
var savedCameraTrack = null; // keep camera track alive during screen share

async function toggleScreenShare() {
  if (isScreenSharing) { stopScreenShare(); return; }
  try {
    var ss = await navigator.mediaDevices.getDisplayMedia({video:{cursor:'always'},audio:false});
    var st = ss.getVideoTracks()[0];
    // Save camera track before replacing (don't stop it)
    savedCameraTrack = localStream.getVideoTracks()[0];
    // Replace on child connections
    for (var [pid,conn] of connections) { if(conn.role==='child'){var s=conn.pc.getSenders().find(function(x){return x.track&&x.track.kind==='video';}); if(s) await s.replaceTrack(st);} }
    // Replace in localStream for preview (don't stop camera track)
    localStream.removeTrack(savedCameraTrack);
    localStream.addTrack(st);
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('localVideo').srcObject = localStream;
    st.onended = function(){stopScreenShare();}; isScreenSharing = true;
    document.getElementById('screenShareBanner').style.display = '';
    document.getElementById('btnScreenShare').textContent = '� 恢复摄像头';
    log('已开始屏幕共享');
  } catch(e) { log('屏幕共享失败: '+e.message,'error'); }
}
async function stopScreenShare() {
  if (!isScreenSharing) return;
  // Stop the screen track
  var screenTrack = localStream.getVideoTracks()[0];
  if (screenTrack) { screenTrack.stop(); localStream.removeTrack(screenTrack); }
  // Restore saved camera track, or re-acquire if dead
  var camTrack = savedCameraTrack;
  if (!camTrack || camTrack.readyState === 'ended') {
    try {
      var nc = await navigator.mediaDevices.getUserMedia({video:getMediaConstraints().video});
      camTrack = nc.getVideoTracks()[0];
    } catch(e) { log('恢复摄像头失败: '+e.message,'error'); isScreenSharing = false; return; }
  }
  localStream.addTrack(camTrack);
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('localVideo').srcObject = localStream;
  // Replace on child connections
  for (var [pid,conn] of connections) { if(conn.role==='child'){var s=conn.pc.getSenders().find(function(x){return x.track&&x.track.kind==='video';}); if(s) await s.replaceTrack(camTrack);} }
  savedCameraTrack = null;
  isScreenSharing = false;
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
  connections.forEach(function(conn, pid) {
    if (conn.role !== 'child') return;
    var senders = conn.pc.getSenders();
    newStream.getTracks().forEach(function(track) {
      var sender = senders.find(function(s) { return s.track && s.track.kind === track.kind; });
      if (sender) {
        sender.replaceTrack(track).catch(function(e) { log('替换子节点轨道失败: '+e.message,'warn'); });
      }
    });
  });
}

// ============================================================
// WebRTC: Connect to parent (primary or backup)
// ============================================================
async function connectToParent(targetId, role) {
  var config = getIceConfig();
  var pc = new RTCPeerConnection(config);
  var ci = { pc:pc, role:role, dc:null, iceState:'new', stats:{}, stream:null };
  connections.set(targetId, ci);
  pc.addTransceiver('video',{direction:'recvonly'}); pc.addTransceiver('audio',{direction:'recvonly'});
  var dc = pc.createDataChannel('chat',{ordered:true}); ci.dc = dc;
  dc.onopen = function(){log('DataChannel('+role+') 打开');};
  dc.onmessage = function(e){handleDcMessage(JSON.parse(e.data),targetId);};
  pc.onicecandidate = function(e){ if(e.candidate) socket.emit('signal',{targetId:targetId,data:{type:'candidate',candidate:e.candidate}}); };
  pc.oniceconnectionstatechange = function(){
    ci.iceState = pc.iceConnectionState;
    log('ICE('+role+') '+targetId.substring(0,8)+': '+pc.iceConnectionState);
    updateIceStatusUI();
    if (pc.iceConnectionState==='failed'){log('ICE失败，重启...','warn');pc.restartIce();}
    if (role==='primary'&&(pc.iceConnectionState==='connected'||pc.iceConnectionState==='completed')) showReconnectOverlay(false);
  };
  pc.ontrack = function(e){
    log('收到轨道('+role+'): '+e.track.kind+' from '+targetId.substring(0,8));
    // Prefer the remote stream provided by the browser (more reliable on iOS Safari)
    var remoteStream = (e.streams && e.streams[0]) ? e.streams[0] : null;
    if (remoteStream) {
      ci.stream = remoteStream;
    } else {
      if (!ci.stream) ci.stream = new MediaStream();
      ci.stream.addTrack(e.track);
    }
    if (role==='primary') {
      receivedStream = ci.stream; showRemoteVideo(targetId, receivedStream);
      // Replace tracks on child connections so downstream viewers get the new stream
      replaceTracksOnChildren(receivedStream);
      if (ci.stream.getVideoTracks().length>0 && ci.stream.getAudioTracks().length>0) { socket.emit('peerReady'); log('已标记为可转发节点'); }
    }
  };
  var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  socket.emit('signal',{targetId:targetId,data:{type:'offer',sdp:pc.localDescription,role:role}});
  log('发送 offer('+role+') -> '+targetId.substring(0,8));
}

// ============================================================
// WebRTC: Handle signals
// ============================================================
async function handleSignal(fromId, data) {
  if (data.type==='offer') {
    log('收到 offer from '+fromId.substring(0,8)+' (我是父节点)');
    var config = getIceConfig(); var pc = new RTCPeerConnection(config);
    var ci = {pc:pc,role:'child',dc:null,iceState:'new',stats:{}};
    connections.set(fromId, ci);
    pc.onicecandidate = function(e){ if(e.candidate) socket.emit('signal',{targetId:fromId,data:{type:'candidate',candidate:e.candidate}}); };
    pc.oniceconnectionstatechange = function(){ ci.iceState=pc.iceConnectionState; log('ICE(子) '+fromId.substring(0,8)+': '+pc.iceConnectionState); updateIceStatusUI(); };
    pc.ondatachannel = function(e){ ci.dc=e.channel; e.channel.onmessage=function(ev){handleDcMessage(JSON.parse(ev.data),fromId);}; };
    var stream = myRole==='publisher'?localStream:receivedStream;
    if (stream && stream.getTracks().length > 0) { stream.getTracks().forEach(function(t){pc.addTrack(t,stream);}); log('添加 '+stream.getTracks().length+' 轨道 -> '+fromId.substring(0,8)); }
    else { log('无可发送流 -> '+fromId.substring(0,8),'warn'); }
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    var answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    socket.emit('signal',{targetId:fromId,data:{type:'answer',sdp:pc.localDescription}});
  } else if (data.type==='answer') {
    var c = connections.get(fromId); if(c) await c.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type==='candidate') {
    var c2 = connections.get(fromId); if(c2) await c2.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
}

// ============================================================
// DataChannel
// ============================================================
function handleDcMessage(msg, fromId) {
  if (msg.type==='chat') { if(seenMsgIds.has(msg.id))return; markSeen(msg.id); appendChatMessage(msg); if(msg.direction==='down')broadcastDc(msg,fromId); }
  else if (msg.type==='reaction') { var rid=msg.id||(msg.from+'-'+msg.emoji+'-'+(msg.ts||0)); if(seenMsgIds.has(rid))return; markSeen(rid); showReactionFloat(msg.emoji); if(msg.direction==='down')broadcastDc(msg,fromId); }
}
function broadcastDc(msg, excludeId) { for(var [pid,conn] of connections){if(conn.role==='child'&&pid!==excludeId&&conn.dc&&conn.dc.readyState==='open')conn.dc.send(JSON.stringify(msg));} }

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
  var c=document.getElementById('iceStatus'); if(!c)return; c.innerHTML='';
  for(var [pid,conn] of connections){
    var st=conn.iceState||'new',color='#888';
    if(st==='connected'||st==='completed')color='#0f9'; else if(st==='checking'||st==='new')color='#ff0'; else if(st==='failed'||st==='disconnected'||st==='closed')color='#f33';
    var rl=conn.role==='primary'?'↑主':conn.role==='backup'?'↑备':'↓子';
    var b=document.createElement('div'); b.className='ice-badge'; b.style.background=color+'22'; b.style.color=color;
    b.innerHTML='<span class="dot" style="background:'+color+'"></span>'+rl+' '+pid.substring(0,6)+' '+st;
    if(st==='failed'){var btn=document.createElement('button');btn.className='btn btn-sm btn-warn';btn.textContent='重连';btn.style.marginLeft='4px';btn.onclick=(function(x){return function(){x.pc.restartIce();};})(conn);b.appendChild(btn);}
    c.appendChild(b);
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
  if(v.srcObject!==stream) {
    v.srcObject=stream;
  }
  // iOS Safari requires explicit play() call after srcObject assignment
  // and may reject it without user gesture — catch and retry on interaction
  var playPromise = v.play();
  if (playPromise !== undefined) {
    playPromise.catch(function(err) {
      log('视频自动播放被阻止: '+err.message+' (点击页面任意位置恢复)','warn');
      // Retry play on next user interaction
      function resumePlay() {
        v.play().catch(function(){});
        document.removeEventListener('touchstart', resumePlay);
        document.removeEventListener('click', resumePlay);
      }
      document.addEventListener('touchstart', resumePlay, {once:true});
      document.addEventListener('click', resumePlay, {once:true});
    });
  }
  // Update unmute button state
  var btn = document.getElementById('btnUnmute');
  if (btn) btn.textContent = v.muted ? '🔊 开启声音' : '🔇 静音';
  var l=document.getElementById('remoteVideoLabel'); if(l)l.innerHTML='连接自: <span style="color:var(--accent2)">'+peerId.substring(0,8)+'...</span>';
}

function unmuteVideo() {
  var v = document.getElementById('remoteVideo');
  if (!v) return;
  v.muted = !v.muted;
  var btn = document.getElementById('btnUnmute');
  if (btn) btn.textContent = v.muted ? '🔊 开启声音' : '🔇 静音';
  // On iOS, toggling muted may require a play() call
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
  canvas.width = rect.width * dpr;
  canvas.height = 400 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '400px';
  ctx.scale(dpr, dpr);

  var W = rect.width, H = 400;
  ctx.clearRect(0, 0, W, H);

  var topo = currentTopology;
  var nodes = topo.nodes || topo;
  if (!nodes || nodes.length === 0) {
    ctx.fillStyle = '#555'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无拓扑数据', W / 2, H / 2);
    return;
  }

  var root = null;
  for (var ni = 0; ni < nodes.length; ni++) { if (nodes[ni].isPublisher) { root = nodes[ni]; break; } }
  if (!root) return;

  var nodeMap = {};
  nodes.forEach(function(n) { nodeMap[n.id] = { id: n.id, parentId: n.parentId, backupParentId: n.backupParentId, isPublisher: n.isPublisher, isReady: n.isReady, childCount: n.childCount, nickname: n.nickname, stats: n.stats, children: [], x: 0, y: 0 }; });
  nodes.forEach(function(n) { if (n.parentId && nodeMap[n.parentId]) nodeMap[n.parentId].children.push(n.id); });

  // BFS to assign positions
  var levels = [];
  var queue = [{ id: root.id, level: 0 }];
  var visited = {};
  while (queue.length > 0) {
    var item = queue.shift();
    if (visited[item.id]) continue;
    visited[item.id] = true;
    if (!levels[item.level]) levels[item.level] = [];
    levels[item.level].push(item.id);
    var nd = nodeMap[item.id];
    if (nd) nd.children.forEach(function(cid) { queue.push({ id: cid, level: item.level + 1 }); });
  }

  var levelH = Math.min(80, (H - 60) / Math.max(levels.length, 1));
  var nodeRadius = 20;

  levels.forEach(function(ids, lvl) {
    var y = 40 + lvl * levelH;
    var spacing = W / (ids.length + 1);
    ids.forEach(function(id, i) { var nd = nodeMap[id]; if (nd) { nd.x = spacing * (i + 1); nd.y = y; } });
  });

  // Draw primary edges (solid)
  ctx.strokeStyle = '#334'; ctx.lineWidth = 2;
  nodes.forEach(function(n) {
    if (n.parentId && nodeMap[n.parentId] && nodeMap[n.id]) {
      var parent = nodeMap[n.parentId], child = nodeMap[n.id];
      ctx.beginPath(); ctx.setLineDash([]);
      ctx.moveTo(parent.x, parent.y + nodeRadius);
      ctx.lineTo(child.x, child.y - nodeRadius);
      ctx.stroke();
    }
  });

  // Draw backup edges (dashed, different color)
  ctx.strokeStyle = '#f9044488'; ctx.lineWidth = 1.5;
  nodes.forEach(function(n) {
    if (n.backupParentId && nodeMap[n.backupParentId] && nodeMap[n.id]) {
      var bp = nodeMap[n.backupParentId], child = nodeMap[n.id];
      ctx.beginPath(); ctx.setLineDash([4, 4]);
      ctx.moveTo(bp.x, bp.y + nodeRadius);
      ctx.lineTo(child.x, child.y - nodeRadius);
      ctx.stroke();
    }
  });
  ctx.setLineDash([]);

  // Draw nodes
  nodes.forEach(function(n) {
    var nd = nodeMap[n.id]; if (!nd) return;
    var color = '#3498db';
    if (n.isPublisher) color = topo.publisherOffline ? '#555' : '#e94560';
    else if (n.childCount > 0) color = '#27ae60';
    if (!n.isReady && !n.isPublisher) color = '#f39c12';

    ctx.beginPath(); ctx.arc(nd.x, nd.y, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = color + '33'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var icon = n.isPublisher ? (topo.publisherOffline ? '⏸' : '📡') : (n.childCount > 0 ? '🔁' : '👤');
    ctx.fillText(icon, nd.x, nd.y);

    ctx.fillStyle = '#aaa'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top';
    var label = n.nickname || n.id.substring(0, 6);
    var meTag = n.id === myPeerId ? ' (我)' : '';
    ctx.fillText(label + meTag, nd.x, nd.y + nodeRadius + 4);

    // Show stats if available
    if (n.stats && n.stats.rtt) {
      ctx.fillStyle = n.stats.rtt > 500 ? '#f33' : '#888';
      ctx.font = '9px sans-serif';
      ctx.fillText(Math.round(n.stats.rtt) + 'ms', nd.x, nd.y + nodeRadius + 16);
    }
  });

  canvas._nodes = nodeMap;
}

// Click on canvas node for detail
document.addEventListener('click', function(e) {
  var canvas = document.getElementById('topoCanvas');
  var detail = document.getElementById('nodeDetail');
  if (!canvas || !canvas._nodes) { if (detail) detail.style.display = 'none'; return; }
  var rect = canvas.getBoundingClientRect();
  if (e.target !== canvas) { if (detail) detail.style.display = 'none'; return; }
  var x = e.clientX - rect.left, y = e.clientY - rect.top;
  var found = null;
  for (var id in canvas._nodes) {
    var nd = canvas._nodes[id];
    var dx = nd.x - x, dy = nd.y - y;
    if (Math.sqrt(dx * dx + dy * dy) < 24) { found = nd; break; }
  }
  if (!found) { if (detail) detail.style.display = 'none'; return; }
  detail.style.display = '';
  detail.style.left = (e.clientX + 10) + 'px';
  detail.style.top = (e.clientY + 10) + 'px';
  document.getElementById('nodeDetailTitle').textContent = found.isPublisher ? '📡 主播节点' : '👤 观众节点';
  var conn = connections.get(found.id);
  var iceState = conn ? conn.iceState : 'N/A';
  var statsHtml = '';
  if (found.stats) {
    statsHtml = '<div class="detail-row">RTT: <span>' + (found.stats.rtt ? Math.round(found.stats.rtt) + 'ms' : 'N/A') + '</span></div>' +
      '<div class="detail-row">丢包: <span>' + (found.stats.packetLoss != null ? found.stats.packetLoss + '%' : 'N/A') + '</span></div>';
  }
  document.getElementById('nodeDetailBody').innerHTML =
    '<div class="detail-row">Peer ID: <span>' + found.id.substring(0, 12) + '...</span></div>' +
    '<div class="detail-row">昵称: <span>' + escHtml(found.nickname || 'N/A') + '</span></div>' +
    '<div class="detail-row">父节点: <span>' + (found.parentId ? found.parentId.substring(0, 8) : '无 (根)') + '</span></div>' +
    '<div class="detail-row">备用父节点: <span>' + (found.backupParentId ? found.backupParentId.substring(0, 8) : '无') + '</span></div>' +
    '<div class="detail-row">子节点数: <span>' + found.childCount + '</span></div>' +
    '<div class="detail-row">ICE状态: <span>' + iceState + '</span></div>' +
    '<div class="detail-row">就绪: <span>' + (found.isReady ? '✅' : '⏳') + '</span></div>' +
    statsHtml;
});

// ============================================================
// Stream health monitoring
// ============================================================
var HEALTH_CHECK_INTERVAL = 3000;  // check every 3s
var STALL_THRESHOLD = 3;           // consecutive stalls before failover
var streamHealthState = {
  prevBytesReceived: 0,
  stallCount: 0,
  failoverInProgress: false
};

function resetHealthState() {
  streamHealthState.prevBytesReceived = 0;
  streamHealthState.stallCount = 0;
  streamHealthState.failoverInProgress = false;
}

async function checkStreamHealth() {
  if (!socket || !myPeerId || myRole !== 'viewer') return;
  if (streamHealthState.failoverInProgress) return;

  var primaryConn = primaryParentId ? connections.get(primaryParentId) : null;
  if (!primaryConn || !primaryConn.pc || primaryConn.pc.connectionState === 'closed') return;

  // Only check when ICE looks healthy — that's the whole point of this monitor
  var iceState = primaryConn.pc.iceConnectionState;
  if (iceState !== 'connected' && iceState !== 'completed') {
    // ICE itself is broken — normal ICE failure handling will kick in
    resetHealthState();
    return;
  }

  try {
    var stats = await primaryConn.pc.getStats();
    var totalBytes = 0;
    var hasInbound = false;
    stats.forEach(function(report) {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        totalBytes += report.bytesReceived || 0;
        hasInbound = true;
      }
    });

    if (!hasInbound) return; // no inbound video track yet

    if (streamHealthState.prevBytesReceived > 0 && totalBytes <= streamHealthState.prevBytesReceived) {
      streamHealthState.stallCount++;
      log('流量停滞检测 (' + streamHealthState.stallCount + '/' + STALL_THRESHOLD + ') bytes=' + totalBytes, 'warn');

      if (streamHealthState.stallCount >= STALL_THRESHOLD) {
        log('主连接流量持续停滞，触发故障转移', 'error');
        triggerStreamFailover();
      }
    } else {
      // Bytes are flowing, reset stall counter
      if (streamHealthState.stallCount > 0) {
        streamHealthState.stallCount = 0;
      }
    }
    streamHealthState.prevBytesReceived = totalBytes;
  } catch (e) { /* ignore stats errors */ }
}

async function triggerStreamFailover() {
  if (streamHealthState.failoverInProgress) return;
  streamHealthState.failoverInProgress = true;
  showReconnectOverlay(true);

  // Strategy 1: promote backup if available and healthy
  if (backupParentId && connections.has(backupParentId)) {
    var backupConn = connections.get(backupParentId);
    if (backupConn && backupConn.pc &&
        (backupConn.pc.iceConnectionState === 'connected' || backupConn.pc.iceConnectionState === 'completed')) {
      log('故障转移: 提升备用连接 ' + backupParentId.substring(0, 8) + ' 为主连接');

      // Close dead primary
      var oldPrimary = primaryParentId;
      var oldConn = connections.get(oldPrimary);
      if (oldConn) { oldConn.pc.close(); connections.delete(oldPrimary); }

      // Promote backup
      backupConn.role = 'primary';
      var newPrimary = backupParentId;
      primaryParentId = newPrimary;
      backupParentId = null;

      if (backupConn.stream && backupConn.stream.getTracks().length > 0) {
        receivedStream = backupConn.stream;
        showRemoteVideo(newPrimary, receivedStream);
        replaceTracksOnChildren(receivedStream);
      } else {
        // Backup ICE is green but no media — do full reconnect to this node
        log('备用连接无流数据，重新建立连接','warn');
        backupConn.pc.close(); connections.delete(newPrimary);
        await connectToParent(newPrimary, 'primary');
      }

      // Notify server of the promotion
      socket.emit('promoteBackup', { oldPrimaryId: oldPrimary, newPrimaryId: newPrimary }, function(res) {
        if (res && res.newBackupId) {
          backupParentId = res.newBackupId;
          connectToParent(backupParentId, 'backup');
        }
      });

      showReconnectOverlay(false);
      resetHealthState();
      log('故障转移完成 (备用提升)');
      return;
    }
  }

  // Strategy 2: no usable backup — close dead primary and ask server for reassignment
  log('故障转移: 无可用备用连接，请求服务器重新分配');
  var deadPrimary = primaryParentId;
  var deadConn = connections.get(deadPrimary);
  if (deadConn) { deadConn.pc.close(); connections.delete(deadPrimary); }
  primaryParentId = null;
  receivedStream = null;

  socket.emit('requestReassign', { reason: 'stream-stalled' });
  resetHealthState();
}

// ============================================================
// Stats collection & reporting
// ============================================================
setInterval(function() {
  if (!socket || !myPeerId) return;

  // Collect stats for all connections
  connections.forEach(function(conn, pid) {
    if (!conn.pc || conn.pc.connectionState === 'closed') return;
    conn.pc.getStats().then(function(stats) {
      var rtt = 0, packetLoss = 0, jitter = 0, bytesReceived = 0, bytesSent = 0;
      stats.forEach(function(report) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = (report.currentRoundTripTime || 0) * 1000;
        }
        if (report.type === 'inbound-rtp') {
          packetLoss = report.packetsLost || 0;
          jitter = (report.jitter || 0) * 1000;
          bytesReceived += report.bytesReceived || 0;
        }
        if (report.type === 'outbound-rtp') { bytesSent += report.bytesSent || 0; }
      });
      conn.stats = { rtt: rtt, packetLoss: packetLoss, jitter: jitter, bytesReceived: bytesReceived, bytesSent: bytesSent };
    }).catch(function() {});
  });

  // Report aggregated stats to server
  var primaryConn = primaryParentId ? connections.get(primaryParentId) : null;
  if (primaryConn && primaryConn.stats) {
    socket.emit('reportStats', primaryConn.stats);
  }

  // Run stream health check
  checkStreamHealth();
}, HEALTH_CHECK_INTERVAL);

// ============================================================
// Cleanup
// ============================================================
function cleanup() {
  connections.forEach(function(conn) { conn.pc.close(); });
  connections.clear();
  if (localStream) { localStream.getTracks().forEach(function(t) { t.stop(); }); localStream = null; }
  receivedStream = null;
  primaryParentId = null;
  backupParentId = null;
  if (socket) { socket.disconnect(); socket = null; }
  myRole = null;
  myPeerId = null;
}

// Resize handler for topology
window.addEventListener('resize', function() {
  if (document.getElementById('tab-topology').classList.contains('active')) drawTopology();
});
