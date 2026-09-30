# Thumbs Feedback

A kiosk website for collecting student feedback. The screen shows a statement, and a student answers by holding a **👍 thumbs up (agree)** or **👎 thumbs down (disagree)** in front of the camera for **3 seconds**. Hand tracking runs in the browser with [MediaPipe Gesture Recognizer](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer). Video never leaves the device. Only the answer is sent to the server.

## Running it

Requires Node.js 22.13 or newer. It uses the built-in `node:sqlite`, so there are no native dependencies.

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

- Kiosk: <http://localhost:3000>
- Admin: <http://localhost:3000/admin>

If `ADMIN_PASSWORD` isn't set, the password is `admin`. Set a real one before using it with students.

Votes are stored in `data/feedback.db`. Delete that file to start over.

## How the kiosk works

1. **Idle.** The statement and the live camera feed are shown.
2. **Holding.** When a 👍 or 👎 is detected with at least 70% confidence, a ring fills over 3 seconds. If the student switches thumbs, the ring starts over. If they drop the gesture, it resets. A 250 ms grace period absorbs single missed frames.
3. **Recorded.** The vote is saved and the current agree/disagree percentages are shown for 4 seconds.
4. **Cooldown.** The kiosk waits until no hand has been visible for 1 second before it accepts the next vote. This prevents the same student from voting twice.

The kiosk checks for a new statement every 5 seconds. The timings are defined at the top of `public/kiosk.js`.

## Admin page

- Publish a new statement. Each statement keeps its own results.
- See live counts and percentages for the current statement.
- See the history of every statement and its results.
- Export all votes as CSV.

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/statement` | – | Current statement `{id, text, created_at}` |
| POST | `/api/statement` | admin | `{text}` publishes a new statement |
| POST | `/api/votes` | – | `{statementId, answer: "agree" \| "disagree"}` returns the updated results |
| GET | `/api/results?statementId=` | – | Counts and percentages (defaults to the current statement) |
| GET | `/api/history` | admin | All statements with their counts |
| GET | `/api/export.csv` | admin | All votes as CSV |

Admin requests send the password in the `x-admin-password` header.

## Camera and HTTPS

Browsers only allow camera access on **`localhost` or HTTPS**. Running the server and kiosk on the same machine works as is. If the kiosk runs on a different device, such as a tablet, serve the site over HTTPS, for example:

- Deploy it to a host that provides HTTPS (Render, Railway, Fly.io, etc.). Note that the SQLite file needs persistent storage there.
- Or tunnel your local server with `npx localtunnel --port 3000`, or use `cloudflared tunnel --url http://localhost:3000`.

## Tips for the kiosk

- Put the browser in full screen (F11, or ⌃⌘F on macOS). Chrome's `--kiosk` flag also works.
- Use even, front-facing light. Gestures are recognized most reliably when the hand is roughly 0.5–1.5 m from the camera.
- The kiosk needs internet on first load to download the MediaPipe model (about 8 MB) from the CDN.
