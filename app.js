const el = (id) => document.getElementById(id);

const APP_NAME = "EryVanta";
const POLYGON_CHAIN_ID = "0x89"; // 137

// Receiver
const MERCHANT_ADDRESS = "0x03a6BC48ED8733Cc700AE49657931243f078a994";

// TEST MODE: fixed 1 POL payment
const FIXED_PAY_WEI = 1n * (10n ** 18n); // 1 POL = 1e18 wei

// ChainList-style RPC candidates (HTTPS)
const POLYGON_RPC_CANDIDATES = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
  "https://polygon-public.nodies.app",
];

// --- Robustness knobs ---
const TX_SEND_TIMEOUT_MS = 60000;     // more room for MetaMask UI
const TX_CONFIRM_TIMEOUT_MS = 300000; // 5 min

const btnConnect = el("btnConnect");
const btnFixRpc = el("btnFixRpc"); // optional (but recommended)
const btnLogout = el("btnLogout");
const btnQuote = el("btnQuote");
const btnPay = el("btnPay");

let account = null;
let lastQuote = null;
let activeRpc = null;
let activateTab = () => {};

/* -----------------------
   UI status helpers
------------------------ */
function setStatus(text, onOff) {
  el("status").textContent = text;
  const dot = el("dot");
  dot.classList.remove("on", "off");
  if (onOff === "on") dot.classList.add("on");
  if (onOff === "off") dot.classList.add("off");
}

function setSessionMsg(msg = "") {
  const node = el("sessionMsg");
  if (node) node.textContent = msg;
}

function toHex(bigint) {
  if (bigint < 0n) throw new Error("Negative BigInt not supported");
  return "0x" + bigint.toString(16);
}

function formatEthFromWeiHex(weiHex) {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

function nowIso() {
  return new Date().toISOString();
}

/* -----------------------
   Provider (MetaMask)
------------------------ */
async function requireProvider() {
  if (!window.ethereum) throw new Error("MetaMask is not installed.");
  return window.ethereum;
}

async function getChainIdWallet() {
  const provider = await requireProvider();
  return provider.request({ method: "eth_chainId" });
}

/* -----------------------
   Timeouts + wallet helpers
------------------------ */
function withTimeout(promise, ms, label = "Operation") {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function isUserRejected(err) {
  return err?.code === 4001;
}

function isPendingRequest(err) {
  return err?.code === -32002;
}

async function walletReq(method, params = [], timeoutMs = 30000) {
  const provider = await requireProvider();
  return withTimeout(provider.request({ method, params }), timeoutMs, `wallet ${method}`);
}

/* -----------------------
   RPC auto-failover layer
------------------------ */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcFetch(url, method, params = [], timeoutMs = 6500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

async function isHealthyPolygonRpc(url) {
  const chainId = await rpcFetch(url, "eth_chainId", []);
  if (String(chainId).toLowerCase() !== POLYGON_CHAIN_ID) throw new Error("Wrong chainId");
  await rpcFetch(url, "eth_blockNumber", []);
  return true;
}

function getCachedRpc() {
  try {
    const x = JSON.parse(localStorage.getItem("eryvanta_polygon_rpc") || "null");
    if (!x || !x.url || !x.ts) return null;
    if (Date.now() - x.ts > 30 * 60 * 1000) return null; // re-check every 30 minutes
    return x.url;
  } catch {
    return null;
  }
}

function cacheRpc(url) {
  localStorage.setItem("eryvanta_polygon_rpc", JSON.stringify({ url, ts: Date.now() }));
}

async function pickHealthyPolygonRpc() {
  const cached = getCachedRpc();
  if (cached) {
    activeRpc = cached;
    return activeRpc;
  }

  for (const url of POLYGON_RPC_CANDIDATES) {
    try {
      await isHealthyPolygonRpc(url);
      activeRpc = url;
      cacheRpc(activeRpc);
      return activeRpc;
    } catch {
      // continue
    }
  }

  throw new Error("No healthy Polygon RPC found. Try again later.");
}

async function rpcRequestPolygon(method, params = []) {
  if (!activeRpc) await pickHealthyPolygonRpc();

  const tried = new Set();
  const candidates = [activeRpc, ...POLYGON_RPC_CANDIDATES.filter((u) => u !== activeRpc)];

  for (const url of candidates) {
    if (tried.has(url)) continue;
    tried.add(url);
    try {
      const out = await rpcFetch(url, method, params, 9000);
      if (url !== activeRpc) {
        activeRpc = url;
        cacheRpc(activeRpc);
      }
      return out;
    } catch {
      // try next
    }
  }

  throw new Error("Polygon RPC failed on all endpoints.");
}

/* -----------------------
   MetaMask Polygon RPC auto-heal
------------------------ */
async function autoFixMetamaskPolygonRpc() {
  const provider = await requireProvider();
  const bestRpc = await pickHealthyPolygonRpc();

  await withTimeout(
    provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: POLYGON_CHAIN_ID,
          chainName: "Polygon Mainnet",
          rpcUrls: [bestRpc, ...POLYGON_RPC_CANDIDATES.filter((x) => x !== bestRpc)],
          nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
          blockExplorerUrls: ["https://polygonscan.com/"],
        },
      ],
    }),
    25000,
    "wallet_addEthereumChain"
  );
}

