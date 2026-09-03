use nalgebra::linalg::SVD;
use nalgebra::{DMatrix, DVector, Dyn};
use statrs::distribution::{ContinuousCDF, FisherSnedecor, StudentsT};

use crate::engine::fit_model::ModelMatrixSpec;
use crate::models::fit_model::{
    FitModelAnovaRow, FitModelCentering, FitModelNotComputableReason, FitModelNotComputableResult,
    FitModelParameterEstimate, FitModelPlotRow, FitModelPredictorRange, FitModelResolvedTerm,
    FitModelResult, FitModelSnapshot, FitModelSummaryOfFit, FitModelWarningCode,
};

const CONDITION_WARNING_THRESHOLD: f64 = 1e10;
const PERFECT_FIT_RELATIVE_TOLERANCE: f64 = 1e-12;
const ROUNDING_CLAMP_FACTOR: f64 = 1e-12;
const MIN_P_VALUE: f64 = 1e-300;
const GRAPH_SCATTER_RENDER_BUDGET: usize = crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET;

#[derive(Debug, Clone, PartialEq)]
pub enum FitModelEngineError {
    InvalidInput(String),
    NumericalFailure(String),
    SolveFailure,
    InvalidConfidenceLevel(f64),
}

#[derive(Debug, Clone)]
pub struct FitModelData {
    pub response_column: String,
    pub predictor_columns: Vec<String>,
    pub predictor_ranges: Vec<FitModelPredictorRange>,
    pub model_matrix_spec: ModelMatrixSpec,
    pub design_matrix: DMatrix<f64>,
    pub response_values: Vec<f64>,
    pub row_indexes: Vec<u64>,
    pub excluded_rows: u64,
}

#[derive(Debug, Clone)]
struct FitGeometry {
    rank_tolerance: f64,
    rank: usize,
    sigma_max: f64,
    sigma_min: f64,
    singular_values: DVector<f64>,
    v_t: DMatrix<f64>,
}

impl FitGeometry {
    fn condition_number(&self) -> f64 {
        if self.sigma_min > 0.0 {
            self.sigma_max / self.sigma_min
        } else {
            f64::INFINITY
        }
    }
}

fn fit_geometry_from_svd(
    svd: &SVD<f64, Dyn, Dyn>,
    n: usize,
    p: usize,
) -> Result<FitGeometry, FitModelEngineError> {
    let singular_values = svd.singular_values.clone();
    let sigma_max = singular_values.iter().copied().fold(0.0_f64, f64::max);
    let sigma_min = singular_values
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    let rank_tolerance = (n.max(p) as f64) * f64::EPSILON * sigma_max;
    let rank = singular_values
        .iter()
        .filter(|value| **value > rank_tolerance)
        .count();
    let v_t = svd.v_t.clone().ok_or_else(|| {
        FitModelEngineError::NumericalFailure(
            "SVD did not provide V^T for fit geometry".to_string(),
        )
    })?;

    Ok(FitGeometry {
        rank_tolerance,
        rank,
        sigma_max,
        sigma_min,
        singular_values,
        v_t,
    })
}

