use crate::error::AppError;
use crate::models::hypothesis_test::HypothesisTestAlternative;
use statrs::distribution::{ContinuousCDF, StudentsT};

#[derive(Debug, Clone, PartialEq)]
pub struct ParametricTestResult {
    pub estimate: f64,
    pub standard_error: f64,
    pub statistic: f64,
    pub degrees_of_freedom: f64,
    pub p_value: f64,
    pub lower: f64,
    pub upper: f64,
}

pub fn paired_t(
    pairs: &[[f64; 2]],
    alternative: HypothesisTestAlternative,
    confidence_level: f64,
) -> Result<ParametricTestResult, AppError> {
    let differences = pairs.iter().map(|pair| pair[0] - pair[1]).collect::<Vec<_>>();
    let (mean, variance) = sample_moments(&differences)?;
    let standard_error = (variance / differences.len() as f64).sqrt();
    finish_t(mean, standard_error, (differences.len() - 1) as f64, alternative, confidence_level)
}

pub fn student_two_sample_t(
    left: &[f64],
    right: &[f64],
    alternative: HypothesisTestAlternative,
    confidence_level: f64,
) -> Result<ParametricTestResult, AppError> {
    let (left_mean, left_variance) = sample_moments(left)?;
    let (right_mean, right_variance) = sample_moments(right)?;
    let degrees_of_freedom = (left.len() + right.len() - 2) as f64;
    let pooled_variance = (((left.len() - 1) as f64 * left_variance)
        + ((right.len() - 1) as f64 * right_variance)) / degrees_of_freedom;
    let standard_error = (pooled_variance * (1.0 / left.len() as f64 + 1.0 / right.len() as f64)).sqrt();
    finish_t(
        left_mean - right_mean,
        standard_error,
        degrees_of_freedom,
        alternative,
        confidence_level,
    )
}

pub fn welch_two_sample_t(
    left: &[f64],
    right: &[f64],
    alternative: HypothesisTestAlternative,
    confidence_level: f64,
) -> Result<ParametricTestResult, AppError> {
    let (left_mean, left_variance) = sample_moments(left)?;
    let (right_mean, right_variance) = sample_moments(right)?;
    let left_component = left_variance / left.len() as f64;
    let right_component = right_variance / right.len() as f64;
    let variance_sum = left_component + right_component;
    let denominator = left_component.powi(2) / (left.len() - 1) as f64
        + right_component.powi(2) / (right.len() - 1) as f64;
    if denominator <= 0.0 {
        return Err(AppError::Stats("Welch degrees of freedom are not estimable".into()));
    }
    let degrees_of_freedom = variance_sum.powi(2) / denominator;
    finish_t(
        left_mean - right_mean,
        variance_sum.sqrt(),
        degrees_of_freedom,
        alternative,
        confidence_level,
    )
}

