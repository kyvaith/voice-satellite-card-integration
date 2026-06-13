/**
 * Ink Blobs Skin
 *
 * Dark/light adaptive skin that renders colored ink diffusing through water
 * using a real-time GPU fluid simulation (Navier-Stokes: advection, vorticity
 * confinement, Jacobi pressure solve). Colored ink is injected as jets from
 * the left and right edges and the solver carries it into swirling, billowing
 * plumes - genuine fluid motion rather than procedural noise.
 *
 * The simulation is adapted from Pavel Dobryakov's WebGL-Fluid-Simulation
 * (MIT License, https://github.com/PavelDoGreat/WebGL-Fluid-Simulation).
 *
 * Lifecycle mirrors the other canvas skins: a self-mounting runtime activated
 * explicitly by the skin registry, with warmup / visibility / resize handling.
 */

import css from './ink-blobs.css';
import previewCSS from './ink-blobs-preview.css';

// ── Ink palettes (0-255) ────────────────────────────────────────────
// Red / yellow / blue / green plus a neutral: black on the light surface,
// light grey on the dark surface. Override via the --ib-ink-N CSS variables.
const INK_DARK = [
  [255, 26, 26], [255, 209, 13], [31, 102, 255], [26, 235, 64], [224, 230, 240],
];
const INK_LIGHT = [
  [217, 10, 10], [245, 184, 0], [10, 36, 217], [0, 140, 31], [10, 13, 18],
];

// ── Shaders (ported from the validated fluid prototype) ──────────────
const BASE_VERT = `precision highp float;
attribute vec2 aP;
varying vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main () {
  vUv = aP * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aP, 0.0, 1.0);
}`;
const SPLAT_FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec4 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  gl_FragColor = texture2D(uTarget, vUv) + exp(-dot(p, p) / radius) * color;
}`;
const ADV_FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
  vec2 c = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
  gl_FragColor = texture2D(uSource, c) / (1.0 + dissipation * dt);
}`;
const DIV_FRAG = `precision highp float;
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;
const CURL_FRAG = `precision highp float;
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;
const VORT_FRAG = `precision highp float;
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
  v = clamp(v, -1000.0, 1000.0);
  gl_FragColor = vec4(v, 0.0, 1.0);
}`;
const PRES_FRAG = `precision highp float;
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float d = texture2D(uDivergence, vUv).x;
  gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
}`;
const GRAD_FRAG = `precision highp float;
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
  gl_FragColor = vec4(v, 0.0, 1.0);
}`;
const CLEAR_FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float value;
void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`;
const DISPLAY_FRAG = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
void main () {
  vec4 c = texture2D(uTexture, vUv);
  gl_FragColor = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}`;

// ── Simulation config ────────────────────────────────────────────────
const SIM_RES = 128;
const DYE_RES = 512;
const CANVAS_SCALE = 0.75;        // display backing relative to CSS size
const PRESSURE = 0.8;
const PRESSURE_ITER = 20;
const CURL = 30;
const CURL_REACT = 2.4;           // vorticity multiplier at peak audio (the main reactivity)
const VEL_DISS = 0.15;
const DEN_DISS = 0.18;            // ink fades over ~tens of seconds so it clears
const SPLAT_RADIUS = 0.016;
const JET_FORCE = 240;            // per-frame streaming force (scaled by audio)
const DYE_RATE = 10;             // dye injected per second while a jet streams
const IDLE_JET_RATE = 0.35;       // jets/sec at idle
const ACTIVE_JET_RATE = 0.7;      // extra jets/sec at peak audio
const AUDIO_GAIN = 1.6;           // mic/TTS level multiplier

let _inkBlobsSetupDone = false;
const HIDDEN_WARMUP_BLOCKED =
  /Fully Kiosk/i.test(navigator.userAgent || '')
  || /\bwv\b/i.test(navigator.userAgent || '');

