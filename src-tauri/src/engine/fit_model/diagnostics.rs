use std::collections::BTreeMap;

use nalgebra::{DMatrix, DVector};
use statrs::distribution::{ContinuousCDF, FisherSnedecor, Normal, StudentsT};

use crate::engine::fit_model::ols::FitModelEngineError;
use crate::models::fit_model::{
    FitModelDiagnosticFlag, FitModelDiagnostics, FitModelInferenceReason, FitModelLackOfFitResult,
    FitModelQqRow, FitModelResolvedTerm, FitModelRowDiagnostic, FitModelVifRow,
};

#[allow(clippy::too_many_arguments)]
pub fn compute_diagnostics(
    design_matrix: &DMatrix<f64>,
    response: &[f64],
    fitted: &[f64],
    residuals: &[f64],
    row_indexes: &[u64],
    predictor_rows: &[Vec<f64>],
    terms: &[FitModelResolvedTerm],
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
    covariance: Option<&[Vec<f64>]>,
) -> Result<FitModelDiagnostics, FitModelEngineError> {
    let row_count = response.len();
    if row_count == 0
        || design_matrix.nrows() != row_count
        || design_matrix.ncols() != terms.len() + 1
        || fitted.len() != row_count
        || residuals.len() != row_count
        || row_indexes.len() != row_count
        || predictor_rows.len() != row_count
    {
        return Err(FitModelEngineError::InvalidInput(
            "diagnostic inputs have inconsistent row counts".to_string(),
        ));
    }
    if design_matrix.iter().any(|value| !value.is_finite())
        || response.iter().any(|value| !value.is_finite())
        || fitted.iter().any(|value| !value.is_finite())
        || residuals.iter().any(|value| !value.is_finite())
        || predictor_rows
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(FitModelEngineError::InvalidInput(
            "diagnostic inputs must be finite".to_string(),
        ));
    }

    let lack_of_fit = lack_of_fit(
        response,
        residuals,
        predictor_rows,
        design_matrix.ncols(),
        error_degrees_of_freedom,
    )?;
    let svd = design_matrix.clone().svd(true, false);
    let u = svd.u.ok_or_else(|| {
        FitModelEngineError::NumericalFailure("diagnostic SVD did not provide U".to_string())
    })?;
    let parameter_count = design_matrix.ncols();
    if u.ncols() < parameter_count {
        return Err(FitModelEngineError::NumericalFailure(
            "diagnostic SVD rank is smaller than parameter count".to_string(),
        ));
    }

    let all_rows = (0..row_count)
        .map(|index| {
            let leverage = (0..parameter_count)
                .map(|column| u[(index, column)].powi(2))
                .sum::<f64>();
            let studentized_residual = mse
                .filter(|value| *value > 0.0 && value.is_finite())
                .and_then(|value| {
                    let variance = value * (1.0 - leverage);
                    (variance > 0.0)
                        .then_some(residuals[index] / variance.sqrt())
                        .filter(|value| value.is_finite())
                });
            let cooks_distance = studentized_residual.and_then(|studentized| {
                let denominator = parameter_count as f64 * (1.0 - leverage);
                (denominator > 0.0)
                    .then_some(studentized.powi(2) * leverage / denominator)
                    .filter(|value| value.is_finite())
            });
            let mut flags = Vec::new();
            if let Some(studentized) = studentized_residual {
                if studentized.abs() > 3.0 {
                    flags.push(FitModelDiagnosticFlag::ResidualSevere);
                } else if studentized.abs() > 2.0 {
                    flags.push(FitModelDiagnosticFlag::ResidualWarning);
                }
            }
            if leverage > 2.0 * parameter_count as f64 / row_count as f64 {
                flags.push(FitModelDiagnosticFlag::HighLeverage);
            }
            if cooks_distance.is_some_and(|value| value > 4.0 / row_count as f64) {
                flags.push(FitModelDiagnosticFlag::Influential);
            }
            let intervals = row_intervals(
                design_matrix,
                index,
                fitted[index],
                covariance,
                mse,
                error_degrees_of_freedom,
                confidence_level,
            );
            FitModelRowDiagnostic {
                row_index: row_indexes[index],
                observed: response[index],
                fitted: fitted[index],
                residual: residuals[index],
                studentized_residual,
                leverage: leverage.is_finite().then_some(leverage),
                cooks_distance,
                mean_confidence_lower: intervals.map(|value| value.0),
                mean_confidence_upper: intervals.map(|value| value.1),
                prediction_lower: intervals.map(|value| value.2),
                prediction_upper: intervals.map(|value| value.3),
                flags,
            }
        })
        .collect::<Vec<_>>();

    let row_sample_indexes = deterministic_sample_indexes(row_count, render_budget());
    let rows_sampled = row_sample_indexes.len() < row_count;
    let rows = row_sample_indexes
        .iter()
        .map(|index| all_rows[*index].clone())
        .collect();

    let mut qq_source = all_rows
        .iter()
        .filter_map(|row| row.studentized_residual.map(|value| (row.row_index, value)))
        .collect::<Vec<_>>();
    qq_source.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let inference_available =
        mse.is_some_and(|value| value > 0.0 && value.is_finite()) && error_degrees_of_freedom > 0;
    let qq_reason = if !inference_available {
        Some(FitModelInferenceReason::InferenceNotEstimable)
    } else if qq_source.len() < 2 {
        Some(FitModelInferenceReason::InsufficientDiagnosticRows)
    } else {
        None
    };
    let qq_all = if qq_reason.is_none() {
        let normal = Normal::new(0.0, 1.0).map_err(|error| {
            FitModelEngineError::NumericalFailure(format!("normal distribution failed: {error}"))
        })?;
        qq_source
            .iter()
            .enumerate()
            .map(|(index, (row_index, studentized_residual))| {
                let probability = (index as f64 + 0.625) / (qq_source.len() as f64 + 0.25);
                FitModelQqRow {
                    row_index: *row_index,
                    theoretical_quantile: normal.inverse_cdf(probability),
                    studentized_residual: *studentized_residual,
                }
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let qq_sample_indexes = deterministic_sample_indexes(qq_all.len(), render_budget());
    let qq_rows_sampled = qq_sample_indexes.len() < qq_all.len();
    let qq_rows = qq_sample_indexes
        .iter()
        .map(|index| qq_all[*index].clone())
        .collect();

    let diagnostics = FitModelDiagnostics {
        lack_of_fit,
        feature_vif: feature_vif(design_matrix, terms),
        rows,
        rows_sampled,
        source_row_count: row_count as u64,
        qq_rows,
        qq_rows_sampled,
        qq_source_row_count: qq_all.len() as u64,
        qq_reason,
    };
    validate_finite_diagnostics(&diagnostics)?;
    Ok(diagnostics)
}

fn validate_finite_diagnostics(
    diagnostics: &FitModelDiagnostics,
) -> Result<(), FitModelEngineError> {
    let lack = &diagnostics.lack_of_fit;
    let required = [
        lack.sum_of_squares_error,
        lack.sum_of_squares_pure_error,
        lack.sum_of_squares_lack_of_fit,
    ];
    let optional = [
        lack.mean_square_pure_error,
        lack.mean_square_lack_of_fit,
        lack.f_ratio,
        lack.p_value,
    ];
    let rows_are_finite = diagnostics.rows.iter().all(|row| {
        [row.observed, row.fitted, row.residual]
            .iter()
            .all(|value| value.is_finite())
            && [
                row.studentized_residual,
                row.leverage,
                row.cooks_distance,
                row.mean_confidence_lower,
                row.mean_confidence_upper,
                row.prediction_lower,
                row.prediction_upper,
            ]
            .iter()
            .flatten()
            .all(|value| value.is_finite())
    });
    let vif_is_finite = diagnostics
        .feature_vif
        .iter()
        .all(|row| row.value.is_none_or(|value| value.is_finite()));
    let qq_is_finite = diagnostics
        .qq_rows
        .iter()
        .all(|row| row.theoretical_quantile.is_finite() && row.studentized_residual.is_finite());
    if required.iter().any(|value| !value.is_finite())
        || optional.iter().flatten().any(|value| !value.is_finite())
        || !rows_are_finite
        || !vif_is_finite
        || !qq_is_finite
    {
        return Err(FitModelEngineError::NumericalFailure(
            "diagnostic output contained a non-finite value".to_string(),
        ));
    }
    Ok(())
}

fn row_intervals(
    design_matrix: &DMatrix<f64>,
    row: usize,
    fitted: f64,
    covariance: Option<&[Vec<f64>]>,
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Option<(f64, f64, f64, f64)> {
    let covariance = covariance?;
    let mse = mse?;
    let size = design_matrix.ncols();
    if mse <= 0.0
        || !mse.is_finite()
        || error_degrees_of_freedom == 0
        || !(0.0..1.0).contains(&confidence_level)
        || covariance.len() != size
        || covariance
            .iter()
            .any(|values| values.len() != size || values.iter().any(|value| !value.is_finite()))
    {
        return None;
    }
    let mean_variance = (0..size)
        .map(|left| {
            (0..size)
                .map(|right| {
                    design_matrix[(row, left)]
                        * covariance[left][right]
                        * design_matrix[(row, right)]
                })
                .sum::<f64>()
        })
        .sum::<f64>();
    if !mean_variance.is_finite() || mean_variance < 0.0 {
        return None;
    }
    let critical = StudentsT::new(0.0, 1.0, error_degrees_of_freedom as f64)
        .ok()?
        .inverse_cdf(0.5 + confidence_level / 2.0);
    let mean_margin = critical * mean_variance.sqrt();
    let prediction_margin = critical * (mse + mean_variance).sqrt();
    let bounds = (
        fitted - mean_margin,
        fitted + mean_margin,
        fitted - prediction_margin,
        fitted + prediction_margin,
    );
    [bounds.0, bounds.1, bounds.2, bounds.3]
        .iter()
        .all(|value| value.is_finite())
        .then_some(bounds)
}

fn feature_vif(
    design_matrix: &DMatrix<f64>,
    terms: &[FitModelResolvedTerm],
) -> Vec<FitModelVifRow> {
    let row_count = design_matrix.nrows();
    terms
        .iter()
        .enumerate()
        .map(|(term_index, term)| {
            let target_column = term_index + 1;
            let target = design_matrix.column(target_column).into_owned();
            let target_mean = target.iter().sum::<f64>() / row_count as f64;
            let total_ss = target
                .iter()
                .map(|value| (value - target_mean).powi(2))
                .sum::<f64>();
            if !total_ss.is_finite() || total_ss <= f64::EPSILON {
                return FitModelVifRow {
                    term_id: term.term_id.clone(),
                    term_label: term.label.clone(),
                    value: None,
                    reason: Some(FitModelInferenceReason::ConstantFeature),
                };
            }

            let auxiliary_columns = (0..design_matrix.ncols())
                .filter(|column| *column != target_column)
                .collect::<Vec<_>>();
            let auxiliary = DMatrix::from_fn(row_count, auxiliary_columns.len(), |row, column| {
                design_matrix[(row, auxiliary_columns[column])]
            });
            let target_vector = DVector::from_column_slice(target.as_slice());
            let (value, reason) = match auxiliary_residual_ss(auxiliary, &target_vector) {
                Ok(residual_ss) if residual_ss > f64::EPSILON => {
                    let vif = total_ss / residual_ss;
                    if vif.is_finite() {
                        (Some(vif), None)
                    } else {
                        (None, Some(FitModelInferenceReason::InferenceNotEstimable))
                    }
                }
                Ok(_) | Err(VifFailure::RankDeficient) => {
                    (None, Some(FitModelInferenceReason::AuxiliaryRankDeficient))
                }
                Err(VifFailure::Numerical) => {
                    (None, Some(FitModelInferenceReason::InferenceNotEstimable))
                }
            };
            FitModelVifRow {
                term_id: term.term_id.clone(),
                term_label: term.label.clone(),
                value,
                reason,
            }
        })
        .collect()
}

enum VifFailure {
    RankDeficient,
    Numerical,
}

fn auxiliary_residual_ss(
    auxiliary: DMatrix<f64>,
    target: &DVector<f64>,
) -> Result<f64, VifFailure> {
    let row_count = auxiliary.nrows();
    let column_count = auxiliary.ncols();
    let svd = auxiliary.clone().svd(true, true);
    let sigma_max = svd.singular_values.iter().copied().fold(0.0_f64, f64::max);
    let tolerance = row_count.max(column_count) as f64 * f64::EPSILON * sigma_max;
    if svd
        .singular_values
        .iter()
        .filter(|value| **value > tolerance)
        .count()
        < column_count
    {
        return Err(VifFailure::RankDeficient);
    }
    let u = svd.u.ok_or(VifFailure::Numerical)?;
    let v_t = svd.v_t.ok_or(VifFailure::Numerical)?;
    let mut scaled = DVector::zeros(column_count);
    for index in 0..column_count {
        let sigma = svd.singular_values[index];
        if sigma <= tolerance {
            return Err(VifFailure::RankDeficient);
        }
        scaled[index] = u.column(index).dot(target) / sigma;
    }
    let coefficients = v_t.transpose() * scaled;
    let residual = target - auxiliary * coefficients;
    let residual_ss = residual.iter().map(|value| value.powi(2)).sum::<f64>();
    residual_ss
        .is_finite()
        .then_some(residual_ss)
        .ok_or(VifFailure::Numerical)
}

fn render_budget() -> usize {
    crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET
}

fn deterministic_sample_indexes(length: usize, budget: usize) -> Vec<usize> {
    if length <= budget {
        return (0..length).collect();
    }
    if budget <= 1 {
        return vec![0];
    }
    (0..budget)
        .map(|index| index * (length - 1) / (budget - 1))
        .collect()
}

fn lack_of_fit(
    response: &[f64],
    residuals: &[f64],
    predictor_rows: &[Vec<f64>],
    parameter_count: usize,
    error_degrees_of_freedom: u64,
) -> Result<FitModelLackOfFitResult, FitModelEngineError> {
    let mut groups = BTreeMap::<Vec<u64>, Vec<usize>>::new();
    for (index, row) in predictor_rows.iter().enumerate() {
        let key = row
            .iter()
            .map(|value| if *value == 0.0 { 0 } else { value.to_bits() })
            .collect::<Vec<_>>();
        groups.entry(key).or_default().push(index);
    }

    let ss_error = residuals.iter().map(|value| value.powi(2)).sum::<f64>();
    let mut ss_pure_error = 0.0;
    for indexes in groups.values() {
        let mean = indexes
            .iter()
            .enumerate()
            .fold(0.0, |mean, (position, index)| {
                let count = (position + 1) as f64;
                mean * ((count - 1.0) / count) + response[*index] / count
            });
        ss_pure_error += indexes
            .iter()
            .map(|index| (response[*index] - mean).powi(2))
            .sum::<f64>();
    }
    let tolerance = 1e-12 * ss_error.abs().max(1.0);
    let raw_ss_lack_of_fit = ss_error - ss_pure_error;
    let ss_lack_of_fit = if raw_ss_lack_of_fit >= 0.0 {
        raw_ss_lack_of_fit
    } else if raw_ss_lack_of_fit >= -tolerance {
        0.0
    } else {
        return Err(FitModelEngineError::NumericalFailure(
            "lack-of-fit sum of squares is negative beyond tolerance".to_string(),
        ));
    };
    let pure_error_df = response.len().saturating_sub(groups.len()) as u64;
    let lack_of_fit_df = groups.len().saturating_sub(parameter_count) as u64;
    let mean_square_pure_error =
        (pure_error_df > 0).then_some(ss_pure_error / pure_error_df as f64);
    let mean_square_lack_of_fit =
        (lack_of_fit_df > 0).then_some(ss_lack_of_fit / lack_of_fit_df as f64);
    let reason = if pure_error_df == 0 {
        Some(FitModelInferenceReason::NoReplicates)
    } else if lack_of_fit_df == 0 {
        Some(FitModelInferenceReason::LackOfFitDegreesOfFreedomZero)
    } else if ss_pure_error == 0.0 {
        Some(FitModelInferenceReason::PureErrorZero)
    } else {
        None
    };
    let f_ratio = match (mean_square_lack_of_fit, mean_square_pure_error, &reason) {
        (Some(lack), Some(pure), None) if pure > 0.0 => Some(lack / pure),
        _ => None,
    };
    let p_value = f_ratio.and_then(|ratio| {
        FisherSnedecor::new(lack_of_fit_df as f64, pure_error_df as f64)
            .ok()
            .map(|distribution| distribution.sf(ratio.max(0.0)))
            .filter(|value| value.is_finite())
    });

    Ok(FitModelLackOfFitResult {
        sum_of_squares_error: ss_error,
        sum_of_squares_pure_error: ss_pure_error,
        sum_of_squares_lack_of_fit: ss_lack_of_fit,
        error_degrees_of_freedom,
        pure_error_degrees_of_freedom: pure_error_df,
        lack_of_fit_degrees_of_freedom: lack_of_fit_df,
        mean_square_pure_error,
        mean_square_lack_of_fit,
        f_ratio,
        p_value,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use nalgebra::DMatrix;

    use super::compute_diagnostics;
    use crate::engine::fit_model::ols::FitModelEngineError;
    use crate::models::fit_model::{
        FitModelInferenceReason, FitModelResolvedTerm, FitModelTermKind,
    };

    fn assert_close(actual: f64, expected: f64) {
        let tolerance = 1e-12_f64.max(expected.abs() * 1e-9);
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected}"
        );
    }

    #[test]
    fn computes_replicated_lack_of_fit_and_row_leverage() {
        let design = DMatrix::from_row_slice(
            6,
            2,
            &[1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 1.0, 2.0],
        );
        let response = vec![1.0, 2.0, 3.0, 5.0, 5.0, 8.0];
        let fitted = vec![1.5, 1.5, 4.0, 4.0, 6.5, 6.5];
        let residuals = response
            .iter()
            .zip(&fitted)
            .map(|(observed, predicted)| observed - predicted)
            .collect::<Vec<_>>();
        let diagnostics = compute_diagnostics(
            &design,
            &response,
            &fitted,
            &residuals,
            &[1, 2, 3, 4, 5, 6],
            &[
                vec![0.0],
                vec![0.0],
                vec![1.0],
                vec![1.0],
                vec![2.0],
                vec![2.0],
            ],
            &[FitModelResolvedTerm {
                term_id: "A".to_string(),
                kind: FitModelTermKind::Main,
                column_names: vec!["A".to_string()],
                label: "A".to_string(),
            }],
            Some(1.75),
            4,
            0.95,
            Some(&[vec![0.1, 0.0], vec![0.0, 0.1]]),
        )
        .expect("diagnostics should be computable");

        let lack_of_fit = diagnostics.lack_of_fit;
        assert_close(lack_of_fit.sum_of_squares_error, 7.0);
        assert_close(lack_of_fit.sum_of_squares_pure_error, 7.0);
        assert_close(lack_of_fit.sum_of_squares_lack_of_fit, 0.0);
        assert_eq!(lack_of_fit.pure_error_degrees_of_freedom, 3);
        assert_eq!(lack_of_fit.lack_of_fit_degrees_of_freedom, 1);
        assert_close(lack_of_fit.f_ratio.unwrap(), 0.0);
        assert_close(lack_of_fit.p_value.unwrap(), 1.0);
        assert_eq!(lack_of_fit.reason, None);

        assert_eq!(diagnostics.rows.len(), 6);
        assert!(diagnostics.rows.iter().all(|row| row.leverage.is_some()));
        assert_close(diagnostics.rows[0].leverage.unwrap(), 5.0 / 12.0);
        assert_close(diagnostics.rows[2].leverage.unwrap(), 1.0 / 6.0);
        assert_close(diagnostics.rows[4].leverage.unwrap(), 5.0 / 12.0);
        let row = &diagnostics.rows[2];
        assert!(row.mean_confidence_lower.is_some());
        assert!(row.mean_confidence_upper.is_some());
        assert!(row.prediction_lower.is_some());
        assert!(row.prediction_upper.is_some());
        assert!(
            row.prediction_upper.unwrap() - row.fitted
                > row.mean_confidence_upper.unwrap() - row.fitted
        );
    }

    #[test]
    fn reports_no_replicates_and_preserves_perfect_fit_leverage() {
        let design = DMatrix::from_row_slice(4, 2, &[1.0, 0.0, 1.0, 1.0, 1.0, 2.0, 1.0, 3.0]);
        let response = vec![1.0, 3.0, 5.0, 7.0];
        let diagnostics = compute_diagnostics(
            &design,
            &response,
            &response,
            &[0.0; 4],
            &[1, 2, 3, 4],
            &[vec![0.0], vec![1.0], vec![2.0], vec![3.0]],
            &[FitModelResolvedTerm {
                term_id: "A".to_string(),
                kind: FitModelTermKind::Main,
                column_names: vec!["A".to_string()],
                label: "A".to_string(),
            }],
            Some(0.0),
            2,
            0.95,
            None,
        )
        .expect("perfect-fit diagnostics should preserve geometry");

        assert_eq!(
            diagnostics.lack_of_fit.reason,
            Some(crate::models::fit_model::FitModelInferenceReason::NoReplicates)
        );
        assert!(diagnostics.rows.iter().all(|row| row.leverage.is_some()));
        assert!(diagnostics
            .rows
            .iter()
            .all(|row| row.studentized_residual.is_none() && row.cooks_distance.is_none()));
        assert!(diagnostics.qq_rows.is_empty());
        assert_eq!(
            diagnostics.qq_reason,
            Some(crate::models::fit_model::FitModelInferenceReason::InferenceNotEstimable)
        );
    }

    #[test]
    fn computes_feature_vif_cooks_flags_and_qq_rows() {
        let design = DMatrix::from_row_slice(
            4,
            3,
            &[
                1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0, 1.0,
            ],
        );
        let response = vec![0.0, 0.0, 0.0, 4.0];
        let fitted = vec![0.5, -0.5, -0.5, 4.5];
        let residuals = vec![-0.5, 0.5, 0.5, -0.5];
        let terms = vec![
            FitModelResolvedTerm {
                term_id: "A".to_string(),
                kind: FitModelTermKind::Main,
                column_names: vec!["A".to_string()],
                label: "A".to_string(),
            },
            FitModelResolvedTerm {
                term_id: "B".to_string(),
                kind: FitModelTermKind::Main,
                column_names: vec!["B".to_string()],
                label: "B".to_string(),
            },
        ];
        let diagnostics = compute_diagnostics(
            &design,
            &response,
            &fitted,
            &residuals,
            &[1, 2, 3, 4],
            &[
                vec![-1.0, -1.0],
                vec![-1.0, 1.0],
                vec![1.0, -1.0],
                vec![1.0, 1.0],
            ],
            &terms,
            Some(1.0),
            1,
            0.95,
            None,
        )
        .expect("diagnostics should be computable");

        assert_eq!(diagnostics.feature_vif.len(), 2);
        assert_close(diagnostics.feature_vif[0].value.unwrap(), 1.0);
        assert_close(diagnostics.feature_vif[1].value.unwrap(), 1.0);
        assert!(diagnostics
            .rows
            .iter()
            .all(|row| row.cooks_distance.is_some()));
        assert_eq!(diagnostics.qq_rows.len(), 4);
        assert!(diagnostics
            .qq_rows
            .windows(2)
            .all(|pair| pair[0].studentized_residual <= pair[1].studentized_residual));
    }

    #[test]
    fn samples_row_and_qq_diagnostics_to_render_budget() {
        let row_count = crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET + 1;
        let mut design_data = Vec::with_capacity(row_count * 2);
        let mut response = Vec::with_capacity(row_count);
        let mut predictor_rows = Vec::with_capacity(row_count);
        for index in 0..row_count {
            let value = index as f64;
            design_data.extend([1.0, value]);
            response.push(value + if index % 2 == 0 { -1.0 } else { 1.0 });
            predictor_rows.push(vec![value]);
        }
        let design = DMatrix::from_row_slice(row_count, 2, &design_data);
        let fitted = (0..row_count).map(|index| index as f64).collect::<Vec<_>>();
        let residuals = response
            .iter()
            .zip(&fitted)
            .map(|(observed, predicted)| observed - predicted)
            .collect::<Vec<_>>();
        let diagnostics = compute_diagnostics(
            &design,
            &response,
            &fitted,
            &residuals,
            &(1..=row_count as u64).collect::<Vec<_>>(),
            &predictor_rows,
            &[FitModelResolvedTerm {
                term_id: "A".to_string(),
                kind: FitModelTermKind::Main,
                column_names: vec!["A".to_string()],
                label: "A".to_string(),
            }],
            Some(1.0),
            (row_count - 2) as u64,
            0.95,
            None,
        )
        .expect("large diagnostics should be sampled");

        assert_eq!(
            diagnostics.rows.len(),
            crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET
        );
        assert!(diagnostics.rows_sampled);
        assert_eq!(diagnostics.source_row_count, row_count as u64);
        assert_eq!(
            diagnostics.qq_rows.len(),
            crate::models::graph_data::GRAPH_SCATTER_RENDER_BUDGET
        );
        assert!(diagnostics.qq_rows_sampled);
        assert_eq!(diagnostics.qq_source_row_count, row_count as u64);
    }

    #[test]
    fn rejects_term_dimension_mismatch_and_non_finite_inputs() {
        let design = DMatrix::from_row_slice(2, 2, &[1.0, 0.0, 1.0, 1.0]);
        let mismatch = compute_diagnostics(
            &design,
            &[1.0, 2.0],
            &[1.0, 2.0],
            &[0.0, 0.0],
            &[1, 2],
            &[vec![0.0], vec![1.0]],
            &[],
            Some(1.0),
            1,
            0.95,
            None,
        );
        assert!(matches!(
            mismatch,
            Err(FitModelEngineError::InvalidInput(_))
        ));

        let non_finite = compute_diagnostics(
            &design,
            &[1.0, f64::INFINITY],
            &[1.0, 2.0],
            &[0.0, 0.0],
            &[1, 2],
            &[vec![0.0], vec![1.0]],
            &[FitModelResolvedTerm {
                term_id: "A".to_string(),
                kind: FitModelTermKind::Main,
                column_names: vec!["A".to_string()],
                label: "A".to_string(),
            }],
            Some(1.0),
            1,
            0.95,
            None,
        );
        assert!(matches!(
            non_finite,
            Err(FitModelEngineError::InvalidInput(_))
        ));
    }

    #[test]
    fn reports_insufficient_rows_for_qq_when_inference_has_fewer_than_two_points() {
        let diagnostics = compute_diagnostics(
            &DMatrix::from_row_slice(1, 1, &[1.0]),
            &[1.0],
            &[1.0],
            &[0.0],
            &[1],
            &[vec![]],
            &[],
            Some(1.0),
            1,
            0.95,
            None,
        )
        .expect("single-row geometry should return a structured QQ empty state");

        assert!(diagnostics.qq_rows.is_empty());
        assert_eq!(diagnostics.qq_source_row_count, 0);
        assert_eq!(
            diagnostics.qq_reason,
            Some(FitModelInferenceReason::InsufficientDiagnosticRows)
        );
    }
}
