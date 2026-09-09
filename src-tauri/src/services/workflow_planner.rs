use std::collections::{BTreeSet, HashMap, HashSet};

use crate::error::AppError;
use crate::services::workflow_domain::{
    ArtifactKind, PortPayloadKind, WorkflowDefinition, WorkflowPort,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowExecutionPlan {
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub operation_ids: Vec<String>,
    pub output_declaration_ids: Vec<String>,
}

pub fn plan_workflow(workflow: &WorkflowDefinition) -> Result<WorkflowExecutionPlan, AppError> {
    if workflow.format_version != "1" {
        return Err(invalid(format!(
            "unsupported workflow format version: {}",
            workflow.format_version
        )));
    }
    let mut node_kinds = HashMap::new();
    let mut source_ports = HashMap::new();
    let mut target_ports = HashMap::new();
    let mut payloads = HashMap::new();

    for slot in &workflow.input_slots {
        insert_node(&mut node_kinds, &slot.id, "input slot")?;
        insert_ports(
            &mut payloads,
            &slot.id,
            std::slice::from_ref(&slot.output_port),
        )?;
        source_ports.insert(
            slot.id.as_str(),
            HashSet::from([slot.output_port.id.as_str()]),
        );
        target_ports.insert(slot.id.as_str(), HashSet::new());
    }
    for operation in &workflow.operations {
        insert_node(&mut node_kinds, &operation.id, "operation")?;
        if operation.schema_version != "1" {
            return Err(invalid(format!(
                "operation {} uses unsupported adapter version {}",
                operation.id, operation.schema_version
            )));
        }
        insert_ports(&mut payloads, &operation.id, &operation.input_ports)?;
        insert_ports(&mut payloads, &operation.id, &operation.output_ports)?;
        source_ports.insert(
            operation.id.as_str(),
            operation
                .output_ports
                .iter()
                .map(|port| port.id.as_str())
                .collect(),
        );
        target_ports.insert(
            operation.id.as_str(),
            operation
                .input_ports
                .iter()
                .map(|port| port.id.as_str())
                .collect(),
        );
    }
    for output in &workflow.output_declarations {
        insert_node(&mut node_kinds, &output.id, "output declaration")?;
        insert_ports(
            &mut payloads,
            &output.id,
            &[output.input_port.clone(), output.output_port.clone()],
        )?;
        let expected_payload = artifact_payload_kind(&output.artifact_kind);
        if output.input_port.payload_kind != expected_payload
            || output.output_port.payload_kind != expected_payload
        {
            return Err(invalid(format!(
                "output declaration {} payload does not match its artifact kind",
                output.id
            )));
        }
        source_ports.insert(
            output.id.as_str(),
            HashSet::from([output.output_port.id.as_str()]),
        );
        target_ports.insert(
            output.id.as_str(),
            HashSet::from([output.input_port.id.as_str()]),
        );
    }

    let mut indegree = node_kinds
        .keys()
        .map(|id| (id.as_str(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let mut incoming_ports: HashMap<(&str, &str), usize> = HashMap::new();
    let mut edge_ids = HashSet::new();
    for edge in &workflow.edges {
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(invalid(format!("duplicate workflow edge id: {}", edge.id)));
        }
        let source = edge.source.node_id.as_str();
        let target = edge.target.node_id.as_str();
        let valid_source_ports = source_ports.get(source).ok_or_else(|| {
            invalid(format!(
                "workflow edge {} has unknown source node {source}",
                edge.id
            ))
        })?;
        if !valid_source_ports.contains(edge.source.port_id.as_str()) {
            return Err(invalid(format!(
                "workflow edge {} has unknown source port {}",
                edge.id, edge.source.port_id
            )));
        }
        let valid_target_ports = target_ports.get(target).ok_or_else(|| {
            invalid(format!(
                "workflow edge {} has unknown target node {target}",
                edge.id
            ))
        })?;
        if !valid_target_ports.contains(edge.target.port_id.as_str()) {
            return Err(invalid(format!(
                "workflow edge {} has unknown target port {}",
                edge.id, edge.target.port_id
            )));
        }
        let source_payload = payloads
            .get(&(source.to_string(), edge.source.port_id.clone()))
            .ok_or_else(|| invalid(format!("workflow edge {} has no source payload", edge.id)))?;
        let target_payload = payloads
            .get(&(target.to_string(), edge.target.port_id.clone()))
            .ok_or_else(|| invalid(format!("workflow edge {} has no target payload", edge.id)))?;
        if source_payload != &PortPayloadKind::Any
            && target_payload != &PortPayloadKind::Any
            && source_payload != target_payload
        {
            return Err(invalid(format!(
                "workflow edge {} has incompatible payload kinds",
                edge.id
            )));
        }
        let count = incoming_ports
            .entry((target, edge.target.port_id.as_str()))
            .or_default();
        *count += 1;
        if *count > 1 {
            return Err(invalid(format!(
                "workflow input {target}:{} has multiple producers",
                edge.target.port_id
            )));
        }
        if outgoing.entry(source).or_default().insert(target) {
            *indegree.get_mut(target).ok_or_else(|| {
                invalid(format!(
                    "workflow edge {} has unknown target node {target}",
                    edge.id
                ))
            })? += 1;
        }
    }

    for output in &workflow.output_declarations {
        let matches_source = workflow.edges.iter().any(|edge| {
            edge.target.node_id == output.id
                && edge.target.port_id == output.input_port.id
                && edge.source == output.source_endpoint
        });
        if !matches_source {
            return Err(invalid(format!(
                "output declaration {} is not connected to its source endpoint",
                output.id
            )));
        }
    }

    let mut ready = indegree
        .iter()
        .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
        .collect::<BTreeSet<_>>();
    let mut ordered = Vec::with_capacity(node_kinds.len());
    while let Some(id) = ready.pop_first() {
        ordered.push(id);
        if let Some(targets) = outgoing.get(id) {
            for target in targets {
                let degree = indegree
                    .get_mut(target)
                    .ok_or_else(|| invalid(format!("unknown workflow node {target}")))?;
                *degree -= 1;
                if *degree == 0 {
                    ready.insert(target);
                }
            }
        }
    }

    if ordered.len() != node_kinds.len() {
        let mut involved = indegree
            .into_iter()
            .filter_map(|(id, degree)| (degree > 0).then_some(id))
            .collect::<Vec<_>>();
        involved.sort_unstable();
        return Err(invalid(format!(
            "workflow cycle involves nodes: {}",
            involved.join(", ")
        )));
    }

    let operation_ids = ordered
        .into_iter()
        .filter(|id| node_kinds.get(*id) == Some(&"operation"))
        .map(str::to_string)
        .collect();
    let mut output_declaration_ids = workflow
        .output_declarations
        .iter()
        .map(|output| output.id.clone())
        .collect::<Vec<_>>();
    output_declaration_ids.sort();

    Ok(WorkflowExecutionPlan {
        workflow_id: workflow.id.clone(),
        workflow_revision: workflow.revision,
        operation_ids,
        output_declaration_ids,
    })
}

fn insert_ports(
    payloads: &mut HashMap<(String, String), PortPayloadKind>,
    node_id: &str,
    ports: &[WorkflowPort],
) -> Result<(), AppError> {
    for port in ports {
        if port.id.trim().is_empty() {
            return Err(invalid(format!(
                "workflow node {node_id} has an empty port id"
            )));
        }
        if payloads
            .insert(
                (node_id.to_string(), port.id.clone()),
                port.payload_kind.clone(),
            )
            .is_some()
        {
            return Err(invalid(format!(
                "workflow node {node_id} has duplicate port id {}",
                port.id
            )));
        }
    }
    Ok(())
}

fn artifact_payload_kind(kind: &ArtifactKind) -> PortPayloadKind {
    match kind {
        ArtifactKind::Table => PortPayloadKind::Table,
        ArtifactKind::TableTransform => PortPayloadKind::TableTransform,
        ArtifactKind::Graph => PortPayloadKind::Graph,
        ArtifactKind::Analysis => PortPayloadKind::Analysis,
        ArtifactKind::Distribution => PortPayloadKind::Distribution,
        ArtifactKind::FitYByX => PortPayloadKind::FitYByX,
        ArtifactKind::Tabulate => PortPayloadKind::Tabulate,
        ArtifactKind::Report => PortPayloadKind::Report,
        ArtifactKind::Snapshot => PortPayloadKind::Snapshot,
    }
}

fn insert_node(
    nodes: &mut HashMap<String, &'static str>,
    id: &str,
    kind: &'static str,
) -> Result<(), AppError> {
    if id.trim().is_empty() {
        return Err(invalid(format!("{kind} id cannot be empty")));
    }
    if nodes.insert(id.to_string(), kind).is_some() {
        return Err(invalid(format!("duplicate workflow node id: {id}")));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidParam(message.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::services::workflow_domain::{
        OperationKind, PortPayloadKind, WorkflowDefinition, WorkflowEdge, WorkflowEdgeKind,
        WorkflowEndpoint, WorkflowOperationNode, WorkflowPort,
    };

    fn operation(id: &str) -> WorkflowOperationNode {
        WorkflowOperationNode {
            id: id.to_string(),
            kind: OperationKind::TableTransform,
            schema_version: "1".to_string(),
            configuration: Some(json!({"id": id})),
            input_ports: vec![
                WorkflowPort {
                    id: "in-a".to_string(),
                    name: "input A".to_string(),
                    payload_kind: PortPayloadKind::Table,
                },
                WorkflowPort {
                    id: "in-b".to_string(),
                    name: "input B".to_string(),
                    payload_kind: PortPayloadKind::Table,
                },
            ],
            output_ports: vec![WorkflowPort {
                id: "out".to_string(),
                name: "output".to_string(),
                payload_kind: PortPayloadKind::Table,
            }],
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.to_string(),
            kind: WorkflowEdgeKind::Consumes,
            source: WorkflowEndpoint {
                node_id: source.to_string(),
                port_id: "out".to_string(),
            },
            target: WorkflowEndpoint {
                node_id: target.to_string(),
                port_id: format!("in-{}", source.trim_start_matches("operation-")),
            },
        }
    }

    fn workflow(
        operations: Vec<WorkflowOperationNode>,
        edges: Vec<WorkflowEdge>,
    ) -> WorkflowDefinition {
        WorkflowDefinition {
            id: "workflow-1".to_string(),
            name: "Workflow 1".to_string(),
            description: None,
            format_version: "1".to_string(),
            revision: 1,
            input_slots: vec![],
            operations,
            edges,
            output_declarations: vec![],
            layout: None,
        }
    }

    #[test]
    fn shuffled_insertion_order_produces_stable_operation_order() {
        let first = workflow(
            vec![
                operation("operation-c"),
                operation("operation-b"),
                operation("operation-a"),
            ],
            vec![
                edge("edge-b-c", "operation-b", "operation-c"),
                edge("edge-a-c", "operation-a", "operation-c"),
            ],
        );
        let second = workflow(
            vec![
                operation("operation-a"),
                operation("operation-c"),
                operation("operation-b"),
            ],
            vec![
                edge("edge-a-c", "operation-a", "operation-c"),
                edge("edge-b-c", "operation-b", "operation-c"),
            ],
        );

        assert_eq!(
            plan_workflow(&first).unwrap().operation_ids,
            vec!["operation-a", "operation-b", "operation-c"]
        );
        assert_eq!(
            plan_workflow(&first).unwrap(),
            plan_workflow(&second).unwrap()
        );
    }

    #[test]
    fn cycle_error_names_involved_stable_ids() {
        let cyclic = workflow(
            vec![operation("operation-b"), operation("operation-a")],
            vec![
                edge("edge-a-b", "operation-a", "operation-b"),
                edge("edge-b-a", "operation-b", "operation-a"),
            ],
        );

        let error = plan_workflow(&cyclic).unwrap_err().to_string();
        assert!(error.contains("operation-a"));
        assert!(error.contains("operation-b"));
    }
}
