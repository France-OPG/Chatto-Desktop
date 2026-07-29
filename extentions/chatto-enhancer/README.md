# Chatto Enhancer

Two things Chatto doesn't have yet, added from the browser side:

1. **Per-person volume** in voice calls — a slider on each participant card, 0–100%.
2. **An emoji picker** — a grey smiley next to the send button.

Nothing is sent anywhere and no server changes are needed. The extension only
reads Chatto's page and appends its own elements, so a Chatto update can at
worst stop the controls appearing — it can't break the app.

---

## Install (Chromium, Chrome, Edge, Brave, Opera)

1. Unzip this folder somewhere permanent. **Don't delete it afterwards** —
   Chrome loads the extension from this folder every time it starts.
2. Go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Reload your Chatto tab

To update later: replace the files, then hit the refresh icon on the
extension's card in `chrome://extensions`.

### Adding another Chatto server

Out of the box it runs on `chat.chatto.run` and `chatto.pixel-box.net`. For
another domain, add a line to `matches` in `manifest.json`:

```json
"matches": [
  "https://chat.chatto.run/*",
  "https://chatto.pixel-box.net/*",
  "https://chat.example.com/*"
]
```

Then reload the extension.

---

## Volume

A thin bar sits along the bottom of each person in the Call panel. Hover a
person and it thickens with a knob and a percentage readout.

| Action | Result |
|---|---|
| Scroll wheel over a person | ±5% |
| Shift + scroll | ±1% for fine adjustment |
| Drag the bar | Jump straight to a level |
| Double-click the bar | Back to 100% |
| Arrow keys (once focused) | ±5% |
| Home / End | Mute / full |

0% turns the bar red and reads **Muted**.

Levels are saved per person and come back next time — including if they leave
and rejoin, or you restart the browser.

**If the list of people ever gets long enough to need scrolling**, the wheel
will fight you, because it's being used for volume. Open `content.js` and
change `WHEEL_TARGET` near the top from `'card'` to `'slider'`; the wheel then
only works directly over the bar.

---

## Emoji

Click the grey smiley to the left of the send button.

- Type in the search box to filter (searches emoji names — "pizza", "heart", "cat")
- Nine category tabs across the top jump to that section
- Emoji you use are remembered under **Recently used**
- **Shift-click** an emoji to keep the picker open and add several
- **Escape**, or a click outside, closes it

The emoji is inserted at your cursor, so you can drop one mid-sentence rather
than only at the end.

1,898 emoji, bundled in the extension — no network requests, nothing loaded at
runtime.

---

## How the volume control works

Worth knowing, because it explains why v1.0 and v1.1 didn't work.

Chatto plays voice audio by calling LiveKit's `track.attach()` with no
argument (`voiceCall.svelte.ts`, on `TrackSubscribed`). LiveKit creates an
`<audio>` element internally and **never inserts it into the page** — playback
doesn't require that. So those elements are invisible to
`document.querySelectorAll('audio')`; they exist only as JavaScript objects
inside LiveKit.

The extension therefore runs a second script (`main-world.js`) inside the
page's own JavaScript context, which catches every `<audio>` as it is created
and replaces its `volume` property so that

    what you hear = what Chatto asked for x your slider

Two consequences worth knowing:

- Chatto re-applies its own volume on every track event. Because we intercept
  the write instead of overwriting afterwards, your setting survives.
- Chatto's own per-person mute button still wins outright. It sets volume to
  0, and zero times anything is zero. That's the right precedence: an explicit
  mute shouldn't be undone by a slider.

Matching a slider to a person: (see below)

Matching a slider to a person: when Chatto loops over the call participants to
set their volumes, it does so in the same order the cards appear on screen.
The extension watches that burst of writes and lines it up against the cards.
It re-learns this every time someone joins or leaves.

Matching a slider to a person happens two ways. Position is the first guess,
but it goes wrong when someone has a participant card and no audio stream —
they joined with no working microphone — because every position after them
shifts by one.

So the extension also listens. It measures how loud each stream is and
compares that against whichever card Chatto is showing as speaking. When the
two agree three times running, that person is matched for certain. This
needs a few seconds of someone actually talking, and it corrects a wrong
guess rather than waiting for one.

The measuring tap is never connected to the output, so it cannot change what
you hear.

If a slider still controls the wrong person, open DevTools, switch the console
context from **top** to **Chatto Enhancer**, and run `__ceDebug()` — it prints
the mapping and what has been matched by voice so far. `__ceReset()` puts
everyone back to 100%.

## Uninstall

Remove it from `chrome://extensions`. Chatto is untouched — there's nothing to
clean up.
