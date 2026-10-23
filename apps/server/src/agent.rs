//! Agent access: read-only tokens a listener creates for an AI assistant, and
//! the Model Context Protocol endpoint those tokens reach.
//!
//! An agent token is not a session. It is stored apart from sessions, the
//! session middleware never accepts it, and it reaches nothing but
//! `/api/agent/mcp`. It resolves its account on every request, so it can never
//! see more than its creator can see in the app at that moment: a demotion or
//! a narrowed book grant applies to the token at once. Scopes only narrow that
//! further. Nothing here writes listening progress or anything else.
//!
//! Other listeners' activity is out of reach whatever the scopes say. A token
//! acts for one listener, and their shared view of others is theirs to read in
//! the app, not to hand to a third party.

use crate::*;
use axum::body::Bytes;

pub(crate) const AGENT_TOKENS_DOCUMENT: &str = "agent-tokens";

/// Lets a client, and a listener reading a config file, tell an agent token
/// from a session token at a glance. The session middleware never sees one in
/// its store, so the prefix is a convenience rather than the boundary.
const AGENT_TOKEN_PREFIX: &str = "olagent_";

const MAX_AGENT_TOKENS_PER_USER: usize = 10;

const AGENT_TOKEN_NAME_MAX_CHARS: usize = 64;

/// `lastUsedAt` helps a listener decide what to revoke; it is not an audit
/// log. Recording every call would rewrite the store on each tool use.
const LAST_USED_RESOLUTION_MS: u64 = 10 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentScope {
    /// Book metadata for the books the listener can see.
    Library,
    /// Where the listener is in each book.
    Progress,
    /// Listening sessions, finished books, and listening stats.
    History,
    /// A book's text up to the listener's position, for spoiler-free recaps.
    Text,
    /// A scope written by a newer server. Never granted by this one.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentToken {
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) name: String,
    pub(crate) scopes: Vec<AgentScope>,
    /// [`agent_token_lookup_key`] of the secret. The secret itself is shown
    /// once at creation and kept nowhere, so a backup cannot act as an agent.
    pub(crate) token_hash: String,
    pub(crate) created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_used_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTokenStore {
    /// The owner turns assistants on under Experiments. While off, tokens are
    /// kept but refused, so turning it back on reconnects everyone.
    #[serde(default)]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) tokens: Vec<AgentToken>,
}

pub(crate) type AgentTokens = CachedStore<AgentTokenStore>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTokenSummary {
    id: String,
    name: String,
    scopes: Vec<AgentScope>,
    created_at: String,
    last_used_at: Option<String>,
}

