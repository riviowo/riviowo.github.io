const el = (id) => document.getElementById(id);

const APP_NAME = "EryVanta";
const POLYGON_CHAIN_ID = "0x89";

// Your receiving address
const MERCHANT_ADDRESS = "0x03a6BC48ED8733Cc700AE49657931243f078a994";

// Chainlink MATIC/USD feed on Polygon (used here as USD per native token context)
const CHAINLINK_POL_USD_FEED = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";

// $1.00
const PRICE_USD_CENTS = 100;

// Function selectors
const SEL_DECIMALS = "0x313ce567";
const SEL_LATEST_ROUND_DATA = "0xfeaf968c";

// ChainList-style RPC candidates (HTTPS)
const POLYGON_RPC_CANDIDATES = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
];

const btnConnect = el("btnConnect");
const btnFixRpc = el("btnFixRpc");
const btnLogout = el("btnLogout");
const btnQuote = el("btnQuote");
const btnPay = el("btnPay");

let account = null;
let lastQuote = null;
let activeRpc = null;
let activateTab = () => {};

function setStatus(text, onOff) {
  el("status").textContent = text;
  const dot = el("dot");
  dot.classList.remove("on", "off");
  if (onOff === "on") dot.classList.add("on");
  if (onOff === "off") dot.classList.add("off");
}

function setSessionMsg(msg = "") {
  el("sessionMsg").textContent = msg;
}

function toHex(bigint) {
  return "0x" + bigint.toString(16);
}

function readWord(hex, wordIndex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const start = wordIndex * 64;
  return "0x" + clean.slice(start, start + 64);
}

function uintFromWord(wordHex) {
  return BigInt(wordHex);
}

function intFromWord(wordHex) {
  const x = BigInt(wordHex);
  const two256 = 1n << 256n;
  const two255 = 1n << 255n;
  return x >= two255 ? x - two256 : x;
}

