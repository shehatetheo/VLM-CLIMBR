# CLIMBR — read every move

CLIMBR turns a phone video of a boulder problem into a synced replay, a move-by-move read of the beta, and a coach's notes. It segments every hold on your route with **SAM 3.1**, tracks all four limbs with **ViTPose+**, and asks a vision-language model for feedback. All three models run through the [VLM Run](https://vlm.run) gateway. The camera can be on a tripod or in a friend's hand following you up the wall.

<p align="center"><img src="docs/finale.jpg" width="900" alt="The finale: holds relit in the colour of the limb that used them, order badges, the torso's path, and the climb measured in meters"></p>

## Run it

```bash
npm install
npm run dev                 # web on http://localhost:5173, API on :8787
```

Then connect your VLM Run key under **Settings → the coach** and paste it. The server tests it against the gateway, shows whether it can use SAM 3.1, ViTPose+ and a coach model, and saves it to `.env` only if it works. `.env` is gitignored. You can also put `VLMRUN_API_KEY=…` in `.env` yourself (see `.env.example`).

To check a key from the command line: `curl localhost:8787/api/models` returns `ok: true` and the models the key can use.

The first visit plays the onboarding. **Settings → replay the intro** shows it again.

Without a key, everything except live analysis and the AI coach notes still works: the example, the Coach Score and the reel.

Without Supabase settings (below), climbs are kept on the device only and the feed shows the built-in example.

The server needs ffmpeg to read clips. `npm install` brings a static build (`ffmpeg-static`); a system ffmpeg/ffprobe is used when there is one.

For production, run `npm run build && npm start`. That serves `dist/` and the API from one process on port 8787.

## Deploy to Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new). `vercel.json` already sets the Vite build and the `api/` functions, so keep the defaults.
2. **Settings → Environment Variables:** add `VLMRUN_API_KEY`.
3. **For live video analysis:** go to **Storage → Create → Blob** and connect the store to the project. That adds `BLOB_READ_WRITE_TOKEN`. Clips are bigger than a function's 4.5 MB request limit, so the browser uploads them to Blob and `api/analyze` reads them from there. The upload is deleted when the run ends; the H.264 playback copy and the poster are written back to Blob for the replay.
4. Redeploy, then open `https://<your-app>.vercel.app/api/models`: `"ok": true` means the key works and can use SAM 3.1 and ViTPose+.

Without Blob, everything else still works: the example, the AI coach and the reel. The analyze screen says what's missing.