impl From<&AgentToken> for AgentTokenSummary {
    fn from(token: &AgentToken) -> Self {
        Self {
            id: token.id.clone(),
            name: token.name.clone(),
            scopes: token.scopes.clone(),
            created_at: rfc3339_utc(token.created_at_ms / 1_000),
            last_used_at: token.last_used_at_ms.map(|at| rfc3339_utc(at / 1_000)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateAgentTokenRequest {
    name: String,
    scopes: Vec<AgentScope>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedAgentToken {
    /// The secret, returned this once.
    token: String,
    agent_token: AgentTokenSummary,
}

fn agent_token_lookup_key(secret: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"operalibre-agent-token-v1\0");
    digest.update(secret.as_bytes());
    general_purpose::URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn generate_agent_token_id() -> String {
    let mut bytes = [0u8; 12];
    rand::rng().fill(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

const AGENT_ACCESS_OFF: &str = "AI assistants are not turned on for this server.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAccessStatus {
    enabled: bool,
    /// Counts only: who connected what is each listener's own business.
    assistants: usize,
    listeners: usize,
}

impl From<&AgentTokenStore> for AgentAccessStatus {
    fn from(store: &AgentTokenStore) -> Self {
        Self {
            enabled: store.enabled,
            assistants: store.tokens.len(),
            listeners: store
                .tokens
                .iter()
                .map(|token| token.user_id.as_str())
                .collect::<HashSet<_>>()
                .len(),
        }
    }
}

pub(crate) async fn agent_access_experiment(
    State(state): State<AppState>,
    _: AdminUser,
) -> Json<AgentAccessStatus> {
    Json(AgentAccessStatus::from(&*state.agent_tokens.read().await))
}

pub(crate) async fn set_agent_access_enabled(
    State(state): State<AppState>,
    _: OwnerUser,
    Json(input): Json<ExperimentalFeatureEnabled>,
) -> Result<Json<AgentAccessStatus>, ApiError> {
    state
        .agent_tokens
        .mutate(|store| {
            store.enabled = input.enabled;
            Ok(AgentAccessStatus::from(&*store))
        })
        .await
        .map(Json)
}

pub(crate) async fn list_agent_tokens(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<AgentTokenSummary>>, ApiError> {
    let store = state.agent_tokens.read().await;
    // The app hides its card on a 404, as for a server without assistants.
    if !store.enabled {
        return Err(ApiError::not_found(AGENT_ACCESS_OFF));
    }
    let mut tokens: Vec<&AgentToken> = store
        .tokens
        .iter()
        .filter(|token| token.user_id == auth.id)
        .collect();
    tokens.sort_by_key(|token| std::cmp::Reverse(token.created_at_ms));
    Ok(Json(
        tokens.into_iter().map(AgentTokenSummary::from).collect(),
    ))
}

pub(crate) async fn create_agent_token(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<CreateAgentTokenRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("Give the agent a name."));
    }
    if name.chars().count() > AGENT_TOKEN_NAME_MAX_CHARS || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "An agent name is at most {AGENT_TOKEN_NAME_MAX_CHARS} characters on one line."
        )));
    }
    let mut scopes = payload.scopes;
    if scopes.contains(&AgentScope::Unknown) {
        return Err(ApiError::bad_request(
            "That access level is not recognized.",
        ));
    }
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() {
        return Err(ApiError::bad_request(
            "Choose at least one thing the agent may read.",
        ));
    }

    let secret = format!("{AGENT_TOKEN_PREFIX}{}", generate_session_token());
    let token = AgentToken {
        id: generate_agent_token_id(),
        user_id: auth.id.clone(),
        name,
        scopes,
        token_hash: agent_token_lookup_key(&secret),
        created_at_ms: unix_now_millis(),
        last_used_at_ms: None,
    };
    let summary = AgentTokenSummary::from(&token);
    state
        .agent_tokens
        .mutate(|store| {
            if !store.enabled {
                return Err(ApiError::not_found(AGENT_ACCESS_OFF));
            }
            let existing = store
                .tokens
                .iter()
                .filter(|candidate| candidate.user_id == auth.id)
                .count();
            if existing >= MAX_AGENT_TOKENS_PER_USER {
                return Err(ApiError::conflict(format!(
                    "You can connect at most {MAX_AGENT_TOKENS_PER_USER} agents. Remove one first."
                )));
            }
            store.tokens.push(token);
            Ok(())
        })
        .await?;
    Ok((
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(CreatedAgentToken {
            token: secret,
            agent_token: summary,
        }),
    ))
}

pub(crate) async fn revoke_agent_token(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(token_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .agent_tokens
        .mutate(|store| {
            let before = store.tokens.len();
            store
                .tokens
                .retain(|token| !(token.id == token_id && token.user_id == auth.id));
            if store.tokens.len() == before {
                return Err(ApiError::not_found("Agent not found."));
            }
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove every agent token an account holds: the account is gone, or someone
/// else reset its password and the listener has not yet seen what it holds.
pub(crate) async fn revoke_agent_tokens_for_user(
    state: &AppState,
    user_id: &str,
) -> Result<(), ApiError> {
    if !state
        .agent_tokens
        .read()
        .await
        .tokens
        .iter()
        .any(|token| token.user_id == user_id)
    {
        return Ok(());
    }
    state
        .agent_tokens
        .mutate(|store| {
            store.tokens.retain(|token| token.user_id != user_id);
            Ok(())
        })
        .await
}

/// The agent a request authenticated as, and the listener it acts for.
#[derive(Debug, Clone)]
pub(crate) struct AgentCaller {
    scopes: Vec<AgentScope>,
    user: AuthUser,
}

impl AgentCaller {
    fn allows(&self, scope: AgentScope) -> bool {
        self.scopes.contains(&scope)
    }
}

async fn resolve_agent_token(state: &AppState, secret: &str) -> Option<AgentCaller> {
    let lookup_key = agent_token_lookup_key(secret);
    let token = state
        .agent_tokens
        .read()
        .await
        .tokens
        .iter()
        .find(|token| token.token_hash == lookup_key)
        .cloned()?;
    let user = state
        .users
        .read()
        .await
        .users
        .iter()
        .find(|user| user.id == token.user_id)
        .map(AuthUser::from)?;

    let now = unix_now_millis();
    if token
        .last_used_at_ms
        .is_none_or(|last| now.saturating_sub(last) >= LAST_USED_RESOLUTION_MS)
    {
        let recorded = state
            .agent_tokens
            .mutate(|store| {
                if let Some(stored) = store.tokens.iter_mut().find(|stored| stored.id == token.id) {
                    stored.last_used_at_ms = Some(now);
                }
                Ok(())
            })
            .await;
        if let Err(error) = recorded {
            tracing::warn!("failed to record agent token use: {}", error.message);
        }
    }

    Some(AgentCaller {
        scopes: token.scopes,
        user,
    })
}

fn agent_unauthorized(message: &str) -> Response {
    let mut response = ApiError::unauthorized(message).into_response();
    response.headers_mut().insert(
        axum::http::header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"OperaLibre agent access\""),
    );
    response
}

/// Accepts an agent token in `Authorization: Bearer` and nothing else: no
/// cookie, so a browser cannot be steered into calling it, and no query
/// token, so the secret never lands in a URL or a log.
pub(crate) async fn agent_auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    if !state.agent_tokens.read().await.enabled {
        return ApiError::forbidden(AGENT_ACCESS_OFF).into_response();
    }
    let Some(secret) = token_from_authorization(req.headers())
        .filter(|token| token.starts_with(AGENT_TOKEN_PREFIX))
    else {
        return agent_unauthorized(
            "Agent access needs an agent token from Settings, sent as Authorization: Bearer.",
        );
    };
    let Some(caller) = resolve_agent_token(&state, &secret).await else {
        return agent_unauthorized("This agent token was removed or is not valid.");
    };
    req.extensions_mut().insert(caller);
    next.run(req).await
}

// ---------------------------------------------------------------------------
// Model Context Protocol
// ---------------------------------------------------------------------------
//
// The Streamable HTTP transport, answered with plain JSON: every tool is a
// quick read, so there is nothing to stream and no session to keep. Clients
// that open a GET event stream are told 405, which the transport allows.

const MCP_PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const MCP_INSTRUCTIONS: &str = "OperaLibre is the listener's own private audiobook server. Everything here is read-only. When recommending what to read next, get_series_progress shows where the listener is in each series. When recapping a book, use only the text get_text_so_far returns: it stops exactly where the listener is. Do not add plot details from your own knowledge of the book or its series, because that could spoil what they have not heard yet. Book ids come from search_library, get_currently_listening, and the history tools.";

pub(crate) async fn mcp_endpoint(
    State(state): State<AppState>,
    Extension(caller): Extension<AgentCaller>,
    body: Bytes,
) -> Response {
    let message: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(rpc_error(serde_json::Value::Null, -32700, "Parse error")),
            )
                .into_response();
        }
    };
    let Some(object) = message.as_object() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(rpc_error(
                serde_json::Value::Null,
                -32600,
                "Send one JSON-RPC message per request.",
            )),
        )
            .into_response();
    };
    // Notifications and responses carry no id and expect no answer.
    let (Some(id), Some(method)) = (
        object.get("id").cloned(),
        object.get("method").and_then(|method| method.as_str()),
    ) else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = object
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let reply = match method {
        "initialize" => rpc_result(id, initialize_result(&params)),
        "ping" => rpc_result(id, serde_json::json!({})),
        "tools/list" => rpc_result(id, serde_json::json!({ "tools": tool_list(&caller) })),
        "tools/call" => {
            let name = params.get("name").and_then(|name| name.as_str());
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match name.and_then(|name| AgentTool::named(name, &caller)) {
                None => rpc_error(id, -32602, "Unknown tool, or one this agent may not use."),
                Some(tool) => rpc_result(
                    id,
                    tool_result(tool.call(&state, &caller, &arguments).await),
                ),
            }
        }
        _ => rpc_error(id, -32601, "Method not found"),
    };
    Json(reply).into_response()
}

fn initialize_result(params: &serde_json::Value) -> serde_json::Value {
    let requested = params
        .get("protocolVersion")
        .and_then(|version| version.as_str());
    let version = requested
        .filter(|version| MCP_PROTOCOL_VERSIONS.contains(version))
        .unwrap_or(MCP_PROTOCOL_VERSIONS[0]);
    serde_json::json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": "operalibre",
            "title": "OperaLibre",
            "version": updates::current_version(),
        },
        "instructions": MCP_INSTRUCTIONS,
    })
}

