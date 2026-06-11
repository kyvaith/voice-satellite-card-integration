/**
 * Camera WebRTC playback over the HA websocket.
 *
 * Negotiates a stream for a camera entity using HA's camera/webrtc/*
 * websocket API (the same flow as HA's own ha-web-rtc-player): fetch
 * the client config (STUN servers, optional data channel), add
 * recvonly transceivers, send the SDP offer via the camera/webrtc/offer
 * subscription, and trickle ICE candidates both ways - local ones are
 * buffered until HA assigns a session id, remote ones until the answer
 * is applied.
 *
 * Used by the media player (camera playback) and the screensaver
 * (media type with a camera selected).
 */

/** True when the camera entity has a WebRTC provider registered. */
export async function cameraSupportsWebrtc(conn, entityId) {
  const caps = await conn.sendMessagePromise({
    type: 'camera/capabilities',
    entity_id: entityId,
  });
  return !!caps?.frontend_stream_types?.includes('web_rtc');
}

/**
 * Negotiate a camera WebRTC stream and attach it to a <video> element
 * (via srcObject).  Negotiation runs asynchronously; terminal failures
 * (setup error, error event from HA, connection failed) are reported
 * through onError exactly once unless already closed.
 *
 * The caller owns the video element and MUST call close() on teardown -
 * it ends the signaling subscription (tearing down the stream
 * server-side) and closes the peer connection.
 *
 * @param {object} opts
 * @param {object} opts.conn       HA websocket connection
 * @param {string} opts.entityId   camera.xxx entity id
 * @param {HTMLVideoElement} opts.video
 * @param {(msg: string) => void} [opts.log]
 * @param {(err: Error) => void}  [opts.onError]
 * @returns {{ close: () => void }}
 */
export function attachCameraWebrtc({ conn, entityId, video, log = () => {}, onError = () => {} }) {
  let closed = false;
  let pc = null;
  let unsubPromise = null;

  const fail = (err) => {
    if (!closed) onError(err);
  };

  (async () => {
    // STUN/TURN servers and (for some cameras, e.g. Nest) a required
    // data channel name.  Optional - negotiation proceeds without it.
    let clientConfig = null;
    try {
      clientConfig = await conn.sendMessagePromise({
        type: 'camera/webrtc/get_client_config',
        entity_id: entityId,
      });
    } catch (e) {
      log(`No WebRTC client config: ${e?.message || e}`);
    }
    if (closed) return;

    try {
      pc = new RTCPeerConnection(clientConfig?.configuration || undefined);
      if (clientConfig?.dataChannel) {
        pc.createDataChannel(clientConfig.dataChannel);
      }
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.ontrack = (ev) => {
        if (!video.srcObject) video.srcObject = ev.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        log(`WebRTC connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
          fail(new Error('WebRTC connection failed'));
        }
      };

      // Trickle ICE: local candidates are buffered until HA assigns a
      // session id, then sent (and live ones forwarded as they gather).
      let sessionId = null;
      const pendingLocal = [];
      const sendCandidate = (candidate) => {
        conn.sendMessagePromise({
          type: 'camera/webrtc/candidate',
          entity_id: entityId,
          session_id: sessionId,
          candidate,
        }).catch((e) => {
          log(`Failed to send ICE candidate: ${e?.message || JSON.stringify(e)}`);
        });
      };
      pc.onicecandidate = (ev) => {
        if (closed || !ev.candidate?.candidate) return; // null/empty = end-of-candidates
        const init = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
        if (sessionId) sendCandidate(init);
        else pendingLocal.push(init);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (closed) return;

      // Remote candidates that arrive while setRemoteDescription is still
      // in flight would throw InvalidStateError - buffer until the answer
      // is applied.
      let remoteDescSet = false;
      const pendingRemote = [];
      unsubPromise = conn.subscribeMessage(async (event) => {
        if (closed) return;
        try {
          if (event.type === 'session') {
            sessionId = event.session_id;
            for (const c of pendingLocal.splice(0)) sendCandidate(c);
          } else if (event.type === 'answer') {
            log('WebRTC answer received');
            await pc.setRemoteDescription({ type: 'answer', sdp: event.answer });
            remoteDescSet = true;
            for (const c of pendingRemote.splice(0)) await pc.addIceCandidate(c);
          } else if (event.type === 'candidate') {
            if (remoteDescSet) await pc.addIceCandidate(event.candidate);
            else pendingRemote.push(event.candidate);
          } else if (event.type === 'error') {
            fail(new Error(`WebRTC error ${event.code}: ${event.message}`));
          }
        } catch (e) {
          fail(e);
        }
      }, {
        type: 'camera/webrtc/offer',
        entity_id: entityId,
        offer: offer.sdp,
      });
      await unsubPromise;
    } catch (e) {
      fail(e);
    }
  })();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (unsubPromise) {
        // Unsubscribing ends the signaling session, which tears down the
        // stream server-side.
        unsubPromise.then((unsub) => unsub()).catch(() => { /* already closed */ });
        unsubPromise = null;
      }
      if (pc) {
        try { pc.close(); } catch (_e) { /* best effort */ }
        pc = null;
      }
    },
  };
}
