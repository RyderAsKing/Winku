// Spike UI: send a prompt, stream the reply, Esc stops it.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const input = document.getElementById("input");
const status = document.getElementById("status");
const reply = document.getElementById("reply");
let promptCount = 0;

listen("engine", ({ payload }) => {
  switch (payload.type) {
    case "ready":
      status.textContent = `${payload.provider}/${payload.model}`;
      break;
    case "text_delta":
      reply.textContent += payload.delta;
      break;
    case "reply_end":
      if (payload.aborted) status.textContent += " · stopped";
      break;
    case "error":
      status.textContent = `Error: ${payload.message}`;
      break;
  }
});

document.getElementById("bar").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  reply.textContent = "";
  promptCount += 1;
  invoke("engine_send", { message: { type: "prompt", id: `p${promptCount}`, text } }).catch((error) => {
    status.textContent = `Error: ${error}`;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") invoke("engine_send", { message: { type: "abort" } });
});
