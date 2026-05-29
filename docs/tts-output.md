# TTS Output

The **TTS Output** select on each satellite device controls where the assistant's spoken response is played. By default it plays locally in the browser tab running Voice Satellite, but it can also be routed to any other Home Assistant `media_player` entity - a smart speaker, an HA media group, a Chromecast-attached TV, an ESP32-based satellite, anything that HA already exposes as a media player.

The same routing applies to the wake/done/error chimes so the audible feedback always travels with the voice.

## Contents

- [Browser (default)](#browser-default)
- [Remote `media_player`](#remote-media_player)
- [Remote TTS Output behavior](#remote-tts-output-behavior)
- [Which behavior fits your speaker](#which-behavior-fits-your-speaker)
- [Caveats for Normal Playback](#caveats-for-normal-playback)
- [Switching between options](#switching-between-options)

## Browser (default)

When **TTS Output** is set to "Browser", everything plays through the browser tab on the device running Voice Satellite. The audio is emitted by the tablet/PC's own speakers (or whatever HDMI/Bluetooth output the OS routes browser audio to). Wake chime, TTS, and done chime all hit the tablet directly with zero network hops.

- **Latency**: lowest. Audio is decoded and played by the same process that ran STT, so chime-to-mic timing is tight and TTS starts within a frame of receiving the audio.
- **Volume control**: the satellite's own `media_player` entity (the one named after the satellite) drives volume for browser playback. Targeting it with `media_player.volume_set` adjusts what the browser plays.
- **Other media on the device**: the browser's `<audio>` element shares the OS audio mixer with anything else on the tablet. The satellite pauses its own local media (managed via the satellite's `media_player` entity) during interactions; it does not touch audio from other apps.

Pick Browser when the tablet running Voice Satellite *is* the speaker, or when you want to keep voice and any other audio on the same device fully isolated from other smart speakers in the room.

## Remote `media_player`

Selecting any non-"Browser" entry in the **TTS Output** dropdown routes the satellite's chimes and TTS to that media player instead. The dropdown is populated from every `media_player` entity HA knows about, minus the satellite's own entity.

Typical reasons to route TTS to a remote player:

- The tablet is a wall-mounted display with no speakers, and a dedicated speaker (Sonos, ESPHome, Cast group, etc.) covers the room.
- You want a single household speaker to handle voice across multiple satellites.
- The remote speaker is louder, has better directivity, or is positioned for the user's listening spot.

When **TTS Output** points at a remote player, the satellite issues `media_player.play_media` against that entity for every chime and TTS clip. From the satellite's perspective the call is fire-and-forget; what the speaker does with that call depends on the speaker's HA integration and firmware.

## Remote TTS Output behavior

Home Assistant's `media_player.play_media` accepts an `announce: true` flag that asks the speaker to **duck or pause whatever it's currently playing**, **play the announcement**, then **restore the prior media**. Some integrations honor that contract end-to-end; many silently ignore the flag and just play the requested content as a normal item, which kills whatever was playing and never brings it back.

The **TTS Output behavior (remote)** select on the integration page picks how the satellite uses that flag and whether the satellite has to do the resume work itself. It's automatically unavailable when **TTS Output** is "Browser" since browser playback never touches a remote speaker.

| Option | Behavior | Pick this when... |
|--------|----------|-------------------|
| **Announcement** (default) | The satellite issues `play_media` with `announce: true` for both chimes and TTS. The speaker is responsible for ducking or pausing prior media, playing the satellite audio, then restoring playback on its own. | Your speaker honors `announce: true` cleanly. Sonos, the official ESPHome `media_player`, and Music Assistant Universal Group with announce-capable members all work in this mode. You'll hear the music duck during the chime/TTS, then come back automatically. |
| **Normal Playback** | The satellite snapshots the speaker's current `media_content_id` and playback position *before* the wake chime fires, then issues `play_media` *without* `announce: true` for chime, TTS, and done chime. After the interaction ends, the satellite re-issues `play_media` for the snapshotted content and seeks back to the captured position. | Your speaker silently ignores the `announce` flag and just replaces whatever it was playing. Google Cast (Nest speakers, Chromecast Audio, TVs), generic UPnP/DLNA, and most Bluetooth-bridged media players fall into this group. Without this mode they leave the user's music dead after a single voice interaction. |

In Normal Playback the restore happens at the very end of the interaction, after the trailing done chime, so the user hears: chime, TTS, done chime, then their music resumes near where it left off. Stop word and double-tap cancellation also restore the music - the satellite preserves the snapshot through cancellation and the trailing done chime fires the restore.

## Which behavior fits your speaker

The fastest way to tell which option you need is to try one voice interaction with music playing on your TTS Output speaker. Set the behavior to **Announcement** first and listen for what happens after the assistant finishes speaking.

- **Music resumes on its own**: you have an announce-honoring speaker. Leave the setting at "Announcement".
- **Music stays stopped or you have to manually press play**: switch to "Normal Playback".

You can also confirm independently in **Developer Tools -> Actions** by calling `media_player.play_media` with `announce: true` against the speaker while music is playing. Use any short audio file as the `media_content_id`. If the music doesn't resume on its own after the test clip ends, your speaker doesn't honor announce and you need Normal Playback.

## Caveats for Normal Playback

The snapshot-and-restore strategy is robust for most use cases, but it does have inherent limits because it re-issues `play_media` rather than truly resuming a paused session:

- **Position seek depends on the source.** Local file playback, internet radio addressed by URL, and most Music Assistant tracks accept `media_seek` and resume close to the original position. Live HLS and live internet streams have no seekable position so the restore effectively continues at "live" (acceptable for radio, fine for cameras).
- **Queue context is not preserved.** If the user was playing track 4 of a Music Assistant or Spotify playlist, the restore plays track 4 by itself - it does not put the playlist back as the active queue. Most users won't notice unless they were about to skip to the next track.
- **Session-bound URIs may not replay.** A few sources (some Spotify URIs without an active Connect device, expired stream tokens) cannot be re-played from a stored `media_content_id`. These are rare in practice; if you hit one, the restore will silently fail and the speaker will just sit idle after the interaction.
- **Restore fires after the done chime.** There's a brief gap (~0.3-0.8 seconds) between when the TTS finishes and when the music resumes, because the satellite waits for the trailing done chime to finish before restoring. This is by design - restoring earlier would just be clobbered by the done chime.

If your speaker honors `announce` properly, **Announcement** mode is always the better choice. It hands off the entire duck/restore cycle to the speaker, which preserves queue context, exact playback position, and session state without any guesswork on the satellite's side.

## Switching between options

Both **TTS Output** and **TTS Output behavior (remote)** persist across restarts and apply immediately - no integration reload required. Changes take effect on the next voice interaction.

If you change **TTS Output** mid-interaction, the in-flight interaction continues to play on the previously selected target; the new selection applies starting from the next wake word. The same applies to switching the behavior between Announcement and Normal Playback.
