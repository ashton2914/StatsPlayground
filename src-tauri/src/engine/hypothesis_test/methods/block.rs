use crate::engine::hypothesis_test::normalize::CompleteBlocks;
use crate::error::AppError;
use statrs::distribution::{ChiSquared, ContinuousCDF, FisherSnedecor};

use super::rank::average_ranks;

#[derive(Debug, Clone, PartialEq)]
pub struct BlockTestResult {
    pub statistic: f64,
    pub numerator_degrees_of_freedom: f64,
    pub denominator_degrees_of_freedom: Option<f64>,
    pub p_value: f64,
    pub effect_size: f64,
    pub condition_sum_of_squares: Option<f64>,
    pub block_sum_of_squares: Option<f64>,
    pub residual_sum_of_squares: Option<f64>,
}

pub fn randomized_block_anova(study: &CompleteBlocks) -> Result<BlockTestResult, AppError> {
    validate_complete_blocks(study)?;
    let block_count = study.blocks.len();
    let condition_count = study.conditions.len();
    let observation_count = block_count * condition_count;
    let grand_mean = study.blocks.iter().flatten().sum::<f64>() / observation_count as f64;
    let condition_means = (0..condition_count).map(|condition| {
        study.blocks.iter().map(|block| block[condition]).sum::<f64>() / block_count as f64
    }).collect::<Vec<_>>();
    let block_means = study.blocks.iter().map(|block| {
        block.iter().sum::<f64>() / condition_count as f64
    }).collect::<Vec<_>>();
    let condition_ss = block_count as f64 * condition_means.iter()
        .map(|mean| (mean - grand_mean).powi(2)).sum::<f64>();
    let block_ss = condition_count as f64 * block_means.iter()
        .map(|mean| (mean - grand_mean).powi(2)).sum::<f64>();
    let total_ss = study.blocks.iter().flatten()
        .map(|value| (value - grand_mean).powi(2)).sum::<f64>();
    let residual_ss = (total_ss - condition_ss - block_ss).max(0.0);
    let condition_df = (condition_count - 1) as f64;
    let residual_df = ((condition_count - 1) * (block_count - 1)) as f64;
    let residual_mean_square = residual_ss / residual_df;
    if residual_mean_square <= 0.0 {
        return Err(AppError::Stats("randomized-block residual variance is not estimable".into()));
    }
    let statistic = (condition_ss / condition_df) / residual_mean_square;
    let distribution = FisherSnedecor::new(condition_df, residual_df)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    Ok(BlockTestResult {
        statistic,
        numerator_degrees_of_freedom: condition_df,
        denominator_degrees_of_freedom: Some(residual_df),
        p_value: distribution.sf(statistic),
        effect_size: condition_ss / (condition_ss + block_ss + residual_ss),
        condition_sum_of_squares: Some(condition_ss),
        block_sum_of_squares: Some(block_ss),
        residual_sum_of_squares: Some(residual_ss),
    })
}

pub fn friedman(study: &CompleteBlocks) -> Result<BlockTestResult, AppError> {
    validate_complete_blocks(study)?;
    let block_count = study.blocks.len();
    let condition_count = study.conditions.len();
    let mut rank_sums = vec![0.0; condition_count];
    let mut tie_sum = 0_usize;
    for block in &study.blocks {
        let mut order = (0..condition_count).collect::<Vec<_>>();
        order.sort_by(|left, right| block[*left].total_cmp(&block[*right]));
        let sorted = order.iter().map(|index| block[*index]).collect::<Vec<_>>();
        let (ranks, ties) = average_ranks(&sorted);
        tie_sum += ties.iter().map(|size| size.pow(3) - size).sum::<usize>();
        for (position, condition) in order.into_iter().enumerate() {
            rank_sums[condition] += ranks[position];
        }
    }
    let uncorrected = 12.0 / (block_count * condition_count * (condition_count + 1)) as f64
        * rank_sums.iter().map(|sum| sum.powi(2)).sum::<f64>()
        - 3.0 * block_count as f64 * (condition_count + 1) as f64;
    let tie_correction = 1.0 - tie_sum as f64
        / (block_count * condition_count * (condition_count.pow(2) - 1)) as f64;
    if tie_correction <= 0.0 {
        return Err(AppError::Stats("Friedman test is undefined when every block is tied".into()));
    }
    let statistic = uncorrected / tie_correction;
    let degrees_of_freedom = (condition_count - 1) as f64;
    let distribution = ChiSquared::new(degrees_of_freedom)
        .map_err(|error| AppError::Stats(error.to_string()))?;
    Ok(BlockTestResult {
        statistic,
        numerator_degrees_of_freedom: degrees_of_freedom,
        denominator_degrees_of_freedom: None,
        p_value: distribution.sf(statistic),
        effect_size: statistic / (block_count as f64 * degrees_of_freedom),
        condition_sum_of_squares: None,
        block_sum_of_squares: None,
        residual_sum_of_squares: None,
    })
}

fn validate_complete_blocks(study: &CompleteBlocks) -> Result<(), AppError> {
    if study.conditions.len() < 2 || study.blocks.len() < 2 {
        return Err(AppError::Stats(
            "complete-block tests require at least two conditions and two blocks".into(),
        ));
    }
    if study.blocks.iter().any(|block| {
        block.len() != study.conditions.len() || block.iter().any(|value| !value.is_finite())
    }) {
        return Err(AppError::Stats("complete-block matrix must be rectangular and finite".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn randomized_block_anova_partitions_additive_sums_of_squares() {
        let study = fixture();
        let result = randomized_block_anova(&study).expect("block ANOVA");
        assert!((result.condition_sum_of_squares.unwrap() - 37.555_555_555_555_56).abs() < 1e-12);
        assert!((result.block_sum_of_squares.unwrap() - 13.555_555_555_555_554).abs() < 1e-12);
        assert!((result.residual_sum_of_squares.unwrap() - 0.444_444_444_444_446_4).abs() < 1e-12);
        assert!((result.statistic - 169.0).abs() < 1e-10);
        assert_eq!(result.numerator_degrees_of_freedom, 2.0);
        assert_eq!(result.denominator_degrees_of_freedom, Some(4.0));
    }

    #[test]
    fn friedman_applies_within_block_tie_correction_and_reports_kendalls_w() {
        let study = CompleteBlocks {
            conditions: vec!["A".into(), "B".into(), "C".into()],
            subjects: vec!["1".into(), "2".into(), "3".into(), "4".into()],
            blocks: vec![
                vec![1.0, 2.0, 3.0],
                vec![1.0, 1.0, 3.0],
                vec![2.0, 3.0, 4.0],
                vec![1.0, 2.0, 2.0],
            ],
        };
        let result = friedman(&study).expect("Friedman");
        assert!((result.statistic - 7.0).abs() < 1e-12);
        assert!((result.effect_size - 0.875).abs() < 1e-12);
        assert!(result.p_value > 0.0 && result.p_value < 0.05);
    }

    fn fixture() -> CompleteBlocks {
        CompleteBlocks {
            conditions: vec!["A".into(), "B".into(), "C".into()],
            subjects: vec!["1".into(), "2".into(), "3".into()],
            blocks: vec![
                vec![8.0, 10.0, 13.0],
                vec![9.0, 12.0, 14.0],
                vec![11.0, 13.0, 16.0],
            ],
        }
    }
}