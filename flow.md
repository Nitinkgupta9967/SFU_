# Mini-SFU: Flow of Implementation

Companion to [`plan.md`](./plan.md). All diagrams are Mermaid and render on GitHub, GitLab, VS Code (Markdown Preview Mermaid) and most documentation tools.

**Legend:** `A`, `B`, `C` are browser clients. `SIG` is the signaling gateway. `ROOM` is the Room and Peer logic. `ENG` is the media engine (Producers, Consumers, RtpRewriter). `PUB-T` and `SUB-T` are the publisher and subscriber transports of a peer.

---

## 1. Topology: why N:N works through an SFU

```mermaid
flowchart LR
  subgraph Mesh["Mesh (not used): N x (N-1) uploads per client"]
    direction LR
    m1((A)) <--> m2((B))
    m1 <--> m3((C))
    m2 <--> m3
  end

  subgraph SFU["SFU (this project): 1 upload per client"]
    direction LR
    a((A)) -- "up" --> S{{SFU}}
    b((B)) -- "up" --> S
    c((C)) -- "up" --> S
    S -- "down B and C" --> a
    S -- "down A and C" --> b
    S -- "down A and B" --> c
  end
```

Each client uploads one copy of its media. The server decrypts it, rewrites the headers per receiver, and sends N-1 re-encrypted copies out.

---

## 2. Build order (implementation flow)

The order in which the system is built, with the dependency of each step. Maps to the phases in `plan.md` §10.

```mermaid
flowchart TD
  P0["Phase 0: Spike<br/>werift loopback and RTCP check"] --> P1
  P1["Phase 1: Signaling, Room, Peer<br/>join, leave, REST"] --> P2
  P2["Phase 2: Publish path<br/>PUB-T, Producer, track.publish, offer"] --> P3
  P3["Phase 3: Subscribe path<br/>SUB-T, Consumer, Negotiator, client SDK"] --> P4
  P4["Phase 4: Media quality<br/>keyframe gate, PLI, NACK, mute, rewriter tests"] --> MVP{{"MVP: N:N conference"}}
  MVP --> P5["Phase 5: Speaker detection, stats, auth"]
  MVP --> P6["Phase 6: Simulcast and adaptive layers (stretch)"]
  P5 --> P7
  P6 --> P7["Phase 7: Reconnect, ICE restart, worker sharding, load test"]
```

---

## 3. Connection and join

Two sockets of different kinds are involved: one WebSocket for signaling, then two PeerConnections for media. The PeerConnections are created **after** the join succeeds.

```mermaid
sequenceDiagram
  autonumber
  participant A as Client A
  participant SIG as Signaling
  participant ROOM as Room / Peer
  participant B as Client B (already in room)

  A->>SIG: WS connect /ws?room=demo&token=JWT
  SIG->>SIG: verify token, check room capacity
  alt invalid token
    SIG-->>A: close 4001
  else room full
    SIG-->>A: response ROOM_FULL then close
  end
  A->>SIG: request join (displayName, autoSubscribe)
  SIG->>ROOM: getOrCreate room, create Peer A
  ROOM-->>SIG: peerId, peers snapshot with live tracks
  SIG-->>A: response join (peerId, iceServers, peers, reconnectToken)
  ROOM-->>B: notification peer.joined (A)
  Note over A: Client creates publisher PC and subscriber PC objects
  opt room already has published tracks
    ROOM->>ROOM: create Consumers for A (late-joiner catch-up)
    ROOM->>ROOM: negotiator.markDirty (see section 6)
  end
```

---

## 4. Publish a track (A turns on camera)

Key idea: A **declares** the track first (`track.publish`), then sends the SDP offer with a `mid → cid` map. The server never has to guess which media section is which.

