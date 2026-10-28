# MIDI Sketch

A phone-first, offline-capable PWA for sketching melodies, basslines, and drum grooves — built for writing music on planes, exporting standard `.mid` files that drag-and-drop into REAPER.

**Live:** https://unlockedagency.github.io/midisketch/
**Install:** open the URL in iPhone Safari → Share → **Add to Home Screen** → launch once online. After that it works fully offline (verified in airplane mode).

Built Oct 27–28, 2026 in a rapid build/QA loop (11 versions in two days). No framework, no build step, no dependencies — three hand-written files served from GitHub Pages.

---

## What it does

- **Synth clips** — a chord-locked step grid. Each bar has its own chord (e.g. Am → F → C → G); the grid only enables that bar's chord tones, so melodies can't land on sour notes. Rows show note name + scale degree (1, b3, 5), root rows in amber. A **Spice** toggle reveals passing tones (2nds/4ths/6ths/7ths) as dimmed rows.
- **Drum clips** — an 8-lane TR-style grid (Kick, Snare, Clap, CH/OH Hat, Ride, Tom, Cowbell) with two synthesized kits: **909 House** and **808 HipHop**. Closed hat chokes open hat like real TR hardware.
- **Six synth voices**, all WebAudio-synthesized and deliberately dark-voiced (harsh-highs sensitivity): Buzz Lead (7-voice stereo supersaw), Acid Bass (24dB cascaded filter ladder with drive), House Pluck, 808 Sub (pitch-drop), BoC Pad (tape-wobble, 3s release), Lo-fi Keys.
- **FX bus**: tempo-synced dotted-eighth ping-pong delay (dark feedback), convolver reverb (generated plate IR), stereo chorus on pad/keys. Per-voice send levels (sub stays dry). Delay/Reverb/Brightness controls in the Sound panel.
- **Groove backing**: a synth clip can play one of your saved drum clips behind it (replaces the metronome pulse presets).
- **Learning aids**: chord progression per bar, degree labels, stray-note flagging (red) with one-tap "snap to chord", backing pulse presets with genre-correct BPM/swing.

## Gestures (the whole interaction language)

| Gesture | Action |
|---|---|
| Tap empty cell | Add note (auditions instantly) |
| Tap a note | Delete it — always |
| Drag note sideways | Stretch (sustain), across bars too |
| Touch + **immediately** drag up/down | Gate/roll ×2 ×3 ×4 (label shows on note) |
| Hold perfectly still ~½s | Toggle accent (orange = louder) |
| Tap bar chip | View that bar |
| Tap current bar's chip again | Chord picker + bar tools (copy/paste/clear bar) |
| ◀ ▶ | Step through bars |

**Rolls**: on synths, a roll is a true *amplitude gate* — one sustained voice with its volume chopped (the Vital-gate-rig sound), not a retrigger stutter. On drums it retriggers (correct for hat rolls). Exports as real subdivided notes (triplets included).

**Grid 1/16 ↔ 1/32**: in 1/32 mode the same full-bar view stays; each cell splits into tappable left/right halves for true off-grid 32nd placement.

## Saving & export

- Clips autosave to `localStorage` (key `midisketch_v1`). ☰ menu: load/duplicate/delete/export per clip, **Backup (JSON)** and **Restore** (imports a backup, converts old-format files).
- **⬇ .mid** (header) — one clip, one standard SMF type-0 file. Synth clips on channel 1; drum clips on **channel 10 with General MIDI mapping** (kick 36, snare 38, CH 42…). PPQ 480, tempo embedded, accents = velocity 108 vs 78. Swing is deliberately NOT baked in (straight grid for REAPER editing).
- **Bundle .mid** (☰ menu) — select multiple clips → one SMF **type-1** file: tempo track with **chord-name markers**, a **"Chords (ref)"** track voicing the progression, then one named track per clip. REAPER auto-explodes it onto named tracks.
- iOS export goes through the share sheet (Save to Files / AirDrop); desktop downloads directly.

## Architecture