pub fn fit_linear_model(
    input: FitModelData,
    confidence_level: f64,
) -> Result<FitModelResult, FitModelEngineError> {
    if !(0.0..1.0).contains(&confidence_level) {
        return Err(FitModelEngineError::InvalidConfidenceLevel(
            confidence_level,
        ));
    }

    let n = input.response_values.len();
    let p = input.design_matrix.ncols();
    if n == 0 || p == 0 {
        return Err(FitModelEngineError::InvalidInput(
            "design matrix and response must be non-empty".to_string(),
        ));
    }
    if input.design_matrix.nrows() != n {
        return Err(FitModelEngineError::InvalidInput(
            "design matrix row count must match response length".to_string(),
        ));
    }
    if input.row_indexes.len() != n {
        return Err(FitModelEngineError::InvalidInput(
            "row index count must match response length".to_string(),
        ));
    }

    if n < p {
        return Ok(not_computable(
            FitModelNotComputableReason::InsufficientRows,
            n as u64,
            input.excluded_rows,
        ));
    }

    let svd = input.design_matrix.clone().svd(true, true);
    let geometry = fit_geometry_from_svd(&svd, n, p)?;
    if geometry.rank < p {
        return Ok(not_computable(
            FitModelNotComputableReason::RankDeficient,
            n as u64,
            input.excluded_rows,
        ));
    }

    let response = DVector::from_vec(input.response_values.clone());
    let coefficients = solve_coefficients(&response, &svd, geometry.rank_tolerance)?;
    if coefficients.iter().any(|value| !value.is_finite()) {
        return Err(FitModelEngineError::NumericalFailure(
            "coefficient solve produced non-finite value".to_string(),
        ));
    }

    let fitted = &input.design_matrix * &coefficients;
    let residuals = &response - &fitted;

    let mean_response = mean(&input.response_values)?;
    let sst = input
        .response_values
        .iter()
        .map(|value| square(*value - mean_response))
        .sum::<f64>();
    let sse_raw = residuals.iter().map(|value| square(*value)).sum::<f64>();
    let rounding_tolerance = ROUNDING_CLAMP_FACTOR * sst.abs().max(1.0);
    let response_energy = input
        .response_values
        .iter()
        .map(|value| square(*value))
        .sum::<f64>();
    let sse = normalize_sse_roundoff_to_zero(
        clamp_roundoff_negative(sse_raw, rounding_tolerance, "SSE")?,
        n,
        response_energy,
    );
    let ssm_raw = sst - sse;
    let ssm = clamp_roundoff_negative(ssm_raw, rounding_tolerance, "SSM")?;

    let df_model = p.saturating_sub(1);
    let df_error = n.saturating_sub(p);
    let df_total = n.saturating_sub(1);

    let condition_number = geometry.condition_number();

    let constant_response = sst == 0.0;
    let perfect_fit = sse == 0.0 || (sst > 0.0 && sse <= PERFECT_FIT_RELATIVE_TOLERANCE * sst);
    let saturated_model = df_error == 0;
    let ill_conditioned =
        condition_number.is_finite() && condition_number > CONDITION_WARNING_THRESHOLD;

    let mse = if df_error > 0 {
        Some(sse / (df_error as f64))
    } else {
        None
    };
    let rmse = if saturated_model {
        None
    } else if perfect_fit {
        Some(0.0)
    } else {
        finite_or_none(mse.map(f64::sqrt).unwrap_or(0.0))
    };

    let r_squared = if constant_response {
        None
    } else {
        finite_or_none(1.0 - sse / sst)
    };
    let adjusted_r_squared = if constant_response || df_error == 0 || df_total == 0 {
        None
    } else {
        finite_or_none(1.0 - (sse / df_error as f64) / (sst / df_total as f64))
    };

    let ms_model = if df_model > 0 {
        finite_or_none(ssm / df_model as f64)
    } else {
        None
    };
    let ms_error = if df_error > 0 {
        finite_or_none(sse / df_error as f64)
    } else {
        None
    };
    let f_ratio = if perfect_fit || constant_response || df_model == 0 {
        None
    } else {
        match (ms_model, ms_error) {
            (Some(model), Some(error)) if error > 0.0 => finite_or_none(model / error),
            _ => None,
        }
    };
    let model_p_value = match (f_ratio, df_model, df_error) {
        (Some(value), model_df, error_df) if model_df > 0 && error_df > 0 => {
            upper_tail_f(value, model_df as u64, error_df as u64)
        }
        _ => None,
    };

    let allow_parameter_inference = !saturated_model && !perfect_fit && df_error > 0;
    let parameter_estimates = parameter_estimates(
        &input,
        &coefficients,
        &geometry,
        mse,
        df_error as u64,
        confidence_level,
        allow_parameter_inference,
    )?;

    let mut plot_rows = Vec::with_capacity(n.min(GRAPH_SCATTER_RENDER_BUDGET));
    let sampled_ranks = deterministic_rank_grid(n as u64, GRAPH_SCATTER_RENDER_BUDGET);
    let sampled = sampled_ranks.len() < n;
    for rank in sampled_ranks {
        let index = (rank - 1) as usize;
        let observed = normalize_signed_zero(response[index]);
        let fitted_value = normalize_signed_zero(fitted[index]);
        let residual = normalize_signed_zero(residuals[index]);
        if !observed.is_finite() || !fitted_value.is_finite() || !residual.is_finite() {
            return Err(FitModelEngineError::NumericalFailure(
                "plot row contained non-finite value".to_string(),
            ));
        }
        plot_rows.push(FitModelPlotRow {
            row_index: input.row_indexes[index],
            observed,
            fitted: fitted_value,
            residual,
        });
    }

    let warnings = warnings(
        saturated_model,
        constant_response,
        perfect_fit,
        ill_conditioned,
    );
    let resolved = resolved_terms(&input.model_matrix_spec);
    let centering = FitModelCentering {
        method: input.model_matrix_spec.centering_method().clone(),
        centers: input.model_matrix_spec.centers().to_vec(),
    };
    let mut coefficient_term_ids = Vec::with_capacity(coefficients.len());
    coefficient_term_ids.push("Intercept".to_string());
    coefficient_term_ids.extend(resolved.iter().map(|term| term.term_id.clone()));
    let snapshot_covariance = if allow_parameter_inference {
        covariance_matrix(&geometry, mse)?
            .map(matrix_to_finite_rows)
            .transpose()?
    } else {
        None
    };
    let snapshot = FitModelSnapshot {
        coefficient_term_ids,
        coefficients: coefficients
            .iter()
            .map(|value| normalize_signed_zero(*value))
            .collect(),
        covariance: snapshot_covariance,
        mean_square_error: mse.filter(|value| value.is_finite() && *value > 0.0),
        error_degrees_of_freedom: df_error as u64,
        confidence_level,
        terms: resolved.clone(),
        centering: centering.clone(),
        predictor_ranges: input.predictor_ranges,
    };

    Ok(FitModelResult::Fitted(Box::new(
        crate::models::fit_model::FitModelFittedResult {
            used_rows: n as u64,
            excluded_rows: input.excluded_rows,
            confidence_level,
            response_column: input.response_column,
            predictor_columns: input.predictor_columns,
            terms: resolved,
            centering,
            snapshot,
            summary_of_fit: FitModelSummaryOfFit {
                r_squared,
                adjusted_r_squared,
                root_mean_square_error: rmse,
                mean_of_response: normalize_signed_zero(mean_response),
                observation_count: n as u64,
                model_degrees_of_freedom: df_model as u64,
                error_degrees_of_freedom: df_error as u64,
            },
            anova: vec![
                FitModelAnovaRow {
                    source: "Model".to_string(),
                    degrees_of_freedom: df_model as u64,
                    sum_of_squares: normalize_signed_zero(ssm),
                    mean_square: ms_model,
                    f_ratio,
                    p_value: model_p_value,
                },
                FitModelAnovaRow {
                    source: "Error".to_string(),
                    degrees_of_freedom: df_error as u64,
                    sum_of_squares: normalize_signed_zero(sse),
                    mean_square: ms_error,
                    f_ratio: None,
                    p_value: None,
                },
                FitModelAnovaRow {
                    source: "Total".to_string(),
                    degrees_of_freedom: df_total as u64,
                    sum_of_squares: normalize_signed_zero(sst),
                    mean_square: None,
                    f_ratio: None,
                    p_value: None,
                },
            ],
            parameter_estimates,
            plot_rows,
            plot_rows_sampled: sampled,
            warnings,
        },
    )))
}

fn matrix_to_finite_rows(matrix: DMatrix<f64>) -> Result<Vec<Vec<f64>>, FitModelEngineError> {
    if matrix.nrows() != matrix.ncols() || matrix.iter().any(|value| !value.is_finite()) {
        return Err(FitModelEngineError::NumericalFailure(
            "coefficient covariance matrix is invalid".to_string(),
        ));
    }
    Ok((0..matrix.nrows())
        .map(|row| {
            (0..matrix.ncols())
                .map(|column| matrix[(row, column)])
                .collect()
        })
        .collect())
}

fn parameter_estimates(
    input: &FitModelData,
    coefficients: &DVector<f64>,
    geometry: &FitGeometry,
    mse: Option<f64>,
    df_error: u64,
    confidence_level: f64,
    allow_inference: bool,
) -> Result<Vec<FitModelParameterEstimate>, FitModelEngineError> {
    let mut estimates = Vec::with_capacity(coefficients.len());
    let mut term_ids = Vec::with_capacity(coefficients.len());
    let mut labels = Vec::with_capacity(coefficients.len());

    term_ids.push("Intercept".to_string());
    labels.push("Intercept".to_string());
    for term in input.model_matrix_spec.terms() {
        term_ids.push(term.term_id().to_string());
        labels.push(term.label().to_string());
    }

    let covariance = if allow_inference {
        covariance_matrix(geometry, mse)?
    } else {
        None
    };
    let t_critical = if allow_inference {
        t_critical(df_error, confidence_level)
    } else {
        None
    };

    for index in 0..coefficients.len() {
        let estimate = normalize_signed_zero(coefficients[index]);
        let (standard_error, t_ratio, p_value, lower_confidence_limit, upper_confidence_limit) =
            if let (Some(cov), Some(critical), Some(mse_value)) =
                (covariance.as_ref(), t_critical, mse)
            {
                if !mse_value.is_finite() || mse_value < 0.0 {
                    return Err(FitModelEngineError::NumericalFailure(
                        "MSE for inference is invalid".to_string(),
                    ));
                }
                let variance = cov[(index, index)];
                if variance < 0.0 {
                    return Err(FitModelEngineError::NumericalFailure(
                        "variance estimate became negative".to_string(),
                    ));
                }
                let se_value = normalize_signed_zero(variance.sqrt());
                let se = finite_or_none(se_value);
                let t_value = match se {
                    Some(value) if value > 0.0 => finite_or_none(estimate / value),
                    _ => None,
                };
                let p = match t_value {
                    Some(value) => two_sided_t_p_value(value, df_error),
                    None => None,
                };
                let (lower, upper) = match se {
                    Some(value) => {
                        let margin = critical * value;
                        (
                            finite_or_none(normalize_signed_zero(estimate - margin)),
                            finite_or_none(normalize_signed_zero(estimate + margin)),
                        )
                    }
                    None => (None, None),
                };
                (se, t_value, p, lower, upper)
            } else {
                (None, None, None, None, None)
            };

        estimates.push(FitModelParameterEstimate {
            term_id: term_ids
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("term-{index}")),
            term_label: labels
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("term-{index}")),
            estimate,
            standard_error,
            t_ratio,
            p_value,
            lower_confidence_limit,
            upper_confidence_limit,
        });
    }

    Ok(estimates)
}

