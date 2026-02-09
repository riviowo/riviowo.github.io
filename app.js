/* app.js
   =========================
   EryVanta — Fixed 0.1 POL (NORMAL)
   - ONLY sends {from,to,value}
   - NO gas/fee/nonce overrides
   - Plan UI + 30-day countdown + withdraw request
   ========================= */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const APP_NAME = "EryVanta";
  const POLYGON_CHAIN_ID = "0x89"; // 137
  const MERCHANT_ADDRESS = "0x03a6BC48ED8733Cc700AE49657931243f078a994";

  // ✅ EXACT 0.1 POL in wei
  const PAY_WEI = 100000000000000000n; // 1e17
  const PAY_WEI_HEX = "0x16345785d8a0000"; // 0.1 * 1e18

  // Plan config
  const PLAN_NAME_FA = "پلن 0.1 پالیگانی فعال";
  const PLAN_DAYS = 30;
  const PLAN_MS = PLAN_DAYS * 24 * 60 * 60 * 1000;

  // Withdrawal config (نمایشی)
  const WITHDRAW_PAYOUT_POL = "1.1";
  // اگر بک‌اند/وبهوک داری اینجا بذار:
  const WITHDRAW_WEBHOOK_URL = ""; // مثال: "https://your-domain.com/api/withdraw"

  // RPC candidates (reads/verify only)
  const POLYGON_RPC_CANDIDATES = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://rpc.ankr.com/polygon",
    "https://1rpc.io/matic",
    "https://polygon.drpc.org",
    "https://polygon-rpc.com",
    "https://polygon-public.nodies.app",
  ];

  // State
  let account = null;
  let lastQuote = null;
  let activeRpc = null;
  let activateTab = () => {};
  let planTimerId = null;
  let RING_C = null;

  // Elements (set on init)
  let btnConnect, btnFixRpc, btnLogout, btnQuote, btnPay, btnWithdraw, btnCopyWithdraw;

  /* ---------- Helpers ---------- */
  function setStatus(text, onOff) {
    const statusEl = $("status");
    const dot = $("dot");
    if (statusEl) statusEl.textContent = text || "";
    if (dot) {
      dot.classList.remove("on", "off");
      if (onOff === "on") dot.classList.add("on");
      if (onOff === "off") dot.classList.add("off");
    }
  }

  function setSessionMsg(msg = "") {
    const node = $("sessionMsg");
    if (node) node.textContent = msg;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function formatPolFromWeiHex(weiHex) {
    const wei = BigInt(weiHex);
    const base = 10n ** 18n;
    const whole = wei / base;
    const frac = (wei % base).toString().padStart(18, "0").slice(0, 6);
    return `${whole}.${frac}`;
  }

  function isUserRejected(err) {
    return err?.code === 4001;
  }
  function isPendingRequest(err) {
    return err?.code === -32002;
  }

  /* ---------- Provider (MetaMask) ---------- */
  async function requireProvider() {
    if (!window.ethereum) throw new Error("MetaMask نصب نیست.");
    return window.ethereum;
  }

  async function getChainIdWallet() {
    const provider = await requireProvider();
    return provider.request({ method: "eth_chainId" });
  }

  /* ---------- RPC failover (reads only) ---------- */
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
      if (Date.now() - x.ts > 30 * 60 * 1000) return null; // 30min
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
      } catch {}
    }
    throw new Error("هیچ RPC سالمی برای Polygon پیدا نشد.");
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
      } catch {}
    }
    throw new Error("Polygon RPC روی همه endpoint ها fail شد.");
  }

  /* ---------- Network switching (Polygon) ---------- */
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
        let bestRpc = POLYGON_RPC_CANDIDATES[0];
        try {
          bestRpc = await pickHealthyPolygonRpc();
        } catch {}
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

  async function fixMetamaskPolygonRpc() {
    const provider = await requireProvider();
    let bestRpc = POLYGON_RPC_CANDIDATES[0];
    try {
      bestRpc = await pickHealthyPolygonRpc();
    } catch {}
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
  }

  /* ---------- Storage ---------- */
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
    return Boolean(s && s.account && s.sig && s.message && account && s.account.toLowerCase() === account.toLowerCase());
  }

  /* ---------- Tabs ---------- */
  function setupTabs() {
    const tabs = Array.from(document.querySelectorAll(".tab"));
    const views = { home: $("view-home"), shop: $("view-shop"), account: $("view-account") };

    function activate(name) {
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
      Object.entries(views).forEach(([k, v]) => v && v.classList.toggle("active", k === name));
      if (name === "shop") refreshQuote();
      if (name === "account") refreshMembershipUI();
    }

    activateTab = activate;
    tabs.forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab)));
  }

  /* ---------- Wallet UI ---------- */
  function setLoggedOutUI() {
    setStatus("Disconnected", "off");
    setSessionMsg("");
    if ($("addr")) $("addr").textContent = "-";
    if ($("chain")) $("chain").textContent = "-";
    if ($("bal")) $("bal").textContent = "-";
    if (btnLogout) btnLogout.disabled = true;
    if (btnPay) btnPay.disabled = true;
  }

  async function refreshWalletUI() {
    if (!account) return;

    if ($("addr")) $("addr").textContent = account;
    if (btnLogout) btnLogout.disabled = false;

    try {
      if ($("chain")) $("chain").textContent = await getChainIdWallet();
    } catch {
      if ($("chain")) $("chain").textContent = "?";
    }

    try {
      const balHex = await window.ethereum.request({ method: "eth_getBalance", params: [account, "latest"] });
      if ($("bal")) $("bal").textContent = formatPolFromWeiHex(balHex);
    } catch {
      try {
        await pickHealthyPolygonRpc();
        const balHex = await rpcRequestPolygon("eth_getBalance", [account, "latest"]);
        if ($("bal")) $("bal").textContent = formatPolFromWeiHex(balHex);
        setSessionMsg("اگر MetaMask کند/قفل شد، Fix Polygon RPC را بزن و در MetaMask تایید کن.");
      } catch {
        if ($("bal")) $("bal").textContent = "?";
      }
    }

    setStatus("Connected", "on");
    await refreshMembershipUI().catch(() => {});
  }

  /* ---------- Quote ---------- */
  async function refreshQuote() {
    if ($("shopMsg")) $("shopMsg").textContent = "";
    if ($("receiver")) $("receiver").textContent = MERCHANT_ADDRESS;

    lastQuote = { wei: PAY_WEI.toString(), updatedAt: Math.floor(Date.now() / 1000), mode: "fixed_0_1_pol" };

    if ($("price")) $("price").textContent = "Fixed 0.1 POL";
    if ($("amountPol")) $("amountPol").textContent = "0.100000 POL";
    if ($("updatedAt")) $("updatedAt").textContent = "now";

    if (btnPay) btnPay.disabled = !isSignedIn();
  }

  /* ---------- Tx verify helpers ---------- */
  async function waitForReceipt(txHash, timeoutMs = 300000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // try wallet rpc
      try {
        const r = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] });
        if (r) return r;
      } catch {}

      // fallback to our rpc list
      try {
        await pickHealthyPolygonRpc();
        const r2 = await rpcRequestPolygon("eth_getTransactionReceipt", [txHash]);
        if (r2) return r2;
      } catch {}

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

  /* ---------- Plan UI (countdown + ring) ---------- */
  function stopPlanTicker() {
    if (planTimerId) clearInterval(planTimerId);
    planTimerId = null;
  }

  function formatDHMS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  function setupRing() {
    const ring = $("ringFg");
    if (!ring) return null;
    const r = 18;
    const C = 2 * Math.PI * r;
    ring.style.strokeDasharray = `${C} ${C}`;
    ring.style.strokeDashoffset = "0";
    return C;
  }

  function setRingProgress(pct01) {
    if (!RING_C) return;
    const ring = $("ringFg");
    if (!ring) return;
    const clamped = Math.max(0, Math.min(1, pct01));
    const offset = RING_C * (1 - clamped);
    ring.style.strokeDashoffset = String(offset);
    if ($("ringPct")) $("ringPct").textContent = `${Math.round(clamped * 100)}%`;
  }

  function showPlanCard({ txHash, startAtMs, endAtMs, status, subText }) {
    const planCard = $("planCard");
    if (!planCard) return;
    planCard.classList.add("active");

    if ($("planTitle")) $("planTitle").textContent = PLAN_NAME_FA;
    if ($("planTx")) $("planTx").textContent = txHash || "-";
    if ($("planExpire")) $("planExpire").textContent = new Date(endAtMs).toISOString();
    if ($("planSub") && subText) $("planSub").textContent = subText;

    const badge = $("planBadge");
    if (badge) {
      if (status === "active") {
        badge.textContent = "ACTIVE";
        badge.style.background = "rgba(168,85,247,.16)";
      } else if (status === "expired") {
        badge.textContent = "EXPIRED";
        badge.style.background = "rgba(239,68,68,.14)";
      } else {
        badge.textContent = "PENDING";
        badge.style.background = "rgba(255,255,255,.10)";
      }
    }

    stopPlanTicker();
    planTimerId = setInterval(() => {
      const now = Date.now();
      const remaining = endAtMs - now;

      const days = Math.max(0, Math.ceil(remaining / 86400000));
      if ($("daysLeft")) $("daysLeft").textContent = String(days);
      if ($("fineTime")) $("fineTime").textContent = formatDHMS(remaining);

      const pct = remaining <= 0 ? 0 : remaining / PLAN_MS;
      setRingProgress(pct);

      const w = $("withdrawBox");
      if (w) w.classList.toggle("show", remaining <= 0);
    }, 1000);

    // immediate render
    const remaining0 = endAtMs - Date.now();
    if ($("daysLeft")) $("daysLeft").textContent = String(Math.max(0, Math.ceil(remaining0 / 86400000)));
    if ($("fineTime")) $("fineTime").textContent = formatDHMS(remaining0);
    setRingProgress(remaining0 <= 0 ? 0 : remaining0 / PLAN_MS);
    const w0 = $("withdrawBox");
    if (w0) w0.classList.toggle("show", remaining0 <= 0);
  }

  function hidePlanCard() {
    const planCard = $("planCard");
    if (planCard) planCard.classList.remove("active");
    stopPlanTicker();
  }

  /* ---------- Membership UI ---------- */
  async function refreshMembershipUI() {
    const m = getMembership();

    if (!m || !account) {
      if ($("mStatus")) $("mStatus").textContent = "Inactive";
      if ($("mTx")) $("mTx").textContent = "-";
      if ($("mVerified")) $("mVerified").textContent = "-";
      hidePlanCard();
      return;
    }

    if ($("mTx")) $("mTx").textContent = m.txHash || "-";

    if (m.account?.toLowerCase() !== account.toLowerCase()) {
      if ($("mStatus")) $("mStatus").textContent = "Inactive";
      if ($("mVerified")) $("mVerified").textContent = "No (different wallet)";
      hidePlanCard();
      return;
    }

    // timings from storage (always available)
    const startAtMs =
      m.planStartAt ? new Date(m.planStartAt).getTime() : m.confirmedAt ? new Date(m.confirmedAt).getTime() : Date.now();
    const endAtMs = m.planEndAt ? new Date(m.planEndAt).getTime() : startAtMs + PLAN_MS;
    const isExpired = Date.now() >= endAtMs;

    try {
      const v = await verifyTx(m.txHash, m.expectedWei);

      if ($("mStatus")) $("mStatus").textContent = v.ok ? "Active" : "Inactive";
      if ($("mVerified")) $("mVerified").textContent = v.ok ? "Yes" : `No (${v.reason})`;

      if (v.ok) {
        showPlanCard({
          txHash: m.txHash,
          startAtMs,
          endAtMs,
          status: isExpired ? "expired" : "active",
          subText: "پلن ماهانه — پرداخت تایید شد",
        });
      } else {
        // اگر verify شکست خورد، باز هم می‌تونیم UI رو pending نگه داریم
        showPlanCard({
          txHash: m.txHash,
          startAtMs,
          endAtMs,
          status: isExpired ? "expired" : "pending",
          subText: "پلن ماهانه — در انتظار تایید شبکه",
        });
      }
    } catch (e) {
      // ✅ مهم: حتی اگر RPC مشکل داشت، پلن را از روی localStorage نشان بده
      if ($("mStatus")) $("mStatus").textContent = "Active";
      if ($("mVerified")) $("mVerified").textContent = e?.message || String(e);

      showPlanCard({
        txHash: m.txHash,
        startAtMs,
        endAtMs,
        status: isExpired ? "expired" : "active",
        subText: "پلن ماهانه — تایید محلی (RPC مشکل دارد)",
      });
    }
  }

  /* ---------- Connect + Sign ---------- */
  async function connectWallet() {
    await requireProvider();
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = accounts?.[0] || null;
    if (!account) throw new Error("هیچ اکانتی انتخاب نشد.");
    await refreshWalletUI();
  }

  async function signIn() {
    const provider = await requireProvider();
    const message = [`Sign in to ${APP_NAME}`, `Address: ${account}`, `Time: ${nowIso()}`].join("\n");
    const sig = await provider.request({ method: "personal_sign", params: [message, account] });
    setSession({ account, sig, message });
  }

  /* ---------- Withdraw request ---------- */
  async function buildWithdrawPayload() {
    const m = getMembership();
    if (!m) throw new Error("No membership.");

    const payload = {
      type: "withdraw_request",
      app: APP_NAME,
      chainId: POLYGON_CHAIN_ID,
      account,
      merchant: MERCHANT_ADDRESS,
      txHash: m.txHash,
      plan: { name: PLAN_NAME_FA, days: PLAN_DAYS, paidWei: String(m.expectedWei || PAY_WEI) },
      payout: { amountPol: WITHDRAW_PAYOUT_POL },
      requestedAt: nowIso(),
      nonce: Math.floor(Math.random() * 1e9),
    };

    const provider = await requireProvider();
    const message = [
      `Withdraw request — ${APP_NAME}`,
      `Account: ${payload.account}`,
      `TxHash: ${payload.txHash}`,
      `Payout: ${payload.payout.amountPol} POL`,
      `Time: ${payload.requestedAt}`,
      `Nonce: ${payload.nonce}`,
    ].join("\n");

    const sig = await provider.request({ method: "personal_sign", params: [message, account] });
    payload.signature = sig;
    payload.signedMessage = message;
    return payload;
  }

  async function sendWithdrawRequest(payload) {
    if (WITHDRAW_WEBHOOK_URL && WITHDRAW_WEBHOOK_URL.startsWith("http")) {
      const res = await fetch(WITHDRAW_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Webhook error: HTTP ${res.status}`);
      return "درخواست برای شما ارسال شد (Webhook).";
    }

    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
    return "Webhook تنظیم نشده. درخواست کپی شد (Copy Request).";
  }

  /* ---------- Handlers ---------- */
  function wireHandlers() {
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
        await fixMetamaskPolygonRpc();
        setSessionMsg("در MetaMask درخواست آپدیت Polygon ارسال شد. Approve کن و دوباره تست کن.");
      } catch (e) {
        setSessionMsg(e?.message || String(e));
      }
    };

    btnLogout.onclick = () => {
      clearSession();
      if (btnPay) btnPay.disabled = true;
      const shopMsg = $("shopMsg");
      if (shopMsg) shopMsg.textContent = "Signed out.";
      setLoggedOutUI();
      hidePlanCard();
    };

    btnQuote.onclick = async () => {
      await refreshQuote();
    };

    btnPay.onclick = async () => {
      try {
        const shopMsg = $("shopMsg");
        if (shopMsg) shopMsg.textContent = "";

        if (!account) throw new Error("اول کیف پول را وصل کن.");
        if (!isSignedIn()) throw new Error("اول Sign in (signature) انجام بده.");

        await switchToPolygon();
        await refreshQuote();

        // NORMAL tx: ONLY from/to/value
        const hintTimer = setTimeout(() => {
          const shopMsg2 = $("shopMsg");
          if (shopMsg2) {
            shopMsg2.textContent =
              "اگر پنجره MetaMask باز نشد، خود MetaMask را باز کن (ممکن است یک درخواست Pending داشته باشی).";
          }
        }, 12000);

        if (shopMsg) shopMsg.textContent = "Confirm in MetaMask...";
        let txHash;

        try {
          txHash = await window.ethereum.request({
            method: "eth_sendTransaction",
            params: [{ from: account, to: MERCHANT_ADDRESS, value: PAY_WEI_HEX }],
          });
        } catch (err) {
          if (isUserRejected(err)) throw new Error("Transaction rejected in wallet.");
          if (isPendingRequest(err))
            throw new Error("یک درخواست MetaMask باز است. MetaMask را باز کن و درخواست قبلی را کامل کن.");
          throw err;
        } finally {
          clearTimeout(hintTimer);
        }

        if (shopMsg) shopMsg.textContent = "Submitted. Waiting for confirmation...";
        const receipt = await waitForReceipt(txHash);
        if (receipt?.status !== "0x1") throw new Error("Transaction failed.");

        const startAt = new Date().toISOString();
        const endAt = new Date(Date.now() + PLAN_MS).toISOString();

        setMembership({
          account,
          txHash,
          expectedWei: PAY_WEI.toString(),
          purchasedAt: nowIso(),
          confirmedAt: nowIso(),
          planStartAt: startAt,
          planEndAt: endAt,
          mode: "fixed_0_1_pol_monthly",
          chainId: POLYGON_CHAIN_ID,
          status: "confirmed",
          withdraw: null,
        });

        // ✅ SHOW PLAN IMMEDIATELY (بدون منتظر شدن verify)
        showPlanCard({
          txHash,
          startAtMs: new Date(startAt).getTime(),
          endAtMs: new Date(endAt).getTime(),
          status: "active",
          subText: "پلن ماهانه — پرداخت تایید شد",
        });

        if (shopMsg) shopMsg.textContent = "Payment confirmed (0.1 POL).";
        activateTab("account");
        await refreshMembershipUI();
      } catch (e) {
        const shopMsg = $("shopMsg");
        if (shopMsg) shopMsg.textContent = e?.message || String(e);
      }
    };

    // Withdraw buttons ممکنه بعضی وقتا تو HTML نباشن
    if (btnWithdraw) {
      btnWithdraw.onclick = async () => {
        try {
          const withdrawMsg = $("withdrawMsg");
          if (withdrawMsg) withdrawMsg.textContent = "";

          const m = getMembership();
          if (!m?.planEndAt) throw new Error("Plan info missing.");
          if (Date.now() < new Date(m.planEndAt).getTime()) throw new Error("هنوز ۳۰ روز کامل نشده.");

          if (m.withdraw?.requestedAt) {
            if (withdrawMsg) withdrawMsg.textContent = "این درخواست قبلاً ثبت شده.";
            return;
          }

          const payload = await buildWithdrawPayload();
          const msg = await sendWithdrawRequest(payload);

          m.withdraw = { requestedAt: payload.requestedAt, payload };
          setMembership(m);

          if (withdrawMsg) withdrawMsg.textContent = msg;
          btnWithdraw.disabled = true;
        } catch (e) {
          const withdrawMsg = $("withdrawMsg");
          if (withdrawMsg) withdrawMsg.textContent = e?.message || String(e);
        }
      };
    }

    if (btnCopyWithdraw) {
      btnCopyWithdraw.onclick = async () => {
        try {
          const withdrawMsg = $("withdrawMsg");
          const m = getMembership();
          const payload = m?.withdraw?.payload || (await buildWithdrawPayload());
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          if (withdrawMsg) withdrawMsg.textContent = "Request copied.";
        } catch (e) {
          const withdrawMsg = $("withdrawMsg");
          if (withdrawMsg) withdrawMsg.textContent = e?.message || String(e);
        }
      };
    }
  }

  /* ---------- Init ---------- */
  async function init() {
    // element refs
    btnConnect = $("btnConnect");
    btnFixRpc = $("btnFixRpc");
    btnLogout = $("btnLogout");
    btnQuote = $("btnQuote");
    btnPay = $("btnPay");
    btnWithdraw = $("btnWithdraw");
    btnCopyWithdraw = $("btnCopyWithdraw");

    // basic guard
    if (!btnConnect || !btnPay) return;

    setupTabs();

    if ($("receiver")) $("receiver").textContent = MERCHANT_ADDRESS;
    if ($("merchantCfg")) $("merchantCfg").textContent = MERCHANT_ADDRESS;

    setStatus("Disconnected", "off");
    setSessionMsg("");

    // setup ring after DOM exists
    RING_C = setupRing();

    if (!window.ethereum) {
      setLoggedOutUI();
      return;
    }

    wireHandlers();

    window.ethereum.on("accountsChanged", (accs) => {
      account = accs?.[0] || null;
      if (!account) setLoggedOutUI();
      else refreshWalletUI();
    });

    window.ethereum.on("chainChanged", () => {
      if (account) refreshWalletUI();
    });

    // silent reconnect
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    account = accs?.[0] || null;
    if (account) await refreshWalletUI();
    else setLoggedOutUI();

    // preload quote
    refreshQuote().catch(() => {});
  }

  window.addEventListener("DOMContentLoaded", init);
})();
