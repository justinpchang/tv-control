// Minimal remote: one WebSocket to the control service, fire-and-forget commands.

const statusEl = document.querySelector<HTMLElement>("#status")!;
const stateEl = document.querySelector<HTMLElement>("#state")!;

function serverUrl(): string {
  const host = window.location.hostname || "localhost";
  return `ws://${host}:8080`;
}

let ws: WebSocket | null = null;

function connect(): void {
  statusEl.textContent = `connecting to ${serverUrl()}…`;
  ws = new WebSocket(serverUrl());
  ws.onopen = () => { statusEl.textContent = "connected"; };
  ws.onclose = () => {
    statusEl.textContent = "disconnected — retrying…";
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { ws?.close(); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type: string; state?: unknown };
      if (msg.type === "state") stateEl.textContent = JSON.stringify(msg.state);
    } catch { /* ignore */ }
  };
}

document.querySelectorAll<HTMLButtonElement>("button[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(btn.dataset.cmd!);
    } else {
      statusEl.textContent = "not connected — retrying…";
      connect();
    }
  });
});

connect();