fn rpc_result(id: serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: serde_json::Value, code: i64, message: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// A tool failure the agent should read and recover from, rather than a
/// protocol error.
type ToolOutcome = Result<serde_json::Value, String>;

fn tool_result(outcome: ToolOutcome) -> serde_json::Value {
    match outcome {
        // The text copy is for clients from before structured results.
        Ok(value) => serde_json::json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "structuredContent": value,
            "isError": false,
        }),
        Err(message) => serde_json::json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true,
        }),
    }
}

fn tool_failure(error: ApiError) -> String {
    if error.status == StatusCode::INTERNAL_SERVER_ERROR {
        tracing::error!(error = %error.message, "agent tool failed");
        "The server could not answer that. Try again later.".to_string()
    } else {
        error.message
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentTool {
    SearchLibrary,
    GetBook,
    GetCurrentlyListening,
    GetListeningSessions,
    GetFinishedBooks,
    GetListeningStats,
    GetAchievements,
    GetSeriesProgress,
    GetTextSoFar,
}

impl AgentTool {
    const ALL: [AgentTool; 9] = [
        AgentTool::SearchLibrary,
        AgentTool::GetBook,
        AgentTool::GetSeriesProgress,
        AgentTool::GetCurrentlyListening,
        AgentTool::GetListeningSessions,
        AgentTool::GetFinishedBooks,
        AgentTool::GetListeningStats,
        AgentTool::GetAchievements,
        AgentTool::GetTextSoFar,
    ];

    fn name(self) -> &'static str {
        match self {
            AgentTool::SearchLibrary => "search_library",
            AgentTool::GetBook => "get_book",
            AgentTool::GetCurrentlyListening => "get_currently_listening",
            AgentTool::GetListeningSessions => "get_listening_sessions",
            AgentTool::GetFinishedBooks => "get_finished_books",
            AgentTool::GetListeningStats => "get_listening_stats",
            AgentTool::GetAchievements => "get_achievements",
            AgentTool::GetSeriesProgress => "get_series_progress",
            AgentTool::GetTextSoFar => "get_text_so_far",
        }
    }

    fn scope(self) -> AgentScope {
        match self {
            AgentTool::SearchLibrary | AgentTool::GetBook | AgentTool::GetSeriesProgress => {
                AgentScope::Library
            }
            AgentTool::GetCurrentlyListening => AgentScope::Progress,
            AgentTool::GetListeningSessions
            | AgentTool::GetFinishedBooks
            | AgentTool::GetListeningStats
            | AgentTool::GetAchievements => AgentScope::History,
            AgentTool::GetTextSoFar => AgentScope::Text,
        }
    }

    fn named(name: &str, caller: &AgentCaller) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|tool| tool.name() == name && caller.allows(tool.scope()))
    }

    fn definition(self, caller: &AgentCaller) -> serde_json::Value {
        let (title, description, properties, required): (&str, String, serde_json::Value, &[&str]) =
            match self {
                AgentTool::SearchLibrary => (
                    "Search the library",
                    format!(
                        "List books on the listener's server, optionally filtered. Every filter is a case-insensitive substring match.{}",
                        if caller.allows(AgentScope::Progress) {
                            " Each book includes the listener's status and percent complete."
                        } else {
                            ""
                        }
                    ),
                    serde_json::json!({
                        "query": { "type": "string", "description": "Matches title, author, narrator, series, genres, or tags." },
                        "author": { "type": "string" },
                        "series": { "type": "string" },
                        "genre": { "type": "string" },
                        "status": {
                            "type": "string",
                            "enum": ["notStarted", "inProgress", "finished"],
                            "description": "Only books in this state for the listener. Needs progress access.",
                        },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
                        "offset": { "type": "integer", "minimum": 0, "default": 0 },
                    }),
                    &[],
                ),
                AgentTool::GetBook => (
                    "Get a book",
                    "One book's full details: description, publisher, series, tags, and chapters. Chapter titles past the listener's position are left out so they cannot spoil anything.".to_string(),
                    serde_json::json!({ "bookId": { "type": "string" } }),
                    &["bookId"],
                ),
                AgentTool::GetCurrentlyListening => (
                    "Currently listening",
                    "Books the listener has started and not finished, most recently played first, with their current chapter and time remaining.".to_string(),
                    serde_json::json!({
                        "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
                    }),
                    &[],
                ),
                AgentTool::GetListeningSessions => (
                    "Listening sessions",
                    "The listener's sittings, newest first: which book, when, for how long, and how far through it they got.".to_string(),
                    serde_json::json!({
                        "since": { "type": "string", "description": "Earliest day to include, YYYY-MM-DD." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 },
                    }),
                    &[],
                ),
                AgentTool::GetFinishedBooks => (
                    "Finished books",
                    "Every book the listener has finished, newest first, as it was when they finished it. Use it for reading history, series tracking, and recommendations.".to_string(),
                    serde_json::json!({
                        "since": { "type": "string", "description": "Earliest day to include, YYYY-MM-DD." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    }),
                    &[],
                ),
                AgentTool::GetListeningStats => (
                    "Listening stats",
                    "Totals, streaks, favorite narrator and genre, and recent daily listening minutes.".to_string(),
                    serde_json::json!({
                        "tzOffsetMinutes": { "type": "integer", "description": "The listener's offset from UTC in minutes, east positive, so days and streaks are theirs." },
                    }),
                    &[],
                ),
                AgentTool::GetTextSoFar => (
                    "Text so far",
                    "The book's text from the start up to the exact sentence the listener has reached, for a spoiler-free recap. Nothing past their position is ever returned. Only books with a follow-along map have this. Returns the latest chapter by default; pass chapter to read an earlier one.".to_string(),
                    serde_json::json!({
                        "bookId": { "type": "string" },
                        "chapter": { "type": "integer", "minimum": 0, "description": "A chapter index from the chapters list this tool returns." },
                        "maxCharacters": { "type": "integer", "minimum": 1000, "maximum": 200000, "default": 30000, "description": "A longer chapter keeps its most recent text." },
                    }),
                    &["bookId"],
                ),
                AgentTool::GetAchievements => (
                    "Achievements",
                    "The listener's achievements, as their profile shows them: each milestone with how far they are toward it and whether it is earned.".to_string(),
                    serde_json::json!({
                        "tzOffsetMinutes": { "type": "integer", "description": "The listener's offset from UTC in minutes, east positive, so listening streaks count their days." },
                    }),
                    &[],
                ),
                AgentTool::GetSeriesProgress => (
                    "Series progress",
                    format!(
                        "Each series on the server with its books in order and the positions the server is missing.{}",
                        if caller.allows(AgentScope::Progress) {
                            " Includes how many the listener has finished and the book to read next, most recently listened series first."
                        } else {
                            ""
                        }
                    ),
                    serde_json::json!({
                        "series": { "type": "string", "description": "Only series whose name contains this, case-insensitively." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
                    }),
                    &[],
                ),
            };
        serde_json::json!({
            "name": self.name(),
            "title": title,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
            "annotations": {
                "title": title,
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false,
            },
        })
    }

    async fn call(
        self,
        state: &AppState,
        caller: &AgentCaller,
        arguments: &serde_json::Value,
    ) -> ToolOutcome {
        match self {
            AgentTool::SearchLibrary => search_library(state, caller, arguments).await,
            AgentTool::GetBook => get_book(state, caller, arguments).await,
            AgentTool::GetCurrentlyListening => {
                get_currently_listening(state, caller, arguments).await
            }
            AgentTool::GetListeningSessions => {
                get_listening_sessions(state, caller, arguments).await
            }
            AgentTool::GetFinishedBooks => get_finished_books(state, caller, arguments).await,
            AgentTool::GetListeningStats => get_listening_stats(state, caller, arguments).await,
            AgentTool::GetAchievements => get_achievements(state, caller, arguments).await,
            AgentTool::GetSeriesProgress => get_series_progress(state, caller, arguments).await,
            AgentTool::GetTextSoFar => get_text_so_far(state, caller, arguments).await,
        }
    }
}

fn tool_list(caller: &AgentCaller) -> Vec<serde_json::Value> {
    AgentTool::ALL
        .into_iter()
        .filter(|tool| caller.allows(tool.scope()))
        .map(|tool| tool.definition(caller))
        .collect()
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

fn string_argument(arguments: &serde_json::Value, name: &str) -> Option<String> {
    arguments
        .get(name)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn count_argument(arguments: &serde_json::Value, name: &str, default: usize, max: usize) -> usize {
    arguments
        .get(name)
        .and_then(|value| value.as_u64())
        .map(|value| usize::try_from(value).unwrap_or(max))
        .unwrap_or(default)
        .min(max)
}

fn book_id_argument(arguments: &serde_json::Value) -> Result<String, String> {
    string_argument(arguments, "bookId").ok_or_else(|| "bookId is required.".to_string())
}

fn since_argument(arguments: &serde_json::Value) -> Result<Option<String>, String> {
    let since = string_argument(arguments, "since");
    if since
        .as_deref()
        .is_some_and(|day| ymd_to_days(day).is_none())
    {
        return Err("since must be a day written YYYY-MM-DD.".to_string());
    }
    Ok(since)
}

fn rounded(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (value * scale).round() / scale
}

fn hours(seconds: f64) -> f64 {
    rounded(seconds / 3_600.0, 1)
}

fn minutes(seconds: f64) -> f64 {
    rounded(seconds / 60.0, 1)
}

fn book_status(book: &Book) -> BookProgressStatus {
    book.progress
        .as_ref()
        .map_or(BookProgressStatus::NotStarted, |progress| progress.status)
}

/// A status argument, by the name the tools report it under.
fn status_named(name: &str) -> Option<BookProgressStatus> {
    [
        BookProgressStatus::NotStarted,
        BookProgressStatus::InProgress,
        BookProgressStatus::Finished,
    ]
    .into_iter()
    .find(|status| serde_json::json!(status) == name)
}

/// How far into the book the listener has heard. Only finishing a book on
/// purpose unlocks all of it: progress also counts a book finished in its last
/// thirty seconds or half a percent, and in a long book that is minutes of
/// ending the listener has not heard.
fn heard_through(progress: &BookProgress) -> f64 {
    if progress.finished_override == Some(true) {
        f64::INFINITY
    } else {
        progress.book_position_seconds
    }
}

fn add_position(details: &mut serde_json::Value, progress: &BookProgress) {
    details["positionMinutes"] = minutes(progress.book_position_seconds).into();
    details["remainingHours"] = progress.remaining_seconds.map(hours).into();
}

fn progress_instant(updated_at: &str) -> String {
    rfc3339_utc(progress_timestamp_millis(updated_at) / 1_000)
}

/// The chapter a book-absolute position falls in, by index into `chapters`.
fn chapter_index_at(chapters: &[Chapter], seconds: f64) -> Option<usize> {
    chapters
        .partition_point(|chapter| chapter.start_seconds <= seconds)
        .checked_sub(1)
}

fn book_summary(book: &Book, caller: &AgentCaller) -> serde_json::Value {
    let mut summary = serde_json::json!({
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "narrator": book.narrator,
        "series": book.metadata.series,
        "seriesPosition": book.metadata.series_position,
        "genres": book.genres,
        "publishedDate": book.published_date,
        "durationHours": book.duration_seconds.map(hours),
        "recapAvailable": book.sync_file.is_some(),
    });
    if caller.allows(AgentScope::Progress) {
        let progress = book.progress.as_ref();
        summary["status"] = serde_json::json!(book_status(book));
        summary["percentComplete"] = progress
            .and_then(|progress| progress.percent_complete)
            .map(|percent| rounded(percent, 1))
            .into();
        summary["lastListenedAt"] = progress
            .map(|progress| progress_instant(&progress.updated_at))
            .into();
    }
    summary
}

/// The listener's books, with their own progress when the token may see it.
async fn caller_books(state: &AppState, caller: &AgentCaller) -> Result<Vec<Book>, String> {
    caller_books_where(state, caller, |_| true).await
}

/// The listener's books `keep` accepts, filtered before progress is looked up
/// so a narrow search does not pay for the whole library.
async fn caller_books_where(
    state: &AppState,
    caller: &AgentCaller,
    keep: impl Fn(&Book) -> bool,
) -> Result<Vec<Book>, String> {
    ensure_startup_scan_finished(state)
        .await
        .map_err(tool_failure)?;
    let books = visible_books_where(state, &caller.user, keep).await;
    if caller.allows(AgentScope::Progress) {
        enrich_books_with_progress(state, &caller.user, books)
            .await
            .map_err(tool_failure)
    } else {
        Ok(books)
    }
}

async fn caller_book(
    state: &AppState,
    caller: &AgentCaller,
    book_id: &str,
    with_progress: bool,
) -> Result<Book, String> {
    // Restricted books answer exactly as missing ones do, as on every route.
    let missing = || "No book with that id. Use search_library to find one.".to_string();
    if !can_access_book(&caller.user, book_id) {
        return Err(missing());
    }
    let book = state
        .library
        .read()
        .await
        .book(book_id)
        .cloned()
        .map_err(|_| missing())?;
    if with_progress {
        book_with_progress(state, &caller.user, book)
            .await
            .map_err(tool_failure)
    } else {
        Ok(book)
    }
}

fn contains_folded(haystack: Option<&str>, needle: &str) -> bool {
    haystack.is_some_and(|value| value.to_lowercase().contains(needle))
}

async fn search_library(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let status = match string_argument(arguments, "status") {
        None => None,
        Some(_) if !caller.allows(AgentScope::Progress) => {
            return Err(
                "This agent may not see listening progress, so it cannot filter by status.".into(),
            );
        }
        Some(name) => {
            Some(status_named(&name).ok_or("status must be notStarted, inProgress, or finished.")?)
        }
    };
    let fold = |name| string_argument(arguments, name).map(|value| value.to_lowercase());
    let (query, author, series, genre) =
        (fold("query"), fold("author"), fold("series"), fold("genre"));
    let limit = count_argument(arguments, "limit", 25, 100).max(1);
    let offset = count_argument(arguments, "offset", 0, usize::MAX);

    let books = caller_books_where(state, caller, |book| {
        query.as_deref().is_none_or(|query| {
            contains_folded(Some(&book.title), query)
                || contains_folded(book.author.as_deref(), query)
                || contains_folded(book.narrator.as_deref(), query)
                || contains_folded(book.metadata.series.as_deref(), query)
                || book
                    .genres
                    .iter()
                    .any(|genre| contains_folded(Some(genre), query))
                || book
                    .tags
                    .iter()
                    .any(|tag| contains_folded(Some(&tag.name), query))
        }) && author
            .as_deref()
            .is_none_or(|author| contains_folded(book.author.as_deref(), author))
            && series.as_deref().is_none_or(|series| {
                contains_folded(book.metadata.series.as_deref(), series)
                    || book
                        .tags
                        .iter()
                        .any(|tag| contains_folded(Some(&tag.name), series))
            })
            && genre.as_deref().is_none_or(|genre| {
                book.genres
                    .iter()
                    .any(|candidate| contains_folded(Some(candidate), genre))
            })
    })
    .await?;
    let matches: Vec<&Book> = books
        .iter()
        .filter(|book| status.is_none_or(|status| book_status(book) == status))
        .collect();
    Ok(serde_json::json!({
        "total": matches.len(),
        "offset": offset,
        "books": matches
            .iter()
            .skip(offset)
            .take(limit)
            .map(|book| book_summary(book, caller))
            .collect::<Vec<_>>(),
    }))
}

async fn get_book(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let book_id = book_id_argument(arguments)?;
    let with_progress = caller.allows(AgentScope::Progress);
    let book = caller_book(state, caller, &book_id, with_progress).await?;
    let mut details = book_summary(&book, caller);
    details["subtitle"] = book.metadata.subtitle.clone().into();
    details["description"] = book.description.clone().into();
    details["publisher"] = book.metadata.publisher.clone().into();
    details["language"] = book.metadata.language.clone().into();
    details["asin"] = book.asin.clone().into();
    details["tags"] = serde_json::to_value(&book.tags).unwrap_or_default();
    details["chapterCount"] = book.chapters.len().into();

    // Chapter titles are listed only as far as the listener has got: a title
    // like "The Betrayal" is a spoiler too. Without progress there is no way
    // to know how far that is, so none are listed.
    let progress = book.progress.as_ref().filter(|_| with_progress);
    let reached = progress.map_or(0, |progress| {
        chapter_index_at(&book.chapters, heard_through(progress)).map_or(0, |index| index + 1)
    });
    details["chapters"] = book
        .chapters
        .iter()
        .take(reached)
        .enumerate()
        .map(|(index, chapter)| {
            serde_json::json!({
                "index": index,
                "title": chapter.title,
                "startMinutes": minutes(chapter.start_seconds),
            })
        })
        .collect::<Vec<_>>()
        .into();
    if let Some(progress) = progress {
        add_position(&mut details, progress);
    }
    Ok(details)
}

async fn get_currently_listening(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let limit = count_argument(arguments, "limit", 10, 50).max(1);
    let mut books: Vec<Book> = caller_books(state, caller)
        .await?
        .into_iter()
        .filter(|book| book_status(book) == BookProgressStatus::InProgress)
        .collect();
    books.sort_by_key(|book| {
        std::cmp::Reverse(book.progress.as_ref().map_or(0, |progress| {
            progress_timestamp_millis(&progress.updated_at)
        }))
    });
    Ok(serde_json::json!({
        "books": books
            .iter()
            .take(limit)
            .map(|book| {
                let mut summary = book_summary(book, caller);
                if let Some(progress) = &book.progress {
                    summary["currentChapter"] =
                        chapter_index_at(&book.chapters, progress.book_position_seconds)
                            .map(|index| book.chapters[index].title.clone())
                            .into();
                    add_position(&mut summary, progress);
                }
                summary
            })
            .collect::<Vec<_>>(),
    }))
}

/// Titles for the books a history row names: the library's copy when the
/// listener can still see the book, otherwise how it was when they finished
/// it. A book they never finished and can no longer see stays an id.
struct HistoryTitles {
    library: HashMap<String, (String, Option<String>, Option<f64>)>,
    finished: HashMap<String, (String, Option<String>)>,
}

impl HistoryTitles {
    async fn load(state: &AppState, caller: &AgentCaller) -> Self {
        let library = state
            .library
            .read()
            .await
            .books
            .iter()
            .filter(|book| can_access_book(&caller.user, &book.id))
            .map(|book| {
                (
                    book.id.clone(),
                    (
                        book.title.clone(),
                        book.author.clone(),
                        book.duration_seconds,
                    ),
                )
            })
            .collect();
        let finished = state
            .reading_history
            .read()
            .await
            .completions
            .iter()
            .filter(|completion| completion.user_id == caller.user.id)
            .map(|completion| {
                (
                    completion.book_id.clone(),
                    (
                        completion.snapshot.title.clone(),
                        completion.snapshot.author.clone(),
                    ),
                )
            })
            .collect();
        Self { library, finished }
    }

    fn describe(&self, book_id: &str) -> (Option<String>, Option<String>, Option<f64>) {
        if let Some((title, author, duration)) = self.library.get(book_id) {
            return (Some(title.clone()), author.clone(), *duration);
        }
        match self.finished.get(book_id) {
            Some((title, author)) => (Some(title.clone()), author.clone(), None),
            None => (None, None, None),
        }
    }
}

async fn get_listening_sessions(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let query = ReadingLogQuery {
        limit: Some(count_argument(arguments, "limit", 50, 500).max(1)),
        since: since_argument(arguments)?,
    };
    let Json(sessions) = reading_log_sessions(
        State(state.clone()),
        Extension(caller.user.clone()),
        Query(query),
    )
    .await;
    let titles = HistoryTitles::load(state, caller).await;
    let percent = |seconds: f64, duration: Option<f64>| {
        duration
            .filter(|duration| *duration > 0.0)
            .map(|duration| rounded((seconds / duration * 100.0).clamp(0.0, 100.0), 1))
    };
    Ok(serde_json::json!({
        "sessions": sessions
            .iter()
            .map(|session| {
                let (title, author, duration) = titles.describe(&session.book_id);
                serde_json::json!({
                    "bookId": session.book_id,
                    "title": title,
                    "author": author,
                    "day": session.started_on,
                    "startedAt": rfc3339_utc(session.started_at_ms / 1_000),
                    "endedAt": rfc3339_utc(session.ended_at_ms / 1_000),
                    "minutesListened": minutes(session.listened_seconds),
                    "fromPercent": percent(session.start_position_seconds, duration),
                    "toPercent": percent(session.end_position_seconds, duration),
                    "speed": session.speed,
                    "client": session.client,
                })
            })
            .collect::<Vec<_>>(),
    }))
}

async fn get_finished_books(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let query = ReadingLogQuery {
        limit: Some(count_argument(arguments, "limit", 100, 1_000).max(1)),
        since: since_argument(arguments)?,
    };
    let Json(completions) = reading_log_completions(
        State(state.clone()),
        Extension(caller.user.clone()),
        Query(query),
    )
    .await;
    Ok(serde_json::json!({
        "finished": completions
            .iter()
            .map(|completion| {
                let snapshot = &completion.snapshot;
                serde_json::json!({
                    "bookId": completion.book_id,
                    "title": snapshot.title,
                    "author": snapshot.author,
                    "narrator": snapshot.narrator,
                    "series": snapshot.series,
                    "seriesPosition": snapshot.series_position,
                    "genres": snapshot.genres,
                    "publishedDate": snapshot.published_date,
                    "durationHours": snapshot.duration_seconds.map(hours),
                    "finishedOn": completion.finished_on,
                    "markedFinished": completion.source == CompletionSource::Marked,
                })
            })
            .collect::<Vec<_>>(),
    }))
}

async fn get_listening_stats(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let stats = caller_stats(state, caller, arguments).await?;
    let mut stats = serde_json::to_value(stats).map_err(|error| tool_failure(error.into()))?;
    // Cover links carry a media path; an agent has no use for one.
    if let Some(recent) = stats["recentBooks"].as_array_mut() {
        for book in recent {
            if let Some(book) = book.as_object_mut() {
                book.remove("coverArtUrl");
            }
        }
    }
    Ok(stats)
}

async fn caller_stats(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> Result<ProfileStats, String> {
    let tz_offset_minutes = arguments
        .get("tzOffsetMinutes")
        .and_then(|value| value.as_i64())
        .and_then(|value| i32::try_from(value).ok());
    let Json(stats) = profile_stats(
        State(state.clone()),
        Extension(caller.user.clone()),
        Query(ProfileStatsQuery { tz_offset_minutes }),
    )
    .await
    .map_err(tool_failure)?;
    Ok(stats)
}

async fn get_achievements(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    ensure_startup_scan_finished(state)
        .await
        .map_err(tool_failure)?;
    let books = books_with_progress(state, &caller.user)
        .await
        .map_err(tool_failure)?;
    let stats = caller_stats(state, caller, arguments).await?;
    let achievements = reading_achievements(&books, &stats);
    Ok(serde_json::json!({
        "earned": achievements.iter().filter(|achievement| achievement["earned"] == true).count(),
        "total": achievements.len(),
        "achievements": achievements,
    }))
}

/// The achievements on the listener's profile. This mirrors
/// `readingAchievements` in apps/web/src/readingAchievements.ts, which the
/// app keeps for itself because it also runs offline and against Jellyfin;
/// change the two together.
fn reading_achievements(books: &[Book], stats: &ProfileStats) -> Vec<serde_json::Value> {
    let finished: Vec<&Book> = books
        .iter()
        .filter(|book| book_status(book) == BookProgressStatus::Finished)
        .collect();
    let duration = |book: &Book| {
        book.duration_seconds
            .filter(|seconds| seconds.is_finite())
            .unwrap_or(0.0)
            .max(0.0)
    };
    let longest = finished.iter().copied().reduce(|longest, book| {
        if duration(book) > duration(longest) {
            book
        } else {
            longest
        }
    });
    let longest_hours = longest.map_or(0.0, |book| duration(book) / 3_600.0);
    let authors = most_finished(&finished, |book| book.author.iter().cloned().collect());
    let narrators = most_finished(&finished, |book| book.narrator.iter().cloned().collect());
    let genres = most_finished(&finished, |book| book.genres.clone());
    let series = most_finished(&finished, |book| {
        book.metadata.series.iter().cloned().collect()
    });

    let mut achievements = Vec::new();
    let mut add = |id: String,
                   title: &str,
                   description: String,
                   category: &str,
                   current: f64,
                   target: u32,
                   unit: &str,
                   evidence: Option<&Book>| {
        let current = if current.is_finite() {
            current.max(0.0)
        } else {
            0.0
        };
        achievements.push(serde_json::json!({
            "id": id,
            "title": title,
            "description": description,
            "category": category,
            "current": rounded(current, 1),
            "target": target,
            "unit": unit,
            "earned": current >= f64::from(target),
            "book": evidence.map(|book| serde_json::json!({ "id": book.id, "title": book.title })),
        }));
    };
    for (target, title) in [
        (1, "The first of many"),
        (10, "Shelf made"),
        (25, "Well read"),
        (100, "Living library"),
    ] {
        let description = if target == 1 {
            "Finish your first book.".to_string()
        } else {
            format!("Finish {target} books.")
        };
        add(
            format!("finished-{target}"),
            title,
            description,
            "Milestones",
            finished.len() as f64,
            target,
            "books",
            None,
        );
    }
    for (target, title) in [
        (24, "A day in another world"),
        (48, "The long way home"),
        (72, "Epic endurance"),
    ] {
        add(
            format!("epic-{target}"),
            title,
            format!(
                "Finish a book at least {target} hours long. Original runtime, at any playback speed."
            ),
            "Milestones",
            longest_hours,
            target,
            "hours",
            longest,
        );
    }
    add(
        "authors".into(),
        "Literary passport",
        "Finish books by 5 different authors.".into(),
        "Exploration",
        authors.len() as f64,
        5,
        "authors",
        None,
    );
    add(
        "genres".into(),
        "Beyond your borders",
        "Finish books spanning 5 different genres.".into(),
        "Exploration",
        genres.len() as f64,
        5,
        "genres",
        None,
    );
    fn top<'a>(groups: &[(usize, &'a Book)]) -> (f64, Option<&'a Book>) {
        groups
            .first()
            .map_or((0.0, None), |(count, book)| (*count as f64, Some(*book)))
    }
    let (count, book) = top(&authors);
    add(
        "author-loyalty".into(),
        "An old friend",
        "Finish 3 books by the same author.".into(),
        "Exploration",
        count,
        3,
        "books",
        book,
    );
    let (count, book) = top(&narrators);
    add(
        "narrator-loyalty".into(),
        "A familiar voice",
        "Finish 3 books with the same narrator credit.".into(),
        "Exploration",
        count,
        3,
        "books",
        book,
    );
    let (count, book) = top(&series);
    add(
        "series".into(),
        "Deep in the saga",
        "Finish 3 books in one series.".into(),
        "Exploration",
        count,
        3,
        "books",
        book,
    );
    for (target, title) in [
        (7, "A week of worlds"),
        (30, "Part of the day"),
        (100, "Unbroken thread"),
    ] {
        add(
            format!("streak-{target}"),
            title,
            format!("Listen on {target} consecutive days. Uses your longest recorded streak."),
            "Rituals",
            f64::from(stats.longest_streak_days),
            target,
            "days",
            None,
        );
    }
    for (target, title) in [
        (24, "Time well spent"),
        (100, "Centurion"),
        (500, "A life in stories"),
    ] {
        add(
            format!("listening-{target}"),
            title,
            format!("Log {target} hours of measured listening."),
            "Rituals",
            stats.total_hours_read,
            target,
            "hours",
            None,
        );
    }
    achievements
}

/// How many finished books share each label, most first, with the latest
/// finished book carrying it. Labels compare trimmed and case-insensitively.
fn most_finished<'a>(
    finished: &[&'a Book],
    labels: impl Fn(&Book) -> Vec<String>,
) -> Vec<(usize, &'a Book)> {
    let mut index = HashMap::<String, usize>::new();
    let mut groups: Vec<(usize, &Book)> = Vec::new();
    for book in finished {
        let mut seen = HashSet::new();
        for label in labels(book) {
            let label = label.trim().to_lowercase();
            if label.is_empty() || !seen.insert(label.clone()) {
                continue;
            }
            match index.get(&label) {
                Some(&at) => groups[at] = (groups[at].0 + 1, book),
                None => {
                    index.insert(label, groups.len());
                    groups.push((1, book));
                }
            }
        }
    }
    // Stable, so ties keep the label finished first.
    groups.sort_by_key(|(count, _)| std::cmp::Reverse(*count));
    groups
}

/// A series position as a number to order by: "2", "2.5", and "Book 2" all
/// count; anything without a number sorts last.
fn series_order(position: Option<&str>) -> Option<f64> {
    position?
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|part| !part.is_empty())
        .and_then(|part| part.parse().ok())
}

