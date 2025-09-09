const vault = require('node-vault');
const fs = require('fs');
const path = require('path');

// Load environment variables from a .env file if needed
require('dotenv').config();

// File path to store the last known secret values
const cacheFilePath = path.resolve(__dirname, '.last.cache.json');
const secretsFilePath = process.env.SECRETS_FILE_PATH || path.resolve('/secrets', 'secrets.env');

// Multi-mapping support: parse VAULT_SECRET_MAPPINGS if provided
// Format: VAULT_SECRET_MAPPINGS=path1:/secrets/a.env,path2:/secrets/b.env
function parseMappings(envStr) {
  if (!envStr) return [];
  // Trim and strip a single layer of surrounding quotes if present
  const cleaned = envStr.trim().replace(/^['"]|['"]$/g, '');
  return cleaned
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const pair = raw.replace(/^['"]|['"]$/g, '');
      const idx = pair.indexOf(':');
      if (idx === -1) {
        throw new Error(
          `Invalid VAULT_SECRET_MAPPINGS entry: "${pair}". Expected format "vault/secret/path:/secrets/target.env"`
        );
      }
      const secretPath = pair.slice(0, idx).trim();
      const targetFileRaw = pair.slice(idx + 1).trim();
      return { secretPath, targetFile: targetFileRaw };
    });
}

function getDestPath(targetFile) {
  if (!targetFile) return secretsFilePath;
  if (path.isAbsolute(targetFile)) return targetFile;
  // default to writing under /secrets
  return path.resolve('/secrets', targetFile);
}

function getCachePath(secretPath) {
  const slug = String(secretPath).replace(/[^a-zA-Z0-9_-]+/g, '_');
  return path.resolve(__dirname, `.last.cache.${slug}.json`);
}

function parseEnumeratedMappingsFromEnv(env) {
  const out = [];
  const regex = /^VAULT_SECRET_PATH_(\d+)$/;
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(regex);
    if (m && value) {
      const idx = m[1];
      const tfKey = `TARGET_HOST_FILE_${idx}`;
      const targetFile = env[tfKey];
      if (targetFile) {
        out.push({ secretPath: String(value).trim(), targetFile: String(targetFile).trim() });
      }
    }
  }
  return out;
}

const mappingsListVar = parseMappings(process.env.VAULT_SECRET_MAPPINGS);
const mappingsEnumVar = parseEnumeratedMappingsFromEnv(process.env);
const mappings = [...mappingsListVar, ...mappingsEnumVar];
const USING_MULTI_MODE = mappings.length > 0;

// Create a Vault client
const vaultClient = vault({
  apiVersion: 'v1',
  endpoint: process.env.VAULT_ENDPOINT,
  token: process.env.VAULT_TOKEN,
});

// Utility function to parse time duration (s, m, h, d) and convert to seconds
function parseDuration(duration) {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);

  if (!isNaN(value)) {
    switch (unit) {
      case 's':
        return value; // Seconds
      case 'm':
        return value * 60; // Minutes to seconds
      case 'h':
        return value * 60 * 60; // Hours to seconds
      case 'd':
        return value * 60 * 60 * 24; // Days to seconds
      default:
        throw new Error(`Invalid time unit in duration: ${unit}`);
    }
  }

  // If no time format (e.g., `s`, `m`, `h`, `d`) is provided, treat the value as seconds
  const numericValue = parseInt(duration, 10);
  if (isNaN(numericValue)) {
    throw new Error(`Invalid time duration: ${duration}`);
  }

  return numericValue; // Default to seconds if no unit is provided
}

