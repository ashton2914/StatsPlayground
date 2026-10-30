//! Metadata-only Transform topology, shared by navigation and native operation authorization.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use crate::{engine::duckdb_engine::DuckDbEngine, error::AppError, models::{project_persistence::*, project_topology::*}};

fn invalid(code:&str)->AppError {AppError::InvalidParam(code.into())}
impl ProjectTopology {
    pub fn from_parts(epoch:u64,committed_revision:u64,summaries:Vec<ProjectDocumentSummary>,transforms:Vec<ProjectTransformLink>,owned_documents:Vec<ProjectOwnedDocument>)->Self {
        let tables=summaries.into_iter().filter(|s|s.kind==ProjectDocumentKind::Table).map(|s|ProjectTableNode{id:s.id,name:s.name,folder:s.folder,revision:s.revision}).collect();
        let mut result=Self{epoch,committed_revision,tables,transforms,owned_documents,diagnostics:vec![]};
        result.validate();result
    }
    fn diagnose(&mut self,code:&str,id:&str) {self.diagnostics.push(ProjectTopologyDiagnostic{code:code.into(),id:id.into()});}
    fn validate(&mut self) {
        let tables:BTreeSet<_>=self.tables.iter().map(|t|t.id.clone()).collect();
        let mut producers=BTreeSet::new();let mut connectors=BTreeSet::new();
        let mut errors=Vec::new();
        for link in &self.transforms {
            let mut roles=BTreeSet::new();
            if !connectors.insert(&link.id)||!producers.insert(&link.output_table_id) {errors.push(("project_transform_duplicate",link.id.clone()));}
            if link.inputs.is_empty()||!tables.contains(&link.output_table_id)||link.inputs.iter().any(|input|input.role.is_empty()||!roles.insert(&input.role)||!tables.contains(&input.table_id)) {errors.push(("project_transform_binding_invalid",link.id.clone()));}
        }
        // Kahn's algorithm avoids recursion on long chains and detects cyclic ownership.
        let mut degree:BTreeMap<String,usize>=tables.iter().map(|id|(id.clone(),0)).collect();
        let mut children:BTreeMap<String,BTreeSet<String>>=BTreeMap::new();
        for link in &self.transforms {for input in &link.inputs {if children.entry(input.table_id.clone()).or_default().insert(link.output_table_id.clone()) {if let Some(n)=degree.get_mut(&link.output_table_id){*n+=1;}}}}
        let mut queue:VecDeque<_>=degree.iter().filter(|(_,n)|**n==0).map(|(id,_)|id.clone()).collect();let mut seen=0;
        while let Some(id)=queue.pop_front(){seen+=1;if let Some(next)=children.get(&id){for child in next{if let Some(n)=degree.get_mut(child){*n-=1;if *n==0{queue.push_back(child.clone());}}}}}
        if seen!=tables.len(){errors.push(("project_transform_cycle","project".into()));}
        for doc in &self.owned_documents {if !tables.contains(&doc.table_id){errors.push(("project_document_owner_missing",doc.id.clone()));}}
        for (code,id) in errors {self.diagnose(code,&id);}
    }
    fn reachable(&self,table_id:&str,undirected:bool)->Result<Vec<String>,AppError> {
        if !self.diagnostics.is_empty(){return Err(invalid("project_topology_invalid"));}
        if !self.tables.iter().any(|t|t.id==table_id){return Err(invalid("project_table_not_found"));}
        let mut adjacency:BTreeMap<&str,Vec<&str>>=BTreeMap::new();
        for link in &self.transforms {for input in &link.inputs {adjacency.entry(&input.table_id).or_default().push(&link.output_table_id);if undirected{adjacency.entry(&link.output_table_id).or_default().push(&input.table_id);}}}
        let mut found=BTreeSet::new();let mut queue=VecDeque::from([table_id]);
        while let Some(id)=queue.pop_front(){if found.insert(id.to_string()){if let Some(next)=adjacency.get(id){queue.extend(next);}}}
        Ok(found.into_iter().collect())
    }
    pub fn component(&self,table_id:&str)->Result<Vec<String>,AppError>{self.reachable(table_id,true)}
    pub fn descendants(&self,table_id:&str)->Result<Vec<String>,AppError>{self.reachable(table_id,false)}
    pub fn preview(&self,table_id:&str,scope:ProjectActionScope)->Result<ProjectActionPreview,AppError>{
        let table_ids=match scope{ProjectActionScope::Component=>self.component(table_id)?,ProjectActionScope::Descendants=>self.descendants(table_id)?};
        let set:BTreeSet<_>=table_ids.iter().collect();
        let mut transform_ids:Vec<_>=self.transforms.iter().filter(|t|set.contains(&t.output_table_id)).map(|t|t.id.clone()).collect();transform_ids.sort();
        let mut owned_document_ids:Vec<_>=self.owned_documents.iter().filter(|d|set.contains(&d.table_id)).map(|d|d.id.clone()).collect();owned_document_ids.sort();
        Ok(ProjectActionPreview{epoch:self.epoch,committed_revision:self.committed_revision,target_table_id:table_id.into(),scope,table_ids,transform_ids,owned_document_ids,blockers:vec![]})
    }
}