struct SeriesProgress<'a> {
    name: String,
    /// In reading order.
    books: Vec<&'a Book>,
    /// Whole-number positions below the highest one that no book here holds.
    missing_positions: Vec<u32>,
    /// The book in progress, or else the first unfinished one after the last
    /// finished one. `None` for a series not started or already done.
    next: Option<&'a Book>,
}

/// Group books by their series, in reading order.
fn series_progress(books: &[Book]) -> Vec<SeriesProgress<'_>> {
    let mut index = HashMap::<String, usize>::new();
    let mut groups: Vec<(String, Vec<&Book>)> = Vec::new();
    for book in books {
        let Some(name) = book
            .metadata
            .series
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let key = name.to_lowercase();
        match index.get(&key) {
            Some(&at) => groups[at].1.push(book),
            None => {
                index.insert(key, groups.len());
                groups.push((name.to_string(), vec![book]));
            }
        }
    }
    groups
        .into_iter()
        .map(|(name, mut books)| {
            books.sort_by(|left, right| {
                let order = |book: &Book| series_order(book.metadata.series_position.as_deref());
                match (order(left), order(right)) {
                    (Some(left), Some(right)) => left.total_cmp(&right),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
                .then_with(|| left.title.cmp(&right.title))
            });
            let held: HashSet<u32> = books
                .iter()
                .filter_map(|book| series_order(book.metadata.series_position.as_deref()))
                .filter(|position| {
                    position.fract() == 0.0 && *position >= 1.0 && *position <= 1_000.0
                })
                .map(|position| position as u32)
                .collect();
            let highest = held.iter().copied().max().unwrap_or(0);
            let missing_positions = (1..highest)
                .filter(|position| !held.contains(position))
                .collect();
            let next = books
                .iter()
                .copied()
                .find(|book| book_status(book) == BookProgressStatus::InProgress)
                .or_else(|| {
                    let last_finished = books
                        .iter()
                        .rposition(|book| book_status(book) == BookProgressStatus::Finished)?;
                    books[last_finished + 1..]
                        .iter()
                        .copied()
                        .find(|book| book_status(book) != BookProgressStatus::Finished)
                });
            SeriesProgress {
                name,
                books,
                missing_positions,
                next,
            }
        })
        .collect()
}

