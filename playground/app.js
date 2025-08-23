(() => {
  const $ = sel => document.querySelector(sel);
  const ev = msg => { const el = $('#eventsLog'); el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`; el.scrollTop = el.scrollHeight; };
  const syntaxHighlight = json => {
    const str = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/("[^"]+"\s*:)/g, '<span class="token-key">$1</span>')
      .replace(/(:\s*)"([^\"]*)"/g, '$1<span class="token-string">"$2"</span>')
      .replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="token-number">$2</span>')
      .replace(/(:\s*)(true|false)/g, '$1<span class="token-boolean">$2</span>')
      .replace(/(:\s*)(null)/g, '$1<span class="token-null">$2</span>');
  };
  const resp = obj => { const el = $('#responseLog'); const html = syntaxHighlight(obj); el.innerHTML += `${new Date().toLocaleTimeString()}<br/>${html}<br/><br/>`; el.scrollTop = el.scrollHeight; };

  let socket = null;

  const connect = () => {
    const host = $('#host').value.trim() || 'http://localhost:3000';
    const token = $('#token').value.trim();
    if (!token) { ev('Missing JWT token'); return; }
    socket = io(host, { auth: { token } });

    socket.on('connect', () => { $('#status').textContent = 'connected'; ev(`connected: ${socket.id}`); });
    socket.on('disconnect', (r) => { $('#status').textContent = 'disconnected'; ev(`disconnected: ${r}`); });
    socket.on('error', (e) => { ev(`error: ${JSON.stringify(e)}`); });

    // server events
    socket.on('session-joined', p => ev(`session-joined: ${JSON.stringify(p)}`));
    socket.on('message-received', p => ev(`message-received: ${JSON.stringify(p)}`));
    socket.on('agent-thinking', p => ev(`agent-thinking: ${JSON.stringify(p)}`));
    socket.on('agent-response', p => { ev(`agent-response meta`); resp(p); });
  // Clear buttons
  // Attach after script load to avoid DOMContentLoaded timing differences
  const wireClearButtons = () => {
    const clrE = document.getElementById('btnClearEvents');
    const clrR = document.getElementById('btnClearResp');
    if (clrE && clrR) {
      clrE.onclick = () => { document.getElementById('eventsLog').textContent = ''; };
      clrR.onclick = () => { document.getElementById('responseLog').innerHTML = ''; };
    } else {
      setTimeout(wireClearButtons, 50);
    }
  };
  wireClearButtons();
    socket.on('typing-indicator', p => ev(`typing-indicator: ${JSON.stringify(p)}`));
    socket.on('sessions-list', p => ev(`sessions-list: ${JSON.stringify(p)}`));
    socket.on('session-created', p => ev(`session-created: ${JSON.stringify(p)}`));
    socket.on('session-deleted', p => ev(`session-deleted: ${JSON.stringify(p)}`));
  };

  const disconnect = () => { if (socket) { socket.disconnect(); socket = null; } };

  const join = () => {
    if (!socket) return ev('not connected');
    const sessionId = $('#sessionId').value.trim();
    const userId = $('#userId').value.trim();
    if (!sessionId || !userId) { return ev('sessionId and userId required'); }
    socket.emit('join-session', { sessionId, userId });
  };

  const send = () => {
    if (!socket) return ev('not connected');
    const sessionId = $('#sessionId').value.trim();
    const message = $('#message').value.trim();
    const dbUrl = $('#dbUrl').value.trim();
    const dbType = $('#dbType').value.trim();
    if (!sessionId || !message) { return ev('sessionId and message required'); }
    const payload = { sessionId, message };
    if (dbUrl) payload.dbUrl = dbUrl;
    if (dbType) payload.dbType = dbType;
    socket.emit('send-message', payload);
    ev(`send-message: ${JSON.stringify(payload)}`);
  };

  const typing = () => {
    if (!socket) return ev('not connected');
    const sessionId = $('#sessionId').value.trim();
    socket.emit('typing', { sessionId, isTyping: true });
    ev('typing sent');
  };

  const getSessions = () => {
    if (!socket) return ev('not connected');
    const userId = $('#userId').value.trim();
    socket.emit('get-sessions', { userId });
  };

  const createSession = () => {
    if (!socket) return ev('not connected');
    const userId = $('#userId').value.trim();
    const title = $('#title').value.trim();
    socket.emit('create-session', { userId, title });
  };

  const deleteSession = () => {
    if (!socket) return log('not connected');
    const userId = $('#userId').value.trim();
    const sessionId = $('#sessionId').value.trim();
    socket.emit('delete-session', { userId, sessionId });
  };

  $('#btnConnect').addEventListener('click', connect);
  $('#btnDisconnect').addEventListener('click', disconnect);
  $('#btnJoin').addEventListener('click', join);
  $('#btnSend').addEventListener('click', send);
  $('#btnTyping').addEventListener('click', typing);
  $('#btnGetSessions').addEventListener('click', getSessions);
  $('#btnCreateSession').addEventListener('click', createSession);
  $('#btnDeleteSession').addEventListener('click', deleteSession);
})();


