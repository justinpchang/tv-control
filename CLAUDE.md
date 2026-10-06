I want to turn a Dell OptiPlex 7060 into my main TV streaming/gaming box. It is connected to a Samsung UN55MU6300FXZA TV using DisplayPort → HDMI. The TV IP is `192.168.1.163`.

## Requirements

- The PC can stay on 24/7; only the TV needs normal power on/off behavior.
- An iPhone PWA should be the only remote/UI.
- I do not want a physical remote, mouse, or keyboard in normal use.
- The PWA should talk to a small local service running on the Windows PC, preferably over HTTP/WebSocket.
- Tapping Netflix, Prime, YouTube, GeForce NOW, etc. should automatically:
  - turn on the TV if necessary,
  - switch the TV to the PC HDMI input,
  - launch/focus the appropriate Windows app or browser.
- “Off” should turn off the TV while leaving the PC running.
- Use Samsung LAN control rather than buying a USB HDMI-CEC adapter if possible.
- Investigate the MU6300’s Tizen WebSocket API and Wake-on-LAN for power-on.
- Streaming services should preferably run in Edge/Chromium so browser extensions/ad blocking can be used.
- GeForce NOW should use the native Windows app.
- The PWA should send semantic commands such as:
  - `launch.netflix`
  - `launch.geforce`
  - `home`
  - `back`
  - `left`
  - `right`
  - `up`
  - `down`
  - `select`
  - `playPause`
- Do not make mouse emulation the normal control model.
- Eventually, a custom browser extension can provide service-specific navigation for Netflix/Prime/etc. so the phone can control their web UIs cleanly.
- There should always be a reliable `Home` action that restores the system to a known usable state.

## First thing to verify

Test what LAN control is actually possible with the Samsung TV at `192.168.1.163`, especially:

- power off
- Wake-on-LAN power on
- volume control
- Home/Back/navigation
- reliable switching to the HDMI input containing the PC
- pairing/authentication behavior for the Samsung Tizen WebSocket API
