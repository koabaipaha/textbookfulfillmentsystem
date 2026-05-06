# Textbook Library Bridge

A tiny agent that runs on the Windows machine where your `D:\Book Database`
folder lives. It mirrors that folder into the cloud Textbook Portal so the
fulfillment pipeline's "local DB" search step can find books from the drive.

The bridge:

- Walks `LIBRARY_PATH` recursively (PDF / EPUB / DOCX / DOC / MOBI / TXT / RTF / HTML).
- Hashes each file (SHA-256) and uploads only what's new or changed.
- Watches for live filesystem changes (debounced 5s) and re-scans on a 30 min cadence.
- Removes cloud entries when files are deleted locally.

## Requirements

- Windows 10/11 (or any OS — the script is portable).
- Node.js **18 or newer** (`node --version`). Download from <https://nodejs.org>.

## One-time setup

1. Copy this entire `tools/library-bridge` folder to the Windows machine — for
   example `C:\library-bridge\`.

2. In that folder, create a file called `.env` (no extension other than
   `.env`) with these three lines:

   ```env
   BRIDGE_URL=https://YOUR-APP.replit.app
   BRIDGE_TOKEN=paste-the-LIBRARY_BRIDGE_TOKEN-secret-here
   LIBRARY_PATH=D:\Book Database
   ```

   Get the `BRIDGE_URL` from the address bar of your deployed Replit app.
   `BRIDGE_TOKEN` must match the `LIBRARY_BRIDGE_TOKEN` secret you set on the
   Replit server.

3. Open Command Prompt or PowerShell in that folder and run:

   ```cmd
   node bridge.mjs
   ```

   You should see something like:

   ```
   [scan] starting at D:\Book Database
   [scan] cloud knows 0 files
   [scan] done in 12.3s — created=128 updated=0 removed=0 skipped=0 ...
   [watch] watching for changes
   ```

## Optional settings (in `.env`)

| Variable             | Default | Description                                              |
| -------------------- | ------- | -------------------------------------------------------- |
| `POLL_INTERVAL_MIN`  | `30`    | How often to do a full re-scan, in minutes.              |
| `MAX_FILE_MB`        | `200`   | Skip files larger than this many MB.                     |
| `WATCH`              | `1`     | Set to `0` to disable real-time watching.                |

## Running it as a Windows service

To keep the bridge running in the background after you close the terminal,
install [`nssm`](https://nssm.cc/) and register it:

```cmd
nssm install TextbookBridge "C:\Program Files\nodejs\node.exe" "C:\library-bridge\bridge.mjs"
nssm set TextbookBridge AppDirectory "C:\library-bridge"
nssm start TextbookBridge
```

Logs go to the Windows Event Log; configure stdout/stderr redirection in nssm
if you want a log file.

## What gets uploaded

For each new/changed file the bridge POSTs the raw bytes to the cloud's
`/api/library/bridge/upload`. The server:

- Stores the file in private object storage.
- Extracts ISBN-10 / ISBN-13 from the filename.
- Cleans the filename into a title.
- Inserts a row in the `books` table with `source = "library_bridge"` so
  it shows up in the cascade's first search step.

If the same `sourcePath` appears with the same SHA-256, the upload is a no-op.
If a local file disappears, the cloud row is marked `removed`.