/* -----------------------
   Network switching (Polygon)
------------------------ */
async function switchToPolygon() {
  const provider = await requireProvider();
  const current = await getChainIdWallet().catch(() => null);
  if (current && String(current).toLowerCase() === POLYGON_CHAIN_ID) return;

  const bestRpc = await pickHealthyPolygonRpc();

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: POLYGON_CHAIN_ID,
            chainName: "Polygon Mainnet",
            rpcUrls: [bestRpc, ...POLYGON_RPC_CANDIDATES.filter((x) => x !== bestRpc)],
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            blockExplorerUrls: ["https://polygonscan.com/"],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

/* -----------------------
   FREE FEES tx params:
   - no gasPrice / maxFeePerGas / maxPriorityFeePerGas set
   - MetaMask chooses best fees automatically
   - optional: set only "gas" from healthy RPC to reduce MetaMask estimation hangs
------------------------ */
async function buildTxParamsFreeFees({ from, to, valueWei }) {
  await pickHealthyPolygonRpc();

  let gasHex = null;
  try {
    gasHex = await rpcRequestPolygon("eth_estimateGas", [{ from, to, value: toHex(valueWei) }]);
  } catch {
    gasHex = null;
  }

  const tx = {
    from,
    to,
    value: toHex(valueWei),
  };

  if (gasHex) {
    const gas = (BigInt(gasHex) * 120n) / 100n; // +20% margin
    tx.gas = toHex(gas);
  }

  // IMPORTANT: do NOT set gasPrice/maxFee/maxPriority => MetaMask auto
  return tx;
}

/* -----------------------
   Session + membership local storage
------------------------ */
function getSession() {
  try {
    return JSON.parse(localStorage.getItem("eryvanta_session") || "null");
  } catch {
    return null;
  }
}
function setSession(s) {
  localStorage.setItem("eryvanta_session", JSON.stringify(s));
}
function clearSession() {
  localStorage.removeItem("eryvanta_session");
}

function getMembership() {
  try {
    return JSON.parse(localStorage.getItem("eryvanta_membership") || "null");
  } catch {
    return null;
  }
}
function setMembership(m) {
  localStorage.setItem("eryvanta_membership", JSON.stringify(m));
}

function isSignedIn() {
  const s = getSession();
  return Boolean(
    s &&
      s.account &&
      s.sig &&
      s.message &&
      account &&
      s.account.toLowerCase() === account.toLowerCase()
  );
}

/* -----------------------
   UI helpers
------------------------ */
function setLoggedOutUI() {
  setStatus("Disconnected", "off");
  setSessionMsg("");
  el("addr").textContent = "-";
  el("chain").textContent = "-";
  el("bal").textContent = "-";
  btnLogout.disabled = true;
  btnPay.disabled = true;
}

async function refreshWalletUI() {
  if (!account) return;

  el("addr").textContent = account;
  btnLogout.disabled = false;

  // chain id (prefer wallet)
  try {
    el("chain").textContent = await getChainIdWallet();
  } catch {
    try {
      el("chain").textContent = await rpcRequestPolygon("eth_chainId", []);
    } catch {
      el("chain").textContent = "?";
    }
  }

  // balance (prefer wallet; fallback to our RPC)
  try {
    const balHex = await walletReq("eth_getBalance", [account, "latest"], 15000);
    el("bal").textContent = formatEthFromWeiHex(balHex);
  } catch {
    setSessionMsg("RPC متامسک مشکل دارد. Fix Polygon RPC را بزن یا RPC شبکه Polygon را در MetaMask تغییر بده.");
    try {
      const balHex = await rpcRequestPolygon("eth_getBalance", [account, "latest"]);
      el("bal").textContent = formatEthFromWeiHex(balHex);
    } catch {
      el("bal").textContent = "?";
    }
  }

  setStatus("Connected", "on");
  await refreshMembershipUI().catch(() => {});
}

/* -----------------------
   Quote (TEST: fixed 1 POL)
------------------------ */
async function refreshQuote() {
  el("shopMsg").textContent = "";
  el("receiver").textContent = MERCHANT_ADDRESS;

  try {
    await pickHealthyPolygonRpc();

    lastQuote = {
      wei: FIXED_PAY_WEI.toString(),
      mode: "fixed_pol",
      updatedAt: Math.floor(Date.now() / 1000),
    };

    el("price").textContent = "Fixed (1 POL)";
    el("amountPol").textContent = "1.000000 POL";
    el("updatedAt").textContent = "now";

    btnPay.disabled = !isSignedIn();
  } catch (e) {
    btnPay.disabled = true;
    el("price").textContent = "-";
    el("amountPol").textContent = "-";
    el("updatedAt").textContent = "-";
    el("shopMsg").textContent = e?.message || String(e);
  }
}

/* -----------------------
   Tx verify helpers
------------------------ */
async function waitForReceiptSmart(txHash, timeoutMs = TX_CONFIRM_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // 1) wallet provider
    try {
      const r1 = await walletReq("eth_getTransactionReceipt", [txHash], 8000).catch(() => null);
      if (r1) return r1;
    } catch {}

    // 2) our RPC failover
    try {
      const r2 = await rpcRequestPolygon("eth_getTransactionReceipt", [txHash]).catch(() => null);
      if (r2) return r2;
    } catch {}

    await sleep(2000);
  }
  throw new Error("Timed out waiting for confirmation.");
}

