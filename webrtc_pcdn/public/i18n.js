'use strict';
// ============================================================
// i18n — Chinese / English toggle
// ============================================================
// URL param: ?lang=en or ?lang=zh
// Persisted in localStorage. Toggle button in header.
// ============================================================

var I18N = {
  zh: {
    // Header
    title: '🌐 WebRTC PCDN 级联直播系统',
    subtitle: '单主播 + 多观众 · 树状级联分发 · P2P加速',
    // Tabs
    tabLobby: '🏠 大厅', tabLive: '📺 直播', tabTopology: '🌳 拓扑', tabLog: '📋 日志',
    // Stats bar
    statViewersLabel: '在线观众', statDepthLabel: '树深度', statSavedLabel: '带宽节省',
    statPcdnLabel: '主播上行', statRoutes: '路', statLinksLabel: '链路',
    // Lobby
    liveRooms: '📺 正在直播的房间', noRooms: '暂无直播房间',
    createLive: '🎥 创建直播', joinWatch: '👀 加入观看',
    roomId: '房间号', roomTitleLabel: '房间标题', roomPwd: '房间密码',
    nickname: '昵称', password: '密码',
    roomTitlePh: '我的直播间', optionalPh: '可选', viewerPh: '观众', ifNeededPh: '如需要',
    startLive: '🎥 开始直播', joinBtn: '👀 加入观看',
    // Network settings
    networkSettings: '⚙️ 网络设置 (STUN/TURN)',
    stunServer: 'STUN 服务器', turnAddr: 'TURN 地址', turnUser: 'TURN 用户名', turnPwd: 'TURN 密码',
    turnFallbackLabel: 'TURN 回退',
    turnAuto: '自动 (P2P失败时使用TURN)', turnAlways: '始终使用TURN', turnNever: '仅P2P',
    // Live — publisher
    publisherTitle: '🎥 主播端', stopLive: '停止直播',
    screenShare: '🖥️ 共享屏幕', screenShareRestore: '📷 恢复摄像头',
    copyInvite: '📎 复制邀请链接', inviteLink: '📎 邀请链接',
    sharingScreen: '正在共享屏幕', stopShare: '停止共享',
    childNodeStatus: '📡 子节点连接状态', noChildNodes: '暂无子节点',
    reconnecting: '🔄 正在重新连接...',
    // Live — viewer
    watchingTitle: '👀 观看中', leaveRoom: '离开房间',
    unmute: '🔊 开启声音', mute: '🔇 静音',
    noLiveMsg: '请先在大厅创建或加入直播',
    // Chat
    chatTitle: '💬 聊天', chatPh: '发送消息...', sendBtn: '发送',
    // Topology
    topoTitle: '🌳 网络拓扑可视化',
    legendPublisher: '主播', legendRelay: '中继节点', legendViewer: '观众', legendBackup: '备用连接',
    nodeDetail: '节点详情',
    // Log
    logTitle: '📋 系统日志', copyLog: '📋 复制日志',
    // Dynamic JS strings
    inviteCopied: '邀请链接已复制',
    inviteCopyPrompt: '复制此链接分享给观众:',
    enterRoomId: '请输入房间号',
    roomNotExist: '房间不存在或主播已离开',
    joinFailed: '加入失败: ',
    liveEnded: '直播已结束',
    liveEndedFull: '直播已结束，主播已离开房间',
    roomLabel: '房间',
    primaryLabel: '主',
    backupLabel: '备',
    topoLabel: '拓扑',
    nodesLabel: '节点',
    connectedFrom: '连接自',
    publisherNode: '📡 主播节点',
    viewerNode: '👤 观众节点',
    detailNickname: '昵称', detailParent: '父节点', detailBackupParent: '备用父节点',
    detailChildren: '子节点', detailFanout: '扇出余量', detailLink: '链路',
    detailCandidate: '候选', detailLocal: '本地', detailRemote: '远端',
    detailSubnet: '网段', detailReady: '就绪', detailLoss: '丢包',
    noParent: '无 (根)', none: '无', same: '同',
    copiedLogs: '✅ 已复制 {0} 条日志',
    defaultPublisher: '主播', defaultViewer: '观众',
    hostLabel: '主播', viewerLabel: '观众',
    roomCardHost: '主播', roomCardOffline: '⚠️离线',
  },
  en: {
    title: '🌐 WebRTC PCDN Cascade Live',
    subtitle: 'Single Publisher + Multi-Viewer · Tree Cascade · P2P Accelerated',
    tabLobby: '🏠 Lobby', tabLive: '📺 Live', tabTopology: '🌳 Topology', tabLog: '📋 Log',
    statViewersLabel: 'Viewers', statDepthLabel: 'Tree Depth', statSavedLabel: 'BW Saved',
    statPcdnLabel: 'Uplinks', statRoutes: '', statLinksLabel: 'Links',
    liveRooms: '📺 Live Rooms', noRooms: 'No live rooms',
    createLive: '🎥 Create Live', joinWatch: '👀 Join as Viewer',
    roomId: 'Room ID', roomTitleLabel: 'Room Title', roomPwd: 'Room Password',
    nickname: 'Nickname', password: 'Password',
    roomTitlePh: 'My Room', optionalPh: 'Optional', viewerPh: 'Viewer', ifNeededPh: 'If needed',
    startLive: '🎥 Start Live', joinBtn: '👀 Join',
    networkSettings: '⚙️ Network Settings (STUN/TURN)',
    stunServer: 'STUN Server', turnAddr: 'TURN Address', turnUser: 'TURN Username', turnPwd: 'TURN Password',
    turnFallbackLabel: 'TURN Fallback',
    turnAuto: 'Auto (TURN on P2P fail)', turnAlways: 'Always TURN', turnNever: 'P2P Only',
    publisherTitle: '🎥 Publisher', stopLive: 'Stop Live',
    screenShare: '🖥️ Share Screen', screenShareRestore: '📷 Restore Camera',
    copyInvite: '📎 Copy Invite Link', inviteLink: '📎 Invite Link',
    sharingScreen: 'Sharing Screen', stopShare: 'Stop Sharing',
    childNodeStatus: '📡 Child Node Status', noChildNodes: 'No child nodes',
    reconnecting: '🔄 Reconnecting...',
    watchingTitle: '👀 Watching', leaveRoom: 'Leave Room',
    unmute: '🔊 Unmute', mute: '🔇 Mute',
    noLiveMsg: 'Create or join a live room from the lobby',
    chatTitle: '💬 Chat', chatPh: 'Send a message...', sendBtn: 'Send',
    topoTitle: '🌳 Network Topology',
    legendPublisher: 'Publisher', legendRelay: 'Relay Node', legendViewer: 'Viewer', legendBackup: 'Backup',
    nodeDetail: 'Node Detail',
    logTitle: '📋 System Log', copyLog: '📋 Copy Log',
    inviteCopied: 'Invite link copied',
    inviteCopyPrompt: 'Copy this link to share:',
    enterRoomId: 'Please enter a room ID',
    roomNotExist: 'Room does not exist or host left',
    joinFailed: 'Join failed: ',
    liveEnded: 'Live ended',
    liveEndedFull: 'Live ended, host has left the room',
    roomLabel: 'Room',
    primaryLabel: 'Primary',
    backupLabel: 'Backup',
    topoLabel: 'Topo',
    nodesLabel: 'nodes',
    connectedFrom: 'From',
    publisherNode: '📡 Publisher Node',
    viewerNode: '👤 Viewer Node',
    detailNickname: 'Nickname', detailParent: 'Parent', detailBackupParent: 'Backup Parents',
    detailChildren: 'Children', detailFanout: 'Fanout Left', detailLink: 'Link',
    detailCandidate: 'Candidate', detailLocal: 'Local', detailRemote: 'Remote',
    detailSubnet: 'Subnet', detailReady: 'Ready', detailLoss: 'Loss',
    noParent: 'None (root)', none: 'None', same: 'Same',
    copiedLogs: '✅ Copied {0} log entries',
    defaultPublisher: 'Host', defaultViewer: 'Viewer',
    hostLabel: 'Host', viewerLabel: 'Viewer',
    roomCardHost: 'Host', roomCardOffline: '⚠️Offline',
  }
};

