/*
 * Peer-to-peer transport built on PeerJS (WebRTC). One host, one guest.
 * The host registers a Peer with the room id; the guest connects to it.
 * Exposes `SvcNet` on the global object.
 */
(function (global) {
  'use strict';

  const ROOM_PREFIX = 'svc-';
  const RETRY_MS = 3000;

  function randomCode(n) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const buf = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(buf);
    else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < n; i++) s += chars[buf[i] % chars.length];
    return s;
  }

  function newRoomId() {
    return ROOM_PREFIX + randomCode(6);
  }

  function normalizeRoomId(s) {
    s = (s || '').trim().toLowerCase();
    try {
      const u = new URL(s);
      const q = u.searchParams.get('room');
      if (q) s = q.toLowerCase();
    } catch (e) { /* not a URL */ }
    if (s && s.indexOf(ROOM_PREFIX) !== 0) s = ROOM_PREFIX + s;
    return s;
  }

  function Connection(handlers) {
    this.h = handlers;
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.roomId = null;
    this.closed = false;
    this.retryTimer = null;
  }

  Connection.prototype._emit = function (name, arg) {
    if (this.h[name]) this.h[name](arg);
  };

  Connection.prototype._newPeer = function (id) {
    const self = this;
    const peer = id ? new Peer(id) : new Peer();
    peer.on('error', function (err) {
      self._emit('error', err);
      if (self.role === 'guest' && (err.type === 'peer-unavailable' || err.type === 'network')) self._scheduleRetry();
    });
    peer.on('disconnected', function () {
      if (self.closed) return;
      try { peer.reconnect(); } catch (e) { /* ignore */ }
    });
    return peer;
  };

  Connection.prototype.host = function (roomId) {
    const self = this;
    this.role = 'host';
    this.roomId = roomId;
    this.peer = this._newPeer(roomId);
    this.peer.on('open', function () { self._emit('ready', roomId); });
    this.peer.on('connection', function (conn) {
      if (self.conn && self.conn.open) {
        // Only one guest at a time.
        conn.on('open', function () { conn.send({ t: 'busy' }); setTimeout(function () { conn.close(); }, 500); });
        return;
      }
      self._attach(conn);
    });
  };

  Connection.prototype.join = function (roomId) {
    const self = this;
    this.role = 'guest';
    this.roomId = roomId;
    this.peer = this._newPeer(null);
    this.peer.on('open', function () { self._emit('ready', roomId); self._connect(); });
  };

  Connection.prototype._connect = function () {
    if (this.closed || !this.peer || this.peer.disconnected) return;
    this._emit('status', 'connecting');
    const conn = this.peer.connect(this.roomId, { reliable: true });
    this._attach(conn);
  };

  Connection.prototype._scheduleRetry = function () {
    const self = this;
    if (this.closed || this.retryTimer) return;
    this._emit('status', 'retrying');
    this.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self._connect();
    }, RETRY_MS);
  };

  Connection.prototype._attach = function (conn) {
    const self = this;
    this.conn = conn;
    conn.on('open', function () { self._emit('connected'); });
    conn.on('data', function (data) {
      if (data && data.t === 'busy') { self._emit('busy'); self.close(); return; }
      self._emit('message', data);
    });
    conn.on('close', function () {
      if (self.conn === conn) self.conn = null;
      self._emit('disconnected');
      if (self.role === 'guest') self._scheduleRetry();
    });
    conn.on('error', function (err) { self._emit('error', err); });
  };

  Connection.prototype.send = function (obj) {
    if (this.conn && this.conn.open) { this.conn.send(obj); return true; }
    return false;
  };

  Connection.prototype.isConnected = function () {
    return !!(this.conn && this.conn.open);
  };

  Connection.prototype.close = function () {
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.conn) { try { this.conn.close(); } catch (e) { /* ignore */ } }
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
    this.conn = null;
    this.peer = null;
  };

  global.SvcNet = { Connection: Connection, newRoomId: newRoomId, normalizeRoomId: normalizeRoomId, available: function () { return typeof Peer !== 'undefined'; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