async function verifyTx(txHash, expectedWeiStr) {
  const tx = await rpcRequestPolygon("eth_getTransactionByHash", [txHash]);
  if (!tx) return { ok: false, reason: "Transaction not found." };

  const to = (tx.to || "").toLowerCase();
  const from = (tx.from || "").toLowerCase();
  const valueWei = BigInt(tx.value || "0x0");
  const expectedWei = BigInt(expectedWeiStr);

  if (to !== MERCHANT_ADDRESS.toLowerCase()) return { ok: false, reason: "Receiver mismatch." };
  if (!account || from !== account.toLowerCase()) return { ok: false, reason: "Sender mismatch." };
  if (valueWei !== expectedWei) return { ok: false, reason: "Amount mismatch." };

  const receipt = await rpcRequestPolygon("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { ok: false, reason: "Receipt not found yet." };
  if (receipt.status !== "0x1") return { ok: false, reason: "Transaction failed." };

  return { ok: true, reason: "Verified." };
}

async function refreshMembershipUI() {
  const m = getMembership();
  if (!m || !account) {
    el("mStatus").textContent = "Inactive";
    el("mTx").textContent = "-";
    el("mVerified").textContent = "-";
    return;
  }

  el("mTx").textContent = m.txHash || "-";

  if (m.account?.toLowerCase() !== account.toLowerCase()) {
    el("mStatus").textContent = "Inactive";
    el("mVerified").textContent = "No (different wallet)";
    return;
  }

  try {
    await pickHealthyPolygonRpc();
    const v = await verifyTx(m.txHash, m.expectedWei);
    el("mStatus").textContent = v.ok ? "Active" : "Inactive";
    el("mVerified").textContent = v.ok ? "Yes" : `No (${v.reason})`;
  } catch (e) {
    el("mStatus").textContent = "Unknown";
    el("mVerified").textContent = e?.message || String(e);
  }
}

/* -----------------------
   Tabs
------------------------ */
function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const views = { home: el("view-home"), shop: el("view-shop"), account: el("view-account") };

  function activate(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(views).forEach(([k, v]) => v.classList.toggle("active", k === name));
    if (name === "shop") refreshQuote();
    if (name === "account") refreshMembershipUI();
  }

  activateTab = activate;
  tabs.forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab)));
}

/* -----------------------
   Connect + Sign
------------------------ */
async function connectWallet() {
  await requireProvider();
  let accounts;
  try {
    accounts = await walletReq("eth_requestAccounts", [], 60000);
  } catch (err) {
    if (isPendingRequest(err)) {
      throw new Error("یک درخواست متامسک باز است. MetaMask را باز کن و درخواست قبلی را کامل کن.");
    }
    throw err;
  }
  account = accounts?.[0] || null;
  if (!account) throw new Error("No account selected.");
  await refreshWalletUI();
}

async function signIn() {
  const provider = await requireProvider();
  const message = [`Sign in to ${APP_NAME}`, `Address: ${account}`, `Time: ${nowIso()}`].join("\n");

  const sig = await provider.request({
    method: "personal_sign",
    params: [message, account],
  });

  setSession({ account, sig, message });
}

