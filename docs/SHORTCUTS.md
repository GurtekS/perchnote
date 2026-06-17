# Automating Perchnote with URL schemes

Perchnote registers the `perchnote://` URL scheme, which makes it scriptable
from anything that can open a URL: Apple Shortcuts, Raycast, Stream Deck,
Alfred, cron, or a plain shell. Everything runs locally, and opening a link
never touches the network.

## Supported links

| Link | Action |
|---|---|
| `perchnote://record/start` (or `perchnote://record`) | Start recording. Creates a new meeting if none is in progress; brings the app forward. |
| `perchnote://record/start?title=<title>` | Same, but the new meeting is named `<title>` (URL-encode it; capped at 200 chars). |
| `perchnote://record/stop` | Stop the current recording and kick off transcription. |
| `perchnote://meeting/<uuid>` | Open a specific meeting. |
| `perchnote://meeting/<uuid>/transcript` | Open a specific meeting with the transcript drawer popped. |
| `perchnote://search?q=<query>` | Open the command palette pre-filled with `<query>`. The full search grammar (`speaker:"Amy"`, `folder:`, `before:`/`after:`) works exactly as if typed. |

Anything else is ignored: unknown links are dropped, and `meeting/` links
must carry a valid UUID.

## x-callback-url

Every verb accepts the standard [x-callback-url](https://x-callback-url.com)
companion params, and `perchnote://x-callback-url/<verb>` works as an alias
for `perchnote://<verb>`:

- `x-success=<url>` is opened after the action is dispatched.
- `x-error=<url>` is opened (with `?errorMessage=<why>` appended) when the
  link doesn't parse.

Callback URLs may only be `shortcuts://x-callback-url/…`, the resume shape
Apple Shortcuts itself supplies. Anything else is refused, including
`shortcuts://run-shortcut` (it would *execute* an automation, not resume
one) and `http(s)`: a webpage can trigger `perchnote://` links, and
callbacks must not become a way to launder app or automation launches
through Perchnote.

```
perchnote://x-callback-url/record/start?title=Standup&x-success=shortcuts%3A%2F%2F
```

In Apple Shortcuts, use the **Open X-Callback URL** action with
`perchnote://record/start?title=Standup`. Shortcuts appends `x-success`
itself and resumes the shortcut when Perchnote calls it back.

Where meeting links come from (you never type a UUID by hand):

- **Obsidian/markdown mirror.** Every mirrored note's frontmatter has a
  `perchnote: perchnote://meeting/…` key. In Obsidian, the link jumps you
  from the vault note straight back to the meeting in Perchnote.
- **Things hand-off.** Tasks sent to Things carry the meeting link in
  their notes, so a to-do always points back to the meeting it came from.

## Recipes

### Apple Shortcuts: start/stop recording from anywhere

1. Shortcuts → **+** → search for the **Open URLs** action.
2. Set the URL to `perchnote://record/start`.
3. Name it "Start Meeting Recording".
4. In the shortcut's settings (ⓘ), add it to the menu bar, or assign a
   keyboard shortcut under **Use as Quick Action → Keyboard**.

Make a second one with `perchnote://record/stop` ("Stop Meeting Recording").

### Apple Shortcuts: auto-record a recurring meeting

Shortcuts → **Automation** tab → **+** → **Time of Day** → pick the weekly
slot your standup starts → add the **Open URLs** action with
`perchnote://record/start` → set **Run Immediately** (macOS 13+ runs
time-of-day automations without confirmation).

### Raycast script command

Save as `start-recording.sh` in your Raycast script directory:

```bash
#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Start Meeting Recording
# @raycast.mode silent
# @raycast.icon 🎙️
open "perchnote://record/start"
```

### Stream Deck

Add a **System → Website** action with `perchnote://record/start` as the
URL and check "Open in background" off. That gives you one physical
button to start recording.

### Shell / anything else

```bash
open "perchnote://record/start"
open "perchnote://record/start?title=Design%20Review"
open "perchnote://record/stop"
open "perchnote://meeting/c075ff8d-5e65-4087-bce7-ba0f4391e476"
open "perchnote://meeting/c075ff8d-5e65-4087-bce7-ba0f4391e476/transcript"
open "perchnote://search?q=roadmap%20speaker%3A%22Amy%22"
```

## Notes

- If Perchnote isn't running, opening any `perchnote://` link launches it
  first; the action runs once the app is up.
- `record/start` while already recording is a no-op (it won't start a
  second session); `record/stop` while idle is likewise ignored.
- App Intents (native Shortcuts actions with parameters) are on the
  roadmap; the URL scheme is the stable contract today.
