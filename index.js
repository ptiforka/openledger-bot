const fs = require('fs');
const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Helper function to pause execution
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to get the current timestamp in the required format
function getTimestamp() {
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toTimeString().split(' ')[0]; // HH:MM:SS
  return `${date} ${time}`;
}

// Function to generate worker data from wallet address
function generateWorkerData(walletAddress) {
  const workerID = Buffer.from(walletAddress).toString('base64'); // Base64 encode the wallet address
  return {
    workerID,
    workerIdentity: workerID, // Both are the same
  };
}

// Display script header
function displayHeader() {
  const width = process.stdout.columns;
  const headerLines = [
    " OpenLedger Bot ",
    "https://lazynode.xyz",
  ];
  headerLines.forEach((line) => {
    console.log(`[${getTimestamp()}] \x1b[36m${line.padStart((width + line.length) / 2)}\x1b[0m`);
  });
}

// Parse accounts and proxies
const tokens = fs
  .readFileSync('account.txt', 'utf8')
  .trim()
  .split(/\s+/)
  .map((line) => {
    const parts = line.split(':');
    if (parts.length !== 2) {
      console.warn(`[${getTimestamp()}] Skipping malformed line: ${line}`);
      return null;
    }
    const [ownerAddress, token] = parts;
    const { workerID, workerIdentity } = generateWorkerData(ownerAddress.trim());
    return {
      token: token.trim(),
      ownerAddress: ownerAddress.trim(),
      workerID,
      workerIdentity,
    };
  })
  .filter((account) => account !== null);

let proxies = [];
try {
  proxies = fs.readFileSync('proxy.txt', 'utf8').trim().split(/\s+/);
} catch (error) {
  console.error(`[${getTimestamp()}] Error reading proxy.txt: ${error.message}`);
}

if (proxies.length < tokens.length) {
  console.error(`[${getTimestamp()}] The number of proxies is less than the number of accounts. Please provide enough proxies.`);
  process.exit(1);
}

