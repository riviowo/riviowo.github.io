const el = (id) => document.getElementById(id);

const APP_NAME = "EryVanta";
const POLYGON_CHAIN_ID = "0x89"; // 137

// Receiver
const MERCHANT_ADDRESS = "0x03a6BC48ED8733Cc700AE49657931243f078a994";

// TEST MODE: fixed 1 POL payment (native token on Polygon)
const FIXED_PAY_WEI = 1n * (10n ** 18n); // 1 * 1e18 wei

// Polygon RPC candidates (HTTPS)
const POLYGON_RPC_CANDIDATES = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
  "https://polygon-public.nodies.app",
];

const btnConnect = el("btnConnect");
const btnFixRpc = el("btnFixRpc"); // optional
const btnLogout = el("btnLogout");
const btnQuote = el("btnQuote");
const btnPay = el("btnPay");

let account = null;
let lastQuote = null;
let activeRpc = null;
let activateTab = () => {};

/* -----------------------
   UI helpers
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function isUserRejected(err) {
  return err?.code === 4001;
}

function isPendingRequest(err) {
  return err?.code === -32002;
}

/* -----------------------
   RPC auto-failover (only for reads/verify)
------------------------ */
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
    if (Date.now() - x.ts > 30 * 60 * 1000) return null; // 30 min
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
      // next
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
   Network switching (Polygon)
   "Normal websites" style: only switch/add when needed
------------------------ */
async function switchToPolygon() {
  const provider = await requireProvider();
  const current = await getChainIdWallet().catch(() => null);
  if (current && String(current).toLowerCase() === POLYGON_CHAIN_ID) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID }],
    });
  } catch (err) {
    // If Polygon not added in wallet
    if (err && err.code === 4902) {
      // pick best rpc (for config only)
      let bestRpc = POLYGON_RPC_CANDIDATES[0];
      try {
        bestRpc = await pickHealthyPolygonRpc();
      } catch {
        // ignore, keep default
      }
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: POLYGON_CHAIN_ID,
            chainName: "Polygon Mainnet",
            rpcUrls: [bestRpc, ...POLYGON_RPC_CANDIDATES.filter((x) => x !== bestRpc)],
            // Keep MetaMask-compatible symbol (display only)
            nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
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
   OPTIONAL: Fix RPC in MetaMask (manual button)
------------------------ */
async function fixMetamaskPolygonRpc() {
  const provider = await requireProvider();
  let bestRpc = POLYGON_RPC_CANDIDATES[0];
  try {
    bestRpc = await pickHealthyPolygonRpc();
  } catch {
    // ignore
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: POLYGON_CHAIN_ID,
        chainName: "Polygon Mainnet",
        rpcUrls: [bestRpc, ...POLYGON_RPC_CANDIDATES.filter((x) => x !== bestRpc)],
        nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
        blockExplorerUrls: ["https://polygonscan.com/"],
      },
    ],
  });
}

/* -----------------------
   Membership local storage
------------------------ */
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

function clearMembership() {
  localStorage.removeItem("eryvanta_membership");
}

/* -----------------------
   UI state
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

function setLoggedInUI() {
  btnLogout.disabled = false;
  btnPay.disabled = false;
}

async function refreshWalletUI() {
  if (!account) return;

  el("addr").textContent = account;
  setLoggedInUI();

  // chain id
  try {
    el("chain").textContent = await getChainIdWallet();
  } catch {
    el("chain").textContent = "?";
  }

  // balance (normal: wallet RPC)
  try {
    const balHex = await window.ethereum.request({
      method: "eth_getBalance",
      params: [account, "latest"],
    });
    el("bal").textContent = formatEthFromWeiHex(balHex);
  } catch {
    // fallback to our RPC (only for display)
    try {
      await pickHealthyPolygonRpc();
      const balHex = await rpcRequestPolygon("eth_getBalance", [account, "latest"]);
      el("bal").textContent = formatEthFromWeiHex(balHex);
      setSessionMsg("اگر پرداخت قفل می‌کند، روی Fix Polygon RPC بزن تا RPC متامسک آپدیت شود.");
    } catch {
      el("bal").textContent = "?";
    }
  }

  setStatus("Connected", "on");
  await refreshMembershipUI().catch(() => {});
}

/* -----------------------
   Quote (fixed 1 POL)
------------------------ */
async function refreshQuote() {
  el("shopMsg").textContent = "";
  el("receiver").textContent = MERCHANT_ADDRESS;

  lastQuote = {
    wei: FIXED_PAY_WEI.toString(),
    mode: "fixed_pol",
    updatedAt: Math.floor(Date.now() / 1000),
  };

  el("price").textContent = "Fixed (1 POL)";
  el("amountPol").textContent = "1.000000 POL";
  el("updatedAt").textContent = "now";

  btnPay.disabled = !account;
}

