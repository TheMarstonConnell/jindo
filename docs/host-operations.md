# Running a host

A runbook for operating a jindo **host** — the storage provider — beyond a
laptop demo. If you haven't started a host once yet, do
[getting-started.md](getting-started.md) first; this picks up from there.

A host's job is three things, forever:

1. **Accept signed uploads/deletes** and commit them on-chain.
2. **Prove** to the contract, on a schedule, that it still holds each client's
   data — this is how it earns.
3. **Claim** the USDC it has earned.

The server started by `jindo start` does (1) and (2) on its own. You wire up (3).

---

## What a host needs

| Requirement | Why |
|---|---|
| A deployed Jindo contract address | Set as `JINDO_CONTRACT`. Deploy with `bun run deploy:sepolia` (or `deploy:mainnet`). |
| A host wallet **with ETH** | The host pays gas for every `commitUpload`, `commitDelete`, and `commitProof`. Keep it funded. |
| A reliable RPC endpoint | The public `https://sepolia.base.org` is fine for testing; for production use a dedicated provider (Alchemy/QuickNode/etc.) so proofs and uploads don't get rate-limited. |
| Disk for `JINDO_DATA_DIR` | Holds the database and every stored blob. Size it for your clients' data. |

The host wallet does **not** hold or need USDC — it *earns* USDC. Clients fund
storage; the host collects it.

---

## Configuration

All host settings come from the environment (`jindo start` reads them via the
`.env` file Bun auto-loads, or real environment variables):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JINDO_PRIVATE_KEY` | yes | — | Host signing key. Pays gas; identifies the host on-chain. |
| `JINDO_RPC_URL` | yes | — | RPC endpoint for the chain the contract is on. |
| `JINDO_CONTRACT` | yes | — | Deployed Jindo contract address. |
| `JINDO_PORT` | no | `5689` | Port the HTTP server binds (on `0.0.0.0`). |
| `JINDO_DATA_DIR` | no | `./data` | Where the database and blobs live. |
| `JINDO_PROVE_INTERVAL_MS` | no | `43200000` (12h) | How often the automatic proof sweep runs. Set `0` to disable automatic proving entirely. |

---

## Starting and keeping it running

For a quick run:

```bash
bun src/cli.ts start
```

For a real deployment, run it under a process manager so it restarts on crash and
on reboot. A minimal **systemd** unit:

```ini
# /etc/systemd/system/jindo-host.service
[Unit]
Description=jindo storage host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jindo
WorkingDirectory=/opt/jindo
# Put JINDO_* (including JINDO_PRIVATE_KEY) here, root-only readable:
EnvironmentFile=/opt/jindo/.env
ExecStart=/home/jindo/.bun/bin/bun src/cli.ts start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jindo-host
journalctl -u jindo-host -f      # follow the logs
```

> Protect the env file — it contains the host private key:
> `sudo chmod 600 /opt/jindo/.env`.

On startup you'll see the listening line and the proof-sweep schedule:

```
jindo host listening on http://0.0.0.0:5689 as 0xHOST... (chain 84532, contract 0x...)
[prove-all] scheduled every 43200000ms (first sweep in 30000ms)
```

Stopping: `Ctrl-C` (or `systemctl stop jindo-host`). The server shuts down
cleanly and cancels the proof timer.

---

## On-disk layout & backups

Everything the host keeps lives under `JINDO_DATA_DIR`:

```
data/
  host.sqlite        # one database: clients, their files, per-pair state, tx hashes
  blobs/
    0x<fileRoot>     # the raw bytes, content-addressed and shared across clients
    0x<fileRoot>
    ...
