use std::collections::{BTreeMap, BTreeSet};

use nalgebra::{DMatrix, DVector};

use crate::engine::fit_model::ols::FitModelEngineError;
use crate::models::fit_model::{FitModelCenteringMethod, FitModelResolvedTerm, FitModelTermKind};

#[derive(Debug, Clone)]
pub(crate) struct FitModelReportingBasis {
    pub coefficients: DVector<f64>,
    pub covariance_geometry: DMatrix<f64>,
    pub term_labels: Vec<String>,
    pub centered: bool,
}

pub(crate) fn reporting_basis(
    coefficients: &DVector<f64>,
    covariance_geometry: &DMatrix<f64>,
    terms: &[FitModelResolvedTerm],
    predictor_means: &BTreeMap<String, f64>,
    construction_centering: &FitModelCenteringMethod,
) -> Result<FitModelReportingBasis, FitModelEngineError> {
    let width = terms.len() + 1;
    if coefficients.len() != width
        || covariance_geometry.nrows() != width
        || covariance_geometry.ncols() != width
    {
        return Err(FitModelEngineError::InvalidInput(
            "reporting basis dimensions must match resolved terms".to_string(),
        ));
    }
    if coefficients.iter().any(|value| !value.is_finite())
        || covariance_geometry.iter().any(|value| !value.is_finite())
    {
        return Err(FitModelEngineError::NumericalFailure(
            "reporting basis inputs must be finite".to_string(),
        ));
    }

    let interactions = interaction_indexes(terms)?;
    let main_effects = terms
        .iter()
        .filter(|term| term.kind == FitModelTermKind::Main && term.column_names.len() == 1)
        .map(|term| term.column_names[0].clone())
        .collect::<BTreeSet<_>>();
    if interactions.is_empty() || !is_strongly_hierarchical(&interactions, &main_effects) {
        return Ok(unchanged_basis(coefficients, covariance_geometry, terms));
    }

    let centered_predictors = interactions
        .keys()
        .flat_map(|columns| columns.iter().cloned())
        .collect::<BTreeSet<_>>();
    let means = centered_predictors
        .into_iter()
        .map(|name| {
            let mean = predictor_means.get(&name).copied().ok_or_else(|| {
                FitModelEngineError::InvalidInput(format!("predictor mean is missing for {name}"))
            })?;
            if !mean.is_finite() {
                return Err(FitModelEngineError::NumericalFailure(format!(
                    "predictor mean is non-finite for {name}"
                )));
            }
            Ok((name, mean))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;

    let main_indexes = terms
        .iter()
        .enumerate()
        .filter_map(|(index, term)| {
            (term.kind == FitModelTermKind::Main && term.column_names.len() == 1)
                .then(|| (term.column_names[0].clone(), index + 1))
        })
        .collect::<BTreeMap<_, _>>();
    let mut transform = DMatrix::zeros(width, width);
    transform[(0, 0)] = 1.0;

    for (term_index, term) in terms.iter().enumerate() {
        let raw_column = term_index + 1;
        match term.kind {
            FitModelTermKind::Main if term.column_names.len() == 1 => {
                let name = &term.column_names[0];
                transform[(raw_column, raw_column)] = 1.0;
                if let Some(mean) = means.get(name) {
                    transform[(0, raw_column)] = *mean;
                }
            }
            FitModelTermKind::Interaction if term.column_names.len() >= 2 => {
                // Mean construction already centers interaction factors, but not main effects.
                if *construction_centering == FitModelCenteringMethod::Mean {
                    transform[(raw_column, raw_column)] = 1.0;
                    continue;
                }
                let columns = sorted_columns(term)?;
                for subset in subsets(&columns) {
                    let report_row = match subset.len() {
                        0 => 0,
                        1 => *main_indexes.get(&subset[0]).ok_or_else(|| {
                            FitModelEngineError::InvalidInput(format!(
                                "interaction is missing main effect {}",
                                subset[0]
                            ))
                        })?,
                        _ => interactions.get(&subset).copied().ok_or_else(|| {
                            FitModelEngineError::InvalidInput(format!(
                                "interaction hierarchy is missing {}",
                                subset.join("*")
                            ))
                        })?,
                    };
                    let subset_names = subset.iter().collect::<BTreeSet<_>>();
                    let multiplier = columns
                        .iter()
                        .filter(|name| !subset_names.contains(name))
                        .map(|name| means[name])
                        .product::<f64>();
                    transform[(report_row, raw_column)] = multiplier;
                }
            }
            _ => transform[(raw_column, raw_column)] = 1.0,
        }
    }

    let reporting_coefficients = &transform * coefficients;
    let reporting_geometry = &transform * covariance_geometry * transform.transpose();
    if reporting_coefficients
        .iter()
        .chain(reporting_geometry.iter())
        .any(|value| !value.is_finite())
    {
        return Err(FitModelEngineError::NumericalFailure(
            "reporting basis transform produced non-finite values".to_string(),
        ));
    }

    let mut term_labels = Vec::with_capacity(width);
    term_labels.push("Intercept".to_string());
    term_labels.extend(terms.iter().map(|term| centered_label(term, &means)));
    Ok(FitModelReportingBasis {
        coefficients: reporting_coefficients,
        covariance_geometry: reporting_geometry,
        term_labels,
        centered: true,
    })
}

fn unchanged_basis(
    coefficients: &DVector<f64>,
    covariance_geometry: &DMatrix<f64>,
    terms: &[FitModelResolvedTerm],
) -> FitModelReportingBasis {
    let mut term_labels = Vec::with_capacity(terms.len() + 1);
    term_labels.push("Intercept".to_string());
    term_labels.extend(terms.iter().map(|term| term.label.clone()));
    FitModelReportingBasis {
        coefficients: coefficients.clone(),
        covariance_geometry: covariance_geometry.clone(),
        term_labels,
        centered: false,
    }
}

fn interaction_indexes(
    terms: &[FitModelResolvedTerm],
) -> Result<BTreeMap<Vec<String>, usize>, FitModelEngineError> {
    terms
        .iter()
        .enumerate()
        .filter(|(_, term)| term.kind == FitModelTermKind::Interaction)
        .map(|(index, term)| Ok((sorted_columns(term)?, index + 1)))
        .collect()
}

fn sorted_columns(term: &FitModelResolvedTerm) -> Result<Vec<String>, FitModelEngineError> {
    let mut columns = term.column_names.clone();
    columns.sort();
    if columns.len() < 2 || columns.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(FitModelEngineError::InvalidInput(format!(
            "invalid interaction term {}",
            term.term_id
        )));
    }
    Ok(columns)
}

fn is_strongly_hierarchical(
    interactions: &BTreeMap<Vec<String>, usize>,
    main_effects: &BTreeSet<String>,
) -> bool {
    interactions.keys().all(|columns| {
        columns.iter().all(|column| main_effects.contains(column))
            // Checking every term's immediate predecessors proves full downward closure
            // without allocating 2^k subsets for an incomplete high-order interaction.
            && (columns.len() <= 2
                || (0..columns.len()).all(|omitted| {
                    let mut predecessor = columns.clone();
                    predecessor.remove(omitted);
                    interactions.contains_key(&predecessor)
                }))
    })
}

fn subsets(columns: &[String]) -> Vec<Vec<String>> {
    fn append_subsets(
        columns: &[String],
        index: usize,
        current: &mut Vec<String>,
        result: &mut Vec<Vec<String>>,
    ) {
        if index == columns.len() {
            result.push(current.clone());
            return;
        }
        append_subsets(columns, index + 1, current, result);
        current.push(columns[index].clone());
        append_subsets(columns, index + 1, current, result);
        current.pop();
    }

    let mut result = Vec::new();
    append_subsets(columns, 0, &mut Vec::new(), &mut result);
    result
}

fn centered_label(term: &FitModelResolvedTerm, means: &BTreeMap<String, f64>) -> String {
    match term.kind {
        FitModelTermKind::Main if term.column_names.len() == 1 => means
            .get(&term.column_names[0])
            .map(|mean| centered_factor(&term.column_names[0], *mean))
            .unwrap_or_else(|| term.label.clone()),
        FitModelTermKind::Interaction => term
            .column_names
            .iter()
            .map(|name| {
                means
                    .get(name)
                    .map(|mean| centered_factor(name, *mean))
                    .unwrap_or_else(|| name.clone())
            })
            .collect::<Vec<_>>()
            .join("*"),
        _ => term.label.clone(),
    }
}

fn centered_factor(name: &str, mean: f64) -> String {
    if mean < 0.0 {
        format!("({name}+{})", format_report_number(-mean))
    } else {
        format!("({name}-{})", format_report_number(mean))
    }
}

fn format_report_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let magnitude = value.abs().log10().floor() as i32;
    if !(-4..6).contains(&magnitude) {
        let text = format!("{value:.5e}");
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, ""));
        return format!(
            "{}e{}",
            mantissa.trim_end_matches('0').trim_end_matches('.'),
            exponent.trim_start_matches('+').trim_start_matches('0')
        );
    }
    let decimal_places = (5 - magnitude).max(0) as usize;
    let text = format!("{value:.decimal_places$}");
    if decimal_places == 0 {
        text
    } else {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nalgebra::{DMatrix, DVector};

    use crate::models::fit_model::{
        FitModelCenteringMethod, FitModelResolvedTerm, FitModelTermKind,
    };

    use super::reporting_basis;

    const TOLERANCE: f64 = 1e-4;

    fn term(
        term_id: &str,
        label: &str,
        kind: FitModelTermKind,
        column_names: &[&str],
    ) -> FitModelResolvedTerm {
        FitModelResolvedTerm {
            term_id: term_id.to_string(),
            kind,
            column_names: column_names
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            label: label.to_string(),
        }
    }

    fn main(name: &str) -> FitModelResolvedTerm {
        term(name, name, FitModelTermKind::Main, &[name])
    }

    fn interaction(names: &[&str]) -> FitModelResolvedTerm {
        let label = names.join("*");
        term(
            &format!("interaction:{label}"),
            &label,
            FitModelTermKind::Interaction,
            names,
        )
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= TOLERANCE,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn fitted_interaction_centering_is_not_applied_twice() {
        let coefficients = DVector::from_vec(vec![1.0, 2.0, 3.0, 4.0]);
        let geometry = DMatrix::identity(4, 4);
        let terms = vec![main("A"), main("B"), interaction(&["A", "B"])];
        let means = BTreeMap::from([("A".to_string(), 1.0), ("B".to_string(), 2.0)]);

        for (construction, expected) in [
            (FitModelCenteringMethod::None, vec![17.0, 10.0, 7.0, 4.0]),
            (FitModelCenteringMethod::Mean, vec![9.0, 2.0, 3.0, 4.0]),
        ] {
            let reporting =
                reporting_basis(&coefficients, &geometry, &terms, &means, &construction)
                    .expect("reporting basis");
            assert_eq!(reporting.coefficients.as_slice(), expected.as_slice());
            if construction == FitModelCenteringMethod::Mean {
                assert_eq!(
                    reporting.covariance_geometry,
                    DMatrix::from_row_slice(
                        4,
                        4,
                        &[
                            6.0, 1.0, 2.0, 0.0, 1.0, 1.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                            0.0, 1.0,
                        ]
                    )
                );
            }
        }
    }

    #[test]
    fn large_incomplete_interaction_returns_fitted_basis_without_enumerating_power_set() {
        let names = (0..80).map(|index| format!("X{index}")).collect::<Vec<_>>();
        let mut terms = names.iter().map(|name| main(name)).collect::<Vec<_>>();
        terms.push(interaction(
            &names.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        let coefficients = DVector::from_element(terms.len() + 1, 1.0);
        let geometry = DMatrix::identity(terms.len() + 1, terms.len() + 1);
        let reporting = reporting_basis(
            &coefficients,
            &geometry,
            &terms,
            &BTreeMap::new(),
            &FitModelCenteringMethod::None,
        )
        .expect("non-hierarchical fallback does not require means");
        assert!(!reporting.centered);
        assert_eq!(reporting.coefficients, coefficients);
        assert_eq!(reporting.covariance_geometry, geometry);
    }

    #[test]
    fn centered_labels_preserve_large_integer_means() {
        assert_eq!(super::centered_factor("X", 100000.0), "(X-100000)");
        assert_eq!(super::centered_factor("X", -100000.0), "(X+100000)");
        assert_eq!(super::centered_factor("X", 1.23000), "(X-1.23)");
        assert_eq!(super::centered_factor("X", 0.0), "(X-0)");
    }

    #[test]
    fn two_way_interaction_uses_centered_reporting_basis() {
        let coefficients = DVector::from_vec(vec![-14.5521, 146.213, 209.243, -334.874]);
        let geometry = DMatrix::identity(4, 4);
        let terms = vec![main("A"), main("B"), interaction(&["A", "B"])];
        let means = BTreeMap::from([("A".to_string(), 0.37388), ("B".to_string(), 0.39633)]);

        let reporting = reporting_basis(
            &coefficients,
            &geometry,
            &terms,
            &means,
            &FitModelCenteringMethod::None,
        )
        .expect("reporting basis");

        assert!(reporting.centered);
        assert_close(reporting.coefficients[0], 73.4217120584104);
        assert_close(reporting.coefficients[1], 13.49238758);
        assert_close(reporting.coefficients[2], 84.04030888);
        assert_close(reporting.coefficients[3], -334.874);
        assert_eq!(reporting.term_labels[3], "(A-0.37388)*(B-0.39633)");
    }

    #[test]
    fn incomplete_three_way_hierarchy_preserves_raw_basis() {
        let coefficients = DVector::from_vec(vec![1.0, 2.0, 3.0, 4.0, 5.0]);
        let geometry = DMatrix::identity(5, 5);
        let terms = vec![
            main("A"),
            main("B"),
            main("C"),
            interaction(&["A", "B", "C"]),
        ];
        let means = BTreeMap::from([
            ("A".to_string(), 1.0),
            ("B".to_string(), 2.0),
            ("C".to_string(), 3.0),
        ]);

        let reporting = reporting_basis(
            &coefficients,
            &geometry,
            &terms,
            &means,
            &FitModelCenteringMethod::None,
        )
        .expect("reporting basis");

        assert!(!reporting.centered);
        assert_eq!(reporting.coefficients, coefficients);
        assert_eq!(reporting.term_labels[4], "A*B*C");
    }

    #[test]
    fn two_way_interaction_without_main_effects_preserves_raw_basis() {
        let coefficients = DVector::from_vec(vec![1.0, 2.0]);
        let geometry = DMatrix::identity(2, 2);
        let terms = vec![interaction(&["A", "B"])];
        let means = BTreeMap::from([("A".to_string(), 1.0), ("B".to_string(), 2.0)]);

        let reporting = reporting_basis(
            &coefficients,
            &geometry,
            &terms,
            &means,
            &FitModelCenteringMethod::None,
        )
        .expect("reporting basis");

        assert!(!reporting.centered);
        assert_eq!(reporting.coefficients, coefficients);
        assert_eq!(reporting.covariance_geometry, geometry);
        assert_eq!(reporting.term_labels, vec!["Intercept", "A*B"]);
    }

    #[test]
    fn complete_three_way_hierarchy_preserves_predictions() {
        let coefficients = DVector::from_vec(vec![0.7, -1.2, 2.3, 0.4, 1.1, -0.8, 0.6, 3.2]);
        let geometry = DMatrix::identity(8, 8);
        let terms = vec![
            main("A"),
            main("B"),
            main("C"),
            interaction(&["A", "B"]),
            interaction(&["A", "C"]),
            interaction(&["B", "C"]),
            interaction(&["A", "B", "C"]),
        ];
        let means = BTreeMap::from([
            ("A".to_string(), 0.5),
            ("B".to_string(), -1.0),
            ("C".to_string(), 2.0),
        ]);
        let rows = [
            [0.0, -2.0, 1.0],
            [0.5, -1.0, 2.0],
            [1.5, 3.0, -4.0],
            [-2.0, 0.25, 5.0],
        ];
        let raw_design = DMatrix::from_fn(rows.len(), 8, |row, column| {
            let [a, b, c] = rows[row];
            [1.0, a, b, c, a * b, a * c, b * c, a * b * c][column]
        });
        let centered_design = DMatrix::from_fn(rows.len(), 8, |row, column| {
            let [a, b, c] = rows[row];
            let (a, b, c) = (a - 0.5, b + 1.0, c - 2.0);
            [1.0, a, b, c, a * b, a * c, b * c, a * b * c][column]
        });

        let hybrid_design = DMatrix::from_fn(rows.len(), 8, |row, column| {
            if (1..=3).contains(&column) {
                rows[row][column - 1]
            } else {
                centered_design[(row, column)]
            }
        });
        for (construction, fitted_design) in [
            (FitModelCenteringMethod::None, raw_design),
            (FitModelCenteringMethod::Mean, hybrid_design),
        ] {
            let reporting =
                reporting_basis(&coefficients, &geometry, &terms, &means, &construction)
                    .expect("reporting basis");
            assert!(reporting.centered);
            let fitted_predictions = fitted_design * &coefficients;
            let report_predictions = &centered_design * &reporting.coefficients;
            for row in 0..rows.len() {
                assert_close(fitted_predictions[row], report_predictions[row]);
            }
        }
    }

    #[test]
    fn rejects_dimension_mismatches_and_non_finite_means() {
        let coefficients = DVector::from_vec(vec![1.0, 2.0, 3.0, 4.0]);
        let geometry = DMatrix::identity(4, 4);
        let terms = vec![main("A"), main("B"), interaction(&["A", "B"])];
        let means = BTreeMap::from([("A".to_string(), f64::NAN), ("B".to_string(), 2.0)]);

        assert!(reporting_basis(
            &DVector::from_vec(vec![1.0, 2.0]),
            &geometry,
            &terms,
            &means,
            &FitModelCenteringMethod::None
        )
        .is_err());
        assert!(reporting_basis(
            &coefficients,
            &geometry,
            &terms,
            &means,
            &FitModelCenteringMethod::None
        )
        .is_err());
    }
}
