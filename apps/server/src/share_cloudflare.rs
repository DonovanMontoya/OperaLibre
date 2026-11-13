//! Installs the gift broker in the owner's own Cloudflare account, so setting
//! up gifts needs no source checkout or command line. The owner pastes an API
//! token; it is used for this one installation and never stored or logged.
//! Nothing here runs unless the owner asks for it.
use crate::*;
use sha2::{Digest, Sha256};

const API: &str = "https://api.cloudflare.com/client/v4";
/// Cloudflare's public STUN service, saved with a first installation so two
/// peers behind home routers can find each other.
pub(crate) const DEFAULT_STUN: &str = "stun:stun.cloudflare.com:3478";
const REJECTED: &str = "Cloudflare did not accept this token. Create a new one with the link above and paste it again.";

/// The compiled Worker, written by `script/gift_broker_modules.mjs`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Worker {
    name: String,
    compatibility_date: String,
    modules: std::collections::BTreeMap<String, String>,
}

static WORKER: LazyLock<Worker> = LazyLock::new(|| {
    serde_json::from_str(include_str!("share_broker_worker.json"))
        .expect("the embedded gift broker is valid")
});

#[cfg(test)]
pub(crate) static TEST_API: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn api_base() -> String {
    #[cfg(test)]
    if let Some(base) = TEST_API.lock().unwrap().clone() {
        return base;
    }
    API.to_string()
}

pub(crate) struct InstalledBroker {
    pub(crate) origin: String,
    pub(crate) owner_secret: String,
}

enum Failure {
    /// The token is wrong, expired, or lacks permission for this call.
    Rejected,
    Missing,
    Other(String),
}

impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Rejected => ApiError::bad_request(REJECTED),
            Failure::Missing => ApiError::bad_request(
                "Cloudflare could not find that account. Check the Account ID.",
            ),
            Failure::Other(message) => ApiError::bad_request(message),
        }
    }
}

struct Account {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Account {
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<serde_json::Value, Failure> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some((content_type, bytes)) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(bytes);
        }
        let unreachable =
            || Failure::Other("Cloudflare could not be reached. Try again in a moment.".into());
        let response = request.send().await.map_err(|_| unreachable())?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.map_err(|_| unreachable())?;
        if status.is_success() && body["success"] == true {
            return Ok(body["result"].clone());
        }
        let code = body["errors"][0]["code"].as_u64().unwrap_or(0);
        // 6003 is a malformed Authorization header, 10000 a failed permission check.
        if matches!(status.as_u16(), 401 | 403) || matches!(code, 6003 | 10000) {
            return Err(Failure::Rejected);
        }
        if status == StatusCode::NOT_FOUND {
            return Err(Failure::Missing);
        }
        let detail: String = body["errors"][0]["message"]
            .as_str()
            .unwrap_or("no details given")
            .chars()
            .filter(|character| !character.is_control())
            .take(200)
            .collect();
        Err(Failure::Other(format!(
            "Cloudflare refused the request: {detail}"
        )))
    }

    async fn get(&self, path: &str) -> Result<serde_json::Value, Failure> {
        self.call(reqwest::Method::GET, path, None).await
    }

    async fn json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, Failure> {
        let body = (
            "application/json".to_string(),
            body.to_string().into_bytes(),
        );
        self.call(method, path, Some(body)).await
    }
}

