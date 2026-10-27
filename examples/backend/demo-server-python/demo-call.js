/* Comms kit browser demo: voice calls (P2P WebRTC, the server relays signalling).
 * Loaded by demo.js only when the server has the call feature.
 * Same flow as the mobile kit: the caller sends a complete offer after ICE gathering,
 * the callee waits for the offer, answers, and trickled candidates are queued until ready. */
(() => {
"use strict";
const A = window.DemoApp;
const { S, $, send, log, nameOf, avatarHtml, icon, esc, announce, fmtDuration } = A;

// ================================================================ tones (Web Audio, no files)
let audioCtx = null;
function unlockAudio() { try { audioCtx = audioCtx || new AudioContext(); audioCtx.resume(); } catch { /* no audio */ } }
const tone = { timer: null, kind: null };
function beep(freqs, ms) {
  if (!audioCtx) return;
  const gain = audioCtx.createGain(); gain.gain.value = 0.08; gain.connect(audioCtx.destination);
  freqs.forEach((f) => { const o = audioCtx.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); o.stop(audioCtx.currentTime + ms / 1000); });
}
function playTone(kind) {
  stopTone();
  // ringback for the caller, a double ring for the callee
  const step = kind === "ringback" ? () => beep([425], 1000) : () => { beep([480, 620], 400); setTimeout(() => beep([480, 620], 400), 600); };
  step(); tone.timer = setInterval(step, kind === "ringback" ? 4000 : 2500);
  tone.kind = kind;
}
function stopTone() { clearInterval(tone.timer); tone.timer = null; tone.kind = null; }

// ================================================================ outcomes shown on the ended / failed screen
const OUTCOMES = {
  hangup: { text: null },                                   // "Call ended · MM:SS"
  ended: { text: "Call ended" },
  cancelled: { text: "Call cancelled" },
  declinedByMe: { text: "Declined" },
  missed: { text: "Missed call" },
  elsewhere: { text: "Answered on another device" },
  noAnswer: { fail: true, text: "No answer", detail: (n) => `${n} didn't pick up. They'll see a missed call.` },
  declined: { fail: true, text: "Declined", detail: (n) => `${n} declined the call.` },
  busy: { fail: true, text: "On another call", detail: (n) => `${n} is on another call. Try again in a moment.` },
  micBlocked: {
    fail: true, text: "Microphone access is blocked",
    detail: () => "To allow it, click the lock (site settings) icon left of the address bar, set Microphone to Allow, then try again. On a phone, also check that the browser may use the microphone in system settings.",
  },
  noMic: { fail: true, text: "No microphone found", detail: () => "Connect a microphone or headset, then try again." },
  connectFailed: { fail: true, text: "Couldn't connect", detail: () => "The audio connection couldn't be set up. Check your network and try again." },
  lost: { fail: true, text: "Connection lost", noRetry: true, detail: () => "You went offline during the call." },
  offline: { fail: true, text: "You're offline", noRetry: true, detail: () => "Wait for the connection to come back, then try again." },
};
const micOutcome = (err) => (err && err.name === "NotFoundError" ? "noMic" : "micBlocked");

// ================================================================ call screen
const canPickOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
let screenOpen = false, renderedKey = null;
const RINGING = ["outgoing", "ringing", "incoming"];
const clock = (c) => fmtDuration(c.connectedAt ? Math.floor((Date.now() - c.connectedAt) / 1000) : 0);

function statusText(c) {
  if (c.state === "connected") return clock(c);
  if (c.state === "ended" || c.state === "failed") return c.endText;
  return { outgoing: "Calling…", ringing: "Ringing…", incoming: "Incoming voice call", connecting: "Connecting…" }[c.state] || c.state;
}
function setStatus(text, animate) {
  const el = $("callStatus");
  el.textContent = text;
  if (animate && !A.reducedMotion()) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); }
}
const ctl = (cls, act, ic, label, aria, attrs = "") =>
  `<div class="ctl ${cls}"><button class="ctl-btn" type="button" data-act="${act}" aria-label="${esc(aria)}"${attrs}>${icon(ic)}</button><span aria-hidden="true">${esc(label)}</span></div>`;