// Function to read a secret for a specific mapping
async function readSecretForMapping(secretPath, targetFile) {
  const kvStore = process.env.VAULT_KV_STORE;
  const destPath = getDestPath(targetFile);
  const cachePath = getCachePath(secretPath);

  try {
    const secret = await vaultClient.read(`${kvStore}/data/${secretPath}`);
    const secretData = secret.data.data;

    // Cache the latest known secret values for this mapping
    fs.writeFileSync(cachePath, JSON.stringify(secretData, null, 2));
    console.log(`Secrets cached successfully for path: ${secretPath}`);

    // Output only the secret names
    for (const key of Object.keys(secretData)) {
      console.log(`${key}=**********`);
    }

    // Write the secrets to the target file
    writeSecretsToFile(secretData, destPath);
  } catch (err) {
    if (err.message.includes('permission denied') || err.message.includes('invalid token')) {
      console.error(`Authentication Failure for path: ${secretPath}`);

      // Check if there is a cached secret available for this mapping
      if (fs.existsSync(cachePath)) {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

        // Output only the secret names
        for (const key of Object.keys(cachedData)) {
          console.log(`${key}=**********`);
        }

        // Write the cached secrets to the target file
        writeSecretsToFile(cachedData, destPath);
      } else {
        console.error(`No cached secret values available for path: ${secretPath}`);
      }
    } else {
      console.error(`Error reading secret for path ${secretPath}:`, err.message);
    }
  }
}

// Function to read secrets initially (single or multi mode)
async function readSecret() {
  if (USING_MULTI_MODE) {
    for (const { secretPath, targetFile } of mappings) {
      // eslint-disable-next-line no-await-in-loop
      await readSecretForMapping(secretPath, targetFile);
    }
    return;
  }

  // Single-file backward-compatible mode
  const kvStore = process.env.VAULT_KV_STORE;
  const secretPath = process.env.VAULT_SECRET_PATH;

  try {
    // Read the secret from the specified path
    const secret = await vaultClient.read(`${kvStore}/data/${secretPath}`);
    const secretData = secret.data.data;

    // Cache the latest known secret values
    fs.writeFileSync(cacheFilePath, JSON.stringify(secretData, null, 2));
    console.log('Secrets cached successfully.');

    // Output only the secret names
    for (const key of Object.keys(secretData)) {
      console.log(`${key}=**********`);
    }

    // Write the secrets to the .env file
    writeSecretsToFile(secretData, secretsFilePath);
  } catch (err) {
    if (err.message.includes('permission denied') || err.message.includes('invalid token')) {
      console.error('Authentication Failure');

      // Check if there is a cached secret available
      if (fs.existsSync(cacheFilePath)) {
        const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));

        // Output only the secret names
        for (const key of Object.keys(cachedData)) {
          console.log(`${key}=**********`);
        }

        // Write the cached secrets to the .env file
        writeSecretsToFile(cachedData, secretsFilePath);
      } else {
        console.error('No cached secret values available');
      }
    } else {
      console.error('Error reading secret:', err.message);
    }
  }
}