pub(crate) fn sample_moments(values: &[f64]) -> Result<(f64, f64), AppError> {
    if values.len() < 2 || values.iter().any(|value| !value.is_finite()) {
        return Err(AppError::Stats("at least two finite observations are required".into()));
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let sum_squares = values.iter().map(|value| (value - mean).powi(2)).sum::<f64>();
    let variance = sum_squares / (values.len() - 1) as f64;
    if !variance.is_finite() {
        return Err(AppError::Stats("sample variance is not estimable".into()));
    }
    Ok((mean, variance))
}

fn finish_t(
    estimate: f64,
    standard_error: f64,
    degrees_of_freedom: f64,
    alternative: HypothesisTestAlternative,
    confidence_level: f64,
) -> Result<ParametricTestResult, AppError> {
    if !standard_error.is_finite() || standard_error <= 0.0 || !degrees_of_freedom.is_finite() || degrees_of_freedom <= 0.0 {
        return Err(AppError::Stats("t statistic is not estimable from zero or invalid variance".into()));
    }
    if !confidence_level.is_finite() || confidence_level <= 0.0 || confidence_level >= 1.0 {
        return Err(AppError::InvalidParam("confidence level must be inside (0, 1)".into()));
    }
    let distribution = StudentsT::new(0.0, 1.0, degrees_of_freedom)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    let statistic = estimate / standard_error;
    let (p_value, lower_probability, upper_probability) = match alternative {
        HypothesisTestAlternative::TwoSided => (
            2.0 * distribution.cdf(-statistic.abs()),
            (1.0 - confidence_level) / 2.0,
            1.0 - (1.0 - confidence_level) / 2.0,
        ),
        HypothesisTestAlternative::Less => (
            distribution.cdf(statistic),
            1.0 - confidence_level,
            1.0,
        ),
        HypothesisTestAlternative::Greater => (
            distribution.sf(statistic),
            0.0,
            confidence_level,
        ),
    };
    let lower = if lower_probability == 0.0 {
        f64::NEG_INFINITY
    } else {
        estimate + distribution.inverse_cdf(lower_probability) * standard_error
    };
    let upper = if upper_probability == 1.0 {
        f64::INFINITY
    } else {
        estimate + distribution.inverse_cdf(upper_probability) * standard_error
    };
    Ok(ParametricTestResult {
        estimate,
        standard_error,
        statistic,
        degrees_of_freedom,
        p_value: p_value.clamp(0.0, 1.0),
        lower,
        upper,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_t_matches_reference_and_is_affine_invariant() {
        let pairs = [[1.0, 2.0], [2.0, 4.0], [4.0, 5.0], [7.0, 9.0]];
        let result = paired_t(&pairs, HypothesisTestAlternative::TwoSided, 0.95)
            .expect("paired t");
        assert!((result.estimate + 1.5).abs() < 1e-12);
        assert!((result.statistic + 5.196_152_422_706_632).abs() < 1e-12);
        assert!((result.degrees_of_freedom - 3.0).abs() < 1e-12);
        assert!((result.p_value - 0.013_846_832_988_859).abs() < 1e-10);

        let transformed = pairs.map(|[left, right]| [left * 10.0 + 7.0, right * 10.0 + 7.0]);
        let transformed = paired_t(&transformed, HypothesisTestAlternative::TwoSided, 0.95)
            .expect("transformed paired t");
        assert!((transformed.statistic - result.statistic).abs() < 1e-12);
        assert!((transformed.p_value - result.p_value).abs() < 1e-12);
    }

    #[test]
    fn student_and_welch_use_distinct_variance_and_df_models() {
        let left = [10.0, 11.0, 12.0, 13.0];
        let right = [20.0, 22.0, 24.0, 26.0, 28.0];
        let student = student_two_sample_t(
            &left,
            &right,
            HypothesisTestAlternative::TwoSided,
            0.95,
        ).expect("Student t");
        let welch = welch_two_sample_t(
            &left,
            &right,
            HypothesisTestAlternative::TwoSided,
            0.95,
        ).expect("Welch t");

        assert!((student.statistic + 7.349_309_197_401_64).abs() < 1e-12);
        assert!((student.degrees_of_freedom - 7.0).abs() < 1e-12);
        assert!((welch.statistic + 8.040_844_011_283_461).abs() < 1e-12);
        assert!((welch.degrees_of_freedom - 5.520_787_746_170_677).abs() < 1e-12);
        assert!(student.p_value > 0.0 && student.p_value < 0.001);
        assert!(welch.p_value > 0.0 && welch.p_value < 0.001);
    }

    #[test]
    fn one_sided_alternatives_use_directional_tails_and_infinite_interval_bound() {
        let left = [1.0, 2.0, 3.0, 4.0];
        let right = [4.0, 5.0, 6.0, 7.0];
        let less = welch_two_sample_t(
            &left,
            &right,
            HypothesisTestAlternative::Less,
            0.95,
        ).expect("less Welch t");
        let greater = welch_two_sample_t(
            &left,
            &right,
            HypothesisTestAlternative::Greater,
            0.95,
        ).expect("greater Welch t");

        assert!(less.p_value < 0.01);
        assert!(less.upper.is_infinite() && less.upper.is_sign_positive());
        assert!(greater.p_value > 0.99);
        assert!(greater.lower.is_infinite() && greater.lower.is_sign_negative());
    }
}