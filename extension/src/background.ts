// Phase 2 placeholder: background bridge between control service and adapters.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  sendResponse({ ok: false, reason: "not implemented", echo: msg });
  return true;
});