```mermaid
sequenceDiagram
  autonumber
  participant A as Client A
  participant SIG as Signaling
  participant ROOM as Room / Peer A
  participant PUBT as PUB-T (A)
  participant ENG as Engine
  participant B as Client B

  A->>A: getUserMedia then pc.addTrack(camera)
  A->>SIG: request track.publish (cid, kind=video, source=camera)
  SIG->>ROOM: register pending track (cid)
  ROOM-->>A: response trackSid = TR_a1b2
  A->>A: createOffer then setLocalDescription
  A->>SIG: request publisher.offer (sdp, mids = mid0 to cid)
  SIG->>PUBT: setRemoteDescription(offer)
  PUBT->>PUBT: createAnswer
  PUBT-->>A: response sdp answer
  A->>A: setRemoteDescription(answer)

  par ICE and DTLS
    A-->>SIG: ice.candidate (publisher)
    SIG->>PUBT: addIceCandidate
    PUBT-->>A: ice.candidate (publisher) notification
  end
  Note over A,PUBT: ICE connected then DTLS handshake then SRTP keys derived

  PUBT-->>ENG: onTrack(IncomingTrack mid0)
  ENG->>ROOM: bind mid0 to cid to trackSid, create Producer TR_a1b2
  ROOM-->>B: notification track.published (TR_a1b2)
  ROOM->>ROOM: for each other peer: create Consumer, mark subscriber dirty
  Note over ROOM: continues in section 5 and 6
```

---

## 5. Subscribe and renegotiate (server-driven)

The subscriber PC is always **offered by the server**. The client only answers. This eliminates glare.

```mermaid
sequenceDiagram
  autonumber
  participant ROOM as Room
  participant NEG as Negotiator (B)
  participant SUBT as SUB-T (B)
  participant SIG as Signaling
  participant B as Client B

  ROOM->>SUBT: addOutgoingTrack(video) for Producer TR_a1b2
  ROOM->>NEG: markDirty
  NEG->>NEG: debounce 50 ms, coalesce further changes
  NEG->>SUBT: createOffer
  SUBT-->>NEG: offer sdp, outgoing track mids assigned
  NEG->>SIG: send subscriber.offer (offerId=17, sdp, mids: mid3 to TR_a1b2 of peer A)
  SIG-->>B: notification subscriber.offer
  B->>B: setRemoteDescription, createAnswer, setLocalDescription
  B->>B: ontrack fires, map transceiver.mid to trackSid, attach to A tile
  B->>SIG: request subscriber.answer (offerId=17, sdp)
  SIG->>NEG: onAnswer(offerId=17)
  NEG->>SUBT: setRemoteDescription(answer)
  alt offerId stale
    NEG->>NEG: discard answer
  else changes arrived while waiting
    NEG->>NEG: dirty flag set, go to Debouncing again
  end
  Note over SUBT,B: ICE and DTLS complete (first time only), Consumer enters Gated state
```

---

## 6. The data plane: how one RTP packet travels (core SFU function)

```mermaid
sequenceDiagram
  autonumber
  participant A as Client A
  participant PUBT as PUB-T (A)
  participant PROD as Producer TR_a1b2
  participant CB as Consumer for B
  participant RWB as RtpRewriter B
  participant SUBTB as SUB-T (B)
  participant B as Client B
  participant CC as Consumer for C

  A->>PUBT: SRTP packet (A key)
  PUBT->>PROD: decrypted RtpPacket via onRtp
  alt kind is audio
    PROD->>PROD: SpeakerDetector.update(audio level)
  end
  alt producer muted
    PROD->>PROD: drop
  else live
    PROD->>CB: forward(pkt)
    PROD->>CC: forward(pkt)
    alt B paused or video gate closed and not a keyframe
      CB->>CB: drop, ensure PLI pending
    else flowing
      CB->>RWB: rewrite(pkt)
      Note over RWB: ssrc = B's sender ssrc, pt = B's pt, seq + offset, ts + offset, strip extensions
      RWB-->>CB: new header, shared payload buffer
      CB->>CB: video only: packetCache.put(seq)
      CB->>SUBTB: writeRtp
      SUBTB->>B: SRTP packet (B key)
    end
  end
```

Per-packet rules: synchronous, no `await`, no per-packet logging, header cloned (never mutate the shared packet), payload buffer shared (zero-copy).

---

## 7. Keyframe handling (late joiner, resume, loss)

