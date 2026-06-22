import { State, BlurReason } from '../constants.js';
import { getSwitchState } from '../shared/satellite-state.js';
import {
  mergeAssistantTurnText,
  mergeDisplayTurnText,
  mergeTranscript,
  normalizeTranscriptText,
  removeTranscriptEchoSpan,
  isLikelyTranscriptEcho,
  shouldEndConversation,
} from './transcript.js';

const CLIENT_VERSION = '1.4.0';
const DEFAULT_AUDIO_BUFFER_MS = 120;
const OPUS_AUDIO_QUALITY_PARAMS = {
  minptime: '20',
  useinbandfec: '1',
  maxplaybackrate: '48000',
  maxaveragebitrate: '96000',
  usedtx: '0',
};
const OPUS_AUDIO_REMOVE_PARAMS = new Set(['stereo', 'sprop-stereo']);

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function shortId() {
  return randomId().slice(0, 8);
}

function mergeOpusFmtp(existing) {
  const params = new Map();
  for (const part of existing.split(';').map((item) => item.trim()).filter(Boolean)) {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey.trim().toLowerCase();
    if (!key || OPUS_AUDIO_REMOVE_PARAMS.has(key)) continue;
    params.set(key, rest.length ? rest.join('=').trim() : '');
  }
  for (const [key, value] of Object.entries(OPUS_AUDIO_QUALITY_PARAMS)) params.set(key, value);
  return [...params.entries()].map(([key, value]) => (value ? `${key}=${value}` : key)).join(';');
}

function preferFullbandOpus(sdp) {
  if (!sdp) return sdp;
  const separator = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const opusPayloads = new Set();
  const fmtpPayloads = new Set();

  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i.exec(line);
    if (rtpmap) opusPayloads.add(rtpmap[1]);
    const fmtp = /^a=fmtp:(\d+)\s+/i.exec(line);
    if (fmtp) fmtpPayloads.add(fmtp[1]);
  }

  return lines.map((line) => {
    const fmtp = /^a=fmtp:(\d+)\s*(.*)$/i.exec(line);
    if (fmtp && opusPayloads.has(fmtp[1])) {
      return `a=fmtp:${fmtp[1]} ${mergeOpusFmtp(fmtp[2] || '')}`;
    }
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i.exec(line);
    if (rtpmap && !fmtpPayloads.has(rtpmap[1])) {
      return `${line}${separator}a=fmtp:${rtpmap[1]} ${mergeOpusFmtp('')}`;
    }
    return line;
  }).join(separator);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function rtviAssistantTextPriority(type) {
  if (type === 'bot-output') return 4;
  if (type === 'bot-transcription') return 3;
  if (type === 'bot-tts-text') return 2;
  if (type === 'bot-llm-text') return 1;
  if (type.startsWith('assistant-')) return 2;
  return 0;
}

function isRtviUserTextType(type) {
  return type === 'user-transcription'
    || type === 'user-llm-text'
    || type.startsWith('user-');
}

function isRtviAssistantTextType(type) {
  return rtviAssistantTextPriority(type) > 0;
}

function compactComparableTranscript(value) {
  return normalizeTranscriptText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function isSameTranscriptTurn(left, right) {
  const leftText = normalizeTranscriptText(left);
  const rightText = normalizeTranscriptText(right);
  if (!leftText || !rightText) return false;
  const leftCompact = compactComparableTranscript(leftText);
  const rightCompact = compactComparableTranscript(rightText);
  if (!leftCompact || !rightCompact) return false;
  if (leftCompact === rightCompact) return true;
  const shortest = Math.min(leftCompact.length, rightCompact.length);
  if (shortest >= 8 && (leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact))) return true;
  return isLikelyTranscriptEcho(leftText, rightText) || isLikelyTranscriptEcho(rightText, leftText);
}

export class PipecatAssistRealtimeClient {
  constructor(pipeline) {
    this._pipeline = pipeline;
    this._card = pipeline.card;
    this._log = pipeline.log;
    this._peer = null;
    this._channel = null;
    this._audio = new Audio();
    this._remoteStream = null;
    this._pingTimer = null;
    this._started = false;
    this._stopping = false;
    this._audioBlocked = false;
    this._localAudioTrack = null;
    this._clientIdKey = 'voice-satellite-pipecat-assist-client-id';
    this.clearTurnState();
  }

  get active() { return this._started; }

