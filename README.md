# Teleprompter Control

Run the script on an iPad and control it live from a phone or laptop. The controller shows a preview of exactly what the iPad shows.

It works in two ways, with the same pages:

| Mode | When to use | What's needed |
|---|---|---|
| **Peer-to-peer** (default) | Normal use, with no computer running | Internet for about 2 seconds to connect, then the devices talk directly |
| **Local server** | Backup when there's no internet at all | A computer running `node server.js` on the same Wi-Fi |

## Peer-to-peer (no server)

1. On the iPad, open the **Prompter** page from the GitHub Pages site (the link is on the repo's main page). It shows a **room code** and a QR code.
2. On your phone, scan the QR code, or open the **Controller** page and type the room code.
3. Done. Commands now go directly between the two devices over Wi-Fi or a hotspot.

How it works:
- A free public PeerJS service introduces the two devices once, using the room code.
- After that, the devices talk over a direct WebRTC link when the network allows it. If it does not (phone on mobile data, Wi-Fi that blocks devices from seeing each other), they fall back to an internet relay automatically. The relay uses free public MQTT services, and messages are end-to-end encrypted with a key made from the room code. The controller shows which route is in use ("direct" or "via internet").
- The iPad stores the script and settings in its own browser. It keeps the same room code, so if it reloads, the controller reconnects by itself.

Good to know:
- If the link drops, the iPad keeps scrolling at its current speed.
- Reconnecting needs internet again for the handshake.
- Some office or guest Wi-Fi networks block devices from talking to each other. Use a phone hotspot or a normal router instead.

## Two iPads with the same script

1. Open the **Prompter** on the main iPad as usual. It shows the room code.
2. On the second iPad, open the **Prompter**, tap **Join another iPad as a second screen**, and enter the same code.

The second iPad shows the same script, settings and play/pause, and stays on the same words as the main iPad, even if the screens are different sizes. The controller shows "2 iPads connected".

- **Mirror per iPad:** by default the second iPad copies the main iPad's Mirror/Flip. On its start screen (double-tap to open it), untick "Use the main iPad's mirror setting" to give it its own. It's saved on that iPad.
- The main iPad does the scrolling. The second one follows it, so if the main iPad disconnects, the second one stops moving until it's back.
- In local server mode there's no code to enter: the first iPad to connect becomes the main one, and if it leaves, the next one takes over.

## Local server (offline backup)

You need Node.js. There's nothing to install.

```bash
node server.js
```

Then open the printed `http://<your-ip>:3000/prompter` on the iPad and `/controller` on the phone. No room code is needed in this mode.

## iPad tips

- Use Share → **Add to Home Screen** and open the prompter from there for true full screen.
- Set Settings → Display & Brightness → **Auto-Lock → Never**.
- Double-tap the prompter to bring the room code back.

## Controller

- **Play / Pause**: speed changes ramp smoothly, so they don't jolt the reader.
- **↑ ↓ / ⇈ ⇊**: move the text back or forward 1 or 3 lines.
- **Drag or scroll the preview**: move the text by hand. The iPad follows.
- **Progress bar**: tap or drag to jump anywhere in the script.
- **Speed, font size, line gap, margins, eye line**: slider, or − / + buttons.
- **Mirror / Flip**: for beam-splitter glass rigs.
- **Colours**: presets, or pick any background. The text colour is chosen automatically for contrast. If you pick a text colour yourself, it is adjusted just enough to stay readable (at least 7:1 contrast).
- **Script**: paste the text or open a `.txt` file, then press **Send to iPad**.
- **Keyboard** (laptop): Space = play/pause, ↑/↓ = nudge (Shift = 3 lines), ←/→ = speed, − / = = font, Home = back to top.

## Files

- `docs/`: the web app, which GitHub Pages publishes straight from this folder.
  - `hub.js` holds the shared state logic.
  - `transport.js` handles the peer-to-peer and server connections.
- `server.js`: the optional local server.
