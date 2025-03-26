/***************************************************
 * index.js
 * Combined solution for heartbeats and reward claims
 * using API v2 (with version, user, claim details, and
 * streak info checks). WebSocket connection removed.
 ***************************************************/

const fs = require("fs");
const axios = require("axios");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { v4: uuidv4 } = require("uuid");

/* ==========================
   1) Disable TLS checks (optional/insecure)
   ========================== */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/* ==========================
   2) Constants, Colors, Logger, and Utils
   ========================== */
const BASE_URL = "https://apitn.openledger.xyz";
const REWARDS_URL = "https://rewardstn.openledger.xyz";
const HEADERS = {
  "Content-Type": "application/json"
};

const colors = {
  info: "\x1b[36m",         // cyan
  green: "\x1b[32m",        // green
  error: "\x1b[31m",        // red
  warning: "\x1b[33m",      // yellow
  reset: "\x1b[0m"
};

const logger = {
  info: (msg) => console.log(msg),
  success: (msg) => console.log(msg),
  warn: (msg) => console.log(msg),
  error: (msg) => console.error(msg)
};

function printDivider() {
  console.log(colors.info + "────────────────────────────────────────" + colors.reset);
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString();
}

/* ==========================
   3) Read account.txt
   Format: ownerAddress:token
   ========================== */
const accountLines = fs.readFileSync("account.txt", "utf8").trim().split(/\s+/);
const tokens = accountLines.map((line, idx) => {
  const parts = line.split(":");
  if (parts.length !== 2) {
    logger.warn(colors.warning + `Skipping malformed line #${idx + 1}: ${line}` + colors.reset);
    return null;
  }
  const [ownerAddress, token] = parts.map((x) => x.trim());
  const workerID = base64Encode(ownerAddress);
  const sessionID = uuidv4();
  return { ownerAddress, token, workerID, sessionID };
}).filter(Boolean);

if (!tokens.length) {
  logger.error(colors.error + 'No valid lines in account.txt (need "ownerAddress:token").' + colors.reset);
  process.exit(1);
}

/* ==========================
   4) Read proxies (one per token)
   ========================== */
let rawProxies = [];
try {
  rawProxies = fs.readFileSync("proxy.txt", "utf8").trim().split(/\s+/);
} catch (err) {
  logger.error(colors.error + `Error reading proxy.txt: ${err.message}` + colors.reset);
  process.exit(1);
}
const proxies = rawProxies.map(sanitizeProxyUrl).filter(Boolean);
if (proxies.length < tokens.length) {
  logger.error(colors.error + "Not enough proxies for number of tokens. Provide more or do round-robin logic." + colors.reset);
  process.exit(1);
}

/* ==========================
   5) GPU + Data Assignments
   src/gpu.json should be an array of GPU names.
   data.json persists assignments.
   ========================== */
const gpuList = JSON.parse(fs.readFileSync("src/gpu.json", "utf8"));
let dataAssignments = {};
try {
  dataAssignments = JSON.parse(fs.readFileSync("data.json", "utf8"));
} catch {
  logger.info(colors.info + "No existing data.json, starting fresh." + colors.reset);
}

function getOrAssignResources(workerID) {
  if (!dataAssignments[workerID]) {
    const randomGPU = gpuList[Math.floor(Math.random() * gpuList.length)];
    const randomStorage = (Math.random() * 500).toFixed(2);
    dataAssignments[workerID] = { gpu: randomGPU, storage: randomStorage };
    try {
      fs.writeFileSync("data.json", JSON.stringify(dataAssignments, null, 2));
    } catch (err) {
      logger.error(colors.error + `Error writing data.json: ${err.message}` + colors.reset);
    }
  }
  return dataAssignments[workerID];
}

/* ==========================
   6) Shared State
   ========================== */
const accountIDs = {};
const useProxy = true;

/* ==========================
   7) Helper Functions
   ========================== */
function base64Encode(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

function sanitizeProxyUrl(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    return "http://" + trimmed;
  }
  return trimmed;
}

function buildProxyAgent(index) {
  const proxyUrl = useProxy ? proxies[index] : null;
  if (!proxyUrl) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
}

