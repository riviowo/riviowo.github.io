const el = (id) => document.getElementById(id);

const btnConnect = el("btnConnect");
const btnSign = el("btnSign");
const btnCopy = el("btnCopy");

let account = null;

const NETWORKS = {
  "0x1": "Ethereum Mainnet",
  "0xaa36a7": "Sepolia",
  "0x38": "BNB Chain",
  "0x89": "Polygon",
  "0xa": "Optimism",
  "0xa4b1": "Arbitrum One",
  "0x2105": "Base Mainnet",
};

function chainLabel(chainId) {
  return NETWORKS[chainId] ?? "Unknown Network";
}

function formatEthFromWeiHex(weiHex) {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

function setDisconnectedUI() {
  el("status").textContent = "Status: Disconnected";
  el("addr").textContent = "-";
  el("chain").textContent = "-";
  el("chainName").textContent = "-";
  el("bal").textContent = "-";
  el("sig").textContent = "-";
  btnSign.disabled = true;
  btnCopy.disabled = true;
}

async function refresh() {
  if (!window.ethereum || !account) return;

  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  const balanceHex = await window.ethereum.request({
    method: "eth_getBalance",
    params: [account, "latest"],
  });

  el("addr").textContent = account;
  el("chain").textContent = chainId;
  el("chainName").textContent = chainLabel(chainId);
  el("bal").textContent = formatEthFromWeiHex(balanceHex);
  el("status").textContent = "Status: Connected";

  btnSign.disabled = false;
  btnCopy.disabled = false;
}

btnConnect.onclick = async () => {
  try {
    if (!window.ethereum) {
      el("status").textContent = "MetaMask is not installed.";
      return;
    }
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = accounts?.[0] || null;

    if (!account) {
      setDisconnectedUI();
      return;
    }
    await refresh();
  } catch (e) {
    console.error(e);
    el("status").textContent = "Connection failed or was rejected.";
  }
};

btnSign.onclick = async () => {
  try {
    if (!window.ethereum || !account) return;

    const message = `Sign in to EryVanta\nAddress: ${account}\nTime: ${new Date().toISOString()}`;
    const sig = await window.ethereum.request({
      method: "personal_sign",
      params: [message, account],
    });

    // Optional: store locally (not required)
    localStorage.setItem("eryvanta_user", JSON.stringify({ account, sig, message }));

    el("sig").textContent = sig;
  } catch (e) {
    console.error(e);
    el("sig").textContent = "Signing failed or was rejected.";
  }
};

btnCopy.onclick = async () => {
  try {
    if (!account) return;
    await navigator.clipboard.writeText(account);
    const old = btnCopy.textContent;
    btnCopy.textContent = "Copied ✓";
    setTimeout(() => (btnCopy.textContent = old), 1200);
  } catch (e) {
    console.error(e);
    btnCopy.textContent = "Copy failed";
    setTimeout(() => (btnCopy.textContent = "Copy Address"), 1200);
  }
};

// Auto-load connection (works if the site was previously authorized in MetaMask)
(async function autoLoad() {
  try {
    if (!window.ethereum) return;
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    account = accs?.[0] || null;
    if (account) await refresh();
    else setDisconnectedUI();
  } catch (e) {
    console.error(e);
    setDisconnectedUI();
  }
})();

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accs) => {
    account = accs?.[0] || null;
    if (!account) setDisconnectedUI();
    else refresh();
  });

  window.ethereum.on("chainChanged", () => refresh());
} else {
  setDisconnectedUI();
}
