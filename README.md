# Mini-SFU Engine

A high-performance Selective Forwarding Unit (SFU) WebRTC conference engine built from scratch in TypeScript, powered by `werift` for native WebRTC media transport.

---

## Key Architectural Features

- **Native WebRTC Media Transport (`werift`)**: Direct RTP packet routing over UDP without heavy third-party media server dependencies.
- **RTP Packet Rewriter**: Per-subscriber sequence number & timestamp translation for seamless, glitch-free packet forwarding.
- **VP8 Keyframe Gating**: Automated PLI (Picture Loss Indication) request throttling and keyframe detection before unmuting video streams.
- **Ring Packet Cache & NACK Retransmissions**: Efficient packet caching per consumer for swift recovery under lossy network conditions.
- **Active Speaker Detector**: Real-time RTP audio level header extension parsing (`urn:ietf:params:rtp-hdrext:ssrc-audio-level`) emitting `speakers.changed` events.
- **Full-Featured Client SDK**: Included [`SfuClient.ts`](file:///C:/Users/nitin/OneDrive/Documents/ChatGPT/SFU_/client/SfuClient.ts) browser SDK with automatic reconnection grace, ping keepalives, and event handling.
- **Sleek Conference UI**: Modern glassmorphic multi-party web interface served at `/demo`.
- **Admin REST API & Prometheus Observability**: JWT room token issuance, peer kick controls, and standard `/metrics` endpoint.

---

## Quick Start

### 1. Installation & Build

```bash
npm install
npm run build
```

### 2. Development Server

```bash
npm run dev
```

Server starts at `http://localhost:8080`. Navigate to **`http://localhost:8080/demo`** to launch the conference interface.

### 3. Run Tests

```bash
# Unit test suite
npm test

# Integration & Browser smoke tests
npm run test:integration
```

---

## HTTP REST & Observability API

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/healthz` | Health check & server uptime |
| `POST` | `/api/rooms` | Create room (`{ roomId, maxPeers }`) |
| `GET` | `/api/rooms` | List active room summaries |
| `GET` | `/api/rooms/:roomId` | Detailed room, peer, and track stats |
| `DELETE` | `/api/rooms/:roomId` | Force close room |
| `POST` | `/api/rooms/:roomId/token` | Issue signed JWT room token |
| `DELETE` | `/api/rooms/:roomId/peers/:peerId` | Kick peer from room |
| `GET` | `/api/stats` | Aggregate SFU engine performance metrics |
| `GET` | `/metrics` | Prometheus exporter (`mini_sfu_*` gauges) |
| `GET` | `/demo` | Conference Web UI |

---

## WebSocket Protocol Specification

WebSocket Endpoint: `ws://localhost:8080/ws?room=<roomId>`

### JSON Envelope Formats

#### Client Request
```json
{
  "type": "request",
  "id": 1,
  "method": "join",
  "params": {
    "displayName": "Alice",
    "autoSubscribe": true
  }
}
```

#### Server Response
```json
{
  "type": "response",
  "id": 1,
  "ok": true,
  "data": {
    "peerId": "p_x1y2z3",
    "roomId": "demo",
    "reconnectToken": "rt_a1b2c3"
  }
}
```

#### Notification
```json
{
  "type": "notification",
  "event": "speakers.changed",
  "data": {
    "speakers": [{ "peerId": "p_x1y2z3", "level": 18 }]
  }
}
```

---

## Configuration Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | HTTP & WebSocket server port |
| `PUBLIC_IP` | `undefined` | Server public IP for WAN ICE candidates |
| `RTC_MIN_PORT` | `40000` | Minimum UDP port for WebRTC media |
| `RTC_MAX_PORT` | `40100` | Maximum UDP port for WebRTC media |
| `AUTH_MODE` | `none` | Authentication mode (`none` or `jwt`) |
| `JWT_SECRET` | `undefined` | Secret key for room JWT verification |
| `ADMIN_API_KEY` | `undefined` | Optional bearer token for REST API |
| `MAX_PEERS_PER_ROOM` | `16` | Room capacity limit |
| `RECONNECT_GRACE_MS`| `10000` | Reconnection grace window |
| `RATE_LIMIT_PER_SEC` | `50` | Signaling rate limiter ceiling |