async function handleAxios429(fn) {
  let result;
  while (true) {
    try {
      result = await fn();
      return result;
    } catch (err) {
      if (err.response && err.response.status === 429) {
        const wait = randomDelay(30000, 100000);
        logger.warn(colors.warning + `429 received. Waiting ${wait / 1000}s...` + colors.reset);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

/* ==========================
   8) API Utility Functions (v2)
   ========================== */
async function checkAppVersion(token) {
  try {
    const authToken = token.startsWith("Bearer") ? token : `Bearer ${token}`;
    const response = await axios.get(`${BASE_URL}/ext/api/v2/auth/app_version`, {
      params: { platform: "extension" },
      headers: {
        ...HEADERS,
        Authorization: authToken,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "none"
      },
      timeout: 30000,
      family: 4
    });
    logger.info(colors.info + "[VERSION CHECK]" + colors.reset);
    logger.info(`${colors.info}▸ Platform   : ${colors.green}${response.data.platform}${colors.reset}`);
    logger.info(`${colors.info}▸ Version    : ${colors.green}${response.data.version}${colors.reset}`);
    logger.info(`${colors.info}▸ Status     : ${colors.green}${response.data.under_maintenance ? "Under Maintenance" : "Online"}${colors.reset}`);
    printDivider();
    return response.data;
  } catch (error) {
    logger.error(colors.error + `Failed to check app version: ${error.response?.data || error.message}` + colors.reset);
    return null;
  }
}

async function getUserInfo(token) {
  try {
    const authToken = token.startsWith("Bearer") ? token : `Bearer ${token}`;
    const response = await axios.get(`${BASE_URL}/ext/api/v2/users/me`, {
      headers: { ...HEADERS, Authorization: authToken },
      timeout: 30000,
      family: 4
    });
    printDivider();
    logger.info(colors.info + "[USER INFO]" + colors.reset);
    logger.info(`${colors.info}▸ Address    : ${colors.green}${response.data.data.address}${colors.reset}`);
    logger.info(`${colors.info}▸ ID         : ${colors.green}${response.data.data.id}${colors.reset}`);
    logger.info(`${colors.info}▸ Referral   : ${colors.green}${response.data.data.referral_code}${colors.reset}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      logger.error(colors.error + `Failed to get user info: ${error.response.status} - ${JSON.stringify(error.response.data)}` + colors.reset);
    } else if (error.request) {
      logger.error(colors.error + `Failed to get user info: No response received (${error.code}) - Check your network connection` + colors.reset);
    } else {
      logger.error(colors.error + `Failed to get user info: ${error.message}` + colors.reset);
    }
    return null;
  }
}

async function getClaimDetails(token) {
  try {
    const authToken = token.startsWith("Bearer") ? token : `Bearer ${token}`;
    const response = await axios.get(`${REWARDS_URL}/ext/api/v2/claim_details`, {
      headers: { ...HEADERS, Authorization: authToken },
      timeout: 30000,
      family: 4
    });
    printDivider();
    logger.info(colors.info + "[CLAIM DETAILS]" + colors.reset);
    logger.info(`${colors.info}▸ Tier       : ${colors.green}${response.data.data.tier}${colors.reset}`);
    logger.info(`${colors.info}▸ Daily Point : ${colors.green}${response.data.data.dailyPoint}${colors.reset}`);
    const status = response.data.data.claimed
      ? colors.warning + "Claimed" + colors.reset
      : colors.green + "Available" + colors.reset;
    logger.info(`${colors.info}▸ Status     : ${status}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      logger.error(colors.error + `Failed to get claim details: ${error.response.status} - ${JSON.stringify(error.response.data)}` + colors.reset);
    } else if (error.request) {
      logger.error(colors.error + `Failed to get claim details: No response received (${error.code}) - Check your network connection` + colors.reset);
    } else {
      logger.error(colors.error + `Failed to get claim details: ${error.message}` + colors.reset);
    }
    return null;
  }
}

async function getStreakInfo(token) {
  try {
    const authToken = token.startsWith("Bearer") ? token : `Bearer ${token}`;
    const response = await axios.get(`${REWARDS_URL}/ext/api/v2/streak`, {
      headers: { ...HEADERS, Authorization: authToken },
      timeout: 30000,
      family: 4
    });
    printDivider();
    logger.info(colors.info + "[STREAK INFO]" + colors.reset);
    const claimedDays = response.data.data.filter(day => day.isClaimed).length;
    logger.info(`${colors.info}▸ Current    : ${colors.green}${claimedDays} days${colors.reset}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      logger.error(colors.error + `Failed to get streak info: ${error.response.status} - ${JSON.stringify(error.response.data)}` + colors.reset);
    } else if (error.request) {
      logger.error(colors.error + `Failed to get streak info: No response received (${error.code}) - Check your network connection` + colors.reset);
    } else {
      logger.error(colors.error + `Failed to get streak info: ${error.message}` + colors.reset);
    }
    return null;
  }
}

async function claimReward(token, index) {
  try {
    const authToken = token.startsWith("Bearer") ? token : `Bearer ${token}`;
    logger.info(colors.info + `[${index + 1}] => Attempting to claim reward...` + colors.reset);
    const response = await axios.get(`${REWARDS_URL}/ext/api/v2/claim_reward`, {
      headers: { ...HEADERS, Authorization: authToken },
      timeout: 30000,
      family: 4
    });
    if (response.data.status === "SUCCESS") {
      printDivider();
      logger.success(colors.green + `[${index + 1}] => [CLAIM SUCCESS] Daily reward claimed successfully!` + colors.reset);
      logger.info(`${colors.info}[${index + 1}] => Next Claim at: ${colors.green}${formatTime(response.data.data.nextClaim)}${colors.reset}`);
    } else {
      logger.warn(colors.warning + `[${index + 1}] => Claim reward response: ${JSON.stringify(response.data)}` + colors.reset);
    }
    return response.data;
  } catch (error) {
    if (error.response) {
      logger.error(colors.error + `[${index + 1}] => Failed to claim reward: ${error.response.status} - ${JSON.stringify(error.response.data)}` + colors.reset);
    } else if (error.request) {
      logger.error(colors.error + `[${index + 1}] => Failed to claim reward: No response received (${error.code}) - Check your network connection` + colors.reset);
    } else {
      logger.error(colors.error + `[${index + 1}] => Failed to claim reward: ${error.message}` + colors.reset);
    }
    return null;
  }
}

/* ==========================
   9) Heartbeat Function
   Sends a POST to /ext/api/v2/nodes/communicate with a browser‑like Host.
   ========================== */
async function sendHeartbeat(token, workerID, ownerAddress, sessionID, index) {
  try {
    const authToken = token.startsWith("Bearer") ? token : `Bearer ${token}`;
    const { gpu, storage } = getOrAssignResources(workerID);
    const heartbeatMessage = {
      message: {
        Worker: {
          Identity: workerID,
          ownerAddress,
          type: "LWEXT",
          Host: "chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc",
          pending_jobs_count: 0
        },
        Capacity: {
          AvailableMemory: parseFloat((Math.random() * 32).toFixed(2)),
          AvailableStorage: storage,
          AvailableGPU: gpu,
          AvailableModels: []
        }
      },
      msgType: "HEARTBEAT",
      workerType: "LWEXT",
      workerID: workerID
    };

    logger.info(colors.info + `[${index + 1}] => Sending HEARTBEAT for workerID=${workerID}` + colors.reset);
    const response = await axios.post(
      `${BASE_URL}/ext/api/v2/nodes/communicate`,
      heartbeatMessage,
      {
        headers: { ...HEADERS, Authorization: authToken },
        timeout: 30000,
        family: 4
      }
    );

    const nextHeartbeat = (response.data && response.data.data && response.data.data.next_heartbeat) || 300;
    logger.success(colors.green + `[${index + 1}] => Heartbeat successful. Next heartbeat in ${nextHeartbeat} seconds.` + colors.reset);
  } catch (error) {
    logger.error(colors.error + `[${index + 1}] => Error sending heartbeat: ${error.response?.data || error.message}` + colors.reset);
  }
}

/* ==========================
   10) Concurrency Pipeline
   For each token, perform API checks, heartbeat, and claim reward.
   ========================== */
async function runPipeline({ ownerAddress, token, workerID, sessionID }, index) {
  await checkAppVersion(token);
  await getUserInfo(token);
  await getClaimDetails(token);
  await getStreakInfo(token);
  await sendHeartbeat(token, workerID, ownerAddress, sessionID, index);
  await claimReward(token, index);
}

/* ==========================
   11) Scheduling
   - Heartbeats: every 30 seconds.
   - Claims: every 12 hours.
   ========================== */
function scheduleHeartbeats() {
  setInterval(() => {
    tokens.forEach((t, i) => {
      sendHeartbeat(t.token, t.workerID, t.ownerAddress, t.sessionID, i);
    });
  }, 30000);
}

function scheduleClaims() {
  // Initial claim attempt
  tokens.forEach((t, i) => {
    claimReward(t.token, i);
  });
  // Every 12 hours
  setInterval(() => {
    tokens.forEach((t, i) => {
      claimReward(t.token, i);
    });
  }, 12 * 60 * 60 * 1000);
}

/* ==========================
   12) MAIN
   ========================== */
(async () => {
  printDivider();
  logger.info(colors.info + "OpenLedger Bot by LazyNode" + colors.reset);
  printDivider();

  // Run the pipeline for all tokens
  await Promise.all(tokens.map((t, i) => runPipeline(t, i)));

  // Schedule periodic tasks
  scheduleHeartbeats();
  scheduleClaims();
})();