```mermaid
sequenceDiagram
  autonumber
  participant B as Client B (subscriber)
  participant CB as Consumer B
  participant KC as KeyframeController
  participant PROD as Producer
  participant PUBT as PUB-T (A)
  participant A as Client A (publisher)

  Note over CB: New consumer created, keyframeGate = closed
  CB->>KC: need keyframe (reason: new consumer)
  KC->>KC: throttle check (min 500 ms per producer)
  KC->>PROD: requestKeyframe
  PROD->>PUBT: IncomingTrack.requestKeyframe
  PUBT->>A: RTCP PLI
  A->>PUBT: keyframe (VP8 key frame packets)
  PUBT->>PROD: RtpPacket
  PROD->>CB: forward(pkt)
  CB->>CB: isVp8KeyframeStart is true, so open gate and rewriter.rebase(pkt)
  CB->>B: first decodable packets
  Note over KC: If no keyframe in 1 s, retry up to 5 times
  B-->>CB: later: RTCP PLI (decoder lost sync)
  CB->>KC: need keyframe (reason: subscriber PLI)
  Note over KC: Many subscribers asking at once are coalesced into one PLI to the publisher
```

---

## 8. Loss recovery (NACK served by the SFU)

```mermaid
sequenceDiagram
  autonumber
  participant B as Client B
  participant SUBTB as SUB-T (B)
  participant CB as Consumer B
  participant PC as PacketCache (B)

  B->>SUBTB: RTCP NACK (seq 1201, 1202)
  SUBTB->>CB: onFeedback nack
  CB->>PC: get(1201), get(1202)
  alt found in cache
    PC-->>CB: stored rewritten packets
    CB->>SUBTB: writeRtp (retransmit as-is)
    SUBTB->>B: retransmitted packets
  else evicted
    CB->>CB: ignore, count missedNack (client will PLI if frame is unrecoverable)
  end
```

Because the cache stores **already rewritten** packets, the retransmit needs no reverse mapping to the publisher's sequence numbers.

---

## 9. Mute, pause, resume

```mermaid
sequenceDiagram
  autonumber
  participant A as Client A
  participant SIG as Signaling
  participant PROD as Producer
  participant CB as Consumer B
  participant B as Client B

  A->>SIG: request track.mute (TR_a1b2, muted=true)
  SIG->>PROD: muted = true (ownership check)
  SIG-->>A: response ok
  SIG-->>B: notification track.muted
  Note over PROD: packets dropped at Producer, consumers idle
  A->>SIG: request track.mute (muted=false)
  SIG->>PROD: muted = false
  PROD->>CB: onSourceResumed
  CB->>CB: rewriter.rebase on next packet, keyframeGate = closed
  CB->>PROD: requestKeyframe
  Note over CB: Sequence and timestamps continue smoothly, so B sees no discontinuity

  B->>SIG: request subscription.update (TR_a1b2, paused=true)
  SIG->>CB: pause (only B is affected)
  Note over CB: Other subscribers unaffected. Resume uses the same rebase and re-gate path.
```

---

## 10. Unpublish and leave

```mermaid
sequenceDiagram
  autonumber
  participant A as Client A
  participant SIG as Signaling
  participant ROOM as Room
  participant ENG as Engine
  participant NEG as Negotiator (each subscriber)
  participant B as Client B

  A->>SIG: request track.unpublish (TR_a1b2)
  SIG->>ROOM: removeProducer (ownership check)
  ROOM->>ENG: close Producer, then close every Consumer
  ENG->>ENG: transport.removeOutgoingTrack for each consumer
  ROOM-->>B: notification track.unpublished
  ROOM->>NEG: markDirty
  NEG-->>B: subscriber.offer (track m-section inactive or removed)
  B-->>NEG: subscriber.answer
  SIG-->>A: response ok
  A->>A: renegotiate publisher PC (remove sender)

  Note over A,B: Peer leaving
  A->>SIG: request leave
  SIG->>ROOM: removePeer A
  ROOM->>ENG: close all A producers and all consumers owned by A
  ROOM->>ROOM: close PUB-T and SUB-T, clear timers
  ROOM-->>B: notification peer.left
  ROOM->>NEG: markDirty for every other peer
  SIG-->>A: response ok, close 1000
```

---

## 11. Peer lifecycle, disconnect and reconnect

```mermaid
stateDiagram-v2
  [*] --> Joining: WS open
  Joining --> Active: join ok
  Joining --> Closed: join failed or timeout
  Active --> Disconnected: WS closed unexpectedly or heartbeat timeout
  Disconnected --> Active: reconnect with token inside grace period
  Disconnected --> Closed: grace period expired
  Active --> Closed: leave or kicked or room closed
  Closed --> [*]
```

