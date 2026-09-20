use nalgebra::{DMatrix, DVector};
use statrs::distribution::{ContinuousCDF, FisherSnedecor, StudentsT};

use crate::engine::fit_model::ols::{deterministic_rank_grid, FitModelEngineError};
use crate::models::fit_model::{
    FitModelEffectTest, FitModelInferenceReason, FitModelLeverageBandPoint, FitModelLeveragePlot,
    FitModelLeveragePoint, FitModelResolvedTerm,
};

const ROUNDING_CLAMP_FACTOR: f64 = 1e-12;
const MIN_P_VALUE: f64 = 1e-300;
const GRAPH_SCATTER_RENDER_BUDGET: usize = crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET;

struct EffectColumns<'a> {
    term: &'a FitModelResolvedTerm,
    columns: Vec<usize>,
}

pub(crate) fn compute_effect_tests(
    design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    terms: &[FitModelResolvedTerm],
    full_sse: f64,
    full_mse: Option<f64>,
    error_degrees_of_freedom: u64,
) -> Result<Vec<FitModelEffectTest>, FitModelEngineError> {
    if design_matrix.nrows() != response.len() {
        return Err(FitModelEngineError::InvalidInput(
            "design matrix row count must match response length".to_string(),
        ));
    }
    if design_matrix.ncols() != terms.len() + 1 {
        return Err(FitModelEngineError::InvalidInput(
            "resolved terms must map to all non-intercept design columns".to_string(),
        ));
    }
    if !full_sse.is_finite() || full_sse < 0.0 {
        return Err(FitModelEngineError::NumericalFailure(
            "full-model SSE must be finite and non-negative".to_string(),
        ));
    }

    let effects = group_effect_columns(terms);
    let full_rank = matrix_rank(design_matrix);
    let response_energy = response.dot(response);
    let mut results = Vec::with_capacity(effects.len());

    for effect in effects {
        let reduced = matrix_without_columns(design_matrix, &effect.columns);
        let reduced_svd = reduced.clone().svd(true, true);
        let reduced_rank = rank_from_singular_values(
            reduced_svd.singular_values.as_slice(),
            reduced.nrows(),
            reduced.ncols(),
        );
        let rank_tolerance = rank_tolerance(
            reduced_svd.singular_values.as_slice(),
            reduced.nrows(),
            reduced.ncols(),
        );
        let coefficients = reduced_svd
            .solve(response, rank_tolerance)
            .map_err(|_| FitModelEngineError::SolveFailure)?;
        let residuals = response - reduced * coefficients;
        let reduced_sse = residuals.dot(&residuals);
        let rounding_tolerance = ROUNDING_CLAMP_FACTOR
            * response_energy
                .abs()
                .max(full_sse.abs())
                .max(reduced_sse.abs())
                .max(1.0);
        let partial_ss =
            clamp_roundoff_negative(reduced_sse - full_sse, rounding_tolerance, "partial SS")?;
        let effect_df = directed_effect_df(full_rank, reduced_rank)?;
        let f_ratio = match (full_mse, effect_df, error_degrees_of_freedom) {
            (Some(mse), df, error_df) if mse.is_finite() && mse > 0.0 && df > 0 && error_df > 0 => {
                finite_or_none((partial_ss / df as f64) / mse)
            }
            _ => None,
        };
        let p_value =
            f_ratio.and_then(|ratio| upper_tail_f(ratio, effect_df, error_degrees_of_freedom));
        let reason = if f_ratio.is_some() && p_value.is_some() {
            None
        } else {
            Some(FitModelInferenceReason::InferenceNotEstimable)
        };

        results.push(FitModelEffectTest {
            term_id: effect.term.term_id.clone(),
            term_label: effect.term.label.clone(),
            number_of_parameters: effect.columns.len() as u64,
            degrees_of_freedom: effect_df,
            sum_of_squares: Some(partial_ss),
            f_ratio,
            p_value,
            reason,
        });
    }

    Ok(results)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compute_effect_leverage_plots(
    design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    row_indexes: &[u64],
    terms: &[FitModelResolvedTerm],
    effect_tests: &[FitModelEffectTest],
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Result<Vec<FitModelLeveragePlot>, FitModelEngineError> {
    if design_matrix.nrows() != response.len() || response.len() != row_indexes.len() {
        return Err(FitModelEngineError::InvalidInput(
            "design matrix, response, and row indexes must have equal row counts".to_string(),
        ));
    }
    if design_matrix.ncols() != terms.len() + 1 {
        return Err(FitModelEngineError::InvalidInput(
            "resolved terms must map to all non-intercept design columns".to_string(),
        ));
    }
    if !(0.0..1.0).contains(&confidence_level) {
        return Err(FitModelEngineError::InvalidConfidenceLevel(
            confidence_level,
        ));
    }

    let response_mean = vector_mean(response)?;
    let effects = group_effect_columns(terms);
    let sampled_ranks = deterministic_rank_grid(response.len() as u64, GRAPH_SCATTER_RENDER_BUDGET);
    let rows_sampled = sampled_ranks.len() < response.len();
    let mut plots = Vec::with_capacity(effects.len());

    for effect in effects {
        let effect_test = effect_tests
            .iter()
            .find(|test| test.term_id == effect.term.term_id)
            .ok_or_else(|| {
                FitModelEngineError::InvalidInput(format!(
                    "effect test missing for term {}",
                    effect.term.term_id
                ))
            })?;
        if effect.columns.len() != 1 {
            plots.push(FitModelLeveragePlot {
                term_id: effect.term.term_id.clone(),
                term_label: effect.term.label.clone(),
                p_value: effect_test.p_value.filter(|value| value.is_finite()),
                points: Vec::new(),
                confidence_band: Vec::new(),
                null_line_y: Some(response_mean),
                rows_sampled: false,
                source_row_count: response.len() as u64,
                reason: Some(FitModelInferenceReason::InferenceNotEstimable),
            });
            continue;
        }

        let selected_column = effect.columns[0];
        let selected = design_matrix.column(selected_column).into_owned();
        let effect_mean = vector_mean(&selected)?;
        let nuisance = matrix_without_columns(design_matrix, &[selected_column]);
        let residualized_x = residualize_against(&nuisance, &selected)?;
        let residualized_y = residualize_against(&nuisance, response)?;
        let residualized_x_energy = residualized_x.dot(&residualized_x);
        if !residualized_x_energy.is_finite() || residualized_x_energy <= 0.0 {
            return Err(FitModelEngineError::NumericalFailure(format!(
                "effect {} has no finite residualized variation",
                effect.term.term_id
            )));
        }
        let slope = residualized_x.dot(&residualized_y) / residualized_x_energy;
        if !slope.is_finite() {
            return Err(FitModelEngineError::NumericalFailure(format!(
                "effect {} produced a non-finite partial slope",
                effect.term.term_id
            )));
        }

        let mut points = Vec::with_capacity(sampled_ranks.len());
        for rank in &sampled_ranks {
            let index = (*rank - 1) as usize;
            let effect_leverage =
                finite_value(effect_mean + residualized_x[index], "effect leverage")?;
            let adjusted_response =
                finite_value(response_mean + residualized_y[index], "adjusted response")?;
            points.push(FitModelLeveragePoint {
                row_index: row_indexes[index],
                effect_leverage,
                adjusted_response,
            });
        }

        let inference_mse = mse.filter(|value| value.is_finite() && *value > 0.0);
        let reason = if effect_test.reason.is_some() {
            effect_test.reason.clone()
        } else if inference_mse.is_some() && error_degrees_of_freedom > 0 {
            None
        } else {
            Some(FitModelInferenceReason::InferenceNotEstimable)
        };
        let confidence_band = if let (None, Some(inference_mse)) = (&reason, inference_mse) {
            confidence_band(
                &points,
                effect_mean,
                response_mean,
                slope,
                residualized_x_energy,
                inference_mse,
                error_degrees_of_freedom,
                confidence_level,
                response.len(),
            )?
        } else {
            Vec::new()
        };

        plots.push(FitModelLeveragePlot {
            term_id: effect.term.term_id.clone(),
            term_label: effect.term.label.clone(),
            p_value: effect_test.p_value.filter(|value| value.is_finite()),
            points,
            confidence_band,
            null_line_y: Some(response_mean),
            rows_sampled,
            source_row_count: response.len() as u64,
            reason,
        });
    }

    Ok(plots)
}

fn group_effect_columns(terms: &[FitModelResolvedTerm]) -> Vec<EffectColumns<'_>> {
    let mut effects: Vec<EffectColumns<'_>> = Vec::new();
    for (term_index, term) in terms.iter().enumerate() {
        if let Some(effect) = effects
            .iter_mut()
            .find(|effect| effect.term.term_id == term.term_id)
        {
            effect.columns.push(term_index + 1);
        } else {
            effects.push(EffectColumns {
                term,
                columns: vec![term_index + 1],
            });
        }
    }
    effects
}

fn residualize_against(
    nuisance: &DMatrix<f64>,
    values: &DVector<f64>,
) -> Result<DVector<f64>, FitModelEngineError> {
    let svd = nuisance.clone().svd(true, true);
    let tolerance = rank_tolerance(
        svd.singular_values.as_slice(),
        nuisance.nrows(),
        nuisance.ncols(),
    );
    let coefficients = svd
        .solve(values, tolerance)
        .map_err(|_| FitModelEngineError::SolveFailure)?;
    let residualized = values - nuisance * coefficients;
    if residualized.iter().any(|value| !value.is_finite()) {
        return Err(FitModelEngineError::NumericalFailure(
            "nuisance projection produced non-finite values".to_string(),
        ));
    }
    Ok(residualized)
}

#[allow(clippy::too_many_arguments)]
fn confidence_band(
    points: &[FitModelLeveragePoint],
    effect_mean: f64,
    response_mean: f64,
    slope: f64,
    residualized_x_energy: f64,
    mse: f64,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
    source_row_count: usize,
) -> Result<Vec<FitModelLeverageBandPoint>, FitModelEngineError> {
    let distribution = StudentsT::new(0.0, 1.0, error_degrees_of_freedom as f64).map_err(|_| {
        FitModelEngineError::NumericalFailure(
            "failed to construct leverage confidence distribution".to_string(),
        )
    })?;
    let critical = distribution.inverse_cdf(0.5 + confidence_level / 2.0);
    if !critical.is_finite() {
        return Err(FitModelEngineError::NumericalFailure(
            "leverage confidence critical value is non-finite".to_string(),
        ));
    }

    let mut effect_leverages = points
        .iter()
        .map(|point| point.effect_leverage)
        .collect::<Vec<_>>();
    effect_leverages.sort_by(f64::total_cmp);
    effect_leverages
        .into_iter()
        .map(|effect_leverage| {
            let centered = effect_leverage - effect_mean;
            let fitted = finite_value(response_mean + slope * centered, "leverage fitted value")?;
            let standard_error = (mse
                * (1.0 / source_row_count as f64 + centered * centered / residualized_x_energy))
                .sqrt();
            let margin = finite_value(critical * standard_error, "leverage confidence margin")?;
            Ok(FitModelLeverageBandPoint {
                effect_leverage,
                fitted,
                lower: finite_value(fitted - margin, "leverage confidence lower bound")?,
                upper: finite_value(fitted + margin, "leverage confidence upper bound")?,
            })
        })
        .collect()
}

fn vector_mean(values: &DVector<f64>) -> Result<f64, FitModelEngineError> {
    if values.is_empty() {
        return Err(FitModelEngineError::InvalidInput(
            "leverage inputs must be non-empty".to_string(),
        ));
    }
    finite_value(
        values.iter().sum::<f64>() / values.len() as f64,
        "leverage mean",
    )
}

fn finite_value(value: f64, label: &str) -> Result<f64, FitModelEngineError> {
    if value.is_finite() {
        Ok(normalize_signed_zero(value))
    } else {
        Err(FitModelEngineError::NumericalFailure(format!(
            "{label} is non-finite"
        )))
    }
}

fn matrix_without_columns(matrix: &DMatrix<f64>, removed: &[usize]) -> DMatrix<f64> {
    let retained = (0..matrix.ncols())
        .filter(|column| !removed.contains(column))
        .collect::<Vec<_>>();
    DMatrix::from_fn(matrix.nrows(), retained.len(), |row, column| {
        matrix[(row, retained[column])]
    })
}

fn matrix_rank(matrix: &DMatrix<f64>) -> usize {
    let singular_values = matrix.clone().svd(false, false).singular_values;
    rank_from_singular_values(singular_values.as_slice(), matrix.nrows(), matrix.ncols())
}

fn rank_from_singular_values(singular_values: &[f64], n: usize, p: usize) -> usize {
    let tolerance = rank_tolerance(singular_values, n, p);
    singular_values
        .iter()
        .filter(|value| **value > tolerance)
        .count()
}

fn rank_tolerance(singular_values: &[f64], n: usize, p: usize) -> f64 {
    let sigma_max = singular_values.iter().copied().fold(0.0_f64, f64::max);
    n.max(p) as f64 * f64::EPSILON * sigma_max
}

fn directed_effect_df(full_rank: usize, reduced_rank: usize) -> Result<u64, FitModelEngineError> {
    let difference = full_rank.checked_sub(reduced_rank).ok_or_else(|| {
        FitModelEngineError::NumericalFailure(
            "reduced-model rank exceeded full-model rank".to_string(),
        )
    })?;
    u64::try_from(difference).map_err(|_| {
        FitModelEngineError::NumericalFailure(
            "effect degrees of freedom exceeded supported range".to_string(),
        )
    })
}

fn upper_tail_f(f_ratio: f64, numerator_df: u64, denominator_df: u64) -> Option<f64> {
    if numerator_df == 0 || denominator_df == 0 {
        return None;
    }
    FisherSnedecor::new(numerator_df as f64, denominator_df as f64)
        .ok()
        .map(|distribution| distribution.sf(f_ratio.max(0.0)))
        .and_then(clamp_probability)
}

fn clamp_probability(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    finite_or_none(value.clamp(0.0, 1.0).max(MIN_P_VALUE))
}

fn finite_or_none(value: f64) -> Option<f64> {
    value.is_finite().then_some(normalize_signed_zero(value))
}

fn clamp_roundoff_negative(
    value: f64,
    tolerance: f64,
    label: &str,
) -> Result<f64, FitModelEngineError> {
    if !value.is_finite() {
        return Err(FitModelEngineError::NumericalFailure(format!(
            "{label} is non-finite"
        )));
    }
    if value < 0.0 {
        if value >= -tolerance {
            return Ok(0.0);
        }
        return Err(FitModelEngineError::NumericalFailure(format!(
            "{label} is negative beyond tolerance"
        )));
    }
    Ok(normalize_signed_zero(value))
}

fn normalize_signed_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use nalgebra::{DMatrix, DVector};

    use crate::models::fit_model::{
        FitModelEffectTest, FitModelInferenceReason, FitModelResolvedTerm, FitModelTermKind,
    };

    use super::{
        compute_effect_leverage_plots, compute_effect_tests, directed_effect_df,
        rank_from_singular_values, rank_tolerance,
    };

    const TOLERANCE: f64 = 1e-9;

    fn fixture() -> (DMatrix<f64>, DVector<f64>, Vec<FitModelResolvedTerm>) {
        let design = DMatrix::from_row_slice(
            8,
            4,
            &[
                1.0, -1.0, -1.0, 1.0, //
                1.0, -1.0, -1.0, 1.0, //
                1.0, -1.0, 1.0, -1.0, //
                1.0, -1.0, 1.0, -1.0, //
                1.0, 1.0, -1.0, -1.0, //
                1.0, 1.0, -1.0, -1.0, //
                1.0, 1.0, 1.0, 1.0, //
                1.0, 1.0, 1.0, 1.0,
            ],
        );
        let response = DVector::from_vec(vec![1.0, -1.0, -1.0, -3.0, -3.0, -5.0, 11.0, 9.0]);
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("B", "B", FitModelTermKind::Main, &["B"]),
            term(
                "interaction:A*B",
                "A*B",
                FitModelTermKind::Interaction,
                &["A", "B"],
            ),
        ];
        (design, response, terms)
    }

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

    fn explicit_reduced_sse(
        design: &DMatrix<f64>,
        response: &DVector<f64>,
        removed_column: usize,
    ) -> f64 {
        explicit_sse_without_columns(design, response, &[removed_column])
    }

    fn explicit_sse_without_columns(
        design: &DMatrix<f64>,
        response: &DVector<f64>,
        removed_columns: &[usize],
    ) -> f64 {
        let retained_columns = (0..design.ncols())
            .filter(|column| !removed_columns.contains(column))
            .collect::<Vec<_>>();
        let reduced = DMatrix::from_fn(design.nrows(), retained_columns.len(), |row, column| {
            design[(row, retained_columns[column])]
        });
        let svd = reduced.clone().svd(true, true);
        let sigma_max = svd.singular_values.iter().copied().fold(0.0_f64, f64::max);
        let tolerance = design.nrows().max(reduced.ncols()) as f64 * f64::EPSILON * sigma_max;
        let coefficients = svd
            .solve(response, tolerance)
            .expect("explicit reduced model should solve");
        let residuals = response - reduced * coefficients;
        residuals.dot(&residuals)
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= TOLERANCE,
            "expected {expected}, got {actual}"
        );
    }

    fn explicit_residualize(matrix: &DMatrix<f64>, values: &DVector<f64>) -> DVector<f64> {
        let svd = matrix.clone().svd(true, true);
        let sigma_max = svd.singular_values.iter().copied().fold(0.0_f64, f64::max);
        let tolerance = matrix.nrows().max(matrix.ncols()) as f64 * f64::EPSILON * sigma_max;
        let pseudoinverse = svd
            .pseudo_inverse(tolerance)
            .expect("explicit nuisance pseudoinverse should exist");
        let residual_projection =
            DMatrix::identity(matrix.nrows(), matrix.nrows()) - matrix * pseudoinverse;
        residual_projection * values
    }

    #[test]
    fn leverage_matches_explicit_partial_regression_projection() {
        let (design, response, terms) = fixture();
        let effect_tests = compute_effect_tests(&design, &response, &terms, 8.0, Some(2.0), 4)
            .expect("effect tests should compute");
        let row_indexes = vec![101, 103, 107, 109, 113, 127, 131, 137];

        let plots = compute_effect_leverage_plots(
            &design,
            &response,
            &row_indexes,
            &terms,
            &effect_tests,
            Some(2.0),
            4,
            0.95,
        )
        .expect("leverage plots should compute");

        let plot = plots
            .iter()
            .find(|candidate| candidate.term_id == "A")
            .expect("A leverage plot");
        let nuisance = DMatrix::from_fn(design.nrows(), 3, |row, column| {
            design[(row, [0, 2, 3][column])]
        });
        let selected = design.column(1).into_owned();
        let residualized_x = explicit_residualize(&nuisance, &selected);
        let residualized_y = explicit_residualize(&nuisance, &response);
        let effect_mean = selected.iter().sum::<f64>() / selected.len() as f64;
        let response_mean = response.iter().sum::<f64>() / response.len() as f64;
        let beta_effect = residualized_x.dot(&residualized_y) / residualized_x.dot(&residualized_x);

        assert_eq!(
            plot.points
                .iter()
                .map(|point| point.row_index)
                .collect::<Vec<_>>(),
            row_indexes
        );
        for (row, point) in plot.points.iter().enumerate() {
            assert_close(point.effect_leverage, effect_mean + residualized_x[row]);
            assert_close(point.adjusted_response, response_mean + residualized_y[row]);
        }
        assert!(plot
            .confidence_band
            .windows(2)
            .all(|pair| pair[0].effect_leverage <= pair[1].effect_leverage));
        for band in &plot.confidence_band {
            assert_close(
                band.fitted,
                response_mean + beta_effect * (band.effect_leverage - effect_mean),
            );
            assert!(band.lower.is_finite());
            assert!(band.upper.is_finite());
            assert!(band.lower <= band.fitted);
            assert!(band.fitted <= band.upper);
        }
        assert_close(plot.null_line_y.expect("null line"), response_mean);
        assert!(!plot.rows_sampled);
        assert_eq!(plot.source_row_count, 8);
        assert_eq!(plot.reason, None);
    }

    #[test]
    fn leverage_sampling_is_bounded_and_deterministic() {
        let row_count = 8_002;
        let design = DMatrix::from_fn(row_count, 2, |row, column| {
            if column == 0 {
                1.0
            } else {
                row as f64 / 100.0
            }
        });
        let response = DVector::from_fn(row_count, |row, _| {
            3.0 + 1.5 * design[(row, 1)] + (row % 7) as f64 / 10.0
        });
        let row_indexes = (0..row_count)
            .map(|row| 10_000 + row as u64 * 3)
            .collect::<Vec<_>>();
        let terms = vec![term("X", "X", FitModelTermKind::Main, &["X"])];
        let effect_tests = vec![FitModelEffectTest {
            term_id: "X".to_string(),
            term_label: "X".to_string(),
            number_of_parameters: 1,
            degrees_of_freedom: 1,
            sum_of_squares: Some(1.0),
            f_ratio: Some(1.0),
            p_value: Some(0.5),
            reason: None,
        }];

        let first = compute_effect_leverage_plots(
            &design,
            &response,
            &row_indexes,
            &terms,
            &effect_tests,
            Some(0.1),
            (row_count - 2) as u64,
            0.95,
        )
        .expect("first leverage plot should compute");
        let second = compute_effect_leverage_plots(
            &design,
            &response,
            &row_indexes,
            &terms,
            &effect_tests,
            Some(0.1),
            (row_count - 2) as u64,
            0.95,
        )
        .expect("second leverage plot should compute");
        let first_ids = first[0]
            .points
            .iter()
            .map(|point| point.row_index)
            .collect::<Vec<_>>();
        let second_ids = second[0]
            .points
            .iter()
            .map(|point| point.row_index)
            .collect::<Vec<_>>();

        assert_eq!(first_ids, second_ids);
        assert_eq!(first_ids.len(), 8_000);
        assert_eq!(first_ids.first(), row_indexes.first());
        assert_eq!(first_ids.last(), row_indexes.last());
        assert!(first[0].rows_sampled);
        assert_eq!(first[0].source_row_count, row_count as u64);
    }

    #[test]
    fn leverage_keeps_points_when_inference_is_unavailable() {
        let (design, response, terms) = fixture();
        let effect_tests = compute_effect_tests(&design, &response, &terms, 8.0, None, 0)
            .expect("effect geometry should compute");
        let row_indexes = (1..=8).collect::<Vec<_>>();

        let plots = compute_effect_leverage_plots(
            &design,
            &response,
            &row_indexes,
            &terms,
            &effect_tests,
            None,
            0,
            0.95,
        )
        .expect("leverage points should remain available");

        assert_eq!(plots.len(), 3);
        assert!(plots.iter().all(|plot| !plot.points.is_empty()));
        assert!(plots.iter().all(|plot| plot.confidence_band.is_empty()));
        assert!(plots
            .iter()
            .all(|plot| { plot.reason == Some(FitModelInferenceReason::InferenceNotEstimable) }));
        assert!(plots.iter().all(|plot| plot.null_line_y.is_some()));
    }

    #[test]
    fn leverage_marks_multi_column_effect_non_estimable() {
        let design = DMatrix::from_row_slice(
            6,
            4,
            &[
                1.0, 0.0, 0.0, 0.0, //
                1.0, 1.0, 0.0, 0.0, //
                1.0, 0.0, 1.0, 0.0, //
                1.0, 1.0, 1.0, 0.0, //
                1.0, 0.0, 0.0, 1.0, //
                1.0, 1.0, 2.0, 2.0,
            ],
        );
        let response = DVector::from_vec(vec![1.0, 3.0, 4.0, 6.0, 6.0, 19.0]);
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("B", "B", FitModelTermKind::Main, &["B"]),
        ];
        let effect_tests = compute_effect_tests(&design, &response, &terms, 0.0, Some(1.0), 2)
            .expect("effect tests should compute");

        let plots = compute_effect_leverage_plots(
            &design,
            &response,
            &[1, 2, 3, 4, 5, 6],
            &terms,
            &effect_tests,
            Some(1.0),
            2,
            0.95,
        )
        .expect("leverage payloads should compute");
        let grouped = plots
            .iter()
            .find(|plot| plot.term_id == "A")
            .expect("grouped effect payload");

        assert!(grouped.points.is_empty());
        assert!(grouped.confidence_band.is_empty());
        assert_eq!(
            grouped.reason,
            Some(FitModelInferenceReason::InferenceNotEstimable)
        );
    }

    #[test]
    fn type_three_effect_tests_match_reduced_model_sse() {
        let (design, response, terms) = fixture();
        let full_sse = 8.0;
        let tests = compute_effect_tests(&design, &response, &terms, full_sse, Some(2.0), 4)
            .expect("effect tests should compute");
        let expected_p_values = [
            0.01613008990009246,
            0.0038825370469606213,
            0.0013238969092171926,
        ];

        assert_eq!(tests.len(), 3);
        for (index, test) in tests.iter().enumerate() {
            assert_eq!(test.term_id, terms[index].term_id);
            assert_eq!(test.number_of_parameters, 1);
            assert_eq!(test.degrees_of_freedom, 1);
            let expected_ss = explicit_reduced_sse(&design, &response, index + 1) - full_sse;
            assert_close(test.sum_of_squares.expect("sum of squares"), expected_ss);
            assert_close(test.f_ratio.expect("F ratio"), expected_ss / 2.0);
            assert_close(test.p_value.expect("p-value"), expected_p_values[index]);
            assert_eq!(test.reason, None);
        }
    }

    #[test]
    fn type_three_tests_are_invariant_to_term_order() {
        let (design, response, terms) = fixture();
        let reordered_design = DMatrix::from_fn(8, 4, |row, column| match column {
            1 => design[(row, 2)],
            2 => design[(row, 1)],
            _ => design[(row, column)],
        });
        let reordered_terms = vec![terms[1].clone(), terms[0].clone(), terms[2].clone()];
        let original = compute_effect_tests(&design, &response, &terms, 8.0, Some(2.0), 4)
            .expect("original effect tests should compute");
        let reordered = compute_effect_tests(
            &reordered_design,
            &response,
            &reordered_terms,
            8.0,
            Some(2.0),
            4,
        )
        .expect("reordered effect tests should compute");

        for expected in original {
            let actual = reordered
                .iter()
                .find(|candidate| candidate.term_id == expected.term_id)
                .expect("term should remain present");
            assert_eq!(actual.number_of_parameters, expected.number_of_parameters);
            assert_eq!(actual.degrees_of_freedom, expected.degrees_of_freedom);
            assert_close(
                actual.sum_of_squares.expect("sum of squares"),
                expected.sum_of_squares.expect("sum of squares"),
            );
            assert_close(
                actual.f_ratio.expect("F ratio"),
                expected.f_ratio.expect("F ratio"),
            );
            assert_close(
                actual.p_value.expect("p-value"),
                expected.p_value.expect("p-value"),
            );
        }
    }

    #[test]
    fn effect_test_marks_inference_unavailable_without_error_df() {
        let (design, response, terms) = fixture();
        let tests = compute_effect_tests(&design, &response, &terms, 8.0, None, 0)
            .expect("effect sums of squares should still compute");

        assert_eq!(tests.len(), 3);
        for (index, test) in tests.iter().enumerate() {
            assert_eq!(test.term_id, terms[index].term_id);
            assert_eq!(test.number_of_parameters, 1);
            assert_eq!(test.degrees_of_freedom, 1);
            let expected_ss = explicit_reduced_sse(&design, &response, index + 1) - 8.0;
            assert_close(test.sum_of_squares.expect("sum of squares"), expected_ss);
            assert_eq!(test.f_ratio, None);
            assert_eq!(test.p_value, None);
            assert_eq!(
                test.reason,
                Some(FitModelInferenceReason::InferenceNotEstimable)
            );
        }
    }

    #[test]
    fn non_orthogonal_effect_uses_partial_not_sequential_sum_of_squares() {
        let design = DMatrix::from_row_slice(
            6,
            3,
            &[
                1.0, 0.0, 0.0, //
                1.0, 1.0, 1.0, //
                1.0, 2.0, 1.0, //
                1.0, 3.0, 2.0, //
                1.0, 4.0, 3.0, //
                1.0, 5.0, 5.0,
            ],
        );
        let response = DVector::from_vec(vec![2.0, 5.0, 8.0, 12.0, 14.0, 20.0]);
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("B", "B", FitModelTermKind::Main, &["B"]),
        ];
        let full_sse = explicit_sse_without_columns(&design, &response, &[]);
        let partial_a = explicit_sse_without_columns(&design, &response, &[1]) - full_sse;
        let intercept_only_sse = explicit_sse_without_columns(&design, &response, &[1, 2]);
        let intercept_and_a_sse = explicit_sse_without_columns(&design, &response, &[2]);
        let sequential_a = intercept_only_sse - intercept_and_a_sse;

        let tests = compute_effect_tests(&design, &response, &terms, full_sse, Some(1.0), 3)
            .expect("effect tests should compute");

        assert_close(
            tests[0].sum_of_squares.expect("partial sum of squares"),
            partial_a,
        );
        assert!(
            (partial_a - sequential_a).abs() > 1e-6,
            "fixture must distinguish partial and sequential sums of squares"
        );
    }

    #[test]
    fn grouped_effect_uses_column_count_and_rank_difference() {
        let design = DMatrix::from_row_slice(
            6,
            4,
            &[
                1.0, 0.0, 0.0, 0.0, //
                1.0, 1.0, 0.0, 0.0, //
                1.0, 0.0, 1.0, 0.0, //
                1.0, 1.0, 1.0, 0.0, //
                1.0, 0.0, 0.0, 1.0, //
                1.0, 1.0, 2.0, 2.0,
            ],
        );
        let response = DVector::from_vec(vec![1.0, 3.0, 4.0, 6.0, 6.0, 19.0]);
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("B", "B", FitModelTermKind::Main, &["B"]),
        ];

        let tests = compute_effect_tests(&design, &response, &terms, 0.0, Some(1.0), 2)
            .expect("grouped effect tests should compute");

        assert_eq!(tests.len(), 2);
        assert_eq!(tests[0].term_id, "A");
        assert_eq!(tests[0].number_of_parameters, 2);
        assert_eq!(tests[0].degrees_of_freedom, 2);
        assert_eq!(tests[1].term_id, "B");
        assert_eq!(tests[1].number_of_parameters, 1);
        assert_eq!(tests[1].degrees_of_freedom, 1);
    }

    #[test]
    fn reversed_rank_order_is_a_numerical_failure() {
        let error = directed_effect_df(2, 3).expect_err("reversed rank must fail");

        assert!(matches!(
            error,
            super::FitModelEngineError::NumericalFailure(message)
                if message.contains("reduced-model rank")
        ));
    }

    #[test]
    fn rank_classification_uses_exact_svd_tolerance_boundary() {
        let n = 10;
        let p = 4;
        let sigma_max = 8.0;
        let expected_tolerance = n.max(p) as f64 * f64::EPSILON * sigma_max;
        let just_below = f64::from_bits(expected_tolerance.to_bits() - 1);
        let just_above = f64::from_bits(expected_tolerance.to_bits() + 1);
        let singular_values = [sigma_max, just_above, expected_tolerance, just_below];

        assert!(just_below < expected_tolerance);
        assert!(just_above > expected_tolerance);
        assert_eq!(rank_tolerance(&singular_values, n, p), expected_tolerance);
        assert_eq!(rank_from_singular_values(&singular_values, n, p), 2);
    }

    #[test]
    fn tiny_negative_partial_sum_of_squares_is_clamped_to_zero() {
        let design = DMatrix::from_row_slice(4, 2, &[1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 2.0]);
        let response = DVector::from_element(4, 2.0);
        let terms = vec![term("A", "A", FitModelTermKind::Main, &["A"])];

        let tests = compute_effect_tests(&design, &response, &terms, 1e-14, Some(1.0), 2)
            .expect("roundoff-sized negative partial SS should clamp");

        assert_eq!(tests[0].sum_of_squares, Some(0.0));
        assert_eq!(tests[0].f_ratio, Some(0.0));
        assert_eq!(tests[0].p_value, Some(1.0));
    }
}