function controlsHtml(c) {
  const name = nameOf(c.peer);
  if (c.state === "incoming") return ctl("hangup", "decline", "hangup", "Decline", `Decline call from ${name}`) + ctl("accept", "accept", "phone-fill", "Accept", `Accept call from ${name}`);
  if (c.state === "ended") return "";
  if (c.state === "failed") {
    const again = c.retry ? ctl("retry", "again", "phone-fill", c.role === "caller" ? "Call again" : "Call back", `Call ${name} again`) : "";
    return ctl("", "close", "x", "Close", "Close call screen") + again;
  }
  const mute = ctl("", "mute", c.muted ? "mic-off" : "mic", c.muted ? "Unmute" : "Mute", "Mute microphone", ` aria-pressed="${!!c.muted}"`);
  const speaker = canPickOutput ? ctl("", "output", "speaker", "Speaker", "Choose audio output", ' aria-haspopup="menu" aria-expanded="false" aria-controls="callMenu"') : "";
  return mute + speaker + ctl("hangup", "hangup", "hangup", "End", c.state === "connected" ? "End call" : "Cancel call");
}
function primaryControl() {
  const box = $("callControls");
  return box.querySelector('[data-act="accept"], [data-act="again"], [data-act="hangup"], [data-act="close"]') || $("callScreen");
}
function announceState(c) {
  const name = nameOf(c.peer);
  const text = {
    outgoing: `Calling ${name}`, ringing: `Ringing ${name}`, incoming: `Incoming voice call from ${name}`,
    connecting: "Connecting", connected: `Connected to ${name}`,
  }[c.state] || `${c.endText}${c.endDetail ? ". " + c.endDetail : ""}`;
  announce(text, c.state === "incoming" || c.state === "failed");
}
function renderCall() {
  const c = S.call;
  const scr = $("callScreen");
  if (!c) {
    closeMenu();
    if (screenOpen) { screenOpen = false; A.closeLayer(scr); }
    renderedKey = null;
    stopTone();
    return;
  }
  const key = `${c.state}|${c.endText || ""}|${c.retry ? 1 : 0}`;
  if (key !== renderedKey) {
    const first = renderedKey === null;
    renderedKey = key;
    const hadFocus = !screenOpen || scr.contains(document.activeElement) || document.activeElement === document.body;
    scr.dataset.state = c.state === "connected" ? "active" : c.state;
    scr.dataset.ringing = String(RINGING.includes(c.state));
    $("callAvatar").innerHTML = avatarHtml(c.peer, 128);
    $("callName").textContent = nameOf(c.peer);
    setStatus(statusText(c), !first);
    $("callDetail").hidden = !c.endDetail;
    $("callDetail").textContent = c.endDetail || "";
    closeMenu();
    $("callControls").innerHTML = controlsHtml(c);
    announceState(c);
    if (!screenOpen) {
      screenOpen = true;
      A.openLayer(scr, { initialFocus: primaryControl, onEscape: closeMenu });
    } else if (hadFocus) {
      primaryControl().focus({ preventScroll: true });
    }
  } else if (c.state === "connected") {
    setStatus(clock(c), false);
  }
  if (c.state === "outgoing" || c.state === "ringing") { if (tone.kind !== "ringback") playTone("ringback"); }
  else if (c.state === "incoming") { if (tone.kind !== "ring") playTone("ring"); }
  else stopTone();
}
setInterval(() => { if (S.call?.state === "connected") renderCall(); }, 1000);

function toggleMute() {
  const c = S.call; if (!c) return;
  c.muted = !c.muted;
  c.stream?.getAudioTracks().forEach((t) => (t.enabled = !c.muted));
  const btn = $("callControls").querySelector('[data-act="mute"]');
  if (btn) {
    btn.setAttribute("aria-pressed", String(c.muted));
    btn.innerHTML = icon(c.muted ? "mic-off" : "mic");
    btn.nextElementSibling.textContent = c.muted ? "Unmute" : "Mute";
  }
  announce(c.muted ? "Microphone muted" : "Microphone on");
}

