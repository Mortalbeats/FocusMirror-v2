/*
 * DeskSensor — toggleable desk-presence feature for FocusMirror
 * Talks to the Arduino over USB using the Web Serial API.
 *
 * Renders as a feature card with an on/off switch, matching the dashboard
 * style. When toggled on, a sensor panel appears with live presence status
 * and a Connect button. Toggling off hides the panel and disconnects the
 * Arduino. The toggle state is saved in localStorage.
 *
 * Requirements:
 *   - Chrome or Edge on desktop (Web Serial is not in Safari/Firefox/mobile)
 *   - Site served over HTTPS (https://focusmirror.netlify.app is — good)
 *
 * Arduino side: flash arduino/desk_presence_serial.ino (115200 baud).
 * It prints lines:  DISTANCE:<cm>   and   STATUS:<0|1>
 *
 * Usage — add to your Dashboard page:
 *   <div id="desk-sensor"></div>
 *   <script src="/desk-sensor.js"></script>
 *   <script>DeskSensor.init(document.getElementById("desk-sensor"));</script>
 *
 * API:
 *   DeskSensor.init(container)     render the feature card
 *   DeskSensor.setEnabled(bool)    toggle programmatically
 *   DeskSensor.showRemote(present, distance)   feed WiFi/ESP32 data in
 *   DeskSensor.supported()         Web Serial available?
 *
 * Events: document fires "deskpresence" with
 *   event.detail = { connected: bool, present: true/false/null, distance: number|null }
 * Events only fire while the feature is enabled, so the rest of the app can
 * react — e.g. auto-pause the Pomodoro when the person stands up:
 *
 *   document.addEventListener("deskpresence", (e) => {
 *     if (e.detail.connected && e.detail.present === false) pauseMyTimer();
 *   });
 */
