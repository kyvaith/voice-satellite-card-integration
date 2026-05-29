/**
 * TTS Comms
 *
 * Remote media player service calls for TTS playback.
 * Pure comms - no timer scheduling or manager state mutation.
 */

/**
 * Play TTS on a remote media player entity.
 * Uses media-source:// URIs when available so HA resolves/proxies the audio
 * (required for devices like Sonos that can't fetch self-signed HTTPS URLs).
 * @param {object} card - Card instance
 * @param {string} mediaId - media-source:// URI or full media URL
 * @param {object} [options]
 * @param {boolean} [options.announce=true] - When true, sets announce=true on
 *   play_media so speakers that honor it duck/restore prior media. When false,
 *   issues a plain play_media (caller is responsible for capturing + restoring
 *   prior media state, used when the speaker ignores the announce flag).
 * @returns {Promise<void>}
 */
export function playRemote(card, mediaId, { announce = true } = {}) {
  const entityId = card.ttsTarget;

  card.logger.log('tts', `Playing on remote: ${entityId} media: ${mediaId} announce=${announce}`);

  return card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: mediaId,
    media_content_type: 'music',
    announce,
  }).catch((e) => {
    card.logger.error('tts', `Remote play failed: ${e?.message || JSON.stringify(e)}`);
    throw e;
  });
}

/**
 * Re-issue play_media on a remote media player to restore previously playing
 * content after a TTS interruption, then attempt to seek to the captured
 * position. Used by 'normal_playback' mode for speakers that ignore announce.
 *
 * Position restoration is best-effort:
 *  - `extra.current_time` is honored by Google Cast and a few others.
 *  - A delayed `media_seek` covers integrations that ignore `extra` but
 *    accept seek once playback has buffered. Both calls are safe no-ops on
 *    integrations that don't implement them.
 *
 * @param {object} card
 * @param {{id: string, type: string, position: number}} snapshot
 */
export function restoreRemote(card, snapshot) {
  const entityId = card.ttsTarget;
  if (!entityId || !card.hass) return;

  const { id, type, position } = snapshot;
  card.logger.log('tts', `Restoring on remote: ${entityId} media: ${id} pos=${position.toFixed(1)}s`);

  card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: id,
    media_content_type: type,
    extra: { current_time: position },
  }).catch((e) => {
    card.logger.error('tts', `Remote restore play_media failed: ${e?.message || e}`);
  });

  // Follow-up seek for integrations that ignore extra.current_time.
  // 1.5s is a pragmatic delay covering typical buffer/connect latency on
  // Cast and ESPHome speakers. Seek is a no-op on live sources.
  setTimeout(() => {
    card.hass.callService('media_player', 'media_seek', {
      entity_id: entityId,
      seek_position: position,
    }).catch(() => { /* unsupported / live stream / wrong content - silent */ });
  }, 1500);
}

/**
 * Stop playback on a remote media player entity.
 * @param {object} card - Card instance
 */
export function stopRemote(card) {
  if (!card.ttsTarget || !card.hass) return;

  card.hass.callService('media_player', 'media_stop', {
    entity_id: card.ttsTarget,
  }).catch((e) => {
    card.logger.error('tts', `Remote stop failed: ${e}`);
  });
}
