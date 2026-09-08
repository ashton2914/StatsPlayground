pub const MAX_EXACT_STATES: u64 = 2_000_000;

pub fn choose_capped(total: usize, selected: usize, cap: u64) -> Option<u64> {
    if selected > total {
        return Some(0);
    }
    let selected = selected.min(total - selected);
    let mut result = 1_u64;
    for index in 1..=selected {
        result = result.checked_mul((total - selected + index) as u64)?;
        result /= index as u64;
        if result > cap {
            return None;
        }
    }
    Some(result)
}

pub fn powers_of_two_capped(exponent: usize, cap: u64) -> Option<u64> {
    let shift = u32::try_from(exponent).ok()?;
    let value = 1_u64.checked_shl(shift)?;
    (value <= cap).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_state_estimators_stop_at_the_public_budget() {
        assert_eq!(choose_capped(4, 2, MAX_EXACT_STATES), Some(6));
        assert_eq!(powers_of_two_capped(20, MAX_EXACT_STATES), Some(1_048_576));
        assert_eq!(powers_of_two_capped(21, MAX_EXACT_STATES), None);
    }
}