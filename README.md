# GenCode Usage — Orca Status Bar & Sidebar Plugin

Shows **GenCode** (`gencode stats`) token/cost usage and Genspark credit pool tier (**GREEN / YELLOW / RED / EXHAUSTED**) in Orca's bottom status bar and sidebar panel — locally or over SSH from a remote Linux server.

## Features
- **Bottom Status Bar Item (`gencode-usage`)**: polls `gencode stats --days 1` and `gencode stats` in a Node worker and updates the status bar (`statusBar.update`). Click the item to refresh immediately.
- **Remote SSH Support (`sshHost`)**: leave `SSH host` blank to run `gencode` locally, or set an SSH config alias / `user@host` (e.g. your Linux server) to pull live stats over SSH (`ssh -o BatchMode=yes`).
- **Sidebar Panel**: displays today's and all-time cost/tokens/sessions, plus a credit-pool tracker:
  - `소진율 = (GENCODE_START_BALANCE − 현재 잔액) ÷ GENCODE_BUDGET × 100`
  - `GREEN (<60%)` → `YELLOW (60~85%)` → `RED (85~100%)` → `EXHAUSTED (≥100%)`
- **Settings**: `sshHost`, `gencodeBin`, `refreshIntervalSec` (default 60s), and optional `dailyBudgetUsd`.

## Install on Desktop Orca
> `statusBar.update` runs in the **Desktop Orca app** (not headless `orca serve`).

1. Enable plugins in Desktop Orca (**Settings → Plugins → Turn on plugins**).
2. Install from GitHub in your desktop terminal:
   ```bash
   orca plugin install https://github.com/flybywind2/gencode-usage --json
   # Review the printed permissions & fingerprint, then approve:
   orca plugin install https://github.com/flybywind2/gencode-usage --approve <fingerprint>
   ```
3. If `gencode` runs on your remote Linux server instead of your desktop PC, open **Settings → Plugins → GenCode Usage** and set:
   - **SSH host**: your SSH alias or `ubuntu@<server-ip>`
   - **GenCode CLI path**: `/usr/bin/gencode` (or `gencode`)
