// Decoded from the user's research page (https://always-on-eyes-ui-ux-for-a-tiny-desktop-t22o.pages.grok.bot/), 2026-11-11.
// Design reference for the eyes only. Known bugs, do not copy: "cleared" renders inverted, lids show as black caps in light mode.
// How to re-fetch: docs/research/pi-sdk.md, "Reading the research page" (the iframe needs Sec-Fetch-Dest: iframe).


const STATES = [
  { value: "idle", label: "Idle (slow blink)" },
  { value: "listening", label: "Listening" },
  { value: "thinking", label: "Thinking (curious tilt)" },
  { value: "speaking", label: "Speaking (bounce)" },
  { value: "happy", label: "Happy ^^" },
  { value: "hearts", label: "Heart eyes" },
  { value: "error", label: "Error" },
  { value: "cleared", label: "Context cleared (wipe)" },
  { value: "sleeping", label: "Sleeping" }
];
const EYE_CSS = ".lids{transform-box:fill-box;transform-origin:center;transform:scaleY(0)}.anim-blink .lids{animation:blink 3.8s ease-in-out infinite}@keyframes blink{0%,80%,100%{transform:scaleY(0)}84%{transform:scaleY(1)}88%{transform:scaleY(0.1)}92%{transform:scaleY(1)}96%{transform:scaleY(0)}}.anim-bounce{transform-box:fill-box;transform-origin:center;animation:bounce 0.72s ease-in-out infinite}@keyframes bounce{0%,100%{transform:translateY(0) scale(1,1)}40%{transform:translateY(-6px) scale(1.05,0.93)}70%{transform:translateY(2px) scale(0.98,1.05)}}.anim-pulse{transform-box:fill-box;transform-origin:center;animation:pulse 1.5s ease-in-out infinite}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}.anim-breathe{transform-box:fill-box;transform-origin:center;animation:breathe 2.8s ease-in-out infinite}@keyframes breathe{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.04,0.96) translateY(2px)}}.anim-wipe .lids{animation:wipe 1.35s ease-in-out infinite}@keyframes wipe{0%,100%{transform:scaleY(0)}30%,48%{transform:scaleY(1)}72%{transform:scaleY(0)}82%{transform:scaleY(0.18)}90%{transform:scaleY(0)}}";
const HINT = {
  idle: "Ask anything, or hold Ctrl to talk",
  listening: "Listening...",
  thinking: "Thinking...",
  speaking: "Here is a shorter version.",
  happy: "Nice, that worked.",
  hearts: "Loved that.",
  error: "The model endpoint timed out.",
  cleared: "Context cleared",
  sleeping: "Idle for a while. Click to wake."
};
function glowColor(state) {
  switch (state) {
    case "listening":
      return "#4CFFE3";
    case "thinking":
      return "#FFD56A";
    case "speaking":
      return "#C9B8FF";
    case "error":
      return "#FF8B82";
    case "cleared":
      return "#E7FFFB";
    case "sleeping":
      return "#8ED8D3";
    default:
      return "#5EF6F0";
  }
}
function heartPath(cx, cy, s) {
  return "M " + cx + " " + (cy + s * 0.38) + " C " + (cx - s * 0.08) + " " + (cy + s * 0.18) + ", " + (cx - s * 0.52) + " " + (cy - s * 0.02) + ", " + (cx - s * 0.48) + " " + (cy - s * 0.22) + " C " + (cx - s * 0.44) + " " + (cy - s * 0.46) + ", " + (cx - s * 0.16) + " " + (cy - s * 0.48) + ", " + cx + " " + (cy - s * 0.22) + " C " + (cx + s * 0.16) + " " + (cy - s * 0.48) + ", " + (cx + s * 0.44) + " " + (cy - s * 0.46) + ", " + (cx + s * 0.48) + " " + (cy - s * 0.22) + " C " + (cx + s * 0.52) + " " + (cy - s * 0.02) + ", " + (cx + s * 0.08) + " " + (cy + s * 0.18) + ", " + cx + " " + (cy + s * 0.38) + " Z";
}
function filledArc(cx, cy, w, h, t) {
  const l = cx - w / 2;
  const r = cx + w / 2;
  return "M " + l + " " + cy + " Q " + cx + " " + (cy - h) + " " + r + " " + cy + " Q " + cx + " " + (cy - h + t) + " " + l + " " + cy + " Z";
}
function CuteEyes({ state, animate, uid, width = 320, height = 190 }) {
  const c = glowColor(state);
  const tilt = state === "thinking" ? -13 : 0;
  const left = { cx: 118, cy: 94 };
  const right = { cx: 202, cy: 94 };
  const big = state === "listening" || state === "cleared";
  const eyeW = big ? 76 : 68;
  const eyeH = big ? 76 : 68;
  const rx = 21;
  let lookX = 0;
  let lookY = 0;
  if (state === "thinking") {
    lookX = 8;
    lookY = -9;
  }
  if (state === "error") lookY = 4;
  const blushOp = state === "happy" || state === "hearts" ? 0.28 : 0;
  const pairClass = [
    animate && state === "speaking" ? "anim-bounce" : "",
    animate && state === "listening" ? "anim-pulse" : "",
    animate && state === "idle" ? "anim-blink" : "",
    animate && state === "sleeping" ? "anim-breathe" : "",
    animate && state === "cleared" ? "anim-wipe" : ""
  ].filter(Boolean).join(" ");
  const showLids = Boolean(animate && (state === "idle" || state === "cleared"));
  const renderEye = (side) => {
    const o = side === "left" ? left : right;
    const cx = o.cx + lookX;
    const cy = o.cy + lookY;
    const slant = state === "error" ? side === "left" ? -16 : 16 : state === "thinking" ? side === "left" ? -4 : 6 : 0;
    if (state === "hearts") {
      return /* @__PURE__ */ React.createElement("g", { key: side, transform: "rotate(" + slant + " " + cx + " " + cy + ")" }, /* @__PURE__ */ React.createElement("path", { d: heartPath(cx, cy + 2, 46), fill: c, filter: "url(#" + uid + "bloom)", opacity: "0.9" }), /* @__PURE__ */ React.createElement("path", { d: heartPath(cx, cy + 2, 46), fill: "url(#" + uid + "fill)" }), /* @__PURE__ */ React.createElement("ellipse", { cx: cx - 8, cy: cy - 8, rx: "8", ry: "6", fill: "#fff", opacity: "0.88" }), /* @__PURE__ */ React.createElement("circle", { cx: cx + 8, cy: cy - 2, r: "2.4", fill: "#fff", opacity: "0.95" }));
    }
    if (state === "happy") {
      return /* @__PURE__ */ React.createElement("g", { key: side }, /* @__PURE__ */ React.createElement("path", { d: filledArc(cx, cy + 8, 70, 26, 16), fill: c, filter: "url(#" + uid + "bloom)", opacity: "0.95" }), /* @__PURE__ */ React.createElement("path", { d: filledArc(cx, cy + 8, 70, 26, 16), fill: "url(#" + uid + "fill)" }), /* @__PURE__ */ React.createElement("path", { d: filledArc(cx - 4, cy + 4, 28, 16, 5), fill: "#fff", opacity: "0.55" }));
    }
    if (state === "sleeping") {
      return /* @__PURE__ */ React.createElement("g", { key: side }, /* @__PURE__ */ React.createElement("path", { d: filledArc(cx, cy + 10, 72, 16, 11), fill: c, filter: "url(#" + uid + "bloom)", opacity: "0.85" }), /* @__PURE__ */ React.createElement("path", { d: filledArc(cx, cy + 10, 72, 16, 11), fill: "url(#" + uid + "fill)" }));
    }
    const x = cx - eyeW / 2;
    const clipH = state === "error" ? eyeH * 0.78 : eyeH;
    const y2 = state === "error" ? cy - eyeH / 2 + (eyeH - clipH) * 0.35 : cy - eyeH / 2;
    return /* @__PURE__ */ React.createElement("g", { key: side, transform: "rotate(" + slant + " " + cx + " " + cy + ")" }, state === "listening" ? /* @__PURE__ */ React.createElement(
      "rect",
      {
        x: x - 7,
        y: y2 - 7,
        width: eyeW + 14,
        height: clipH + 14,
        rx: rx + 4,
        fill: "none",
        stroke: c,
        strokeWidth: "2",
        opacity: "0.35"
      }
    ) : null, /* @__PURE__ */ React.createElement("rect", { x, y: y2, width: eyeW, height: clipH, rx, ry: rx, fill: c, filter: "url(#" + uid + "bloom)", opacity: "0.9" }), /* @__PURE__ */ React.createElement("rect", { x, y: y2, width: eyeW, height: clipH, rx, ry: rx, fill: "url(#" + uid + "fill)" }), /* @__PURE__ */ React.createElement("rect", { x: x + 6, y: y2 + 5, width: eyeW - 12, height: clipH * 0.46, rx: rx - 7, fill: "url(#" + uid + "sheen)", opacity: "0.65" }), /* @__PURE__ */ React.createElement("ellipse", { cx: cx - 12, cy: y2 + 18, rx: "14", ry: "10", fill: "#fff", opacity: "0.82" }), /* @__PURE__ */ React.createElement("circle", { cx: cx + 12, cy: y2 + 24, r: "3.2", fill: "#fff", opacity: "0.95" }), state === "error" && side === "right" ? /* @__PURE__ */ React.createElement("path", { d: "M " + (cx + 36) + " " + (cy + 10) + " Q " + (cx + 42) + " " + (cy + 22) + " " + (cx + 34) + " " + (cy + 28) + " Q " + (cx + 30) + " " + (cy + 18) + " " + (cx + 36) + " " + (cy + 10) + " Z", fill: "#7FD4FF", opacity: "0.9" }) : null);
  };
  return /* @__PURE__ */ React.createElement("svg", { width, height, viewBox: "0 0 320 190", role: "img", "aria-label": "Eyes, " + state + " state" }, /* @__PURE__ */ React.createElement("defs", null, /* @__PURE__ */ React.createElement("linearGradient", { id: uid + "fill", x1: "0", y1: "0", x2: "0", y2: "1" }, /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "#FFFFFF" }), /* @__PURE__ */ React.createElement("stop", { offset: "22%", stopColor: "#E8FFFC" }), /* @__PURE__ */ React.createElement("stop", { offset: "55%", stopColor: c }), /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: c })), /* @__PURE__ */ React.createElement("linearGradient", { id: uid + "sheen", x1: "0", y1: "0", x2: "0", y2: "1" }, /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "#fff", stopOpacity: "0.95" }), /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: "#fff", stopOpacity: "0" })), /* @__PURE__ */ React.createElement("radialGradient", { id: uid + "pill", cx: "50%", cy: "28%", r: "72%" }, /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "#181B22" }), /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: "#07080C" })), /* @__PURE__ */ React.createElement("filter", { id: uid + "bloom", x: "-70%", y: "-70%", width: "240%", height: "240%" }, /* @__PURE__ */ React.createElement("feGaussianBlur", { stdDeviation: "5.5", result: "b" }), /* @__PURE__ */ React.createElement("feMerge", null, /* @__PURE__ */ React.createElement("feMergeNode", { in: "b" }), /* @__PURE__ */ React.createElement("feMergeNode", { in: "b" }), /* @__PURE__ */ React.createElement("feMergeNode", { in: "SourceGraphic" }))), /* @__PURE__ */ React.createElement("filter", { id: uid + "blushf", x: "-50%", y: "-50%", width: "200%", height: "200%" }, /* @__PURE__ */ React.createElement("feGaussianBlur", { stdDeviation: "4" })), /* @__PURE__ */ React.createElement("style", null, EYE_CSS)), /* @__PURE__ */ React.createElement("rect", { x: "16", y: "16", width: "288", height: "158", rx: "79", fill: "url(#" + uid + "pill)" }), /* @__PURE__ */ React.createElement("rect", { x: "16.6", y: "16.6", width: "286.8", height: "156.8", rx: "78", fill: "none", stroke: "rgba(255,255,255,0.07)", strokeWidth: "1.2" }), /* @__PURE__ */ React.createElement("g", { className: pairClass, transform: "rotate(" + tilt + " 160 100)" }, renderEye("left"), renderEye("right"), showLids ? /* @__PURE__ */ React.createElement("g", { className: "lids" }, /* @__PURE__ */ React.createElement("rect", { x: left.cx - eyeW / 2 - 3, y: left.cy - eyeH / 2 - 3, width: eyeW + 6, height: eyeH + 6, rx: rx + 1, fill: "#0B0C10" }), /* @__PURE__ */ React.createElement("rect", { x: right.cx - eyeW / 2 - 3, y: right.cy - eyeH / 2 - 3, width: eyeW + 6, height: eyeH + 6, rx: rx + 1, fill: "#0B0C10" })) : null), blushOp ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("ellipse", { cx: "88", cy: "136", rx: "22", ry: "10", fill: "#FF8AA8", opacity: blushOp, filter: "url(#" + uid + "blushf)" }), /* @__PURE__ */ React.createElement("ellipse", { cx: "232", cy: "136", rx: "22", ry: "10", fill: "#FF8AA8", opacity: blushOp, filter: "url(#" + uid + "blushf)" })) : null);
}
function BarMock({ state }) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        maxWidth: 560,
        height: 72,
        borderRadius: 36,
        background: "#0C0E13",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.07)",
        padding: "0 10px 0 4px",
        color: "#F4F1EA",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: 14
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { width: 124, height: 72, overflow: "hidden", flex: "0 0 124px" } }, /* @__PURE__ */ React.createElement("div", { style: { transform: "scale(0.38)", transformOrigin: "left center" } }, /* @__PURE__ */ React.createElement(CuteEyes, { state, uid: "bar-" + state, animate: false, width: 320, height: 190 }))),
    /* @__PURE__ */ React.createElement("div", { style: { flex: 1, color: state === "idle" || state === "sleeping" ? "#9A9488" : "#F4F1EA" } }, HINT[state]),
    /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: "#9A9488", fontFamily: "ui-monospace, SFMono-Regular, monospace", paddingRight: 8 } }, state === "cleared" ? "0% ctx" : state === "sleeping" ? "12% ctx" : "12% ctx")
  );
}
function App() {
  const [state, setState] = useState("idle");
  return /* @__PURE__ */ React.createElement(
    Page,
    {
      title: "Always-on eyes: UI/UX for a tiny desktop AI assistant",
      summary: "Redesigned cute glowing eyes, a survey of apps already close to this idea, and a name shortlist. Links and domain lookups checked 11 Nov 2026 (Asia/Calcutta).",
      width: "wide"
    },
    /* @__PURE__ */ React.createElement(Section, { heading: "Cute eyes, redesigned", id: "mockups" }, /* @__PURE__ */ React.createElement(Text, null, "The first mockups were flat cream blobs with tiny pupils, and they did not look cute. This pass follows the actual face language of desk pets: big glossy rounded-square eyes, cyan glow on a dark pill, a soft highlight and sparkle, and expression changes instead of a drawn-on eyeball. I studied official EMO product shots (LivingAI), Anki Vector and Cozmo character art, plus Eilik, Dasai Mochi, and kawaii closed-eye arcs. These SVGs are original drawings in that language, not copies of any commercial sprite. Pick a state. The large pair at the top is animated when the state has motion (idle blink, listening pulse, thinking tilt, speaking bounce, wipe, sleep breathe)."), /* @__PURE__ */ React.createElement(
      Select,
      {
        label: "Eye state",
        options: STATES,
        value: state,
        onChange: (v) => setState(v)
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start", margin: "16px 0 8px" } }, /* @__PURE__ */ React.createElement(CuteEyes, { state, uid: "hero-" + state, animate: true, width: 420, height: 250 }), /* @__PURE__ */ React.createElement(BarMock, { state })), /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 12,
          margin: "12px 0 16px"
        }
      },
      STATES.map((s) => /* @__PURE__ */ React.createElement(
        "button",
        {
          key: s.value,
          onClick: () => setState(s.value),
          style: {
            appearance: "none",
            background: "transparent",
            border: state === s.value ? "1px solid rgba(94,246,240,0.45)" : "1px solid transparent",
            borderRadius: 16,
            padding: 0,
            cursor: "pointer",
            color: "#C8C2B6",
            fontSize: 11,
            fontFamily: "ui-sans-serif, system-ui, sans-serif"
          }
        },
        /* @__PURE__ */ React.createElement(CuteEyes, { state: s.value, uid: "grid-" + s.value, animate: false, width: 220, height: 130 }),
        /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "0 0 8px" } }, s.label)
      ))
    ), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["State", "What the eyes do", "When it appears"],
        rows: [
          ["Idle", "Rounded-square cyan eyes, glossy highlight and sparkle, a slow squish blink every few seconds", "App is running, no turn in flight"],
          ["Listening", "Slightly larger, a soft ring, a gentle pulse, locked forward", "Hold-to-talk or click-to-talk is active"],
          ["Thinking", "The whole pair tilts, gaze shifts up and to the right, amber glow", "Waiting on the model, including first-token delay"],
          ["Speaking", "Lavender glow, a soft squash-and-bounce", "Streaming a reply or playing TTS"],
          ["Happy ^^", "Closed hill-shaped arcs with a soft blush, the kawaii content face", "A short delight after a good result, or a reaction"],
          ["Heart eyes", "Two glowing hearts with the same gloss highlights", "A rarer delight, keep it scarce so it stays cute"],
          ["Error", "Inward slant, coral glow, a tiny tear", "Network, auth, or model failure"],
          ["Context cleared", "A wipe blink, then extra-bright wide eyes, meter goes to 0%", "User hits the clear-context shortcut"],
          ["Sleeping", "Thin peaceful crescents, a slow breathe", "Hidden-until-hotkey is off, and the orb has been idle for a while"]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Text, null, "Why this looks more like a pet: official EMO shots show a black face with two glowing rounded squares and a short list of morphs (open squares, sleepy arcs, hearts, slants). Vector uses the same idea in a slightly wider rectangle. The cute part is the glow, the rounding, the blink, and the expression change, not a detailed iris. Anki-era notes still apply: a slow blink reads as trust, and the stare should break so contact is not held too long.")),
    /* @__PURE__ */ React.createElement(Callout, { tone: "info", lead: "Top recommendation" }, "Build an always-on-top eyes pill that expands into a compact Spotlight-style bar, not a full chat window first. Use Tauri 2 with a thin web UI, SVG or CSS eyes in this glowing rounded-square language, and lazy-load whisper.cpp plus Piper only when the user talks. Keep one running conversation in SQLite until a clear-context shortcut, and store the API key in the OS keychain. Avoid Option+Space and Command+Space as defaults. Those keys already belong to ChatGPT Mini, BoltAI Instant Chat, optional Claude Quick Entry, and Apple Spotlight."),
    /* @__PURE__ */ React.createElement(
      TableOfContents,
      {
        items: [
          { label: "Cute eyes, redesigned", id: "mockups" },
          { label: "Already out there", id: "already" },
          { label: "The product in one picture", id: "concept" },
          { label: "Name ideas", id: "names" },
          { label: "States, motion, and layout", id: "ui" },
          { label: "Hotkeys, size, color, type", id: "spec" },
          { label: "Context and caching", id: "context" },
          { label: "Settings for any OpenAI-compatible route", id: "settings" },
          { label: "Reference apps and patterns", id: "refs" },
          { label: "Character and mascot references", id: "mascots" },
          { label: "Lightweight stack", id: "stack" },
          { label: "Open-source cousins", id: "oss" },
          { label: "What not to copy", id: "dont" },
          { label: "A first prototype", id: "plan" },
          { label: "Not known", id: "unknown" },
          { label: "Sources", id: "sources" }
        ]
      }
    ),
    /* @__PURE__ */ React.createElement(Section, { heading: "Already out there", id: "already" }, /* @__PURE__ */ React.createElement(Text, null, "You asked whether this idea already exists. Pieces of it do. The exact combo (a cute always-on eyes mascot, a global hotkey, local speech in and out, any OpenAI-compatible endpoint, and a session that lasts until you clear it) does not show up as one product in the sources below. Links were HTTP-checked on 11 Nov 2026 and returned 200 unless noted."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Name", "What it covers", "What's missing versus this idea"],
        rows: [
          ["BoltAI Instant Chat (boltai.com)", "Native Mac app. A global shortcut opens an Instant Chat bar over any app (the help page documents Opt+Space). Instant Dictation can use a local engine (the author recommends Parakeet TDT) or cloud. It talks to OpenAI, Anthropic, Google, Mistral, Azure, Bedrock, plus local models via Ollama and LM Studio. Long chats can auto-compact, and a ring by the mic shows how much context the next message will send. Chats are stored locally in SQLite.", "No always-on cute eyes mascot. Mac-first, paid app, not a tiny low-memory orb. The documented Instant Chat shortcut is the same crowded Option+Space key."],
          ["ChatGPT desktop Pets / Mini", "A floating companion on macOS and Windows. You can type or speak from controls under the pet. Official states include Running, Needs input, Ready, and Blocked. Default shortcuts are Option+Space and Windows+Alt+P.", "Locked to OpenAI's product, not any OpenAI-compatible base URL you paste in. Speech is ChatGPT Voice, not a local STT or TTS model you control. The pet is a heavier sprite, not a tiny eyes pill."],
          [
            "Claude Desktop Quick Entry",
            "A small box over the current app. Default is a double-tap of Option. Drag to screenshot, click a window to attach it, optional Caps Lock dictation (macOS 14+).",
            "Anthropic's Help Center still says Quick Entry is macOS-only. Dictation is not a local model you ship. No cute always-on eyes mascot, and you are tied to Claude, not any compatible endpoint."
          ],
          ["Raycast Quick AI and AI Chat", "Hotkey launcher with Quick AI for one-off questions and AI Chat for longer threads, Screen Awareness, auto-summarise near the context limit, many model providers.", "A command palette, not a persistent eyes character. The May 2026 redesign still splits quick ask and the full chat window."],
          ["sideOS (sideos.ai)", "A Mac assistant that lives in the notch. Hold Control+Option to talk, double-tap Control to type, voice and text share one thread, model choice including OpenAI, local dictation on Apple speech engines.", "Paid, Apple Silicon, macOS 14+. It drives apps, which is more than this brief. It is a notch island, not a cute eyes mascot."],
          ["Enchanted (github.com/gluonfield/enchanted)", "Open-source native Apple client for Ollama. Conversation history is stored on device and sent with later calls. The README lists a macOS Spotlight panel on Ctrl+Command+K, voice prompts, text to speech, and offline use. The same README now says Jaz is the new iteration of the project.", "Ollama-focused, not a general OpenAI-compatible settings panel. The Spotlight panel is a shortcut overlay, not an always-on eyes pet. Voice is listed, but it is not documented there as a shipped local whisper.cpp sidecar."],
          ["Msty Studio (msty.ai)", "A private AI workspace. Official docs say Desktop can run local models through Ollama, MLX, and llama.cpp, and that you can add an OpenAI-compatible provider with a base URL such as http://localhost:11434/v1.", "A full workspace, not a hotkey-summoned eyes orb. I did not find official docs for a cute mascot or a built-in local STT/TTS loop like the one in this brief."],
          ["Jan (jan.ai, github.com/janhq/jan)", "Open-source ChatGPT-style desktop app (Apache 2.0, Tauri). Local LLMs, plus cloud providers (OpenAI, Anthropic, and others). An OpenAI-compatible local server at localhost:1337. The marketing site shows a Memory feature as coming soon.", "A full chat app, not a tiny always-on mascot or a documented global-hotkey overlay. Local voice in and out is not listed in the README feature set I checked."],
          ["LM Studio (lmstudio.ai)", "Local model runner. Official docs expose an OpenAI-compatible server (examples use http://localhost:1234/v1). The current homepage also markets Bionic, an agent with on-device real-time voice transcription.", "A full studio and agent, not a cute always-on eyes overlay. You would still build the mascot, the tiny bar, and the clear-context shortcut yourself, maybe pointing at this server."],
          ["Ollamac (github.com/kevinhermawan/Ollamac)", "Native, free, open-source Mac chat client for Ollama, with a customizable host, syntax highlighting, and a simple UI. macOS 14+.", "Ollama only. No documented always-on mascot, global overlay, or local STT/TTS loop."],
          ["Alfred 6", "Tiny native Mac launcher (official v6 page says the dmg is less than 6 MB). Optional AI with your own key, custom hotkeys, official ChatGPT workflow.", "A launcher and workflow host, not a persistent eyes character or a built-in local voice stack."],
          ["MeshUtility", "Tray-resident Tauri 2 app. Local whisper.cpp, floating overlay, any OpenAI-compatible endpoint, SQLite, a pill with idle, listening, processing, and done states.", "Dictation and prompt enhancing, not a long-running chat companion with a cute eyes character."],
          ["PAL and MIND", "Open-source Tauri assistants with local whisper.cpp and local TTS (Kokoro in PAL, Piper in MIND), tray and shortcuts.", "Not the cute rounded-square eyes mascot. MIND is AGPL and Windows-first. PAL's README still treats session memory as later work."],
          ["Komorebi (interactive_assistent)", "A desktop companion with a Live2D avatar, idle blinking, eye tracking, whisper.cpp, Piper, OpenRouter, SQLite, and global shortcuts.", "The closest cute-companion cousin, but heavier than this brief. Cubism Core is proprietary. It is an anime avatar, not a tiny eyes pill."],
          ["clippy-desktop (github.com/quinnjr/clippy-desktop)", "Always-on-top, transparent desktop Clippy using the original Office animations. The README says it talks to any OpenAI-compatible server and streams the reply into a balloon. Windows, macOS, and Linux.", "The mascot is Clippy, not glowing eyes. The README I checked does not describe local STT or TTS."],
          ["FireCubeStudios/Clippy", "A Windows desktop Clippy that can be pinned for chat, powered by OpenAI GPT-3.5 with a user key.", "OpenAI-only in the README I checked, not any compatible route, and not a local voice stack or eyes mascot."],
          ["ClippyCode (github.com/MushroomFleet/ClippyCode)", "A floating animated Clippy. The README describes multi-turn chat, local Whisper.net push-to-talk (Ctrl+Shift+Space), and on-device TTS including Piper.", "The backend described there is Claude Code, not a user-pasted OpenAI-compatible base URL. The mascot is Clippy again."],
          ["EMO, Eilik, Dasai Mochi, Tamagotchi", "Real desk or pocket pets with expressive screen faces. EMO's official site lists 1000+ faces. Eilik is a desktop OLED companion (Energize Lab, 1.54 inch 128x64 face). Dasai Mochi 3 is an in-car companion with 70+ official animations. Tamagotchi (tamagotchi.com) is the classic handheld pet.", "Hardware characters, not a hotkey desktop assistant with a model endpoint. Steal the face language, not the product shape."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Callout, { tone: "info", lead: "Honest verdict" }, "This exact combo is not taken. The closest software overlaps are BoltAI's Instant Chat bar (hotkey plus many endpoints plus local dictation, but no cute always-on eyes), ChatGPT Pets (a floating mascot you can talk to, but only inside ChatGPT), sideOS (a always-available Mac island with voice, but no eyes character), and Komorebi or the Clippy revival apps (a desktop character that chats, but a different face and an incomplete match on any-endpoint plus local voice). Hardware like EMO already owns the cute glowing-eyes look. If you ship a tiny eyes pill with local ears, any compatible brain, and a clear-context shortcut, you are assembling a gap, not cloning a product."), /* @__PURE__ */ React.createElement(
      LinkCards,
      {
        links: [
          { title: "BoltAI", site: "boltai.com", date: "Checked 11 Nov 2026", href: "https://boltai.com/" },
          { title: "BoltAI Instant Chat and dictation help", site: "help.boltai.com", date: "Checked 11 Nov 2026", href: "https://help.boltai.com/articles/1041393-inline-ai" },
          { title: "ChatGPT Pets", site: "learn.chatgpt.com", date: "Checked 11 Nov 2026", href: "https://learn.chatgpt.com/docs/pets" },
          { title: "Claude Desktop Quick Entry", site: "support.claude.com", date: "Checked 11 Nov 2026", href: "https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac" },
          { title: "The New Raycast", site: "raycast.com", date: "14 May 2026", href: "https://www.raycast.com/blog/the-new-raycast" },
          { title: "sideOS", site: "sideos.ai", date: "Checked 11 Nov 2026", href: "https://sideos.ai/" },
          { title: "Enchanted", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/gluonfield/enchanted" },
          { title: "Msty", site: "msty.ai", date: "Checked 11 Nov 2026", href: "https://msty.ai/" },
          { title: "Msty: add an OpenAI-compatible server", site: "docs.msty.ai", date: "Checked 11 Nov 2026", href: "https://docs.msty.ai/studio/v3/managing-models/external-servers" },
          { title: "Jan", site: "jan.ai", date: "Checked 11 Nov 2026", href: "https://jan.ai/" },
          { title: "Jan on GitHub", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/janhq/jan" },
          { title: "LM Studio", site: "lmstudio.ai", date: "Checked 11 Nov 2026", href: "https://lmstudio.ai/" },
          { title: "LM Studio OpenAI-compatible API", site: "lmstudio.ai", date: "Checked 11 Nov 2026", href: "https://lmstudio.ai/docs/developer/openai-compat" },
          { title: "Ollamac", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/kevinhermawan/Ollamac" },
          { title: "clippy-desktop", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/quinnjr/clippy-desktop" },
          { title: "FireCube Clippy", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/FireCubeStudios/Clippy" },
          { title: "ClippyCode", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/MushroomFleet/ClippyCode" },
          { title: "Eilik", site: "energizelab.com", date: "Checked 11 Nov 2026", href: "https://energizelab.com/eilik/" },
          { title: "Dasai Mochi 3", site: "dasai.com.au", date: "Checked 11 Nov 2026", href: "https://dasai.com.au/products/mochi-3" },
          { title: "Tamagotchi", site: "tamagotchi.com", date: "Checked 11 Nov 2026", href: "https://tamagotchi.com/" }
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "The product in one picture", id: "concept" }, /* @__PURE__ */ React.createElement(Text, null, "Working name, placeholder only: Eyes. A shortlist of better names is in Name ideas below. It should feel like a small pet that lives at the edge of the desktop, not like another Electron chat app. Idle, it is just a pair of glowing rounded-square eyes on a dark pill (a 56 to 64 px orb, or a notch pill on a Mac). A global hotkey or a click opens a compact input bar with the eyes still attached on the left. Type, or hold a talk key to run a local speech-to-text model. The reply can be text, speech, or both. The conversation stays in memory from the first turn until the user clears it with a shortcut. Settings accept any OpenAI-compatible base URL, key, and model name."), /* @__PURE__ */ React.createElement(
      Rows,
      {
        rows: [
          {
            title: "Idle presence",
            detail: "A tiny always-on-top, click-through-except-on-the-orb window. Soft blink, occasional saccade, no chrome. Hidden-until-hotkey is a setting for people who want zero visual noise. After a long idle it can droop into the sleeping crescents."
          },
          {
            title: "Summon",
            detail: "The pill morphs into a 560 px input bar in about 180 ms. Focus lands in the field. Escape hides the bar but keeps the orb and the context."
          },
          {
            title: "Talk",
            detail: "Hold-to-talk transcribes locally, then sends the same turn as typed text. The eyes go wide (listening), then tilt (thinking), then bounce softly while speaking or streaming text."
          },
          {
            title: "One thread, until you wipe it",
            detail: "A token meter sits on the right of the bar (used versus the model context window). The clear shortcut does a wipe blink, empties the live session, and offers a short Undo toast."
          }
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Name ideas", id: "names" }, /* @__PURE__ */ React.createElement(Text, null, 'You asked for a name for this cute always-on desktop assistant. I brainstormed 30 short, sayable, original names in the blink, peek, pip, and mochi spirit, without using those exact words as the product name. I then checked the first 12 (the most immediately brandable short names) in official RDAP for .com, .app, and .ai, plus a quick web, App Store, and GitHub conflict pass. Almost every one-syllable cute name is already a product, and all three of those TLDs were already registered for every name in that first twelve. I then checked further names from the list, and close variants, to find options with some domain space. Lookups were run on 11 Nov 2026 (Asia/Calcutta) against Verisign RDAP for .com, Google Registry RDAP for .app, and Identity Digital plus nic.ai RDAP for .ai. A 404, "no match", or "object not found" is treated as likely available. This is a registry lookup, not a guarantee you can register the name, and it is not a trademark search.'), /* @__PURE__ */ React.createElement(Text, null, "The 30 names: Glim, Piko, Peekum, Eyepip, Pipglo, Nicti, Nicta, Glimlet, Peeklo, Peeksi, Winku, Looku, Eyeglo, Orbie, Lumi, Loomi, Sheen, Glint, Wisp, Vivi, Iri, Mip, Peeku, Ojito, Boopli, Gleemo, Blinku, Pyoko, Qwink, Seebi."), /* @__PURE__ */ React.createElement(Text, null, "The first 12 I checked, all with .com, .app, and .ai already registered, and each with at least one existing AI app or an adjacent product. I would not use these."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Name", "Conflicts found"],
        rows: [
          ["Glim", "Several products: Glim Habit Companion (glimcompanion.com), a fitness coach at heyglim.app, shared notes at glim.space, and Sublunar's Mac assistant Glim in private beta (sublunar.ai/day)."],
          ["Piko", "Crowded. PikoChan is a macOS notch AI companion (github.com/neur0map/PikoChan). There is also a kids voice buddy (pikojoy.com), a reminders app (thepikoapp.com), a PIKO food-scanner App Store app, and a PikoAi command-line tool."],
          ["Loomi", "Bloomreach's Loomi customer-engagement platform lives at loomi.ai. An earlier Loomi personal assistant (LoomiAssist) is listed as out of business."],
          ["Peeku", "Peeku is a pet wellness app with a Peeku AI Advisor (getpeeku.ai)."],
          ["Mip", "Weaker product overlap (Talk to MIP, an App Store business app, Quantum Core MIP), but the three-letter name is still crowded and all three TLDs are taken."],
          ["Iri", "Several Iris and Iri AI assistant apps and sites (including irisai.app and iri-ai.com)."],
          ["Orbie", "Orbie is an iOS speech-to-text app. Also OrbieAI for e-commerce, and an Orbi chatbot."],
          ["Lumi", "Very crowded. Desktop or assistant products include letlumi.com, orbitlumi.com, lumi.loomtable.com, and a Lumi AI App Store listing."],
          ["Sheen", "sheen.ai, a Sheen AI face-and-style App Store app, and a GitHub personal-assistant project named sheen."],
          ["Vivi", "Vivi finance app, a Vivi chatbot, VIVI hospitality agents, and the well-known Vivi classroom presentation system."],
          ["Glint", "Several: an AI-native Git workspace, a macOS ambient assistant at glint-ai.webflow.io, a dating-wingman app, and a Mac memory app."],
          ["Wisp", "Hard no. Wisp is already a desktop AI assistant at heywisp.ai that lives beside the cursor."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Callout, { tone: "info", lead: "Top 3" }, "Peekum, Eyepip, and Pipglo. These are the only shortlist names where .com, .app, and .ai all looked likely available, and I did not find an existing AI app or product using the exact name. If you care more about the word than the .com, Nicti (from nictitate, meaning to blink) and Glimlet (a little gleam) are the most on-theme, but you would start without the .com, and for Nicti without the .app as well."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Top 3", "Name", "Why it fits", "Domains that look free", "Conflicts"],
        rows: [
          ["Yes", "Peekum", "Sounds like peek 'em. Cute, one spoken idea, easy to say (PEE-kum), and it fits glossy eyes that peek when you hit the hotkey.", ".com, .app, and .ai all returned RDAP 404 (likely available).", "No exact product found on the web, App Store, or GitHub. Nearby names like Peek exist, but not Peekum."],
          ["Yes", "Eyepip", "Eye plus pip. The most literal of the clean names: it is a tiny eye pet you can say out loud in two short beats (EYE-pip).", ".com, .app, and .ai all returned RDAP 404 (likely available).", "No exact Eyepip product found. Closest near-miss is Eyepic, an iris-photo camera app, plus EyePop.ai for computer vision. Different spelling, but the eye- prefix is in use."],
          ["Yes", "Pipglo", "Pip plus glow. A little glowing companion, easy to mark on a dark pill. Slightly clunkier to say than Peekum (PIP-glo).", ".com, .app, and .ai all returned RDAP 404 (likely available).", "No exact Pipglo product found. Closest near-miss is Pipgro, an ADHD task-app concept with a different spelling."],
          ["No", "Glimlet", "A little gleam. Two syllables (GLIM-let), brandable, and close to the gloss in the eyes without being Glim, which is already taken as a product.", ".app and .ai looked likely available. glimlet.com is already registered.", "No exact Glimlet app found. Gimlet (the podcast company and a few GitHub orgs) is a one-letter-off near-miss, not the same name."],
          ["No", "Nicti", "From nictitate, to blink. Short, original, and very on-theme for an eyes mascot (NICK-tee).", "Only nicti.ai looked likely available. nicti.com and nicti.app are already registered (the .app registration is from June 2026).", "No AI app or assistant under this exact name turned up in the web, App Store, or GitHub pass."],
          ["No", "Nicta", "The same blink root, a bit softer to say (NICK-tuh). Better domain position than Nicti.", ".app and .ai looked likely available. nicta.com is already registered.", "No current AI assistant by this name found. NICTA was the name of Australia's former ICT research agency (now Data61), so the acronym has a tech history. NIKTA and Nocta are different spellings."],
          ["No", "Winku", "Wink plus a cute ending. One clear eye gesture, easy to say (WINK-oo).", ".app and .ai looked likely available. winku.com is already registered.", "Not an AI assistant, but winku.de is a German shop for Windows apps and web services. Worth knowing before you commit."],
          ["No", "Peeksi", "A peek diminutive (PEEK-see). Keeps the eyes joke without using Peek, which is a crowded word on its own.", ".app and .ai looked likely available. peeksi.com is already registered.", "No exact Peeksi product found. Nearby names include Peeki, Peeke, Peki, and Peeksy, so the peek- family is busy even if this spelling is clear."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Text, null, "Other names I checked and would not shortlist, even when a TLD looked free: Peekle (a macOS notch app for Claude Code, and very close to this product shape), Peeklo (a defunct search engine and a toddler outing product at shoppeeklo.com), Ojito (cute Spanish for little eye, but ojito.dev is already a Mac screen-memory app for agents), Orble and Orblet (an AI planner, orble.tech, and a household app at orblet.app), Pipsy (community software with an AI layer), Peebo (older shopping use, plus student PEBO desk-companion projects), Gloxy (indexed as a dating app at gloxy.app, even though RDAP for that domain returned 404), Qwink (a company already building SMB software and assistive devices), Looku (existing apps, including an AI fitting-room product), Seebi (seebi.at and the nearby Seeb.ai app), Eyeglo (eyeglo.life is marked launching soon), Peekmo (an existing lock-screen notes app), Boopli (loyalty software at boopli.app), Glowmi (an AI makeup assistant), Piko and Pochi and Glimo and Piplet and Pyoko and Zwink (each already used by an AI or companion product), and Nib (nib.app looked free, but NIB is a large Australian health insurer)."), /* @__PURE__ */ React.createElement(Text, null, 'Practical advice: if you want a name you can actually park on a .com this week, start with Peekum or Eyepip, and treat Pipglo as the backup. Say them out loud with the hotkey in mind ("open Peekum", "hey Eyepip"). Then register the three TLDs quickly if you like one, because a lookup is not a hold. If none of those feel cute enough, take Glimlet or Nicti and be ready to live on .app or .ai, or to buy a taken .com later.')),
    /* @__PURE__ */ React.createElement(Section, { heading: "States, motion, and layout", id: "ui" }, /* @__PURE__ */ React.createElement(
      Rows,
      {
        rows: [
          {
            title: "Idle orb or notch pill",
            detail: "Default: a dark pill about 140 by 84 px (or a 64 px orb) with the two glowing squares, lower-right, 16 px from the edge, always on top. Alternate (Mac): a Dynamic Island style pill that sits in or under the notch, in the spirit of sideOS. Drag to reposition. Double-click opens settings."
          },
          {
            title: "Compact input bar",
            detail: "560 px wide, about 72 px tall, 36 px corner radius, eyes on the left, field in the middle, token meter plus a mic affordance on the right. This is the default summoned state, closer to Spotlight, Alfred, Raycast Quick AI, BoltAI Instant Chat, and Claude Quick Entry than to a full messenger."
          },
          {
            title: "Expanded chat",
            detail: "Grow the bar downward to about 420 by 560 px (or 480 wide on large displays) only when the user asks, or when the reply is long. Same composer at the bottom. Do not force a second window the way Raycast split Quick AI and AI Chat."
          },
          {
            title: "Voice mode",
            detail: "Hold the talk key: eyes go to Listening, a thin waveform sits under the field, partial transcript streams in. Release to send. A short tap (under 400 ms) can toggle hands-free, which is how sideOS distinguishes hold versus tap. Esc cancels and does not send. TTS plays only if the user chose speech or both in settings."
          },
          {
            title: "Clear-context feedback",
            detail: "The wipe blink is the confirmation. Then a toast: Context cleared. Undo for 5 seconds. Do not show a modal. Optionally keep an archive in SQLite so a later history view can restore, but the live thread is empty."
          }
        ]
      }
    ), /* @__PURE__ */ React.createElement(Text, null, "Motion timings (design proposal, except the blink interval, which is close to Komorebi's documented 2.5 to 6.5 second random blink). Appear and hide: 180 ms ease-out. State changes: 200 to 250 ms. Blink is a squish: close in 80 to 120 ms, a tiny overshoot, then open, every 3 to 6 seconds while idle. Context wipe: 400 ms close, 200 ms hold, 200 ms open. Honor the OS reduced-motion setting with still frames, as ChatGPT Pets already do.")),
    /* @__PURE__ */ React.createElement(Section, { heading: "Hotkeys, size, color, type", id: "spec" }, /* @__PURE__ */ React.createElement(Callout, { tone: "warning", lead: "Do not steal crowded keys" }, "Apple documents Command+Space as Spotlight. OpenAI documents Option+Space (macOS) and Windows+Alt+P (Windows) for ChatGPT Pets / Mini. BoltAI's help page also documents Opt+Space for Instant Chat. Claude Quick Entry defaults to a double-tap of Option, and offers Option+Space as an official alternative. MeshUtility defaults to Alt+Space for dictation, which also collides with PowerToys Run on Windows. Users already complain about this. Pick a unique default and make it easy to rebind."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Action", "Suggested default", "Notes"],
        rows: [
          ["Summon or hide the bar", "Ctrl+Shift+Space (all platforms)", "MeshUtility already uses this for its prompt overlay, and ClippyCode documents it for push-to-talk, so keep it rebindable. Good second choices: Ctrl+Alt+Space, or a single modifier such as Right Option if the OS allows it."],
          ["Hold to talk", "Ctrl+Alt+L hold", "Komorebi's documented push-to-talk default. Release to send. A short tap can toggle hands-free."],
          ["Clear context", "Ctrl+Shift+Backspace", "Destructive, so pair it with the wipe blink plus a 5 second Undo toast. Avoid Cmd+K, which many apps use for command palettes, and which Enchanted uses (with Control) for its Spotlight panel."],
          ["New line in the field", "Shift+Enter", "Enter sends."],
          ["Stop speech or stream", "Esc", "First Esc stops TTS or generation. Second Esc hides the bar. Context stays."],
          ["Settings", "Ctrl+, or Cmd+,", "Standard app preference shortcut."],
          ["Expand or collapse chat", "Ctrl+J or Cmd+J", "Borrowed from Raycast, which uses Cmd+J / Ctrl+J to promote Quick AI into AI Chat. Here it only resizes the same window."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Element", "Size (proposal)"],
        rows: [
          ["Idle pill", "About 140 by 84 px, or a 64 px orb, 16 px from the screen edge"],
          ["Notch pill (Mac option)", "About 140 by 36 px if it has to sit in the notch, with eyes scaled down"],
          ["Input bar", "560 by 72 px, max 640 px, 36 px radius"],
          ["Expanded chat", "420 by 560 px (480 px wide on large displays)"],
          ["Settings window", "680 by 520 px, ordinary OS window, not an overlay"],
          ["Safe padding", "12 px inside the bar, 16 px of dark gap between the two eyes"]
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      Rows,
      {
        rows: [
          {
            title: "Color (proposal, revised)",
            detail: "Drop the cream blobs. Face and bar: #07080C to #181B22, hairline rgba(255,255,255,0.07). Eye fill is a white-to-cyan gradient on #5EF6F0, with a soft bloom. State tints: listening #4CFFE3, thinking #FFD56A, speaking #C9B8FF, error #FF8B82, cleared almost white-cyan, sleeping a quieter teal. Blush #FF8AA8 only on happy and hearts, and keep it blurred and scarce. Text #F4F1EA, muted #9A9488."
          },
          {
            title: "Type (proposal)",
            detail: "Use the system UI font (SF Pro on mac, Segoe UI Variable on Windows, Inter only if you must ship a webfont). 14 px in the field, 13 px in replies, 11 px mono for shortcuts and the token meter. Do not load a display face in the overlay."
          }
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Context and caching", id: "context" }, /* @__PURE__ */ React.createElement(Text, null, "The product promise is simple: the assistant remembers everything since the session started, until the user clears it. Under the hood that cannot mean sending the raw log forever. You need a live session, a meter the user can see, and a prefix-stable request shape so provider prompt caching actually hits."), /* @__PURE__ */ React.createElement(
      Rows,
      {
        rows: [
          {
            title: "What the user sees",
            detail: "One thread. A compact meter, for example 12% ctx, that fills as estimated tokens approach the configured context window. At about 70%, a quiet warning. At about 90%, automatically summarize older turns and keep going, the way Raycast now summarizes earlier turns when a conversation nears its context limit, and the way BoltAI can auto-compact a long chat. The meter never disappears, even in the compact bar."
          },
          {
            title: "What you store",
            detail: "Every turn goes to a local SQLite database (MeshUtility, Komorebi, and BoltAI already persist locally). The live session is a pointer: all turns plus a rolling summary. Clear-context starts a new session id. Keep the old rows for an optional history view, unless the user also chooses to delete."
          },
          {
            title: "What you send",
            detail: "A stable system prompt and tool list first, then the rolling summary, then the most recent turns that fit. Always append. Do not rewrite earlier messages if you want OpenAI-style prompt caching to work. OpenAI's docs say cache reuse needs the rendered prefix to match, that useful prefixes should stay at the front, and that summarising or truncating can reset reuse from the first changed token."
          },
          {
            title: "Provider caching",
            detail: "For official OpenAI endpoints, prompt caching is on by default for supported models, with a minimum cacheable prefix (1,024 visible tokens on GPT-5.6 and later). Put the system prompt and any fixed tools first, keep them byte-stable, and append new turns. For other OpenAI-compatible servers (Ollama, vLLM, OpenRouter, LiteLLM, LM Studio, Jan's localhost:1337), treat caching as best-effort and still do local summarisation. Do not assume every compatible server implements OpenAI cache fields."
          }
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Settings for any OpenAI-compatible route", id: "settings" }, /* @__PURE__ */ React.createElement(Text, null, "Settings should be a normal window, not a dense overlay. One column, grouped, with a Test connection button that sends a tiny request and shows the model name plus latency."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Group", "Fields"],
        rows: [
          ["Provider", "Preset (OpenAI, OpenRouter, Groq, Together, Fireworks, Ollama, LM Studio, Jan local server, custom), Base URL, API key, Model id, Optional organization header"],
          ["Key handling", "Store the key in the OS keychain (sideOS documents this pattern). Never write it to a plaintext file, and never put it in a chat draft or log. A Test connection action, a Reveal once control, and a Clear key action."],
          ["Generation", "Context window (used by the meter), temperature, max output tokens, system prompt, reply mode: text, speech, or both"],
          ["Speech", "STT engine (whisper.cpp or Moonshine), model size, microphone, push-to-talk versus toggle. TTS engine (Piper first), voice, speed. Lazy-load both engines."],
          ["Shortcuts", "A recorder for summon, talk, and clear. Warn when a binding collides with a known system shortcut."],
          ["Presence", "Launch at login, idle position (corner, notch on Mac, follow cursor, hidden until hotkey), always on top, reduced motion follows the OS"]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Text, null, "Sensible base URL presets, as starting points only: OpenAI https://api.openai.com/v1, Ollama http://127.0.0.1:11434/v1, LM Studio http://127.0.0.1:1234/v1, Jan http://127.0.0.1:1337/v1. The user should still be able to paste any compatible route.")),
    /* @__PURE__ */ React.createElement(Section, { heading: "Reference apps and patterns", id: "refs" }, /* @__PURE__ */ React.createElement(Text, null, "Interaction patterns, separate from the already-out-there product survey above. Dribbble shot URLs returned 202 from this environment (not 404). OpenAI's older Chat Bar help page returned 403 to a plain crawler, so the Pets document is the better official desktop-companion source."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Reference", "What to steal", "What to leave"],
        rows: [
          ["Apple Spotlight (Cmd+Space)", "Instant appear, type, one job, almost no chrome", "It is search, not a conversation. Do not take its shortcut."],
          ["Alfred 6", "Native, tiny, optional AI with your own key, custom hotkeys", "It is still a launcher."],
          ["Raycast Quick AI and AI Chat", "Quick AI for one-off questions, AI Chat for the long thread, Screen Awareness, auto-summarise near the context limit", "The two-door split adds a decision before the user can ask. Keep one surface that can grow."],
          ["BoltAI Instant Chat", "A bar over any app, dictation, a visible context ring", "Do not copy Opt+Space, and do not start as a full paid workspace."],
          ["ChatGPT desktop Pets / Mini", "A floating companion, type or speak, status states, reduced-motion still frames", "Do not copy the shortcut, and do not start with a heavy 3D pet. Eyes are enough."],
          ["Claude Desktop Quick Entry", "Double-tap Option, a small box, drag-to-screenshot, click a window to attach it", "Help Center still says macOS-only."],
          ["sideOS", "The assistant lives in the Mac notch, hold to talk, one thread for voice and text", "Paid Mac agent that also clicks and types. v1 here should be a conversation companion, not a desktop driver."],
          ["Apple Dynamic Island", "Apple's WWDC 2023 session on Live Activities describes a compact pill that expands in place", "Do not pretend to be system UI."],
          ["Humane Ai Pin and Rabbit R1", "Voice-first, a physical talk gesture, a very small face for status", "Hardware devices. Your app still has to live on a desktop."],
          ["Mobbin AI chat screens", "Web chatboxes show suggested actions, a persistent composer, and loading states", "In-page overlays, not desktop companions. Steal hierarchy, not layout size."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Quote, { cite: "@juuanluengo on X, 30 Sep 2026, 8:56 PM Asia/Calcutta" }, "ChatGPT pet having the same keyboard shortcut as Raycast has been driving me crazy for a few days.")),
    /* @__PURE__ */ React.createElement(Section, { heading: "Character and mascot references", id: "mascots" }, /* @__PURE__ */ React.createElement(
      Rows,
      {
        rows: [
          {
            title: "EMO by LivingAI",
            detail: "The strongest visual target. Official product shots show a black face with two glowing cyan rounded squares, plus morphs into sleepy arcs, hearts, and slants. The official site lists 1000+ faces and movements. Use the face language, not the body, headphones, or skateboard.",
            meta: "living.ai/emo, product photography checked 11 Nov 2026"
          },
          {
            title: "Vector and Cozmo eyes",
            detail: "The same glowing rounded-rectangle idea, a bit wider and more rectangular than EMO. Community documentation of Anki's tools describes brow, gaze, openness, cheeks, spacing, and blink. Soft lids read as relaxed. A hard, held stare reads as a challenge.",
            meta: "randym32 Vector documentation, plus official-style character art on that site"
          },
          {
            title: "Eilik (Energize Lab)",
            detail: "A palm-sized desktop companion with a 1.54 inch 128x64 OLED face, touch reactions, and no required app, Bluetooth, or Wi-Fi. Official pages describe abundant facial expressions and a robot that can fall asleep to save battery. Useful as a desk-pet presence model, not as an LLM product.",
            meta: "energizelab.com/eilik"
          },
          {
            title: "Dasai Mochi",
            detail: "An in-car OLED companion. Official Mochi 3 pages list 70+ facial expressions and animations, a full-color screen, and a gyroscope that can react to motion. Steal the idea of many small expression cartoons, not the car use case.",
            meta: "dasai.com.au/products/mochi-3"
          },
          {
            title: "Tamagotchi",
            detail: "The classic handheld pet at tamagotchi.com. A reminder that a tiny creature with a short list of faces can feel more loved than a photoreal avatar. Keep the expression set small and readable at 64 px.",
            meta: "tamagotchi.com"
          },
          {
            title: "Clippy, as a cautionary tale",
            detail: "Microsoft's Office Assistant (officially ClippIt) shipped in Office in 1997 and became a meme for interrupting people. a16z's 2019 biography, with Steven Sinofsky, notes Disney animators advised giving the assistant a stage to perform on, and that the letter-writing prompt went too far. Lesson: the character should wait to be summoned, show state, and never pop in unsolicited. The Clippy revival apps listed above are useful as always-on-mascot software, not as a personality to copy.",
            meta: "a16z, Clippy: The Unauthorized Biography, 27 Apr 2019"
          },
          {
            title: "AI orbs on Dribbble and Animorio",
            detail: "Shots such as AI Orb, Orb AI Motion, and cute robot mascots are useful moodboards. Animorio's 'AI assistant orb whose eyes change expression' is almost the same state machine. Use them as references, not as assets to ship.",
            meta: "Dribbble and Animorio, checked 11 Nov 2026"
          }
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Lightweight stack", id: "stack" }, /* @__PURE__ */ React.createElement(Callout, { lead: "Recommendation" }, "Tauri 2, Rust backend, a thin web UI, SVG or CSS eyes in this glowing rounded-square language, SQLite for sessions, OS keychain for secrets, whisper.cpp tiny as the default STT sidecar, Piper as the default TTS sidecar. Load speech engines only when needed. Talk to models through a single OpenAI-compatible client."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Layer", "Pick", "Why, with sources"],
        rows: [
          ["App shell", "Tauri 2, not Electron", "Hopp's 9 Apr 2025 write-up (N=1, one MacBook Pro, six open windows) measured about 172 MB for Tauri versus about 409 MB for Electron, and 8.6 MiB versus 244 MiB bundles. That is a demo, not your app, but the direction matches the brief. A pure Swift app would be even lighter on a Mac. Start with Tauri unless you decide this is Mac-only."],
          ["Eyes", "SVG plus CSS first", "The mockups on this page are already SVG filters and a few keyframes. No extra runtime. Add Rive later if the animation graph gets rich. Avoid Live2D in v1: Komorebi shows it can look wonderful, but Cubism Core is proprietary."],
          ["STT", "whisper.cpp, tiny or tiny.en, lazy sidecar", "Official whisper.cpp memory table: tiny is 75 MiB on disk and about 273 MB in memory; base is 142 MiB and about 388 MB; small is already about 852 MB. Start with tiny, and do not keep the model resident while idle. Moonshine is a strong alternative. Moonshine Micro can run in as little as 470 KB of RAM, but that figure is for a microcontroller command-style pipeline on an RP2350, not general desktop dictation."],
          ["TTS", "Piper first", "Development now lives at OHF-Voice/piper1-gpl. MIT, local, widely used. Kokoro is the quality upgrade PAL chose; keep it optional, because I did not find an official RAM figure I trust enough to quote."],
          ["Context store", "SQLite plus a rolling summary", "Local, durable, tiny. Use it for sessions, settings (except the key), and an optional archive. Pair it with provider prompt caching as described above."],
          ["Idle strategy", "One transparent window, no speech models loaded", "The memory brief is won or lost here. The pill should be a small always-on-top window. Start the STT or TTS sidecar on first use, then optionally unload after a few minutes of silence."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      Metrics,
      {
        metrics: [
          { value: "~273 MB", label: "whisper.cpp tiny, official runtime memory", detail: "75 MiB on disk. Source: whisper.cpp README memory table." },
          { value: "~388 MB", label: "whisper.cpp base, official runtime memory", detail: "142 MiB on disk. Only step up if tiny quality is not enough." },
          { value: "~172 vs ~409 MB", label: "Tauri vs Electron, Hopp 6-window demo", detail: "Single-run Mac benchmark, 9 Apr 2025. Not an official Tauri figure, and not idle memory." },
          { value: "< 6 MB", label: "Alfred 6 official dmg size", detail: "Bundle size, not RAM. A reminder that a native companion can stay tiny." }
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Open-source cousins", id: "oss" }, /* @__PURE__ */ React.createElement(Text, null, "Stack and interaction cousins, with the same caveat as above: none is already the cute-eyes plus any-endpoint plus local-voice combo. GitHub links were checked live on 11 Nov 2026 (all 200 unless noted)."), /* @__PURE__ */ React.createElement(
      Table,
      {
        columns: ["Project", "Why it is close", "Caveat"],
        rows: [
          ["MeshPilot-in/MeshUtility", "Tauri 2, tray resident, local whisper.cpp, floating overlay, any OpenAI-compatible endpoint, SQLite, a floating pill with state transitions.", "Dictation and prompt enhancing, not a long-running eyes companion."],
          ["mohaneddz/Pal", "Tauri, React, Rust, voice-first, whisper.cpp, Kokoro TTS, optional Groq, global shortcuts, tray, start with the OS.", "Still evolving. Confirm the license in-repo before you reuse code."],
          ["aumi-group/MIND", "Tauri plus Rust, overlay, local whisper.cpp, Piper, cursor and screen as context. AGPL.", "Windows first, alpha, AGPL (that license may not fit a commercial app)."],
          ["kiskaserver/interactive_assistent (Komorebi)", "Desktop companion with idle blinking, eye tracking, talk-back, whisper.cpp, Piper, OpenRouter, SQLite, global shortcuts (Ctrl+Alt+K, Ctrl+Alt+L).", "Heavier than your brief. Live2D Cubism Core is proprietary."],
          ["quinnjr/clippy-desktop", "Always-on-top mascot that talks to any OpenAI-compatible server.", "Clippy, not eyes. No local voice stack in the README I checked."],
          ["gluonfield/enchanted", "Native Ollama client with a Spotlight-style panel and on-device history.", "Ollama-focused. The README points to Jaz as the next iteration."],
          ["kevinhermawan/Ollamac", "Simple native Mac Ollama client.", "No mascot, no overlay, no voice loop."],
          ["janhq/jan", "Open-source local-plus-cloud chat app with an OpenAI-compatible local server.", "Full window app, not an eyes overlay."],
          ["ggml-org/whisper.cpp", "The STT engine, plus a built-in command example for a basic voice assistant.", "A library, not a UI."],
          ["OHF-Voice/piper1-gpl and hexgrad/kokoro", "Local TTS options.", "Engines, not a product UI."]
        ]
      }
    ), /* @__PURE__ */ React.createElement(Text, null, "I also tried github.com/iamsrikanthnani/pluely, which used to be cited as a translucent Tauri overlay assistant. That URL returned 404 on 11 Nov 2026, so I am not treating it as a current open-source reference.")),
    /* @__PURE__ */ React.createElement(Section, { heading: "What not to copy", id: "dont" }, /* @__PURE__ */ React.createElement(
      NumberedList,
      {
        items: [
          "Do not default to Option+Space, Alt+Space, or Command+Space. Those keys are already taken by ChatGPT, BoltAI, various launchers, and Spotlight, and people are already annoyed about it.",
          "Do not make the character interrupt. Clippy is the warning label. The orb may blink or fall asleep, but it should not speak or open itself without a user action, except for a clear error the user must see.",
          "Do not ship Live2D, a full local LLM, and always-resident Whisper in v1. That fights the low-memory brief. Cloud (or any OpenAI-compatible route) for the brain, local only for ears and voice, and unload those engines when idle.",
          "Do not split Quick Ask and Chat into two different windows as a first design. One pill, one bar, one thread that can grow.",
          "Do not write API keys to disk in plaintext, and do not log them.",
          "Do not copy EMO, Vector, Eilik, or Mochi sprites. Copy the face language (glowing rounded squares on a dark face) and draw your own shapes.",
          "Do not claim the CMS or Shopify story of another product here. This page is only for the desktop assistant."
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "A first prototype", id: "plan" }, /* @__PURE__ */ React.createElement(
      NumberedList,
      {
        items: [
          "Week one feel: a Tauri 2 always-on-top transparent window, these SVG eyes, click or Ctrl+Shift+Space to expand the 560 px bar, Escape to shrink. No speech yet.",
          "Talk to any OpenAI-compatible endpoint from Settings (base URL, keychain key, model). Stream the reply into the bar, then into an expandable transcript.",
          "SQLite session that survives hides and restarts, with the clear-context shortcut, wipe blink, and Undo toast.",
          "Add a visible token meter and a dumb rolling summary once replies get long.",
          "Only then add whisper.cpp tiny as a sidecar (hold to talk) and Piper for optional speech-out. Unload both after idle.",
          "Polish the nine eye states, reduced motion, and a notch-pill option if you are on a Mac."
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Not known", id: "unknown" }, /* @__PURE__ */ React.createElement(
      NumberedList,
      {
        items: [
          "Idle RAM for this exact app. I only have sourced figures for whisper.cpp models, a one-off Tauri versus Electron demo, and Alfred's installer size. Measure a hello-world Tauri orb on your machine before you promise a number.",
          "Official desktop RAM for Moonshine Tiny or Streaming, and for Piper or Kokoro voices. I did not quote unofficial blog measurements as fact.",
          "Whether Claude Quick Entry has shipped on Windows. The Help Center still says no.",
          "How complete Enchanted's successor Jaz is. The Enchanted README names it, and I did not treat Jaz as a second reviewed product.",
          "Mobbin is useful for web chat patterns, but it is not a desktop-OS pattern library.",
          "A current open-source project that is already an eyes-pill + hotkey bar + local STT/TTS + OpenAI-compatible settings combo. You would be assembling that combo, not forking it."
        ]
      }
    )),
    /* @__PURE__ */ React.createElement(Section, { heading: "Sources", id: "sources" }, /* @__PURE__ */ React.createElement(
      LinkCards,
      {
        links: [
          { title: "The New Raycast", site: "raycast.com", date: "14 May 2026", href: "https://www.raycast.com/blog/the-new-raycast" },
          { title: "Raycast AI Chat manual", site: "manual.raycast.com", date: "Checked 11 Nov 2026", href: "https://manual.raycast.com/ai/ai-chat" },
          { title: "Spotlight keyboard shortcuts on Mac", site: "support.apple.com", date: "Checked 11 Nov 2026", href: "https://support.apple.com/guide/mac-help/spotlight-keyboard-shortcuts-mh26783/mac" },
          { title: "Alfred 6", site: "alfredapp.com", date: "Checked 11 Nov 2026", href: "https://www.alfredapp.com/v6/" },
          { title: "ChatGPT Pets", site: "learn.chatgpt.com", date: "Checked 11 Nov 2026", href: "https://learn.chatgpt.com/docs/pets" },
          { title: "Claude Desktop Quick Entry", site: "support.claude.com", date: "Checked 11 Nov 2026", href: "https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac" },
          { title: "BoltAI", site: "boltai.com", date: "Checked 11 Nov 2026", href: "https://boltai.com/" },
          { title: "BoltAI Instant Chat help", site: "help.boltai.com", date: "Checked 11 Nov 2026", href: "https://help.boltai.com/articles/1041393-inline-ai" },
          { title: "sideOS", site: "sideos.ai", date: "Checked 11 Nov 2026", href: "https://sideos.ai/" },
          { title: "Enchanted", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/gluonfield/enchanted" },
          { title: "Msty", site: "msty.ai", date: "Checked 11 Nov 2026", href: "https://msty.ai/" },
          { title: "Msty external model servers", site: "docs.msty.ai", date: "Checked 11 Nov 2026", href: "https://docs.msty.ai/studio/v3/managing-models/external-servers" },
          { title: "Jan", site: "jan.ai", date: "Checked 11 Nov 2026", href: "https://jan.ai/" },
          { title: "LM Studio OpenAI-compatible API", site: "lmstudio.ai", date: "Checked 11 Nov 2026", href: "https://lmstudio.ai/docs/developer/openai-compat" },
          { title: "Ollamac", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/kevinhermawan/Ollamac" },
          { title: "EMO desk pet", site: "living.ai", date: "Checked 11 Nov 2026", href: "https://living.ai/emo/" },
          { title: "Eilik", site: "energizelab.com", date: "Checked 11 Nov 2026", href: "https://energizelab.com/eilik/" },
          { title: "Dasai Mochi 3", site: "dasai.com.au", date: "Checked 11 Nov 2026", href: "https://dasai.com.au/products/mochi-3" },
          { title: "Tamagotchi", site: "tamagotchi.com", date: "Checked 11 Nov 2026", href: "https://tamagotchi.com/" },
          { title: "Vector character study", site: "randym32.github.io", date: "Checked 11 Nov 2026", href: "https://randym32.github.io/Anki.Vector.Documentation/guides/Vector%20character%20study.html" },
          { title: "Vector character design guide", site: "randym32.github.io", date: "Checked 11 Nov 2026", href: "https://randym32.github.io/Anki.Vector.Documentation/guides/Vector%20character%20design%20guide.html" },
          { title: "Clippy: The Unauthorized Biography", site: "a16z.com", date: "27 Apr 2019", href: "https://a16z.com/clippy-the-unauthorized-biography/" },
          { title: "clippy-desktop", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/quinnjr/clippy-desktop" },
          { title: "ClippyCode", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/MushroomFleet/ClippyCode" },
          { title: "Design dynamic Live Activities", site: "developer.apple.com", date: "WWDC 2023", href: "https://developer.apple.com/videos/play/wwdc2023/10194/" },
          { title: "Animorio AI orb", site: "animorio.com", date: "Checked 11 Nov 2026", href: "https://animorio.com/en/animations/ai-assistant-orb-whose-eyes-change-expression/" },
          { title: "whisper.cpp memory table", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/ggml-org/whisper.cpp" },
          { title: "OpenAI prompt caching", site: "developers.openai.com", date: "Checked 11 Nov 2026", href: "https://developers.openai.com/api/docs/guides/prompt-caching" },
          { title: "Tauri vs Electron (Hopp)", site: "gethopp.app", date: "9 Apr 2025", href: "https://www.gethopp.app/blog/tauri-vs-electron" },
          { title: "MeshUtility", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/MeshPilot-in/MeshUtility" },
          { title: "PAL", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/mohaneddz/Pal" },
          { title: "Komorebi", site: "github.com", date: "Checked 11 Nov 2026", href: "https://github.com/kiskaserver/interactive_assistent" },
          { title: "X: Option+Space conflict", site: "x.com", date: "30 Sep 2026", href: "https://x.com/juuanluengo/status/2105318312356020384" }
        ]
      }
    ))
  );
}
export {
  App as default
};
