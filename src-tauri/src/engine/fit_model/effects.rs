use std::collections::BTreeMap;

use nalgebra::{DMatrix, DVector};
use statrs::distribution::{ContinuousCDF, FisherSnedecor};

use crate::engine::fit_model::ols::{deterministic_rank_grid, FitModelEngineError};
use crate::engine::fit_model::reporting_basis::FitModelReportingBasis;
use crate::models::fit_model::{
    FitModelActualByPredictedBandPoint, FitModelEffectTest, FitModelInferenceReason,
    FitModelLeverageBandPoint, FitModelLeveragePlot, FitModelLeveragePoint, FitModelResolvedTerm,
};

const ROUNDING_CLAMP_FACTOR: f64 = 1e-12;
const MIN_P_VALUE: f64 = 1e-300;
const GRAPH_SCATTER_RENDER_BUDGET: usize = crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET;

struct EffectColumns<'a> {
    term: &'a FitModelResolvedTerm,
    columns: Vec<usize>,
}

struct LeverageGeometry {
    contribution: DVector<f64>,
    constrained_residuals: DVector<f64>,
    full_residuals: DVector<f64>,
    hypothesis_sum_of_squares: f64,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compute_whole_model_confidence_band(
    fitted: &DVector<f64>,
    response_mean: f64,
    model_sum_of_squares: f64,
    model_degrees_of_freedom: u64,
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Result<Vec<FitModelActualByPredictedBandPoint>, FitModelEngineError> {
    if fitted.is_empty() {
        return Err(FitModelEngineError::InvalidInput(
            "whole model confidence inputs must be non-empty".to_string(),
        ));
    }
    if !(0.0..1.0).contains(&confidence_level) {
        return Err(FitModelEngineError::InvalidConfidenceLevel(
            confidence_level,
        ));
    }
    finite_value(response_mean, "whole model response mean")?;
    if !model_sum_of_squares.is_finite() || model_sum_of_squares < 0.0 {
        return Err(FitModelEngineError::NumericalFailure(
            "whole model sum of squares must be finite and non-negative".to_string(),
        ));
    }
    if fitted.iter().any(|value| !value.is_finite()) {
        return Err(FitModelEngineError::NumericalFailure(
            "whole model fitted coordinate is non-finite".to_string(),
        ));
    }

    let Some(inference_mse) = mse.filter(|value| value.is_finite() && *value > 0.0) else {
        return Ok(Vec::new());
    };
    if model_degrees_of_freedom == 0 || error_degrees_of_freedom == 0 {
        return Ok(Vec::new());
    }

    let mut predicted = if model_sum_of_squares == 0.0 {
        vec![response_mean]
    } else {
        let mut coordinates = fitted.iter().copied().collect::<Vec<_>>();
        coordinates.push(response_mean);
        coordinates
    };
    predicted.iter_mut().for_each(|value| {
        if *value == 0.0 {
            *value = 0.0;
        }
    });
    predicted.sort_by(f64::total_cmp);
    predicted.dedup_by(|left, right| left.total_cmp(right).is_eq());

    confidence_geometry(
        predicted,
        response_mean,
        response_mean,
        1.0,
        model_sum_of_squares,
        model_degrees_of_freedom,
        inference_mse,
        error_degrees_of_freedom,
        confidence_level,
        fitted.len(),
    )?
    .into_iter()
    .map(|(predicted, fitted, lower, upper)| {
        Ok(FitModelActualByPredictedBandPoint {
            predicted,
            fitted,
            lower,
            upper,
        })
    })
    .collect()
}

pub(crate) fn compute_effect_tests(
    design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    terms: &[FitModelResolvedTerm],
    reporting_basis: Option<&FitModelReportingBasis>,
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
    if let Some(reporting) = reporting_basis.filter(|basis| basis.centered) {
        return compute_centered_effect_tests(terms, reporting, full_mse, error_degrees_of_freedom);
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

fn compute_centered_effect_tests(
    terms: &[FitModelResolvedTerm],
    reporting: &FitModelReportingBasis,
    full_mse: Option<f64>,
    error_degrees_of_freedom: u64,
) -> Result<Vec<FitModelEffectTest>, FitModelEngineError> {
    let width = terms.len() + 1;
    if reporting.coefficients.len() != width
        || reporting.covariance_geometry.nrows() != width
        || reporting.covariance_geometry.ncols() != width
        || reporting.term_labels.len() != width
    {
        return Err(FitModelEngineError::InvalidInput(
            "centered reporting basis dimensions must match resolved terms".to_string(),
        ));
    }

    let effects = group_effect_columns(terms);
    let mut results = Vec::with_capacity(effects.len());
    for effect in effects {
        let b = DVector::from_iterator(
            effect.columns.len(),
            effect
                .columns
                .iter()
                .map(|index| reporting.coefficients[*index]),
        );
        let g = DMatrix::from_fn(effect.columns.len(), effect.columns.len(), |row, column| {
            reporting.covariance_geometry[(effect.columns[row], effect.columns[column])]
        });
        let effect_df = matrix_rank(&g) as u64;
        let estimable = effect_df == effect.columns.len() as u64 && effect_df > 0;
        let partial_ss = if estimable {
            let svd = g.clone().svd(true, true);
            let tolerance = rank_tolerance(svd.singular_values.as_slice(), g.nrows(), g.ncols());
            let solved = svd
                .solve(&b, tolerance)
                .map_err(|_| FitModelEngineError::SolveFailure)?;
            let value = b.dot(&solved);
            if !value.is_finite() || value < 0.0 {
                return Err(FitModelEngineError::NumericalFailure(format!(
                    "effect {} produced invalid centered partial SS",
                    effect.term.term_id
                )));
            }
            Some(value)
        } else {
            None
        };
        let f_ratio = match (partial_ss, full_mse, effect_df, error_degrees_of_freedom) {
            (Some(ss), Some(mse), df, error_df)
                if mse.is_finite() && mse > 0.0 && df > 0 && error_df > 0 =>
            {
                finite_or_none((ss / df as f64) / mse)
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
        let first_column = effect.columns[0];
        results.push(FitModelEffectTest {
            term_id: effect.term.term_id.clone(),
            term_label: reporting.term_labels[first_column].clone(),
            number_of_parameters: effect.columns.len() as u64,
            degrees_of_freedom: effect_df,
            sum_of_squares: partial_ss,
            f_ratio,
            p_value,
            reason,
        });
    }
    Ok(results)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compute_effect_leverage_plots(
    fitted_design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    row_indexes: &[u64],
    terms: &[FitModelResolvedTerm],
    reporting: &FitModelReportingBasis,
    effect_tests: &[FitModelEffectTest],
    predictor_means: &BTreeMap<String, f64>,
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Result<Vec<FitModelLeveragePlot>, FitModelEngineError> {
    if fitted_design_matrix.nrows() != response.len() || response.len() != row_indexes.len() {
        return Err(FitModelEngineError::InvalidInput(
            "design matrix, response, and row indexes must have equal row counts".to_string(),
        ));
    }
    if fitted_design_matrix.ncols() != terms.len() + 1 {
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
    let design_matrix = reporting.design_matrix(fitted_design_matrix)?;
    let design_singular_values = design_matrix.clone().svd(false, false).singular_values;
    let projection_rank_tolerance = rank_tolerance(
        design_singular_values.as_slice(),
        design_matrix.nrows(),
        design_matrix.ncols(),
    );
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
        if effect_test.degrees_of_freedom == 0 || effect_test.sum_of_squares.is_none() {
            plots.push(non_estimable_leverage_plot(
                effect.term,
                effect_test,
                response_mean,
                response.len(),
            ));
            continue;
        }

        let geometry = leverage_geometry(
            &design_matrix,
            response,
            &effect.columns,
            &effect.term.term_id,
        )?;
        if geometry.full_residuals.len() != response.len() {
            return Err(FitModelEngineError::NumericalFailure(format!(
                "effect {} produced incomplete leverage geometry",
                effect.term.term_id
            )));
        }
        let simple_continuous_main = effect.columns.len() == 1
            && effect.term.kind == crate::models::fit_model::FitModelTermKind::Main
            && effect.term.column_names.len() == 1;
        let (plot_center, slope, horizontal_coordinates, horizontal_energy) =
            if simple_continuous_main {
                let selected_column = effect.columns[0];
                let selected = design_matrix.column(selected_column).into_owned();
                let nuisance = matrix_without_columns(&design_matrix, &[selected_column]);
                let residualized_x = residualize_against(&nuisance, &selected)?;
                let residualized_x_energy = residualized_x.dot(&residualized_x);
                if !residualized_x_energy.is_finite() {
                    return Err(FitModelEngineError::NumericalFailure(format!(
                        "effect {} has non-finite residualized variation",
                        effect.term.term_id
                    )));
                }
                if residualized_x_energy <= projection_rank_tolerance * projection_rank_tolerance {
                    plots.push(non_estimable_leverage_plot(
                        effect.term,
                        effect_test,
                        response_mean,
                        response.len(),
                    ));
                    continue;
                }
                let predictor_mean = predictor_means
                    .get(&effect.term.column_names[0])
                    .copied()
                    .ok_or_else(|| {
                        FitModelEngineError::InvalidInput(format!(
                            "predictor mean is missing for {}",
                            effect.term.column_names[0]
                        ))
                    })?;
                if !predictor_mean.is_finite() {
                    return Err(FitModelEngineError::NumericalFailure(format!(
                        "predictor mean is non-finite for {}",
                        effect.term.column_names[0]
                    )));
                }
                (
                    predictor_mean,
                    reporting.coefficients[selected_column],
                    residualized_x.map(|value| predictor_mean + value),
                    residualized_x_energy,
                )
            } else {
                let hypothesis_sum_of_squares = if effect_test.sum_of_squares == Some(0.0) {
                    0.0
                } else {
                    geometry.hypothesis_sum_of_squares
                };
                (
                    response_mean,
                    1.0,
                    geometry.contribution.map(|value| response_mean + value),
                    hypothesis_sum_of_squares,
                )
            };

        let mut points = Vec::with_capacity(sampled_ranks.len());
        for rank in &sampled_ranks {
            let index = (*rank - 1) as usize;
            let effect_leverage = finite_value(horizontal_coordinates[index], "effect leverage")?;
            let adjusted_response = finite_value(
                response_mean + geometry.constrained_residuals[index],
                "adjusted response",
            )?;
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
                plot_center,
                response_mean,
                slope,
                horizontal_energy,
                effect_test.degrees_of_freedom,
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

fn leverage_geometry(
    reporting_design: &DMatrix<f64>,
    response: &DVector<f64>,
    effect_columns: &[usize],
    term_id: &str,
) -> Result<LeverageGeometry, FitModelEngineError> {
    let full_residuals = residualize_against(reporting_design, response)?;
    let constrained_design = matrix_without_columns(reporting_design, effect_columns);
    let constrained_residuals = residualize_against(&constrained_design, response)?;
    let contribution = &constrained_residuals - &full_residuals;
    let hypothesis_sum_of_squares = contribution.dot(&contribution);
    if full_residuals
        .iter()
        .chain(constrained_residuals.iter())
        .chain(contribution.iter())
        .any(|value| !value.is_finite())
        || !hypothesis_sum_of_squares.is_finite()
    {
        return Err(FitModelEngineError::NumericalFailure(format!(
            "effect {term_id} produced non-finite leverage geometry"
        )));
    }
    let full_sse = full_residuals.dot(&full_residuals);
    let constrained_sse = constrained_residuals.dot(&constrained_residuals);
    let tolerance = ROUNDING_CLAMP_FACTOR
        * response
            .dot(response)
            .abs()
            .max(full_sse.abs())
            .max(constrained_sse.abs())
            .max(1.0);
    clamp_roundoff_negative(
        constrained_sse - full_sse,
        tolerance,
        "leverage hypothesis SS",
    )?;

    Ok(LeverageGeometry {
        contribution,
        constrained_residuals,
        full_residuals,
        hypothesis_sum_of_squares,
    })
}

fn non_estimable_leverage_plot(
    term: &FitModelResolvedTerm,
    effect_test: &FitModelEffectTest,
    response_mean: f64,
    source_row_count: usize,
) -> FitModelLeveragePlot {
    FitModelLeveragePlot {
        term_id: term.term_id.clone(),
        term_label: term.label.clone(),
        p_value: effect_test.p_value.filter(|value| value.is_finite()),
        points: Vec::new(),
        confidence_band: Vec::new(),
        null_line_y: Some(response_mean),
        rows_sampled: false,
        source_row_count: source_row_count as u64,
        reason: Some(FitModelInferenceReason::InferenceNotEstimable),
    }
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
    plot_center: f64,
    response_mean: f64,
    slope: f64,
    horizontal_energy: f64,
    effect_degrees_of_freedom: u64,
    mse: f64,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
    source_row_count: usize,
) -> Result<Vec<FitModelLeverageBandPoint>, FitModelEngineError> {
    let effect_leverages = if horizontal_energy == 0.0 {
        vec![plot_center]
    } else {
        points
            .iter()
            .map(|point| point.effect_leverage)
            .collect::<Vec<_>>()
    };
    let geometry = confidence_geometry(
        effect_leverages,
        plot_center,
        response_mean,
        slope,
        horizontal_energy,
        effect_degrees_of_freedom,
        mse,
        error_degrees_of_freedom,
        confidence_level,
        source_row_count,
    )?;
    Ok(geometry
        .into_iter()
        .map(
            |(effect_leverage, fitted, lower, upper)| FitModelLeverageBandPoint {
                effect_leverage,
                fitted,
                lower,
                upper,
            },
        )
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn confidence_geometry(
    mut horizontal_coordinates: Vec<f64>,
    plot_center: f64,
    response_mean: f64,
    slope: f64,
    horizontal_energy: f64,
    hypothesis_degrees_of_freedom: u64,
    mse: f64,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
    source_row_count: usize,
) -> Result<Vec<(f64, f64, f64, f64)>, FitModelEngineError> {
    let distribution = FisherSnedecor::new(
        hypothesis_degrees_of_freedom as f64,
        error_degrees_of_freedom as f64,
    )
    .map_err(|_| {
        FitModelEngineError::NumericalFailure(
            "failed to construct leverage confidence distribution".to_string(),
        )
    })?;
    let f_critical = distribution.inverse_cdf(confidence_level);
    if !f_critical.is_finite() {
        return Err(FitModelEngineError::NumericalFailure(
            "leverage confidence critical value is non-finite".to_string(),
        ));
    }

    horizontal_coordinates.sort_by(f64::total_cmp);
    horizontal_coordinates
        .into_iter()
        .map(|horizontal_coordinate| {
            let centered = horizontal_coordinate - plot_center;
            let fitted = if slope == 1.0 && response_mean == plot_center {
                horizontal_coordinate
            } else {
                finite_value(response_mean + slope * centered, "leverage fitted value")?
            };
            let leverage_term = if horizontal_energy == 0.0 {
                0.0
            } else {
                centered * centered / horizontal_energy
            };
            let margin = finite_value(
                (hypothesis_degrees_of_freedom as f64
                    * f_critical
                    * mse
                    * (1.0 / source_row_count as f64 + leverage_term))
                    .sqrt(),
                "leverage confidence margin",
            )?;
            Ok((
                horizontal_coordinate,
                fitted,
                finite_value(fitted - margin, "leverage confidence lower bound")?,
                finite_value(fitted + margin, "leverage confidence upper bound")?,
            ))
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
    use std::collections::BTreeMap;

    use nalgebra::{DMatrix, DVector};
    use statrs::distribution::{ContinuousCDF, FisherSnedecor, StudentsT};

    use crate::engine::fit_model::reporting_basis::reporting_basis_test_fixture;
    use crate::models::fit_model::{
        FitModelEffectTest, FitModelInferenceReason, FitModelResolvedTerm, FitModelTermKind,
    };

    use super::{
        compute_effect_leverage_plots, compute_effect_tests, compute_whole_model_confidence_band,
        directed_effect_df, rank_from_singular_values, rank_tolerance, vector_mean,
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

    #[test]
    fn whole_model_zero_sum_of_squares_returns_only_the_center() {
        let fitted = DVector::from_vec(vec![1.0, 2.0, 3.0]);
        let band = compute_whole_model_confidence_band(&fitted, 2.0, 0.0, 2, Some(4.0), 10, 0.95)
            .expect("zero model sum of squares should remain estimable");

        assert_eq!(band.len(), 1);
        let point = &band[0];
        assert_eq!(point.predicted, 2.0);
        assert_eq!(point.fitted, 2.0);
        let f_critical = FisherSnedecor::new(2.0, 10.0)
            .expect("valid F distribution")
            .inverse_cdf(0.95);
        let expected_margin = (2.0 * f_critical * 4.0 / 3.0).sqrt();
        assert_close(point.lower, 2.0 - expected_margin);
        assert_close(point.upper, 2.0 + expected_margin);
    }

    #[test]
    fn whole_model_non_estimable_inference_returns_no_band() {
        let fitted = DVector::from_vec(vec![1.0, 2.0, 3.0]);
        let band = compute_whole_model_confidence_band(&fitted, 2.0, 2.0, 1, None, 10, 0.95)
            .expect("unavailable inference should not fail geometry");

        assert!(band.is_empty());
    }

    #[allow(clippy::too_many_arguments)]
    fn compute_test_leverage_plots(
        design: &DMatrix<f64>,
        response: &DVector<f64>,
        row_indexes: &[u64],
        terms: &[FitModelResolvedTerm],
        effect_tests: &[FitModelEffectTest],
        mse: Option<f64>,
        error_degrees_of_freedom: u64,
        confidence_level: f64,
    ) -> Result<Vec<crate::models::fit_model::FitModelLeveragePlot>, super::FitModelEngineError>
    {
        let svd = design.clone().svd(true, true);
        let tolerance = rank_tolerance(
            svd.singular_values.as_slice(),
            design.nrows(),
            design.ncols(),
        );
        let coefficients = svd
            .solve(response, tolerance)
            .map_err(|_| super::FitModelEngineError::SolveFailure)?;
        let reporting = reporting_basis_test_fixture(
            coefficients,
            DMatrix::identity(design.ncols(), design.ncols()),
            std::iter::once("Intercept".to_string())
                .chain(terms.iter().map(|term| term.label.clone()))
                .collect(),
            false,
        );
        let predictor_means = terms
            .iter()
            .enumerate()
            .filter(|(_, term)| term.kind == FitModelTermKind::Main && term.column_names.len() == 1)
            .map(|(index, term)| {
                (
                    term.column_names[0].clone(),
                    design.column(index + 1).iter().sum::<f64>() / design.nrows() as f64,
                )
            })
            .collect::<BTreeMap<_, _>>();
        compute_effect_leverage_plots(
            design,
            response,
            row_indexes,
            terms,
            &reporting,
            effect_tests,
            &predictor_means,
            mse,
            error_degrees_of_freedom,
            confidence_level,
        )
    }

    #[test]
    fn centered_effect_test_uses_reporting_hypothesis_geometry() {
        let (design, response, terms) = fixture();
        let reporting = reporting_basis_test_fixture(
            DVector::from_vec(vec![0.0, 2.0, 3.0, 4.0]),
            DMatrix::from_diagonal(&DVector::from_vec(vec![1.0, 0.25, 0.5, 0.75])),
            vec![
                "Intercept".to_string(),
                "(A-0)".to_string(),
                "(B-0)".to_string(),
                "(A-0)*(B-0)".to_string(),
            ],
            true,
        );

        let tests = compute_effect_tests(
            &design,
            &response,
            &terms,
            Some(&reporting),
            8.0,
            Some(2.0),
            4,
        )
        .expect("centered effect tests");
        let test = tests
            .iter()
            .find(|test| test.term_id == "A")
            .expect("A effect");

        assert_close(
            test.sum_of_squares.expect("sum of squares"),
            2.0 * 2.0 / 0.25,
        );
        assert_close(test.f_ratio.expect("F ratio"), 16.0 / 2.0);
        let expected = FisherSnedecor::new(1.0, 4.0)
            .expect("F distribution")
            .sf(8.0);
        assert_close(test.p_value.expect("p-value"), expected);
    }

    #[test]
    fn non_hierarchical_reporting_basis_retains_reduced_model_effect_tests() {
        let (design, response, terms) = fixture();
        let reporting = reporting_basis_test_fixture(
            DVector::from_vec(vec![0.0, 2.0, 3.0, 4.0]),
            DMatrix::identity(4, 4),
            vec![
                "Intercept".to_string(),
                "A".to_string(),
                "B".to_string(),
                "A*B".to_string(),
            ],
            false,
        );

        let expected = compute_effect_tests(&design, &response, &terms, None, 8.0, Some(2.0), 4)
            .expect("raw effect tests");
        let actual = compute_effect_tests(
            &design,
            &response,
            &terms,
            Some(&reporting),
            8.0,
            Some(2.0),
            4,
        )
        .expect("fallback effect tests");

        assert_eq!(
            serde_json::to_vec(&actual).expect("serialize actual"),
            serde_json::to_vec(&expected).expect("serialize expected")
        );
    }

    #[test]
    fn singular_centered_hypothesis_geometry_is_not_estimable() {
        let (design, response, mut terms) = fixture();
        terms[1].term_id = terms[0].term_id.clone();
        let reporting = reporting_basis_test_fixture(
            DVector::from_vec(vec![0.0, 2.0, 3.0, 4.0]),
            DMatrix::from_row_slice(
                4,
                4,
                &[
                    1.0, 0.0, 0.0, 0.0, //
                    0.0, 1.0, 1.0, 0.0, //
                    0.0, 1.0, 1.0, 0.0, //
                    0.0, 0.0, 0.0, 1.0,
                ],
            ),
            vec![
                "Intercept".to_string(),
                "(A-0)".to_string(),
                "(B-0)".to_string(),
                "(A-0)*(B-0)".to_string(),
            ],
            true,
        );

        let tests = compute_effect_tests(
            &design,
            &response,
            &terms,
            Some(&reporting),
            8.0,
            Some(2.0),
            4,
        )
        .expect("centered effect tests");
        let test = &tests[0];

        assert_eq!(test.number_of_parameters, 2);
        assert_eq!(test.degrees_of_freedom, 1);
        assert_eq!(test.sum_of_squares, None);
        assert_eq!(test.f_ratio, None);
        assert_eq!(test.p_value, None);
        assert_eq!(
            test.reason,
            Some(FitModelInferenceReason::InferenceNotEstimable)
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
        let mut effect_tests =
            compute_effect_tests(&design, &response, &terms, None, 8.0, Some(2.0), 4)
                .expect("effect tests should compute");
        effect_tests.reverse();
        let row_indexes = vec![101, 103, 107, 109, 113, 127, 131, 137];

        let plots = compute_test_leverage_plots(
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
        let full_svd = design.clone().svd(true, true);
        let full_tolerance = rank_tolerance(
            full_svd.singular_values.as_slice(),
            design.nrows(),
            design.ncols(),
        );
        let full_coefficients = full_svd
            .solve(&response, full_tolerance)
            .expect("full-model coefficients should solve");

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
        let non_center_band = plot
            .confidence_band
            .iter()
            .find(|band| (band.effect_leverage - effect_mean).abs() > TOLERANCE)
            .expect("band should include a non-center coordinate");
        let recovered_slope = (non_center_band.fitted - response_mean)
            / (non_center_band.effect_leverage - effect_mean);
        assert_close(recovered_slope, full_coefficients[1]);
        let critical = StudentsT::new(0.0, 1.0, 4.0)
            .expect("t distribution")
            .inverse_cdf(0.975);
        let centered = non_center_band.effect_leverage - effect_mean;
        let expected_margin = critical
            * (2.0 * (1.0 / 8.0 + centered * centered / residualized_x.dot(&residualized_x)))
                .sqrt();
        assert_close(
            (non_center_band.upper - non_center_band.lower) / 2.0,
            expected_margin,
        );
        let expected_p_value = effect_tests
            .iter()
            .find(|test| test.term_id == "A")
            .expect("matching A effect test")
            .p_value;
        assert_eq!(plot.p_value, expected_p_value);
        assert_close(plot.null_line_y.expect("null line"), response_mean);
        assert!(!plot.rows_sampled);
        assert_eq!(plot.source_row_count, 8);
        assert_eq!(plot.reason, None);
    }

    fn aliased_leverage_fixture(
        perturbation: f64,
    ) -> (
        DMatrix<f64>,
        DVector<f64>,
        Vec<FitModelResolvedTerm>,
        Vec<FitModelEffectTest>,
    ) {
        let nuisance = [
            1_000_000.0,
            2_000_000.0,
            3_000_000.0,
            4_000_000.0,
            5_000_000.0,
            6_000_000.0,
        ];
        let design = DMatrix::from_fn(6, 3, |row, column| match column {
            0 => 1.0,
            1 => {
                nuisance[row]
                    + if row % 2 == 0 {
                        perturbation
                    } else {
                        -perturbation
                    }
            }
            _ => nuisance[row],
        });
        let response = DVector::from_iterator(
            6,
            nuisance
                .iter()
                .enumerate()
                .map(|(row, value)| 2.0 + 3.0 * value + row as f64 / 10.0),
        );
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term("B", "B", FitModelTermKind::Main, &["B"]),
        ];
        let effect_tests = terms
            .iter()
            .map(|term| FitModelEffectTest {
                term_id: term.term_id.clone(),
                term_label: term.label.clone(),
                number_of_parameters: 1,
                degrees_of_freedom: 0,
                sum_of_squares: Some(0.0),
                f_ratio: None,
                p_value: None,
                reason: Some(FitModelInferenceReason::InferenceNotEstimable),
            })
            .collect();
        (design, response, terms, effect_tests)
    }

    fn assert_aliased_effect_is_non_estimable(perturbation: f64) {
        let (design, response, terms, effect_tests) = aliased_leverage_fixture(perturbation);
        if perturbation > 0.0 {
            assert!(
                (0..design.nrows()).any(|row| design[(row, 1)] != design[(row, 2)]),
                "near-alias fixture must retain a nonzero perturbation"
            );
        }
        let plots = compute_test_leverage_plots(
            &design,
            &response,
            &[1, 2, 3, 4, 5, 6],
            &terms,
            &effect_tests,
            Some(1.0),
            3,
            0.95,
        )
        .expect("alias should produce explicit payloads rather than fail the fit");
        let plot = plots
            .iter()
            .find(|plot| plot.term_id == "A")
            .expect("A payload");

        assert!(plot.points.is_empty());
        assert!(plot.confidence_band.is_empty());
        assert_eq!(plot.null_line_y, Some(response.iter().sum::<f64>() / 6.0));
        assert_eq!(
            plot.reason,
            Some(FitModelInferenceReason::InferenceNotEstimable)
        );
    }

    #[test]
    fn leverage_marks_exact_alias_non_estimable_without_failing_fit() {
        assert_aliased_effect_is_non_estimable(0.0);
    }

    #[test]
    fn leverage_marks_below_rank_tolerance_near_alias_non_estimable() {
        assert_aliased_effect_is_non_estimable(1e-10);
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

        let first = compute_test_leverage_plots(
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
        let second = compute_test_leverage_plots(
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
        let effect_tests = compute_effect_tests(&design, &response, &terms, None, 8.0, None, 0)
            .expect("effect geometry should compute");
        let row_indexes = (1..=8).collect::<Vec<_>>();

        let plots = compute_test_leverage_plots(
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
    fn leverage_scales_multi_column_effect_in_response_units() {
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
        let effect_tests =
            compute_effect_tests(&design, &response, &terms, None, 0.0, Some(1.0), 2)
                .expect("effect tests should compute");

        let plots = compute_test_leverage_plots(
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

        assert!(!grouped.points.is_empty());
        let first = grouped.confidence_band.first().expect("band start");
        let second = grouped
            .confidence_band
            .iter()
            .find(|point| (point.effect_leverage - first.effect_leverage).abs() > TOLERANCE)
            .expect("distinct band coordinate");
        assert_close(
            (second.fitted - first.fitted) / (second.effect_leverage - first.effect_leverage),
            1.0,
        );
        assert_eq!(grouped.p_value, effect_tests[0].p_value);
        assert_eq!(grouped.reason, None);
    }

    #[test]
    fn leverage_non_hierarchical_interaction_uses_raw_test_and_residual_geometry() {
        let design = DMatrix::from_row_slice(
            8,
            3,
            &[
                1.0, -1.0, -1.0, //
                1.0, -1.0, -1.0, //
                1.0, -1.0, 1.0, //
                1.0, -1.0, 1.0, //
                1.0, 1.0, -1.0, //
                1.0, 1.0, -1.0, //
                1.0, 1.0, 1.0, //
                1.0, 1.0, 1.0, //
            ],
        );
        let residual_pattern = [-1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0];
        let response = DVector::from_iterator(
            8,
            (0..8).map(|row| {
                1.0 + 2.0 * design[(row, 1)] + 3.0 * design[(row, 2)] + residual_pattern[row]
            }),
        );
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term(
                "interaction:A*B",
                "A*B",
                FitModelTermKind::Interaction,
                &["A", "B"],
            ),
        ];
        let full_residuals = explicit_residualize(&design, &response);
        let full_sse = full_residuals.dot(&full_residuals);
        let effect_tests =
            compute_effect_tests(&design, &response, &terms, None, full_sse, Some(1.6), 5)
                .expect("raw effect tests");
        let plots = compute_test_leverage_plots(
            &design,
            &response,
            &(1..=8).collect::<Vec<_>>(),
            &terms,
            &effect_tests,
            Some(1.6),
            5,
            0.95,
        )
        .expect("non-hierarchical leverage");
        let plot = plots
            .iter()
            .find(|plot| plot.term_id == "interaction:A*B")
            .expect("interaction plot");
        let effect_test = effect_tests
            .iter()
            .find(|test| test.term_id == "interaction:A*B")
            .expect("interaction test");
        let constrained_design = DMatrix::from_fn(8, 2, |row, column| design[(row, column)]);
        let constrained_residuals = explicit_residualize(&constrained_design, &response);
        let response_mean = vector_mean(&response).expect("response mean");

        assert_eq!(plot.p_value, effect_test.p_value);
        for (row, point) in plot.points.iter().enumerate() {
            assert_close(
                point.adjusted_response - point.effect_leverage,
                full_residuals[row],
            );
            assert_close(
                point.adjusted_response - response_mean,
                constrained_residuals[row],
            );
        }
        assert_close(
            constrained_residuals.dot(&constrained_residuals) - full_sse,
            effect_test.sum_of_squares.expect("interaction SS"),
        );
        let first = plot.confidence_band.first().expect("band start");
        let second = plot
            .confidence_band
            .iter()
            .find(|point| (point.effect_leverage - first.effect_leverage).abs() > TOLERANCE)
            .expect("distinct interaction coordinate");
        assert_close(
            (second.fitted - first.fitted) / (second.effect_leverage - first.effect_leverage),
            1.0,
        );
    }

    #[test]
    fn leverage_zero_sum_of_squares_complex_effect_keeps_center_confidence_point() {
        let design = DMatrix::from_row_slice(
            8,
            3,
            &[
                1.0, -1.0, -1.0, //
                1.0, -1.0, -1.0, //
                1.0, -1.0, 1.0, //
                1.0, -1.0, 1.0, //
                1.0, 1.0, -1.0, //
                1.0, 1.0, -1.0, //
                1.0, 1.0, 1.0, //
                1.0, 1.0, 1.0, //
            ],
        );
        let response = DVector::from_vec(vec![-2.0, 0.0, -2.0, 0.0, 2.0, 4.0, 2.0, 4.0]);
        let terms = vec![
            term("A", "A", FitModelTermKind::Main, &["A"]),
            term(
                "interaction:A*B",
                "A*B",
                FitModelTermKind::Interaction,
                &["A", "B"],
            ),
        ];
        let effect_tests = vec![
            FitModelEffectTest {
                term_id: "A".to_string(),
                term_label: "A".to_string(),
                number_of_parameters: 1,
                degrees_of_freedom: 1,
                sum_of_squares: Some(32.0),
                f_ratio: Some(20.0),
                p_value: Some(0.01),
                reason: None,
            },
            FitModelEffectTest {
                term_id: "interaction:A*B".to_string(),
                term_label: "A*B".to_string(),
                number_of_parameters: 1,
                degrees_of_freedom: 1,
                sum_of_squares: Some(0.0),
                f_ratio: Some(0.0),
                p_value: Some(1.0),
                reason: None,
            },
        ];
        let plots = compute_test_leverage_plots(
            &design,
            &response,
            &(1..=8).collect::<Vec<_>>(),
            &terms,
            &effect_tests,
            Some(1.6),
            5,
            0.95,
        )
        .expect("zero-SS leverage");
        let plot = plots
            .iter()
            .find(|plot| plot.term_id == "interaction:A*B")
            .expect("interaction plot");
        let band = plot.confidence_band.first().expect("center band point");
        let center = vector_mean(&response).expect("response mean");
        let f_critical = FisherSnedecor::new(1.0, 5.0)
            .expect("F distribution")
            .inverse_cdf(0.95);
        let expected_margin = (f_critical * 1.6 / 8.0).sqrt();

        assert_eq!(plot.reason, None);
        assert_eq!(plot.p_value, Some(1.0));
        assert_eq!(plot.confidence_band.len(), 1);
        assert_close(band.effect_leverage, center);
        assert_close(band.fitted, center);
        assert_close(band.upper - band.fitted, expected_margin);
        assert_close(band.fitted - band.lower, expected_margin);
    }

    #[test]
    fn type_three_effect_tests_match_reduced_model_sse() {
        let (design, response, terms) = fixture();
        let full_sse = 8.0;
        let tests = compute_effect_tests(&design, &response, &terms, None, full_sse, Some(2.0), 4)
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
        let original = compute_effect_tests(&design, &response, &terms, None, 8.0, Some(2.0), 4)
            .expect("original effect tests should compute");
        let reordered = compute_effect_tests(
            &reordered_design,
            &response,
            &reordered_terms,
            None,
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
        let tests = compute_effect_tests(&design, &response, &terms, None, 8.0, None, 0)
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

        let tests = compute_effect_tests(&design, &response, &terms, None, full_sse, Some(1.0), 3)
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

        let tests = compute_effect_tests(&design, &response, &terms, None, 0.0, Some(1.0), 2)
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

        let tests = compute_effect_tests(&design, &response, &terms, None, 1e-14, Some(1.0), 2)
            .expect("roundoff-sized negative partial SS should clamp");

        assert_eq!(tests[0].sum_of_squares, Some(0.0));
        assert_eq!(tests[0].f_ratio, Some(0.0));
        assert_eq!(tests[0].p_value, Some(1.0));
    }
}