fn solve_coefficients(
    response: &DVector<f64>,
    svd: &SVD<f64, Dyn, Dyn>,
    rank_tolerance: f64,
) -> Result<DVector<f64>, FitModelEngineError> {
    let u = svd.u.as_ref().ok_or(FitModelEngineError::SolveFailure)?;
    let v_t = svd.v_t.as_ref().ok_or(FitModelEngineError::SolveFailure)?;

    if svd.singular_values.len() != v_t.nrows() || u.ncols() != svd.singular_values.len() {
        return Err(FitModelEngineError::SolveFailure);
    }

    let mut scaled = DVector::zeros(svd.singular_values.len());
    for index in 0..svd.singular_values.len() {
        let sigma = svd.singular_values[index];
        if sigma <= rank_tolerance {
            return Err(FitModelEngineError::SolveFailure);
        }
        let projection = u.column(index).dot(response);
        scaled[index] = projection / sigma;
    }

    Ok(v_t.transpose() * scaled)
}

fn covariance_matrix(
    geometry: &FitGeometry,
    mse: Option<f64>,
) -> Result<Option<DMatrix<f64>>, FitModelEngineError> {
    let mse_value = match mse {
        Some(value) if value.is_finite() && value >= 0.0 => value,
        _ => return Ok(None),
    };

    if geometry.singular_values.len() != geometry.v_t.nrows() {
        return Err(FitModelEngineError::NumericalFailure(
            "SVD singular value count does not match design columns".to_string(),
        ));
    }

    let p = geometry.singular_values.len();
    let mut inverse_diag = DMatrix::zeros(p, p);
    for (index, sigma) in geometry.singular_values.iter().copied().enumerate() {
        if sigma <= geometry.rank_tolerance {
            return Err(FitModelEngineError::NumericalFailure(
                "singular value fell below rank tolerance in covariance".to_string(),
            ));
        }
        inverse_diag[(index, index)] = 1.0 / square(sigma);
    }

    let v = geometry.v_t.transpose();
    let xtx_inverse = &v * inverse_diag * &geometry.v_t;

    let covariance = xtx_inverse * mse_value;
    if covariance.iter().any(|value| !value.is_finite()) {
        return Err(FitModelEngineError::NumericalFailure(
            "covariance matrix contains non-finite value".to_string(),
        ));
    }

    Ok(Some(covariance))
}

fn resolved_terms(spec: &ModelMatrixSpec) -> Vec<FitModelResolvedTerm> {
    spec.terms()
        .iter()
        .map(|term| FitModelResolvedTerm {
            term_id: term.term_id().to_string(),
            kind: term.kind().clone(),
            column_names: term.column_names().to_vec(),
            label: term.label().to_string(),
        })
        .collect()
}

fn warnings(
    saturated_model: bool,
    constant_response: bool,
    perfect_fit: bool,
    ill_conditioned: bool,
) -> Vec<FitModelWarningCode> {
    let mut values = Vec::new();
    if saturated_model {
        values.push(FitModelWarningCode::SaturatedModel);
    }
    if constant_response {
        values.push(FitModelWarningCode::ConstantResponse);
    }
    if perfect_fit {
        values.push(FitModelWarningCode::PerfectFit);
    }
    if ill_conditioned {
        values.push(FitModelWarningCode::IllConditioned);
    }
    values
}