```mermaid
sequenceDiagram
  autonumber
  participant A as Client A
  participant SIG as Signaling
  participant ROOM as Room / Peer A
  participant B as Client B

  Note over A,SIG: Network drops
  SIG->>ROOM: socket closed, start 10 s grace timer
  Note over ROOM: Producers keep state. Media may keep flowing if transports survive
  A->>SIG: WS reconnect, join(reconnectToken)
  alt within grace period
    SIG->>ROOM: rebind WS to existing Peer A
    ROOM-->>A: join response (same peerId, current peers snapshot)
    A->>SIG: ice.restart (publisher and subscriber) if transports failed
    Note over B: B never sees peer.left
  else grace expired
    ROOM->>ROOM: removePeer A (see section 10)
    ROOM-->>B: notification peer.left (reason: timeout)
    A->>SIG: full fresh join
  end
```

---

## 12. Active speaker detection

```mermaid
sequenceDiagram
  autonumber
  participant PROD as Producer (audio)
  participant SD as SpeakerDetector
  participant ROOM as Room
  participant ALL as All clients

  loop every audio packet (20 ms)
    PROD->>SD: update(peerId, audioLevel, voiceFlag)
  end
  loop every 300 ms
    SD->>SD: compute 500 ms windowed average per peer
    SD->>SD: select top 3 below threshold
    alt set or order changed
      SD->>ROOM: speakers changed
      ROOM-->>ALL: notification speakers.changed
    end
  end
```

---

## 13. Simulcast layer switch (phase 6)

```mermaid
sequenceDiagram
  autonumber
  participant B as Client B
  participant CB as Consumer B
  participant LS as LayerSelector
  participant PROD as Producer (layers q, h, f)
  participant RWB as RtpRewriter B

  B-->>CB: RTCP Receiver Report (fractionLost 14 percent)
  CB->>LS: report
  LS->>LS: loss above 10 percent twice, step down from f to h
  LS->>CB: switch target layer to h
  CB->>PROD: requestKeyframe(layer h)
  Note over CB: Keep forwarding layer f until layer h keyframe arrives
  PROD->>CB: layer h keyframe packet
  CB->>RWB: rebase(first h packet)
  CB->>CB: swap source stream to h
  CB-->>B: notification subscription.changed (layer h, reason bandwidth)
  Note over CB,B: seq and timestamp stay continuous, so the decoder sees one stream
```

---

## 14. Negotiation concurrency (what the per-peer queue and negotiator guarantee)

```mermaid
flowchart TD
  E1["Event: track.published by A"] --> Q
  E2["Event: track.published by C"] --> Q
  E3["Event: peer.left D"] --> Q
  Q["Negotiator.markDirty (B)"] --> D{"State?"}
  D -- Idle --> DB["Debouncing 50 ms"]
  D -- Debouncing --> DB
  D -- AwaitingAnswer --> DF["set dirty = true"]
  DB --> OFF["createOffer with ALL current consumers"]
  OFF --> SEND["send subscriber.offer (offerId n)"]
  SEND --> WAIT["AwaitingAnswer"]
  WAIT -- "answer, offerId matches" --> APPLY["setRemoteDescription"]
  WAIT -- "answer, stale id" --> DROP["discard"]
  WAIT -- "timeout 10 s" --> RETRY["rollback and re-offer"]
  APPLY --> CHK{"dirty?"}
  CHK -- yes --> DB
  CHK -- no --> IDLE["Idle"]
  DF --> WAIT
```

Three events arriving close together result in **one** offer (or two if one arrives mid-negotiation), never three overlapping ones.

---

## 15. End-to-end summary (one screen)

```mermaid
flowchart LR
  A1["1. WS + join"] --> A2["2. track.publish (cid)"] --> A3["3. publisher.offer + mids"] --> A4["4. ICE + DTLS up"]
  A4 --> A5["5. onTrack then Producer"] --> A6["6. Consumers for every peer"] --> A7["7. subscriber.offer + mids"]
  A7 --> A8["8. subscriber.answer"] --> A9["9. Gate closed, PLI sent"] --> A10["10. Keyframe opens gate"]
  A10 --> A11["11. RTP forwarded with rewrite"] --> A12["12. NACK, PLI, mute, speaker, stats while live"]
  A12 --> A13["13. Unpublish or leave, renegotiate, cleanup"]
```