async fn get_series_progress(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let filter = string_argument(arguments, "series").map(|series| series.to_lowercase());
    let limit = count_argument(arguments, "limit", 25, 100).max(1);
    let with_progress = caller.allows(AgentScope::Progress);
    let books = caller_books_where(state, caller, |book| {
        book.metadata
            .series
            .as_deref()
            .is_some_and(|series| !series.trim().is_empty())
    })
    .await?;
    let mut series: Vec<SeriesProgress> = series_progress(&books)
        .into_iter()
        .filter(|series| {
            filter
                .as_deref()
                .is_none_or(|filter| series.name.to_lowercase().contains(filter))
        })
        .collect();
    if with_progress {
        let last_listened = |series: &SeriesProgress| {
            series
                .books
                .iter()
                .filter_map(|book| book.progress.as_ref())
                .filter(|progress| progress.status != BookProgressStatus::NotStarted)
                .map(|progress| progress_timestamp_millis(&progress.updated_at))
                .max()
                .unwrap_or(0)
        };
        series.sort_by_cached_key(|series| std::cmp::Reverse(last_listened(series)));
    } else {
        series.sort_by_cached_key(|series| series.name.to_lowercase());
    }
    let total = series.len();
    Ok(serde_json::json!({
        "total": total,
        "series": series
            .iter()
            .take(limit)
            .map(|series| {
                let mut entry = serde_json::json!({
                    "name": series.name,
                    "books": series.books.iter().map(|book| {
                        let mut volume = serde_json::json!({
                            "id": book.id,
                            "title": book.title,
                            "position": book.metadata.series_position,
                        });
                        if with_progress {
                            volume["status"] = serde_json::json!(book_status(book));
                        }
                        volume
                    }).collect::<Vec<_>>(),
                    "missingPositions": series.missing_positions,
                });
                if with_progress {
                    let count = |status| series.books.iter().filter(|book| book_status(book) == status).count();
                    entry["finished"] = count(BookProgressStatus::Finished).into();
                    entry["inProgress"] = count(BookProgressStatus::InProgress).into();
                    entry["next"] = series
                        .next
                        .map(|book| serde_json::json!({ "id": book.id, "title": book.title }))
                        .into();
                }
                entry
            })
            .collect::<Vec<_>>(),
    }))
}

