import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  contract: "0xd4A2e52d158AEb199ecd3FcfBC749986C198F96E",
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
  if (v < 1024) return `${v} b`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kb`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} mb`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} gb`;
}

function shortHex(h: string): string {
  if (h.length <= 16) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function chainName(id: number | null): string {
  switch (id) {
    case 1: return "ethereum";
    case 11155111: return "sepolia";
    case 8453: return "base";
    case 84532: return "base sepolia";
    case 10: return "optimism";
    case 42161: return "arbitrum";
    default: return id ? `chain ${id}` : "—";
  }
}

interface BannerState {
  kind: "error" | "ok";
  text: string;
}

// Cream-stroked brand mark — sibling jindo-mark.svg in this folder. The
// repo-root jindo.svg (black-stroked) is intentionally left untouched.
import jindoMarkUrl from "./jindo-mark.svg";

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [client, setClient] = useState<JindoClient | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [outerRoot, setOuterRoot] = useState<Hex | null>(null);
  const [totalSize, setTotalSize] = useState<bigint>(0n);
  const [walletUsdc, setWalletUsdc] = useState<bigint>(0n);
  const [contractAtto, setContractAtto] = useState<bigint>(0n);
  const [withdrawableAtto, setWithdrawableAtto] = useState<bigint>(0n);
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
      setBanner({ kind: "error", text: "no injected wallet found (install metamask or similar)." });
      return;
    }
    if (!settings.hostUrl || !settings.contract || !settings.rpcUrl) {
      setBanner({ kind: "error", text: "set host url, contract address, and rpc url first." });
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

      try {
        await jindo.recover();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("does not match chain")) {
          console.warn("recover skipped:", msg);
        }
      }

      setAccount(addr);
      setChainId(ctx.chainId);
      setClient(jindo);
      await refresh(jindo);

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

      setBanner({ kind: "ok", text: `connected as ${addr}` });
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, [settings, refresh, refreshBalances]);

  const disconnect = useCallback(() => {
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
  }, []);

  const onDeposit = useCallback(async () => {
    if (!client) return;
    const amount = parseFloat(depositInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setBanner({ kind: "error", text: "enter a positive usdc amount." });
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
      setBanner({ kind: "ok", text: `deposited $${amount.toFixed(2)} usdc` });
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
      setBanner({ kind: "error", text: "enter a positive usdc amount." });
      return;
    }
    const baseAmount = BigInt(Math.round(amount * 1e6));
    const withdrawableBase = withdrawableAtto / 1_000_000_000_000n;
    if (baseAmount > withdrawableBase) {
      setBanner({
        kind: "error",
        text: `only $${(Number(withdrawableBase) / 1e6).toFixed(6)} is withdrawable — the rest is reserved for 30 days of storage.`,
      });
      return;
    }
    setBanner(null);
    setBusy("withdrawing");
    try {
      await client.withdrawUsdc(baseAmount);
      await refreshBalances(client);
      setWithdrawInput("");
      setBanner({ kind: "ok", text: `withdrew $${amount.toFixed(2)} usdc` });
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
      setBusy(arr.length === 1 ? `uploading ${arr[0]!.name}` : `uploading ${arr.length} files`);
      try {
        const payload = await Promise.all(
          arr.map(async (f) => ({
            bytes: new Uint8Array(await f.arrayBuffer()),
            filename: f.name,
          })),
        );
        const { fileRoots } = await client.upload(payload);
        await refresh(client);
        setBanner({
          kind: "ok",
          text:
            fileRoots.length === 1
              ? `uploaded ${arr[0]!.name} → ${shortHex(fileRoots[0]!)}`
              : `uploaded ${fileRoots.length} files in one batch`,
        });
      } catch (e) {
        setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(null);
      }
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
        setBanner({ kind: "ok", text: `deleted ${shortHex(fileRoot)}` });
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

  const connected = !!client && !!account;

  const headerStatus = useMemo(
    () => ({ left: connected ? chainName(chainId) : "not connected" }),
    [connected, chainId],
  );

  return (
    <div className="frame">
      <div className="shell">
        <div className="bar">
          <a className="brand" href="/" aria-label="jindo">
            <img src={jindoMarkUrl} className="mark" alt="" />
            <span className="word">jindo</span>
          </a>
          <span className="meta">
            <span className={`dot${connected ? " live" : ""}`} />
            {headerStatus.left}
          </span>
        </div>

        <div className="intro">
          paste a host, connect a wallet, deposit usdc, upload files. each commit
          is signed and anchored on-chain; hosts only earn when they re-prove the
          data once per <strong>utc day</strong>.
        </div>

        {banner && (
          <div className="banner-bar">
            <div className={`banner ${banner.kind}`}>{banner.text}</div>
          </div>
        )}

        <div className={connected ? "grid" : ""}>
        {/* connect */}
        <section className="section area-connect">
          <div className="section-head">
            <div>
              <h2>{connected ? "connection" : "connect"}</h2>
              <p className="subtitle">
                {connected
                  ? "local cache is synced with the host."
                  : "host url, contract, rpc — then connect a wallet to sign."}
              </p>
            </div>
            {connected && (
              <button className="secondary small" onClick={disconnect}>
                disconnect
              </button>
            )}
          </div>

          {!connected ? (
            <>
              <div className="field">
                <label>host url</label>
                <input
                  type="url"
                  value={settings.hostUrl}
                  onChange={(e) => setSettings({ ...settings, hostUrl: e.target.value })}
                  placeholder="https://your-host"
                  disabled={!!client}
                />
              </div>
              <div className="field">
                <label>contract address</label>
                <input
                  type="text"
                  value={settings.contract}
                  onChange={(e) =>
                    setSettings({ ...settings, contract: e.target.value as Address })
                  }
                  placeholder="0x…"
                  disabled={!!client}
                />
              </div>
              <div className="field">
                <label>rpc url</label>
                <input
                  type="url"
                  value={settings.rpcUrl}
                  onChange={(e) => setSettings({ ...settings, rpcUrl: e.target.value })}
                  placeholder="https://sepolia.base.org"
                  disabled={!!client}
                />
              </div>
              <div className="row" style={{ marginTop: 18 }}>
                <button onClick={connectWallet} disabled={busy === "connecting"}>
                  {busy === "connecting" ? "connecting…" : "connect wallet"}
                </button>
              </div>
            </>
          ) : (
            <table className="kv">
              <tbody>
                <tr>
                  <th>client</th>
                  <td className="preserve-case">{account}</td>
                  <th>host</th>
                  <td className="preserve-case">{client.hostAddress}</td>
                </tr>
                <tr>
                  <th>chain</th>
                  <td>
                    {chainName(chainId)}{" "}
                    <span className="muted">({chainId})</span>
                  </td>
                  <th>contract</th>
                  <td className="preserve-case">{settings.contract}</td>
                </tr>
                <tr>
                  <th>outer root</th>
                  <td className="preserve-case">{outerRoot ?? "—"}</td>
                  <th>stored</th>
                  <td>
                    {formatBytes(totalSize)}{" "}
                    <span className="muted">({String(totalSize)} b)</span>
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </section>

        {/* ledger */}
        {connected && (
          <section className="section area-ledger">
            <div className="section-head">
              <div>
                <h2>ledger</h2>
                <p className="subtitle">
                  funds held in atto-usdc on the contract. 30 days of the new total
                  size is reserved while data is stored — anything beyond is
                  withdrawable.
                </p>
              </div>
              {usdcAddr && (
                <button
                  className="secondary small"
                  onClick={() => client && refreshBalances(client)}
                  disabled={busy !== null}
                >
                  refresh
                </button>
              )}
            </div>

            {!usdcAddr ? (
              <div className="banner error">
                couldn't read usdc address from the contract — the deployed jindo at{" "}
                <code>{settings.contract}</code> probably predates the payment fields.
                redeploy with the current contract source and reconnect.
                {usdcError && (
                  <>
                    <br />
                    <span className="muted">details: {usdcError}</span>
                  </>
                )}
              </div>
            ) : (
              <>
                <table className="kv">
                  <tbody>
                    <tr>
                      <th>token</th>
                      <td className="preserve-case">{usdcAddr}</td>
                      <th>wallet</th>
                      <td>
                        ${(Number(walletUsdc) / 1e6).toFixed(6)}{" "}
                        <span className="muted">({String(walletUsdc)} base)</span>
                      </td>
                    </tr>
                    <tr>
                      <th>on contract</th>
                      <td>
                        ${(Number(contractAtto / 1_000_000_000_000n) / 1e6).toFixed(6)}{" "}
                        <span className="muted">({String(contractAtto)} atto)</span>
                      </td>
                      <th>withdrawable</th>
                      <td>
                        ${(Number(withdrawableAtto / 1_000_000_000_000n) / 1e6).toFixed(6)}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="row" style={{ marginTop: 18 }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="amount in usdc (e.g. 5.00)"
                    value={depositInput}
                    onChange={(e) => setDepositInput(e.target.value)}
                    disabled={busy !== null}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button onClick={onDeposit} disabled={busy !== null || !depositInput}>
                    {busy === "approving"
                      ? "approving…"
                      : busy === "depositing"
                      ? "depositing…"
                      : "deposit"}
                  </button>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="withdraw amount in usdc"
                    value={withdrawInput}
                    onChange={(e) => setWithdrawInput(e.target.value)}
                    disabled={busy !== null}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button
                    className="secondary small"
                    onClick={() => {
                      const max = withdrawableAtto / 1_000_000_000_000n;
                      setWithdrawInput((Number(max) / 1e6).toString());
                    }}
                    disabled={busy !== null || withdrawableAtto === 0n}
                    title="fill in the maximum withdrawable amount"
                  >
                    max
                  </button>
                  <button
                    className="secondary"
                    onClick={onWithdraw}
                    disabled={busy !== null || !withdrawInput}
                  >
                    {busy === "withdrawing" ? "withdrawing…" : "withdraw"}
                  </button>
                </div>
                <p className="note">
                  deposit takes one signature when allowance covers the amount,
                  otherwise two — an erc-20 approve, then a deposit.
                </p>
              </>
            )}
          </section>
        )}

        {/* upload */}
        {connected && usdcAddr && (
          <section className="section area-upload">
            <div className="section-head">
              <div>
                <h2>upload</h2>
                <p className="subtitle">
                  each file is hashed into a 1 kib-chunked merkle tree, the new
                  outer root is signed by your wallet, and the host submits the
                  commit transaction.
                </p>
              </div>
            </div>

            <div
              className={`drop${dragOver ? " over" : ""}`}
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
                : "drop a file here, or click to choose. the wallet will pop up to sign."}
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
        )}

        {/* files */}
        {connected && (
          <section className="section area-files">
            <div className="section-head">
              <div>
                <h2>
                  files
                  <span className="count">
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </span>
                </h2>
                <p className="subtitle">
                  current pair contents — synced from the host on connect.
                </p>
              </div>
              <button
                className="secondary small"
                onClick={async () => {
                  if (!client) return;
                  setBusy("recovering");
                  try {
                    await client.recover();
                    await refresh(client);
                    setBanner({ kind: "ok", text: "synced from host." });
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
                {busy === "recovering" ? "syncing…" : "sync"}
              </button>
            </div>

            {files.length === 0 ? (
              <div className="empty">— no files committed —</div>
            ) : (
              <div className="file-list">
                {files.map((f) => (
                  <div key={f.fileRoot} className="file-row">
                    <span className="root preserve-case" title={f.fileRoot}>
                      {f.fileRoot}
                    </span>
                    <span className="size">{formatBytes(f.sizeBytes)}</span>
                    <a href={downloadUrl(f.fileRoot)} target="_blank" rel="noreferrer">
                      <button className="secondary small">download</button>
                    </a>
                    <button
                      className="danger small"
                      onClick={() => onDelete(f.fileRoot)}
                      disabled={busy !== null}
                    >
                      delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        </div>

      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
