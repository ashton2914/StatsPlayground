use crate::error::AppError;
use statrs::distribution::{ChiSquared, ContinuousCDF};
use statrs::function::erf::erf;

const NORMAL_ORDER: usize = 64;
const MIXTURE_ORDER: usize = 64;

pub fn cdf(value: f64, groups: usize, degrees_of_freedom: f64) -> Result<f64, AppError> {
    validate_parameters(groups, degrees_of_freedom)?;
    if value <= 0.0 {
        return Ok(0.0);
    }
    if value.is_infinite() {
        return Ok(1.0);
    }
    let chi_squared = ChiSquared::new(degrees_of_freedom)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    let (nodes, weights) = gauss_legendre(MIXTURE_ORDER);
    let epsilon = 1e-12;
    let expectation = nodes.iter().zip(weights).map(|(node, weight)| {
        let probability = epsilon + (1.0 - 2.0 * epsilon) * (node + 1.0) / 2.0;
        let scale = (chi_squared.inverse_cdf(probability) / degrees_of_freedom).sqrt();
        weight * normal_range_cdf(value * scale, groups)
    }).sum::<f64>() * (1.0 - 2.0 * epsilon) / 2.0;
    Ok(expectation.clamp(0.0, 1.0))
}

pub fn inverse_cdf(
    probability: f64,
    groups: usize,
    degrees_of_freedom: f64,
) -> Result<f64, AppError> {
    validate_parameters(groups, degrees_of_freedom)?;
    if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
        return Err(AppError::InvalidParam("studentized-range probability must be in [0, 1]".into()));
    }
    if probability == 0.0 {
        return Ok(0.0);
    }
    if probability == 1.0 {
        return Ok(f64::INFINITY);
    }
    let mut lower = 0.0;
    let mut upper = 4.0;
    while cdf(upper, groups, degrees_of_freedom)? < probability {
        upper *= 2.0;
        if upper > 1e6 {
            return Err(AppError::Stats("studentized-range quantile did not converge".into()));
        }
    }
    for _ in 0..48 {
        let middle = (lower + upper) / 2.0;
        if cdf(middle, groups, degrees_of_freedom)? < probability {
            lower = middle;
        } else {
            upper = middle;
        }
    }
    Ok((lower + upper) / 2.0)
}

fn validate_parameters(groups: usize, degrees_of_freedom: f64) -> Result<(), AppError> {
    if groups < 2 || !degrees_of_freedom.is_finite() || degrees_of_freedom <= 0.0 {
        return Err(AppError::InvalidParam(
            "studentized range requires at least two groups and positive finite degrees of freedom".into(),
        ));
    }
    Ok(())
}

fn normal_range_cdf(value: f64, groups: usize) -> f64 {
    let (nodes, weights) = gauss_legendre(NORMAL_ORDER);
    let integral = nodes.iter().zip(weights).map(|(node, weight)| {
        let x = node * 9.0;
        let interval = (standard_normal_cdf(x + value) - standard_normal_cdf(x)).max(0.0);
        weight * standard_normal_pdf(x) * interval.powi((groups - 1) as i32)
    }).sum::<f64>() * 9.0;
    (groups as f64 * integral).clamp(0.0, 1.0)
}

fn standard_normal_cdf(value: f64) -> f64 {
    0.5 * (1.0 + erf(value / 2.0_f64.sqrt()))
}

fn standard_normal_pdf(value: f64) -> f64 {
    (-0.5 * value * value).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

fn gauss_legendre(order: usize) -> (Vec<f64>, Vec<f64>) {
    let mut nodes = vec![0.0; order];
    let mut weights = vec![0.0; order];
    for index in 0..order.div_ceil(2) {
        let mut root = (std::f64::consts::PI * (index as f64 + 0.75)
            / (order as f64 + 0.5)).cos();
        let derivative = loop {
            let (value, derivative) = legendre(order, root);
            let next = root - value / derivative;
            if (next - root).abs() < 1e-15 {
                root = next;
                break derivative;
            }
            root = next;
        };
        let weight = 2.0 / ((1.0 - root * root) * derivative * derivative);
        nodes[index] = -root;
        nodes[order - 1 - index] = root;
        weights[index] = weight;
        weights[order - 1 - index] = weight;
    }
    (nodes, weights)
}

fn legendre(order: usize, value: f64) -> (f64, f64) {
    let mut previous = 1.0;
    let mut current = value;
    for degree in 2..=order {
        let next = ((2 * degree - 1) as f64 * value * current
            - (degree - 1) as f64 * previous) / degree as f64;
        previous = current;
        current = next;
    }
    let derivative = order as f64 * (value * current - previous) / (value * value - 1.0);
    (current, derivative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use statrs::distribution::{ContinuousCDF, StudentsT};

    #[test]
    fn two_group_range_matches_absolute_student_t_identity() {
        let degrees_of_freedom = 11.0;
        let q = 3.25;
        let distribution = StudentsT::new(0.0, 1.0, degrees_of_freedom).expect("t");
        let expected = 2.0 * distribution.cdf(q / 2.0_f64.sqrt()) - 1.0;
        let actual = cdf(q, 2, degrees_of_freedom).expect("range CDF");
        assert!((actual - expected).abs() < 2e-5);

        let recovered = inverse_cdf(expected, 2, degrees_of_freedom).expect("range quantile");
        assert!((recovered - q).abs() < 2e-4, "recovered={recovered}");
    }
}