function setup() {
  const ui = document.getElementById('voice-satellite-ui');
  if (!ui) return false;
  if (_inkBlobsSetupDone) return true;
  _inkBlobsSetupDone = true;
  const barEl = ui.querySelector('.vs-rainbow-bar');

  let palette = INK_DARK;
  let isDark = true;

  const themeProbe = document.createElement('div');
  themeProbe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;color:var(--primary-background-color,#fff)';
  document.body.appendChild(themeProbe);

  function detectTheme() {
    const mode = ui.dataset.themeMode || 'auto';
    let dark;
    if (mode === 'dark') {
      dark = true;
    } else if (mode === 'light') {
      dark = false;
    } else {
      const rgb = getComputedStyle(themeProbe).color;
      const m = rgb.match(/(\d+)/g);
      dark = true;
      if (m) {
        const [r, g, b] = m.map(Number);
        dark = (0.299 * r + 0.587 * g + 0.114 * b) < 128;
      }
    }
    isDark = dark;
    ui.classList.toggle('vs-dark', isDark);
    ui.classList.toggle('vs-light', !isDark);
    palette = isDark ? INK_DARK : INK_LIGHT;
    readInkOverrides();
  }

  function parseHexToRGB(hex) {
    hex = hex.trim().replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const n = parseInt(hex, 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function parseCSSColor(val) {
    if (!val) return null;
    val = val.trim();
    if (val.startsWith('#')) return parseHexToRGB(val);
    const m = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }
  function readInkOverrides() {
    const style = getComputedStyle(ui);
    for (let i = 0; i < palette.length; i++) {
      const parsed = parseCSSColor(style.getPropertyValue(`--ib-ink-${i + 1}`));
      if (parsed) palette[i] = parsed;
    }
  }

  detectTheme();

  const wrapper = document.createElement('div');
  wrapper.className = 'vs-inkblobs';
  wrapper.style.opacity = '0';
  const canvas = document.createElement('canvas');
  wrapper.appendChild(canvas);

  // On-screen debug readout (WebGL canvas can't draw text, so use a DOM
  // overlay). Shown only when the card config has debug: true.
  const debugEl = document.createElement('div');
  debugEl.style.cssText = 'position:absolute;top:6px;left:8px;font:11px monospace;white-space:pre;pointer-events:none;z-index:5;display:none;';
  wrapper.appendChild(debugEl);

  let gl = null;
  let glReady = false;
  let glFailed = false;
  let TEXTYPE = 0;
  let quad = null;
  const progs = {};        // name -> { p, u }
  // FBO containers
  let dye = null, vel = null, divFbo = null, curlFbo = null, pre = null;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[ink-blobs] shader error:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  function makeProg(fragSrc) {
    const p = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, BASE_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('[ink-blobs] link error:', gl.getProgramInfoLog(p));
      return null;
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const nm = gl.getActiveUniform(p, i).name;
      u[nm] = gl.getUniformLocation(p, nm);
    }
    return { p, u };
  }

  function createFBO(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, TEXTYPE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h, texelX: 1 / w, texelY: 1 / h };
  }
  function createDouble(w, h) {
    let a = createFBO(w, h), b = createFBO(w, h);
    return { w, h, texelX: 1 / w, texelY: 1 / h, get read() { return a; }, get write() { return b; }, swap() { const t = a; a = b; b = t; } };
  }
  function deleteFBO(f) { if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); } }
  function deleteAll() {
    if (dye) { deleteFBO(dye.read); deleteFBO(dye.write); }
    if (vel) { deleteFBO(vel.read); deleteFBO(vel.write); }
    if (pre) { deleteFBO(pre.read); deleteFBO(pre.write); }
    deleteFBO(divFbo); deleteFBO(curlFbo);
    dye = vel = pre = divFbo = curlFbo = null;
  }

  function getRes(res) {
    let a = drawW / drawH;
    if (a < 1) a = 1 / a;
    const min = Math.round(res), max = Math.round(res * a);
    return drawW > drawH ? { w: max, h: min } : { w: min, h: max };
  }

  function setupFBOs() {
    deleteAll();
    const s = getRes(SIM_RES);
    const d = getRes(DYE_RES);
    dye = createDouble(d.w, d.h);
    vel = createDouble(s.w, s.h);
    divFbo = createFBO(s.w, s.h);
    curlFbo = createFBO(s.w, s.h);
    pre = createDouble(s.w, s.h);
  }

  function initGL() {
    if (glReady || glFailed) return;
    const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false };
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) { glFailed = true; console.error('[ink-blobs] WebGL unavailable'); return; }
    const hf = gl.getExtension('OES_texture_half_float');
    gl.getExtension('OES_texture_half_float_linear');
    if (hf) {
      TEXTYPE = hf.HALF_FLOAT_OES;
    } else if (gl.getExtension('OES_texture_float')) {
      gl.getExtension('OES_texture_float_linear');
      TEXTYPE = gl.FLOAT;
    } else {
      glFailed = true; console.error('[ink-blobs] float textures unavailable'); return;
    }
    console.log('[ink-blobs] Initializing WebGL fluid sim (deferred)');

    const defs = {
      splat: SPLAT_FRAG, adv: ADV_FRAG, div: DIV_FRAG, curl: CURL_FRAG,
      vort: VORT_FRAG, pres: PRES_FRAG, grad: GRAD_FRAG, clear: CLEAR_FRAG, display: DISPLAY_FRAG,
    };
    for (const k in defs) {
      const pr = makeProg(defs[k]);
      if (!pr) { glFailed = true; return; }
      progs[k] = pr;
    }

    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    glReady = true;
    // FBOs are created in resize() once the canvas has real dimensions.
  }

  function use(o) {
    gl.useProgram(o.p);
    const a = gl.getAttribLocation(o.p, 'aP');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  }
  function blit(target) {
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const aspect = () => drawW / drawH;

  function splatTo(target, x, y, color) {
    const o = progs.splat;
    use(o);
    gl.uniform2f(o.u.texelSize, target.texelX, target.texelY);
    gl.uniform1i(o.u.uTarget, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.read.tex);
    gl.uniform1f(o.u.aspectRatio, aspect());
    gl.uniform2f(o.u.point, x, y);
    gl.uniform1f(o.u.radius, SPLAT_RADIUS);
    gl.uniform4f(o.u.color, color[0], color[1], color[2], color[3]);
    blit(target.write);
    target.swap();
  }

  // A jet is a short-lived streaming emitter rather than one instantaneous
  // splat: it ramps ink + velocity in and out over its lifetime (sin
  // envelope) so ink flows in smoothly instead of popping/flashing.
  const jets = [];
  // Color starts at a random palette entry, then cycles through the rest in
  // order so every jet is a different color from the last.
  let jetColorIndex = Math.floor(Math.random() * palette.length);
  // Side starts random, then alternates left/right so consecutive jets don't
  // enter from the same edge.
  let jetSide = Math.random() < 0.5 ? -1 : 1;
  function spawnJet(level) {
    const side = jetSide;
    jetSide = -jetSide;
    const c = palette[jetColorIndex % palette.length];
    jetColorIndex++;
    // The chat text sits in the bottom-left (low y on the left). Keep left
    // jets in the upper area so ink never enters over the text; right jets
    // use the full height.
    const y = side < 0 ? 0.52 + Math.random() * 0.38 : 0.12 + Math.random() * 0.76;
    jets.push({
      dir: side < 0 ? 1 : -1,
      x: side < 0 ? 0.02 : 0.98,
      y,
      vy: (Math.random() - 0.5) * 0.6,
      col: [c[0] / 255, c[1] / 255, c[2] / 255],
      age: 0,
      dur: 0.4 + Math.random() * 0.3,
      force: JET_FORCE * (0.85 + level * 0.3),  // jets enter at a near-constant gentle force
      dyeMul: 0.9 + level * 0.5,
    });
  }
  function emitJets(dt) {
    for (let i = jets.length - 1; i >= 0; i--) {
      const j = jets[i];
      j.age += dt;
      const tt = j.age / j.dur;
      if (tt >= 1) { jets.splice(i, 1); continue; }
      const env = Math.sin(tt * Math.PI);   // smooth ramp in/out
      splatTo(vel, j.x, j.y, [j.dir * j.force * env, j.vy * j.force * env, 0, 0]);
      const a = DYE_RATE * dt * env * j.dyeMul;
      splatTo(dye, j.x, j.y, [j.col[0] * a, j.col[1] * a, j.col[2] * a, a]);
    }
  }

  function step(dt) {
    gl.disable(gl.BLEND);
    let o;
    // curl
    o = progs.curl; use(o); gl.uniform2f(o.u.texelSize, vel.texelX, vel.texelY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vel.read.tex); gl.uniform1i(o.u.uVelocity, 0);
    blit(curlFbo);
    // vorticity
    o = progs.vort; use(o); gl.uniform2f(o.u.texelSize, vel.texelX, vel.texelY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vel.read.tex); gl.uniform1i(o.u.uVelocity, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, curlFbo.tex); gl.uniform1i(o.u.uCurl, 1);
    gl.uniform1f(o.u.curl, dynCurl); gl.uniform1f(o.u.dt, dt);
    blit(vel.write); vel.swap();
    // divergence
    o = progs.div; use(o); gl.uniform2f(o.u.texelSize, vel.texelX, vel.texelY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vel.read.tex); gl.uniform1i(o.u.uVelocity, 0);
    blit(divFbo);
    // clear pressure
    o = progs.clear; use(o);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pre.read.tex); gl.uniform1i(o.u.uTexture, 0);
    gl.uniform1f(o.u.value, PRESSURE);
    blit(pre.write); pre.swap();
    // pressure jacobi
    o = progs.pres; use(o); gl.uniform2f(o.u.texelSize, vel.texelX, vel.texelY);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, divFbo.tex); gl.uniform1i(o.u.uDivergence, 1);
    for (let i = 0; i < PRESSURE_ITER; i++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pre.read.tex); gl.uniform1i(o.u.uPressure, 0);
      blit(pre.write); pre.swap();
    }
    // gradient subtract
    o = progs.grad; use(o); gl.uniform2f(o.u.texelSize, vel.texelX, vel.texelY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pre.read.tex); gl.uniform1i(o.u.uPressure, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, vel.read.tex); gl.uniform1i(o.u.uVelocity, 1);
    blit(vel.write); vel.swap();
    // advect velocity
    o = progs.adv; use(o); gl.uniform2f(o.u.texelSize, vel.texelX, vel.texelY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vel.read.tex);
    gl.uniform1i(o.u.uVelocity, 0); gl.uniform1i(o.u.uSource, 0);
    gl.uniform1f(o.u.dt, dt); gl.uniform1f(o.u.dissipation, VEL_DISS);
    blit(vel.write); vel.swap();
    // advect dye
    use(o); gl.uniform2f(o.u.texelSize, dye.texelX, dye.texelY);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vel.read.tex); gl.uniform1i(o.u.uVelocity, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dye.read.tex); gl.uniform1i(o.u.uSource, 1);
    gl.uniform1f(o.u.dt, dt); gl.uniform1f(o.u.dissipation, DEN_DISS);
    blit(dye.write); dye.swap();
  }

  function renderDisplay() {
    const o = progs.display; use(o);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dye.read.tex); gl.uniform1i(o.u.uTexture, 0);
    blit(null);
  }

  let drawW = 0, drawH = 0, rafId = null, lastTime = 0, lastTickTime = 0;
  let mounted = false, resizeObs = null;
  let warmupTimer = null, warmupActive = false, warmupStopTimer = null, overlayEl = null;
  let spawnAccumulator = 0, smoothLevel = 0, dynCurl = CURL;
  let fpsFrameCount = 0, fpsAccum = 0, fpsLast = 0, fpsDrawMin = Infinity, fpsDrawMax = 0, fpsDisplay = '';

  function mount() {
    if (mounted) return;
    ui.appendChild(wrapper);
    mounted = true;
    if (!resizeObs) resizeObs = new ResizeObserver(resize);
    resizeObs.observe(wrapper);
    resize();
    scheduleWarmup('mount');
  }
  function unmount() {
    if (!mounted) return;
    cancelWarmup();
    stopLoop();
    if (resizeObs) resizeObs.disconnect();
    drawW = 0; drawH = 0;
    jets.length = 0;
    wrapper.remove();
    mounted = false;
  }

  function resize() {
    const rect = wrapper.getBoundingClientRect();
    if (!rect.width || !rect.height || !glReady) { drawW = 0; drawH = 0; return; }
    drawW = rect.width;
    drawH = rect.height;
    canvas.width = Math.max(1, Math.round(rect.width * CANVAS_SCALE));
    canvas.height = Math.max(1, Math.round(rect.height * CANVAS_SCALE));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    setupFBOs();
  }

  function checkSkinActive() {
    const styleEl = document.getElementById('voice-satellite-styles');
    const isActive = styleEl?.textContent.includes('.vs-inkblobs') ?? false;
    if (isActive) mount();
    else unmount();
  }
  function observeStyleEl() {
    const el = document.getElementById('voice-satellite-styles');
    if (el) {
      new MutationObserver(checkSkinActive).observe(el, { childList: true, characterData: true, subtree: true });
      checkSkinActive();
      return;
    }
    const headObs = new MutationObserver(() => {
      const created = document.getElementById('voice-satellite-styles');
      if (created) {
        headObs.disconnect();
        new MutationObserver(checkSkinActive).observe(created, { childList: true, characterData: true, subtree: true });
        checkSkinActive();
      }
    });
    headObs.observe(document.head, { childList: true });
  }
  observeStyleEl();

  function draw() {
    if (!drawW || !drawH || !glReady) return;
    const t = performance.now() / 1000;
    let dt = lastTime ? t - lastTime : 0.016;
    if (dt > 0.0167) dt = 0.0167;
    lastTime = t;

    const barVisible = barEl.classList.contains('visible');
    const isProcessing = barEl.classList.contains('processing');
    const isActive = barVisible && !isProcessing;
    let rawLevel = 0;
    if (isActive) rawLevel = parseFloat(barEl.style.getPropertyValue('--vs-audio-level')) || 0;
    else if (isProcessing) rawLevel = 0.3;
    const lvlRate = rawLevel > smoothLevel ? 0.2 : 0.08;
    smoothLevel += (rawLevel - smoothLevel) * lvlRate;
    const eff = Math.min(1, smoothLevel * AUDIO_GAIN);   // pronounced mic/TTS reactivity
    dynCurl = CURL * (1 + eff * CURL_REACT);             // audio churns the whole fluid

    spawnAccumulator += dt * (IDLE_JET_RATE + eff * ACTIVE_JET_RATE);
    while (spawnAccumulator >= 1) { spawnAccumulator -= 1; spawnJet(eff); }

    emitJets(dt);
    step(dt);
    renderDisplay();
  }

  function tick() {
    const t0 = performance.now();
    const interval = Number(document.querySelector('voice-satellite-card')?.config?.reactive_bar_update_interval_ms) || 33;
    if (t0 - lastTickTime < Math.max(8, interval)) { rafId = requestAnimationFrame(tick); return; }
    lastTickTime = t0;
    const debug = !!document.querySelector('voice-satellite-card')?.config?.debug;
    draw();
    if (debug) {
      const drawMs = performance.now() - t0;
      fpsFrameCount++;
      if (drawMs < fpsDrawMin) fpsDrawMin = drawMs;
      if (drawMs > fpsDrawMax) fpsDrawMax = drawMs;
      fpsAccum += drawMs;
      if (t0 - fpsLast >= 2000) {
        const fps = (fpsFrameCount / (t0 - fpsLast) * 1000).toFixed(1);
        const avg = (fpsAccum / fpsFrameCount).toFixed(1);
        fpsDisplay = `${fps} fps | step+draw: ${avg}ms avg, ${fpsDrawMin.toFixed(1)}-${fpsDrawMax.toFixed(1)}ms | sim ${vel?.w}x${vel?.h} dye ${dye?.w}x${dye?.h} | jets ${jets.length}`;
        console.log(`[ink-blobs] ${fpsDisplay}`);
        fpsFrameCount = 0; fpsAccum = 0; fpsDrawMin = Infinity; fpsDrawMax = 0; fpsLast = t0;
      }
      if (fpsDisplay) debugEl.textContent = fpsDisplay;
      debugEl.style.color = isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.75)';
      debugEl.style.display = 'block';
    } else if (debugEl.style.display !== 'none') {
      debugEl.style.display = 'none';
    }
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (!rafId && !document.hidden) {
      initGL();
      if (glFailed) return;
      resize();
      detectTheme();
      lastTime = 0;
      tick();
    }
  }
  function cancelWarmup() {
    if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
    if (warmupStopTimer) { clearTimeout(warmupStopTimer); warmupStopTimer = null; }
    warmupActive = false;
  }
  function scheduleWarmup(reason) {
    if (HIDDEN_WARMUP_BLOCKED) return;
    if (document.hidden || !mounted || overlayEl?.classList.contains('visible')) return;
    if (warmupTimer || rafId) return;
    warmupTimer = setTimeout(() => {
      warmupTimer = null;
      if (document.hidden || !mounted || overlayEl?.classList.contains('visible')) return;
      warmupActive = true;
      console.log(`[ink-blobs] Starting hidden warmup (${reason})`);
      startLoop();
      warmupStopTimer = setTimeout(() => {
        warmupStopTimer = null;
        if (warmupActive && !overlayEl?.classList.contains('visible')) {
          console.log('[ink-blobs] Hidden warmup complete');
          stopLoop();
        }
      }, 1800);
    }, 1200);
  }
  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    warmupActive = false;
  }

  overlayEl = ui.querySelector('.vs-blur-overlay');
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelWarmup(); stopLoop(); }
    else if (overlayEl?.classList.contains('visible')) startLoop();
    else scheduleWarmup('visibility');
  });
  if (overlayEl) {
    new MutationObserver(() => {
      if (overlayEl.classList.contains('visible')) { cancelWarmup(); startLoop(); }
      else { stopLoop(); scheduleWarmup('overlay-hidden'); }
    }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
  }
  for (const type of ['pointerdown', 'touchstart', 'keydown']) {
    window.addEventListener(type, () => scheduleWarmup(type), { passive: true });
  }

  return true;
}

export function ensureInkBlobsSkinRuntime() {
  if (setup()) return;
  const bodyObs = new MutationObserver(() => {
    if (document.getElementById('voice-satellite-ui')) {
      bodyObs.disconnect();
      setup();
    }
  });
  bodyObs.observe(document.body, { childList: true });
}

// ── Skin export ──────────────────────────────────────────────────────

export const inkBlobsSkin = {
  id: 'ink-blobs',
  name: 'Ink Blobs',
  css,
  reactiveBar: true,
  overlayColor: [244, 246, 250],
  darkOverlayColor: [0, 0, 0],
  defaultOpacity: 1,
  darkDefaultOpacity: 1,
  previewCSS,
};