// ---------------------------------------------------------------- audio output picker (setSinkId only)
async function openMenu(btn) {
  const menu = $("callMenu");
  let outputs = [];
  try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); } catch { /* not allowed */ }
  if (!outputs.length) outputs = [{ deviceId: "default", label: "Default output" }];
  const current = S.call?.sinkId || "default";
  menu.innerHTML = `<div class="menu-title">Audio output</div>` + outputs.map((d, i) =>
    `<button type="button" role="menuitemradio" aria-checked="${d.deviceId === current || (!S.call?.sinkId && i === 0)}" data-sink="${esc(d.deviceId)}">${icon("check")}<span>${esc(d.label || (d.deviceId === "default" ? "Default output" : `Output ${i + 1}`))}</span></button>`).join("");
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector('[aria-checked="true"]')?.focus() || menu.querySelector("button")?.focus();
}
function closeMenu() {
  const menu = $("callMenu");
  if (menu.hidden) return;
  menu.hidden = true;
  const btn = $("callControls").querySelector('[data-act="output"]');
  btn?.setAttribute("aria-expanded", "false");
  if (menu.contains(document.activeElement)) btn?.focus();
}
async function pickOutput(id) {
  const c = S.call;
  try {
    await $("remoteAudio").setSinkId(id);
    if (c) c.sinkId = id;
  } catch (err) { A.toast("Couldn't switch the audio output", { kind: "error" }); log("err", "setSinkId: " + err); }
  closeMenu();
}

// ================================================================ WebRTC
async function newPeerConnection(c) {
  c.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (c.muted) c.stream.getAudioTracks().forEach((t) => (t.enabled = false));
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  c.stream.getTracks().forEach((t) => pc.addTrack(t, c.stream));
  pc.ontrack = (e) => { $("remoteAudio").srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate && c.id) send("ice_candidate", { call_id: c.id, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected" && !c.connectedAt) { c.state = "connected"; c.connectedAt = Date.now(); renderCall(); }
    if (pc.connectionState === "failed" && S.call === c) { send("end_call", { call_id: c.id }); endCallLocal("connectFailed"); }
  };
  c.pc = pc;
  return pc;
}
const gathered = (pc, ms = 3000) => new Promise((r) => {
  if (pc.iceGatheringState === "complete") return r();
  const t = setTimeout(r, ms);
  pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); r(); } });
});
async function flushIce(c) {
  for (const cand of c.iceQueue.splice(0)) await c.pc.addIceCandidate(cand).catch((err) => log("err", "ice: " + err));
}
const finished = (c) => !c || c.state === "ended" || c.state === "failed";

function startCall(peer) {
  if (!peer || !A.hasCall()) return;
  if (S.call && !finished(S.call)) return;
  S.call = null; // replace a lingering ended / failed screen
  unlockAudio();
  const c = (S.call = { peer, state: "outgoing", role: "caller", iceQueue: [] });
  renderCall();
  if (!send("call_initiate", { receiver_id: peer, call_type: "audio" })) endCallLocal("offline");
  return c;
}
async function acceptCall() {
  const c = S.call;
  if (!c || c.state !== "incoming") return;
  unlockAudio();
  c.state = "connecting"; renderCall();
  let pc;
  try { pc = await newPeerConnection(c); }
  catch (err) { send("reject_call", { call_id: c.id }); return endCallLocal(micOutcome(err)); }
  const deadline = Date.now() + 10000;  // wait for the caller's offer
  while (!c.offer && Date.now() < deadline && S.call === c) await new Promise((r) => setTimeout(r, 100));
  if (S.call !== c || finished(c)) return;
  if (!c.offer) { send("end_call", { call_id: c.id }); return endCallLocal("connectFailed"); }
  await pc.setRemoteDescription(c.offer);
  await flushIce(c);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  send("sdp_answer", { call_id: c.id, sdp: pc.localDescription.toJSON() });
  send("answer_call", { call_id: c.id });
  c.accepted = true;
}
function declineCall() {
  const c = S.call; if (!c) return;
  send("reject_call", { call_id: c.id });
  endCallLocal("declinedByMe");
}
// Calls we hung up on before the server answered `call_initiated`: when that reply arrives (the call already exists
// on the server and is ringing the other person), it must be ended. FIFO: the server answers in the order we asked.
const abandonedCalls = [];
function hangUp() {
  const c = S.call; if (!c || finished(c)) return;
  if (c.id) send("end_call", { call_id: c.id }); else abandonedCalls.push(Date.now());
  endCallLocal(c.connectedAt ? "hangup" : "cancelled");
}
// Show the ended state (auto-closes after 1.6 s) or a failure screen (stays until Close / Call again).
function endCallLocal(outcome, custom) {
  const c = S.call;
  if (finished(c)) return;
  c.pc?.close(); c.stream?.getTracks().forEach((t) => t.stop());
  $("remoteAudio").srcObject = null;
  const o = custom || OUTCOMES[outcome] || OUTCOMES.ended;
  const name = nameOf(c.peer);
  c.endText = o.text || (c.connectedAt ? `Call ended · ${clock(c)}` : "Call ended");
  c.endDetail = typeof o.detail === "function" ? o.detail(name) : o.detail || "";
  c.retry = !!o.fail && !o.noRetry;
  c.state = o.fail ? "failed" : "ended";
  renderCall();
  log("err", "call finished: " + c.endText);
  if (!o.fail) setTimeout(() => { if (S.call === c) { S.call = null; renderCall(); } }, 1600);
}
function closeScreen() { if (finished(S.call)) { S.call = null; renderCall(); } }