async fn get_text_so_far(
    state: &AppState,
    caller: &AgentCaller,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let book_id = book_id_argument(arguments)?;
    let max_characters = count_argument(arguments, "maxCharacters", 30_000, 200_000).max(1_000);
    let book = caller_book(state, caller, &book_id, true).await?;
    let sync_path = state.library.read().await.sync_paths.get(&book.id).cloned();
    let Some(sync_path) = sync_path else {
        return Err(if book.reading_file.is_some() {
            "This book has its text but no follow-along map yet, so OperaLibre cannot tell exactly where the listener is in it. An administrator can create the map from the book's page.".into()
        } else {
            "This book has no text on the server, so there is nothing to recap from.".into()
        });
    };

    let progress = book.progress.as_ref();
    let finished = progress.is_some_and(|progress| progress.status == BookProgressStatus::Finished);
    let position = progress.map_or(0.0, |progress| progress.book_position_seconds);
    if !finished && position <= 0.0 {
        return Err("The listener has not started this book yet.".into());
    }
    let heard_through = progress.map_or(0.0, heard_through);

    // A long book's map is several megabytes of JSON.
    let map = tokio::task::spawn_blocking(move || -> anyhow::Result<alignment::SyncMap> {
        Ok(serde_json::from_slice(&std::fs::read(&sync_path)?)?)
    })
    .await
    .map_err(|error| tool_failure(ApiError::internal(error.to_string())))?
    .map_err(|error| {
        tool_failure(ApiError::internal(format!(
            "Could not read the sync map: {error}"
        )))
    })?;
    if map
        .precision
        .as_deref()
        .is_some_and(|precision| precision != "sentence")
    {
        return Err("This book's follow-along map is only an estimate, so it cannot mark a safe stopping point. Recreating the map fixes that.".into());
    }

    let mut heard: Vec<&alignment::SyncFragment> = map
        .fragments
        .iter()
        .filter(|fragment| fragment.end_seconds <= heard_through)
        .collect();
    heard.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    if heard.is_empty() {
        return Err("The listener has not reached the first sentence of the text yet.".into());
    }

    let text_chapters = group_heard_text(&book, &heard, heard_through);
    let selected = match arguments.get("chapter").and_then(|value| value.as_u64()) {
        Some(index) => text_chapters
            .iter()
            .find(|chapter| chapter.index as u64 == index)
            .ok_or_else(|| {
                "That chapter has no text the listener has heard yet. Use an index from the chapters list.".to_string()
            })?,
        None => text_chapters.last().expect("heard text forms at least one chapter"),
    };
    let (text, truncated) = tail_characters(&selected.text, max_characters);

    Ok(serde_json::json!({
        "bookId": book.id,
        "title": book.title,
        "author": book.author,
        "finished": finished,
        // Where the text stops already hints at the position; the exact
        // figures are for agents that may also read progress.
        "positionMinutes": (caller.allows(AgentScope::Progress) && heard_through.is_finite())
            .then(|| minutes(position)),
        "percentComplete": progress
            .and_then(|progress| progress.percent_complete)
            .filter(|_| caller.allows(AgentScope::Progress))
            .map(|percent| rounded(percent, 1)),
        "chapters": text_chapters
            .iter()
            .map(|chapter| serde_json::json!({
                "index": chapter.index,
                "title": chapter.title,
                "characters": chapter.text.chars().count(),
                "heardInFull": chapter.complete,
            }))
            .collect::<Vec<_>>(),
        "chapter": {
            "index": selected.index,
            "title": selected.title,
            "heardInFull": selected.complete,
            "truncatedFromStart": truncated,
            "text": text,
        },
    }))
}