var currentLang = 'zh';

function detectLang() {
  var params = new URLSearchParams(window.location.search);
  var urlLang = params.get('lang');
  if (urlLang === 'en' || urlLang === 'zh') return urlLang;
  var stored = localStorage.getItem('pcdn_lang');
  if (stored === 'en' || stored === 'zh') return stored;
  return 'zh';
}

function t(key) {
  var dict = I18N[currentLang] || I18N.zh;
  return dict[key] || I18N.zh[key] || key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    var val = t(key);
    if (val) {
      if (el.tagName === 'OPTION') el.textContent = val;
      else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = val;
      else el.textContent = val;
    }
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    var val = t(key);
    if (val) el.placeholder = val;
  });
  // Update lang toggle button text
  var btn = document.getElementById('langToggle');
  if (btn) btn.textContent = currentLang === 'zh' ? 'EN' : '中文';
  // Update page title
  document.title = currentLang === 'zh' ? 'WebRTC PCDN 级联直播系统' : 'WebRTC PCDN Cascade Live';
  // Update default input values that depend on language
  var pubNick = document.getElementById('pubNickname');
  if (pubNick && (pubNick.value === '主播' || pubNick.value === 'Host')) pubNick.value = t('defaultPublisher');
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('pcdn_lang', lang);
  applyI18n();
}

function toggleLang() {
  setLang(currentLang === 'zh' ? 'en' : 'zh');
}

// Initialize on load
currentLang = detectLang();
applyI18n();