fn account_id_shaped(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn random_hex() -> String {
    hex_digest(rand::random::<[u8; 32]>())
}

async fn find_account(api: &Account) -> Result<String, ApiError> {
    let accounts = api.get("/accounts?per_page=50").await?;
    let ids: Vec<&str> = accounts
        .as_array()
        .map(|accounts| {
            accounts
                .iter()
                .filter_map(|account| account["id"].as_str())
                .filter(|id| account_id_shaped(id))
                .collect()
        })
        .unwrap_or_default();
    match ids.as_slice() {
        [id] => Ok((*id).to_string()),
        [] => Err(ApiError::bad_request(
            "This token cannot see a Cloudflare account. Enter your Account ID as well.",
        )),
        _ => Err(ApiError::bad_request(
            "This token works for more than one Cloudflare account. Enter the Account ID of the one to use.",
        )),
    }
}

/// Every Worker in an account is served under one `workers.dev` name. A new
/// account has none until its first Worker, so choose one for it.
async fn workers_subdomain(api: &Account, account: &str) -> Result<String, ApiError> {
    let path = format!("/accounts/{account}/workers/subdomain");
    let existing = match api.get(&path).await {
        Ok(result) => result["subdomain"].as_str().map(str::to_string),
        Err(Failure::Missing) => None,
        Err(failure) => return Err(failure.into()),
    };
    let subdomain = match existing {
        Some(subdomain) => subdomain,
        None => {
            let name = format!("operalibre-{}", &random_hex()[..10]);
            let created = api
                .json(
                    reqwest::Method::PUT,
                    &path,
                    serde_json::json!({ "subdomain": name }),
                )
                .await?;
            created["subdomain"].as_str().unwrap_or(&name).to_string()
        }
    };
    let valid = !subdomain.is_empty()
        && subdomain.len() <= 63
        && subdomain
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(ApiError::bad_request(
            "Cloudflare returned an unusable workers.dev name for this account.",
        ));
    }
    Ok(subdomain)
}

/// The storage class is declared once. A broker that is already installed
/// carries the tag, and declaring the class again would be refused.
async fn needs_storage_migration(api: &Account, account: &str) -> Result<bool, ApiError> {
    let scripts = api
        .get(&format!("/accounts/{account}/workers/scripts"))
        .await?;
    let installed = scripts.as_array().and_then(|scripts| {
        scripts
            .iter()
            .find(|script| script["id"] == WORKER.name.as_str())
    });
    Ok(installed.is_none_or(|script| script["migration_tag"].as_str().is_none()))
}

fn upload(metadata: &serde_json::Value) -> (String, Vec<u8>) {
    let boundary = format!("operalibre-{}", random_hex());
    let mut body = Vec::new();
    let mut part = |name: &str, content_type: &str, contents: &[u8]| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}\"\r\nContent-Type: {content_type}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(contents);
        body.extend_from_slice(b"\r\n");
    };
    part(
        "metadata",
        "application/json",
        metadata.to_string().as_bytes(),
    );
    for (name, source) in &WORKER.modules {
        part(name, "application/javascript+module", source.as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// Installs or replaces the broker and gives it fresh secrets. Replacing it
/// invalidates every link made with the old secrets, so the caller checks
/// that no gift is waiting.
pub(crate) async fn install(
    token: &str,
    account: Option<&str>,
) -> Result<InstalledBroker, ApiError> {
    let api = Account {
        client: http_client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| ApiError::internal("Cannot prepare the Cloudflare connection."))?,
        base: api_base(),
        token: token.to_string(),
    };
    let account = match account {
        Some(account) if account_id_shaped(account) => account.to_ascii_lowercase(),
        Some(_) => {
            return Err(ApiError::bad_request(
                "A Cloudflare Account ID is 32 letters and digits.",
            ));
        }
        None => find_account(&api).await?,
    };
    let subdomain = workers_subdomain(&api, &account).await?;
    let owner_secret = random_hex();
    let mut metadata = serde_json::json!({
        "main_module": "index.js",
        "compatibility_date": WORKER.compatibility_date,
        "bindings": [
            { "type": "durable_object_namespace", "name": "ROOMS", "class_name": "SecureRoom" },
            { "type": "plain_text", "name": "EXPERIMENTAL_ENABLED", "text": "true" },
            { "type": "secret_text", "name": "OWNER_SECRET_DIGEST_HEX",
              "text": hex_digest(Sha256::digest(owner_secret.as_bytes())) },
            { "type": "secret_text", "name": "SIGNING_SECRET", "text": random_hex() },
        ],
    });
    if needs_storage_migration(&api, &account).await? {
        metadata["migrations"] = serde_json::json!({
            "new_tag": "v1",
            "steps": [{ "new_sqlite_classes": ["SecureRoom"] }],
        });
    }
    let script = format!("/accounts/{account}/workers/scripts/{}", WORKER.name);
    api.call(reqwest::Method::PUT, &script, Some(upload(&metadata)))
        .await?;
    api.json(
        reqwest::Method::POST,
        &format!("{script}/subdomain"),
        serde_json::json!({ "enabled": true, "previews_enabled": false }),
    )
    .await?;
    Ok(InstalledBroker {
        origin: format!("https://{}.{subdomain}.workers.dev", WORKER.name),
        owner_secret,
    })
}
