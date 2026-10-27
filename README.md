# Gesture Feedback

A kiosk website for collecting student feedback with hand gestures. You keep a list of questions on the admin page and assign each one to one or more variants. The kiosk runs one variant at a time and asks that variant's questions in random order. Until someone waves at it, the kiosk shows an idle screen. There are three variants:

- **👍👎 Agree / disagree.** The student holds a thumbs up (agree) or thumbs down (disagree) in front of the camera for **3 seconds**.
- **⭐ 1–5 stars.** Five outline stars are shown below the question. The student points their index finger at a star, which fills that star and all the stars before it, and holds it for **1 second** to submit the rating.
- **✋ 1–5 fingers.** The student holds up 1 to 5 fingers, thumb included, for **3 seconds**. The number of fingers is the rating. Numbered chips 1–5 light up to show the count the kiosk sees.

Hand tracking runs in the browser with [MediaPipe Gesture Recognizer](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer). Video never leaves the device. Only the answer is sent to the server.

## Running it

Requires Node.js 22.13 or newer and Docker ([OrbStack](https://orbstack.dev) or Docker Desktop) for the Postgres database.

```bash
docker compose up -d
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

- Kiosk: <http://localhost:3000>
- Admin: <http://localhost:3000/admin>

If `ADMIN_PASSWORD` isn't set, the password is `admin`. Set a real one before using it with students.

Questions and answers are stored in Postgres 17, which `docker-compose.yml` runs on `127.0.0.1:5434` with its data in the `pgdata` Docker volume. The server creates its tables on start. Set `DATABASE_URL` to use another database (default `postgres://feedback:feedback@localhost:5434/feedback`).

- `questions`: the text and the variants it is assigned to (`variants`, an array).
- `answers`: one row per answer, with the question, the variant it was given in, and `answer` (agree/disagree, thumbs) or `rating` (1–5, stars and fingers). Deleting a question deletes its answers.
- `settings`: the variant and camera the kiosk uses.

To start over, run `docker compose down -v`, which also deletes the volume.

### Importing the old SQLite data

Earlier versions stored everything in `data/feedback.db`. To copy that into Postgres once:

```bash
npm run import-sqlite
```

Statements with the same text become one question, assigned to every variant they were asked in, and their votes and ratings become that question's answers with the original timestamps. The import only runs into an empty database and never changes the SQLite file. Set `DB_PATH` to import a different file.

## How the kiosk works

1. **Idle.** A waving hand 👋 asks passers-by to wave, over the blurred camera feed. While a hand is visible, a green square follows it and shows the hand in colour, with the tracked joints drawn on top. The kiosk counts side-to-side swings of a raised, open hand (an open palm, or at least four raised fingers, with the fingers pointing up, give or take 60°: `WAVE_MAX_TILT`), and a row of dots fills as it does. A swing must move the hand sideways at least 0.9 palm length (`WAVE_SWING`), so it works at any distance from the camera, and further sideways than up or down. It must take at least 0.1 seconds (`WAVE_MIN_SWING_MS`), so a jump in the tracking doesn't count, and the next swing must follow within 0.8 seconds (`WAVE_GAP_MS`). Three swings (`WAVE_SWINGS`), back, forth and back again, wake the kiosk: about a second of normal waving. Anything else, like raising the hand into view or moving it about, starts the count over. If no question is assigned to the active variant, the idle screen says so and ignores waves.
   **Which hand is followed.** The model looks for up to three hands (`MAX_HANDS`), and the kiosk follows the raised one: the hand highest in the picture. A hand that points, waves or makes a gesture is held up, so a hand resting at the bottom of the picture never takes over. A new hand less than a third of the size of the biggest one (`HAND_MIN_SIZE`) belongs to someone further away and is ignored, but the hand being followed is kept whatever its size, for example when a resting hand is much closer to a laptop camera. Another hand only takes over when it is at least a palm higher than the followed hand (`HAND_SWITCH`), so two hands at about the same height don't flicker. A hand moving fast blurs and can be lost for a few frames: for 0.4 seconds (`HAND_LOCK_MS`) the kiosk keeps its square in place and waits for it, instead of jumping to a lower hand. A hand of about the same size that turns up at the same height or higher counts as the same hand, however far to the side, because a waving hand that blurs mid-swing comes back at the other end of the swing.
2. **Ready.** The camera feed fills the screen in black and white, with the question over the top and a small card in the bottom-right corner showing the gesture to make. The hand that waved doesn't count as an answer until it changes or is lowered, so a waving hand isn't taken for five fingers. If no hand is seen for 10 seconds (`IDLE_AFTER_MS`), the kiosk goes back to the idle screen.
3. **Holding.** The kiosk fills a hold timer, whose length depends on the variant. A 250 ms grace period absorbs single missed frames.
   - *Thumbs.* When a 👍 or 👎 is detected with enough confidence (`MIN_SCORE`), a large ring fills. If the student switches thumbs, it starts over. If they drop the gesture, it resets.
   - *Stars.* A cursor follows the index fingertip, but only while the index finger is extended. When the cursor is on a star, that star and the stars before it fill, and the ring around the cursor fills. Moving to another star restarts the timer.
   - *Fingers.* The kiosk counts raised fingers using MediaPipe's 3D hand landmarks, so the count doesn't depend on how far the hand is from the camera. A count only takes effect after it has been the same for several frames in a row (`STABLE_FRAMES`), and changing the count restarts the timer. A fist (0 fingers) isn't an answer.
4. **Recorded.** The answer is saved with the question and variant, and the question's results for that variant are shown for 4 seconds: agree/disagree percentages, or the average rating plus a 1–5 distribution. Then the kiosk goes back to the idle screen with the next question lined up, so the next person has to wave before they can answer. If the answer can't be saved, the kiosk says so for 4 seconds and goes back to the idle screen with the same question, so the student can wave and try again.

**Which question is shown.** The kiosk asks the questions assigned to the active variant one at a time, in random order. Every question is asked once before any is repeated, and the same question never comes twice in a row. Questions added on the admin page join the current round. If no question is assigned to the active variant, the kiosk says so and doesn't accept answers. It checks for a new variant and for changed questions every few seconds (`POLL_MS`).

 The timings, the star hit area, the cursor smoothing, the finger-count thresholds (`FINGER_RATIO`, `THUMB_RATIO`) and the wave detection are defined at the top of `public/kiosk.js`. Each variant has its own hold time: `THUMBS_HOLD_MS` (3 s), `STARS_HOLD_MS` (1 s) and `FINGERS_HOLD_MS` (3 s).

## Admin page

- **Kiosk variant.** The switcher at the top sets the variant the kiosk runs: 👍👎, ⭐ or ✋. Each option shows how many questions are assigned to it.
- **Kiosk camera.** Choose the MacBook camera (landscape, for testing) or the Logitech StreamCam (portrait, for the kiosk display). See [Cameras](#cameras).
- **Add a question** and tick the variants it should be asked in. A question can have any combination. A question with none is kept but never shown.
- **Questions.** Every question, newest first. Questions the kiosk is asking now are marked *On kiosk*. Each one shows its results per variant, and these update live as answers come in. *Show answers* opens the 1–5 breakdown and every single answer with its time.
- **Edit** changes the text or the variants. The answers stay with the question. Answers from a variant you untick are kept and marked *not asked anymore*.
- **Delete** removes the question and all its answers, after a confirmation.
- Export all answers as CSV.

## API

Variants are `thumbs`, `stars` and `fingers`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/kiosk` | – | `{variant, camera, questions: [{id, text}]}`: the kiosk settings and the questions assigned to the active variant |
| POST | `/api/answers` | – | `{questionId, variant, answer: "agree" \| "disagree"}` for thumbs, or `{questionId, variant, rating: 1–5}` for stars and fingers. Returns the question's updated results for that variant |
| GET | `/api/settings` | – | `{variant, camera}`: the variant and camera the kiosk uses. `camera` is `macbook` or `logitech` |
| PATCH | `/api/settings` | admin | `{variant?, camera?}` changes either or both |
| GET | `/api/questions` | admin | All questions, newest first, each with `results` per variant |
| POST | `/api/questions` | admin | `{text, variants}` adds a question |
| PATCH | `/api/questions/:id` | admin | `{text?, variants?}` changes a question |
| DELETE | `/api/questions/:id` | admin | Deletes a question and its answers |
| GET | `/api/questions/:id/answers` | admin | Every answer to a question, newest first |
| GET | `/api/export.csv` | admin | All answers as CSV |

Admin requests send the password in the `x-admin-password` header.

## Cameras

You pick the camera on the admin page. The kiosk switches within a few seconds, without a reload. Each camera is defined in `CAMERAS` at the top of `public/kiosk.js`:

| Camera | Found by name | Picture |
| --- | --- | --- |
| **MacBook camera** | "FaceTime", "MacBook" or "Built-in" | Landscape (up to 1920×1080), as the sensor delivers it. For testing on a laptop. |
| **Logitech StreamCam** | "StreamCam", then "Logitech" | Portrait 1080×1920 for the vertical display. Mount the camera upright: the kiosk rotates its picture 270°. |

The picture is always mirrored, so it feels like a mirror. If the chosen camera isn't connected, the kiosk uses the browser's default camera and logs a warning in the console. To correct the orientation of a camera, change its `rotation` (clockwise, in degrees).

## Camera and HTTPS

Browsers only allow camera access on **`localhost` or HTTPS**. Running the server and kiosk on the same machine works as is. If the kiosk runs on a different device, such as a tablet, serve the site over HTTPS, for example:

- Deploy it to a host that provides HTTPS (Render, Railway, Fly.io, etc.) with a Postgres database, and set `DATABASE_URL`.
- Or tunnel your local server with `npx localtunnel --port 3000`, or use `cloudflared tunnel --url http://localhost:3000`.

## Tips for the kiosk

- Put the browser in full screen (F11, or ⌃⌘F on macOS). Chrome's `--kiosk` flag also works.
- Use even, front-facing light. Gestures are recognized most reliably when the hand is roughly 0.5–1.5 m from the camera.
- The kiosk needs internet on first load to download the MediaPipe model (about 8 MB) from the CDN.
