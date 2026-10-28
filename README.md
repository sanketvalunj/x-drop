[![python](https://img.shields.io/badge/python-3.8%2B-blue)](#)
[![license](https://img.shields.io/badge/license-MIT-green)](#)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)](#)

# XDROP

> Peer-to-peer encrypted file sharing for your local network, with a terminal and a clean web dashboard.

- 🛰  **Auto-discovery** on the LAN (zeroconf / mDNS)
- 🔒 **Encrypted transport** every session — ephemeral X25519 ECDH + AES-256-GCM
- ✅ **SHA-256 integrity verification** on every transfer
- ⚡ **Zero setup** — no internet, no cloud, no accounts, no admin/root, no pre-shared passwords
- ✨ **Premium TUI** — rich panels, live discovery, progress, speed, ETA
- 🔄 **Auto-update check** on launch (via PyPI, non-blocking)
- 🐧 **Linux** + 🪟 **Windows** + 🍎 **macOS**, Python 3.8+

---

## Install

```bash
pip install xdrop
```

Or from source:

```bash
pip install .
```

## Run

```bash
xdrop -start
```

(`xdrop`, `xdrop start`, and `xdrop --start` all work too.)

To open the web dashboard instead, run:

```bash
xdrop-web
```

It opens at `http://127.0.0.1:8765` and is only available on the computer
running xdrop (start it with `xdrop-web --lan` to allow other devices on your private network). The dashboard can discover devices, send files, manage incoming
requests, show live outgoing transfer progress with cancellation, accept drag-and-drop
file selection, send multiple files one by one, show and scan connection QR codes,
resume interrupted outgoing transfers, connect by IP, search and filter transfer history, clear completed history,
copy this device's address and port, open the download folder, and change the device
name and download location.

On first launch you must enter a device name — that's how others on the LAN
will see you. Settings can be changed later from the menu.

## Menu

```
1. Discover Devices     — live list of online peers on your LAN
2. Send a File          — pick a peer or enter a direct IP/port
3. Incoming Transfers   — accept / reject offers, view history
4. Settings             — name, download folder, diagnostics & health, update check
5. Quit
```

Received files land in `~/xdrop_files/` by default.

## How it works

- **Discovery** — three methods run at the same time and their results are merged:
  1. **mDNS / zeroconf** advertises `<device-name>._xdrop._tcp.local.` on every IPv4 interface.
  2. **UDP broadcast beacons** on port `47475`: every 2 s each device sends a small "hello" to
     `255.255.255.255` and to each interface's subnet broadcast (e.g. `192.168.43.255`).
     Whoever hears it answers directly, so one working direction is enough.
  3. **Subnet scan**: if nothing is found within ~5 s (or when you press *Scan network now* on the
     Devices page), every address in your /24 is probed on TCP port `47474`. If the scan finds a
     device, a transfer to it will work too.
  Phone hotspots usually drop mDNS multicast between clients, which is why methods 2 and 3 exist.
  You can always type the other device's IP on the Devices page (port is optional).
- **Transport**: a fresh TCP socket per session with bounded concurrency (up to 4 concurrent transfers).
- **Handshake**: X25519 ECDH → HKDF-SHA256 → 32-byte AES key.
- **Peer authentication**: peers are not authenticated or pinned. Encryption protects traffic from passive network observers, but does not prevent an active machine-in-the-middle on the LAN.
- **Stream**: each frame is `[12-byte nonce][4-byte length][AES-256-GCM ciphertext]`.
- **Resumable staging & Integrity**: incoming files are streamed into a temporary `.part` file.
  The offer includes the file size and SHA-256 identity; a retry of the same file resumes from
  the stored byte offset. The receiver verifies the complete hash before atomically promoting
  the file. Interrupted partials remain in the download folder as hidden `.xdrop_*.part` files;
  mismatched partials are removed.

## Packet analytics (web dashboard → **Packets**)

Every record xdrop puts on the network is captured live on **both** the sender and the receiver.
No admin rights or pcap driver are needed.

- **Capture table**: number, time, source → destination `ip:port`, type (`HELLO`, `OFFER`,
  `RESPONSE`, `DATA`, `DONE`, `ACK`), frame size, TCP segments, and a description.
- **Packet journey**: click a packet to see how it is built, layer by layer:
  file bytes or JSON → AES-256-GCM (+16 B tag) → xdrop frame (+12 B nonce, +4 B length) →
  TCP segments (MSS-sized) → IPv4 packets (+20 B) → Wi-Fi/Ethernet frames, with a byte bar for each layer.
- **Real bytes on the wire**: colour-coded hex of the nonce, length field, ciphertext and GCM tag
  (or the `PDIT` magic + public key for handshake packets). Control messages are shown decoded.
  File contents are never shown.
- **Kernel TCP counters** (Linux and macOS): measured MSS, RTT, segments sent and received,
  retransmissions and congestion window for the connection. Windows does not expose these,
  so segment counts are estimated from the MSS there.
- **Network path**: your interface, the access point or gateway, and the peer, with its MAC
  address from the ARP table. *Run traceroute* probes the routed path.
- **Throughput timeline** and a **per-type table** for every transfer. The transfer analyzer
  (click a transfer → *Packets*) links straight to the inspector.

Values marked `*` are calculated from the measured MSS and standard header sizes. TCP is a
byte stream, so the OS may split or merge records differently.

## Firewall / hotspot checklist

- **Windows**: when the "Allow an app to communicate" dialog appears, tick **both Private and
  Public** (Windows often marks hotspots as *Public*), then click Allow. If you clicked Cancel
  earlier, open *Windows Security → Firewall → Allow an app* and tick Python for both, or run in an
  admin terminal:
  ```
  netsh advfirewall firewall add rule name="xdrop TCP" dir=in action=allow protocol=TCP localport=47474
  netsh advfirewall firewall add rule name="xdrop UDP" dir=in action=allow protocol=UDP localport=47475,5353
  ```
- **macOS**: *System Settings → Network → Firewall → Options* → allow incoming connections for Python.
- **Linux (ufw)**: `sudo ufw allow 47474/tcp && sudo ufw allow 47475/udp`
- Both devices must be connected to the **same** hotspot or Wi-Fi network. Some hotspots have
  "client isolation" (sometimes called "AP isolation"), which blocks every device-to-device
  connection. Turn it off if your phone has the setting.

## CLI flags

| Flag | Purpose |
|---|---|
| `-start` / `--start` / `start` | launch the menu (default) |
| `--no-update` / `-no-update` | skip update check on launch |
| `-v` / `--version` / `version` | print version and exit |
| `-h` / `--help` / `help` | show usage |

## Non-goals

No internet transfers. No accounts. No GUI. No admin requirement.
No pre-shared passwords. No cloud.

---

© 2026 Sanket Valunj. All Rights Reserved.
# x-drop
