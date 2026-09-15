use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandBrokerConfig {
    pub max_pending: usize,
    pub max_concurrent: usize,
    pub max_committed_outcomes: usize,
    pub commit_grace_timeout_ms: u64,
}

impl Default for McpCommandBrokerConfig {
    fn default() -> Self {
        Self {
            max_pending: 32,
            max_concurrent: 4,
            max_committed_outcomes: 4,
            commit_grace_timeout_ms: 250,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCommandEnvelope {
    #[serde(rename = "type")]
    pub command_type: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCommandRequestEvent {
    pub request_id: String,
    pub command: ApplicationCommandEnvelope,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCommandCancelEvent {
    pub request_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandResult {
    pub changed: bool,
    pub project_revision: u64,
    pub data: Value,
    #[serde(default)]
    pub warnings: Vec<McpCommandWarning>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandResponse {
    pub request_id: String,
    pub changed: bool,
    pub project_revision: u64,
    pub data: Value,
    #[serde(default)]
    pub warnings: Vec<McpCommandWarning>,
}

impl McpCommandResponse {
    pub fn from_result(request_id: String, result: McpCommandResult) -> Self {
        Self {
            request_id,
            changed: result.changed,
            project_revision: result.project_revision,
            data: result.data,
            warnings: result.warnings,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApplicationCommandResponse {
    Success(McpCommandResult),
    Error(McpCommandError),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationCommandStatus {
    Queued,
    Running,
    AwaitingConfirmation,
    Committing,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCommandProgress {
    pub request_id: String,
    pub status: ApplicationCommandStatus,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpBrokerCompletion {
    pub request_id: String,
    pub response: ApplicationCommandResponse,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpBrokerUpdate {
    Progress {
        request_id: String,
        status: ApplicationCommandStatus,
        stage: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<f64>,
    },
    Complete {
        request_id: String,
        response: ApplicationCommandResponse,
    },
}

impl McpBrokerUpdate {
    pub fn into_progress_or_completion(
        self,
    ) -> Result<ApplicationCommandProgress, McpBrokerCompletion> {
        match self {
            McpBrokerUpdate::Progress {
                request_id,
                status,
                stage,
                message,
                percent,
            } => Ok(ApplicationCommandProgress {
                request_id,
                status,
                stage,
                message,
                percent,
            }),
            McpBrokerUpdate::Complete {
                request_id,
                response,
            } => Err(McpBrokerCompletion {
                request_id,
                response,
            }),
        }
    }
}
