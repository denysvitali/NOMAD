// Singleton WebSocket manager for real-time collaboration

let socket = null
let reconnectTimer = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
const listeners = new Set()
const activeTrips = new Set()
let currentToken = null
let refetchCallback = null
let mySocketId = null

export function getSocketId() {
  return mySocketId
}

export function setRefetchCallback(fn) {
  refetchCallback = fn
}

function getWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/ws`
}

function handleMessage(event) {
  try {
    const parsed = JSON.parse(event.data)
    // Store our socket ID from welcome message
    if (parsed.type === 'welcome') {
      mySocketId = parsed.socketId
      return
    }
    // Silently ignore protocol-level messages (authenticated, error ack, etc.)
    if (parsed.type === 'authenticated') {
      return
    }
    listeners.forEach(fn => {
      try { fn(parsed) } catch (err) { console.error('WebSocket listener error:', err) }
    })
  } catch (err) {
    console.error('WebSocket message parse error:', err)
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // Read a fresh token from storage in case it was refreshed
    const freshToken = localStorage.getItem('auth_token')
    if (freshToken) {
      currentToken = freshToken
      connectInternal(freshToken, true)
    } else if (currentToken) {
      connectInternal(currentToken, true)
    }
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function connectInternal(token, isReconnect = false) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  const url = getWsUrl()
  socket = new WebSocket(url)

  socket.onopen = () => {
    // Send token as first message for authentication
    socket.send(JSON.stringify({ type: 'auth', token }))

    reconnectDelay = 1000
    // Join active trips on any connect (initial or reconnect)
    if (activeTrips.size > 0) {
      activeTrips.forEach(tripId => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'join', tripId }))
          // joined trip room
        }
      })
      // Refetch trip data for active trips
      if (refetchCallback) {
        activeTrips.forEach(tripId => {
          try { refetchCallback(tripId) } catch (err) {
            console.error('Failed to refetch trip data on reconnect:', err)
          }
        })
      }
    }
  }

  socket.onmessage = handleMessage

  socket.onclose = () => {
    socket = null
    if (currentToken) {
      scheduleReconnect()
    }
  }

  socket.onerror = () => {
    // onclose will fire after onerror, reconnect handled there
  }
}

export function connect(token) {
  currentToken = token
  reconnectDelay = 1000
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  connectInternal(token, false)
}

export function disconnect() {
  currentToken = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  activeTrips.clear()
  if (socket) {
    socket.onclose = null // prevent reconnect
    socket.close()
    socket = null
  }
}

export function joinTrip(tripId) {
  activeTrips.add(String(tripId))
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'join', tripId: String(tripId) }))
  }
}

export function leaveTrip(tripId) {
  activeTrips.delete(String(tripId))
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'leave', tripId: String(tripId) }))
  }
}

export function addListener(fn) {
  listeners.add(fn)
}

export function removeListener(fn) {
  listeners.delete(fn)
}