async function handleCall(m) {
  let c = S.call;
  if (finished(c)) c = null;
  switch (m.type) {
    case "call_initiated":
      while (abandonedCalls.length && Date.now() - abandonedCalls[0] > 30000) abandonedCalls.shift();
      if (abandonedCalls.length) { abandonedCalls.shift(); return send("end_call", { call_id: m.call_id }); }
      if (!c || c.role !== "caller" || c.id) return;
      c.id = m.call_id;
      try {
        const pc = await newPeerConnection(c);
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        if (S.call !== c || finished(c)) return;
        send("sdp_offer", { call_id: c.id, sdp: pc.localDescription.toJSON() });
      } catch (err) { send("end_call", { call_id: c.id }); endCallLocal(micOutcome(err)); }
      return;
    case "call_ringing": if (c && c.id === m.call_id && c.state === "outgoing") { c.state = "ringing"; renderCall(); } return;
    case "incoming_call":
      if (c && c.id !== m.call_id) return;
      if (!c) {
        c = S.call = { id: m.call_id, peer: m.caller_id, state: "incoming", role: "callee", iceQueue: [] };
        if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") new Notification("Incoming call", { body: nameOf(m.caller_id) });
      }
      if (m.sdp) c.offer = m.sdp;
      renderCall(); return;
    case "sdp_offer": if (c && c.id === m.call_id) c.offer = m.sdp; return;
    case "sdp_answer":
      if (c && c.id === m.call_id && c.pc) { await c.pc.setRemoteDescription(m.sdp); await flushIce(c); if (c.state !== "connected") { c.state = "connecting"; renderCall(); } }
      return;
    case "ice_candidate":
      if (!c || c.id !== m.call_id) return;
      if (c.pc && c.pc.remoteDescription) await c.pc.addIceCandidate(m.candidate).catch((err) => log("err", "ice: " + err));
      else c.iceQueue.push(m.candidate);
      return;
    case "call_answered":
      if (c && c.id === m.call_id && c.role === "callee" && !c.accepted) endCallLocal("elsewhere");
      return;
    case "call_rejected":
      if (m.call_id === null && c && c.role === "caller" && !c.id) return endCallLocal("busy");
      if (c && c.id === m.call_id) endCallLocal(c.role === "caller" ? "declined" : "declinedByMe");
      return;
    case "call_ended": if (c && c.id === m.call_id) endCallLocal(c.connectedAt ? "hangup" : c.role === "callee" ? "missed" : "ended"); return;
    case "call_missed": if (c && c.id === m.call_id) endCallLocal(c.role === "caller" ? "noAnswer" : "missed"); return;
  }
}

// ================================================================ wiring
$("callControls").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "accept") acceptCall();
  else if (act === "decline") declineCall();
  else if (act === "hangup") hangUp();
  else if (act === "mute") toggleMute();
  else if (act === "output") ($("callMenu").hidden ? openMenu(btn) : closeMenu());
  else if (act === "close") closeScreen();
  else if (act === "again") { const peer = S.call?.peer; S.call = null; renderCall(); startCall(peer); }
});
$("callMenu").addEventListener("click", (e) => { const b = e.target.closest("[data-sink]"); if (b) pickOutput(b.dataset.sink); });
$("callMenu").addEventListener("keydown", (e) => {
  const items = [...$("callMenu").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
});

window.CallUI = {
  start: startCall,
  handle: handleCall,
  unlockAudio,
  onError(m) {
    // Only errors tagged context:"call" reach here (PROTOCOL.md §1).
    const c = S.call;
    if (finished(c)) { A.toast(m.error || "Call failed", { kind: "error" }); return; }
    endCallLocal(null, { fail: true, text: m.error || "Call failed", detail: m.message && m.message !== m.error ? m.message : "" });
  },
  onDisconnect() {
    const c = S.call;
    if (finished(c)) return;
    endCallLocal(c.connectedAt ? "lost" : "offline");
  },
  reset() {
    if (S.call && !finished(S.call)) hangUp();
    S.call = null; renderCall();
  },
};
})();