  clearTurnState() {
    this._userTranscript = '';
    this._assistantTranscript = '';
    this._partialTranscript = '';
    this._currentUserText = '';
    this._currentUserUpdatedAt = 0;
    this._assistantTurnBase = '';
    this._assistantTurnText = '';
    this._assistantTurnPriority = 0;
    this._assistantTurnActive = false;
    this._assistantLastTurnText = '';
    this._assistantLastTurnPriority = 0;
    this._assistantLastTurnFinishedAt = 0;
    this._lastAssistantTextAt = 0;
    this._lastUserTextAt = 0;
    this._lastUserTurnText = '';
    this._lastUserTurnFinishedAt = 0;
    this._ignoreLocalSpeechUntil = 0;
    this._assistantTurnFinishTimer = null;
    this._endConversationPending = false;
    this._endConversationTimer = null;
    this._endConversationStopping = false;
  }

  async start(opts = {}) {
    if (this._started) await this.stop({ restart: false });
    this._started = true;
    this._stopping = false;
    this._audioBlocked = false;
    this.clearTurnState();

    const { audio } = this._card;
    if (!audio._mediaStream) {
      this._log.log('pipecat', 'Mic not running - acquiring through AudioManager before Pipecat WebRTC');
      await audio.startMicrophone('stt');
    }
    if (audio.currentMicMode !== 'stt') {
      try {
        await audio.switchMicMode?.('stt');
      } catch (e) {
        this._log.error('pipecat', `switchMicMode(stt) failed: ${e?.message || e}`);
        throw e;
      }
    }
    audio.setMicTracksMuted?.(false);
    audio.stopSending();

    this._card.setState(State.STT);
    this._card.ui.showBlurOverlay(BlurReason.PIPELINE);

    try {
      const addonConfig = await this.loadAddonConfig();
      const peer = new RTCPeerConnection();
      this._peer = peer;

      const track = audio._mediaStream?.getAudioTracks?.()[0];
      if (track) {
        track.enabled = true;
        this._localAudioTrack = track;
        peer.addTransceiver(track, { direction: 'sendrecv' });
      }
      else peer.addTransceiver('audio', { direction: 'sendrecv' });

      this._channel = peer.createDataChannel('signalling');
      this._channel.onmessage = (event) => this.handleRealtimeMessage(event.data);
      this._channel.onopen = () => this.sendClientReady();

      peer.ontrack = (event) => {
        if (event.track.kind !== 'audio') return;
        this.applyRemoteAudioBuffer(event.receiver);
        this._remoteStream = event.streams[0] || new MediaStream([event.track]);
        this.attachRemoteAudio();
      };
      peer.onconnectionstatechange = () => {
        this._log.log('pipecat', `WebRTC connectionState=${peer.connectionState}`);
        if (peer.connectionState === 'connected') {
          this._pipeline.serviceUnavailable = false;
          this.ensureLocalAudioTrackActive();
          this._card.setState(State.STT);
        }
        if (['failed', 'disconnected'].includes(peer.connectionState)) {
          this.fail(`Pipecat Assist WebRTC ${peer.connectionState}`);
        }
      };

      const offer = await peer.createOffer({ voiceActivityDetection: false });
      await peer.setLocalDescription({ type: offer.type, sdp: preferFullbandOpus(offer.sdp) });
      await this.waitForIce(peer);

      const response = await fetch(this.apiPath(addonConfig.runner_offer_path || '/api/pipecat_assist/offer'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({
          sdp: peer.localDescription.sdp,
          type: peer.localDescription.type,
          request_data: {
            source: 'voice_satellite_card',
            client_id: this.clientId(),
            language: this.sessionLanguage(),
            wake_word_slot: opts.wake_word_slot || undefined,
          },
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const answer = await response.json();
      await peer.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
      this.applyRemoteAudioBuffers(peer);
      this.attachRemoteAudio();
    } catch (err) {
      this.fail(err?.message || String(err));
    }
  }

  async stop({ restart = false } = {}) {
    this._stopping = true;
    this._started = false;

    if (this._assistantTurnFinishTimer) {
      clearTimeout(this._assistantTurnFinishTimer);
      this._assistantTurnFinishTimer = null;
    }
    this.clearEndConversationRequest();
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._channel?.readyState === 'open') {
      this._channel.send(JSON.stringify({
        label: 'rtvi-ai',
        id: shortId(),
        type: 'disconnect-bot',
        data: {},
      }));
    }
    try { this._channel?.close(); } catch (_) {}
    this._channel = null;

    this._peer?.getReceivers?.().forEach((receiver) => receiver.track?.stop());
    this._peer?.getTransceivers?.().forEach((transceiver) => {
      try { transceiver.stop(); } catch (_) {}
    });
    try { this._peer?.close(); } catch (_) {}
    this._peer = null;
    this._localAudioTrack = null;

    this.resetAudioElement();
    this._remoteStream?.getTracks?.().forEach((track) => {
      try { track.stop(); } catch (_) {}
    });
    this._remoteStream = null;
    this._card.analyser?.detachAudio?.();
    this._card.mediaPlayer?.notifyAudioEnd?.('tts');

    this._card.chat.finishUser?.();
    this._card.chat.streamEl = null;
    this._card.chat.streamedResponse = '';

    if (restart) {
      this.playDoneChimeIfEnabled();
      this._card.chat.clear();
      this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
      this._card.mediaPlayer.resumeAfterInterrupt();
      this._card.setState(State.IDLE);
      this._pipeline.restart(0);
    }
  }

  playDoneChimeIfEnabled() {
    const satelliteId = this._card.config?.satellite_entity;
    if (getSwitchState(this._card.hass, satelliteId, 'wake_sound') === false) return;
    this._card.tts?.playChime?.('done');
  }

  clearEndConversationRequest() {
    if (this._endConversationTimer) {
      clearTimeout(this._endConversationTimer);
      this._endConversationTimer = null;
    }
    this._endConversationPending = false;
  }

  finishConversationAfterAssistant(delayMs = 350) {
    if (this._endConversationStopping) return;
    this._endConversationStopping = true;
    this.clearEndConversationRequest();
    window.setTimeout(() => {
      this.endConversation();
      this._endConversationStopping = false;
    }, delayMs);
  }

  requestConversationEnd(fallbackMs = 8000) {
    this._endConversationPending = true;
    if (this._endConversationTimer) clearTimeout(this._endConversationTimer);
    this._endConversationTimer = window.setTimeout(() => {
      this.finishConversationAfterAssistant(0);
    }, fallbackMs);
  }

  fail(message) {
    if (this._stopping) return;
    this._log.error('pipecat', message);
    this._card.toast?.show({
      id: 'pipecat-assist.connection-failed',
      severity: 'error',
      category: 'Pipecat Assist',
      description: message || 'Pipecat Assist connection failed.',
    });
    this.stop({ restart: false }).finally(() => {
      this._pipeline.serviceUnavailable = true;
      this._card.chat.clear();
      this._card.ui.hideBlurOverlay(BlurReason.PIPELINE);
      this._card.mediaPlayer.resumeAfterInterrupt();
      this._pipeline.restart(this._pipeline.calculateRetryDelay());
    });
  }

  apiPath(path) {
    if (!path) return '/api/pipecat_assist/offer';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return path.startsWith('/') ? path : `/${path}`;
  }

  authHeaders() {
    const token = this._card.hass?.auth?.data?.access_token
      || this._card.hass?.connection?.options?.auth?.data?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async loadAddonConfig() {
    const response = await fetch('/api/pipecat_assist/config', { headers: this.authHeaders() });
    if (!response.ok) throw new Error(`Pipecat Assist config failed with HTTP ${response.status}`);
    return response.json();
  }

  clientId() {
    const existing = localStorage.getItem(this._clientIdKey);
    if (existing) return existing;
    const created = randomId();
    localStorage.setItem(this._clientIdKey, created);
    return created;
  }

  sessionLanguage() {
    return this._card.hass?.language
      || this._card.hass?.locale?.language
      || navigator.language
      || 'en';
  }

  async waitForIce(peerConnection, timeoutMs = 2500) {
    if (peerConnection.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        peerConnection.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (peerConnection.iceGatheringState === 'complete') done();
      };
      timer = setTimeout(done, timeoutMs);
      peerConnection.addEventListener('icegatheringstatechange', onChange);
    });
  }

  sendClientReady() {
    if (this._channel?.readyState !== 'open') return;
    this._channel.send(JSON.stringify({
      label: 'rtvi-ai',
      id: shortId(),
      type: 'client-ready',
      data: {
        version: CLIENT_VERSION,
        about: {
          library: 'voice-satellite-card-pipecat-assist',
          library_version: CLIENT_VERSION,
          platform: 'home-assistant',
        },
      },
    }));
    this._pingTimer = window.setInterval(() => {
      if (this._channel?.readyState === 'open') this._channel.send(`ping ${Date.now()}`);
    }, 1000);
  }

  applyRemoteAudioBuffer(receiver) {
    if (!receiver) return;
    const targetMs = DEFAULT_AUDIO_BUFFER_MS;
    try {
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = targetMs;
    } catch (_) {}
    const targetSeconds = targetMs / 1000;
    for (const legacyName of ['playoutDelayHint', 'jitterBufferDelayHint']) {
      try {
        if (legacyName in receiver) receiver[legacyName] = targetSeconds;
      } catch (_) {}
    }
  }

  applyRemoteAudioBuffers(peer = this._peer) {
    peer?.getReceivers?.()
      .filter((receiver) => receiver.track?.kind === 'audio')
      .forEach((receiver) => this.applyRemoteAudioBuffer(receiver));
  }

  resetAudioElement() {
    this._audio.pause();
    this._audio.srcObject = null;
    this._audio.removeAttribute('src');
    try { this._audio.load(); } catch (_) {}
  }

  attachRemoteAudio() {
    if (!this._remoteStream) return;
    if (this._audio.srcObject !== this._remoteStream) this._audio.srcObject = this._remoteStream;
    this._audio.autoplay = true;
    this._audio.playsInline = true;
    this._audio.muted = false;
    this._audio.volume = 1;
    const playPromise = this._audio.play();
    if (this._card.isReactiveBarEnabled) {
      this._card.analyser?.attachAudio?.(this._audio, this._card.audio.audioContext);
    }
    this._card.mediaPlayer?.notifyAudioStart?.('tts');
    if (playPromise?.catch) {
      playPromise.catch((err) => {
        if (err?.name !== 'NotAllowedError' || this._audioBlocked) return;
        this._audioBlocked = true;
        this._card.toast?.show({
          id: 'pipecat-assist.audio-blocked',
          severity: 'warn',
          category: 'Pipecat Assist',
          description: 'Audio is connected, but the browser blocked playback. Tap the page and retry.',
        });
      });
    }
  }

  textFromEvent(data) {
    if (!data || typeof data !== 'object') return '';
    const nested = data.data && typeof data.data === 'object' ? data.data : {};
    return firstString(
      data.text,
      data.transcript,
      data.message,
      data.content,
      data.delta,
      nested.text,
      nested.transcript,
      nested.message,
      nested.content,
      nested.delta,
    );
  }

  assistantEchoReferences() {
    return [
      this._assistantTurnText,
      this._assistantLastTurnText,
      this._assistantTranscript,
    ].filter(Boolean);
  }

  cleanUserSpeechText(text) {
    let cleaned = normalizeTranscriptText(text);
    for (const reference of this.assistantEchoReferences()) {
      cleaned = removeTranscriptEchoSpan(cleaned, reference);
    }
    return cleaned;
  }

  rememberUserTurn(text = this._currentUserText, at = Date.now()) {
    const normalized = normalizeTranscriptText(text);
    if (!normalized) return;
    this._lastUserTurnText = normalized;
    this._lastUserTurnFinishedAt = at;
  }

  isLateUserTranscriptReplay(cleanedText, now) {
    const references = [
      this._currentUserText,
      this._lastUserTurnText,
    ].filter(Boolean);
    if (!references.length) return false;

    const assistantAlreadyMovedOn = this._assistantTurnActive
      || this._lastAssistantTextAt > this._currentUserUpdatedAt
      || this._assistantLastTurnFinishedAt > this._lastUserTurnFinishedAt;
    const recentUserTurn = this._lastUserTurnFinishedAt && now - this._lastUserTurnFinishedAt < 15000;
    const recentAssistantTurn = this._lastAssistantTextAt && now - this._lastAssistantTextAt < 15000;
    if (!assistantAlreadyMovedOn || (!recentUserTurn && !recentAssistantTurn)) return false;
    return references.some((reference) => isSameTranscriptTurn(cleanedText, reference));
  }

  ensureLocalAudioTrackActive() {
    const audio = this._card.audio;
    audio?.setMicTracksMuted?.(false);

    const currentTrack = audio?._mediaStream?.getAudioTracks?.()[0] || null;
    if (currentTrack) currentTrack.enabled = true;

    const hasLiveSender = this._peer?.getSenders?.()
      .some((sender) => sender.track?.kind === 'audio' && sender.track.readyState !== 'ended');
    if (hasLiveSender) {
      this._localAudioTrack = this._peer.getSenders()
        .find((sender) => sender.track?.kind === 'audio' && sender.track.readyState !== 'ended')?.track
        || this._localAudioTrack;
      return;
    }

    if (!currentTrack || currentTrack.readyState === 'ended') return;
    const sender = this._peer?.getSenders?.().find((candidate) => candidate.track?.kind === 'audio' || !candidate.track);
    if (!sender || sender.track === currentTrack) return;
    sender.replaceTrack(currentTrack)
      .then(() => {
        this._localAudioTrack = currentTrack;
        this._log.log('pipecat', 'Re-attached live microphone track to Pipecat WebRTC sender');
      })
      .catch((e) => {
        this._log.error('pipecat', `replaceTrack failed: ${e?.message || e}`);
      });
  }

  beginAssistantTurn(stage = State.TTS) {
    if (this._assistantTurnFinishTimer) {
      clearTimeout(this._assistantTurnFinishTimer);
      this._assistantTurnFinishTimer = null;
    }
    this.rememberUserTurn();
    if (!this._assistantTurnActive) {
      this._assistantTurnBase = normalizeTranscriptText(this._assistantTranscript);
      this._assistantTurnText = '';
      this._assistantTurnPriority = 0;
      this._assistantTurnActive = true;
      this._card.chat.streamEl = null;
      this._card.chat.streamedResponse = '';
    }
    this._ignoreLocalSpeechUntil = Date.now() + 1200;
    this._card.setState(stage);
  }

  finishAssistantTurn() {
    if (this._assistantTurnFinishTimer) {
      clearTimeout(this._assistantTurnFinishTimer);
      this._assistantTurnFinishTimer = null;
    }
    this._assistantTranscript = normalizeTranscriptText(this._assistantTranscript);
    this._assistantTurnBase = this._assistantTranscript;
    if (this._assistantTurnText) {
      this._card.chat.showResponse(this._assistantTurnText);
      this._assistantLastTurnText = this._assistantTurnText;
      this._assistantLastTurnPriority = this._assistantTurnPriority;
      this._assistantLastTurnFinishedAt = Date.now();
      this._lastAssistantTextAt = this._assistantLastTurnFinishedAt;
      this.fireChatEvent();
    }
    this._assistantTurnText = '';
    this._assistantTurnPriority = 0;
    this._assistantTurnActive = false;
    this._card.chat.streamEl = null;
    this._card.chat.streamedResponse = '';
    if (this._endConversationPending) {
      this.finishConversationAfterAssistant(350);
      return;
    }
    if (this._started) {
      this.ensureLocalAudioTrackActive();
      this._card.setState(State.STT);
    }
  }

  scheduleAssistantTurnFinish(delayMs = 1000) {
    if (this._assistantTurnFinishTimer) clearTimeout(this._assistantTurnFinishTimer);
    this._ignoreLocalSpeechUntil = Date.now() + delayMs;
    this._assistantTurnFinishTimer = window.setTimeout(() => this.finishAssistantTurn(), delayMs);
  }

  applyUserText(text, finalEvent) {
    const cleanedText = this.cleanUserSpeechText(text);
    if (!cleanedText) return;
    if (this.assistantEchoReferences().some((reference) => isLikelyTranscriptEcho(cleanedText, reference))) return;
    const now = Date.now();
    if (this.isLateUserTranscriptReplay(cleanedText, now)) {
      this._log.log('pipecat', `Ignoring late user transcript replay: ${cleanedText}`);
      this.ensureLocalAudioTrackActive();
      return;
    }
    this._lastUserTextAt = now;
    const startsNewUserTurn = this._lastAssistantTextAt > this._currentUserUpdatedAt
      || (!this._partialTranscript && this._currentUserUpdatedAt && now - this._currentUserUpdatedAt > 8000);
    if (finalEvent) {
      this._currentUserText = startsNewUserTurn
        ? cleanedText
        : mergeDisplayTurnText(this._currentUserText, cleanedText);
      this._currentUserUpdatedAt = now;
      this._userTranscript = mergeTranscript(this._userTranscript, cleanedText);
      this._partialTranscript = '';
      this.rememberUserTurn(this._currentUserText, now);
    } else {
      this._partialTranscript = cleanedText;
      this._currentUserText = startsNewUserTurn
        ? cleanedText
        : mergeDisplayTurnText(this._currentUserText, cleanedText);
      this._currentUserUpdatedAt = now;
    }
    this._card.chat.updateUser?.(this._currentUserText, startsNewUserTurn);
    if (finalEvent) this._card.chat.finishUser?.();
    this.ensureLocalAudioTrackActive();
    this._card.setState(State.STT);
    if (shouldEndConversation(`${this._currentUserText} ${this._partialTranscript}`)) {
      this.requestConversationEnd(9000);
    }
  }

  applyAssistantText(text, priority) {
    if (isLikelyTranscriptEcho(text, mergeTranscript(this._currentUserText, this._partialTranscript))) return;
    const normalizedText = normalizeTranscriptText(text);
    if (!normalizedText) return;
    const now = Date.now();
    const recentAssistantReplayWindow = this._assistantLastTurnFinishedAt
      && this._lastUserTextAt < this._assistantLastTurnFinishedAt
      && now - this._assistantLastTurnFinishedAt < 4500;
    const assistantReference = mergeTranscript(this._assistantTranscript, this._assistantTurnText);
    if (
      (recentAssistantReplayWindow && isLikelyTranscriptEcho(normalizedText, this._assistantLastTurnText))
      || (recentAssistantReplayWindow && priority <= (this._assistantLastTurnPriority || 0)
        && isLikelyTranscriptEcho(normalizedText, assistantReference))
    ) return;

    this.beginAssistantTurn(State.TTS);
    const previousPriority = this._assistantTurnPriority || 0;
    if (priority > previousPriority) {
      this._assistantTurnPriority = priority;
      this._assistantTurnText = mergeAssistantTurnText(
        this._assistantTurnText,
        normalizedText,
        priority,
        previousPriority,
      );
    } else if (priority === this._assistantTurnPriority) {
      this._assistantTurnText = mergeAssistantTurnText(
        this._assistantTurnText,
        normalizedText,
        priority,
        this._assistantTurnPriority,
      );
    } else {
      return;
    }
    this._assistantTranscript = mergeTranscript(this._assistantTurnBase, this._assistantTurnText);
    this._lastAssistantTextAt = Date.now();
    this._ignoreLocalSpeechUntil = Date.now() + 1200;
    this._card.chat.streamedResponse = this._assistantTurnText;
    this._card.chat.updateResponse(this._assistantTurnText);
    if (shouldEndConversation(this._assistantTranscript)) {
      this.requestConversationEnd(5000);
    }
  }

  handleRealtimeMessage(raw) {
    if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch (_) {
      return;
    }
    const type = String(message.type || message.event || message.name || '').toLowerCase();
    const label = String(message.label || '').toLowerCase();
    if (['conversation-ended', 'conversation_end', 'end-conversation'].includes(type)) {
      this.requestConversationEnd(1200);
      return;
    }

    if (type === 'bot-llm-started') this.beginAssistantTurn(State.INTENT);
    if (type === 'bot-tts-started' || type === 'bot-started-speaking') this.beginAssistantTurn(State.TTS);
    if (type === 'bot-llm-stopped' || type === 'bot-tts-stopped' || type === 'bot-stopped-speaking') {
      this.scheduleAssistantTurnFinish();
    }

    const text = this.textFromEvent(message);
    if (!text) return;

    const finalEvent = type === 'user-llm-text'
      || type.includes('final')
      || Boolean(message.data?.final || message.is_final || message.final);

    if (isRtviUserTextType(type)) {
      this.applyUserText(text, finalEvent);
      return;
    }

    if (isRtviAssistantTextType(type) || (label.includes('bot') && !type.startsWith('user-'))) {
      this.applyAssistantText(text, rtviAssistantTextPriority(type) || 1);
    }
  }

  endConversation() {
    if (!this._started) return;
    this.stop({ restart: true });
  }

  fireChatEvent() {
    const { hass, config } = this._card;
    if (!hass?.connection || !config?.satellite_entity) return;
    const sttText = normalizeTranscriptText(this._currentUserText || this._userTranscript);
    const ttsText = normalizeTranscriptText(this._assistantTurnText || this._assistantLastTurnText);
    if (!sttText && !ttsText) return;
    hass.connection.sendMessagePromise({
      type: 'voice_satellite/fire_chat_event',
      entity_id: config.satellite_entity,
      stt_text: sttText,
      tts_text: ttsText,
      tool_calls: [],
      conversation_id: null,
      is_continuation: true,
      continue_conversation: this._started,
      language: this.sessionLanguage(),
    }).catch((e) => {
      this._log.error('pipecat', `fire_chat_event failed: ${e?.message || e}`);
    });
  }
}
