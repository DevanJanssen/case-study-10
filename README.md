# Gesture Feedback

A kiosk website for collecting student feedback with hand gestures. There are two variants, and you pick one per statement on the admin page:

- **👍👎 Agree / disagree.** The student holds a thumbs up (agree) or thumbs down (disagree) in front of the camera for **3 seconds**.
- **⭐ 1–5 stars.** Five outline stars are shown along the top of the camera view. The student points their index finger at a star, which fills that star and all the stars before it, and holds it for **3 seconds** to submit the rating.

Hand tracking runs in the browser with [MediaPipe Gesture Recognizer](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer). Video never leaves the device. Only the answer is sent to the server.

## Running it

Requires Node.js 22.13 or newer. It uses the built-in `node:sqlite`, so there are no native dependencies.

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

- Kiosk: <http://localhost:3000>
- Admin: <http://localhost:3000/admin>

If `ADMIN_PASSWORD` isn't set, the password is `admin`. Set a real one before using it with students.

Responses are stored in `data/feedback.db`. Set `DB_PATH` to use a different file, or delete the file to start over. Thumbs votes go in the `votes` table and star ratings in the `ratings` table. Older databases are migrated automatically when the server starts.

## How the kiosk works

1. **Idle.** The statement and the live camera feed are shown.
2. **Holding.** The kiosk fills a 3-second hold timer. A 250 ms grace period absorbs single missed frames.
   - *Thumbs.* When a 👍 or 👎 is detected with enough confidence (`MIN_SCORE`), a large ring fills. If the student switches thumbs, it starts over. If they drop the gesture, it resets.
   - *Stars.* A cursor follows the index fingertip, but only while the index finger is extended. When the cursor is on a star, that star and the stars before it fill, and the ring around the cursor fills. Moving to another star restarts the timer.
3. **Recorded.** The answer is saved, and the current results are shown for 4 seconds: agree/disagree percentages, or the average rating plus a 1–5 distribution.
4. **Cooldown.** The kiosk waits until no hand has been visible for 1 second before it accepts the next answer. This prevents the same student from answering twice.

The kiosk checks for a new statement, and therefore a new variant, every few seconds. The timings, the star hit area and the cursor smoothing are defined at the top of `public/kiosk.js`.

## Admin page

- Publish a new statement and choose its variant: 👍👎 or ⭐. Each statement keeps its own results.
- **Switch variant.** This republishes the current statement with the other variant.
- See live counts and percentages for the current statement.
- See the history of every statement and its results.
- Export all responses (votes and ratings) as CSV.

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/statement` | – | Current statement `{id, text, mode, created_at}`, where `mode` is `thumbs` or `stars` |
| POST | `/api/statement` | admin | `{text, mode}` publishes a new statement |
| POST | `/api/votes` | – | `{statementId, answer: "agree" \| "disagree"}` for thumbs, or `{statementId, rating: 1–5}` for stars. Returns the updated results |
| GET | `/api/results?statementId=` | – | Counts and percentages (defaults to the current statement) |
| GET | `/api/history` | admin | All statements with their counts |
| GET | `/api/export.csv` | admin | All votes and ratings as CSV |

Admin requests send the password in the `x-admin-password` header.

## Camera and HTTPS

Browsers only allow camera access on **`localhost` or HTTPS**. Running the server and kiosk on the same machine works as is. If the kiosk runs on a different device, such as a tablet, serve the site over HTTPS, for example:

- Deploy it to a host that provides HTTPS (Render, Railway, Fly.io, etc.). Note that the SQLite file needs persistent storage there.
- Or tunnel your local server with `npx localtunnel --port 3000`, or use `cloudflared tunnel --url http://localhost:3000`.

## Tips for the kiosk

- Put the browser in full screen (F11, or ⌃⌘F on macOS). Chrome's `--kiosk` flag also works.
- Use even, front-facing light. Gestures are recognized most reliably when the hand is roughly 0.5–1.5 m from the camera.
- The kiosk needs internet on first load to download the MediaPipe model (about 8 MB) from the CDN.
