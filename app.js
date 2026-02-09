const el = (id) => document.getElementById(id);

const APP_NAME = "EryVanta";
const POLYGON_CHAIN_ID = "0x89"; // 137

// Receiver (merchant)
const MERCHANT_ADDRESS = "0x03a6BC48ED8733Cc700AE49657931243f078a994";

// ✅ EXACT 1 POL in wei (hard-coded hex so it can NEVER become 1.062 by mistake)
const ONE_POL_WEI_HEX = "0xde0b6b3a7640000"; // 1e18
const ONE_POL_WEI = 1000000000000000000n;

// RPC candidates (only used for: health check, fallback reads, tx verify)
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

function isUserRejected(err) {
  return err?.code === 4001;
}

function isPendingRequest(err) {
  return err?.code === -32002;
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
   RPC failover (reads only)
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
    if (Date.now() - x.ts > 30 * 60 * 1000) return null;
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
   NORMAL like most sites:
   - only switch/add
   - no forced gas/fee/nonce
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
    if (err && err.code === 4902) {
      // chain not added -> add it
      let bestRpc = POLYGON_RPC_CANDIDATES[0];
      try {
        bestRpc = await pickHealthyPolygonRpc();
      } catch {
        // ignore
      }
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: POLYGON_CHAIN_ID,
          chainName: "Polygon Mainnet",
          rpcUrls: [bestRpc, ...POLYGON_RPC_CANDIDATES.filter((x) => x !== bestRpc)],
          nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
          blockExplorerUrls: ["https://polygonscan.com/"],
        }],
      });
    } else {
      throw err;
    }
  }
}

/* -----------------------
   OPTIONAL: Fix Polygon RPC inside MetaMask (manual button)
------------------------ */
async function fixMetamaskPolygonRpc() {
  const provider = await requireProvider();
  let bestRpc = POLYGON_RPC_CANDIDATES[0];
  try { bestRpc = await pickHealthyPolygonRpc(); } catch {}

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: POLYGON_CHAIN_ID,
      chainName: "Polygon Mainnet",
      rpcUrls: [bestRpc, ...POLYGON_RPC_CANDIDATES.filter((x) => x !== bestRpc)],
      nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
      blockExplorerUrls: ["https://polygonscan.com/"],
    }],
  });
}

/* -----------------------
   Membership storage
------------------------ */
function getMembership() {
  try { return JSON.parse(localStorage.getItem("eryvanta_membership") || "null"); }
  catch { return null; }
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

async function refreshWalletUI() {
  if (!account) return;

  el("addr").textContent = account;
  btnLogout.disabled = false;

  // chain id (wallet)
  try {
    el("chain").textContent = await getChainIdWallet();
  } catch {
    el("chain").textContent = "?";
  }

  // balance (wallet, fallback RPC)
  try {
    const balHex = await window.ethereum.request({
      method: "eth_getBalance",
      params: [account, "latest"],
    });
    el("bal").textContent = formatEthFromWeiHex(balHex);
  } catch {
    try {
      await pickHealthyPolygonRpc();
      const balHex = await rpcRequestPolygon("eth_getBalance", [account, "latest"]);
      el("bal").textContent = formatEthFromWeiHex(balHex);
      setSessionMsg("اگر MetaMask کند/قفل شد، روی Fix Polygon RPC بزن و داخل MetaMask تایید کن.");
    } catch {
      el("bal").textContent = "?";
    }
  }

  setStatus("Connected", "on");
  btnPay.disabled = false;

  await refreshMembershipUI().catch(() => {});
}

/* -----------------------
   Quote (fixed 1 POL)
------------------------ */
async function refreshQuote() {
  el("shopMsg").textContent = "";
  el("receiver").textContent = MERCHANT_ADDRESS;

  lastQuote = {
    wei: ONE_POL_WEI.toString(),
    mode: "fixed_1_pol",
    updatedAt: Math.floor(Date.now() / 1000),
  };

  el("price").textContent = "Fixed (1 POL)";
  el("amountPol").textContent = "1.000000 POL";
  el("updatedAt").textContent = "now";

  btnPay.disabled = !account;
}

/* -----------------------
   Receipt wait (wallet first, RPC fallback)
------------------------ */
async function waitForReceipt(txHash, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // wallet
    try {
      const r = await window.ethereum.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
      if (r) return r;
    } catch {}

    // rpc fallback
    try {
      await pickHealthyPolygonRpc();
      const r2 = await rpcRequestPolygon("eth_getTransactionReceipt", [txHash]);
      if (r2) return r2;
    } catch {}

    await sleep(2000);
  }
  throw new Error("Timed out waiting for confirmation.");
}

/* -----------------------
   Verify payment (via RPC)
------------------------ */
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
   Connect
------------------------ */
async function connectWallet() {
  await requireProvider();
  let accounts;
  try {
    accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  } catch (err) {
    if (isPendingRequest(err)) {
      throw new Error("یک درخواست MetaMask باز است. MetaMask را باز کن و درخواست قبلی را کامل کن.");
    }
    throw err;
  }

  account = accounts?.[0] || null;
  if (!account) throw new Error("No account selected.");
  await refreshWalletUI();
}

/* -----------------------
   Pay (NORMAL like every site)
   ✅ No gas, no fees, no nonce, no limit — MetaMask decides everything.
   ✅ Exact value = 1 POL (ONE_POL_WEI_HEX).
------------------------ */
async function sendPaymentNormal() {
  if (!account) throw new Error("Connect wallet first.");

  await switchToPolygon();
  await refreshQuote();

  // Hint if MetaMask UI doesn’t pop immediately
  const hintTimer = setTimeout(() => {
    el("shopMsg").textContent =
      "اگر پنجره MetaMask باز نشد، خود MetaMask را باز کن (ممکن است یک درخواست Pending داشته باشی).";
  }, 12000);

  let txHash;
  try {
    el("shopMsg").textContent = "Confirm in MetaMask...";
    txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{
        from: account,
        to: MERCHANT_ADDRESS,
        value: ONE_POL_WEI_HEX, // ✅ always 1 POL
        // IMPORTANT: nothing else
      }],
    });
  } catch (err) {
    if (isUserRejected(err)) throw new Error("Transaction rejected in wallet.");
    if (isPendingRequest(err)) throw new Error("یک درخواست MetaMask باز است. MetaMask را باز کن و درخواست قبلی را کامل کن.");
    throw err;
  } finally {
    clearTimeout(hintTimer);
  }

  // Save immediately (so UI won’t feel stuck)
  setMembership({
    account,
    txHash,
    expectedWei: ONE_POL_WEI.toString(),
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
    expectedWei: ONE_POL_WEI.toString(),
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
