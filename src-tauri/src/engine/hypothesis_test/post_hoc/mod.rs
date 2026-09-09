pub mod parametric;
pub mod rank;
mod studentized_range;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq)]
pub struct PostHocComparison {
    pub left: String,
    pub right: String,
    pub estimate: f64,
    pub standard_error: Option<f64>,
    pub statistic: f64,
    pub degrees_of_freedom: Option<f64>,
    pub raw_p_value: f64,
    pub adjusted_p_value: f64,
    pub lower: Option<f64>,
    pub upper: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PostHocResult {
    pub family: String,
    pub comparisons: Vec<PostHocComparison>,
    pub compact_letters: Vec<(String, String)>,
}

pub fn holm_adjust(p_values: &[f64]) -> Result<Vec<f64>, AppError> {
    if p_values.iter().any(|value| !value.is_finite() || !(0.0..=1.0).contains(value)) {
        return Err(AppError::Stats("Holm adjustment requires finite probabilities".into()));
    }
    let mut order = p_values.iter().copied().enumerate().collect::<Vec<_>>();
    order.sort_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)));
    let mut adjusted = vec![0.0; p_values.len()];
    let mut previous: f64 = 0.0;
    for (rank, (original, probability)) in order.into_iter().enumerate() {
        let candidate = ((p_values.len() - rank) as f64 * probability).min(1.0);
        previous = previous.max(candidate);
        adjusted[original] = previous;
    }
    Ok(adjusted)
}

pub fn compact_letters(
    conditions: &[String],
    comparisons: &[PostHocComparison],
    alpha: f64,
) -> Result<Vec<(String, String)>, AppError> {
    if conditions.is_empty() || !alpha.is_finite() || !(0.0..1.0).contains(&alpha) {
        return Err(AppError::InvalidParam("compact letters require conditions and alpha in (0, 1)".into()));
    }
    let condition_index = conditions.iter().enumerate()
        .map(|(index, condition)| (condition.as_str(), index))
        .collect::<std::collections::HashMap<_, _>>();
    let mut significant = Vec::new();
    for comparison in comparisons {
        let left = *condition_index.get(comparison.left.as_str())
            .ok_or_else(|| AppError::InvalidParam("post-hoc comparison has unknown condition".into()))?;
        let right = *condition_index.get(comparison.right.as_str())
            .ok_or_else(|| AppError::InvalidParam("post-hoc comparison has unknown condition".into()))?;
        if comparison.adjusted_p_value <= alpha {
            significant.push((left.min(right), left.max(right)));
        }
    }
    significant.sort_unstable();
    let mut columns = vec![(0..conditions.len()).collect::<Vec<_>>()];
    for (left, right) in significant {
        let mut next = Vec::new();
        for column in columns {
            if column.contains(&left) && column.contains(&right) {
                next.push(column.iter().copied().filter(|index| *index != left).collect());
                next.push(column.iter().copied().filter(|index| *index != right).collect());
            } else {
                next.push(column);
            }
        }
        columns = absorb_columns(next);
    }
    columns.sort_by(|left, right| left.first().cmp(&right.first()).then(left.cmp(right)));
    Ok(conditions.iter().enumerate().map(|(condition_index, condition)| {
        let label = columns.iter().enumerate()
            .filter(|(_, column)| column.contains(&condition_index))
            .map(|(index, _)| letter_label(index))
            .collect::<String>();
        (condition.clone(), label)
    }).collect())
}

fn absorb_columns(mut columns: Vec<Vec<usize>>) -> Vec<Vec<usize>> {
    columns.retain(|column| !column.is_empty());
    columns.sort();
    columns.dedup();
    let snapshot = columns.clone();
    columns.into_iter().filter(|candidate| {
        !snapshot.iter().any(|other| {
            other.len() > candidate.len() && candidate.iter().all(|item| other.contains(item))
        })
    }).collect()
}

fn letter_label(mut index: usize) -> String {
    let mut reversed = String::new();
    loop {
        reversed.push((b'a' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    reversed.chars().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holm_is_stable_monotone_and_returns_original_order() {
        let adjusted = holm_adjust(&[0.04, 0.01, 0.01, 0.20]).expect("Holm");
        assert_eq!(adjusted, vec![0.08, 0.04, 0.04, 0.20]);
    }

    #[test]
    fn compact_letters_encode_every_pairwise_decision_in_condition_order() {
        let conditions = vec!["A".into(), "B".into(), "C".into()];
        let comparisons = vec![
            comparison("A", "B", 0.20),
            comparison("A", "C", 0.01),
            comparison("B", "C", 0.20),
        ];
        let letters = compact_letters(&conditions, &comparisons, 0.05).expect("letters");
        assert_eq!(letters, vec![
            ("A".into(), "a".into()),
            ("B".into(), "ab".into()),
            ("C".into(), "b".into()),
        ]);
    }

    fn comparison(left: &str, right: &str, adjusted_p_value: f64) -> PostHocComparison {
        PostHocComparison {
            left: left.into(),
            right: right.into(),
            estimate: 0.0,
            standard_error: None,
            statistic: 0.0,
            degrees_of_freedom: None,
            raw_p_value: adjusted_p_value,
            adjusted_p_value,
            lower: None,
            upper: None,
        }
    }
}