/// ProjectCatalog pages are traversed under the caller's single read transaction.
/// SQL projects only Transform relationship fields; no graph/analysis/table body is fetched.
pub(crate) fn read_topology(engine:&DuckDbEngine,epoch:u64)->Result<ProjectTopology,AppError>{
    let catalog=super::project_catalog::ProjectCatalog::new(engine);let mut summaries=vec![];let mut after=None;
    let revision=loop{let page=catalog.list(&CatalogPageRequest{after,limit:1000})?;summaries.extend(page.items);after=page.next_cursor;if after.is_none(){break page.committed_revision;}};
    let table_ids:BTreeSet<_>=summaries.iter().filter(|s|s.kind==ProjectDocumentKind::Table).map(|s|s.id.clone()).collect();
    let mut owned=vec![];let mut diagnostics=vec![];
    for summary in &summaries {if matches!(summary.kind,ProjectDocumentKind::Graph|ProjectDocumentKind::GraphNew|ProjectDocumentKind::Analysis|ProjectDocumentKind::Tabulate){
        let owners:Vec<_>=summary.dependencies.iter().filter(|id|table_ids.contains(*id)).collect();
        if owners.len()==1{owned.push(ProjectOwnedDocument{id:summary.id.clone(),kind:summary.kind,table_id:owners[0].clone(),revision:summary.revision});}
        else{diagnostics.push(ProjectTopologyDiagnostic{code:"project_document_owner_invalid".into(),id:summary.id.clone()});}
    }}
    let mut statement=engine.conn().prepare("SELECT d.id,d.name,d.revision,json_extract_string(b.body_json,'$.id'),json_extract_string(b.body_json,'$.revision'),json_extract_string(b.body_json,'$.operation.kind'),json_extract_string(b.body_json,'$.output.tableDocumentId'),CAST(json_extract(b.body_json,'$.inputSlots[*].role') AS VARCHAR),json_extract_string(s.value_json,'$.definitionId'),json_extract_string(s.value_json,'$.definitionRevision'),CAST(json_extract(s.value_json,'$.inputs') AS VARCHAR) FROM _project_directory d LEFT JOIN _project_documents b ON b.id=d.id AND b.revision=d.revision LEFT JOIN _project_settings s ON s.key='transformBinding:'||d.id WHERE d.kind='transform' ORDER BY d.id")?;
    let rows=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,u64>(2)?,(3..11).map(|i|r.get::<_,Option<String>>(i)).collect::<Result<Vec<_>,_>>()?)))?.collect::<Result<Vec<_>,_>>()?;
    #[derive(serde::Deserialize)] #[serde(rename_all="camelCase")] struct Input{role:String,table_document_id:String}
    let mut links=vec![];
    for (id,name,revision,fields) in rows {
        let parsed=(||->Option<ProjectTransformLink>{
            if fields[0].as_deref()!=Some(&id)||fields[5].as_deref()!=Some(&id)||fields[1].is_none()||fields[1]!=fields[6]{return None;}
            let roles:Vec<String>=serde_json::from_str(fields[4].as_deref()?).ok()?;
            let inputs:Vec<Input>=serde_json::from_str(fields[7].as_deref()?).ok()?;
            let declared:BTreeSet<_>=roles.iter().map(String::as_str).collect();let bound:BTreeSet<_>=inputs.iter().map(|i|i.role.as_str()).collect();
            if declared.len()!=roles.len()||declared!=bound{return None;}
            Some(ProjectTransformLink{id:id.clone(),name,revision,operation_kind:fields[2].clone()?,output_table_id:fields[3].clone()?,inputs:inputs.into_iter().map(|i|ProjectTransformInput{role:i.role,table_id:i.table_document_id}).collect()})
        })();
        if let Some(link)=parsed{links.push(link);}else{diagnostics.push(ProjectTopologyDiagnostic{code:"project_transform_binding_invalid".into(),id});}
    }
    let mut topology=ProjectTopology::from_parts(epoch,revision,summaries,links,owned);topology.diagnostics.extend(diagnostics);Ok(topology)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::project_persistence::{ProjectDocumentKind, ProjectDocumentSummary};
    use crate::models::project_topology::*;

    fn table(id: &str) -> ProjectDocumentSummary {
        ProjectDocumentSummary { id: id.into(), kind: ProjectDocumentKind::Table, name: id.into(), folder: String::new(), revision: 1, dependencies: vec![], analysis_kind: None }
    }
    fn link(id: &str, inputs: &[&str], output: &str) -> ProjectTransformLink {
        ProjectTransformLink { id: id.into(), revision: 1, name: id.into(), operation_kind: "subset".into(), inputs: inputs.iter().enumerate().map(|(i,id)| ProjectTransformInput { role: format!("input{i}"), table_id: (*id).into() }).collect(), output_table_id: output.into() }
    }
    fn topology(links: Vec<ProjectTransformLink>) -> ProjectTopology {
        ProjectTopology::from_parts(7, 12, vec![table("A"),table("B"),table("C"),table("D"),table("X")], links, vec![])
    }
    #[test]
    fn project_linked_groups_topology_component_and_descendants_differ() {
        let graph = topology(vec![link("ab",&["A"],"B"),link("bc",&["B"],"C")]);
        assert_eq!(graph.component("B").unwrap(), vec!["A","B","C"]);
        assert_eq!(graph.descendants("B").unwrap(), vec!["B","C"]);
        assert_eq!(graph.component("X").unwrap(), vec!["X"]);
        assert!(graph.component("missing").is_err());
    }
    #[test]
    fn project_linked_groups_topology_branch_and_shared_input_survivors() {
        let graph = topology(vec![link("join",&["A","X"],"B"),link("bc",&["B"],"C"),link("ad",&["A"],"D")]);
        assert_eq!(graph.component("C").unwrap(), vec!["A","B","C","D","X"]);
        assert_eq!(graph.descendants("B").unwrap(), vec!["B","C"]);
        assert_eq!(graph.descendants("A").unwrap(), vec!["A","B","C","D"]);
        assert_eq!(graph.descendants("X").unwrap(), vec!["B","C","X"]);
    }
    #[test]
    fn project_linked_groups_topology_preview_owns_documents_without_merging_tables() {
        let mut graph = topology(vec![link("ab",&["A"],"B")]);
        graph.owned_documents = vec![ProjectOwnedDocument { id:"analysis-b".into(), kind:ProjectDocumentKind::Analysis, table_id:"B".into(), revision:2 }];
        let preview=graph.preview("B",ProjectActionScope::Descendants).unwrap();
        assert_eq!(preview.table_ids,vec!["B"]);
        assert_eq!(preview.transform_ids,vec!["ab"]);
        assert_eq!(preview.owned_document_ids,vec!["analysis-b"]);
        assert_eq!(preview.committed_revision,12);
    }
    #[test]
    fn project_linked_groups_topology_invalid_links_do_not_silently_split_groups() {
        for links in [vec![link("broken",&["missing"],"B")],vec![link("empty",&[],"B")],vec![link("ab",&["A"],"B"),link("ba",&["B"],"A")],vec![link("ab",&["A"],"B"),link("xb",&["X"],"B")]] {
            let graph=topology(links);
            assert!(!graph.diagnostics.is_empty());
            assert!(graph.component("A").is_err());
        }
        let mut duplicate=link("duplicate",&["A","X"],"B");duplicate.inputs[1].role=duplicate.inputs[0].role.clone();
        assert!(topology(vec![duplicate]).descendants("A").is_err());
    }
    #[test]
    fn project_linked_groups_topology_reads_unloaded_metadata_and_binding_settings() {
        use crate::services::project_database::ProjectDatabase;
        let dir=tempfile::tempdir().unwrap();let db=ProjectDatabase::create(&dir.path().join("topology.spprj"),false).unwrap();
        db.with_engine(|engine| {
            for id in ["A","B","X"] {engine.conn().execute("INSERT INTO _project_directory VALUES (?,'table',?,'',1,'[]')",duckdb::params![id,id])?;}
            engine.conn().execute("INSERT INTO _project_directory VALUES ('ab','transform','Subset','',1,'[]')",[])?;
            let body=serde_json::json!({"id":"ab","name":"Subset","formatVersion":"1","revision":1,"operation":{"kind":"subset","columns":["value"]},"inputSlots":[{"role":"source"}],"output":{"tableDocumentId":"B","name":"B"}});
            engine.conn().execute("INSERT INTO _project_documents VALUES ('ab',1,1,?)",[body.to_string()])?;
            let binding=serde_json::json!({"definitionId":"ab","definitionRevision":1,"inputs":[{"role":"source","tableDocumentId":"A"}],"outputGeneration":1});
            engine.conn().execute("INSERT INTO _project_settings VALUES ('transformBinding:ab',1,?)",[binding.to_string()])?;
            crate::services::project_work_counters::reset();
            let graph=read_topology(engine,db.epoch())?;
            assert_eq!(graph.component("B")?,vec!["A","B"]);
            assert_eq!(graph.transforms[0].inputs[0].role,"source");
            let work=crate::services::project_work_counters::snapshot();
            assert_eq!(work["archiveRestoredRows"],0);assert_eq!(work["fullWindowCounts"],0);assert_eq!(work["fullAnchorRebuilds"],0);
            engine.conn().execute("DELETE FROM _project_settings WHERE key='transformBinding:ab'",[])?;
            assert!(!read_topology(engine,db.epoch())?.diagnostics.is_empty());
            Ok(())
        }).unwrap();
        db.shutdown().unwrap();
    }
}