// Retry logic for APIs
async function retryWithBackoff(fn, retries = 5, delay = 30000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[${getTimestamp()}] Attempt ${attempt}...`);
      return await fn();
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.error(`[${getTimestamp()}] 429 Too Many Requests. Retrying in ${delay / 1000} seconds...`);
        await sleep(delay + Math.random() * 30000); // Add randomness to avoid immediate retry collisions
      } else {
        console.error(`[${getTimestamp()}] Attempt ${attempt} failed: ${error.message}`);
        if (attempt === retries) throw error;
        await sleep(delay);
      }
    }
  }
}

// Fetch account ID with retry
async function getAccountID(token, index) {
  const proxyUrl = proxies[index];
  const agent = new HttpsProxyAgent(proxyUrl);

  await retryWithBackoff(async () => {
    console.log(`[${getTimestamp()}] Fetching account ID for token index ${index} using proxy: ${proxyUrl}`);
    const response = await axios.get('https://apitn.openledger.xyz/api/v1/users/me', {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: agent,
    });
    const accountID = response.data.data.id;
    console.log(`[${getTimestamp()}] Account ID for token index ${index}: ${accountID}`);
  });
}

// Check and claim rewards periodically
async function checkAndClaimRewardsPeriodically(useProxy) {
  console.log(`[${getTimestamp()}] Starting periodic reward check...`);
  const promises = tokens.map(({ token }, index) => checkAndClaimReward(token, index, useProxy));
  await Promise.all(promises);

  setInterval(async () => {
    console.log(`[${getTimestamp()}] Checking rewards for all accounts...`);
    const promises = tokens.map(({ token }, index) => checkAndClaimReward(token, index, useProxy));
    await Promise.all(promises);
  }, 12 * 60 * 60 * 1000); // Every 12 hours
}

// Check and claim rewards for a single token
async function checkAndClaimReward(token, index, useProxy) {
  const proxyUrl = proxies[index];
  const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

  await retryWithBackoff(async () => {
    console.log(`[${getTimestamp()}] Checking reward details for token index ${index}`);
    const claimDetailsResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/claim_details', {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: agent,
    });

    const claimed = claimDetailsResponse.data.data.claimed;

    if (!claimed) {
      console.log(`[${getTimestamp()}] Claiming reward for token index ${index}`);
      const claimRewardResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/claim_reward', {
        headers: { Authorization: `Bearer ${token}` },
        httpsAgent: agent,
      });

      if (claimRewardResponse.data.status === 'SUCCESS') {
        console.log(`[${getTimestamp()}] Reward claimed successfully for token index ${index}`);
      } else {
        console.warn(`[${getTimestamp()}] Reward claim failed for token index ${index}: ${claimRewardResponse.data.message}`);
      }
    } else {
      console.log(`[${getTimestamp()}] Reward already claimed for token index ${index}`);
    }
  });
}

// WebSocket connection with retry and heartbeat
function connectWebSocket({ token, workerID, workerIdentity, ownerAddress }, index) {
  const wsUrl = `wss://apitn.openledger.xyz/ws/v1/orch?authToken=${token}`;
  const proxyUrl = proxies[index];

  async function reconnect() {
    console.log(`[${getTimestamp()}] Reconnecting WebSocket for token index ${index}...`);
    await sleep(30000 + Math.random() * 30000); // Sleep for 30–60 seconds
    connectWebSocket({ token, workerID, workerIdentity, ownerAddress }, index);
  }

  console.log(`[${getTimestamp()}] Connecting WebSocket for token index ${index} using proxy: ${proxyUrl}`);
  const ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(proxyUrl) });

  ws.on('open', () => {
    console.log(`[${getTimestamp()}] WebSocket connected for token index ${index}.`);

    const registerMessage = {
      workerID,
      msgType: 'REGISTER',
      workerType: 'LWEXT',
      message: {
        id: Math.random().toString(36).substring(2),
        type: 'REGISTER',
        worker: {
          host: 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc',
          identity: workerIdentity,
          ownerAddress,
          type: 'LWEXT',
        },
      },
    };
    console.log(`[${getTimestamp()}] Sending register message for token index ${index}`);
    ws.send(JSON.stringify(registerMessage));

    setInterval(() => {
      const heartbeatMessage = {
        message: {
          Worker: {
            Identity: workerIdentity,
            ownerAddress,
            type: 'LWEXT',
            Host: 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc',
          },
          Capacity: {
            AvailableMemory: (Math.random() * 32).toFixed(2),
            AvailableStorage: Math.random() * 500,
            AvailableGPU: 'GPU-SIMULATED',
            AvailableModels: [],
          },
        },
        msgType: 'HEARTBEAT',
        workerType: 'LWEXT',
        workerID,
      };
      console.log(`[${getTimestamp()}] Sending heartbeat for token index ${index}`);
      ws.send(JSON.stringify(heartbeatMessage));
    }, 30000); // Heartbeat every 30 seconds
  });

  ws.on('message', (data) => {
    console.log(`[${getTimestamp()}] Message received for token index ${index}: ${data}`);
  });

  ws.on('error', (err) => {
    console.error(`[${getTimestamp()}] WebSocket error for token index ${index}: ${err.message}`);
    if (err.message.includes('429')) reconnect();
  });

  ws.on('close', () => {
    console.log(`[${getTimestamp()}] WebSocket closed for token index ${index}.`);
    reconnect();
  });
}

// Main process
(async () => {
  displayHeader();
  console.log(`[${getTimestamp()}] Starting account ID fetch...`);
  await Promise.all(tokens.map(({ token }, index) => getAccountID(token, index)));
  console.log(`[${getTimestamp()}] Account ID fetch complete. Starting WebSocket connections...`);
  tokens.forEach((account, index) => connectWebSocket(account, index));
  await checkAndClaimRewardsPeriodically(true); // Always use proxy
})();