/* -----------------------
   Button handlers
------------------------ */
btnConnect.onclick = async () => {
  try {
    setSessionMsg("");
    await connectWallet();
    if (!isSignedIn()) await signIn();
    activateTab("shop");
    await refreshQuote();
  } catch (e) {
    setStatus(e?.message || String(e), "off");
  }
};

if (btnFixRpc) {
  btnFixRpc.onclick = async () => {
    try {
      setSessionMsg("");
      await autoFixMetamaskPolygonRpc();
      setSessionMsg("در MetaMask درخواست آپدیت Polygon ارسال شد. Approve کن و دوباره تست کن.");
    } catch (e) {
      setSessionMsg(e?.message || String(e));
    }
  };
}

btnLogout.onclick = () => {
  clearSession();
  btnPay.disabled = true;
  el("shopMsg").textContent = "Signed out.";
  setLoggedOutUI();
};

btnQuote.onclick = async () => {
  await refreshQuote();
};

btnPay.onclick = async () => {
  const prevDisabled = btnPay.disabled;
  btnPay.disabled = true;

  try {
    el("shopMsg").textContent = "";

    if (!account) throw new Error("Connect wallet first.");
    if (!isSignedIn()) throw new Error("Sign in first (signature).");

    el("shopMsg").textContent = "Preparing network...";
    await pickHealthyPolygonRpc();
    await switchToPolygon();

    // Heal MetaMask Polygon RPC (reduces hangs)
    try {
      el("shopMsg").textContent = "Fixing wallet Polygon RPC...";
      await autoFixMetamaskPolygonRpc();
    } catch {
      // ignore
    }

    await refreshQuote();
    if (!lastQuote) throw new Error("Quote not available.");

    const expectedWei = FIXED_PAY_WEI;

    // FREE FEES: MetaMask decides best fees
    el("shopMsg").textContent = "Opening MetaMask...";
    const txParams = await buildTxParamsFreeFees({
      from: account,
      to: MERCHANT_ADDRESS,
      valueWei: expectedWei,
    });

    let txHash;
    try {
      txHash = await withTimeout(
        window.ethereum.request({
          method: "eth_sendTransaction",
          params: [txParams],
        }),
        TX_SEND_TIMEOUT_MS,
        "eth_sendTransaction"
      );
    } catch (err) {
      if (isUserRejected(err)) throw new Error("Transaction rejected in wallet.");
      if (isPendingRequest(err)) throw new Error("یک درخواست متامسک باز است. MetaMask را باز کن و درخواست قبلی را کامل کن.");
      throw err;
    }

    // Store pending immediately (so UI won't look stuck)
    setMembership({
      account,
      txHash,
      expectedWei: expectedWei.toString(),
      purchasedAt: nowIso(),
      mode: "fixed_1_pol",
      chainId: POLYGON_CHAIN_ID,
      status: "pending",
    });

    el("shopMsg").textContent = "Submitted. Waiting for confirmation...";

    const receipt = await waitForReceiptSmart(txHash);

    if (receipt?.status !== "0x1") throw new Error("Transaction failed.");

    setMembership({
      account,
      txHash,
      expectedWei: expectedWei.toString(),
      purchasedAt: nowIso(),
      mode: "fixed_1_pol",
      chainId: POLYGON_CHAIN_ID,
      status: "confirmed",
      confirmedAt: nowIso(),
    });

    el("shopMsg").textContent = "Payment confirmed (1 POL).";
    await refreshMembershipUI();
  } catch (e) {
    el("shopMsg").textContent = e?.message || String(e);
  } finally {
    btnPay.disabled = prevDisabled ? true : !isSignedIn();
  }
};

/* -----------------------
   Init
------------------------ */
(async function init() {
  setupTabs();
  el("receiver").textContent = MERCHANT_ADDRESS;
  setStatus("Disconnected", "off");
  setSessionMsg("");

  // Pre-pick a healthy RPC in background
  pickHealthyPolygonRpc().catch(() => {});

  if (!window.ethereum) {
    setLoggedOutUI();
    return;
  }

  window.ethereum.on("accountsChanged", (accs) => {
    account = accs?.[0] || null;
    if (!account) setLoggedOutUI();
    else refreshWalletUI();
  });

  window.ethereum.on("chainChanged", () => {
    if (account) refreshWalletUI();
  });

  // silent reconnect (no popup)
  const accs = await window.ethereum.request({ method: "eth_accounts" });
  account = accs?.[0] || null;
  if (account) await refreshWalletUI();
  else setLoggedOutUI();
})();
