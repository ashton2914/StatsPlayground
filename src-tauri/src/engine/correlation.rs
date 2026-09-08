#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatisticalMethod {
    Pearson,
    Spearman,
    Kendall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrelationFailure {
    InsufficientData,
    ZeroVariance,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CorrelationResult {
    pub coefficient: Option<f64>,
    pub sample_count: u64,
    pub failure: Option<CorrelationFailure>,
}

pub fn correlate(
    left: &[Option<f64>],
    right: &[Option<f64>],
    method: StatisticalMethod,
) -> CorrelationResult {
    assert!(
        left.len() == right.len(),
        "left and right columns must have equal length: left={}, right={}",
        left.len(),
        right.len()
    );

    let pairs = pairwise_finite(left, right);
    let sample_count = pairs.len() as u64;

    let outcome = match method {
        StatisticalMethod::Pearson => pearson_from_pairs(&pairs),
        StatisticalMethod::Spearman => spearman_from_pairs(&pairs),
        StatisticalMethod::Kendall => kendall_tau_b_from_pairs(&pairs),
    };

    match outcome {
        Ok(coefficient) => CorrelationResult {
            coefficient: Some(coefficient),
            sample_count,
            failure: None,
        },
        Err(failure) => CorrelationResult {
            coefficient: None,
            sample_count,
            failure: Some(failure),
        },
    }
}

fn pairwise_finite(left: &[Option<f64>], right: &[Option<f64>]) -> Vec<(f64, f64)> {
    left.iter()
        .zip(right.iter())
        .filter_map(|(lx, ry)| match (lx, ry) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
                Some((normalize_signed_zero(*x), normalize_signed_zero(*y)))
            }
            _ => None,
        })
        .collect()
}

fn normalize_signed_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn pearson_from_pairs(pairs: &[(f64, f64)]) -> Result<f64, CorrelationFailure> {
    if pairs.len() < 2 {
        return Err(CorrelationFailure::InsufficientData);
    }

    let mut n = 0.0_f64;
    let mut mean_x = 0.0_f64;
    let mut mean_y = 0.0_f64;
    let mut sxx = 0.0_f64;
    let mut syy = 0.0_f64;
    let mut sxy = 0.0_f64;

    for &(x, y) in pairs {
        n += 1.0;

        let dx = x - mean_x;
        mean_x += dx / n;

        let dy = y - mean_y;
        mean_y += dy / n;

        sxx += dx * (x - mean_x);
        syy += dy * (y - mean_y);
        sxy += dx * (y - mean_y);
    }

    if sxx == 0.0 || syy == 0.0 {
        return Err(CorrelationFailure::ZeroVariance);
    }

    let denominator = (sxx * syy).sqrt();
    if denominator == 0.0 {
        return Err(CorrelationFailure::ZeroVariance);
    }

    let coefficient = sxy / denominator;
    if !coefficient.is_finite() {
        return Err(CorrelationFailure::ZeroVariance);
    }

    Ok(coefficient.clamp(-1.0, 1.0))
}

fn spearman_from_pairs(pairs: &[(f64, f64)]) -> Result<f64, CorrelationFailure> {
    if pairs.len() < 2 {
        return Err(CorrelationFailure::InsufficientData);
    }

    let xs: Vec<f64> = pairs.iter().map(|(x, _)| *x).collect();
    let ys: Vec<f64> = pairs.iter().map(|(_, y)| *y).collect();
    let rank_x = average_ranks(&xs);
    let rank_y = average_ranks(&ys);

    let rank_pairs: Vec<(f64, f64)> = rank_x.into_iter().zip(rank_y).collect();
    pearson_from_pairs(&rank_pairs)
}

