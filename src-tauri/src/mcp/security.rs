use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use subtle::ConstantTimeEq;

const HTTP_RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_HTTP_REQUESTS_PER_WINDOW: usize = 120;
const MAX_HTTP_CONCURRENT_REQUESTS: usize = 16;

#[derive(Clone)]
pub struct BearerToken(String);

impl BearerToken {
    pub fn generate() -> Self {
        let bytes: [u8; 32] = rand::random();
        Self(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn expose_for_management(&self) -> String {
        self.0.clone()
    }

    fn matches(&self, candidate: &str) -> bool {
        self.0.as_bytes().ct_eq(candidate.as_bytes()).into()
    }
}

#[derive(Clone)]
pub struct McpHttpSecurityState {
    token: BearerToken,
    active: Arc<AtomicBool>,
}

impl McpHttpSecurityState {
    pub fn new(token: BearerToken) -> Self {
        Self {
            token,
            active: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn revoke(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn authorizes(&self, candidate: &str) -> bool {
        self.active.load(Ordering::SeqCst) && self.token.matches(candidate)
    }
}

pub async fn require_bearer(
    axum::extract::State(state): axum::extract::State<McpHttpSecurityState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(header_value) = request.headers().get(header::AUTHORIZATION) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(value) = header_value.to_str() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(candidate) = value.strip_prefix("Bearer ") else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !state.authorizes(candidate) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

#[derive(Clone, Default)]
pub struct McpHttpLimitsState {
    inner: Arc<McpHttpLimitsInner>,
}

#[derive(Default)]
struct McpHttpLimitsInner {
    active_requests: AtomicUsize,
    request_times: Mutex<VecDeque<Instant>>,
}

impl McpHttpLimitsState {
    pub fn active_requests(&self) -> usize {
        self.inner.active_requests.load(Ordering::SeqCst)
    }

    fn check_rate_limit(&self, now: Instant) -> Result<(), StatusCode> {
        let mut request_times = self
            .inner
            .request_times
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        while request_times
            .front()
            .is_some_and(|timestamp| now.duration_since(*timestamp) > HTTP_RATE_WINDOW)
        {
            request_times.pop_front();
        }
        if request_times.len() >= MAX_HTTP_REQUESTS_PER_WINDOW {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        request_times.push_back(now);
        Ok(())
    }
}

struct ActiveRequestGuard {
    state: McpHttpLimitsState,
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.state
            .inner
            .active_requests
            .fetch_sub(1, Ordering::SeqCst);
    }
}

pub async fn enforce_http_limits(
    axum::extract::State(state): axum::extract::State<McpHttpLimitsState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Err(status) = state.check_rate_limit(Instant::now()) {
        return status.into_response();
    }
    let previous = state.inner.active_requests.fetch_add(1, Ordering::SeqCst);
    if previous >= MAX_HTTP_CONCURRENT_REQUESTS {
        state.inner.active_requests.fetch_sub(1, Ordering::SeqCst);
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let _guard = ActiveRequestGuard { state };
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_url_safe_without_padding() {
        let token = BearerToken::generate().expose_for_management();
        assert!(token.len() >= 43);
        assert!(!token.contains('='));
        assert!(token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    }

    #[test]
    fn bearer_token_accepts_only_exact_current_token() {
        let token = BearerToken::generate();
        let exposed = token.expose_for_management();
        let state = McpHttpSecurityState::new(token);
        assert!(state.authorizes(&exposed));
        assert!(!state.authorizes("wrong"));
        assert!(!state.authorizes(&format!("{exposed}x")));
    }

    #[test]
    fn revoking_security_state_immediately_rejects_current_token() {
        let token = BearerToken::generate();
        let exposed = token.expose_for_management();
        let state = McpHttpSecurityState::new(token);

        assert!(state.authorizes(&exposed));
        state.revoke();
        assert!(!state.authorizes(&exposed));
    }

    #[test]
    fn http_limits_bound_rate_window_and_report_active_requests() {
        let limits = McpHttpLimitsState::default();
        let now = Instant::now();
        for _ in 0..MAX_HTTP_REQUESTS_PER_WINDOW {
            limits.check_rate_limit(now).expect("within rate limit");
        }
        assert!(matches!(
            limits.check_rate_limit(now),
            Err(StatusCode::TOO_MANY_REQUESTS)
        ));
        assert_eq!(limits.active_requests(), 0);
    }
}
