//! `ApiError`: the status-and-message error every handler returns.

use crate::*;

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
}

impl ApiError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub(crate) fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    pub(crate) fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    pub(crate) fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: message.into(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    /// A temporary refusal the client should retry, such as a listing asked
    /// for before the startup scan has finished.
    pub(crate) fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }
}

/// What a `503` tells the client to wait before asking again.
pub(crate) const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS: u64 = 5;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let message = if self.status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self.message, "request failed with an internal error");
            "Internal server error.".to_string()
        } else {
            self.message
        };
        let mut response = (
            self.status,
            [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
            Json(serde_json::json!({ "message": message })),
        )
            .into_response();
        if self.status == StatusCode::SERVICE_UNAVAILABLE {
            response.headers_mut().insert(
                axum::http::header::RETRY_AFTER,
                HeaderValue::from(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS),
            );
        }
        response
    }
}

impl From<io::Error> for ApiError {
    fn from(error: io::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl From<axum::http::Error> for ApiError {
    fn from(error: axum::http::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}
