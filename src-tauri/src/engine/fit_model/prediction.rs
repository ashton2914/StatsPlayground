use std::collections::BTreeMap;

use statrs::distribution::{ContinuousCDF, StudentsT};

use crate::engine::fit_model::ols::FitModelEngineError;
use crate::engine::fit_model::terms::resolve_terms;
use crate::engine::fit_model::ModelMatrixSpec;
use crate::models::fit_model::{
    FitModelInferenceReason, FitModelPrediction, FitModelSnapshot, FitModelTerm, FitModelTermKind,
};

pub fn predict_from_snapshot(
    snapshot: &FitModelSnapshot,
    values: &BTreeMap<String, f64>,
) -> Result<FitModelPrediction, FitModelEngineError> {
    let terms = snapshot
        .terms
        .iter()
        .map(|term| FitModelTerm {
            kind: term.kind.clone(),
            column_names: term.column_names.clone(),
            exponent: (term.kind == FitModelTermKind::Power).then_some(2),
        })
        .collect::<Vec<_>>();
    let resolved = resolve_terms(&terms).map_err(|error| {
        FitModelEngineError::InvalidInput(format!("invalid snapshot terms: {error:?}"))
    })?;
    let expected_ids = std::iter::once("Intercept")
        .chain(resolved.iter().map(|term| term.term_id()))
        .collect::<Vec<_>>();
    if expected_ids
        != snapshot
            .coefficient_term_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
        || snapshot.coefficients.len() != expected_ids.len()
        || snapshot.coefficients.iter().any(|value| !value.is_finite())
        || values.values().any(|value| !value.is_finite())
    {
        return Err(FitModelEngineError::InvalidInput(
            "snapshot coefficient order or prediction values are invalid".to_string(),
        ));
    }

    let matrix_spec = ModelMatrixSpec::from_snapshot_parts(
        resolved,
        snapshot.centering.method.clone(),
        snapshot.centering.centers.clone(),
    )
    .map_err(|error| {
        FitModelEngineError::InvalidInput(format!("invalid snapshot matrix: {error:?}"))
    })?;
    let feature_vector = matrix_spec.transform_point(values).map_err(|error| {
        FitModelEngineError::InvalidInput(format!("invalid prediction point: {error:?}"))
    })?;
    let predicted = feature_vector
        .iter()
        .zip(&snapshot.coefficients)
        .map(|(feature, coefficient)| feature * coefficient)
        .sum::<f64>();
    if !predicted.is_finite() {
        return Err(FitModelEngineError::NumericalFailure(
            "point prediction is non-finite".to_string(),
        ));
    }

    let inference = inference_intervals(snapshot, &feature_vector, predicted);
    let Some((mean_lower, mean_upper, prediction_lower, prediction_upper)) = inference else {
        return Ok(FitModelPrediction {
            predicted,
            mean_confidence_lower: None,
            mean_confidence_upper: None,
            prediction_lower: None,
            prediction_upper: None,
            inference_reason: Some(FitModelInferenceReason::InferenceNotEstimable),
        });
    };

    Ok(FitModelPrediction {
        predicted,
        mean_confidence_lower: Some(mean_lower),
        mean_confidence_upper: Some(mean_upper),
        prediction_lower: Some(prediction_lower),
        prediction_upper: Some(prediction_upper),
        inference_reason: None,
    })
}