5. **For saved climbs and the feed:** see [Saved climbs and the feed](#saved-climbs-and-the-feed-supabase) and add its four variables.

Once a run finishes, the browser keeps its own copy of the playback clip and poster (IndexedDB) and `api/cleanup` deletes them from Blob, so nothing of a climb stays on the server.

### On an iPhone

CLIMBR is laid out for a phone first. Open the deployed site in Safari, tap **Share → Add to Home Screen**, and it launches full screen like an app: bottom navigation, safe-area aware, clips picked straight from the camera roll. Climbs are stored on the phone itself.

The functions bundle `ffmpeg-static`, so clips (including iPhone HDR `.mov`) are read on Vercel exactly as they are locally. `api/analyze` runs up to 300 s, the Hobby maximum; a 30 s climb takes 45–70 s. The coach cuts its 8 keyframes in the browser, so it needs no ffmpeg at all.

## What's in it

| | |
|---|---|
| **Tabs** | A chrome bar in the thumb zone: **feed**, **analyze**, **my climbs**, **settings**. The glossy pill slides to the tab you pick. |
| **Looks** | Dark by default, with a light-mode switch in Settings, and three colors: lime, sunset, dusk. All of it is CSS tokens on `<html data-mode data-theme>` (`src/styles/metro.css`). |
| **Logo and 3D art** | The logo follows the color: lime is the original; sunset is an exact hue shift of it; dusk is a white version made with Higgsfield, lettering unchanged. Glossy 3D holds, generated with Higgsfield and recolored per theme by shifting only their green pixels (`tools/recolor-art.py`), drift at the page edges. Empty and error screens use a plain icon in a soft ring. |
| **Motion** | Buttons press fast and spring back, with a ripple where your finger lands and a band of light across the big ones. The background breathes: two drifting pools of light, rising glossy bubbles, twinkling stars, a sonar pulse on the rings. Only transform and opacity move, and "reduce motion" turns it all off (`src/styles/motion.css`, `src/lib/fx.ts`). |
| **Onboarding** | Four steps, each one screen with no scrolling: top bar (back, "2 of 4", Skip), content, pinned action bar. Film one attempt, how it is read, your name / grade / route color, done. |
| **Feed** | Shared climbs, full screen, one per swipe: autoplay muted, overlays on or off, props, save, a breakdown sheet, and **for you** / **saved**. |
| **My climbs** | Your saved climbs as tiles with their score and a SENT / so close sticker. Each one can be shared to the feed or kept private (the default). |
| **Results** | Where a freshly analyzed climb opens. **Coach Score** (0–100, a label and a one-sentence verdict, five sub-scores each with its reason), then **Coach analysis** (plain-English notes sorted by what they cost you: when, where on the wall in words, why, what to try; tap one to watch that moment), then **Your data**, collapsed: time on holds, a sideways-scrolling limb timeline, which holds each limb used, move order, every placement, and attempts compared. Optional AI coach notes from a vision model sit beside it; the score does not depend on them. |
| **Replay** | The clip, the route map and a scrubber on one clock. The map carries one number, the order each hold was reached, with badges spread so none overlap; tap a hold for its number. On a desktop the live numbers sit beside it. |
| **Reel** | The whole performance in one picture, in the app's look: the theme's page with its rings and stars, the logo in the current color, the clip in a chrome frame, the wall with the skeleton on it, and glass panels with "so far" (time on the wall, holds used, moves) and the sequence as glossy hold badges. A finale relights the holds in order and ends on the Coach Score in its chrome ring, the status sticker, the coach's line, and the climb in tiles. Wide (1920×1080) or Tall (1080×1920). **Save video** records it in the browser (MP4 where the browser can record H.264, else WebM). |
| **Analyze** | Pick a phone video (`.mov`, `.mp4`, `.webm`; any orientation, iPhone HDR, up to 2 minutes) and watch it being read: uploading → reading the video → finding your holds ‖ tracking your body → reading your moves → building your report. A clip that is too long, a route color that is not found, or a climber who cannot be seen each says how to fix it. |
| **Export** | The performance reel. The download button opens it; **Save video** records and shares it. |

Keyboard: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> seek (hold <kbd>Shift</kbd> for 2 s) · <kbd>1</kbd>–<kbd>3</kbd> views · <kbd>E</kbd> export.

The 3D wall and iPhone LiDAR are parked in `attic/3d/` until the video analysis is where we want it; its README says how to bring them back.

<p align="center">
  <img src="docs/replay.jpg" width="440" alt="Replay mid-climb">
  <img src="docs/coach.jpg" width="440" alt="VLM coach">
  <img src="docs/import.jpg" width="440" alt="Import: drop a video of the climb">
</p>

## How it works

```
 browser                                  CLIMBR server (server/)                      VLM Run gateway
  · replay, coach, exports                POST /api/analyze
  · route reader  (src/lib/analyze.ts) ◄── probe → analysis copy, 10 fps ─────────►  facebook/sam3.1    (track "{color} climbing hold")
  · camera motion (src/lib/motion.ts)      + H.264 playback copy + poster   ─────────►  vitpose-plus-large (pose, every analysis frame)
  · checks        (src/lib/live.ts)     ◄── NDJSON stages + normalized payloads
  · wall mosaic   (src/lib/wallplate.ts)  POST /api/coach ── 8 keyframes ───────────►  qwen3.8-27b / gemini (JSON feedback)
                                          the API key never leaves the server
```

1. **Reading the clip.** The server probes the original for duration, frame rate, display size after rotation, frame count and format. It uses ffprobe, or the bundled ffmpeg's own report, and fails the run if any of them cannot be read. One ffmpeg pass then makes the *analysis copy*: exactly 10 frames a second, upright, tone-mapped to SDR, long edge ≤ 960. Frame *i* sits at *i*/10 s, so the models' frame ids are real timestamps. The same pass makes an H.264 *playback copy* (≤ 1280 px, ≤ 30 fps) that every browser plays, and a poster. The original is kept beside them.
2. **SAM 3.1 and ViTPose+** run in parallel on the analysis copy. SAM samples up to 128 frames evenly across the whole clip, and ViTPose+ poses every frame. Each answer goes through a strict adapter (`server/vlm.mjs`). It checks the envelope against the clip that was sent and requires `vid.segment.masks` / `vid.pose.kpts` and COCO-17 keypoints. It turns pixel coordinates into 0–1 if a response ever uses them, and takes times from the response's own `frame_ts`. Anything off-shape fails the stage with the reason.
3. **The camera** is read from SAM's own hold tracks (`src/lib/motion.ts`). Holds are bolted down, so when they move in the picture, the camera moved. Every sampled frame gets a similarity transform onto one wall canvas. The fit is robust to a hold half-hidden under a hand, and it drops tracks that move against the wall and sightings where SAM switched holds. A tripod clip registers as exactly still and reads as the pipeline reads it. A hand-held one gets a canvas covering the wall the climber used, much as vision-demos' `camera.py` does with homographies.
4. **The route reader** (`src/lib/analyze.ts`) is a TypeScript port of the core of `vision-demos/rock_climbing/src/climb.py`. It judges contact in the picture itself, against each hold's outline as SAM saw it nearest that moment, carried by the camera's motion. It uses the pipeline's dwell, hysteresis, graze, toe-offset, start and top-out rules, with margins in hold heights and body heights. On the example's raw gateway responses it reproduces the pipeline's 16-hold numbering and finds all 9 holds of its sequence in the same order, plus two half-second touches the pipeline discards. Each limb's *share of contact* lands within 1 point of the pipeline's.
5. **The route color, checked** (`server/routecolor.mjs`). If SAM finds fewer than five holds of the color picked, or the climber touches fewer than two of them, the server looks at the colors under the climber's hands and feet (against how common each color is on the rest of the wall), re-runs SAM for the two likeliest, and keeps the color with the most touches. A clip analyzed as green while the climber was on red is read as red, and the app says so. Close-ups of the right color skip this.
6. **Checks** (`src/lib/live.ts`) run before anything opens:
   - the playback copy is as long as the source;
   - SAM sampled the whole clip, and ViTPose+ posed at least 40% of it (under 90% only warns: far away, a climber can drop out for a moment);
   - the camera was placed;
   - every move, skeleton frame and torso point sits on the clip's own clock;
   - every hold outline sits on the canvas.

   A failed check stops the run with its reason. No duration, frame size or frame rate is ever assumed.
7. **The replay** draws its overlay in the video's own pixels, letterboxed exactly as the video is. Holds appear where the camera saw them, light up once used and turn white while held, under the real 17-joint skeleton. One clock runs through the whole clip in real seconds, with the climb clock zeroed at the start.

- **The wall plate** is the climber-free photo of the wall. Frames are warped onto the canvas by their own camera transforms, the climber is cut out of each using the pose, and a per-pixel median does the rest. With a moving camera it is a mosaic of everything the camera saw. The route backdrop is drawn from it.
- **The coach** works through a model chain: `CLIMBR_COACH_MODEL`, then `google/gemini-3.7-flash`, `qwen/qwen3.8-27b` and `qwen/qwen3.5-0.8b`. A model the account isn't entitled to is skipped, and the one that answers is remembered. Qwen's thinking mode is switched off so it spends its budget on the answer. The clip goes in as 8 keyframes rather than a `video_url`, because not every chat model on the gateway decodes video.

Measured on a 29.4 s hand-held iPhone clip: reading it took ~8 s, SAM 3.1 + ViTPose+ took 40–60 s for **$0.036**, and the route reader took well under a second. The coach took ~10 s for **$0.003**.

### Debugging a run (development)

`npm run dev` keeps every run in `.climbr/runs/<id>/`:

- the original clip, plus the analysis and playback copies;
- `sam.raw.json` and `pose.raw.json`, the gateway's answers with masks stripped;
- the normalized `sam.json` and `pose.json`;
- `run.json`, a log with every stage's timing;
- `client.json`, the browser's report of what it read and which checks passed.

`GET /api/debug/runs` lists the runs and `/api/debug/runs/<id>` returns one. In the app, **Debug** on a live session shows the same. `tools/read-run.ts` runs the browser's reader in Node on a saved run, or on raw gateway responses:

```bash
npx rolldown tools/read-run.ts -p node -f esm -o .climbr/read-run.mjs
node .climbr/read-run.mjs run .climbr/runs/<id>
node .climbr/read-run.mjs raw public/examples/green-vb/gateway/sam3.1-track.json public/examples/green-vb/gateway/vitpose-plus-large.json public/examples/green-vb/climb.json
```

## Saved climbs and the feed (Supabase)

Everything lives in `supabase/migrations/20261114000000_climbr.sql`, written for a Supabase project of its own:

- **Tables:** `profiles` (a random username, no real names), `climbs`, `props`, `saves`, `reports`. Row level security on every one: people change only their own rows, and of a climb only its title and whether it is shared. Scores and analysis are not theirs to edit.
- **Sharing:** a climb is private until its owner shares it. Shared climbs go straight into the feed while `auto_approve` is on (the default). To make every share wait for a moderator instead, run `update private.settings set value = 'false' where key = 'auto_approve';`.
- **Reports:** three reports hide a climb until someone looks at it on `/#/admin`. No location is stored anywhere.
- **Videos:** private buckets `climb-videos` and `climb-thumbnails`, read through signed URLs. The stored video is the server's H.264 playback copy, which carries no metadata (no GPS).

Setup:

1. Run the migration (SQL editor, or `supabase db push`).
2. **Authentication → Sign In / Providers → Allow anonymous sign-ins: on.** Everyone gets an account without signing up.
3. Pick a long random `ADMIN_RPC_SECRET`, then store its hash once from the SQL editor:
   `insert into private.settings (key, value) values ('admin_secret_hash', extensions.crypt('<ADMIN_RPC_SECRET>', extensions.gen_salt('bf'))) on conflict (key) do update set value = excluded.value;`
4. Vercel → Environment Variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the project's publishable key), `ADMIN_PASSWORD` (what you type on `/#/admin`) and `ADMIN_RPC_SECRET`. Redeploy: the two `VITE_` values are built into the page.
5. Seed the example climb into the feed:
   ```bash
   npx rolldown tools/seed.ts -p node -f esm -o .climbr/seed.mjs
   VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… ADMIN_RPC_SECRET=… node .climbr/seed.mjs
   ```

`supabase/tests/run.sh` applies the migration to a scratch local Postgres and runs 31 security checks against it.

## The Coach Score

`src/lib/score.ts` is pure: the same climb always gets the same score. `SCORE_WEIGHTS` sets how much Efficiency, Flow, Footwork, Precision and Speed count; `SCORE_RULES` holds every threshold and penalty; the formula is written out above `coachScore()`. `coachInsights()` builds the analysis from the same measurements and sorts it by seconds lost.

In development, `src/lib/devOverflow.ts` logs any element that runs off the side of the screen.

## Project layout

```
server/core.mjs    the API itself: VLM Run client, probe + frame extraction, SAM 3.1 + ViTPose+, coach, run folders
server/vlm.mjs     the strict adapter for SAM 3.1 and ViTPose+ responses
server/index.mjs   Express wrapper for local runs and `npm start` (plus /api/debug in development)
api/               the same core as Vercel functions (health, models, key, analyze, upload, cleanup, coach)
src/lib/           route reader, camera motion, checks, session model, timeline + climber IK, overlay, reel compositor, Coach Score + insights (score.ts), AI coach
src/components/    route panel (SVG), video stage, timeline, live stats, your-data sections, reel player, key connection, debug panel
src/views/         onboarding, feed, analyze, my climbs, settings, admin, session (breakdown · replay · reel)
src/ui/            the component kit (glossy buttons, pills, stickers, score badge, tab bar) and the background art
src/styles/        metro.css (tokens, looks, materials), screens.css, motion.css
supabase/          the migration and its security tests
attic/3d/          the parked 3D wall and LiDAR view
public/examples/   the example climb: pipeline JSON, raw gateway JSON, clip, wall plate, coach feedback
tools/             read-run.ts: the browser's route reader, run in Node on saved gateway output
```

The bundled example lives in `public/examples/green-vb/`. Its `gateway/` folder holds the real SAM 3.1 and ViTPose+ responses for the clip, which `tools/read-run.ts` reads as a regression check.

## Credits

The example footage, its hold and contact data, and the reference pipeline the route reader is ported from come from [**jeremyipark/vision-demos**](https://github.com/jeremyipark/vision-demos) by Jeremy Park, Apache-2.0.
