/***************************************************
 * index.js
 ***************************************************/
const fs = require('fs');
const WebSocket = require('ws');
const axios = require('axios');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { v4: uuidv4 } = require('uuid');

/* ==========================
   1) Disable TLS checks (optional/insecure)
   ========================== */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/* ==========================
   2) Color-coded logs
   ========================== */
const color = {
  red: (txt) => `\x1b[31m${txt}\x1b[0m`,
  green: (txt) => `\x1b[32m${txt}\x1b[0m`,
  yellow: (txt) => `\x1b[33m${txt}\x1b[0m`,
  cyan: (txt) => `\x1b[36m${txt}\x1b[0m`,
};

function logInfo(msg) {
  console.log(color.cyan(msg));
}
function logSuccess(msg) {
  console.log(color.green(msg));
}
function logWarn(msg) {
  console.log(color.yellow(msg));
}
function logError(msg) {
  console.error(color.red(msg));
}

/* ==========================
   3) Show header
   ========================== */
function displayHeader() {
  const width = process.stdout.columns || 80;
  const lines = [
    "<|============================================|>",
    " OpenLedger Bot by LazyNode ",
    " https://lazynode.com ",
    "<|============================================|>"
  ];
  lines.forEach(line => {
    const padded = line.padStart((width + line.length) / 2);
    console.log(color.cyan(padded));
  });
}

/* ==========================
   4) Random Delay Helper
   ========================== */
function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/* ==========================
   5) Base64 for workerID
   ========================== */
function base64Encode(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

/* ==========================
   6) Sanitize Proxy URL
   ========================== */
function sanitizeProxyUrl(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    // If missing protocol, prepend http://
    return 'http://' + trimmed;
  }
  return trimmed;
}

/* ==========================
   7) Read account.txt
   Format: ownerAddress:token
   ========================== */
const accountLines = fs.readFileSync('account.txt', 'utf8').trim().split(/\s+/);
const tokens = accountLines.map((line, idx) => {
  const parts = line.split(':');
  if (parts.length !== 2) {
    logWarn(`Skipping malformed line #${idx+1}: ${line}`);
    return null;
  }
  const [ownerAddress, token] = parts.map(x => x.trim());
  const workerID = base64Encode(ownerAddress);
  const sessionID = uuidv4();
  return { ownerAddress, token, workerID, sessionID };
}).filter(Boolean);

if (!tokens.length) {
  logError('No valid lines in account.txt (need "ownerAddress:token").');
  process.exit(1);
}

/* ==========================
   8) Read proxies
   Must have enough lines for each token
   ========================== */
let rawProxies = [];
try {
  rawProxies = fs.readFileSync('proxy.txt', 'utf8').trim().split(/\s+/);
} catch (err) {
  logError(`Error reading proxy.txt: ${err.message}`);
  process.exit(1);
}
const proxies = rawProxies.map(sanitizeProxyUrl).filter(Boolean);
if (proxies.length < tokens.length) {
  logError('Not enough proxies for number of tokens. Provide more or do round-robin logic.');
  process.exit(1);
}

/* ==========================
   9) GPU + data assignments
   data.json => { [workerID]: { gpu, storage } }
   ========================== */
const gpuList = JSON.parse(fs.readFileSync('src/gpu.json', 'utf8'));
let dataAssignments = {};
try {
  dataAssignments = JSON.parse(fs.readFileSync('data.json', 'utf8'));
} catch {
  logInfo('No existing data.json, starting fresh.');
}

function getOrAssignResources(workerID) {
  if (!dataAssignments[workerID]) {
    const randomGPU = gpuList[Math.floor(Math.random() * gpuList.length)];
    const randomStorage = (Math.random() * 500).toFixed(2);
    dataAssignments[workerID] = { gpu: randomGPU, storage: randomStorage };
    try {
      fs.writeFileSync('data.json', JSON.stringify(dataAssignments, null, 2));
    } catch (err) {
      logError(`Error writing data.json: ${err.message}`);
    }
  }
  return dataAssignments[workerID];
}

/* ==========================
   10) Shared State
   We'll store token => accountID
   Force always proxy = true
   ========================== */
const accountIDs = {};
const useProxy = true;

/* 
   Helper: build an agent (Axios or WebSocket) from the i-th proxy
   We also set rejectUnauthorized=false if ignoring cert errors
*/
function buildProxyAgent(index) {
  const proxyUrl = useProxy ? proxies[index] : null;
  if (!proxyUrl) {
    // fallback
    return new https.Agent({ rejectUnauthorized: false });
  }
  return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
}