// Function to write secrets to a .env-like file
function writeSecretsToFile(secretData, destFilePath) {
  const secretLines = Object.entries(secretData).map(([key, value]) => `${key}=${value}`).join('\n');

  // Ensure destination directory exists
  const dir = path.dirname(destFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory for secrets at ${dir}`);
  }

  // Create the file if it doesn't exist
  if (!fs.existsSync(destFilePath)) {
    fs.writeFileSync(destFilePath, '');
    console.log(`Created new secrets file at ${destFilePath}`);
  }

  // Write to the file and log the action
  fs.writeFileSync(destFilePath, secretLines);
  console.log(`Secrets written to ${destFilePath}`);
}

// Function to check and renew the Vault token if it is close to expiration
async function checkToken() {
  const thresholdString = process.env.TOKEN_RENEW_THRESHOLD || '60s'; // Default threshold as string
  const threshold = parseDuration(thresholdString); // Convert to seconds

  try {
    // Lookup the current token's TTL (Time to Live)
    const tokenInfo = await vaultClient.tokenLookupSelf();
    const ttl = tokenInfo.data.ttl; // TTL is in seconds

    console.log(`Token TTL: ${ttl} seconds`);

    // Check if the TTL is below the threshold
    if (ttl <= threshold) {
      console.log(`Token TTL is below the threshold of ${thresholdString}. Renewing the token...`);

      // Renew the token
      const renewedToken = await vaultClient.tokenRenewSelf();
      console.log(`Token renewed successfully. New TTL: ${renewedToken.auth.lease_duration} seconds`);

      // Update the token in the Vault client
      vaultClient.token = renewedToken.auth.client_token;
    } else {
      console.log(`Token is still valid. TTL (${ttl} seconds) is above the renewal threshold (${thresholdString}).`);
    }
  } catch (err) {
    console.error('Error checking token:', err.message);
  }
}

// Function to check for updates for a specific mapping
async function checkForUpdatesForMapping(secretPath, targetFile) {
  const kvStore = process.env.VAULT_KV_STORE;
  const destPath = getDestPath(targetFile);
  const cachePath = getCachePath(secretPath);

  try {
    // Read the secret from the specified path
    const secret = await vaultClient.read(`${kvStore}/data/${secretPath}`);
    const secretData = secret.data.data;

    // Check if there are changes in the secret values
    if (fs.existsSync(cachePath)) {
      const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

      if (JSON.stringify(cachedData) !== JSON.stringify(secretData)) {
        console.log(`Secret values have changed for path: ${secretPath}`);

        // Update the cache with the latest known secret values
        fs.writeFileSync(cachePath, JSON.stringify(secretData, null, 2));
        console.log('Secrets cache updated.');

        // Output only the secret names
        for (const key of Object.keys(secretData)) {
          console.log(`${key}=**********`);
        }

        // Write the updated secrets to the target file
        writeSecretsToFile(secretData, destPath);
      }
    } else {
      // Cache the latest known secret values if not already cached
      fs.writeFileSync(cachePath, JSON.stringify(secretData, null, 2));
      console.log(`Secrets cached for the first time for path: ${secretPath}`);

      // Output only the secret names
      for (const key of Object.keys(secretData)) {
        console.log(`${key}=**********`);
      }

      // Write the secrets to the target file
      writeSecretsToFile(secretData, destPath);
    }
  } catch (err) {
    console.error(`Error checking for updates for path ${secretPath}:`, err.message);
  }
}

// Function to periodically check for secret updates (single or multi)
async function checkForUpdates() {
  if (USING_MULTI_MODE) {
    for (const { secretPath, targetFile } of mappings) {
      // eslint-disable-next-line no-await-in-loop
      await checkForUpdatesForMapping(secretPath, targetFile);
    }
    return;
  }

  // Single-file mode
  const kvStore = process.env.VAULT_KV_STORE;
  const secretPath = process.env.VAULT_SECRET_PATH;

  try {
    // Read the secret from the specified path
    const secret = await vaultClient.read(`${kvStore}/data/${secretPath}`);
    const secretData = secret.data.data;

    // Check if there are changes in the secret values
    if (fs.existsSync(cacheFilePath)) {
      const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));

      if (JSON.stringify(cachedData) !== JSON.stringify(secretData)) {
        console.log('Secret values have changed.');

        // Update the cache with the latest known secret values
        fs.writeFileSync(cacheFilePath, JSON.stringify(secretData, null, 2));
        console.log('Secrets cache updated.');

        // Output only the secret names
        for (const key of Object.keys(secretData)) {
          console.log(`${key}=**********`);
        }

        // Write the updated secrets to the .env file
        writeSecretsToFile(secretData, secretsFilePath);
      }
    } else {
      // Cache the latest known secret values if not already cached
      fs.writeFileSync(cacheFilePath, JSON.stringify(secretData, null, 2));
      console.log('Secrets cached for the first time.');

      // Output only the secret names
      for (const key of Object.keys(secretData)) {
        console.log(`${key}=**********`);
      }

      // Write the secrets to the .env file
      writeSecretsToFile(secretData, secretsFilePath);
    }
  } catch (err) {
    console.error('Error checking for updates:', err.message);
  }
}

// Function to periodically check the token and secrets
function keepAlive() {
  const secretsCheckIntervalString = process.env.SECRETS_CHECK_INTERVAL || '5s'; // Default as string
  const tokenCheckIntervalString = process.env.TOKEN_CHECK_INTERVAL || '60s'; // Default as string

  const secretsCheckInterval = parseDuration(secretsCheckIntervalString); // Convert to seconds
  const tokenCheckInterval = parseDuration(tokenCheckIntervalString); // Convert to seconds

  console.log(`Token will be checked every ${tokenCheckIntervalString}.`);

  // Set interval to check for secrets updates
  setInterval(() => {
    checkForUpdates();
  }, secretsCheckInterval * 1000);

  // Set interval to check and renew the token
  setInterval(() => {
    checkToken();
  }, tokenCheckInterval * 1000);
}

// Execute the readSecret function initially
readSecret().then(() => {
  keepAlive();
});