fn deterministic_rank_grid(logical_n: u64, max_points: usize) -> Vec<u64> {
    if logical_n == 0 {
        return Vec::new();
    }
    let logical_n_usize = usize::try_from(logical_n).unwrap_or(usize::MAX);
    if logical_n_usize <= max_points {
        return (1..=logical_n).collect();
    }

    let mut ranks = std::collections::BTreeSet::new();
    let center = logical_n.div_ceil(2);
    ranks.insert(1_u64);
    ranks.insert(center);
    ranks.insert(logical_n);

    let denominator = max_points.saturating_sub(1) as f64;
    for index in 0..max_points {
        let fraction = if denominator == 0.0 {
            0.0
        } else {
            index as f64 / denominator
        };
        let rank = 1_u64 + ((logical_n - 1) as f64 * fraction).round() as u64;
        ranks.insert(rank.clamp(1, logical_n));
    }

    let sorted = ranks.into_iter().collect::<Vec<_>>();
    if sorted.len() > max_points {
        let mut selected = Vec::with_capacity(max_points);
        for index in 0..max_points {
            let pick = if max_points == 1 {
                0
            } else {
                ((index as f64) * (sorted.len().saturating_sub(1) as f64)
                    / ((max_points - 1) as f64))
                    .round() as usize
            };
            if let Some(rank) = sorted.get(pick) {
                selected.push(*rank);
            }
        }
        selected.sort_unstable();
        selected.dedup();
        while selected.len() < max_points {
            if let Some(last) = selected.last().copied() {
                let candidate = last.saturating_sub(1).max(1);
                if !selected.contains(&candidate) {
                    selected.push(candidate);
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        selected.sort_unstable();
        selected.truncate(max_points);
        return selected;
    }

    sorted
}

fn not_computable(
    reason: FitModelNotComputableReason,
    used_rows: u64,
    excluded_rows: u64,
) -> FitModelResult {
    FitModelResult::NotComputable(FitModelNotComputableResult {
        reason,
        used_rows,
        excluded_rows,
    })
}

fn t_critical(df: u64, confidence_level: f64) -> Option<f64> {
    if df == 0 || !(0.0..1.0).contains(&confidence_level) {
        return None;
    }
    StudentsT::new(0.0, 1.0, df as f64)
        .ok()
        .map(|distribution| distribution.inverse_cdf(1.0 - (1.0 - confidence_level) / 2.0))
        .and_then(finite_or_none)
}

fn two_sided_t_p_value(t_ratio: f64, df: u64) -> Option<f64> {
    if df == 0 {
        return None;
    }
    StudentsT::new(0.0, 1.0, df as f64)
        .ok()
        .map(|distribution| 2.0 * distribution.sf(t_ratio.abs()))
        .and_then(clamp_probability)
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
    let clamped = value.clamp(0.0, 1.0).max(MIN_P_VALUE);
    finite_or_none(normalize_signed_zero(clamped))
}

fn finite_or_none(value: f64) -> Option<f64> {
    if value.is_finite() {
        Some(normalize_signed_zero(value))
    } else {
        None
    }
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

fn mean(values: &[f64]) -> Result<f64, FitModelEngineError> {
    if values.is_empty() {
        return Err(FitModelEngineError::InvalidInput(
            "cannot compute mean for empty response".to_string(),
        ));
    }
    let mut count = 0.0_f64;
    let mut current = 0.0_f64;
    for value in values {
        if !value.is_finite() {
            return Err(FitModelEngineError::InvalidInput(
                "response contains non-finite value".to_string(),
            ));
        }
        count += 1.0;
        current += (*value - current) / count;
    }
    Ok(normalize_signed_zero(current))
}

fn square(value: f64) -> f64 {
    value * value
}

fn normalize_signed_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn normalize_sse_roundoff_to_zero(value: f64, n: usize, response_energy: f64) -> f64 {
    let scale = if response_energy.is_finite() {
        response_energy.abs().max(f64::MIN_POSITIVE)
    } else {
        f64::MIN_POSITIVE
    };
    let epsilon_tolerance = (n.max(1) as f64) * f64::EPSILON * scale;
    if value >= 0.0 && value <= epsilon_tolerance {
        0.0
    } else {
        normalize_signed_zero(value)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nalgebra::DMatrix;
    use statrs::distribution::{ContinuousCDF, StudentsT};

    use crate::engine::fit_model::ols::{fit_linear_model, FitModelData};
    use crate::engine::fit_model::terms::resolve_terms;
    use crate::engine::fit_model::ModelMatrixSpec;
    use crate::models::fit_model::{
        FitModelCenteringMethod, FitModelNotComputableReason, FitModelPredictorRange,
        FitModelResult, FitModelTerm, FitModelTermKind, FitModelWarningCode,
    };

    const GRAPH_SCATTER_RENDER_BUDGET: usize = 8_000;

    fn assert_close(actual: f64, expected: f64) {
        let tolerance = 1e-12_f64.max(1e-9 * expected.abs());
        assert!(
            (actual - expected).abs() <= tolerance,
            "actual={actual}, expected={expected}, tolerance={tolerance}"
        );
    }

    fn term(kind: FitModelTermKind, columns: &[&str]) -> FitModelTerm {
        FitModelTerm {
            kind,
            column_names: columns.iter().map(|value| (*value).to_string()).collect(),
            exponent: None,
        }
    }

    fn build_input(
        response_column: &str,
        terms: Vec<FitModelTerm>,
        centering: FitModelCenteringMethod,
        columns: BTreeMap<String, Vec<f64>>,
        response: Vec<f64>,
        row_indexes: Vec<u64>,
        excluded_rows: u64,
    ) -> FitModelData {
        let predictor_ranges = columns
            .iter()
            .map(|(column_name, values)| FitModelPredictorRange {
                column_name: column_name.clone(),
                minimum: values.iter().copied().fold(f64::INFINITY, f64::min),
                maximum: values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                mean: values.iter().sum::<f64>() / values.len() as f64,
            })
            .collect();
        let resolved_terms = resolve_terms(&terms).expect("terms should resolve");
        let spec = ModelMatrixSpec::from_columns(resolved_terms, centering, &columns)
            .expect("spec should build");
        let matrix = spec
            .transform_training_columns(&columns)
            .expect("design matrix should build");

        FitModelData {
            response_column: response_column.to_string(),
            predictor_columns: columns.keys().cloned().collect(),
            predictor_ranges,
            model_matrix_spec: spec,
            design_matrix: matrix,
            response_values: response,
            row_indexes,
            excluded_rows,
        }
    }

    fn assert_parameter_row(
        result: &crate::models::fit_model::FitModelParameterEstimate,
        estimate: f64,
        se: f64,
        t_ratio: f64,
        df_error: u64,
        confidence_level: f64,
    ) {
        let distribution =
            StudentsT::new(0.0, 1.0, df_error as f64).expect("students-t should build");
        let p_value = (2.0 * distribution.sf(t_ratio.abs())).clamp(1e-300, 1.0);
        let t_critical = distribution.inverse_cdf(1.0 - (1.0 - confidence_level) / 2.0);
        let margin = t_critical * se;

        assert_close(result.estimate, estimate);
        assert_close(result.standard_error.expect("standard error"), se);
        assert_close(result.t_ratio.expect("t-ratio"), t_ratio);
        assert_close(result.p_value.expect("p-value"), p_value);
        assert_close(
            result
                .lower_confidence_limit
                .expect("lower confidence limit"),
            estimate - margin,
        );
        assert_close(
            result
                .upper_confidence_limit
                .expect("upper confidence limit"),
            estimate + margin,
        );
    }

    #[test]
    fn exact_line_fixture_matches_oracle() {
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let y = vec![3.0, 5.0, 7.0, 9.0, 11.0];
        let input = build_input(
            "Y",
            vec![term(FitModelTermKind::Main, &["X"])],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X"), x)]),
            y,
            vec![1, 2, 3, 4, 5],
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_eq!(fitted.parameter_estimates.len(), 2);
        assert_close(fitted.parameter_estimates[0].estimate, 1.0);
        assert_close(fitted.parameter_estimates[1].estimate, 2.0);

        for row in &fitted.plot_rows {
            assert_close(row.observed, row.fitted);
            assert_close(row.residual, 0.0);
        }

        assert_close(
            fitted.anova[0].sum_of_squares + fitted.anova[1].sum_of_squares,
            fitted.anova[2].sum_of_squares,
        );
        assert_eq!(fitted.summary_of_fit.model_degrees_of_freedom, 1);
        assert_eq!(fitted.summary_of_fit.error_degrees_of_freedom, 3);
        assert_eq!(fitted.summary_of_fit.r_squared, Some(1.0));
        assert_eq!(fitted.summary_of_fit.adjusted_r_squared, Some(1.0));
        assert_eq!(fitted.summary_of_fit.root_mean_square_error, Some(0.0));
        assert_eq!(fitted.warnings, vec![FitModelWarningCode::PerfectFit]);

        for parameter in &fitted.parameter_estimates {
            assert!(parameter.standard_error.is_none());
            assert!(parameter.t_ratio.is_none());
            assert!(parameter.p_value.is_none());
            assert!(parameter.lower_confidence_limit.is_none());
            assert!(parameter.upper_confidence_limit.is_none());
        }
        assert!(fitted.anova[0].f_ratio.is_none());
        assert!(fitted.anova[0].p_value.is_none());
    }

    #[test]
    fn noisy_line_fixture_matches_oracle() {
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        let y = vec![3.1, 4.8, 7.2, 8.9, 11.3, 12.7, 15.1, 16.8, 19.2, 20.9];
        let input = build_input(
            "Y",
            vec![term(FitModelTermKind::Main, &["X"])],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X"), x)]),
            y,
            (1..=10).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_close(fitted.parameter_estimates[0].estimate, 1.0333333333333243);
        assert_close(fitted.parameter_estimates[1].estimate, 1.9939393939393941);

        let expected_fitted = [
            3.0272727272727185,
            5.021212121212113,
            7.015151515151507,
            9.0090909090909,
            11.003030303030295,
            12.996969696969689,
            14.990909090909083,
            16.984848484848477,
            18.97878787878787,
            20.972727272727266,
        ];
        let expected_residuals = [
            0.07272727272728163,
            -0.22121212121211276,
            0.18484848484849348,
            -0.10909090909090047,
            0.29696969696970577,
            -0.2969696969696898,
            0.10909090909091645,
            -0.1848484848484766,
            0.22121212121212963,
            -0.07272727272726698,
        ];

        for (index, row) in fitted.plot_rows.iter().enumerate() {
            assert_close(row.fitted, expected_fitted[index]);
            assert_close(row.residual, expected_residuals[index]);
        }

        assert_close(fitted.anova[1].sum_of_squares, 0.37696969696969823);
        assert_close(fitted.anova[2].sum_of_squares, 328.37999999999994);
        assert_close(fitted.anova[0].sum_of_squares, 328.00303030303024);
        assert_close(
            fitted.anova[0].sum_of_squares + fitted.anova[1].sum_of_squares,
            fitted.anova[2].sum_of_squares,
        );

        assert_eq!(fitted.summary_of_fit.model_degrees_of_freedom, 1);
        assert_eq!(fitted.summary_of_fit.error_degrees_of_freedom, 8);
        assert_close(
            fitted.summary_of_fit.root_mean_square_error.expect("rmse"),
            0.21707420878863587,
        );
        assert_close(
            fitted.summary_of_fit.r_squared.expect("r-squared"),
            0.9988520321061889,
        );
        assert_close(
            fitted
                .summary_of_fit
                .adjusted_r_squared
                .expect("adjusted r-squared"),
            0.9987085361194625,
        );

        assert_parameter_row(
            &fitted.parameter_estimates[0],
            1.0333333333333243,
            0.1482899153344524,
            6.96833180464598,
            8,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[1],
            1.9939393939393941,
            0.023899083821976225,
            83.43162477659006,
            8,
            0.95,
        );
    }

    #[test]
    fn exact_plane_fixture_matches_oracle() {
        let x1 = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let x2 = vec![2.0, 1.0, 4.0, 3.0, 6.0, 5.0];
        let y = vec![0.5, 4.0, -0.5, 3.0, -1.5, 2.0];
        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["X1"]),
                term(FitModelTermKind::Main, &["X2"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X1"), x1), (String::from("X2"), x2)]),
            y,
            (1..=6).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_close(fitted.parameter_estimates[0].estimate, 3.0);
        assert_close(fitted.parameter_estimates[1].estimate, 1.5);
        assert_close(fitted.parameter_estimates[2].estimate, -2.0);
        assert_close(fitted.anova[1].sum_of_squares, 0.0);
        assert_close(fitted.anova[0].sum_of_squares, 22.375);
        assert_close(fitted.anova[2].sum_of_squares, 22.375);
        assert_eq!(fitted.summary_of_fit.error_degrees_of_freedom, 3);
        assert_eq!(fitted.summary_of_fit.r_squared, Some(1.0));
        assert_eq!(fitted.summary_of_fit.adjusted_r_squared, Some(1.0));
        assert_eq!(fitted.warnings, vec![FitModelWarningCode::PerfectFit]);

        for parameter in &fitted.parameter_estimates {
            assert!(parameter.standard_error.is_none());
            assert!(parameter.t_ratio.is_none());
            assert!(parameter.p_value.is_none());
        }
    }

    #[test]
    fn noisy_plane_fixture_matches_oracle() {
        let x1 = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let x2 = vec![2.0, 1.0, 4.0, 3.0, 6.0, 5.0];
        let y = vec![0.55, 3.97, -0.48, 2.96, -1.49, 2.03];
        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["X1"]),
                term(FitModelTermKind::Main, &["X2"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X1"), x1), (String::from("X2"), x2)]),
            y,
            (1..=6).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_close(fitted.parameter_estimates[0].estimate, 2.9979166666666632);
        assert_close(fitted.parameter_estimates[1].estimate, 1.4812500000000008);
        assert_close(fitted.parameter_estimates[2].estimate, -1.9787499999999998);

        assert_close(fitted.anova[1].sum_of_squares, 0.003633333333333347);
        assert_close(fitted.anova[2].sum_of_squares, 21.921133333333334);
        assert_close(fitted.anova[0].sum_of_squares, 21.9175);
        assert_close(
            fitted.anova[0].sum_of_squares + fitted.anova[1].sum_of_squares,
            fitted.anova[2].sum_of_squares,
        );

        assert_eq!(fitted.summary_of_fit.model_degrees_of_freedom, 2);
        assert_eq!(fitted.summary_of_fit.error_degrees_of_freedom, 3);
        assert_close(
            fitted.summary_of_fit.root_mean_square_error.expect("rmse"),
            0.03480102169636857,
        );
        assert_close(
            fitted.summary_of_fit.r_squared.expect("r-squared"),
            0.9998342543116688,
        );
        assert_close(
            fitted
                .summary_of_fit
                .adjusted_r_squared
                .expect("adjusted r-squared"),
            0.9997237571861146,
        );

        assert_parameter_row(
            &fitted.parameter_estimates[0],
            2.9979166666666632,
            0.03360221415764593,
            89.21783108106612,
            3,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[1],
            1.4812500000000008,
            0.014858514830324188,
            99.69031339370292,
            3,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[2],
            -1.9787499999999998,
            0.014858514830324184,
            -133.17279839850772,
            3,
            0.95,
        );
    }

    #[test]
    fn replicated_interaction_fixture_matches_oracle() {
        let a = vec![-1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0];
        let b = vec![-1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0];
        let y = vec![6.04, -4.03, 1.02, 8.95, 6.01, -3.97, 0.98, 9.04];
        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["A"]),
                term(FitModelTermKind::Main, &["B"]),
                term(FitModelTermKind::Interaction, &["A", "B"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("A"), a), (String::from("B"), b)]),
            y,
            (1..=8).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_close(fitted.parameter_estimates[0].estimate, 3.005);
        assert_close(fitted.parameter_estimates[1].estimate, 1.9925);
        assert_close(fitted.parameter_estimates[2].estimate, -0.5075000000000003);
        assert_close(fitted.parameter_estimates[3].estimate, 4.504999999999999);

        assert_close(fitted.anova[1].sum_of_squares, 0.0070999999999999995);
        assert_close(fitted.anova[2].sum_of_squares, 196.18819999999997);
        assert_close(fitted.anova[0].sum_of_squares, 196.18109999999996);
        assert_close(
            fitted.anova[0].sum_of_squares + fitted.anova[1].sum_of_squares,
            fitted.anova[2].sum_of_squares,
        );

        assert_eq!(fitted.summary_of_fit.model_degrees_of_freedom, 3);
        assert_eq!(fitted.summary_of_fit.error_degrees_of_freedom, 4);
        assert_close(
            fitted.summary_of_fit.root_mean_square_error.expect("rmse"),
            0.04213074886588179,
        );
        assert_close(
            fitted.summary_of_fit.r_squared.expect("r-squared"),
            0.9999638102597403,
        );
        assert_close(
            fitted
                .summary_of_fit
                .adjusted_r_squared
                .expect("adjusted r-squared"),
            0.9999366679545457,
        );

        assert_parameter_row(
            &fitted.parameter_estimates[0],
            3.005,
            0.01489546910976623,
            201.73919853452406,
            4,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[1],
            1.9925,
            0.01489546910976623,
            133.76550851249223,
            4,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[2],
            -0.5075000000000003,
            0.01489546910976623,
            -34.0707631468456,
            4,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[3],
            4.504999999999999,
            0.01489546910976623,
            302.4409615301267,
            4,
            0.95,
        );
    }

    #[test]
    fn mean_centered_interaction_fixture_matches_oracle() {
        let runtime = vec![
            8.17, 8.63, 8.65, 8.92, 8.95, 9.22, 9.4, 9.63, 9.93, 10.0, 10.07, 10.08, 10.13, 10.25,
            10.33, 10.47, 10.5, 10.6, 10.85, 10.95, 11.08, 11.12, 11.17, 11.37, 11.5, 11.63, 11.95,
            12.63, 12.88, 13.08, 14.03,
        ];
        let runpulse = vec![
            166.0, 170.0, 156.0, 146.0, 180.0, 178.0, 186.0, 164.0, 148.0, 162.0, 185.0, 168.0,
            168.0, 162.0, 166.0, 186.0, 170.0, 162.0, 162.0, 168.0, 172.0, 176.0, 156.0, 178.0,
            170.0, 176.0, 176.0, 174.0, 168.0, 174.0, 186.0,
        ];
        let rstpulse = vec![
            40.0, 48.0, 45.0, 48.0, 44.0, 55.0, 56.0, 48.0, 49.0, 48.0, 62.0, 67.0, 45.0, 48.0,
            50.0, 59.0, 53.0, 47.0, 64.0, 57.0, 48.0, 51.0, 62.0, 62.0, 52.0, 58.0, 70.0, 58.0,
            44.0, 63.0, 56.0,
        ];
        let oxy = vec![
            59.57, 60.06, 54.3, 54.63, 49.16, 49.87, 48.67, 45.44, 50.55, 46.67, 45.31, 50.39,
            50.54, 46.77, 51.86, 45.79, 47.47, 47.27, 49.09, 40.84, 45.12, 44.75, 46.08, 44.61,
            47.92, 44.81, 45.68, 39.41, 39.2, 39.44, 37.39,
        ];

        let input = build_input(
            "Oxy",
            vec![
                term(FitModelTermKind::Main, &["Runtime"]),
                term(FitModelTermKind::Main, &["RunPulse"]),
                term(FitModelTermKind::Main, &["RstPulse"]),
                term(FitModelTermKind::Interaction, &["Runtime", "RstPulse"]),
            ],
            FitModelCenteringMethod::Mean,
            BTreeMap::from([
                (String::from("Runtime"), runtime),
                (String::from("RunPulse"), runpulse),
                (String::from("RstPulse"), rstpulse),
            ]),
            oxy,
            (1..=31).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_close(fitted.parameter_estimates[0].estimate, 91.37860600474693);
        assert_close(fitted.parameter_estimates[1].estimate, -3.059414649499809);
        assert_close(fitted.parameter_estimates[2].estimate, -0.0732501362581633);
        assert_close(fitted.parameter_estimates[3].estimate, 0.007953458492631182);
        assert_close(fitted.parameter_estimates[4].estimate, 0.08383780480752634);

        assert_close(fitted.anova[1].sum_of_squares, 181.9635518437887);
        assert_close(fitted.anova[2].sum_of_squares, 851.6441354838712);
        assert_close(fitted.anova[0].sum_of_squares, 669.6805836400824);
        assert_close(
            fitted.anova[0].sum_of_squares + fitted.anova[1].sum_of_squares,
            fitted.anova[2].sum_of_squares,
        );

        assert_eq!(fitted.summary_of_fit.model_degrees_of_freedom, 4);
        assert_eq!(fitted.summary_of_fit.error_degrees_of_freedom, 26);
        assert_close(
            fitted.summary_of_fit.root_mean_square_error.expect("rmse"),
            2.6454863726426616,
        );
        assert_close(
            fitted.summary_of_fit.r_squared.expect("r-squared"),
            0.7863385136323353,
        );
        assert_close(
            fitted
                .summary_of_fit
                .adjusted_r_squared
                .expect("adjusted r-squared"),
            0.7534675157296177,
        );

        assert_parameter_row(
            &fitted.parameter_estimates[0],
            91.37860600474693,
            8.162470741351981,
            11.19496888874747,
            26,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[1],
            -3.059414649499809,
            0.4025812099490719,
            -7.59949688135429,
            26,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[2],
            -0.0732501362581633,
            0.05126948817186079,
            -1.4287276676650456,
            26,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[3],
            0.007953458492631182,
            0.07352390351449342,
            0.10817513913775477,
            26,
            0.95,
        );
        assert_parameter_row(
            &fitted.parameter_estimates[4],
            0.08383780480752634,
            0.0485744228089683,
            1.7259660529007328,
            26,
            0.95,
        );
    }

    #[test]
    fn returns_not_computable_for_insufficient_rows() {
        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["A"]),
                term(FitModelTermKind::Main, &["B"]),
                term(FitModelTermKind::Interaction, &["A", "B"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([
                (String::from("A"), vec![1.0, 2.0, 3.0]),
                (String::from("B"), vec![4.0, 5.0, 6.0]),
            ]),
            vec![1.0, 2.0, 3.0],
            vec![1, 2, 3],
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should return a result");
        let FitModelResult::NotComputable(not_computable) = result else {
            panic!("expected not computable result");
        };

        assert_eq!(
            not_computable.reason,
            FitModelNotComputableReason::InsufficientRows
        );
    }

    #[test]
    fn returns_not_computable_for_rank_deficiency() {
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let b = a.iter().map(|value| value * 2.0).collect::<Vec<_>>();
        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["A"]),
                term(FitModelTermKind::Main, &["B"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("A"), a), (String::from("B"), b)]),
            vec![1.0, 1.5, 2.0, 2.5, 3.0],
            vec![1, 2, 3, 4, 5],
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should return a result");
        let FitModelResult::NotComputable(not_computable) = result else {
            panic!("expected not computable result");
        };

        assert_eq!(
            not_computable.reason,
            FitModelNotComputableReason::RankDeficient
        );
    }

    #[test]
    fn saturated_model_keeps_fit_and_nulls_inference() {
        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["A"]),
                term(FitModelTermKind::Main, &["B"]),
                term(FitModelTermKind::Interaction, &["A", "B"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([
                (String::from("A"), vec![0.0, 0.0, 1.0, 1.0]),
                (String::from("B"), vec![0.0, 1.0, 0.0, 1.0]),
            ]),
            vec![10.0, 12.0, 15.0, 20.0],
            vec![1, 2, 3, 4],
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_eq!(
            fitted.warnings,
            vec![
                FitModelWarningCode::SaturatedModel,
                FitModelWarningCode::PerfectFit
            ]
        );
        for parameter in &fitted.parameter_estimates {
            assert!(parameter.standard_error.is_none());
            assert!(parameter.t_ratio.is_none());
            assert!(parameter.p_value.is_none());
            assert!(parameter.lower_confidence_limit.is_none());
            assert!(parameter.upper_confidence_limit.is_none());
        }
        assert!(fitted.summary_of_fit.root_mean_square_error.is_none());
        assert!(fitted.anova[0].f_ratio.is_none());
        assert!(fitted.anova[0].p_value.is_none());
    }

    #[test]
    fn constant_response_sets_warning_and_nulls_r_squared_and_f_test() {
        let input = build_input(
            "Y",
            vec![term(FitModelTermKind::Main, &["X"])],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X"), vec![-2.0, -1.0, 0.0, 1.0, 2.0])]),
            vec![10.0, 10.0, 10.0, 10.0, 10.0],
            vec![1, 2, 3, 4, 5],
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_eq!(
            fitted.warnings,
            vec![
                FitModelWarningCode::ConstantResponse,
                FitModelWarningCode::PerfectFit,
            ]
        );
        assert!(fitted.summary_of_fit.r_squared.is_none());
        assert!(fitted.summary_of_fit.adjusted_r_squared.is_none());
        assert!(fitted.anova[0].f_ratio.is_none());
        assert!(fitted.anova[0].p_value.is_none());
    }

    #[test]
    fn tiny_scale_noisy_data_is_not_classified_as_perfect_fit() {
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        let y = vec![
            3.1e-9, 4.8e-9, 7.2e-9, 8.9e-9, 11.3e-9, 12.7e-9, 15.1e-9, 16.8e-9, 19.2e-9, 20.9e-9,
        ];
        let input = build_input(
            "Y",
            vec![term(FitModelTermKind::Main, &["X"])],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X"), x)]),
            y,
            (1..=10).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert!(!fitted
            .warnings
            .iter()
            .any(|warning| warning == &FitModelWarningCode::PerfectFit));
        assert!(fitted.anova[0].f_ratio.is_some());
        for parameter in &fitted.parameter_estimates {
            assert!(parameter.standard_error.is_some());
            assert!(parameter.t_ratio.is_some());
            assert!(parameter.p_value.is_some());
        }
    }

    #[test]
    fn perfect_fit_sets_warning_and_nulls_tests() {
        let input = build_input(
            "Y",
            vec![term(FitModelTermKind::Main, &["X"])],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X"), vec![1.0, 2.0, 3.0, 4.0])]),
            vec![3.0, 5.0, 7.0, 9.0],
            vec![1, 2, 3, 4],
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_eq!(fitted.warnings, vec![FitModelWarningCode::PerfectFit]);
        assert!(fitted.anova[0].f_ratio.is_none());
        assert!(fitted.anova[0].p_value.is_none());
        for parameter in &fitted.parameter_estimates {
            assert!(parameter.t_ratio.is_none());
            assert!(parameter.p_value.is_none());
        }
    }

    #[test]
    fn ill_conditioned_model_sets_warning() {
        let scale = 1e-11;
        let x1 = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let x2 = x1
            .iter()
            .map(|value| value + scale * value * value)
            .collect::<Vec<_>>();
        let y = x1
            .iter()
            .zip(x2.iter())
            .map(|(a, b)| 5.0 + 3.0 * a - 2.0 * b)
            .collect::<Vec<_>>();

        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["X1"]),
                term(FitModelTermKind::Main, &["X2"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X1"), x1), (String::from("X2"), x2)]),
            y,
            (1..=6).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert!(fitted
            .warnings
            .iter()
            .any(|warning| warning == &FitModelWarningCode::IllConditioned));
    }

    #[test]
    fn ill_conditioned_noisy_full_rank_matches_python_oracle_and_inference_policy() {
        let n = 20_usize;
        let scale = 1.8e-11;
        let x1 = (0..n).map(|index| index as f64 - 9.5).collect::<Vec<_>>();
        let x1_square_mean = x1.iter().map(|value| value * value).sum::<f64>() / n as f64;
        let x2 = x1
            .iter()
            .map(|value| scale * (value * value - x1_square_mean))
            .collect::<Vec<_>>();
        let y = x1
            .iter()
            .zip(x2.iter())
            .enumerate()
            .map(|(index, (a, b))| {
                let noise = ((index % 7) as f64 - 3.0) * 2.0e-4;
                2.5 - 1.75 * a + 8.0e10 * b + noise
            })
            .collect::<Vec<_>>();

        let input = build_input(
            "Y",
            vec![
                term(FitModelTermKind::Main, &["X1"]),
                term(FitModelTermKind::Main, &["X2"]),
            ],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X1"), x1), (String::from("X2"), x2)]),
            y,
            (1..=(n as u64)).collect(),
            0,
        );

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert!(fitted
            .warnings
            .iter()
            .any(|warning| warning == &FitModelWarningCode::IllConditioned));
        assert!(!fitted
            .warnings
            .iter()
            .any(|warning| warning == &FitModelWarningCode::PerfectFit));
        assert!(fitted.summary_of_fit.error_degrees_of_freedom > 0);

        assert_close(fitted.parameter_estimates[0].estimate, 2.4999699999999994);
        assert_close(fitted.parameter_estimates[1].estimate, -1.7499842105263166);
        assert_close(
            fitted.parameter_estimates[2].estimate,
            7.9999906964380661e10,
        );

        assert_close(fitted.anova[1].sum_of_squares, 2.766976076546134e-06);
        assert_close(fitted.anova[0].sum_of_squares, 38440.562678215014);
        assert_close(fitted.anova[2].sum_of_squares, 38440.56268098199);
        assert_close(
            fitted.anova[0].sum_of_squares + fitted.anova[1].sum_of_squares,
            fitted.anova[2].sum_of_squares,
        );
        assert_close(
            fitted.anova[0].mean_square.expect("ms_model"),
            19220.281339107507,
        );
        assert_close(
            fitted.anova[0].f_ratio.expect("f_ratio"),
            118087317607.99515,
        );
        assert_close(
            fitted.anova[0].p_value.expect("model p"),
            6.1141090285572085e-87,
        );
        assert_close(
            fitted.anova[1].mean_square.expect("ms_error"),
            1.6276329862036082e-07,
        );

        assert_close(
            fitted.summary_of_fit.root_mean_square_error.expect("rmse"),
            0.00040343933697690017,
        );
        assert_close(
            fitted.summary_of_fit.r_squared.expect("r_squared"),
            0.9999999999280194,
        );
        assert_close(
            fitted
                .summary_of_fit
                .adjusted_r_squared
                .expect("adjusted_r_squared"),
            0.999999999919551,
        );

        let expected_se = [
            9.0211778227779332e-05,
            1.5644706453961283e-05,
            1.6915815911285867e+05,
        ];
        let expected_t = [
            2.7712235021991528e+04,
            -1.1185791281390363e+05,
            4.7292963806142187e+05,
        ];
        let expected_p = [
            1.6358065008838666e-66,
            8.1623331651686628e-77,
            1.8518567029685031e-87,
        ];
        let expected_ci = [
            (2.4997796697849903e+00, 2.5001603302150084e+00),
            (-1.7500172179717037e+00, -1.7499512030809294e+00),
            (7.9999550071861450e+10, 8.0000263856899872e+10),
        ];

        for (index, parameter) in fitted.parameter_estimates.iter().enumerate() {
            assert_close(
                parameter.standard_error.expect("standard_error"),
                expected_se[index],
            );
            assert_close(parameter.t_ratio.expect("t_ratio"), expected_t[index]);
            assert_close(parameter.p_value.expect("p_value"), expected_p[index]);
            assert_close(
                parameter
                    .lower_confidence_limit
                    .expect("lower_confidence_limit"),
                expected_ci[index].0,
            );
            assert_close(
                parameter
                    .upper_confidence_limit
                    .expect("upper_confidence_limit"),
                expected_ci[index].1,
            );
        }
    }

    fn make_sampling_input() -> FitModelData {
        let n = GRAPH_SCATTER_RENDER_BUDGET + 1;
        let x = (0..n).map(|index| index as f64).collect::<Vec<_>>();
        let y = x
            .iter()
            .map(|value| 2.0 + 0.5 * value + (value % 7.0) * 0.01)
            .collect::<Vec<_>>();

        build_input(
            "Y",
            vec![term(FitModelTermKind::Main, &["X"])],
            FitModelCenteringMethod::None,
            BTreeMap::from([(String::from("X"), x)]),
            y,
            (1..=(n as u64)).collect(),
            0,
        )
    }

    #[test]
    fn sampling_caps_plot_rows_and_is_deterministic() {
        let result_a = fit_linear_model(make_sampling_input(), 0.95).expect("fit should succeed");
        let result_b = fit_linear_model(make_sampling_input(), 0.95).expect("fit should succeed");

        let FitModelResult::Fitted(fitted_a) = result_a else {
            panic!("expected fitted result");
        };
        let FitModelResult::Fitted(fitted_b) = result_b else {
            panic!("expected fitted result");
        };

        assert!(fitted_a.plot_rows_sampled);
        assert_eq!(fitted_a.plot_rows.len(), GRAPH_SCATTER_RENDER_BUDGET);
        assert_eq!(fitted_b.plot_rows.len(), GRAPH_SCATTER_RENDER_BUDGET);

        let rows_a = fitted_a
            .plot_rows
            .iter()
            .map(|row| row.row_index)
            .collect::<Vec<_>>();
        let rows_b = fitted_b
            .plot_rows
            .iter()
            .map(|row| row.row_index)
            .collect::<Vec<_>>();

        assert_eq!(rows_a, rows_b);
        assert_eq!(rows_a.first().copied(), Some(1));
        assert_eq!(
            rows_a.last().copied(),
            Some((GRAPH_SCATTER_RENDER_BUDGET + 1) as u64)
        );
    }

    #[test]
    fn warns_in_required_order_when_multiple_conditions_apply() {
        let matrix = DMatrix::from_row_slice(
            4,
            4,
            &[
                1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0,
            ],
        );
        let terms = resolve_terms(&[
            term(FitModelTermKind::Main, &["X1"]),
            term(FitModelTermKind::Main, &["X2"]),
            term(FitModelTermKind::Main, &["X3"]),
        ])
        .expect("terms should resolve");
        let columns = BTreeMap::from([
            (String::from("X1"), vec![1.0, 2.0, 3.0, 4.0]),
            (String::from("X2"), vec![1.0, 4.0, 9.0, 16.0]),
            (String::from("X3"), vec![1.0, 8.0, 27.0, 64.0]),
        ]);
        let spec = ModelMatrixSpec::from_columns(terms, FitModelCenteringMethod::None, &columns)
            .expect("spec should build");
        let input = FitModelData {
            response_column: String::from("Y"),
            predictor_columns: vec![String::from("X1"), String::from("X2"), String::from("X3")],
            predictor_ranges: vec![],
            model_matrix_spec: spec,
            design_matrix: matrix,
            response_values: vec![5.0, 5.0, 5.0, 5.0],
            row_indexes: vec![1, 2, 3, 4],
            excluded_rows: 0,
        };

        let result = fit_linear_model(input, 0.95).expect("fit should succeed");
        let FitModelResult::Fitted(fitted) = result else {
            panic!("expected fitted result");
        };

        assert_eq!(
            fitted.warnings,
            vec![
                FitModelWarningCode::SaturatedModel,
                FitModelWarningCode::ConstantResponse,
                FitModelWarningCode::PerfectFit,
            ]
        );
    }
}
