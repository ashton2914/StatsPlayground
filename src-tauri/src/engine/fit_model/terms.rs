use std::collections::BTreeSet;

use crate::models::fit_model::{FitModelTerm, FitModelTermKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTerm {
    term_id: String,
    kind: FitModelTermKind,
    column_names: Vec<String>,
    exponent: Option<u8>,
    label: String,
}

impl ResolvedTerm {
    fn main(column_name: String) -> Self {
        let term_id = if ["main:", "interaction:", "power:"]
            .iter()
            .any(|prefix| column_name.starts_with(prefix))
        {
            format!("main:{}:{column_name}", column_name.len())
        } else {
            column_name.clone()
        };
        Self {
            term_id,
            kind: FitModelTermKind::Main,
            column_names: vec![column_name.clone()],
            exponent: None,
            label: column_name,
        }
    }

    fn interaction(column_names: Vec<String>) -> Self {
        let label = column_names.join("*");
        let term_id = if column_names
            .iter()
            .any(|column| column.contains(['*', '^', ':']))
        {
            format!("interaction:tuple:{}", encode_columns(&column_names))
        } else {
            format!("interaction:{label}")
        };
        Self {
            term_id,
            kind: FitModelTermKind::Interaction,
            column_names,
            exponent: None,
            label,
        }
    }

    fn power(column_name: String, exponent: u8) -> Self {
        let label = format!("{column_name}^{exponent}");
        let term_id = if column_name.contains(['*', '^', ':']) {
            format!("power:{}:{column_name}^{exponent}", column_name.len())
        } else {
            format!("power:{label}")
        };
        Self {
            term_id,
            kind: FitModelTermKind::Power,
            column_names: vec![column_name],
            exponent: Some(exponent),
            label,
        }
    }

    pub fn term_id(&self) -> &str {
        &self.term_id
    }

    pub fn kind(&self) -> &FitModelTermKind {
        &self.kind
    }

    pub fn column_names(&self) -> &[String] {
        &self.column_names
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn main_column(&self) -> Option<&str> {
        if self.kind == FitModelTermKind::Main && self.column_names.len() == 1 {
            return Some(self.column_names[0].as_str());
        }
        None
    }

    pub fn interaction_columns(&self) -> Option<&[String]> {
        if self.kind == FitModelTermKind::Interaction && self.column_names.len() >= 2 {
            return Some(&self.column_names);
        }
        None
    }

    pub fn power_column(&self) -> Option<(&str, u8)> {
        if self.kind == FitModelTermKind::Power && self.column_names.len() == 1 {
            return self
                .exponent
                .map(|exponent| (self.column_names[0].as_str(), exponent));
        }
        None
    }

    #[cfg(test)]
    pub(crate) fn from_parts_for_test(
        term_id: String,
        kind: FitModelTermKind,
        column_names: Vec<String>,
        label: String,
    ) -> Self {
        Self {
            term_id,
            kind,
            column_names,
            exponent: None,
            label,
        }
    }
}

fn encode_columns(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("{}:{column}", column.len()))
        .collect::<Vec<_>>()
        .join("")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermError {
    EmptyColumnName,
    TooManyTerms {
        actual: usize,
        maximum: usize,
    },
    InvalidArity {
        kind: FitModelTermKind,
        expected: usize,
        actual: usize,
    },
    InteractionRequiresAtLeastTwoColumns(usize),
    InvalidExponent {
        kind: FitModelTermKind,
        exponent: Option<u8>,
    },
    DuplicateTerm(String),
    MissingMainEffect(String),
    PowerRequiresMainEffect(String),
    InteractionRequiresDistinctColumns(String),
}

fn duplicate_key_for_main(column: &str) -> String {
    format!("main\u{0}{column}")
}

fn duplicate_key(kind: &str, columns: &[String], exponent: Option<u8>) -> String {
    let tuple = columns
        .iter()
        .map(|column| format!("{}:{column}", column.len()))
        .collect::<Vec<_>>()
        .join("\u{0}");
    format!("{kind}\u{0}{tuple}\u{0}{}", exponent.unwrap_or(0))
}

pub fn resolve_terms(terms: &[FitModelTerm]) -> Result<Vec<ResolvedTerm>, TermError> {
    const MAX_TERMS: usize = 256;
    if terms.len() > MAX_TERMS {
        return Err(TermError::TooManyTerms {
            actual: terms.len(),
            maximum: MAX_TERMS,
        });
    }
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let mut seen = BTreeSet::new();
    let mut mains_seen = BTreeSet::new();
    let mut mains = Vec::new();
    let mut interactions = Vec::new();
    let mut powers = Vec::new();

    for term in terms {
        if term
            .column_names
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return Err(TermError::EmptyColumnName);
        }

        match term.kind {
            FitModelTermKind::Main => {
                if term.exponent.is_some() {
                    return Err(TermError::InvalidExponent {
                        kind: FitModelTermKind::Main,
                        exponent: term.exponent,
                    });
                }
                if term.column_names.len() != 1 {
                    return Err(TermError::InvalidArity {
                        kind: FitModelTermKind::Main,
                        expected: 1,
                        actual: term.column_names.len(),
                    });
                }

                let column = term.column_names[0].clone();
                let duplicate_key = duplicate_key_for_main(&column);
                if !seen.insert(duplicate_key) {
                    return Err(TermError::DuplicateTerm(column));
                }
                mains_seen.insert(column.clone());
                mains.push(ResolvedTerm::main(column));
            }
            FitModelTermKind::Interaction => {
                if term.exponent.is_some() {
                    return Err(TermError::InvalidExponent {
                        kind: FitModelTermKind::Interaction,
                        exponent: term.exponent,
                    });
                }
                if term.column_names.len() < 2 {
                    return Err(TermError::InteractionRequiresAtLeastTwoColumns(
                        term.column_names.len(),
                    ));
                }

                let mut cols = term.column_names.clone();
                cols.sort();
                if let Some(columns) = cols.windows(2).find(|pair| pair[0] == pair[1]) {
                    return Err(TermError::InteractionRequiresDistinctColumns(
                        columns[0].clone(),
                    ));
                }
                let duplicate_key = duplicate_key("interaction", &cols, None);
                if !seen.insert(duplicate_key) {
                    return Err(TermError::DuplicateTerm(cols.join("*")));
                }

                interactions.push(ResolvedTerm::interaction(cols));
            }
            FitModelTermKind::Power => {
                if term.column_names.len() != 1 {
                    return Err(TermError::InvalidArity {
                        kind: FitModelTermKind::Power,
                        expected: 1,
                        actual: term.column_names.len(),
                    });
                }
                if term.exponent != Some(2) {
                    return Err(TermError::InvalidExponent {
                        kind: FitModelTermKind::Power,
                        exponent: term.exponent,
                    });
                }
                let column = term.column_names[0].clone();
                if !seen.insert(duplicate_key("power", &term.column_names, term.exponent)) {
                    return Err(TermError::DuplicateTerm(format!("{column}^2")));
                }
                powers.push(ResolvedTerm::power(column, 2));
            }
        }
    }

    for interaction in &interactions {
        for column in interaction.column_names() {
            if !mains_seen.contains(column) {
                return Err(TermError::MissingMainEffect(column.clone()));
            }
        }
    }

    for power in &powers {
        let (column, _) = power
            .power_column()
            .ok_or_else(|| TermError::InvalidExponent {
                kind: FitModelTermKind::Power,
                exponent: None,
            })?;
        if !mains_seen.contains(column) {
            return Err(TermError::PowerRequiresMainEffect(column.to_string()));
        }
    }

    interactions.sort_by(|left, right| {
        left.column_names()
            .len()
            .cmp(&right.column_names().len())
            .then_with(|| left.column_names().cmp(right.column_names()))
    });
    powers.sort_by(|left, right| left.column_names().cmp(right.column_names()));

    let mut resolved = Vec::with_capacity(mains.len() + interactions.len() + powers.len());
    resolved.extend(mains);
    resolved.extend(interactions);
    resolved.extend(powers);

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn power(column: &str, exponent: u8) -> FitModelTerm {
        FitModelTerm {
            kind: FitModelTermKind::Power,
            column_names: vec![column.to_string()],
            exponent: Some(exponent),
        }
    }

    fn term(kind: &str, columns: &[&str]) -> FitModelTerm {
        let mapped_kind = match kind {
            "main" => FitModelTermKind::Main,
            "interaction" => FitModelTermKind::Interaction,
            _ => panic!("unsupported test term kind: {kind}"),
        };

        FitModelTerm {
            kind: mapped_kind,
            column_names: columns.iter().map(|value| (*value).to_string()).collect(),
            exponent: None,
        }
    }

    #[test]
    fn interaction_requires_both_main_effects() {
        let terms = vec![term("interaction", &["A", "B"]), term("main", &["A"])];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::MissingMainEffect("B".into()))
        );
    }

    #[test]
    fn reversed_interaction_is_a_duplicate() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("interaction", &["A", "B"]),
            term("interaction", &["B", "A"]),
        ];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::DuplicateTerm("A*B".into()))
        );
    }

    #[test]
    fn main_name_that_looks_like_interaction_does_not_collide() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("main", &["A*B"]),
            term("interaction", &["A", "B"]),
        ];
        let resolved = resolve_terms(&terms).expect("term ids should be collision-free by kind");
        assert_eq!(resolved.len(), 4);
        assert!(resolved
            .iter()
            .any(|entry| entry.kind() == &FitModelTermKind::Main
                && entry.main_column() == Some("A*B")));
        assert!(resolved.iter().any(|entry| {
            entry.kind() == &FitModelTermKind::Interaction
                && entry
                    .interaction_columns()
                    .is_some_and(|columns| columns == ["A", "B"])
        }));
    }

    #[test]
    fn interaction_identity_is_tuple_based_not_join_based() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("main", &["C"]),
            term("main", &["B*C"]),
            term("main", &["A*B"]),
            term("interaction", &["A", "B*C"]),
            term("interaction", &["A*B", "C"]),
        ];
        let resolved = resolve_terms(&terms).expect("interaction keys should be unambiguous");
        assert_eq!(resolved.len(), 7);
        let interaction_ids = resolved
            .iter()
            .filter(|entry| entry.kind() == &FitModelTermKind::Interaction)
            .map(ResolvedTerm::term_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(interaction_ids.len(), 2);
    }

    #[test]
    fn resolved_ids_do_not_collide_across_term_kinds() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("main", &["interaction:A*B"]),
            term("main", &["power:A^2"]),
            term("interaction", &["A", "B"]),
            power("A", 2),
        ];
        let resolved = resolve_terms(&terms).expect("valid terms");
        let ids = resolved
            .iter()
            .map(ResolvedTerm::term_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), resolved.len());
    }

    #[test]
    fn interactions_are_ordered_by_degree_then_canonical_tuple() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("main", &["C"]),
            term("main", &["Z"]),
            term("interaction", &["A", "B", "C"]),
            term("interaction", &["A", "Z"]),
        ];
        let resolved = resolve_terms(&terms).expect("valid interactions");
        let interactions = resolved
            .iter()
            .filter(|entry| entry.kind() == &FitModelTermKind::Interaction)
            .map(|entry| entry.column_names().to_vec())
            .collect::<Vec<_>>();
        assert_eq!(
            interactions,
            vec![
                vec!["A".to_string(), "Z".to_string()],
                vec!["A".to_string(), "B".to_string(), "C".to_string()],
            ]
        );
    }

    #[test]
    fn rejects_invalid_wire_main_arity() {
        let terms = vec![term("main", &["A", "B"])];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::InvalidArity {
                kind: FitModelTermKind::Main,
                expected: 1,
                actual: 2,
            })
        );
    }

    #[test]
    fn rejects_invalid_wire_interaction_arity() {
        let terms = vec![term("interaction", &["A"])];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::InteractionRequiresAtLeastTwoColumns(1))
        );
    }

    #[test]
    fn resolves_three_way_interaction_and_square() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("main", &["C"]),
            term("interaction", &["C", "A", "B"]),
            power("A", 2),
        ];

        let resolved = resolve_terms(&terms).expect("valid terms");
        assert_eq!(resolved[3].term_id(), "interaction:A*B*C");
        assert_eq!(resolved[4].term_id(), "power:A^2");
    }

    #[test]
    fn rejects_more_than_256_terms_before_resolution() {
        let terms = (0..257)
            .map(|index| term("main", &[&format!("X{index}")]))
            .collect::<Vec<_>>();
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::TooManyTerms {
                actual: 257,
                maximum: 256,
            })
        );
    }

    #[test]
    fn rejects_unsupported_power_exponent() {
        assert_eq!(
            resolve_terms(&[term("main", &["A"]), power("A", 3)]),
            Err(TermError::InvalidExponent {
                kind: FitModelTermKind::Power,
                exponent: Some(3),
            })
        );
    }

    #[test]
    fn rejects_reordered_duplicate_three_way_interaction() {
        let terms = vec![
            term("main", &["A"]),
            term("main", &["B"]),
            term("main", &["C"]),
            term("interaction", &["A", "B", "C"]),
            term("interaction", &["C", "A", "B"]),
        ];
        assert_eq!(
            resolve_terms(&terms),
            Err(TermError::DuplicateTerm("A*B*C".into()))
        );
    }

    #[test]
    fn power_requires_its_main_effect() {
        assert_eq!(
            resolve_terms(&[power("A", 2)]),
            Err(TermError::PowerRequiresMainEffect("A".into()))
        );
    }
}