fn average_ranks(values: &[f64]) -> Vec<f64> {
    let mut indexed: Vec<(f64, usize)> = values
        .iter()
        .copied()
        .enumerate()
        .map(|(idx, value)| (value, idx))
        .collect();
    indexed.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut ranks = vec![0.0_f64; values.len()];
    let mut i = 0_usize;
    while i < indexed.len() {
        let mut j = i + 1;
        while j < indexed.len() && indexed[j].0.total_cmp(&indexed[i].0).is_eq() {
            j += 1;
        }

        let start_rank = (i + 1) as f64;
        let end_rank = j as f64;
        let avg_rank = (start_rank + end_rank) / 2.0;

        for &(_, original_index) in &indexed[i..j] {
            ranks[original_index] = avg_rank;
        }

        i = j;
    }

    ranks
}

fn kendall_tau_b_from_pairs(pairs: &[(f64, f64)]) -> Result<f64, CorrelationFailure> {
    let n = pairs.len();
    if n < 2 {
        return Err(CorrelationFailure::InsufficientData);
    }

    let mut sorted_pairs: Vec<(f64, f64)> = pairs.to_vec();
    sorted_pairs.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));

    let n_u128 = n as u128;
    let n0 = choose2(n_u128);

    let ties_x = tie_pairs_count_by(&sorted_pairs, |p| p.0);
    let ties_xy = tie_pairs_count_by_pair(&sorted_pairs);

    let mut y_values: Vec<f64> = sorted_pairs.iter().map(|(_, y)| *y).collect();
    y_values.sort_by(|a, b| a.total_cmp(b));
    let ties_y = tie_pairs_count_by_values(&y_values);

    let mut y_for_inversions: Vec<f64> = sorted_pairs.iter().map(|(_, y)| *y).collect();
    let discordant = count_inversions(&mut y_for_inversions);

    let concordant = n0
        .saturating_sub(ties_x)
        .saturating_sub(ties_y)
        .saturating_add(ties_xy)
        .saturating_sub(discordant);

    let numerator = concordant as f64 - discordant as f64;
    let denominator = (((n0 - ties_x) as f64) * ((n0 - ties_y) as f64)).sqrt();
    if denominator == 0.0 {
        return Err(CorrelationFailure::ZeroVariance);
    }

    let tau = numerator / denominator;
    if !tau.is_finite() {
        return Err(CorrelationFailure::ZeroVariance);
    }

    Ok(tau.clamp(-1.0, 1.0))
}

fn tie_pairs_count_by<F>(pairs: &[(f64, f64)], key: F) -> u128
where
    F: Fn(&(f64, f64)) -> f64,
{
    let mut count = 0_u128;
    let mut i = 0_usize;
    while i < pairs.len() {
        let mut j = i + 1;
        while j < pairs.len() && key(&pairs[j]).total_cmp(&key(&pairs[i])).is_eq() {
            j += 1;
        }
        count += choose2((j - i) as u128);
        i = j;
    }
    count
}

fn tie_pairs_count_by_pair(pairs: &[(f64, f64)]) -> u128 {
    let mut count = 0_u128;
    let mut i = 0_usize;
    while i < pairs.len() {
        let mut j = i + 1;
        while j < pairs.len()
            && pairs[j].0.total_cmp(&pairs[i].0).is_eq()
            && pairs[j].1.total_cmp(&pairs[i].1).is_eq()
        {
            j += 1;
        }
        count += choose2((j - i) as u128);
        i = j;
    }
    count
}

fn tie_pairs_count_by_values(values: &[f64]) -> u128 {
    let mut count = 0_u128;
    let mut i = 0_usize;
    while i < values.len() {
        let mut j = i + 1;
        while j < values.len() && values[j].total_cmp(&values[i]).is_eq() {
            j += 1;
        }
        count += choose2((j - i) as u128);
        i = j;
    }
    count
}

fn choose2(n: u128) -> u128 {
    n.saturating_mul(n.saturating_sub(1)) / 2
}

fn count_inversions(values: &mut [f64]) -> u128 {
    let mut scratch = vec![0.0_f64; values.len()];
    merge_count(values, &mut scratch)
}