const DeskSensor = (() => {
  const STORAGE_KEY = "fm-desk-sensor-enabled";
  let port = null, reader = null, connected = false, remote = false;
  let root = null, els = {}, enabled = false;
  const state = { present: null, distance: null };

  const css = `
    .ds-feature{font-family:inherit;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px 20px;max-width:360px;color:#e8e6e1;backdrop-filter:blur(6px)}
    .ds-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
    .ds-label{font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#c5c8d4}
    .ds-desc{font-size:12.5px;color:#7d8090;margin-top:4px}
    .ds-switch{width:44px;height:24px;border-radius:12px;background:#262a38;border:1px solid rgba(255,255,255,.12);position:relative;cursor:pointer;flex-shrink:0;padding:0;transition:background .2s,border-color .2s}
    .ds-switch[aria-checked="true"]{background:#6d5df6;border-color:#6d5df6}
    .ds-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:left .2s}
    .ds-switch[aria-checked="true"] .ds-knob{left:22px}
    .ds-switch:disabled{opacity:.45;cursor:not-allowed}
    .ds-body{margin-top:16px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px}
    .ds-body[hidden]{display:none}
    .ds-row{display:flex;align-items:center;gap:12px}
    .ds-dot{width:12px;height:12px;border-radius:50%;background:#5a5f6e;flex-shrink:0}
    .ds-dot.on{background:#34d399;box-shadow:0 0 10px rgba(52,211,153,.5)}
    .ds-dot.off{background:#f87171;box-shadow:0 0 10px rgba(248,113,113,.5)}
    .ds-status{font-size:17px;font-weight:600}
    .ds-sub{font-size:13px;color:#7d8090;margin-top:2px}
    .ds-btn{margin-top:14px;width:100%;background:#6d5df6;border:none;color:#fff;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
    .ds-btn:hover{background:#5b4be0}
  `;

  function supported() { return "serial" in navigator; }

  function build() {
    const style = document.createElement("style");
    style.textContent = css;
    const wrap = document.createElement("div");
    wrap.className = "ds-feature";
    wrap.innerHTML = `
      <div class="ds-toggle-row">
        <div>
          <div class="ds-label">Desk Sensor</div>
          <div class="ds-desc" data-desc>Arduino ultrasonic presence</div>
        </div>
        <button class="ds-switch" data-switch role="switch" aria-checked="false" aria-label="Toggle desk sensor">
          <span class="ds-knob"></span>
        </button>
      </div>
      <div class="ds-body" data-body hidden>
        <div class="ds-row">
          <div class="ds-dot" data-dot></div>
          <div>
            <div class="ds-status" data-status>Offline</div>
            <div class="ds-sub" data-sub>Arduino not connected</div>
          </div>
        </div>
        <button class="ds-btn" data-btn>Connect Arduino</button>
      </div>`;
    root.appendChild(style);
    root.appendChild(wrap);

    els = {
      desc: wrap.querySelector("[data-desc]"),
      switch: wrap.querySelector("[data-switch]"),
      body: wrap.querySelector("[data-body]"),
      dot: wrap.querySelector("[data-dot]"),
      status: wrap.querySelector("[data-status]"),
      sub: wrap.querySelector("[data-sub]"),
      btn: wrap.querySelector("[data-btn]"),
    };

    els.switch.addEventListener("click", () => setEnabled(!enabled));
    els.btn.addEventListener("click", () => (connected ? disconnect() : connect()));

    if (!supported()) {
      els.switch.disabled = true;
      els.desc.textContent = "Chrome/Edge on desktop only";
    }

    // Restore the toggle state from last visit
    setEnabled(localStorage.getItem(STORAGE_KEY) === "on");
  }

  async function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(STORAGE_KEY, on ? "on" : "off"); } catch (e) {}
    els.switch.setAttribute("aria-checked", String(on));
    els.body.hidden = !on;
    if (on) {
      render();
    } else {
      if (connected) {
        await disconnect(); // also emits
      } else {
        state.present = null; state.distance = null;
        render(); emit();
      }
    }
  }

  function render() {
    const p = state.present;
    els.dot.className = "ds-dot " + (p === null ? "" : p ? "on" : "off");
    if (remote) {
      els.status.textContent = p === null ? "Waiting…" : p ? "At your desk" : "Desk empty";
      els.sub.textContent = (state.distance != null ? state.distance + " cm from sensor" : "—") + " · WiFi";
      els.btn.style.display = "none";
    } else if (!connected) {
      els.status.textContent = "Offline";
      els.sub.textContent = supported() ? "Arduino not connected" : "Needs Chrome/Edge";
      els.btn.style.display = "";
    } else if (p === null) {
      els.status.textContent = "Waiting…";
      els.sub.textContent = "Reading from sensor";
      els.btn.style.display = "";
    } else {
      els.status.textContent = p ? "At your desk" : "Desk empty";
      els.sub.textContent = state.distance != null ? state.distance + " cm from sensor" : "—";
      els.btn.style.display = "";
    }
    els.btn.textContent = connected && !remote ? "Disconnect" : "Connect Arduino";
  }

  function emit() {
    document.dispatchEvent(new CustomEvent("deskpresence", {
      detail: { connected: enabled && connected, present: state.present, distance: state.distance },
    }));
  }

  function handleLine(line) {
    if (line.startsWith("DISTANCE:")) {
      const d = parseInt(line.slice(9), 10);
      if (!isNaN(d) && d > 0) state.distance = d;
    } else if (line.startsWith("STATUS:")) {
      state.present = line.slice(7).trim() === "1";
      emit();
    }
    render();
  }

  async function readLoop() {
    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable);
    reader = decoder.readable.getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, i).trim());
          buffer = buffer.slice(i + 1);
        }
      }
    } catch (e) {
      console.warn("DeskSensor read error:", e);
    }
    if (connected) disconnect();
  }

  async function connect() {
    try {
      port = await navigator.serial.requestPort(); // must be triggered by the button click
      await port.open({ baudRate: 115200 });
      connected = true;
      render();
      readLoop();
    } catch (e) {
      console.warn("DeskSensor connect failed:", e);
      connected = false;
      render();
    }
  }

  async function disconnect() {
    try { if (reader) await reader.cancel(); } catch (e) {}
    try { if (port) await port.close(); } catch (e) {}
    connected = false; port = null; reader = null;
    state.present = null; state.distance = null;
    render(); emit();
  }

  /* WiFi option: push server-fetched state into the feature. */
  function showRemote(present, distance) {
    remote = true;
    state.present = present;
    state.distance = distance;
    connected = true;
    if (!enabled) setEnabled(true);
    render(); emit();
  }

  function init(container) {
    root = container;
    build();
    if (supported()) {
      navigator.serial.addEventListener("disconnect", (e) => {
        if (connected && port === e.target) disconnect();
      });
    }
  }

  return { init, setEnabled, showRemote, supported };
})();