fn inference_intervals(
    snapshot: &FitModelSnapshot,
    feature_vector: &[f64],
    predicted: f64,
) -> Option<(f64, f64, f64, f64)> {
    let covariance = snapshot.covariance.as_ref()?;
    let mse = snapshot.mean_square_error?;
    let size = feature_vector.len();
    if mse <= 0.0
        || !mse.is_finite()
        || snapshot.error_degrees_of_freedom == 0
        || !snapshot.confidence_level.is_finite()
        || !(0.0..1.0).contains(&snapshot.confidence_level)
        || covariance.len() != size
        || covariance
            .iter()
            .any(|row| row.len() != size || row.iter().any(|value| !value.is_finite()))
    {
        return None;
    }

    let mean_variance = feature_vector
        .iter()
        .enumerate()
        .map(|(row, row_value)| {
            covariance[row]
                .iter()
                .zip(feature_vector)
                .map(|(covariance_value, column_value)| row_value * covariance_value * column_value)
                .sum::<f64>()
        })
        .sum::<f64>();
    if !mean_variance.is_finite() || mean_variance < 0.0 {
        return None;
    }

    let distribution = StudentsT::new(0.0, 1.0, snapshot.error_degrees_of_freedom as f64).ok()?;
    let probability = 0.5 + snapshot.confidence_level / 2.0;
    let critical = distribution.inverse_cdf(probability);
    let mean_margin = critical * mean_variance.sqrt();
    let prediction_margin = critical * (mse + mean_variance).sqrt();
    let bounds = (
        predicted - mean_margin,
        predicted + mean_margin,
        predicted - prediction_margin,
        predicted + prediction_margin,
    );
    [bounds.0, bounds.1, bounds.2, bounds.3]
        .iter()
        .all(|value| value.is_finite())
        .then_some(bounds)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::predict_from_snapshot;
    use crate::models::fit_model::{
        FitModelCenter, FitModelCentering, FitModelCenteringMethod, FitModelPredictorRange,
        FitModelResolvedTerm, FitModelSnapshot, FitModelTermKind,
    };

    fn assert_close(actual: f64, expected: f64) {
        let tolerance = 1e-12_f64.max(expected.abs() * 1e-9);
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected}"
        );
    }

    fn response_surface_snapshot() -> FitModelSnapshot {
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
            FitModelResolvedTerm {
                term_id: "interaction:A*B".to_string(),
                kind: FitModelTermKind::Interaction,
                column_names: vec!["A".to_string(), "B".to_string()],
                label: "A*B".to_string(),
            },
            FitModelResolvedTerm {
                term_id: "power:A^2".to_string(),
                kind: FitModelTermKind::Power,
                column_names: vec!["A".to_string()],
                label: "A^2".to_string(),
            },
        ];
        FitModelSnapshot {
            coefficient_term_ids: std::iter::once("Intercept".to_string())
                .chain(terms.iter().map(|term| term.term_id.clone()))
                .collect(),
            coefficients: vec![1.0, 2.0, -1.0, 0.5, 3.0],
            covariance: Some(vec![
                vec![0.04, 0.0, 0.0, 0.0, 0.0],
                vec![0.0, 0.01, 0.0, 0.0, 0.0],
                vec![0.0, 0.0, 0.0025, 0.0, 0.0],
                vec![0.0, 0.0, 0.0, 0.01, 0.0],
                vec![0.0, 0.0, 0.0, 0.0, 0.04],
            ]),
            mean_square_error: Some(0.25),
            error_degrees_of_freedom: 10,
            confidence_level: 0.95,
            terms,
            centering: FitModelCentering {
                method: FitModelCenteringMethod::Mean,
                centers: vec![
                    FitModelCenter {
                        column_name: "A".to_string(),
                        mean: 2.0,
                    },
                    FitModelCenter {
                        column_name: "B".to_string(),
                        mean: 4.0,
                    },
                ],
            },
            predictor_ranges: vec![
                FitModelPredictorRange {
                    column_name: "A".to_string(),
                    minimum: 0.0,
                    maximum: 4.0,
                    mean: 2.0,
                },
                FitModelPredictorRange {
                    column_name: "B".to_string(),
                    minimum: 1.0,
                    maximum: 7.0,
                    mean: 4.0,
                },
            ],
        }
    }

    #[test]
    fn predicts_centered_response_surface_with_mean_and_prediction_intervals() {
        let prediction = predict_from_snapshot(
            &response_surface_snapshot(),
            &BTreeMap::from([("A".to_string(), 3.0), ("B".to_string(), 6.0)]),
        )
        .expect("prediction should succeed");

        assert_close(prediction.predicted, 5.0);
        assert_close(prediction.mean_confidence_lower.unwrap(), 3.77959808952514);
        assert_close(prediction.mean_confidence_upper.unwrap(), 6.22040191047486);
        assert_close(prediction.prediction_lower.unwrap(), 3.34756800170186);
        assert_close(prediction.prediction_upper.unwrap(), 6.65243199829814);
        assert_eq!(prediction.inference_reason, None);
    }

    #[test]
    fn preserves_point_prediction_when_inference_is_not_estimable() {
        let mut snapshot = response_surface_snapshot();
        snapshot.covariance = None;
        snapshot.mean_square_error = None;
        snapshot.error_degrees_of_freedom = 0;

        let prediction = predict_from_snapshot(
            &snapshot,
            &BTreeMap::from([("A".to_string(), 3.0), ("B".to_string(), 6.0)]),
        )
        .expect("point prediction should remain available");

        assert_close(prediction.predicted, 5.0);
        assert_eq!(prediction.mean_confidence_lower, None);
        assert_eq!(prediction.mean_confidence_upper, None);
        assert_eq!(prediction.prediction_lower, None);
        assert_eq!(prediction.prediction_upper, None);
        assert_eq!(
            prediction.inference_reason,
            Some(crate::models::fit_model::FitModelInferenceReason::InferenceNotEstimable)
        );
    }
}