/* ==========================
   11) 429 Retry Logic in HTTP
   ========================== */
async function handleAxios429(fn) {
  // We'll wrap each call in a try/catch that if 429 => random 30-50s wait
  let result;
  while (true) {
    try {
      result = await fn();
      return result;
    } catch (err) {
      if (err.response?.status === 429) {
        const wait = randomDelay(30000, 50000);
        logWarn(`429 => waiting ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        // then continue
      } else {
        throw err;
      }
    }
  }
}

/* ==========================
   12) getAccountID (indefinite)
   ========================== */
async function getAccountID(token, index, delayMs = 60000) {
  let attempt = 1;
  while (true) {
    try {
      const agent = buildProxyAgent(index);
      const resp = await handleAxios429(() => {
        return axios.get('https://apitn.openledger.xyz/api/v1/users/me', {
          headers: { Authorization: `Bearer ${token}` },
          httpsAgent: agent
        });
      });
      accountIDs[token] = resp.data.data.id;
      logSuccess(`[${index + 1}] => AID=${accountIDs[token]}, Proxy=${proxies[index]}`);
      return;
    } catch (err) {
      logError(`[${index + 1}] => getAccountID attempt ${attempt}: ${err.message}`);
      logInfo(`[${index + 1}] => Retry in ${delayMs/1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
      attempt++;
    }
  }
}

/* ==========================
   13) getAccountDetails (3 attempts)
   ========================== */
async function getAccountDetails(token, index, retries = 3, delayMs = 60000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const agent = buildProxyAgent(index);
      const [resp1, resp2, resp3] = await handleAxios429(async () => {
        return await Promise.all([
          axios.get('https://rewardstn.openledger.xyz/api/v1/reward_realtime', {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agent
          }),
          axios.get('https://rewardstn.openledger.xyz/api/v1/reward_history', {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agent
          }),
          axios.get('https://rewardstn.openledger.xyz/api/v1/reward', {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agent
          })
        ]);
      });

      const totalHeartbeats = parseInt(resp1.data.data[0].total_heartbeats, 10);
      const totalPointsHist = parseInt(resp2.data.data[0].total_points, 10);
      const totalPointFromReward = parseFloat(resp3.data.data.totalPoint);
      const epochName = resp3.data.data.name;
      const total = totalHeartbeats + totalPointFromReward;

      logSuccess(`[${index + 1}] => AID=${accountIDs[token]}, HB=${totalHeartbeats}, Points=${total.toFixed(2)} (Epoch=${epochName}), Proxy=${proxies[index]}`);
      return;
    } catch (err) {
      logError(`[${index + 1}] => getAccountDetails attempt ${attempt}: ${err.message}`);
      if (attempt < retries) {
        logInfo(`[${index + 1}] => Retry in ${delayMs/1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        logError(`[${index + 1}] => All attempts failed for getAccountDetails.`);
      }
    }
  }
}

/* ==========================
   14) checkAndClaimReward (3 attempts)
   ========================== */
async function checkAndClaimReward(token, index, retries = 3, delayMs = 60000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const agent = buildProxyAgent(index);
      const details = await handleAxios429(() => {
        return axios.get('https://rewardstn.openledger.xyz/api/v1/claim_details', {
          headers: { Authorization: `Bearer ${token}` },
          httpsAgent: agent
        });
      });
      if (!details.data.data.claimed) {
        const claim = await handleAxios429(() => {
          return axios.get('https://rewardstn.openledger.xyz/api/v1/claim_reward', {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agent
          });
        });
        if (claim.data.status === 'SUCCESS') {
          logSuccess(`[${index + 1}] => Claimed daily reward for AID=${accountIDs[token]}`);
        }
      }
      return;
    } catch (err) {
      logError(`[${index + 1}] => checkAndClaim attempt ${attempt}: ${err.message}`);
      if (attempt < retries) {
        logInfo(`[${index + 1}] => Retry in ${delayMs/1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        logError(`[${index + 1}] => All attempts failed for checkAndClaimReward.`);
      }
    }
  }
}

/* ==========================
   15) The concurrency pipeline
   ========================== */
async function runPipeline({ ownerAddress, token, workerID, sessionID }, index) {
  // get ID
  await getAccountID(token, index);
  // get details
  await getAccountDetails(token, index);
  // claim
  await checkAndClaimReward(token, index);
  // connect WS
  connectWebSocket({ ownerAddress, token, workerID, sessionID }, index);
}

/* ==========================
   16) Connect WebSocket with proxy
   - ws v8+ supports { agent: HttpsProxyAgent(...) }
   - Avoid duplicate reconnect
   ========================== */
function connectWebSocket({ ownerAddress, token, workerID, sessionID }, index) {
  let reconnectPending = false;
  const proxyUrl = useProxy ? proxies[index] : null;

  // Build an agent for WebSocket:
  let wsAgent;
  if (proxyUrl) {
    wsAgent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  } else {
    wsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  const wsUrl = `wss://apitn.openledger.xyz/ws/v1/orch?authToken=${token}`;
  const wsOptions = {
    agent: wsAgent,            // <-- Proxy the wss connection 
    rejectUnauthorized: false, // if ignoring cert checks
  };
  const ws = new WebSocket(wsUrl, wsOptions);

  let heartbeatInterval;

  function sendHeartbeat() {
    const { gpu, storage } = getOrAssignResources(workerID);
    const hbMsg = {
      msgType: 'HEARTBEAT',
      workerType: 'LWEXT',
      workerID,
      message: {
        Worker: {
          Identity: workerID,
          ownerAddress,
          type: 'LWEXT',
          Host: 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc'
        },
        Capacity: {
          AvailableMemory: (Math.random() * 32).toFixed(2),
          AvailableStorage: storage,
          AvailableGPU: gpu,
          AvailableModels: []
        }
      }
    };
    logInfo(`[${index + 1}] => HEARTBEAT: workerID=${workerID}, AID=${accountIDs[token]}, Proxy=${proxyUrl}`);
    ws.send(JSON.stringify(hbMsg));
  }

  function doReconnect() {
    if (reconnectPending) return;
    reconnectPending = true;
    logWarn(`[${index + 1}] => Reconnect WS for workerID=${workerID} in 30s...`);
    setTimeout(() => {
      reconnectPending = false;
      connectWebSocket({ ownerAddress, token, workerID, sessionID }, index);
    }, 30000);
  }

  ws.on('open', () => {
    logSuccess(`[${index + 1}] => WS open => workerID=${workerID}, AID=${accountIDs[token]}, Proxy=${proxyUrl}`);
    // REGISTER
    const regMsg = {
      workerID,
      msgType: 'REGISTER',
      workerType: 'LWEXT',
      message: {
        id: sessionID,
        type: 'REGISTER',
        worker: {
          host: 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc',
          identity: workerID,
          ownerAddress,
          type: 'LWEXT'
        }
      }
    };
    ws.send(JSON.stringify(regMsg));

    heartbeatInterval = setInterval(sendHeartbeat, 30000);
  });

  ws.on('message', (data) => {
    logInfo(`[${index + 1}] => WS message => workerID=${workerID}: ${data}`);
  });

  ws.on('error', (err) => {
    logError(`[${index + 1}] => WS error => workerID=${workerID}: ${err.message || err}`);
  });

  ws.on('close', () => {
    logWarn(`[${index + 1}] => WS closed => workerID=${workerID}, AID=${accountIDs[token]}`);
    clearInterval(heartbeatInterval);
    doReconnect();
  });
}

/* ==========================
   17) Periodic claim (12h)
   ========================== */
function schedulePeriodicClaims() {
  // initial
  Promise.all(tokens.map((tk, i) => checkAndClaimReward(tk.token, i)))
    .catch(err => logError(`Error in initial claim: ${err.message}`));

  // every 12h
  setInterval(() => {
    Promise.all(tokens.map((tk, i) => checkAndClaimReward(tk.token, i)))
      .catch(err => logError(`Error in scheduled claims: ${err.message}`));
  }, 12 * 60 * 60 * 1000);
}

/* ==========================
   18) Periodic updates (5m)
   ========================== */
function schedulePeriodicUpdates() {
  setInterval(async () => {
    try {
      await Promise.all(tokens.map(({ token }, i) => getAccountDetails(token, i)));
    } catch (err) {
      logError(`Error in scheduled details: ${err.message}`);
    }
  }, 5 * 60 * 1000);
}

/* ==========================
   MAIN
   ========================== */
(async () => {
  displayHeader();

  // Periodic claiming
  schedulePeriodicClaims();

  // Run concurrency pipeline for all tokens
  await Promise.all(tokens.map((t, i) => runPipeline(t, i)));

  // Periodic details
  schedulePeriodicUpdates();
})();