```

Blobs are **content-addressed and de-duplicated**: if two clients upload the same
bytes, the host stores one blob and reference-counts it. A blob is removed from
disk only when the last client referencing it deletes it.

**Backups:** back up the *whole* `JINDO_DATA_DIR` together — `host.sqlite` and
`blobs/` must stay consistent with each other (and with the chain). The safest
snapshot is taken with the host stopped, or using SQLite's online backup. If you
ever lose `host.sqlite` but keep the blobs, there is no built-in rebuild path, so
treat the database as precious.

---

## Earning: proofs and claims

This is the part that's easy to forget. A host that accepts uploads but never
proves or claims **stores data for free**.

### Proving (automatic)

The server runs a proof sweep across every client on a timer
(`JINDO_PROVE_INTERVAL_MS`, default every 12 hours; the first sweep is 30 seconds
after startup). Each sweep, for each non-empty client, it answers the current
on-chain challenge — submitting the bytes of a random chunk plus Merkle proofs —
which moves one day's fee from the client's pool into your accrued earnings.

Watch it in the logs:

```
[prove-all] sweep starting for 3 client(s)
[prove-all] 0xCLIENT...: ok challengeIndex=42 fileRoot=0x... tx=0x...
[prove-all] 0xCLIENT...: cooldown — already proved this UTC day, skipping
[prove-all] sweep done
```

Rules to know:

- **At most one paid proof per client per UTC day.** Running the sweep more often
  is harmless — extra runs hit the cooldown and skip. Running it *less* than once
  a day means you forfeit the missed days' revenue. Twice daily (the default) is a
  comfortable margin against downtime.
- A sweep that's still running when the next tick fires is skipped, so slow chains
  won't pile up overlapping sweeps.

Force a single client's proof by hand:

```bash
bun src/cli.ts prove 0xCLIENT...
```

### Claiming (you schedule this)

Proofs accrue earnings on-chain but don't transfer USDC. To pull your earnings
into the host wallet, run:

```bash
bun src/cli.ts withdraw
```

This sweeps **every client** you store for and claims each pair's whole-USDC
accrued balance (sub-cent dust is left to accumulate). Output:

```
[withdraw] sweep starting for 3 client(s) as host 0xHOST...
[withdraw] 0xCLIENT..: claimed $0.690000 (accrued $0.690420 → $0.000420) tx=0x...
[withdraw] 0xCLIENT..: nothing to claim (accrued $0.000100 < 1 base unit) — skipping
[withdraw] sweep done: claimed $0.690000 from 1/3 client(s)
```

> Despite the name, `jindo withdraw` is a **host** command — it claims your
> *earnings*. It is different from the contract's `withdraw()` function, which
> lets a *client* pull back unspent deposit. There is no client-side CLI for that
> today; a client withdraws unspent funds by calling the contract directly (e.g.
> with `cast send <contract> "withdraw(uint256)" <baseAmount>`).

Claiming costs a little gas, so don't run it every minute. A daily or weekly cron
is typical:

```cron
# claim earnings every day at 02:00
0 2 * * * cd /opt/jindo && /home/jindo/.bun/bin/bun src/cli.ts withdraw >> /var/log/jindo-withdraw.log 2>&1
```

---

## Monitoring

The host exposes plain HTTP endpoints (full reference in [server.md](server.md)):

```bash
# Rich status: identity, chain, client count, total bytes, uptime
curl http://localhost:5689/ | jq

# Liveness + the host's address/chain/contract
curl http://localhost:5689/health

# Every client this host stores for, with size and file count
curl http://localhost:5689/clients | jq
```

Useful signals to alert on:

- The host process is up and `/health` responds.
- Host wallet ETH balance stays above a floor (it can't commit anything at zero).
  Check with `cast balance <HOST_ADDRESS> --rpc-url $JINDO_RPC_URL`.
- The logs show a successful `[prove-all]` sweep at least once per UTC day.
- No recurring `chain submission failed` lines (RPC trouble or out of gas).

---

## Operational checklist

| Cadence | Do |
|---|---|
| Continuously | Keep the process up (process manager + restart). |
| Per upload | Nothing — the host refuses underfunded clients (`402`) and rolls back automatically if a chain tx fails, so its state always matches the chain. |
| Daily | Confirm a proof sweep succeeded; top up host ETH if low. |
| Daily/weekly | Run `jindo withdraw` to collect earnings. |
| Ongoing | Back up `JINDO_DATA_DIR` (database + blobs together). |

---

## Going to mainnet

When you're ready to leave testnet:

```bash
bun run deploy:mainnet      # asks for explicit confirmation; deploys to Base mainnet
```

Everything else is identical — point `JINDO_RPC_URL` at a Base mainnet RPC and
`JINDO_CONTRACT` at the new address. Now the ETH is real (gas) and the USDC is
real (earnings), so fund and secure the host wallet accordingly, and prefer a
dedicated RPC provider over a public endpoint.