fn merge_count(values: &mut [f64], scratch: &mut [f64]) -> u128 {
    let len = values.len();
    if len <= 1 {
        return 0;
    }

    let mid = len / 2;
    let (left, right) = values.split_at_mut(mid);
    let (scratch_left, scratch_right) = scratch.split_at_mut(mid);

    let mut inversions = merge_count(left, scratch_left) + merge_count(right, scratch_right);

    scratch[..len].copy_from_slice(values);

    let mut i = 0_usize;
    let mut j = mid;
    let mut k = 0_usize;
    while i < mid && j < len {
        if scratch[i].total_cmp(&scratch[j]).is_le() {
            values[k] = scratch[i];
            i += 1;
        } else {
            values[k] = scratch[j];
            inversions += (mid - i) as u128;
            j += 1;
        }
        k += 1;
    }

    while i < mid {
        values[k] = scratch[i];
        i += 1;
        k += 1;
    }

    while j < len {
        values[k] = scratch[j];
        j += 1;
        k += 1;
    }

    inversions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
        if let Some(message) = payload.downcast_ref::<String>() {
            return message.clone();
        }
        if let Some(message) = payload.downcast_ref::<&'static str>() {
            return (*message).to_string();
        }
        "<non-string panic payload>".to_string()
    }

    #[test]
    fn correlate_panics_on_mismatched_lengths_with_clear_message() {
        let panic = std::panic::catch_unwind(|| {
            let _ = correlate(
                &[Some(1.0)],
                &[Some(1.0), Some(2.0)],
                StatisticalMethod::Pearson,
            );
        })
        .expect_err("mismatched inputs must panic");

        assert!(
            panic_message(panic).contains("left and right columns must have equal length"),
            "panic message should explain the equal-length API contract"
        );
    }

    #[test]
    fn pearson_uses_pairwise_finite_rows_and_is_stable_at_large_offsets() {
        let left = [
            Some(1.0e12 + 1.0),
            None,
            Some(1.0e12 + 2.0),
            Some(f64::INFINITY),
            Some(1.0e12 + 3.0),
        ];
        let right = [Some(3.0), Some(99.0), Some(5.0), Some(7.0), Some(7.0)];
        let result = correlate(&left, &right, StatisticalMethod::Pearson);
        assert_eq!(result.sample_count, 3);
        assert!((result.coefficient.unwrap() - 1.0).abs() < 1e-12);
        assert_eq!(result.failure, None);
    }

    #[test]
    fn pearson_distinguishes_insufficient_data_from_zero_variance() {
        let insufficient = correlate(&[Some(1.0)], &[Some(2.0)], StatisticalMethod::Pearson);
        assert_eq!(insufficient.coefficient, None);
        assert_eq!(
            insufficient.failure,
            Some(CorrelationFailure::InsufficientData)
        );

        let constant = correlate(
            &[Some(4.0), Some(4.0)],
            &[Some(1.0), Some(2.0)],
            StatisticalMethod::Pearson,
        );
        assert_eq!(constant.coefficient, None);
        assert_eq!(constant.failure, Some(CorrelationFailure::ZeroVariance));
    }

    #[test]
    fn spearman_uses_average_ties_after_pairwise_deletion() {
        let left = [Some(10.0), Some(10.0), Some(20.0), None];
        let right = [Some(1.0), Some(2.0), Some(3.0), Some(100.0)];
        let result = correlate(&left, &right, StatisticalMethod::Spearman);
        assert_eq!(result.sample_count, 3);
        assert!((result.coefficient.unwrap() - 0.8660254037844387).abs() < 1e-12);
    }

    #[test]
    fn spearman_treats_negative_and_positive_zero_as_same_tie() {
        let left = [Some(-0.0), Some(0.0), Some(1.0), Some(2.0)];
        let right = [Some(1.0), Some(2.0), Some(3.0), Some(4.0)];
        let result = correlate(&left, &right, StatisticalMethod::Spearman);
        assert_eq!(result.sample_count, 4);
        assert!((result.coefficient.unwrap() - 0.9486832980505138).abs() < 1e-12);
    }

    #[test]
    fn kendall_tau_b_corrects_ties() {
        let left = [Some(1.0), Some(1.0), Some(2.0), Some(3.0)];
        let right = [Some(1.0), Some(2.0), Some(2.0), Some(3.0)];
        let result = correlate(&left, &right, StatisticalMethod::Kendall);
        assert_eq!(result.sample_count, 4);
        assert!((result.coefficient.unwrap() - 0.8).abs() < 1e-12);
    }

    #[test]
    fn kendall_tau_b_is_negative_one_for_reverse_order() {
        let left = [Some(1.0), Some(2.0), Some(3.0), Some(4.0)];
        let right = [Some(4.0), Some(3.0), Some(2.0), Some(1.0)];
        let result = correlate(&left, &right, StatisticalMethod::Kendall);
        assert_eq!(result.sample_count, 4);
        assert!((result.coefficient.unwrap() + 1.0).abs() < 1e-12);
    }

    #[test]
    fn kendall_tau_b_accounts_for_joint_ties() {
        let left = [Some(1.0), Some(1.0), Some(2.0), Some(2.0)];
        let right = [Some(1.0), Some(1.0), Some(2.0), Some(2.0)];
        let result = correlate(&left, &right, StatisticalMethod::Kendall);
        assert_eq!(result.sample_count, 4);
        assert!((result.coefficient.unwrap() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn kendall_treats_negative_and_positive_zero_as_same_tie() {
        let left = [Some(-0.0), Some(0.0), Some(1.0), Some(2.0)];
        let right = [Some(1.0), Some(2.0), Some(3.0), Some(4.0)];
        let result = correlate(&left, &right, StatisticalMethod::Kendall);
        assert_eq!(result.sample_count, 4);
        assert!((result.coefficient.unwrap() - 0.9128709291752769).abs() < 1e-12);
    }

    #[test]
    fn methods_are_symmetric() {
        let left = [Some(1.0), Some(2.0), Some(4.0), Some(8.0)];
        let right = [Some(5.0), Some(7.0), Some(11.0), Some(13.0)];

        for method in [
            StatisticalMethod::Pearson,
            StatisticalMethod::Spearman,
            StatisticalMethod::Kendall,
        ] {
            let lr = correlate(&left, &right, method);
            let rl = correlate(&right, &left, method);
            assert_eq!(lr.sample_count, rl.sample_count);
            assert_eq!(lr.failure, rl.failure);
            assert!((lr.coefficient.unwrap() - rl.coefficient.unwrap()).abs() < 1e-12);
        }
    }

    #[test]
    fn diagonal_is_one_when_variance_exists() {
        let values = [Some(1.0), Some(2.0), Some(4.0), Some(7.0)];
        for method in [
            StatisticalMethod::Pearson,
            StatisticalMethod::Spearman,
            StatisticalMethod::Kendall,
        ] {
            let result = correlate(&values, &values, method);
            assert_eq!(result.failure, None);
            assert!((result.coefficient.unwrap() - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn pairwise_filtering_reports_insufficient_data_when_no_finite_pairs() {
        let left = [Some(f64::INFINITY), None, Some(f64::NAN)];
        let right = [Some(1.0), Some(2.0), Some(3.0)];

        let result = correlate(&left, &right, StatisticalMethod::Pearson);
        assert_eq!(result.sample_count, 0);
        assert_eq!(result.coefficient, None);
        assert_eq!(result.failure, Some(CorrelationFailure::InsufficientData));
    }

    #[test]
    fn methods_report_unavailable_reason_for_zero_variance() {
        let left = [Some(4.0), Some(4.0), Some(4.0)];
        let right = [Some(1.0), Some(2.0), Some(3.0)];

        for method in [
            StatisticalMethod::Pearson,
            StatisticalMethod::Spearman,
            StatisticalMethod::Kendall,
        ] {
            let result = correlate(&left, &right, method);
            assert_eq!(result.coefficient, None);
            assert_eq!(result.failure, Some(CorrelationFailure::ZeroVariance));
        }
    }
}
