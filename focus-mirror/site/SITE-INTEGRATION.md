# Desk Sensor — integrated into FocusMirror

The Arduino ultrasonic desk-presence feature is now built into the site as a
**toggleable feature card on the Dashboard**, styled to match the app.

## What changed (4 files)

| File | Change |
|---|---|
| `index.html` | Added the Desk Sensor card markup in the dashboard's right column (below the READY alert box) + `<script src="js/desksensor.js">` after `app.js` |
| `js/desksensor.js` | **New.** Web Serial client + toggle logic + auto-pause wiring |
| `js/app.js` | Added a tiny `window.fmTimerState()` bridge so the sensor can read whether the Pomodoro / Time Block timers are running |
| `css/styles.css` | Appended the `.ds-*` styles (glass card, violet switch, status dot) incl. light-theme overrides |

## How it works

1. User flips the **Desk Sensor** switch ON (state saved in `localStorage`)
2. The panel appears with a **Connect Arduino** button
3. Clicking it makes the browser ask for access to the serial port
   ("input of data from the PC") — Web Serial's port picker
4. The Arduino (HC-SR04, sketch `arduino/desk_presence_serial.ino`,
   115200 baud) sends `DISTANCE:<cm>` / `STATUS:<0|1>` twice per second
5. The card shows a teal dot + **"At your desk"** or a red dot +
   **"Desk empty"**, with the live distance underneath
6. Bonus: when the person leaves the desk, any running **Pomodoro** or
   **Time Block** timer auto-pauses (with a notification) and auto-resumes
   when they return. Toggling the feature OFF disconnects the Arduino and
   stops all of this.

## Test locally

```bash
cd site
python3 serve.py
```

Open the printed `http://localhost:PORT` URL in **Chrome or Edge**,
go to **Dashboard**, flip the Desk Sensor switch on, click
**Connect Arduino**, pick the port. Sit/stand to see it flip.

> Web Serial needs Chrome/Edge on desktop and an HTTPS (or localhost)
> origin. On the live Netlify site this is already satisfied. On
> Safari/Firefox/mobile the switch is disabled with a note.

## Deploy

Copy the 4 changed files into your site repo (same paths) and push —
Netlify redeploys automatically.

## Arduino side

Flash `../arduino/desk_presence_serial.ino`:
- HC-SR04: VCC→5V, GND→GND, Trig→D9, Echo→D10 (direct jumper wires, no breadboard)
- Tune `PRESENCE_THRESHOLD_CM` from your Serial Monitor readings
  (sitting distance vs. away distance; default 70)

## Optional: WiFi instead of USB

`DeskSensor.showRemote(present, distance)` feeds the same card from a
remote source. See `../web-integration/netlify/functions/presence.js`
(a Netlify function) + `../arduino/desk_presence_wifi.ino` (ESP32 sketch).
Poll `/api/presence` every 2 s and call `showRemote` with the result.
