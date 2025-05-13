const vault = require('node-vault');
const fs = require('fs');
const path = require('path');

// Load environment variables from a .env file if needed
require('dotenv').config();

// File path to store the last known secret values
const cacheFilePath = path.resolve(__dirname, '.last.cache.json');
const secretsFilePath = process.env.SECRETS_FILE_PATH || path.resolve('/secrets', 'secrets.env');

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

// Function to read the secret from Vault
async function readSecret() {
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
    writeSecretsToFile(secretData);
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
        writeSecretsToFile(cachedData);
      } else {
        console.error('No cached secret values available');
      }
    } else {
      console.error('Error reading secret:', err.message);
    }
  }
}

// Function to write secrets to a .env file
function writeSecretsToFile(secretData) {
  const secretLines = Object.entries(secretData).map(([key, value]) => `${key}=${value}`).join('\n');
  
  // Create the .env file if it doesn't exist and log the action
  if (!fs.existsSync(secretsFilePath)) {
    fs.writeFileSync(secretsFilePath, '');
    console.log(`Created new secrets file at ${secretsFilePath}`);
  }

  // Write to the .env file and log the action
  fs.writeFileSync(secretsFilePath, secretLines);
  console.log(`Secrets written to ${secretsFilePath}`);
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

// Function to periodically check for secret updates
async function checkForUpdates() {
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
        writeSecretsToFile(secretData);
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
      writeSecretsToFile(secretData);
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