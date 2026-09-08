use crate::error::AppError;
use crate::models::hypothesis_test::HypothesisTestStudyDesign;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct LongHypothesisTestRow {
    pub identity: String,
    pub response: Option<f64>,
    pub condition: Option<String>,
    pub subject: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WideHypothesisTestRow {
    pub identity: String,
    pub subject: Option<String>,
    pub measurements: Vec<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HypothesisTestRows {
    Long(Vec<LongHypothesisTestRow>),
    Wide {
        conditions: Vec<String>,
        explicit_subject: bool,
        rows: Vec<WideHypothesisTestRow>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndependentGroups {
    pub groups: Vec<ConditionValues>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConditionValues {
    pub condition: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairedDifferences {
    pub conditions: [String; 2],
    pub subjects: Vec<String>,
    pub pairs: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompleteBlocks {
    pub conditions: Vec<String>,
    pub subjects: Vec<String>,
    pub blocks: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NormalizedStudy {
    IndependentTwo(IndependentGroups),
    IndependentMulti(IndependentGroups),
    PairedTwo(PairedDifferences),
    CompleteBlock(CompleteBlocks),
}

impl NormalizedStudy {
    pub fn retained_observations(&self) -> usize {
        match self {
            Self::IndependentTwo(groups) | Self::IndependentMulti(groups) => {
                groups.groups.iter().map(|group| group.values.len()).sum()
            }
            Self::PairedTwo(paired) => paired.pairs.len() * 2,
            Self::CompleteBlock(blocks) => blocks.blocks.len() * blocks.conditions.len(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExclusionReason {
    MissingResponse,
    MissingCondition,
    IncompletePair,
    IncompleteBlock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizationExclusion {
    pub identity: String,
    pub reason: ExclusionReason,
    pub condition: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedHypothesisTest {
    pub study: NormalizedStudy,
    pub exclusions: Vec<NormalizationExclusion>,
}

pub fn normalize_hypothesis_test_rows(
    rows: HypothesisTestRows,
    study_design: HypothesisTestStudyDesign,
    level_order: &[String],
) -> Result<NormalizedHypothesisTest, AppError> {
    match (rows, study_design) {
        (HypothesisTestRows::Long(rows), HypothesisTestStudyDesign::Independent) => {
            normalize_long_independent(rows, level_order)
        }
        (
            HypothesisTestRows::Wide { conditions, rows, .. },
            HypothesisTestStudyDesign::Independent,
        ) => normalize_wide_independent(conditions, rows, level_order),
        (HypothesisTestRows::Long(rows), HypothesisTestStudyDesign::PairedOrBlocked) => {
            normalize_long_blocked(rows, level_order)
        }
        (
            HypothesisTestRows::Wide { conditions, explicit_subject, rows },
            HypothesisTestStudyDesign::PairedOrBlocked,
        ) => normalize_wide_blocked(conditions, explicit_subject, rows, level_order),
    }
}

fn normalize_long_independent(
    rows: Vec<LongHypothesisTestRow>,
    level_order: &[String],
) -> Result<NormalizedHypothesisTest, AppError> {
    let mut observed = Vec::new();
    let mut values: HashMap<String, Vec<f64>> = HashMap::new();
    let mut exclusions = Vec::new();
    for row in rows {
        let Some(condition) = row.condition.filter(|value| !value.is_empty()) else {
            exclusions.push(exclusion(row.identity, ExclusionReason::MissingCondition, None));
            continue;
        };
        if !values.contains_key(&condition) {
            observed.push(condition.clone());
        }
        let Some(response) = finite(row.response) else {
            exclusions.push(exclusion(
                row.identity,
                ExclusionReason::MissingResponse,
                Some(condition),
            ));
            continue;
        };
        values.entry(condition).or_default().push(response);
    }
    finish_independent(values, ordered_conditions(level_order, &observed), exclusions)
}

fn normalize_wide_independent(
    conditions: Vec<String>,
    rows: Vec<WideHypothesisTestRow>,
    level_order: &[String],
) -> Result<NormalizedHypothesisTest, AppError> {
    validate_wide_shape(&conditions, &rows)?;
    let ordered = ordered_conditions(level_order, &conditions);
    let offsets = condition_offsets(&conditions);
    let mut values: HashMap<String, Vec<f64>> = conditions
        .iter()
        .map(|condition| (condition.clone(), Vec::new()))
        .collect();
    let mut exclusions = Vec::new();
    for row in rows {
        for condition in &ordered {
            let offset = offsets[condition];
            if let Some(value) = finite(row.measurements[offset]) {
                values.entry(condition.clone()).or_default().push(value);
            } else {
                exclusions.push(exclusion(
                    row.identity.clone(),
                    ExclusionReason::MissingResponse,
                    Some(condition.clone()),
                ));
            }
        }
    }
    finish_independent(values, ordered, exclusions)
}

fn finish_independent(
    mut values: HashMap<String, Vec<f64>>,
    ordered: Vec<String>,
    exclusions: Vec<NormalizationExclusion>,
) -> Result<NormalizedHypothesisTest, AppError> {
    let groups = ordered
        .into_iter()
        .filter_map(|condition| {
            let group_values = values.remove(&condition).unwrap_or_default();
            (!group_values.is_empty()).then_some(ConditionValues {
                condition,
                values: group_values,
            })
        })
        .collect::<Vec<_>>();
    let study = match groups.len() {
        2 => NormalizedStudy::IndependentTwo(IndependentGroups { groups }),
        count if count >= 3 => NormalizedStudy::IndependentMulti(IndependentGroups { groups }),
        _ => return Err(AppError::InvalidParam(
            "independent hypothesis test requires at least two non-empty conditions".into(),
        )),
    };
    Ok(NormalizedHypothesisTest { study, exclusions })
}

fn normalize_long_blocked(
    rows: Vec<LongHypothesisTestRow>,
    level_order: &[String],
) -> Result<NormalizedHypothesisTest, AppError> {
    let mut observed_conditions = Vec::new();
    let mut subject_order = Vec::new();
    let mut cells: HashMap<String, HashMap<String, Option<f64>>> = HashMap::new();
    let mut exclusions = Vec::new();
    for row in rows {
        let Some(condition) = row.condition.filter(|value| !value.is_empty()) else {
            exclusions.push(exclusion(row.identity, ExclusionReason::MissingCondition, None));
            continue;
        };
        let subject = row.subject.filter(|value| !value.is_empty()).ok_or_else(|| {
            AppError::InvalidParam("paired or blocked long data requires a subject for every row".into())
        })?;
        if !observed_conditions.contains(&condition) {
            observed_conditions.push(condition.clone());
        }
        if !cells.contains_key(&subject) {
            subject_order.push(subject.clone());
        }
        let subject_cells = cells.entry(subject.clone()).or_default();
        if subject_cells.contains_key(&condition) {
            return Err(AppError::InvalidParam(format!(
                "duplicate subject-condition cell: {subject}/{condition}"
            )));
        }
        subject_cells.insert(condition, finite(row.response));
    }
    let conditions = ordered_conditions(level_order, &observed_conditions);
    finish_blocks(conditions, subject_order, cells, exclusions)
}

fn normalize_wide_blocked(
    conditions: Vec<String>,
    explicit_subject: bool,
    rows: Vec<WideHypothesisTestRow>,
    level_order: &[String],
) -> Result<NormalizedHypothesisTest, AppError> {
    validate_wide_shape(&conditions, &rows)?;
    let ordered = ordered_conditions(level_order, &conditions);
    let offsets = condition_offsets(&conditions);
    let mut subject_order = Vec::new();
    let mut cells = HashMap::new();
    for row in rows {
        let subject = match (explicit_subject, row.subject.filter(|value| !value.is_empty())) {
            (true, None) => return Err(AppError::InvalidParam(
                "explicit wide subject must be non-missing".into(),
            )),
            (_, Some(subject)) => subject,
            (false, None) => row.identity,
        };
        if cells.contains_key(&subject) {
            return Err(AppError::InvalidParam(format!(
                "wide subject must be unique: {subject}"
            )));
        }
        subject_order.push(subject.clone());
        cells.insert(
            subject,
            ordered.iter().map(|condition| {
                (condition.clone(), finite(row.measurements[offsets[condition]]))
            }).collect(),
        );
    }
    finish_blocks(ordered, subject_order, cells, Vec::new())
}

fn finish_blocks(
    conditions: Vec<String>,
    subject_order: Vec<String>,
    cells: HashMap<String, HashMap<String, Option<f64>>>,
    mut exclusions: Vec<NormalizationExclusion>,
) -> Result<NormalizedHypothesisTest, AppError> {
    if conditions.len() < 2 {
        return Err(AppError::InvalidParam(
            "paired or blocked hypothesis test requires at least two conditions".into(),
        ));
    }
    let reason = if conditions.len() == 2 {
        ExclusionReason::IncompletePair
    } else {
        ExclusionReason::IncompleteBlock
    };
    let mut retained_subjects = Vec::new();
    let mut blocks = Vec::new();
    for subject in subject_order {
        let subject_cells = &cells[&subject];
        let values = conditions.iter()
            .map(|condition| subject_cells.get(condition).copied().flatten())
            .collect::<Option<Vec<_>>>();
        if let Some(values) = values {
            retained_subjects.push(subject);
            blocks.push(values);
        } else {
            exclusions.push(exclusion(subject, reason.clone(), None));
        }
    }
    let study = if conditions.len() == 2 {
        NormalizedStudy::PairedTwo(PairedDifferences {
            conditions: [conditions[0].clone(), conditions[1].clone()],
            subjects: retained_subjects,
            pairs: blocks.into_iter().map(|values| [values[0], values[1]]).collect(),
        })
    } else {
        NormalizedStudy::CompleteBlock(CompleteBlocks {
            conditions,
            subjects: retained_subjects,
            blocks,
        })
    };
    Ok(NormalizedHypothesisTest { study, exclusions })
}

fn ordered_conditions(persisted: &[String], observed: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    persisted.iter().chain(observed).filter_map(|condition| {
        seen.insert(condition.clone()).then_some(condition.clone())
    }).collect()
}

fn condition_offsets(conditions: &[String]) -> HashMap<String, usize> {
    conditions.iter().enumerate().map(|(index, condition)| (condition.clone(), index)).collect()
}

fn validate_wide_shape(
    conditions: &[String],
    rows: &[WideHypothesisTestRow],
) -> Result<(), AppError> {
    if conditions.len() < 2 || conditions.iter().any(String::is_empty) {
        return Err(AppError::InvalidParam(
            "wide hypothesis test requires at least two named measurement columns".into(),
        ));
    }
    if conditions.iter().collect::<HashSet<_>>().len() != conditions.len() {
        return Err(AppError::InvalidParam(
            "wide hypothesis test measurement columns must be unique".into(),
        ));
    }
    if rows.iter().any(|row| row.measurements.len() != conditions.len()) {
        return Err(AppError::Stats(
            "wide hypothesis test row width did not match measurement columns".into(),
        ));
    }
    Ok(())
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite())
}

fn exclusion(
    identity: String,
    reason: ExclusionReason,
    condition: Option<String>,
) -> NormalizationExclusion {
    NormalizationExclusion { identity, reason, condition }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalent_long_and_wide_independent_rows_normalize_identically() {
        let long = HypothesisTestRows::Long(vec![
            long_row("1", Some(10.0), Some("A"), None),
            long_row("2", Some(11.0), Some("A"), None),
            long_row("3", None, Some("A"), None),
            long_row("4", Some(20.0), Some("B"), None),
            long_row("5", Some(21.0), Some("B"), None),
            long_row("6", Some(22.0), Some("B"), None),
        ]);
        let wide = HypothesisTestRows::Wide {
            conditions: vec!["A".into(), "B".into()],
            explicit_subject: false,
            rows: vec![
                wide_row("1", None, vec![Some(10.0), Some(20.0)]),
                wide_row("2", None, vec![Some(11.0), Some(21.0)]),
                wide_row("3", None, vec![None, Some(22.0)]),
            ],
        };

        let long = normalize_hypothesis_test_rows(
            long,
            HypothesisTestStudyDesign::Independent,
            &["A".into(), "B".into()],
        ).expect("long normalization");
        let wide = normalize_hypothesis_test_rows(
            wide,
            HypothesisTestStudyDesign::Independent,
            &["A".into(), "B".into()],
        ).expect("wide normalization");

        assert_eq!(long.study, wide.study);
        assert_eq!(long.study.retained_observations(), 5);
    }

    #[test]
    fn equivalent_long_and_wide_paired_rows_drop_whole_incomplete_pairs() {
        let long = HypothesisTestRows::Long(vec![
            long_row("1", Some(10.0), Some("Before"), Some("P1")),
            long_row("2", Some(12.0), Some("After"), Some("P1")),
            long_row("3", Some(20.0), Some("Before"), Some("P2")),
            long_row("4", None, Some("After"), Some("P2")),
            long_row("5", Some(30.0), Some("Before"), Some("P3")),
            long_row("6", Some(31.0), Some("After"), Some("P3")),
        ]);
        let wide = HypothesisTestRows::Wide {
            conditions: vec!["Before".into(), "After".into()],
            explicit_subject: true,
            rows: vec![
                wide_row("1", Some("P1"), vec![Some(10.0), Some(12.0)]),
                wide_row("2", Some("P2"), vec![Some(20.0), None]),
                wide_row("3", Some("P3"), vec![Some(30.0), Some(31.0)]),
            ],
        };

        let long = normalize_hypothesis_test_rows(
            long,
            HypothesisTestStudyDesign::PairedOrBlocked,
            &["Before".into(), "After".into()],
        ).expect("long normalization");
        let wide = normalize_hypothesis_test_rows(
            wide,
            HypothesisTestStudyDesign::PairedOrBlocked,
            &["Before".into(), "After".into()],
        ).expect("wide normalization");

        assert_eq!(long.study, wide.study);
        assert_eq!(long.study.retained_observations(), 4);
        assert_eq!(long.exclusions[0].reason, ExclusionReason::IncompletePair);
        assert_eq!(wide.exclusions[0].reason, ExclusionReason::IncompletePair);
    }

    #[test]
    fn complete_blocks_drop_subjects_with_any_missing_condition() {
        let normalized = normalize_hypothesis_test_rows(
            HypothesisTestRows::Wide {
                conditions: vec!["A".into(), "B".into(), "C".into()],
                explicit_subject: false,
                rows: vec![
                    wide_row("1", None, vec![Some(1.0), Some(2.0), Some(3.0)]),
                    wide_row("2", None, vec![Some(4.0), None, Some(6.0)]),
                ],
            },
            HypothesisTestStudyDesign::PairedOrBlocked,
            &[],
        ).expect("complete block normalization");

        assert_eq!(normalized.study.retained_observations(), 3);
        assert_eq!(normalized.exclusions, vec![NormalizationExclusion {
            identity: "2".into(),
            reason: ExclusionReason::IncompleteBlock,
            condition: None,
        }]);
    }

    #[test]
    fn rejects_duplicate_long_subject_condition_cells() {
        let result = normalize_hypothesis_test_rows(
            HypothesisTestRows::Long(vec![
                long_row("1", Some(1.0), Some("A"), Some("P1")),
                long_row("2", Some(2.0), Some("A"), Some("P1")),
            ]),
            HypothesisTestStudyDesign::PairedOrBlocked,
            &[],
        );

        assert!(matches!(result, Err(AppError::InvalidParam(message)) if message.contains("duplicate subject-condition")));
    }

    #[test]
    fn rejects_missing_or_duplicate_explicit_wide_subjects() {
        let missing = normalize_hypothesis_test_rows(
            HypothesisTestRows::Wide {
                conditions: vec!["A".into(), "B".into()],
                explicit_subject: true,
                rows: vec![wide_row("1", None, vec![Some(1.0), Some(2.0)])],
            },
            HypothesisTestStudyDesign::PairedOrBlocked,
            &[],
        );
        assert!(matches!(missing, Err(AppError::InvalidParam(message)) if message.contains("non-missing")));

        let duplicate = normalize_hypothesis_test_rows(
            HypothesisTestRows::Wide {
                conditions: vec!["A".into(), "B".into()],
                explicit_subject: true,
                rows: vec![
                    wide_row("1", Some("P1"), vec![Some(1.0), Some(2.0)]),
                    wide_row("2", Some("P1"), vec![Some(3.0), Some(4.0)]),
                ],
            },
            HypothesisTestStudyDesign::PairedOrBlocked,
            &[],
        );
        assert!(matches!(duplicate, Err(AppError::InvalidParam(message)) if message.contains("unique")));
    }

    fn long_row(
        identity: &str,
        response: Option<f64>,
        condition: Option<&str>,
        subject: Option<&str>,
    ) -> LongHypothesisTestRow {
        LongHypothesisTestRow {
            identity: identity.into(),
            response,
            condition: condition.map(str::to_string),
            subject: subject.map(str::to_string),
        }
    }

    fn wide_row(
        identity: &str,
        subject: Option<&str>,
        measurements: Vec<Option<f64>>,
    ) -> WideHypothesisTestRow {
        WideHypothesisTestRow {
            identity: identity.into(),
            subject: subject.map(str::to_string),
            measurements,
        }
    }
}