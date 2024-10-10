# The Vault Secret Injector
A Secret Injector Service that is designed to interact with HashiCorp Vault to securely retrieve and cache secrets. It also manages Vault token renewal to ensure continuous authentication. The application periodically checks for updates in the stored secrets and updates a local .env file, which can be used by other applications for environment configuration.
## Features
#### Fetch Secrets from Vault:
1. Retrieves secrets from a specified Vault KV store and caches them locally.
2. Writes the secrets to a .env file or a custom file specified in the environment.

#### Token Management and Renewal:
1. Periodically checks the remaining TTL (Time to Live) of the Vault token and renews it when it is close to expiration.
2. The renewal threshold can be configured to control when the token should be renewed before expiration.

#### Caching Mechanism:
1. Caches the last known secret values in a JSON file.
2. If the Vault server is unavailable or the token is invalid, the application falls back to the cached secrets.
3. Configurable Time Intervals.

## How It Works
#### Secrets Fetching and Caching:
1. The app fetches secrets from the Vault KV store and caches the results locally in a JSON file.
2. If the secrets change in Vault, the cached values and the .env file are updated.

#### Token Checking and Renewal:
1. The app checks the TTL of the Vault token at regular intervals.
2. If the TTL is below a configured threshold, the app will attempt to renew the token automatically.

#### Fallback to Cached Secrets:
1. If Vault is unreachable or the token is invalid, the app falls back to the cached secrets, ensuring your application remains functional with the last known valid data.
2. Time intervals for checking secrets and token status can be specified in a flexible format (s, m, h, d) for seconds, minutes, hours, or days.
3. Defaults to seconds if no format is provided.

## Configure a Vault Token
1. Download vault cli from here: https://developer.hashicorp.com/vault/install
2. Export Vault Configs
    ```
    export VAULT_ADDR='https://vault.domain.com'
    export TOKEN='hvs.ADMINXXXXXXXXXXXXX'
    ```
3. Connect to VPN to be able to reach vault
4. Login to vault
    ```
    vault login $TOKEN
    ```
5. Create a renewable Token using a specific policy (In this case, we are creating a renewable token that is vaild initially for 30 days)
**IMPORTANT:** USE THE EXACT SAME COMMAND
    ```
    vault token create -policy="admin" -period=30d
    ```
6. You can see the validity of the token using the below command
    ```
    vault token lookup $(TOKEN_VALUE)
    ```

## Setup
### Configure
Make a copy of the `.env.template` file and populate it
```bash
# The Vault Endpoint
VAULT_ENDPOINT=http://127.0.0.1:8200
# The Vault Token
VAULT_TOKEN=example-token
# The Key Value Storne Name
VAULT_KV_STORE=kv-secret
# The path for the secret
VAULT_SECRET_PATH=my-secret
# The targeted ENV file on the host system
TARGET_HOST_FILE="./secrets.env"
# The Interval in which the injector will check for secrets updates (Note: You can use the time formats: s,m,h,d)
SECRETS_CHECK_INTERVAL=5s
# The Interval in which the injector will check if the token is about to expire (Note: You can use the time formats: s,m,h,d)
TOKEN_CHECK_INTERVAL=12h
# The minimum threshold in which the token TTL is allowed to be (It should be more than the TOKEN_CHECK_INTERVAL) (Note: You can use the time formats: s,m,h,d)
TOKEN_RENEW_THRESHOLD=25d
```
### Start
```bash
docker compose up -d
```