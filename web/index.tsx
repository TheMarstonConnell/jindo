import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  buildChainContextFromWallet,
  JindoClient,
  memoryCacheFactory,
  type ChainContext,
  type FileRecord,
} from "../src/lib/index.ts";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

interface Settings {
  hostUrl: string;
  contract: Address;
  rpcUrl: string;
}

const DEFAULTS: Settings = {
  hostUrl: "https://jindo.marston.dev",
  contract: "0x7915F17C3f5BD379e76688b6b3A935097f80F423",
  rpcUrl: "https://sepolia.base.org",
};

const SETTINGS_KEY = "jindo:settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function formatBytes(n: number | bigint): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function shortHex(h: string): string {
  if (h.length <= 16) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

interface BannerState {
  kind: "error" | "ok";
  text: string;
}

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [client, setClient] = useState<JindoClient | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [outerRoot, setOuterRoot] = useState<Hex | null>(null);
  const [totalSize, setTotalSize] = useState<bigint>(0n);
  const [walletUsdc, setWalletUsdc] = useState<bigint>(0n); // base units (6 decimals)
  const [contractAtto, setContractAtto] = useState<bigint>(0n); // atto-USDC
  const [withdrawableAtto, setWithdrawableAtto] = useState<bigint>(0n); // atto-USDC
  const [usdcAddr, setUsdcAddr] = useState<Address | null>(null);
  const [usdcError, setUsdcError] = useState<string | null>(null);
  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const refresh = useCallback(async (jindo: JindoClient) => {
    const out = jindo.list();
    setFiles(out.files);
    setOuterRoot(out.state.outerRoot);
    setTotalSize(out.state.totalSize);
  }, []);

  const refreshBalances = useCallback(async (jindo: JindoClient) => {
    const [wallet, contract, withdrawable] = await Promise.all([
      jindo.walletUsdcBalance(),
      jindo.contractUsdcBalance(),
      jindo.withdrawableUsdc(),
    ]);
    setWalletUsdc(wallet);
    setContractAtto(contract);
    setWithdrawableAtto(withdrawable);
  }, []);

  const connectWallet = useCallback(async () => {
    setBanner(null);
    if (!window.ethereum) {
      setBanner({ kind: "error", text: "No injected wallet found (install MetaMask or similar)." });
      return;
    }
    if (!settings.hostUrl || !settings.contract || !settings.rpcUrl) {
      setBanner({ kind: "error", text: "Set host URL, contract address, and RPC URL first." });
      return;
    }

    setBusy("connecting");
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts.length) throw new Error("no account returned from wallet");
      const addr = getAddress(accounts[0]!);

      const publicClient: PublicClient = createPublicClient({ transport: http(settings.rpcUrl) });
      const walletClient: WalletClient = createWalletClient({
        account: addr,
        transport: custom(window.ethereum),
      });

      const ctx: ChainContext = await buildChainContextFromWallet({
        publicClient,
        walletClient,
        contract: getAddress(settings.contract),
      });

      const jindo = await JindoClient.fromContext(ctx, {
        hostUrl: settings.hostUrl,
        openCache: memoryCacheFactory,
      });

      // Pull current state from host so the local cache is in sync before any upload.
      try {
        await jindo.recover();
      } catch (e) {
        // recover() throws if the chain has nothing yet — that's fine for a fresh pair.
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("does not match chain")) {
          // Surface unexpected errors but keep going if it's just an empty pair.
          console.warn("recover skipped:", msg);
        }
      }

      setAccount(addr);
      setChainId(ctx.chainId);
      setClient(jindo);
      await refresh(jindo);

      // Pull USDC address + balances. If this fails the contract is most
      // likely a pre-payment-aware deployment (no USDC() function); we keep
      // the panel visible with the error so the user can act on it.
      setUsdcAddr(null);
      setUsdcError(null);
      try {
        const usdc = await jindo.usdcAddress();
        setUsdcAddr(usdc);
        await refreshBalances(jindo);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("usdc balance read skipped:", e);
        setUsdcError(msg);
      }

      setBanner({ kind: "ok", text: `Connected as ${addr}` });
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, [settings, refresh, refreshBalances]);

  const onDeposit = useCallback(async () => {
    if (!client) return;
    const amount = parseFloat(depositInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setBanner({ kind: "error", text: "Enter a positive USDC amount." });
      return;
    }
    const baseAmount = BigInt(Math.round(amount * 1e6));
    setBanner(null);
    setBusy("depositing");
    try {
      await client.depositUsdc(baseAmount, {
        onStage: (stage) => setBusy(stage === "approve" ? "approving" : "depositing"),
      });
      await refreshBalances(client);
      setDepositInput("");
      setBanner({ kind: "ok", text: `Deposited $${amount.toFixed(2)} USDC` });
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, [client, depositInput, refreshBalances]);

  const onWithdraw = useCallback(async () => {
    if (!client) return;
    const amount = parseFloat(withdrawInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setBanner({ kind: "error", text: "Enter a positive USDC amount." });
      return;
    }
    const baseAmount = BigInt(Math.round(amount * 1e6));
    // The contract holds back 30 days of storage fees as a reserve, so the
    // wallet's view of "balance on contract" overstates what's actually
    // pullable. Pre-check here to fail fast before MetaMask pops up.
    const withdrawableBase = withdrawableAtto / 1_000_000_000_000n;
    if (baseAmount > withdrawableBase) {
      setBanner({
        kind: "error",
        text: `Only $${(Number(withdrawableBase) / 1e6).toFixed(6)} is withdrawable — the rest is reserved for 30 days of storage.`,
      });
      return;
    }
    setBanner(null);
    setBusy("withdrawing");
    try {
      await client.withdrawUsdc(baseAmount);
      await refreshBalances(client);
      setWithdrawInput("");
      setBanner({ kind: "ok", text: `Withdrew $${amount.toFixed(2)} USDC` });
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, [client, withdrawInput, withdrawableAtto, refreshBalances]);

  const onFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!client) return;
      const arr = Array.from(fileList);
      if (arr.length === 0) return;
      setBanner(null);
      for (const f of arr) {
        setBusy(`uploading ${f.name}`);
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const root = await client.upload(bytes);
          await refresh(client);
          setBanner({ kind: "ok", text: `Uploaded ${f.name} → ${shortHex(root)}` });
        } catch (e) {
          setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
          break;
        }
      }
      setBusy(null);
    },
    [client, refresh],
  );

  const onDelete = useCallback(
    async (fileRoot: Hex) => {
      if (!client) return;
      setBusy(`deleting ${shortHex(fileRoot)}`);
      try {
        await client.delete(fileRoot);
        await refresh(client);
        setBanner({ kind: "ok", text: `Deleted ${shortHex(fileRoot)}` });
      } catch (e) {
        setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(null);
      }
    },
    [client, refresh],
  );

  const downloadUrl = useCallback(
    (fileRoot: Hex) => {
      const stripped = settings.hostUrl.replace(/\/$/, "");
      return `${stripped}/download/${fileRoot}`;
    },
    [settings.hostUrl],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
    },
    [onFiles],
  );

  return (
    <main>
      <header>
        <h1>Jindo demo</h1>
        <p>Connect a wallet, point at a host, upload a file, and watch it land on-chain.</p>
      </header>

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      <section className="panel">
        <div>
          <label>Host URL</label>
          <input
            type="url"
            value={settings.hostUrl}
            onChange={(e) => setSettings({ ...settings, hostUrl: e.target.value })}
            placeholder="http://127.0.0.1:8787"
            disabled={!!client}
          />
        </div>
        <div>
          <label>Contract address</label>
          <input
            type="text"
            value={settings.contract}
            onChange={(e) => setSettings({ ...settings, contract: e.target.value as Address })}
            placeholder="0x…"
            disabled={!!client}
          />
        </div>
        <div>
          <label>RPC URL (read-only)</label>
          <input
            type="url"
            value={settings.rpcUrl}
            onChange={(e) => setSettings({ ...settings, rpcUrl: e.target.value })}
            placeholder="http://127.0.0.1:8545"
            disabled={!!client}
          />
        </div>
        <div className="row">
          {!client ? (
            <button onClick={connectWallet} disabled={busy === "connecting"}>
              {busy === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          ) : (
            <button
              className="secondary"
              onClick={() => {
                setClient(null);
                setAccount(null);
                setChainId(null);
                setFiles([]);
                setOuterRoot(null);
                setTotalSize(0n);
                setWalletUsdc(0n);
                setContractAtto(0n);
                setWithdrawableAtto(0n);
                setUsdcAddr(null);
                setUsdcError(null);
                setBanner(null);
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </section>

      {client && account && (
        <>
          <section className="panel">
            <div className="kv">
              <div className="k">client</div>
              <div className="v">{account}</div>
              <div className="k">host</div>
              <div className="v">{client.hostAddress}</div>
              <div className="k">chain</div>
              <div className="v">{chainId}</div>
              <div className="k">outer root</div>
              <div className="v">{outerRoot ?? "—"}</div>
              <div className="k">total</div>
              <div className="v">
                {formatBytes(totalSize)} <span className="muted">({String(totalSize)} B)</span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>USDC</strong>
              <button
                className="secondary"
                onClick={() => client && refreshBalances(client)}
                disabled={busy !== null || !usdcAddr}
              >
                Refresh
              </button>
            </div>
            {!usdcAddr ? (
              <div className="banner error">
                Couldn't read USDC address from the contract — the deployed Jindo at{" "}
                <code>{settings.contract}</code> probably predates the payment fields.
                Redeploy with the current contract source (the deploy scripts now bake
                USDC into the constructor) and reconnect.
                {usdcError && (
                  <>
                    <br />
                    <span className="muted">details: {usdcError}</span>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="kv">
                  <div className="k">token</div>
                  <div className="v">{usdcAddr}</div>
                  <div className="k">wallet</div>
                  <div className="v">
                    ${(Number(walletUsdc) / 1e6).toFixed(6)}{" "}
                    <span className="muted">({String(walletUsdc)} base)</span>
                  </div>
                  <div className="k">on contract</div>
                  <div className="v">
                    ${(Number(contractAtto / 1_000_000_000_000n) / 1e6).toFixed(6)}{" "}
                    <span className="muted">({String(contractAtto)} atto)</span>
                  </div>
                  <div className="k">withdrawable</div>
                  <div className="v">
                    ${(Number(withdrawableAtto / 1_000_000_000_000n) / 1e6).toFixed(6)}{" "}
                    <span className="muted">
                      (rest is 30-day storage reserve)
                    </span>
                  </div>
                </div>
                <div className="row">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="amount in USDC (e.g. 5.00)"
                    value={depositInput}
                    onChange={(e) => setDepositInput(e.target.value)}
                    disabled={busy !== null}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button onClick={onDeposit} disabled={busy !== null || !depositInput}>
                    {busy === "approving"
                      ? "Approving…"
                      : busy === "depositing"
                      ? "Depositing…"
                      : "Deposit"}
                  </button>
                </div>
                <div className="row">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="withdraw amount in USDC"
                    value={withdrawInput}
                    onChange={(e) => setWithdrawInput(e.target.value)}
                    disabled={busy !== null}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button
                    className="secondary"
                    onClick={() => {
                      const max = withdrawableAtto / 1_000_000_000_000n;
                      setWithdrawInput((Number(max) / 1e6).toString());
                    }}
                    disabled={busy !== null || withdrawableAtto === 0n}
                    title="Fill in the maximum withdrawable amount"
                  >
                    Max
                  </button>
                  <button
                    className="secondary"
                    onClick={onWithdraw}
                    disabled={busy !== null || !withdrawInput}
                  >
                    {busy === "withdrawing" ? "Withdrawing…" : "Withdraw"}
                  </button>
                </div>
                <div className="muted">
                  Deposit takes one signature when the existing allowance covers
                  the amount, otherwise two (approve, then deposit).
                </div>
              </>
            )}
          </section>

          <section className="panel">
            <div
              className={`drop ${dragOver ? "over" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              {busy?.startsWith("uploading")
                ? busy
                : "Drop a file here, or click to choose. The wallet will pop up to sign each upload."}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={(e) => {
                if (e.target.files) onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </section>

          <section className="panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>Files ({files.length})</strong>
              <button
                className="secondary"
                onClick={async () => {
                  if (!client) return;
                  setBusy("recovering");
                  try {
                    await client.recover();
                    await refresh(client);
                    setBanner({ kind: "ok", text: "Synced from host." });
                  } catch (e) {
                    setBanner({
                      kind: "error",
                      text: e instanceof Error ? e.message : String(e),
                    });
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={busy !== null}
              >
                {busy === "recovering" ? "Syncing…" : "Sync"}
              </button>
            </div>
            {files.length === 0 ? (
              <div className="empty">No files yet.</div>
            ) : (
              <div className="file-list">
                {files.map((f) => (
                  <div key={f.fileRoot} className="file-row">
                    <span className="root" title={f.fileRoot}>
                      {f.fileRoot}
                    </span>
                    <span className="size">{formatBytes(f.sizeBytes)}</span>
                    <a href={downloadUrl(f.fileRoot)} target="_blank" rel="noreferrer">
                      <button className="secondary">Download</button>
                    </a>
                    <button
                      className="danger"
                      onClick={() => onDelete(f.fileRoot)}
                      disabled={busy !== null}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
