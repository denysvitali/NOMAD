const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./config');
const { db, canAccessTrip } = require('./db/database');

// Room management: tripId → Set<WebSocket>
const rooms = new Map();

// Track which rooms each socket is in
const socketRooms = new WeakMap();

// Track user info per socket
const socketUser = new WeakMap();

// Track unique socket ID
const socketId = new WeakMap();
let nextSocketId = 1;

// Per-user connection tracking
const userConnections = new Map(); // userId -> Set<ws>
const MAX_CONNECTIONS_PER_USER = 10;

// Per-socket message rate limiting
const messageRates = new WeakMap();
const MAX_MESSAGES_PER_SECOND = 20;

// Per-socket room limit
const MAX_ROOMS_PER_SOCKET = 10;

// Token expiry tracking per socket
const socketExpiry = new WeakMap();

let wss;

function setupWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 64 * 1024, // 64 KB
    verifyClient: ({ origin, req }, cb) => {
      if (process.env.NODE_ENV !== 'production') return cb(true);
      const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : null;
      const host = req.headers.host;
      if (allowedOrigins) {
        cb(!origin || allowedOrigins.includes(origin));
      } else {
        // Same-origin check
        cb(!origin || origin === `https://${host}` || origin === `http://${host}`);
      }
    }
  });

  // Heartbeat: ping every 30s, terminate if no pong
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      // Check token expiry before pinging
      const expiry = socketExpiry.get(ws);
      if (expiry && Date.now() > expiry) {
        ws.close(4003, 'Token expired');
        return;
      }
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    let userId = null;
    let authenticated = false;

    // Must authenticate within 5 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'Authentication timeout');
    }, 5000);

    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Handle unauthenticated state — expect auth message first
      if (!authenticated) {
        if (msg.type !== 'auth' || !msg.token) {
          ws.close(4001, 'Authentication required');
          return;
        }
        let decoded;
        try {
          decoded = jwt.verify(msg.token, JWT_SECRET, { algorithms: ['HS256'] });
        } catch {
          ws.close(4001, 'Invalid token');
          return;
        }
        const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(decoded.id);
        if (!user) {
          ws.close(4001, 'Invalid user');
          return;
        }

        userId = user.id;
        authenticated = true;
        clearTimeout(authTimeout);

        // Per-user connection limit
        if (!userConnections.has(userId)) userConnections.set(userId, new Set());
        const conns = userConnections.get(userId);
        if (conns.size >= MAX_CONNECTIONS_PER_USER) {
          ws.close(4008, 'Too many connections');
          return;
        }
        conns.add(ws);

        const sid = nextSocketId++;
        socketId.set(ws, sid);
        socketUser.set(ws, user);
        socketRooms.set(ws, new Set());
        socketExpiry.set(ws, decoded.exp * 1000);

        ws.send(JSON.stringify({ type: 'authenticated' }));
        ws.send(JSON.stringify({ type: 'welcome', socketId: sid }));
        return;
      }

      // Authenticated — apply rate limiting
      const now = Date.now();
      let bucket = messageRates.get(ws);
      if (!bucket || now > bucket.reset) {
        bucket = { count: 0, reset: now + 1000 };
        messageRates.set(ws, bucket);
      }
      if (++bucket.count > MAX_MESSAGES_PER_SECOND) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
        return;
      }

      if (msg.type === 'join' && msg.tripId) {
        const tripId = parseInt(msg.tripId, 10);
        if (!Number.isFinite(tripId) || tripId <= 0) return;

        // Enforce room limit per socket
        const currentRooms = socketRooms.get(ws);
        if (currentRooms && currentRooms.size >= MAX_ROOMS_PER_SOCKET) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too many active rooms' }));
          return;
        }

        // Verify the user has access to this trip
        if (!canAccessTrip(tripId, userId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
          return;
        }
        // Add to room
        if (!rooms.has(tripId)) rooms.set(tripId, new Set());
        rooms.get(tripId).add(ws);
        socketRooms.get(ws).add(tripId);
        ws.send(JSON.stringify({ type: 'joined', tripId }));
      }

      if (msg.type === 'leave' && msg.tripId) {
        const tripId = parseInt(msg.tripId, 10);
        if (!Number.isFinite(tripId) || tripId <= 0) return;
        leaveRoom(ws, tripId);
        ws.send(JSON.stringify({ type: 'left', tripId }));
      }
    });

    ws.on('close', () => {
      // Clean up all rooms this socket was in
      const myRooms = socketRooms.get(ws);
      if (myRooms) {
        for (const tripId of myRooms) {
          leaveRoom(ws, tripId);
        }
      }
      // Clean up user connection tracking
      if (userId !== null) {
        const conns = userConnections.get(userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) userConnections.delete(userId);
        }
      }
    });
  });

  console.log('WebSocket server attached at /ws');
}

function leaveRoom(ws, tripId) {
  const room = rooms.get(tripId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) rooms.delete(tripId);
  }
  const myRooms = socketRooms.get(ws);
  if (myRooms) myRooms.delete(tripId);
}

/**
 * Broadcast an event to all sockets in a trip room, optionally excluding a user.
 * @param {number} tripId
 * @param {string} eventType  e.g. 'place:created'
 * @param {object} payload    the data to send
 * @param {number} [excludeSid]  don't send to this socket (the one who triggered the change)
 */
function broadcast(tripId, eventType, payload, excludeSid) {
  tripId = Number(tripId);
  const room = rooms.get(tripId);
  if (!room || room.size === 0) return;

  const excludeNum = excludeSid ? Number(excludeSid) : null;

  for (const ws of room) {
    if (ws.readyState !== 1) continue; // WebSocket.OPEN === 1
    // Exclude the specific socket that triggered the change
    if (excludeNum && socketId.get(ws) === excludeNum) continue;
    ws.send(JSON.stringify({ type: eventType, tripId, ...payload }));
  }
}

function broadcastToUser(userId, payload, excludeSid) {
  if (!wss) return;
  const excludeNum = excludeSid ? Number(excludeSid) : null;
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (excludeNum && socketId.get(ws) === excludeNum) continue;
    const user = socketUser.get(ws);
    if (user && user.id === userId) {
      ws.send(JSON.stringify(payload));
    }
  }
}

function getOnlineUserIds() {
  const ids = new Set();
  if (!wss) return ids;
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    const user = socketUser.get(ws);
    if (user) ids.add(user.id);
  }
  return ids;
}

module.exports = { setupWebSocket, broadcast, broadcastToUser, getOnlineUserIds };
