# RepSight

A workout logger that watches you through the camera. Point a phone or laptop
camera at the person exercising. RepSight recognises the movement, counts reps
(or times holds) and logs each finished set to the current workout. You can
then add weights, edit counts and save the workout to your history.

Everything runs in the browser. Video never leaves the device. Pose tracking
uses Google's MediaPipe Pose Landmarker (WebAssembly/WebGPU), and workouts are
saved in the browser's local storage.

## What it recognises

| Exercise       | Counted as | Best camera angle               |
|----------------|------------|---------------------------------|
| Squat          | reps       | side-on or 45°                  |
| Push-up        | reps       | side-on, camera at floor level  |
| Bicep curl     | reps       | side-on or facing; alternating arms count separately |
| Overhead press | reps       | facing                          |
| Jumping jack   | reps       | facing                          |
| Plank          | seconds    | side-on, camera at floor level  |

### How it works

1. **Pose:** MediaPipe returns 33 body landmarks per video frame.
2. **Features** (`detect.js`): joint angles (knees, elbows, hips), torso tilt,
   upper-arm direction, wrist height and foot spread, lightly smoothed.
3. **Rep counters:** each exercise has a hysteresis counter on its key angle
   (for example, squat knee angle above 155° → below 110° → above 155°). The
   rep only counts if the body position matches that exercise for most of the rep:
   upright for squats, horizontal with straight legs for push-ups, and so on.
   Half reps and very fast or very slow movements are ignored.
4. **Auto-tracking:** an exercise is confirmed after 2 matching reps. The set
   ends after a few seconds without a rep (6 s by default; you can change it in
   Settings), or when 3 reps of a different exercise show up. A rest timer then
   runs until the next set starts.

## Run it

The camera only works on a secure page (HTTPS or `localhost`).

```bash
cd repsight
python3 -m http.server 8000
# open http://localhost:8000
```

To use it on a phone, host the `repsight/` folder on any HTTPS static host
(GitHub Pages, Netlify, Cloudflare Pages) and open it there. On the phone you
can also "Add to Home Screen".

No camera nearby? **Run demo** plays a simulated person through the same
recognition pipeline. **Analyze a video** runs the pipeline on a recorded clip.

## Tests

```bash
cd repsight
npm test        # node --test, no dependencies
```

The tests drive the recogniser with synthetic skeletons (`synth.js`). They
check rep counts for every exercise, alternating curls, plank timing,
back-to-back sets, idle movement, half reps and missing landmarks.

## Files

- `index.html`, `styles.css`: app shell
- `app.js`: camera and video pipeline, overlay, logbook, history, settings
- `detect.js`: exercise recognition and rep counting (pure, testable)
- `synth.js`: synthetic poses for tests and the demo