struct HeardChapter {
    /// Index into the book's chapters, or 0 for a book without any.
    index: usize,
    title: String,
    text: String,
    complete: bool,
}

/// Gather heard sentences under the audio chapters they fall in. A book
/// without chapters is one stretch named after the book.
fn group_heard_text(
    book: &Book,
    heard: &[&alignment::SyncFragment],
    heard_through: f64,
) -> Vec<HeardChapter> {
    let mut chapters: Vec<HeardChapter> = Vec::new();
    let mut previous_href: Option<&str> = None;
    for fragment in heard {
        let index = chapter_index_at(&book.chapters, fragment.start_seconds).unwrap_or(0);
        if chapters.last().is_none_or(|chapter| chapter.index != index) {
            let (title, complete) = match book.chapters.get(index) {
                Some(chapter) => (
                    chapter.title.clone(),
                    book.chapters
                        .get(index + 1)
                        .map(|next| next.start_seconds)
                        .or(chapter.end_seconds)
                        .or(book.duration_seconds)
                        .is_some_and(|end| end <= heard_through),
                ),
                None => (book.title.clone(), heard_through.is_infinite()),
            };
            chapters.push(HeardChapter {
                index,
                title,
                text: String::new(),
                complete,
            });
            previous_href = None;
        }
        let chapter = chapters.last_mut().expect("a chapter was just pushed");
        if !chapter.text.is_empty() {
            // A new spine document is a new section of the book.
            chapter
                .text
                .push_str(if previous_href == Some(fragment.href.as_str()) {
                    " "
                } else {
                    "\n\n"
                });
        }
        chapter.text.push_str(fragment.text.trim());
        previous_href = Some(&fragment.href);
    }
    chapters
}

/// The last `max` characters of `text`, starting at a word, and whether
/// anything was cut. A recap leans on what was heard most recently.
fn tail_characters(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    let start = text
        .char_indices()
        .nth(count - max)
        .map_or(0, |(offset, _)| offset);
    let tail = &text[start..];
    let tail = tail
        .find(char::is_whitespace)
        .map_or(tail, |space| tail[space..].trim_start());
    (tail.to_string(), true)
}