function formatEthFromWeiHex(weiHex) {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

function formatPolFromWei(wei) {
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac} POL`;
}

function nowIso() {
  return new Date().toISOString();
}

async function requireProvider() {
  if (!window.ethereum) throw new Error("MetaMask is not installed.");
  return window.ethereum;
}

/* -----------------------
   RPC auto-failover layer
------------------------ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcFetch(url, method, params = [], timeoutMs = 6000) {
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
  const start = performance.now();
  const chainId = await rpcFetch(url, "eth_chainId", []);
  if (String(chainId).toLowerCase() !== POLYGON_CHAIN_ID) throw new Error("Wrong chainId");
  await rpcFetch(url, "eth_blockNumber", []);
  const ms = performance.now() - start;
  return ms;
}

function getCachedRpc() {
  try {
    const x = JSON.parse(localStorage.getItem("eryvanta_polygon_rpc") || "null");
    if (!x || !x.url || !x.ts) return null;
    // re-check every 30 minutes
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

  let best = null;
  for (const url of POLYGON_RPC_CANDIDATES) {
    try {
      const ms = await isHealthyPolygonRpc(url);
      if (!best || ms < best.ms) best = { url, ms };
    } catch {
      // ignore and continue
    }
  }

  if (!best) throw new Error("No healthy Polygon RPC found. Try again later.");
  activeRpc = best.url;
  cacheRpc(activeRpc);
  return activeRpc;
}

async function rpcRequestPolygon(method, params = []) {
  // Ensure we have an RPC
  if (!activeRpc) await pickHealthyPolygonRpc();

  // Try active first, then fall back to others
  const tried = new Set();
  const candidates = [activeRpc, ...POLYGON_RPC_CANDIDATES.filter((u) => u !== activeRpc)];

  for (const url of candidates) {
    if (tried.has(url)) continue;
    tried.add(url);
    try {
      const out = await rpcFetch(url, method, params, 7000);
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
   Wallet + network helpers
------------------------ */

async function getChainIdWallet() {
  const provider = await requireProvider();
  return provider.request({ method: "eth_chainId" });
}

async function switchToPolygon() {
  const provider = await requireProvider();
  const current = await getChainIdWallet().catch(() => null);
  if (current && String(current).toLowerCase() === POLYGON_CHAIN_ID) return;

  // pick best RPC and propose it first
  const bestRpc = await pickHealthyPolygonRpc();

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID }],
    });
  } catch (err) {
    // If Polygon is not added, add it with multiple RPCs (ChainList style)
    if (err && err.code === 4902) {
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

function setLoggedOutUI() {
  setStatus("Disconnected", "off");
  setSessionMsg("");
  el("addr").textContent = "-";
  el("chain").textContent = "-";
  el("bal").textContent = "-";
  btnLogout.disabled = true;
  btnPay.disabled = true;
}

function getSession() {
  try { return JSON.parse(localStorage.getItem("eryvanta_session") || "null"); }
  catch { return null; }
}
function setSession(s) { localStorage.setItem("eryvanta_session", JSON.stringify(s)); }
function clearSession() { localStorage.removeItem("eryvanta_session"); }

function getMembership() {
  try { return JSON.parse(localStorage.getItem("eryvanta_membership") || "null"); }
  catch { return null; }
}
function setMembership(m) { localStorage.setItem("eryvanta_membership", JSON.stringify(m)); }

function isSignedIn() {
  const s = getSession();
  return Boolean(s && s.account && s.sig && s.message && account && s.account.toLowerCase() === account.toLowerCase());
}

/* -----------------------
   UI refresh
------------------------ */

async function refreshWalletUI() {
  if (!account) return;

  el("addr").textContent = account;
  btnLogout.disabled = false;

  // Prefer wallet for chain id, fallback to RPC
  try {
    const chainId = await getChainIdWallet();
    el("chain").textContent = chainId;
  } catch {
    try {
      const chainId = await rpcRequestPolygon("eth_chainId", []);
      el("chain").textContent = chainId;
    } catch {
      el("chain").textContent = "?";
    }
  }

  // Prefer wallet for balance, fallback to RPC
  try {
    const balHex = await window.ethereum.request({ method: "eth_getBalance", params: [account, "latest"] });
    el("bal").textContent = formatEthFromWeiHex(balHex);
  } catch (e) {
    // Wallet RPC likely failing; show hint + use our RPC for display
    setSessionMsg("Your wallet RPC seems unstable. Use “Fix Polygon RPC” or change the Polygon RPC URL in MetaMask.");
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

async function getChainlinkPriceUsdPerPol() {
  // decimals()
  const decHex = await rpcRequestPolygon("eth_call", [{ to: CHAINLINK_POL_USD_FEED, data: SEL_DECIMALS }, "latest"]);
  const decimals = Number(uintFromWord(readWord(decHex, 0)));

  // latestRoundData()
  const roundHex = await rpcRequestPolygon("eth_call", [{ to: CHAINLINK_POL_USD_FEED, data: SEL_LATEST_ROUND_DATA }, "latest"]);
  const answer = intFromWord(readWord(roundHex, 1));
  const updatedAt = Number(uintFromWord(readWord(roundHex, 3)));

  if (answer <= 0n) throw new Error("Invalid price feed answer.");
  if (!updatedAt) throw new Error("Price feed has no updatedAt.");
  return { answer, decimals, updatedAt };
}

function computeWeiForUsdCents(usdCents, priceAnswer, priceDecimals) {
  const dec = 10n ** BigInt(priceDecimals);
  const numerator = BigInt(usdCents) * dec * (10n ** 18n);
  const denom = 100n * BigInt(priceAnswer);
  return (numerator + denom - 1n) / denom; // round up
}

function formatPrice(answer, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = answer / base;
  const frac = (answer % base).toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

function fmtTimeAgo(unixSec) {
  const diffMs = Date.now() - unixSec * 1000;
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  return `${Math.floor(minutes / 60)} hours ago`;
}

async function refreshQuote() {
  el("shopMsg").textContent = "";
  el("receiver").textContent = MERCHANT_ADDRESS;

  try {
    await pickHealthyPolygonRpc();

    const { answer, decimals, updatedAt } = await getChainlinkPriceUsdPerPol();
    const ageMin = Math.floor((Date.now() / 1000 - updatedAt) / 60);
    if (ageMin > 30) throw new Error("Price feed looks stale. Please try again.");

    const wei = computeWeiForUsdCents(PRICE_USD_CENTS, answer, decimals);
    lastQuote = { answer: answer.toString(), decimals, updatedAt, wei: wei.toString() };

    el("price").textContent = `${formatPrice(answer, decimals)} USD`;
    el("amountPol").textContent = formatPolFromWei(wei);
    el("updatedAt").textContent = fmtTimeAgo(updatedAt);

    btnPay.disabled = !isSignedIn();
  } catch (e) {
    btnPay.disabled = true;
    el("price").textContent = "-";
    el("amountPol").textContent = "-";
    el("updatedAt").textContent = "-";
    el("shopMsg").textContent = e?.message || String(e);
  }
}

async function waitForReceipt(txHash, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await rpcRequestPolygon("eth_getTransactionReceipt", [txHash]);
    if (r) return r;
    await sleep(2500);
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
   Tabs + actions
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

async function connectWallet() {
  await requireProvider();
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  account = accounts?.[0] || null;
  if (!account) throw new Error("No account selected.");
  await refreshWalletUI();
}

async function signIn() {
  const provider = await requireProvider();
  const message = [`Sign in to ${APP_NAME}`, `Address: ${account}`, `Time: ${nowIso()}`].join("\n");
  const sig = await provider.request({ method: "personal_sign", params: [message, account] });
  setSession({ account, sig, message });
}

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

btnFixRpc.onclick = async () => {
  try {
    setSessionMsg("");
    const provider = await requireProvider();
    const bestRpc = await pickHealthyPolygonRpc();

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

    setSessionMsg("Requested Polygon network update in MetaMask. If prompted, approve it, then retry.");
  } catch (e) {
    setSessionMsg(e?.message || String(e));
  }
};

btnLogout.onclick = () => {
  clearSession();
  btnPay.disabled = true;
  el("shopMsg").textContent = "Signed out.";
};

btnQuote.onclick = async () => {
  await refreshQuote();
};

btnPay.onclick = async () => {
  try {
    el("shopMsg").textContent = "";

    if (!account) throw new Error("Connect wallet first.");
    if (!isSignedIn()) throw new Error("Sign in first (signature).");

    await pickHealthyPolygonRpc();
    await switchToPolygon();

    // refresh quote right before payment
    await refreshQuote();
    if (!lastQuote) throw new Error("Quote not available.");

    const expectedWei = BigInt(lastQuote.wei);

    el("shopMsg").textContent = "Opening MetaMask...";
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: MERCHANT_ADDRESS, value: toHex(expectedWei) }],
    });

    el("shopMsg").textContent = "Waiting for confirmation...";
    await waitForReceipt(txHash);

    setMembership({ account, txHash, expectedWei: expectedWei.toString(), purchasedAt: nowIso() });
    el("shopMsg").textContent = "Payment confirmed.";
    await refreshMembershipUI();
  } catch (e) {
    el("shopMsg").textContent = e?.message || String(e);
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

  // Pre-pick a healthy RPC in background for smoother UX
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