```
index.html   markup + all CSS (dark theme, thumb-sized targets, safe-area aware)
app.js       everything: state, grid, chord math, audio engine, SMF writer, storage
sw.js        service worker — cache-first, versioned cache name
manifest.webmanifest, icon-192/512.png (gen_icons.py regenerates, stdlib only)
```

Key internals (for future work):

- **Time resolution**: 32nd-note "units", 32/bar (`UPB`). Coarse grid snaps to 2-unit grain; fine mode places at 1 unit. One-time migration (`store.u32`) doubled pre-v6 note positions. Export: `UT=60` ticks/unit, `SPT=120` ticks/16th.
- **Scheduler**: 25ms `setInterval`, 0.12s lookahead against `AudioContext.currentTime`; swing offsets odd *16ths* (both halves equally); after main-thread stalls it skips missed steps silently. `stepQueue` drives the playhead via rAF.
- **Voices**: per-note node graphs → per-voice sends (`SENDS`) → master → brightness lowpass (~9kHz default) → compressor → destination. `voicePlay(..., opt)`: `opt === true` = tight envelope; `opt = {t,hd,hits,duty}` = scheduled amplitude gate (see `activeGate`/`route()`/`scheduleGate()`).
- **Drum voices**: `drumPlay(kit, gm, ...)` — per-GM-note synthesis, `lastOpenHat` implements the choke.
- **Chord math**: `CHORD_TYPES` (tones + spice intervals), `chordSets(bar)`, `computeRows()` unions chord tones across all bars so rows stay stable while per-bar enablement changes.
- **Undo**: 60-deep JSON snapshots of `{notes, progression, bars}`; `pushUndo()` precedes every mutation; cleared on clip switch.
- **Interaction state machine**: `ui.drag` modes `maybe → stretch | roll | done`; any movement cancels the long-press accent timer; `pointercancel` never mutates.

## Deploying changes

1. Edit files, **bump `CACHE` in sw.js** (e.g. `midisketch-v12`) **and the `verLabel` div in index.html** — they must move together; the cache bump is what makes installed phones refetch.
2. Commit, `git push` — GitHub Pages redeploys in ~30–60s (poll `curl https://unlockedagency.github.io/midisketch/sw.js`).
3. On the phone: the app shows a **"✨ Updated — tap to reload"** toast when the new version takes over (one legacy close-reopen needed only for pre-v11 installs).
4. Verify the version at the **top of the Sound ▾ panel**.

Local testing: `python3 -m http.server 8741` in this directory. Note: a previously registered service worker will serve the old cache — unregister it in DevTools (or bump the cache name) when testing locally.

## Known limits (deliberate)

- Bundle export stamps the **first selected clip's BPM**; mixed-tempo bundles conform to it. 13+ synth clips in one bundle share channel 16.
- Swing/pulse are 16th-based by design (swung 32nds sound drunk).
- The FX are monitoring-only; exported MIDI is always pure notes.
- iOS: audio needs one tap to start; the **ringer silent switch mutes web audio** (the 🔇/🔊 badge top-right shows state; tap it for a test blip).

## Version history (compressed)

v1 flight-ready core (grid/voices/export/PWA, user-verified in airplane mode) · v2 undo, copy/paste bar, play-from-bar, bar loop · v3 FX bus + supersaw + acid ladder · v4 drum clips, groove backing, bundle export · v5 real-device layout fixes, bar navigator · v6 32nd-unit engine, 1/32 grid, modeless roll · v7 sound-panel trap fix, sticky transport · v8 roll gesture forgiveness, iOS audio resume · v9 roll gate envelopes, note-fill fix · v10 true amplitude gate, split-cell 1/32 redesign · v11 QA hardening (7 fixes), update toast, restore, clear bar.

## Unbuilt shelf (future v12+ candidates)

- **Song mode** — chain clips into sections (A A B A), export one long file
- **ReaScript importer** — Lua script that builds a REAPER session from a folder of these files, inserting the user's real instruments per sketch voice
- Transpose clip ±semitones/octave · ghost-note velocity (3rd level) · phrase-overview mini-map · progression presets · reference `.wav` bounce of the loop