/* -----------------------
   Tx wait + verify (via our RPC failover)
------------------------ */
async function waitForReceipt(txHash, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let r = null;

    // try wallet first
    try {
      r = await window.ethereum.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
    } catch {
      r = null;
    }
    if (r) return r;

    // fallback to our RPC failover
    try {
      await pickHealthyPolygonRpc();
      r = await rpcRequestPolygon("eth_getTransactionReceipt", [txHash]);
      if (r) return r;
    } catch {
      // ignore
    }

    await sleep(2000);
  }
  throw new Error("Timed out waiting for confirmation.");
}

async function verifyTx(txHash, expectedWeiStr) {
  await pickHealthyPolygonRpc();
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
   Connect (normal)
------------------------ */
async function connectWallet() {
  await requireProvider();
  let accounts;
  try {
    accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
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

/* -----------------------
   Payment (NORMAL like most sites)
   - NO manual fee/gas/nonce
   - Just {from,to,value}
------------------------ */
async function sendPaymentNormal() {
  if (!account) throw new Error("Connect wallet first.");

  // Make sure we are on Polygon (wallet handles UX)
  await switchToPolygon();

  // Ensure quote exists
  await refreshQuote();
  const expectedWei = FIXED_PAY_WEI;

  // Show helpful message if MetaMask popup seems stuck (but don't cancel)
  let hintTimer = setTimeout(() => {
    el("shopMsg").textContent =
      "اگر پنجره MetaMask باز نشد، خودِ MetaMask را باز کن (ممکن است یک درخواست Pending داشته باشی).";
  }, 12000);

  let txHash;
  try {
    el("shopMsg").textContent = "Confirm in MetaMask...";
    txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: account,
          to: MERCHANT_ADDRESS,
          value: toHex(expectedWei),
          // IMPORTANT: no gas/gasPrice/maxFee/maxPriority/nonce => MetaMask chooses best
        },
      ],
    });
  } catch (err) {
    if (isUserRejected(err)) throw new Error("Transaction rejected in wallet.");
    if (isPendingRequest(err)) {
      throw new Error("یک درخواست متامسک باز است. MetaMask را باز کن و درخواست قبلی را کامل کن.");
    }
    throw err;
  } finally {
    clearTimeout(hintTimer);
  }

  // Save immediately so UI doesn't feel stuck
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

  const receipt = await waitForReceipt(txHash);
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
}

/* -----------------------
   Button handlers
------------------------ */
btnConnect.onclick = async () => {
  try {
    setSessionMsg("");
    await connectWallet();
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
      await fixMetamaskPolygonRpc();
      setSessionMsg("در MetaMask درخواست آپدیت Polygon ارسال شد. Approve کن و دوباره تست کن.");
    } catch (e) {
      setSessionMsg(e?.message || String(e));
    }
  };
}

btnLogout.onclick = () => {
  account = null;
  clearMembership();
  btnPay.disabled = true;
  el("shopMsg").textContent = "Disconnected.";
  setLoggedOutUI();
};

btnQuote.onclick = async () => {
  await refreshQuote();
};

btnPay.onclick = async () => {
  const oldDisabled = btnPay.disabled;
  btnPay.disabled = true;

  try {
    el("shopMsg").textContent = "";
    await sendPaymentNormal();
  } catch (e) {
    el("shopMsg").textContent = e?.message || String(e);
  } finally {
    btnPay.disabled = oldDisabled ? true : !account;
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
