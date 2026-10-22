[![python](https://img.shields.io/badge/python-3.8%2B-blue)](#)
[![license](https://img.shields.io/badge/license-MIT-green)](#)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)](#)

# XDROP

> Peer-to-peer encrypted file sharing for your local network, with a terminal and a clean web dashboard.

- 🛰  **Auto-discovery** on the LAN (zeroconf / mDNS)
- 🔒 **End-to-end encryption** every session — X25519 ECDH + AES-256-GCM
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
running xdrop. The dashboard can discover devices, send files, manage incoming
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

- **Discovery**: zeroconf broadcasts `<device-name>._xdrop._tcp.local.`
  with your TCP port and a `name` TXT record. If mDNS is blocked by router or
  firewall, manual Direct IP/Port mode is automatically available as a fallback.
- **Transport**: a fresh TCP socket per session with bounded concurrency (up to 4 concurrent transfers).
- **Handshake**: X25519 ECDH → HKDF-SHA256 → 32-byte AES key.
- **Stream**: each frame is `[12-byte nonce][4-byte length][AES-256-GCM ciphertext]`.
- **Resumable staging & Integrity**: incoming files are streamed into a temporary `.part` file.
  The offer includes the file size and SHA-256 identity; a retry of the same file resumes from
  the stored byte offset. The receiver verifies the complete hash before atomically promoting
  the file. Interrupted partials remain in the download folder as hidden `.xdrop_*.part` files;
  mismatched partials are removed.

## Windows firewall

The first time you run `xdrop`, Windows shows the standard
"Allow an app to communicate" dialog. Click **Allow** on private networks.
**No admin password is ever required.** The app prints a friendly heads-up
before opening its socket.

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
