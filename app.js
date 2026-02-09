const el = (id) => document.getElementById(id);

const APP_NAME = "EryVanta";
const POLYGON_CHAIN_ID = "0x89";

const MERCHANT_ADDRESS = "0x03a6BC48ED8733Cc700AE49657931243f078a994";
const CHAINLINK_POL_USD_FEED = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
const PRICE_USD_CENTS = 100;

const SEL_DECIMALS = "0x313ce567";
const SEL_LATEST_ROUND_DATA = "0xfeaf968c";

const btnConnect = el("btnConnect");
const btnLogout = el("btnLogout");
const btnQuote = el("btnQuote");
const btnPay = el("btnPay");

let account = null;
let lastQuote = null;
let activateTab = () => {};

function setStatus(text, onOff) {
  el("status").textContent = text;
  const dot = el("dot");
  dot.classList.remove("on", "off");
  if (onOff === "on") dot.classList.add("on");
  if (onOff === "off") dot.classList.add("off");
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

async function ethCall(to, data) {
  const provider = await requireProvider();
  return provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
}

async function getChainId() {
  const provider = await requireProvider();
  return provider.request({ method: "eth_chainId" });
}

async function switchToPolygon() {
  const provider = await requireProvider();
  const current = await getChainId();
  if (current === POLYGON_CHAIN_ID) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: POLYGON_CHAIN_ID,
          chainName: "Polygon Mainnet",
          rpcUrls: [
            "https://rpc.ankr.com/polygon",
            "https://polygon-bor-rpc.publicnode.com",
            "https://polygon-rpc.com",
          ],
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

async function refreshWalletUI() {
  if (!window.ethereum || !account) return;

  // show address immediately even if RPC fails
  el("addr").textContent = account;
  setStatus("Connected", "on");
  btnLogout.disabled = false;

  // chainId (may fail if RPC is down)
  try {
    el("chain").textContent = await getChainId();
  } catch (e) {
    el("chain").textContent = "?";
    setStatus(e?.message || String(e), "off");
  }

  // balance (may fail if RPC is down)
  try {
    const balHex = await window.ethereum.request({ method: "eth_getBalance", params: [account, "latest"] });
    el("bal").textContent = formatEthFromWeiHex(balHex);
  } catch (e) {
    el("bal").textContent = "?";
    setStatus(e?.message || String(e), "off");
  }

  try { await refreshMembershipUI(); } catch {}
}

async function getChainlinkPriceUsdPerPol() {
  const decHex = await ethCall(CHAINLINK_POL_USD_FEED, SEL_DECIMALS);
  const decimals = Number(uintFromWord(readWord(decHex, 0)));

  const roundHex = await ethCall(CHAINLINK_POL_USD_FEED, SEL_LATEST_ROUND_DATA);
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
    await switchToPolygon();

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
  const provider = await requireProvider();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error("Timed out waiting for confirmation.");
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
  el("mStatus").textContent = "Unknown";
  el("mVerified").textContent = "Check Account tab after RPC is stable.";
}

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const views = { home: el("view-home"), shop: el("view-shop"), account: el("view-account") };

  function activate(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(views).forEach(([k, v]) => v.classList.toggle("active", k === name));
    if (name === "shop") refreshQuote();
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
    await connectWallet();
    if (!isSignedIn()) await signIn();
    activateTab("shop");
    await refreshQuote();
  } catch (e) {
    setStatus(e?.message || String(e), "off");
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
    if (!account) throw new Error("Connect wallet first.");
    if (!isSignedIn()) throw new Error("Sign in first (signature).");

    await switchToPolygon();
    await refreshQuote();
    if (!lastQuote) throw new Error("Quote not available.");

    const provider = await requireProvider();
    const expectedWei = BigInt(lastQuote.wei);

    el("shopMsg").textContent = "Opening MetaMask...";
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: MERCHANT_ADDRESS, value: toHex(expectedWei) }],
    });

    el("shopMsg").textContent = "Waiting for confirmation...";
    await waitForReceipt(txHash);

    setMembership({ account, txHash, expectedWei: expectedWei.toString(), purchasedAt: nowIso() });
    el("shopMsg").textContent = "Payment confirmed.";
  } catch (e) {
    el("shopMsg").textContent = e?.message || String(e);
  }
};

(async function init() {
  setupTabs();
  el("receiver").textContent = MERCHANT_ADDRESS;
  setStatus("Disconnected", "off");

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
