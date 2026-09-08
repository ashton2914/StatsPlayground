use crate::engine::distribution_executor::PreparedObservationV1;
use crate::error::AppError;
use crate::models::distribution::{
    CapabilityTypedValueV1, ContinuousDistributionIdV1, DistributionCoordinateV1,
    DistributionFitConvergenceStatusV1, DistributionFitConvergenceV1, DistributionFitParameterV1,
};
use argmin::core::{
    CostFunction as ArgminCostFunction, Error as ArgminError, Executor, IterState,
    TerminationReason, TerminationStatus,
};
use argmin::solver::brent::{BrentOpt, BrentRoot};
use statrs::distribution::{Continuous, Exp, Gamma, LogNormal, Normal, Weibull};
use statrs::function::gamma::digamma;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

const AVAILABLE_STATE: &str = "available";
const UNAVAILABLE_STATE: &str = "unavailable";
const AICC_UNAVAILABLE_REASON: &str = "distribution.fit.aiccUnavailable.v1";
const OBSERVATION_VALUE_INVALID_REASON: &str = "distribution.fit.observationValueInvalid.v1";
const OBSERVATION_WEIGHT_INVALID_REASON: &str = "distribution.fit.observationWeightInvalid.v1";
const OBSERVATION_FREQUENCY_INVALID_REASON: &str =
    "distribution.fit.observationFrequencyInvalid.v1";
const EFFECTIVE_N_INVALID_REASON: &str = "distribution.fit.effectiveNInvalid.v1";
const LOG_LIKELIHOOD_INVALID_REASON: &str = "distribution.fit.logLikelihoodInvalid.v1";
const PARAMETER_INFERENCE_UNAVAILABLE_REASON: &str =
    "distribution.fit.parameterInferenceUnavailable.v1";
const PARAMETER_INFORMATION_SINGULAR_REASON: &str =
    "distribution.fit.parameterInformationSingular.v1";
const PARAMETER_Z_975: f64 = 1.959_963_984_540_054;
const POSITIVE_TRANSFORM_INVALID_REASON: &str = "distribution.fit.positiveTransformInvalid.v1";
const CURVE_WIDTH_INVALID_REASON: &str = "distribution.fit.curveWidthInvalid.v1";
const CURVE_STEP_INVALID_REASON: &str = "distribution.fit.curveStepInvalid.v1";
const CURVE_X_INVALID_REASON: &str = "distribution.fit.curveXInvalid.v1";
const PDF_NON_FINITE_REASON: &str = "distribution.fit.pdfNonFinite.v1";
const PDF_X_INVALID_REASON: &str = "distribution.fit.pdfXInvalid.v1";
const OPTIMIZER_OBJECTIVE_INVALID_REASON: &str = "distribution.fit.optimizerObjectiveInvalid.v1";
const OPTIMIZER_PARAMETERS_INVALID_REASON: &str = "distribution.fit.optimizerParametersInvalid.v1";
const OPTIMIZER_GRADIENT_NORM_INVALID_REASON: &str =
    "distribution.fit.optimizerGradientNormInvalid.v1";
const OBSERVATIONS_EMPTY_REASON: &str = "distribution.fit.observationsEmpty.v1";
const OBSERVATION_CONTRIBUTION_INVALID_REASON: &str =
    "distribution.fit.observationContributionInvalid.v1";
const ESTIMATE_DISTRIBUTION_INVALID_REASON: &str =
    "distribution.fit.estimateDistributionInvalid.v1";
const ESTIMATE_PARAMETERIZATION_INVALID_REASON: &str =
    "distribution.fit.estimateParameterizationInvalid.v1";
const ESTIMATE_PARAMETERS_INVALID_REASON: &str = "distribution.fit.estimateParametersInvalid.v1";
const CONSTANT_SAMPLE_REASON: &str = "distribution.fit.constantSample.v1";
const LOGNORMAL_DOMAIN_INVALID_REASON: &str = "distribution.fit.lognormalDomainInvalid.v1";
const EXPONENTIAL_DOMAIN_INVALID_REASON: &str = "distribution.fit.exponentialDomainInvalid.v1";
const GAMMA_DOMAIN_INVALID_REASON: &str = "distribution.fit.gammaDomainInvalid.v1";
const WEIBULL_DOMAIN_INVALID_REASON: &str = "distribution.fit.weibullDomainInvalid.v1";
const OPTIMIZER_ITERATION_LIMIT_REASON: &str = "distribution.fit.optimizerIterationLimit.v1";
const OPTIMIZER_BOUNDARY_REASON: &str = "distribution.fit.optimizerBoundary.v1";
const OPTIMIZER_FAILED_REASON: &str = "distribution.fit.optimizerFailed.v1";
const OPTIMIZER_BRACKET_INVALID_REASON: &str = "distribution.fit.optimizerBracketInvalid.v1";
const ARGMIN_BRENT_OPTIMIZER_ID: &str = "argmin.brentOptThenRoot.v1";
const ARGMIN_BRENT_OPTIMIZER_VERSION: &str = "0.11.0";
const CONTINUOUS_FIT_ITERATION_LIMIT: u64 = 500;
const CONTINUOUS_FIT_TOLERANCE: f64 = 1e-10;
const EULER_MASCHERONI: f64 = 0.577_215_664_901_532_9;

#[derive(Debug, Clone, PartialEq)]
pub struct FitObservationV1 {
    pub value: f64,
    pub frequency: f64,
    pub weight: f64,
}

impl FitObservationV1 {
    pub fn contribution(&self) -> f64 {
        self.frequency * self.weight
    }
}

impl TryFrom<&PreparedObservationV1> for FitObservationV1 {
    type Error = AppError;

    fn try_from(observation: &PreparedObservationV1) -> Result<Self, Self::Error> {
        if !observation.y.is_finite() {
            return Err(AppError::Stats(
                OBSERVATION_VALUE_INVALID_REASON.to_string(),
            ));
        }
        if !observation.weight.is_finite() || observation.weight <= 0.0 {
            return Err(AppError::Stats(
                OBSERVATION_WEIGHT_INVALID_REASON.to_string(),
            ));
        }
        if observation.frequency == 0 {
            return Err(AppError::Stats(
                OBSERVATION_FREQUENCY_INVALID_REASON.to_string(),
            ));
        }

        Ok(Self {
            value: observation.y,
            frequency: observation.frequency as f64,
            weight: observation.weight,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitMetricSetV1 {
    pub aic: CapabilityTypedValueV1,
    pub aicc: CapabilityTypedValueV1,
    pub bic: CapabilityTypedValueV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FitFailureClassificationV1 {
    Input,
    Domain,
    Optimizer,
    Objective,
    Curve,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FitFailureV1 {
    pub reason_code: String,
    pub classification: FitFailureClassificationV1,
}

impl FitFailureV1 {
    pub fn new(reason_code: impl Into<String>, classification: FitFailureClassificationV1) -> Self {
        Self {
            reason_code: reason_code.into(),
            classification,
        }
    }
}

pub fn input_failure(reason_code: &str) -> FitFailureV1 {
    FitFailureV1::new(reason_code, FitFailureClassificationV1::Input)
}

pub fn domain_failure(reason_code: &str) -> FitFailureV1 {
    FitFailureV1::new(reason_code, FitFailureClassificationV1::Domain)
}

pub fn optimizer_failure(reason_code: &str) -> FitFailureV1 {
    FitFailureV1::new(reason_code, FitFailureClassificationV1::Optimizer)
}

pub fn objective_failure(reason_code: &str) -> FitFailureV1 {
    FitFailureV1::new(reason_code, FitFailureClassificationV1::Objective)
}

pub fn curve_failure(reason_code: &str) -> FitFailureV1 {
    FitFailureV1::new(reason_code, FitFailureClassificationV1::Curve)
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitEstimateV1 {
    pub distribution_id: ContinuousDistributionIdV1,
    pub parameterization_id: &'static str,
    pub parameters: Vec<DistributionFitParameterV1>,
    pub log_likelihood: f64,
    pub convergence: DistributionFitConvergenceV1,
}

impl FitEstimateV1 {
    pub fn new(
        distribution_id: ContinuousDistributionIdV1,
        parameterization_id: &'static str,
        parameters: Vec<DistributionFitParameterV1>,
        log_likelihood: f64,
        convergence: DistributionFitConvergenceV1,
    ) -> Result<Self, FitFailureV1> {
        if !log_likelihood.is_finite() {
            return Err(FitFailureV1::new(
                LOG_LIKELIHOOD_INVALID_REASON,
                FitFailureClassificationV1::Objective,
            ));
        }

        Ok(Self {
            distribution_id,
            parameterization_id,
            parameters,
            log_likelihood,
            convergence,
        })
    }
}

pub trait FitModel {
    fn distribution_id(&self) -> ContinuousDistributionIdV1;
    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1>;
    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1>;
    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1>;
}

pub fn attach_parameter_inference(
    estimate: &mut FitEstimateV1,
    observations: &[FitObservationV1],
) {
    let values = estimate
        .parameters
        .iter()
        .filter_map(|parameter| parameter.value.value)
        .collect::<Vec<_>>();
    let total_weight = observations
        .iter()
        .map(FitObservationV1::contribution)
        .sum::<f64>();
    let standard_errors = match estimate.distribution_id {
        ContinuousDistributionIdV1::Normal | ContinuousDistributionIdV1::Lognormal
            if values.len() == 2 && total_weight.is_finite() && total_weight > 0.0 =>
        {
            Some(vec![
                values[1] / total_weight.sqrt(),
                values[1] / (2.0 * total_weight).sqrt(),
            ])
        }
        ContinuousDistributionIdV1::Exponential
            if !values.is_empty() && total_weight.is_finite() && total_weight > 0.0 =>
        {
            Some(vec![values[0] / total_weight.sqrt()])
        }
        ContinuousDistributionIdV1::Gamma if values.len() == 2 => {
            gamma_standard_errors(values[0], values[1], total_weight)
        }
        ContinuousDistributionIdV1::Weibull if values.len() == 2 => {
            weibull_standard_errors(observations, values[0], values[1])
        }
        _ => None,
    };

    for (index, parameter) in estimate.parameters.iter_mut().enumerate() {
        let Some(standard_error) = standard_errors
            .as_ref()
            .and_then(|errors| errors.get(index))
            .copied()
            .filter(|value| value.is_finite() && *value >= 0.0)
        else {
            set_parameter_inference_unavailable(parameter, PARAMETER_INFORMATION_SINGULAR_REASON);
            continue;
        };
        let Some(point) = parameter.value.value else {
            set_parameter_inference_unavailable(parameter, PARAMETER_INFERENCE_UNAVAILABLE_REASON);
            continue;
        };
        let lower = point - PARAMETER_Z_975 * standard_error;
        let upper = point + PARAMETER_Z_975 * standard_error;
        if !lower.is_finite() || !upper.is_finite() {
            set_parameter_inference_unavailable(
                parameter,
                "distribution.fit.parameterIntervalNonFinite.v1",
            );
            continue;
        }
        parameter.standard_error = available_typed_value(standard_error);
        parameter.lower_confidence = available_typed_value(lower);
        parameter.upper_confidence = available_typed_value(upper);
    }
}

fn available_typed_value(value: f64) -> CapabilityTypedValueV1 {
    CapabilityTypedValueV1 {
        state: AVAILABLE_STATE.to_string(),
        value: Some(value),
        reason_code: None,
    }
}

fn set_parameter_inference_unavailable(
    parameter: &mut DistributionFitParameterV1,
    reason: &str,
) {
    let unavailable = unavailable_metric(reason);
    parameter.standard_error = unavailable.clone();
    parameter.lower_confidence = unavailable.clone();
    parameter.upper_confidence = unavailable;
}

fn trigamma(mut value: f64) -> Option<f64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let mut result = 0.0;
    while value < 8.0 {
        result += 1.0 / (value * value);
        value += 1.0;
    }
    let inverse = value.recip();
    let inverse2 = inverse * inverse;
    result += inverse + inverse2 / 2.0 + inverse2 * inverse / 6.0
        - inverse2 * inverse2 * inverse / 30.0
        + inverse2.powi(3) * inverse / 42.0;
    result.is_finite().then_some(result)
}

fn gamma_standard_errors(shape: f64, scale: f64, total_weight: f64) -> Option<Vec<f64>> {
    if !shape.is_finite() || shape <= 0.0 || !scale.is_finite() || scale <= 0.0
        || !total_weight.is_finite() || total_weight <= 0.0
    {
        return None;
    }
    let information_00 = total_weight * trigamma(shape)?;
    let information_01 = total_weight / scale;
    let information_11 = total_weight * shape / (scale * scale);
    let determinant = information_00 * information_11 - information_01 * information_01;
    if !determinant.is_finite() || determinant <= 0.0 {
        return None;
    }
    let variance_shape = information_11 / determinant;
    let variance_scale = information_00 / determinant;
    if variance_shape < 0.0 || variance_scale < 0.0 {
        return None;
    }
    Some(vec![variance_shape.sqrt(), variance_scale.sqrt()])
}

fn weibull_standard_errors(
    observations: &[FitObservationV1],
    shape: f64,
    scale: f64,
) -> Option<Vec<f64>> {
    if shape <= 0.0 || scale <= 0.0 || !shape.is_finite() || !scale.is_finite() {
        return None;
    }
    let canonical_center = |value: f64| (value * 1e8).round() / 1e8;
    let center = [canonical_center(shape.ln()), canonical_center(scale.ln())];
    let steps = center.map(|value| f64::EPSILON.cbrt() * value.abs().max(1.0));
    let mut grouped = BTreeMap::<u64, (f64, f64)>::new();
    for observation in observations {
        let entry = grouped
            .entry(observation.value.to_bits())
            .or_insert((observation.value, 0.0));
        entry.1 += observation.contribution();
    }
    let grouped = grouped.into_values().collect::<Vec<_>>();
    let objective = |parameters: [f64; 2]| -> Option<f64> {
        let candidate_shape = parameters[0].exp();
        let candidate_scale = parameters[1].exp();
        let distribution = Weibull::new(candidate_shape, candidate_scale).ok()?;
        let log_likelihood = grouped
            .iter()
            .map(|(value, contribution)| contribution * distribution.ln_pdf(*value))
            .sum::<f64>();
        log_likelihood.is_finite().then_some(-log_likelihood)
    };
    let center_value = objective(center)?;
    let mut hessian = [[0.0; 2]; 2];
    for index in 0..2 {
        let mut plus = center;
        let mut minus = center;
        plus[index] += steps[index];
        minus[index] -= steps[index];
        hessian[index][index] =
            (objective(plus)? - 2.0 * center_value + objective(minus)?)
                / steps[index].powi(2);
    }
    let mut plus_plus = center;
    let mut plus_minus = center;
    let mut minus_plus = center;
    let mut minus_minus = center;
    plus_plus[0] += steps[0]; plus_plus[1] += steps[1];
    plus_minus[0] += steps[0]; plus_minus[1] -= steps[1];
    minus_plus[0] -= steps[0]; minus_plus[1] += steps[1];
    minus_minus[0] -= steps[0]; minus_minus[1] -= steps[1];
    let cross = (objective(plus_plus)? - objective(plus_minus)?
        - objective(minus_plus)? + objective(minus_minus)?)
        / (4.0 * steps[0] * steps[1]);
    hessian[0][1] = cross;
    hessian[1][0] = cross;
    let determinant = hessian[0][0] * hessian[1][1] - cross * cross;
    if !determinant.is_finite() || determinant <= 0.0
        || hessian[0][0] <= 0.0 || hessian[1][1] <= 0.0
    {
        return None;
    }
    let transformed_variance_shape = hessian[1][1] / determinant;
    let transformed_variance_scale = hessian[0][0] / determinant;
    Some(vec![
        shape * transformed_variance_shape.sqrt(),
        scale * transformed_variance_scale.sqrt(),
    ])
}

#[derive(Debug, Clone)]
pub struct FitModelRegistrationV1 {
    pub distribution_id: ContinuousDistributionIdV1,
    pub estimated_parameter_count: usize,
    pub method_id: &'static str,
    pub method_version: &'static str,
    pub parameterization_id: &'static str,
    pub initialization_strategy_id: &'static str,
    pub optimizer_id: &'static str,
    pub optimizer_version: &'static str,
    pub convergence_tolerance: f64,
    pub iteration_limit: u64,
    factory: fn() -> Box<dyn FitModel>,
}

impl FitModelRegistrationV1 {
    pub fn model(&self) -> Box<dyn FitModel> {
        (self.factory)()
    }
}

fn normal_model() -> Box<dyn FitModel> {
    Box::new(NormalFitV1)
}

fn lognormal_model() -> Box<dyn FitModel> {
    Box::new(LognormalFitV1)
}

fn exponential_model() -> Box<dyn FitModel> {
    Box::new(ExponentialFitV1)
}

fn gamma_model() -> Box<dyn FitModel> {
    Box::new(GammaFitV1)
}

fn weibull_model() -> Box<dyn FitModel> {
    Box::new(WeibullFitV1)
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NormalFitV1;

impl NormalFitV1 {
    pub const METHOD_ID: &'static str = "fit.normal.mle.v1";
    pub const PARAMETERIZATION_ID: &'static str = "normal.locationScale.v1";
}

impl FitModel for NormalFitV1 {
    fn distribution_id(&self) -> ContinuousDistributionIdV1 {
        ContinuousDistributionIdV1::Normal
    }

    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
        validate_observations(observations)
    }

    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> {
        self.validate_domain(observations)?;

        let location = weighted_mean(observations)?;
        let scale = weighted_scale(observations, location)?;
        let distribution =
            Normal::new(location, scale).map_err(|_| domain_failure(CONSTANT_SAMPLE_REASON))?;
        let log_likelihood =
            weighted_log_likelihood(observations, |value| distribution.ln_pdf(value))?;

        FitEstimateV1::new(
            ContinuousDistributionIdV1::Normal,
            Self::PARAMETERIZATION_ID,
            vec![
                available_parameter("location", location)?,
                available_parameter("scale", scale)?,
            ],
            log_likelihood,
            closed_form_convergence(),
        )
    }

    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1> {
        let [location, scale] = expect_parameter_values(
            estimate,
            &ContinuousDistributionIdV1::Normal,
            Self::PARAMETERIZATION_ID,
            &["location", "scale"],
        )?;
        let distribution = Normal::new(location, scale)
            .map_err(|_| input_failure(ESTIMATE_PARAMETERS_INVALID_REASON))?;
        finite_nonnegative_pdf(distribution.pdf(validate_pdf_x(x)?))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LognormalFitV1;

impl LognormalFitV1 {
    pub const METHOD_ID: &'static str = "fit.lognormal.mle.v1";
    pub const PARAMETERIZATION_ID: &'static str = "lognormal.logLocationLogScale.v1";
}

impl FitModel for LognormalFitV1 {
    fn distribution_id(&self) -> ContinuousDistributionIdV1 {
        ContinuousDistributionIdV1::Lognormal
    }

    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
        validate_observations(observations)?;
        if observations
            .iter()
            .any(|observation| observation.value <= 0.0)
        {
            return Err(domain_failure(LOGNORMAL_DOMAIN_INVALID_REASON));
        }

        Ok(())
    }

    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> {
        self.validate_domain(observations)?;

        let log_observations: Vec<FitObservationV1> = observations
            .iter()
            .map(|observation| FitObservationV1 {
                value: observation.value.ln(),
                frequency: observation.frequency,
                weight: observation.weight,
            })
            .collect();
        let log_location = weighted_mean(&log_observations)?;
        let log_scale = weighted_scale(&log_observations, log_location)?;
        let distribution = LogNormal::new(log_location, log_scale)
            .map_err(|_| domain_failure(CONSTANT_SAMPLE_REASON))?;
        let log_likelihood =
            weighted_log_likelihood(observations, |value| distribution.ln_pdf(value))?;

        FitEstimateV1::new(
            ContinuousDistributionIdV1::Lognormal,
            Self::PARAMETERIZATION_ID,
            vec![
                available_parameter("logLocation", log_location)?,
                available_parameter("logScale", log_scale)?,
            ],
            log_likelihood,
            closed_form_convergence(),
        )
    }

    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1> {
        let [log_location, log_scale] = expect_parameter_values(
            estimate,
            &ContinuousDistributionIdV1::Lognormal,
            Self::PARAMETERIZATION_ID,
            &["logLocation", "logScale"],
        )?;
        let x = validate_pdf_x(x)?;
        if x <= 0.0 {
            return Ok(0.0);
        }
        let distribution = LogNormal::new(log_location, log_scale)
            .map_err(|_| input_failure(ESTIMATE_PARAMETERS_INVALID_REASON))?;
        finite_nonnegative_pdf(distribution.pdf(x))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ExponentialFitV1;

impl ExponentialFitV1 {
    pub const METHOD_ID: &'static str = "fit.exponential.location0.mle.v1";
    pub const PARAMETERIZATION_ID: &'static str = "exponential.scaleLocation0.v1";
}

impl FitModel for ExponentialFitV1 {
    fn distribution_id(&self) -> ContinuousDistributionIdV1 {
        ContinuousDistributionIdV1::Exponential
    }

    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
        validate_observations(observations)?;
        if observations
            .iter()
            .any(|observation| observation.value < 0.0)
        {
            return Err(domain_failure(EXPONENTIAL_DOMAIN_INVALID_REASON));
        }

        Ok(())
    }

    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> {
        self.validate_domain(observations)?;

        let scale = weighted_mean(observations)?;
        if !scale.is_finite() || scale <= 0.0 {
            return Err(domain_failure(CONSTANT_SAMPLE_REASON));
        }
        let distribution =
            Exp::new(1.0 / scale).map_err(|_| domain_failure(CONSTANT_SAMPLE_REASON))?;
        let log_likelihood =
            weighted_log_likelihood(observations, |value| distribution.ln_pdf(value))?;

        FitEstimateV1::new(
            ContinuousDistributionIdV1::Exponential,
            Self::PARAMETERIZATION_ID,
            vec![available_parameter("scale", scale)?],
            log_likelihood,
            closed_form_convergence(),
        )
    }

    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1> {
        let [scale] = expect_parameter_values(
            estimate,
            &ContinuousDistributionIdV1::Exponential,
            Self::PARAMETERIZATION_ID,
            &["scale"],
        )?;
        let x = validate_pdf_x(x)?;
        if x < 0.0 {
            return Ok(0.0);
        }
        let distribution =
            Exp::new(1.0 / scale).map_err(|_| input_failure(ESTIMATE_PARAMETERS_INVALID_REASON))?;
        finite_nonnegative_pdf(distribution.pdf(x))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GammaFitV1;

impl GammaFitV1 {
    pub const METHOD_ID: &'static str = "fit.gamma.shapeScale.mle.v1";
    pub const PARAMETERIZATION_ID: &'static str = "gamma.shapeScale.location0.v1";
}

impl FitModel for GammaFitV1 {
    fn distribution_id(&self) -> ContinuousDistributionIdV1 {
        ContinuousDistributionIdV1::Gamma
    }

    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
        validate_observations(observations)?;
        if observations
            .iter()
            .any(|observation| observation.value <= 0.0)
        {
            return Err(domain_failure(GAMMA_DOMAIN_INVALID_REASON));
        }

        Ok(())
    }

    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> {
        self.validate_domain(observations)?;

        let initial_parameters = gamma_initial_parameters(observations)?;
        let objective = GammaObjectiveV1 { observations };
        let optimizer = ArgminBrentOptimizerV1;
        let problem = FitOptimizationProblemV1 {
            objective: &objective,
            initial_parameters: vec![initial_parameters[0]],
            lower_bounds: vec![None],
            upper_bounds: vec![None],
            iteration_limit: CONTINUOUS_FIT_ITERATION_LIMIT,
            tolerance: CONTINUOUS_FIT_TOLERANCE,
        };
        let optimization = run_optimizer(&optimizer, &problem)?;
        let convergence = optimized_convergence(&optimizer, &problem, &optimization)?;
        let [shape, scale] =
            gamma_profile_parameters(observations, optimization.unconstrained_parameters[0])?;
        let log_likelihood = finite_log_likelihood_from_objective(optimization.objective_value)?;

        FitEstimateV1::new(
            ContinuousDistributionIdV1::Gamma,
            Self::PARAMETERIZATION_ID,
            vec![
                available_parameter("shape", shape)?,
                available_parameter("scale", scale)?,
            ],
            log_likelihood,
            convergence,
        )
    }

    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1> {
        let [shape, scale] = expect_parameter_values(
            estimate,
            &ContinuousDistributionIdV1::Gamma,
            Self::PARAMETERIZATION_ID,
            &["shape", "scale"],
        )?;
        let x = validate_pdf_x(x)?;
        if x == 0.0 {
            return if shape > 1.0 {
                Ok(0.0)
            } else if (shape - 1.0).abs() <= f64::EPSILON {
                finite_nonnegative_pdf(1.0 / scale)
            } else {
                Err(curve_failure(PDF_NON_FINITE_REASON))
            };
        }
        let rate = gamma_rate_from_scale(scale)?;
        let distribution = Gamma::new(shape, rate)
            .map_err(|_| input_failure(ESTIMATE_PARAMETERS_INVALID_REASON))?;
        finite_nonnegative_pdf(distribution.pdf(x))
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct WeibullFitV1;

impl WeibullFitV1 {
    pub const METHOD_ID: &'static str = "fit.weibull.shapeScale.mle.v1";
    pub const PARAMETERIZATION_ID: &'static str = "weibull.shapeScale.location0.v1";
}

pub const STAGE1_FIT_REGISTRY: [FitModelRegistrationV1; 5] = [
    FitModelRegistrationV1 {
        distribution_id: ContinuousDistributionIdV1::Normal,
        estimated_parameter_count: 2,
        method_id: NormalFitV1::METHOD_ID,
        method_version: "1.0.0",
        parameterization_id: NormalFitV1::PARAMETERIZATION_ID,
        initialization_strategy_id: "closedForm.v1",
        optimizer_id: "closed-form",
        optimizer_version: "1",
        convergence_tolerance: 0.0,
        iteration_limit: 0,
        factory: normal_model,
    },
    FitModelRegistrationV1 {
        distribution_id: ContinuousDistributionIdV1::Lognormal,
        estimated_parameter_count: 2,
        method_id: LognormalFitV1::METHOD_ID,
        method_version: "1.0.0",
        parameterization_id: LognormalFitV1::PARAMETERIZATION_ID,
        initialization_strategy_id: "closedForm.logTransform.v1",
        optimizer_id: "closed-form",
        optimizer_version: "1",
        convergence_tolerance: 0.0,
        iteration_limit: 0,
        factory: lognormal_model,
    },
    FitModelRegistrationV1 {
        distribution_id: ContinuousDistributionIdV1::Exponential,
        estimated_parameter_count: 1,
        method_id: ExponentialFitV1::METHOD_ID,
        method_version: "1.0.0",
        parameterization_id: ExponentialFitV1::PARAMETERIZATION_ID,
        initialization_strategy_id: "closedForm.location0.v1",
        optimizer_id: "closed-form",
        optimizer_version: "1",
        convergence_tolerance: 0.0,
        iteration_limit: 0,
        factory: exponential_model,
    },
    FitModelRegistrationV1 {
        distribution_id: ContinuousDistributionIdV1::Gamma,
        estimated_parameter_count: 2,
        method_id: GammaFitV1::METHOD_ID,
        method_version: "1.0.0",
        parameterization_id: GammaFitV1::PARAMETERIZATION_ID,
        initialization_strategy_id: "logMoments.v1",
        optimizer_id: ARGMIN_BRENT_OPTIMIZER_ID,
        optimizer_version: ARGMIN_BRENT_OPTIMIZER_VERSION,
        convergence_tolerance: CONTINUOUS_FIT_TOLERANCE,
        iteration_limit: CONTINUOUS_FIT_ITERATION_LIMIT,
        factory: gamma_model,
    },
    FitModelRegistrationV1 {
        distribution_id: ContinuousDistributionIdV1::Weibull,
        estimated_parameter_count: 2,
        method_id: WeibullFitV1::METHOD_ID,
        method_version: "1.0.0",
        parameterization_id: WeibullFitV1::PARAMETERIZATION_ID,
        initialization_strategy_id: "logMoments.v1",
        optimizer_id: ARGMIN_BRENT_OPTIMIZER_ID,
        optimizer_version: ARGMIN_BRENT_OPTIMIZER_VERSION,
        convergence_tolerance: CONTINUOUS_FIT_TOLERANCE,
        iteration_limit: CONTINUOUS_FIT_ITERATION_LIMIT,
        factory: weibull_model,
    },
];

impl FitModel for WeibullFitV1 {
    fn distribution_id(&self) -> ContinuousDistributionIdV1 {
        ContinuousDistributionIdV1::Weibull
    }

    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
        validate_observations(observations)?;
        if observations
            .iter()
            .any(|observation| observation.value <= 0.0)
        {
            return Err(domain_failure(WEIBULL_DOMAIN_INVALID_REASON));
        }

        Ok(())
    }

    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> {
        self.validate_domain(observations)?;

        let initial_parameters = weibull_initial_parameters(observations)?;
        let objective = WeibullObjectiveV1 { observations };
        let optimizer = ArgminBrentOptimizerV1;
        let problem = FitOptimizationProblemV1 {
            objective: &objective,
            initial_parameters: vec![initial_parameters[0]],
            lower_bounds: vec![None],
            upper_bounds: vec![None],
            iteration_limit: CONTINUOUS_FIT_ITERATION_LIMIT,
            tolerance: CONTINUOUS_FIT_TOLERANCE,
        };
        let optimization = run_optimizer(&optimizer, &problem)?;
        let convergence = optimized_convergence(&optimizer, &problem, &optimization)?;
        let [shape, scale] =
            weibull_profile_parameters(observations, optimization.unconstrained_parameters[0])?;
        let log_likelihood = finite_log_likelihood_from_objective(optimization.objective_value)?;

        FitEstimateV1::new(
            ContinuousDistributionIdV1::Weibull,
            Self::PARAMETERIZATION_ID,
            vec![
                available_parameter("shape", shape)?,
                available_parameter("scale", scale)?,
            ],
            log_likelihood,
            convergence,
        )
    }

    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1> {
        let [shape, scale] = expect_parameter_values(
            estimate,
            &ContinuousDistributionIdV1::Weibull,
            Self::PARAMETERIZATION_ID,
            &["shape", "scale"],
        )?;
        let x = validate_pdf_x(x)?;
        if x == 0.0 {
            return if shape > 1.0 {
                Ok(0.0)
            } else if (shape - 1.0).abs() <= f64::EPSILON {
                finite_nonnegative_pdf(1.0 / scale)
            } else {
                Err(curve_failure(PDF_NON_FINITE_REASON))
            };
        }
        let distribution = Weibull::new(shape, scale)
            .map_err(|_| input_failure(ESTIMATE_PARAMETERS_INVALID_REASON))?;
        finite_nonnegative_pdf(distribution.pdf(x))
    }
}

pub trait FitObjective {
    fn evaluate(&self, unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1>;

    fn score(&self, _unconstrained_parameters: &[f64]) -> Result<Option<f64>, FitFailureV1> {
        Ok(None)
    }
}

#[derive(Clone)]
struct ArgminObjectiveBridgeV1<'a> {
    objective: &'a dyn FitObjective,
    failure: Rc<RefCell<Option<FitFailureV1>>>,
}

impl ArgminObjectiveBridgeV1<'_> {
    fn record_failure(&self, failure: FitFailureV1) {
        let mut slot = self.failure.borrow_mut();
        if slot.is_none() {
            *slot = Some(failure);
        }
    }
}

impl ArgminCostFunction for ArgminObjectiveBridgeV1<'_> {
    type Param = f64;
    type Output = f64;

    fn cost(&self, unconstrained_parameters: &Self::Param) -> Result<Self::Output, ArgminError> {
        match self.objective.evaluate(&[*unconstrained_parameters]) {
            Ok(objective_value) if objective_value.is_finite() => Ok(objective_value),
            Ok(_) => {
                self.record_failure(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
                Err(ArgminError::msg(LOG_LIKELIHOOD_INVALID_REASON))
            }
            Err(failure) => {
                self.record_failure(failure.clone());
                Err(ArgminError::msg(failure.reason_code))
            }
        }
    }
}

#[derive(Clone)]
struct ArgminScoreBridgeV1<'a> {
    objective: &'a dyn FitObjective,
    failure: Rc<RefCell<Option<FitFailureV1>>>,
}

impl ArgminCostFunction for ArgminScoreBridgeV1<'_> {
    type Param = f64;
    type Output = f64;

    fn cost(&self, unconstrained_parameters: &Self::Param) -> Result<Self::Output, ArgminError> {
        match self.objective.score(&[*unconstrained_parameters]) {
            Ok(Some(score)) if score.is_finite() => Ok(score),
            Ok(_) => {
                let failure = objective_failure(LOG_LIKELIHOOD_INVALID_REASON);
                *self.failure.borrow_mut() = Some(failure.clone());
                Err(ArgminError::msg(failure.reason_code))
            }
            Err(failure) => {
                *self.failure.borrow_mut() = Some(failure.clone());
                Err(ArgminError::msg(failure.reason_code))
            }
        }
    }
}

fn refine_score_root(
    objective: &dyn FitObjective,
    lower_bound: f64,
    upper_bound: f64,
    iteration_limit: u64,
    tolerance: f64,
) -> Result<(f64, u64, TerminationStatus), FitFailureV1> {
    let lower_score = objective
        .score(&[lower_bound])?
        .filter(|score| score.is_finite())
        .ok_or_else(|| objective_failure(LOG_LIKELIHOOD_INVALID_REASON))?;
    let upper_score = objective
        .score(&[upper_bound])?
        .filter(|score| score.is_finite())
        .ok_or_else(|| objective_failure(LOG_LIKELIHOOD_INVALID_REASON))?;
    if lower_score.signum() == upper_score.signum() {
        return Err(input_failure(OPTIMIZER_BRACKET_INVALID_REASON));
    }

    let score_failure = Rc::new(RefCell::new(None));
    let score_bridge = ArgminScoreBridgeV1 {
        objective,
        failure: Rc::clone(&score_failure),
    };
    let execution = Executor::new(
        score_bridge,
        BrentRoot::new(lower_bound, upper_bound, tolerance),
    )
    .configure(|state: IterState<f64, (), (), (), (), f64>| state.max_iters(iteration_limit))
    .run();

    if let Some(captured_failure) = score_failure.borrow_mut().take() {
        return Err(captured_failure);
    }

    let execution = execution.map_err(|_| optimizer_failure(OPTIMIZER_FAILED_REASON))?;
    let parameter = execution
        .state
        .best_param
        .or(execution.state.param)
        .ok_or_else(|| optimizer_failure(OPTIMIZER_PARAMETERS_INVALID_REASON))?;

    Ok((
        parameter,
        execution.state.iter,
        execution.state.termination_status,
    ))
}

#[derive(Debug, Clone, Copy, Default)]
struct ArgminBrentOptimizerV1;

impl FitOptimizer for ArgminBrentOptimizerV1 {
    fn optimizer_id(&self) -> &'static str {
        ARGMIN_BRENT_OPTIMIZER_ID
    }

    fn optimizer_version(&self) -> &'static str {
        ARGMIN_BRENT_OPTIMIZER_VERSION
    }

    fn minimize(
        &self,
        problem: &FitOptimizationProblemV1<'_>,
    ) -> Result<FitOptimizationResultV1, FitFailureV1> {
        let failure = Rc::new(RefCell::new(None));
        let initial_parameter = expect_one_parameter(&problem.initial_parameters)?;
        let (lower_bound, upper_bound) = build_brent_bounds(problem, initial_parameter)?;
        let solver_tolerance = (problem.tolerance * problem.tolerance).max(f64::EPSILON);
        let solver = BrentOpt::new(lower_bound, upper_bound)
            .set_tolerance(solver_tolerance, solver_tolerance);
        let bridge = ArgminObjectiveBridgeV1 {
            objective: problem.objective,
            failure: Rc::clone(&failure),
        };
        let execution = Executor::new(bridge, solver)
            .configure(|state: IterState<f64, (), (), (), (), f64>| {
                state
                    .param(initial_parameter)
                    .max_iters(problem.iteration_limit)
            })
            .run();

        if let Some(captured_failure) = failure.borrow_mut().take() {
            return match captured_failure.classification {
                FitFailureClassificationV1::Objective => Ok(FitOptimizationResultV1 {
                    unconstrained_parameters: problem.initial_parameters.clone(),
                    objective_value: f64::MAX,
                    iterations: 0,
                    state: FitOptimizationStateV1::NonFiniteObjective,
                    gradient_norm: None,
                }),
                _ => Err(captured_failure),
            };
        }

        let execution = execution.map_err(|_| optimizer_failure(OPTIMIZER_FAILED_REASON))?;
        let mut best_parameters = execution
            .state
            .best_param
            .or(execution.state.param)
            .ok_or_else(|| optimizer_failure(OPTIMIZER_PARAMETERS_INVALID_REASON))?;
        let mut objective_value = best_cost_from_state(&execution.state)?;
        let mut iterations = execution.state.iter;
        let mut termination_status = execution.state.termination_status.clone();

        let remaining_iterations = problem.iteration_limit.saturating_sub(iterations);
        if remaining_iterations > 0 && problem.objective.score(&[best_parameters])?.is_some() {
            let (root_parameter, root_iterations, root_termination_status) = refine_score_root(
                problem.objective,
                lower_bound,
                upper_bound,
                remaining_iterations,
                problem.tolerance,
            )?;
            best_parameters = root_parameter;
            objective_value = problem.objective.evaluate(&[best_parameters])?;
            iterations += root_iterations;
            termination_status = root_termination_status;
        }

        let state = optimization_state_from_termination(
            termination_status,
            best_parameters,
            &problem.lower_bounds,
            &problem.upper_bounds,
            problem.tolerance,
        );

        Ok(FitOptimizationResultV1 {
            unconstrained_parameters: vec![best_parameters],
            objective_value,
            iterations,
            state,
            gradient_norm: None,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct GammaObjectiveV1<'a> {
    observations: &'a [FitObservationV1],
}

impl FitObjective for GammaObjectiveV1<'_> {
    fn evaluate(&self, unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
        let ln_shape = expect_one_parameter(unconstrained_parameters)?;
        let [shape, scale] = gamma_profile_parameters(self.observations, ln_shape)?;
        let rate = gamma_rate_from_scale(scale)?;
        let distribution = Gamma::new(shape, rate)
            .map_err(|_| objective_failure(LOG_LIKELIHOOD_INVALID_REASON))?;
        Ok(-weighted_log_likelihood(self.observations, |value| {
            distribution.ln_pdf(value)
        })?)
    }

    fn score(&self, unconstrained_parameters: &[f64]) -> Result<Option<f64>, FitFailureV1> {
        let ln_shape = expect_one_parameter(unconstrained_parameters)?;
        let shape = positive_transform(ln_shape)?;
        let mean = weighted_mean(self.observations)?;
        let mean_log = weighted_mean(&log_observations(self.observations))?;
        let score = shape.ln() - digamma(shape) - (mean.ln() - mean_log);
        if !score.is_finite() {
            return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
        }

        Ok(Some(score))
    }
}

#[derive(Debug, Clone, Copy)]
struct WeibullObjectiveV1<'a> {
    observations: &'a [FitObservationV1],
}

impl FitObjective for WeibullObjectiveV1<'_> {
    fn evaluate(&self, unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
        let ln_shape = expect_one_parameter(unconstrained_parameters)?;
        let [shape, scale] = weibull_profile_parameters(self.observations, ln_shape)?;
        let distribution = Weibull::new(shape, 1.0)
            .map_err(|_| objective_failure(LOG_LIKELIHOOD_INVALID_REASON))?;
        let log_scale = scale.ln();
        Ok(-weighted_log_likelihood(self.observations, |value| {
            distribution.ln_pdf(value / scale) - log_scale
        })?)
    }

    fn score(&self, unconstrained_parameters: &[f64]) -> Result<Option<f64>, FitFailureV1> {
        let ln_shape = expect_one_parameter(unconstrained_parameters)?;
        let shape = positive_transform(ln_shape)?;
        let mean_log = weighted_mean(&log_observations(self.observations))?;
        let max_log = self
            .observations
            .iter()
            .map(|observation| observation.value.ln())
            .fold(f64::NEG_INFINITY, f64::max);
        let mut weighted_power = 0.0;
        let mut weighted_power_log = 0.0;
        for observation in self.observations {
            let log_value = observation.value.ln();
            let scaled_power = (shape * (log_value - max_log)).exp();
            let contribution = observation.contribution() * scaled_power;
            weighted_power += contribution;
            weighted_power_log += contribution * log_value;
        }
        if !weighted_power.is_finite() || weighted_power <= 0.0 || !weighted_power_log.is_finite() {
            return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
        }
        let score = shape.recip() + mean_log - weighted_power_log / weighted_power;
        if !score.is_finite() {
            return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
        }

        Ok(Some(score))
    }
}

pub struct FitOptimizationProblemV1<'a> {
    pub objective: &'a dyn FitObjective,
    pub initial_parameters: Vec<f64>,
    pub lower_bounds: Vec<Option<f64>>,
    pub upper_bounds: Vec<Option<f64>>,
    pub iteration_limit: u64,
    pub tolerance: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FitOptimizationStateV1 {
    Converged,
    IterationLimit,
    Boundary,
    NonFiniteObjective,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitOptimizationResultV1 {
    pub unconstrained_parameters: Vec<f64>,
    pub objective_value: f64,
    pub iterations: u64,
    pub state: FitOptimizationStateV1,
    pub gradient_norm: Option<f64>,
}

pub trait FitOptimizer {
    fn optimizer_id(&self) -> &'static str;
    fn optimizer_version(&self) -> &'static str;
    fn minimize(
        &self,
        problem: &FitOptimizationProblemV1<'_>,
    ) -> Result<FitOptimizationResultV1, FitFailureV1>;
}

const _: fn(&[FitObservationV1]) -> f64 = total_frequency;
const _: fn(&[FitObservationV1]) -> Result<f64, AppError> = effective_n;
const _: fn(f64, usize, f64) -> Result<FitMetricSetV1, AppError> = fit_information_criteria;
const _: fn(f64) -> Result<f64, FitFailureV1> = positive_transform;
const _: [FitOptimizationStateV1; 5] = [
    FitOptimizationStateV1::Converged,
    FitOptimizationStateV1::IterationLimit,
    FitOptimizationStateV1::Boundary,
    FitOptimizationStateV1::NonFiniteObjective,
    FitOptimizationStateV1::Failed,
];
const _: fn(
    ContinuousDistributionIdV1,
    &'static str,
    Vec<DistributionFitParameterV1>,
    f64,
    DistributionFitConvergenceV1,
) -> Result<FitEstimateV1, FitFailureV1> = FitEstimateV1::new;
const _: fn(&str) -> FitFailureV1 = domain_failure;
const _: fn(&str) -> FitFailureV1 = optimizer_failure;
const _: fn(&str) -> FitFailureV1 = objective_failure;
const _: fn(&str) -> FitFailureV1 = input_failure;
const _: fn(&str) -> FitFailureV1 = curve_failure;
const _: fn(&FitOptimizationResultV1) -> Result<(), FitFailureV1> = validate_optimizer_result;
const _: fn(&dyn FitModel, &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> =
    validate_and_fit_model;
const _: fn(
    &dyn FitModel,
    &FitEstimateV1,
    f64,
    f64,
) -> Result<Vec<DistributionCoordinateV1>, FitFailureV1> = build_pdf_curve;
const _: for<'a> fn(&FitOptimizationProblemV1<'a>) -> Result<f64, FitFailureV1> =
    evaluate_objective;
const _: for<'a> fn(
    &dyn FitOptimizer,
    &FitOptimizationProblemV1<'a>,
) -> Result<FitOptimizationResultV1, FitFailureV1> = run_optimizer;

pub fn validate_and_fit_model(
    model: &dyn FitModel,
    observations: &[FitObservationV1],
) -> Result<FitEstimateV1, FitFailureV1> {
    let _ = model.distribution_id();
    model.validate_domain(observations)?;
    model.fit(observations)
}

pub fn evaluate_objective(problem: &FitOptimizationProblemV1<'_>) -> Result<f64, FitFailureV1> {
    let objective_value = problem.objective.evaluate(&problem.initial_parameters)?;
    if !objective_value.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok(objective_value)
}

pub fn run_optimizer(
    optimizer: &dyn FitOptimizer,
    problem: &FitOptimizationProblemV1<'_>,
) -> Result<FitOptimizationResultV1, FitFailureV1> {
    if problem.initial_parameters.len() != problem.lower_bounds.len()
        || problem.initial_parameters.len() != problem.upper_bounds.len()
    {
        return Err(input_failure(
            "distribution.fit.optimizerBoundsShapeInvalid.v1",
        ));
    }
    if problem.iteration_limit == 0 {
        return Err(input_failure("distribution.fit.iterationLimitInvalid.v1"));
    }
    if !problem.tolerance.is_finite() || problem.tolerance <= 0.0 {
        return Err(input_failure("distribution.fit.toleranceInvalid.v1"));
    }

    let _ = optimizer.optimizer_id();
    let _ = optimizer.optimizer_version();
    if let Err(failure) = evaluate_objective(problem) {
        return match failure.classification {
            FitFailureClassificationV1::Objective => Ok(FitOptimizationResultV1 {
                unconstrained_parameters: problem.initial_parameters.clone(),
                objective_value: f64::MAX,
                iterations: 0,
                state: FitOptimizationStateV1::NonFiniteObjective,
                gradient_norm: None,
            }),
            _ => Err(failure),
        };
    }
    let result = optimizer.minimize(problem)?;
    validate_optimizer_result(&result)?;

    Ok(result)
}

fn validate_optimizer_result(result: &FitOptimizationResultV1) -> Result<(), FitFailureV1> {
    if !result.objective_value.is_finite() {
        return Err(optimizer_failure(OPTIMIZER_OBJECTIVE_INVALID_REASON));
    }
    if result
        .unconstrained_parameters
        .iter()
        .any(|parameter| !parameter.is_finite())
    {
        return Err(optimizer_failure(OPTIMIZER_PARAMETERS_INVALID_REASON));
    }
    if result
        .gradient_norm
        .is_some_and(|gradient_norm| !gradient_norm.is_finite())
    {
        return Err(optimizer_failure(OPTIMIZER_GRADIENT_NORM_INVALID_REASON));
    }

    Ok(())
}

pub fn total_frequency(observations: &[FitObservationV1]) -> f64 {
    observations
        .iter()
        .map(|observation| observation.frequency)
        .sum()
}

pub fn effective_n(observations: &[FitObservationV1]) -> Result<f64, AppError> {
    if observations.is_empty() {
        return Err(AppError::Stats(EFFECTIVE_N_INVALID_REASON.to_string()));
    }

    let numerator_sum: f64 = observations
        .iter()
        .map(FitObservationV1::contribution)
        .sum();
    let denominator_sum: f64 = observations
        .iter()
        .map(|observation| observation.frequency * observation.weight * observation.weight)
        .sum();

    if !numerator_sum.is_finite() || !denominator_sum.is_finite() || denominator_sum <= 0.0 {
        return Err(AppError::Stats(EFFECTIVE_N_INVALID_REASON.to_string()));
    }

    let effective_n = numerator_sum * numerator_sum / denominator_sum;
    if !effective_n.is_finite() || effective_n <= 0.0 {
        return Err(AppError::Stats(EFFECTIVE_N_INVALID_REASON.to_string()));
    }

    Ok(effective_n)
}

pub fn fit_information_criteria(
    log_likelihood: f64,
    parameter_count: usize,
    effective_n: f64,
) -> Result<FitMetricSetV1, AppError> {
    if !log_likelihood.is_finite() || !effective_n.is_finite() || effective_n <= 0.0 {
        return Err(AppError::Stats(LOG_LIKELIHOOD_INVALID_REASON.to_string()));
    }

    let parameter_count = parameter_count as f64;
    let aic = finite_metric(2.0 * parameter_count - 2.0 * log_likelihood)?;
    let bic = finite_metric(parameter_count * effective_n.ln() - 2.0 * log_likelihood)?;
    let aicc = if effective_n <= parameter_count + 1.0 {
        unavailable_metric(AICC_UNAVAILABLE_REASON)
    } else {
        let correction =
            2.0 * parameter_count * (parameter_count + 1.0) / (effective_n - parameter_count - 1.0);
        finite_metric(value_from_metric(&aic)? + correction)?
    };

    Ok(FitMetricSetV1 { aic, aicc, bic })
}

pub fn positive_transform(unconstrained: f64) -> Result<f64, FitFailureV1> {
    if !unconstrained.is_finite() {
        return Err(input_failure(POSITIVE_TRANSFORM_INVALID_REASON));
    }

    let transformed = unconstrained.exp();
    if !transformed.is_finite() || transformed <= 0.0 {
        return Err(objective_failure(POSITIVE_TRANSFORM_INVALID_REASON));
    }

    Ok(transformed)
}

pub fn build_pdf_curve(
    model: &dyn FitModel,
    estimate: &FitEstimateV1,
    x_min: f64,
    x_max: f64,
) -> Result<Vec<DistributionCoordinateV1>, FitFailureV1> {
    if !x_min.is_finite() || !x_max.is_finite() || x_max <= x_min {
        return Err(curve_failure(CURVE_WIDTH_INVALID_REASON));
    }

    let step = (x_max - x_min) / 255.0;
    if !step.is_finite() {
        return Err(curve_failure(CURVE_STEP_INVALID_REASON));
    }

    let mut points = Vec::with_capacity(256);
    for index in 0..256 {
        let mut x = if index == 255 {
            x_max
        } else {
            x_min + step * index as f64
        };
        if !x.is_finite() {
            return Err(curve_failure(CURVE_X_INVALID_REASON));
        }
        let y = match model.pdf(estimate, x) {
            Err(failure)
                if index == 0
                    && x == 0.0
                    && failure.reason_code == PDF_NON_FINITE_REASON =>
            {
                x = (step / 1024.0).max(f64::MIN_POSITIVE);
                model.pdf(estimate, x)?
            }
            result => result?,
        };
        if !y.is_finite() {
            return Err(curve_failure(PDF_NON_FINITE_REASON));
        }
        points.push(DistributionCoordinateV1 { x, y });
    }

    Ok(points)
}

fn validate_observations(observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
    if observations.is_empty() {
        return Err(input_failure(OBSERVATIONS_EMPTY_REASON));
    }

    for observation in observations {
        if !observation.value.is_finite() {
            return Err(input_failure(OBSERVATION_VALUE_INVALID_REASON));
        }
        if !observation.frequency.is_finite() || observation.frequency <= 0.0 {
            return Err(input_failure(OBSERVATION_FREQUENCY_INVALID_REASON));
        }
        if !observation.weight.is_finite() || observation.weight <= 0.0 {
            return Err(input_failure(OBSERVATION_WEIGHT_INVALID_REASON));
        }
        let contribution = observation.contribution();
        if !contribution.is_finite() || contribution <= 0.0 {
            return Err(input_failure(OBSERVATION_CONTRIBUTION_INVALID_REASON));
        }
    }

    Ok(())
}

fn total_contribution(observations: &[FitObservationV1]) -> Result<f64, FitFailureV1> {
    let total: f64 = observations
        .iter()
        .map(FitObservationV1::contribution)
        .sum();
    if !total.is_finite() || total <= 0.0 {
        return Err(input_failure(OBSERVATION_CONTRIBUTION_INVALID_REASON));
    }

    Ok(total)
}

fn weighted_mean(observations: &[FitObservationV1]) -> Result<f64, FitFailureV1> {
    let denominator = total_contribution(observations)?;
    let numerator: f64 = observations
        .iter()
        .map(|observation| observation.contribution() * observation.value)
        .sum();
    if !numerator.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    let mean = numerator / denominator;
    if !mean.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok(mean)
}

fn weighted_scale(observations: &[FitObservationV1], location: f64) -> Result<f64, FitFailureV1> {
    let denominator = total_contribution(observations)?;
    let weighted_sum_squares: f64 = observations
        .iter()
        .map(|observation| observation.contribution() * (observation.value - location).powi(2))
        .sum();
    if !weighted_sum_squares.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    let variance = weighted_sum_squares / denominator;
    if !variance.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }
    if variance <= 0.0 {
        return Err(domain_failure(CONSTANT_SAMPLE_REASON));
    }

    let scale = variance.sqrt();
    if !scale.is_finite() || scale <= 0.0 {
        return Err(domain_failure(CONSTANT_SAMPLE_REASON));
    }

    Ok(scale)
}

fn weighted_log_likelihood(
    observations: &[FitObservationV1],
    mut ln_density: impl FnMut(f64) -> f64,
) -> Result<f64, FitFailureV1> {
    let mut log_likelihood = 0.0;

    for observation in observations {
        let term = ln_density(observation.value);
        if !term.is_finite() {
            return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
        }
        log_likelihood += observation.contribution() * term;
        if !log_likelihood.is_finite() {
            return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
        }
    }

    Ok(log_likelihood)
}

fn log_observations(observations: &[FitObservationV1]) -> Vec<FitObservationV1> {
    observations
        .iter()
        .map(|observation| FitObservationV1 {
            value: observation.value.ln(),
            frequency: observation.frequency,
            weight: observation.weight,
        })
        .collect()
}

fn gamma_initial_parameters(observations: &[FitObservationV1]) -> Result<Vec<f64>, FitFailureV1> {
    let mean = weighted_mean(observations)?;
    let log_mean = weighted_mean(&log_observations(observations))?;
    let moment_gap = mean.ln() - log_mean;
    if !moment_gap.is_finite() || moment_gap <= 0.0 {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    let shape = (3.0 - moment_gap + ((moment_gap - 3.0).powi(2) + 24.0 * moment_gap).sqrt())
        / (12.0 * moment_gap);
    if !shape.is_finite() || shape <= 0.0 {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    let scale = mean / shape;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    unconstrained_shape_scale(shape, scale)
}

fn weibull_initial_parameters(observations: &[FitObservationV1]) -> Result<Vec<f64>, FitFailureV1> {
    let log_observations = log_observations(observations);
    let log_location = weighted_mean(&log_observations)?;
    let log_scale = weighted_scale(&log_observations, log_location)?;
    let shape = std::f64::consts::PI / (6.0f64.sqrt() * log_scale);
    if !shape.is_finite() || shape <= 0.0 {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    let scale = (log_location + EULER_MASCHERONI / shape).exp();
    if !scale.is_finite() || scale <= 0.0 {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    unconstrained_shape_scale(shape, scale)
}

fn unconstrained_shape_scale(shape: f64, scale: f64) -> Result<Vec<f64>, FitFailureV1> {
    if !shape.is_finite() || !scale.is_finite() || shape <= 0.0 || scale <= 0.0 {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    let ln_shape = shape.ln();
    let ln_scale = scale.ln();
    if !ln_shape.is_finite() || !ln_scale.is_finite() {
        return Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON));
    }

    Ok(vec![ln_shape, ln_scale])
}

fn gamma_profile_parameters(
    observations: &[FitObservationV1],
    ln_shape: f64,
) -> Result<[f64; 2], FitFailureV1> {
    let shape = positive_transform(ln_shape)?;
    let mean = weighted_mean(observations)?;
    let scale = mean / shape;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok([shape, scale])
}

fn weibull_profile_parameters(
    observations: &[FitObservationV1],
    ln_shape: f64,
) -> Result<[f64; 2], FitFailureV1> {
    let shape = positive_transform(ln_shape)?;
    let total = total_contribution(observations)?;
    let max_log_value = observations
        .iter()
        .map(|observation| observation.value.ln())
        .fold(f64::NEG_INFINITY, f64::max);
    if !max_log_value.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }
    let scaled_sum: f64 = observations
        .iter()
        .map(|observation| {
            let scaled_power = (shape * (observation.value.ln() - max_log_value)).exp();
            observation.contribution() * scaled_power
        })
        .sum();
    if !scaled_sum.is_finite() || scaled_sum <= 0.0 {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }
    let log_scale = max_log_value + (scaled_sum / total).ln() / shape;
    if !log_scale.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }
    let scale = log_scale.exp();
    if !scale.is_finite() || scale <= 0.0 {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok([shape, scale])
}

fn expect_one_parameter(parameters: &[f64]) -> Result<f64, FitFailureV1> {
    if parameters.len() != 1 {
        return Err(input_failure(OPTIMIZER_PARAMETERS_INVALID_REASON));
    }

    Ok(parameters[0])
}

fn gamma_rate_from_scale(scale: f64) -> Result<f64, FitFailureV1> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(input_failure(ESTIMATE_PARAMETERS_INVALID_REASON));
    }
    let rate = 1.0 / scale;
    if !rate.is_finite() || rate <= 0.0 {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok(rate)
}

fn build_brent_bounds(
    problem: &FitOptimizationProblemV1<'_>,
    initial_parameter: f64,
) -> Result<(f64, f64), FitFailureV1> {
    let span = (initial_parameter.abs() * 2.0 + 1.0).max(2.0);
    let lower_bound = problem
        .lower_bounds
        .first()
        .and_then(|bound| *bound)
        .unwrap_or(initial_parameter - span);
    let upper_bound = problem
        .upper_bounds
        .first()
        .and_then(|bound| *bound)
        .unwrap_or(initial_parameter + span);
    if !lower_bound.is_finite() || !upper_bound.is_finite() || lower_bound >= upper_bound {
        return Err(input_failure(OPTIMIZER_BRACKET_INVALID_REASON));
    }
    if initial_parameter < lower_bound || initial_parameter > upper_bound {
        return Err(input_failure(OPTIMIZER_BRACKET_INVALID_REASON));
    }

    Ok((lower_bound, upper_bound))
}

fn best_cost_from_state(state: &IterState<f64, (), (), (), (), f64>) -> Result<f64, FitFailureV1> {
    let objective_value = if state.best_cost.is_finite() {
        state.best_cost
    } else {
        state.cost
    };
    if !objective_value.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok(objective_value)
}

fn optimization_state_from_termination(
    termination_status: TerminationStatus,
    parameter: f64,
    lower_bounds: &[Option<f64>],
    upper_bounds: &[Option<f64>],
    tolerance: f64,
) -> FitOptimizationStateV1 {
    match termination_status {
        TerminationStatus::Terminated(TerminationReason::MaxItersReached) => {
            FitOptimizationStateV1::IterationLimit
        }
        TerminationStatus::Terminated(TerminationReason::SolverConverged)
        | TerminationStatus::Terminated(TerminationReason::TargetCostReached) => {
            if parameter_on_boundary(parameter, lower_bounds, upper_bounds, tolerance) {
                FitOptimizationStateV1::Boundary
            } else {
                FitOptimizationStateV1::Converged
            }
        }
        _ => FitOptimizationStateV1::Failed,
    }
}

fn parameter_on_boundary(
    parameter: f64,
    lower_bounds: &[Option<f64>],
    upper_bounds: &[Option<f64>],
    tolerance: f64,
) -> bool {
    let edge_tolerance = tolerance.sqrt().max(1e-6);
    lower_bounds
        .first()
        .and_then(|bound| *bound)
        .is_some_and(|lower| (parameter - lower).abs() <= edge_tolerance)
        || upper_bounds
            .first()
            .and_then(|bound| *bound)
            .is_some_and(|upper| (parameter - upper).abs() <= edge_tolerance)
}

fn finite_log_likelihood_from_objective(objective_value: f64) -> Result<f64, FitFailureV1> {
    if !objective_value.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    let log_likelihood = -objective_value;
    if !log_likelihood.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    Ok(log_likelihood)
}

fn optimized_convergence(
    optimizer: &dyn FitOptimizer,
    problem: &FitOptimizationProblemV1<'_>,
    optimization: &FitOptimizationResultV1,
) -> Result<DistributionFitConvergenceV1, FitFailureV1> {
    match optimization.state {
        FitOptimizationStateV1::Converged => Ok(DistributionFitConvergenceV1 {
            status: DistributionFitConvergenceStatusV1::Converged,
            reason_code: None,
            optimizer_id: optimizer.optimizer_id().to_string(),
            optimizer_version: optimizer.optimizer_version().to_string(),
            iterations: optimization.iterations,
            tolerance: problem.tolerance,
            objective: Some(optimization.objective_value),
            gradient_norm: optimization.gradient_norm,
        }),
        FitOptimizationStateV1::IterationLimit => {
            Err(optimizer_failure(OPTIMIZER_ITERATION_LIMIT_REASON))
        }
        FitOptimizationStateV1::Boundary => Err(optimizer_failure(OPTIMIZER_BOUNDARY_REASON)),
        FitOptimizationStateV1::NonFiniteObjective => {
            Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON))
        }
        FitOptimizationStateV1::Failed => Err(optimizer_failure(OPTIMIZER_FAILED_REASON)),
    }
}

fn available_parameter(
    parameter_id: &'static str,
    value: f64,
) -> Result<DistributionFitParameterV1, FitFailureV1> {
    if !value.is_finite() {
        return Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON));
    }

    let inference_unavailable = unavailable_metric("distribution.fit.parameterInferenceUnavailable.v1");
    Ok(DistributionFitParameterV1 {
        parameter_id: parameter_id.to_string(),
        value: CapabilityTypedValueV1 {
            state: AVAILABLE_STATE.to_string(),
            value: Some(value),
            reason_code: None,
        },
        standard_error: inference_unavailable.clone(),
        lower_confidence: inference_unavailable.clone(),
        upper_confidence: inference_unavailable,
    })
}

fn closed_form_convergence() -> DistributionFitConvergenceV1 {
    DistributionFitConvergenceV1 {
        status: DistributionFitConvergenceStatusV1::Converged,
        reason_code: None,
        optimizer_id: "closed-form".to_string(),
        optimizer_version: "1".to_string(),
        iterations: 1,
        tolerance: 0.0,
        objective: None,
        gradient_norm: None,
    }
}

fn expect_parameter_values<const N: usize>(
    estimate: &FitEstimateV1,
    expected_distribution: &ContinuousDistributionIdV1,
    expected_parameterization: &'static str,
    expected_parameter_ids: &[&str; N],
) -> Result<[f64; N], FitFailureV1> {
    if &estimate.distribution_id != expected_distribution {
        return Err(input_failure(ESTIMATE_DISTRIBUTION_INVALID_REASON));
    }
    if estimate.parameterization_id != expected_parameterization {
        return Err(input_failure(ESTIMATE_PARAMETERIZATION_INVALID_REASON));
    }
    if estimate.parameters.len() != N {
        return Err(input_failure(ESTIMATE_PARAMETERS_INVALID_REASON));
    }

    let mut values = [0.0; N];
    for (index, (parameter, expected_parameter_id)) in estimate
        .parameters
        .iter()
        .zip(expected_parameter_ids.iter())
        .enumerate()
    {
        if parameter.parameter_id != *expected_parameter_id {
            return Err(input_failure(ESTIMATE_PARAMETERS_INVALID_REASON));
        }
        if parameter.value.state != AVAILABLE_STATE || parameter.value.reason_code.is_some() {
            return Err(input_failure(ESTIMATE_PARAMETERS_INVALID_REASON));
        }
        let value = parameter
            .value
            .value
            .filter(|value| value.is_finite())
            .ok_or_else(|| input_failure(ESTIMATE_PARAMETERS_INVALID_REASON))?;
        values[index] = value;
    }

    Ok(values)
}

fn validate_pdf_x(x: f64) -> Result<f64, FitFailureV1> {
    if !x.is_finite() {
        return Err(input_failure(PDF_X_INVALID_REASON));
    }

    Ok(x)
}

fn finite_nonnegative_pdf(value: f64) -> Result<f64, FitFailureV1> {
    if !value.is_finite() || value < 0.0 {
        return Err(objective_failure(PDF_NON_FINITE_REASON));
    }

    Ok(value)
}

fn finite_metric(value: f64) -> Result<CapabilityTypedValueV1, AppError> {
    if !value.is_finite() {
        return Err(AppError::Stats(LOG_LIKELIHOOD_INVALID_REASON.to_string()));
    }

    Ok(CapabilityTypedValueV1 {
        state: AVAILABLE_STATE.to_string(),
        value: Some(value),
        reason_code: None,
    })
}

fn unavailable_metric(reason_code: &str) -> CapabilityTypedValueV1 {
    CapabilityTypedValueV1 {
        state: UNAVAILABLE_STATE.to_string(),
        value: None,
        reason_code: Some(reason_code.to_string()),
    }
}

fn value_from_metric(metric: &CapabilityTypedValueV1) -> Result<f64, AppError> {
    metric
        .value
        .filter(|value| value.is_finite())
        .ok_or_else(|| AppError::Stats(LOG_LIKELIHOOD_INVALID_REASON.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        attach_parameter_inference, build_pdf_curve, closed_form_convergence, effective_n,
        fit_information_criteria, objective_failure,
        optimized_convergence, positive_transform, refine_score_root, run_optimizer,
        total_frequency, weibull_profile_parameters, ArgminBrentOptimizerV1, ExponentialFitV1,
        FitEstimateV1, FitFailureClassificationV1, FitFailureV1, FitModel, FitObjective,
        FitObservationV1, FitOptimizationProblemV1, FitOptimizationResultV1,
        FitOptimizationStateV1, FitOptimizer, GammaFitV1, GammaObjectiveV1, LognormalFitV1,
        NormalFitV1, WeibullFitV1, WeibullObjectiveV1, ARGMIN_BRENT_OPTIMIZER_ID,
        ARGMIN_BRENT_OPTIMIZER_VERSION, CONTINUOUS_FIT_ITERATION_LIMIT, CONTINUOUS_FIT_TOLERANCE,
        trigamma, LOG_LIKELIHOOD_INVALID_REASON, STAGE1_FIT_REGISTRY,
    };
    use crate::engine::distribution_executor::PreparedObservationV1;
    use crate::models::distribution::{
        CapabilityTypedValueV1, ContinuousDistributionIdV1, DistributionCoordinateV1,
        DistributionFitConvergenceStatusV1, DistributionFitConvergenceV1,
        DistributionFitParameterV1,
    };
    use serde::Deserialize;
    use statrs::distribution::{ContinuousCDF, Gamma, Weibull};
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::fs;

    fn prepared_observation(y: f64, frequency: u64, weight: f64) -> PreparedObservationV1 {
        PreparedObservationV1 {
            row_id: 1,
            y,
            weight,
            frequency,
            contribution: weight * frequency as f64,
        }
    }

    fn observation(value: f64, frequency: f64, weight: f64) -> FitObservationV1 {
        FitObservationV1 {
            value,
            frequency,
            weight,
        }
    }

    fn assert_close(actual: f64, expected: f64) {
        let abs = (actual - expected).abs();
        let rel = if expected == 0.0 {
            abs
        } else {
            abs / expected.abs()
        };
        assert!(
            abs <= 1e-10 || rel <= 1e-9,
            "expected {expected}, got {actual}, abs={abs}, rel={rel}"
        );
    }

    fn assert_numerical_inference_close(actual: f64, expected: f64) {
        let absolute = (actual - expected).abs();
        let relative = absolute / expected.abs().max(1.0);
        assert!(
            absolute <= 1e-8 || relative <= 2e-6,
            "expected {expected}, got {actual}, abs={absolute}, rel={relative}"
        );
    }

    fn assert_recovered_close(actual: f64, expected: f64) {
        let abs = (actual - expected).abs();
        let rel = abs / expected.abs();
        assert!(
            abs <= 5e-2 || rel <= 2e-2,
            "expected recovery near {expected}, got {actual}, abs={abs}, rel={rel}"
        );
    }

    fn available_parameter(parameter_id: &str, value: f64) -> DistributionFitParameterV1 {
        let unavailable = CapabilityTypedValueV1 {
            state: "unavailable".to_string(),
            value: None,
            reason_code: Some("distribution.fit.parameterInferenceUnavailable.v1".to_string()),
        };
        DistributionFitParameterV1 {
            parameter_id: parameter_id.to_string(),
            value: CapabilityTypedValueV1 {
                state: "available".to_string(),
                value: Some(value),
                reason_code: None,
            },
            standard_error: unavailable.clone(),
            lower_confidence: unavailable.clone(),
            upper_confidence: unavailable,
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PublicFixtureV1 {
        schema_version: String,
        cases: Vec<PublicFixtureCaseV1>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PublicFixtureCaseV1 {
        case_id: String,
        distribution_id: ContinuousDistributionIdV1,
        method_id: String,
        parameterization_id: String,
        values: Vec<f64>,
        frequencies: Option<Vec<f64>>,
        weights: Option<Vec<f64>>,
        expected_parameters: Vec<PublicFixtureParameterV1>,
        expected_log_likelihood: f64,
        replication_group: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PublicFixtureParameterV1 {
        parameter_id: String,
        estimate: f64,
        standard_error: Option<f64>,
        lower_confidence: Option<f64>,
        upper_confidence: Option<f64>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CapabilityFixtureV1 {
        observations: Vec<f64>,
    }

    fn public_fixture_path() -> String {
        format!(
            "{}/../tests/fixtures/distribution/continuous-fit-stage1-public-v1.json",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    fn load_public_fixture() -> PublicFixtureV1 {
        let fixture = fs::read_to_string(public_fixture_path()).expect("read public fixture");
        serde_json::from_str(&fixture).expect("parse public fixture")
    }

    fn observations_from_case(case: &PublicFixtureCaseV1) -> Vec<FitObservationV1> {
        let frequencies = case
            .frequencies
            .clone()
            .unwrap_or_else(|| vec![1.0; case.values.len()]);
        let weights = case
            .weights
            .clone()
            .unwrap_or_else(|| vec![1.0; case.values.len()]);

        assert_eq!(frequencies.len(), case.values.len());
        assert_eq!(weights.len(), case.values.len());

        case.values
            .iter()
            .zip(frequencies.iter())
            .zip(weights.iter())
            .map(|((value, frequency), weight)| observation(*value, *frequency, *weight))
            .collect()
    }

    fn fit_model_for(distribution_id: &ContinuousDistributionIdV1) -> Box<dyn FitModel> {
        match distribution_id {
            ContinuousDistributionIdV1::Normal => Box::new(NormalFitV1),
            ContinuousDistributionIdV1::Lognormal => Box::new(LognormalFitV1),
            ContinuousDistributionIdV1::Exponential => Box::new(ExponentialFitV1),
            ContinuousDistributionIdV1::Gamma => Box::new(GammaFitV1),
            ContinuousDistributionIdV1::Weibull => Box::new(WeibullFitV1),
            ContinuousDistributionIdV1::Unknown => panic!("unknown fit model in fixture"),
        }
    }

    mod closed_form {
        use super::*;

        fn closed_form_estimate(
            distribution_id: ContinuousDistributionIdV1,
            parameterization_id: &'static str,
            parameters: Vec<DistributionFitParameterV1>,
        ) -> FitEstimateV1 {
            FitEstimateV1::new(
                distribution_id,
                parameterization_id,
                parameters,
                -1.0,
                DistributionFitConvergenceV1 {
                    status: DistributionFitConvergenceStatusV1::Converged,
                    reason_code: None,
                    optimizer_id: "closed-form".to_string(),
                    optimizer_version: "1".to_string(),
                    iterations: 1,
                    tolerance: 0.0,
                    objective: None,
                    gradient_norm: None,
                },
            )
            .unwrap()
        }

        #[test]
        fn normal_uses_weighted_mle_and_closed_form_convergence() {
            let model = NormalFitV1;
            let observations = vec![observation(1.0, 1.0, 1.0), observation(4.0, 1.0, 3.0)];

            let estimate = model.fit(&observations).unwrap();

            assert_eq!(estimate.distribution_id, ContinuousDistributionIdV1::Normal);
            assert_eq!(
                estimate.parameterization_id,
                NormalFitV1::PARAMETERIZATION_ID
            );
            assert_eq!(estimate.parameters.len(), 2);
            assert_eq!(estimate.parameters[0].parameter_id, "location");
            assert_eq!(estimate.parameters[1].parameter_id, "scale");
            assert_close(estimate.parameters[0].value.value.unwrap(), 3.25);
            assert_close(
                estimate.parameters[1].value.value.unwrap(),
                1.299038105676658,
            );
            assert_close(estimate.log_likelihood, -6.722250420347787);
            assert_eq!(
                estimate.convergence.status,
                DistributionFitConvergenceStatusV1::Converged
            );
            assert_eq!(estimate.convergence.reason_code, None);
            assert_eq!(estimate.convergence.optimizer_id, "closed-form");
            assert_eq!(estimate.convergence.optimizer_version, "1");
            assert_eq!(estimate.convergence.iterations, 1);
            assert_eq!(estimate.convergence.tolerance, 0.0);
            assert_eq!(estimate.convergence.objective, None);
            assert_eq!(estimate.convergence.gradient_norm, None);
        }

        #[test]
        fn lognormal_uses_weighted_logs_after_the_log_transform() {
            let model = LognormalFitV1;
            let observations = vec![
                observation(1.0, 1.0, 1.0),
                observation(std::f64::consts::E.powi(2), 1.0, 3.0),
            ];

            let estimate = model.fit(&observations).unwrap();

            let expected_log_location = (1.0_f64 * 0.0_f64 + 3.0_f64 * 2.0_f64) / 4.0_f64;
            let expected_log_scale = ((1.0_f64 * (0.0_f64 - expected_log_location).powi(2)
                + 3.0_f64 * (2.0_f64 - expected_log_location).powi(2))
                / 4.0_f64)
                .sqrt();

            assert_eq!(
                estimate.distribution_id,
                ContinuousDistributionIdV1::Lognormal
            );
            assert_eq!(
                estimate.parameterization_id,
                LognormalFitV1::PARAMETERIZATION_ID
            );
            assert_eq!(estimate.parameters[0].parameter_id, "logLocation");
            assert_eq!(estimate.parameters[1].parameter_id, "logScale");
            assert_close(
                estimate.parameters[0].value.value.unwrap(),
                expected_log_location,
            );
            assert_close(
                estimate.parameters[1].value.value.unwrap(),
                expected_log_scale,
            );
            assert_close(estimate.log_likelihood, -11.1003899879151);
        }

        #[test]
        fn invalid_contributions_return_stable_typed_failures() {
            let normal = NormalFitV1;

            assert!(matches!(
                normal.fit(&[FitObservationV1 {
                    value: 1.0,
                    frequency: 1.0,
                    weight: 0.0,
                }]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.observationWeightInvalid.v1"
            ));

            assert!(matches!(
                normal.fit(&[FitObservationV1 {
                    value: 1.0,
                    frequency: 1.0,
                    weight: f64::NAN,
                }]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.observationWeightInvalid.v1"
            ));

            assert!(matches!(
                normal.fit(&[FitObservationV1 {
                    value: 1.0,
                    frequency: f64::MAX,
                    weight: 2.0,
                }]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.observationContributionInvalid.v1"
            ));
        }

        #[test]
        fn domain_and_constant_sample_failures_are_typed() {
            let normal = NormalFitV1;
            let lognormal = LognormalFitV1;
            let exponential = ExponentialFitV1;

            assert!(matches!(
                normal.fit(&[]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.observationsEmpty.v1"
            ));
            assert!(matches!(
                normal.fit(&[observation(2.0, 1.0, 1.0), observation(2.0, 1.0, 1.0)]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Domain,
                }) if reason_code == "distribution.fit.constantSample.v1"
            ));
            assert!(matches!(
                lognormal.fit(&[observation(0.0, 1.0, 1.0), observation(2.0, 1.0, 1.0)]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Domain,
                }) if reason_code == "distribution.fit.lognormalDomainInvalid.v1"
            ));
            assert!(matches!(
                exponential.fit(&[observation(-1.0, 1.0, 1.0), observation(2.0, 1.0, 1.0)]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Domain,
                }) if reason_code == "distribution.fit.exponentialDomainInvalid.v1"
            ));
            assert!(matches!(
                exponential.fit(&[observation(0.0, 1.0, 1.0), observation(0.0, 1.0, 1.0)]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Domain,
                }) if reason_code == "distribution.fit.constantSample.v1"
            ));
        }

        #[test]
        fn model_specific_pdf_validation_errors_are_typed() {
            let lognormal = LognormalFitV1;
            let exponential = ExponentialFitV1;

            let lognormal_distribution_mismatch = closed_form_estimate(
                ContinuousDistributionIdV1::Normal,
                LognormalFitV1::PARAMETERIZATION_ID,
                vec![
                    available_parameter("logLocation", 1.0),
                    available_parameter("logScale", 2.0),
                ],
            );
            assert!(matches!(
                lognormal.pdf(&lognormal_distribution_mismatch, 1.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateDistributionInvalid.v1"
            ));

            let lognormal_shape_mismatch = closed_form_estimate(
                ContinuousDistributionIdV1::Lognormal,
                "lognormal.shapeScale.v1",
                vec![
                    available_parameter("logLocation", 1.0),
                    available_parameter("logScale", 2.0),
                ],
            );
            assert!(matches!(
                lognormal.pdf(&lognormal_shape_mismatch, 1.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParameterizationInvalid.v1"
            ));

            let lognormal_parameter_ids_mismatch = closed_form_estimate(
                ContinuousDistributionIdV1::Lognormal,
                LognormalFitV1::PARAMETERIZATION_ID,
                vec![
                    available_parameter("logScale", 2.0),
                    available_parameter("logLocation", 1.0),
                ],
            );
            assert!(matches!(
                lognormal.pdf(&lognormal_parameter_ids_mismatch, 1.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParametersInvalid.v1"
            ));

            let exponential_location_mismatch = closed_form_estimate(
                ContinuousDistributionIdV1::Exponential,
                ExponentialFitV1::PARAMETERIZATION_ID,
                vec![
                    available_parameter("scale", 2.0),
                    available_parameter("location", 1.0),
                ],
            );
            assert!(matches!(
                exponential.pdf(&exponential_location_mismatch, 1.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParametersInvalid.v1"
            ));

            let exponential_parameter_ids_mismatch = closed_form_estimate(
                ContinuousDistributionIdV1::Exponential,
                "exponential.locationScale.v1",
                vec![
                    available_parameter("location", 0.0),
                    available_parameter("scale", 2.0),
                ],
            );
            assert!(matches!(
                exponential.pdf(&exponential_parameter_ids_mismatch, 1.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParameterizationInvalid.v1"
            ));
        }

        #[test]
        fn pdf_validates_estimate_distribution_parameterization_and_parameter_order() {
            let normal = NormalFitV1;
            let estimate = FitEstimateV1::new(
                ContinuousDistributionIdV1::Gamma,
                NormalFitV1::PARAMETERIZATION_ID,
                vec![
                    available_parameter("location", 1.0),
                    available_parameter("scale", 2.0),
                ],
                -1.0,
                DistributionFitConvergenceV1 {
                    status: DistributionFitConvergenceStatusV1::Converged,
                    reason_code: None,
                    optimizer_id: "closed-form".to_string(),
                    optimizer_version: "1".to_string(),
                    iterations: 1,
                    tolerance: 0.0,
                    objective: None,
                    gradient_norm: None,
                },
            )
            .unwrap();

            assert!(matches!(
                normal.pdf(&estimate, 0.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateDistributionInvalid.v1"
            ));

            let bad_parameterization = FitEstimateV1::new(
                ContinuousDistributionIdV1::Normal,
                "normal.shapeScale.v1",
                vec![
                    available_parameter("location", 1.0),
                    available_parameter("scale", 2.0),
                ],
                -1.0,
                DistributionFitConvergenceV1 {
                    status: DistributionFitConvergenceStatusV1::Converged,
                    reason_code: None,
                    optimizer_id: "closed-form".to_string(),
                    optimizer_version: "1".to_string(),
                    iterations: 1,
                    tolerance: 0.0,
                    objective: None,
                    gradient_norm: None,
                },
            )
            .unwrap();

            assert!(matches!(
                normal.pdf(&bad_parameterization, 0.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParameterizationInvalid.v1"
            ));

            let bad_order = FitEstimateV1::new(
                ContinuousDistributionIdV1::Normal,
                NormalFitV1::PARAMETERIZATION_ID,
                vec![
                    available_parameter("scale", 2.0),
                    available_parameter("location", 1.0),
                ],
                -1.0,
                DistributionFitConvergenceV1 {
                    status: DistributionFitConvergenceStatusV1::Converged,
                    reason_code: None,
                    optimizer_id: "closed-form".to_string(),
                    optimizer_version: "1".to_string(),
                    iterations: 1,
                    tolerance: 0.0,
                    objective: None,
                    gradient_norm: None,
                },
            )
            .unwrap();

            assert!(matches!(
                normal.pdf(&bad_order, 0.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParametersInvalid.v1"
            ));
        }
    }

    mod public_fixture {
        use super::*;

        #[test]
        fn cases_match_literal_fixture_and_frequency_replication() {
            let fixture = load_public_fixture();
            assert_eq!(fixture.schema_version, "1");

            let mut replication_groups: BTreeMap<String, Vec<(String, FitEstimateV1)>> =
                BTreeMap::new();
            let mut inferred_distributions = BTreeMap::<String, usize>::new();
            let mut pinned_inference_distributions = BTreeMap::<String, usize>::new();

            for case in &fixture.cases {
                let observations = observations_from_case(case);
                let model = fit_model_for(&case.distribution_id);
                let mut estimate = model.fit(&observations).unwrap();
                attach_parameter_inference(&mut estimate, &observations);

                let expected_method_id = match case.distribution_id {
                    ContinuousDistributionIdV1::Normal => NormalFitV1::METHOD_ID,
                    ContinuousDistributionIdV1::Lognormal => LognormalFitV1::METHOD_ID,
                    ContinuousDistributionIdV1::Exponential => ExponentialFitV1::METHOD_ID,
                    ContinuousDistributionIdV1::Gamma => GammaFitV1::METHOD_ID,
                    ContinuousDistributionIdV1::Weibull => WeibullFitV1::METHOD_ID,
                    ContinuousDistributionIdV1::Unknown => {
                        panic!("unknown fit model in fixture")
                    }
                };

                assert_eq!(case.method_id, expected_method_id);
                assert_eq!(estimate.distribution_id, case.distribution_id);
                assert_eq!(estimate.parameterization_id, case.parameterization_id);
                assert_eq!(estimate.parameters.len(), case.expected_parameters.len());

                for (actual, expected) in estimate
                    .parameters
                    .iter()
                    .zip(case.expected_parameters.iter())
                {
                    assert_eq!(actual.parameter_id, expected.parameter_id);
                    assert_eq!(actual.value.state, "available");
                    assert_eq!(actual.value.reason_code, None);
                    assert_close(actual.value.value.unwrap(), expected.estimate);
                }

                assert_close(estimate.log_likelihood, case.expected_log_likelihood);
                *inferred_distributions
                    .entry(format!("{:?}", case.distribution_id))
                    .or_default() += 1;
                for parameter in &estimate.parameters {
                    let point = parameter.value.value.unwrap();
                    let standard_error = parameter.standard_error.value.unwrap();
                    assert!(standard_error.is_finite() && standard_error >= 0.0);
                    assert_close(
                        parameter.lower_confidence.value.unwrap(),
                        point - 1.959_963_984_540_054 * standard_error,
                    );
                    assert_close(
                        parameter.upper_confidence.value.unwrap(),
                        point + 1.959_963_984_540_054 * standard_error,
                    );
                    if let Some(expected) = case
                        .expected_parameters
                        .iter()
                        .find(|expected| expected.parameter_id == parameter.parameter_id)
                    {
                        if let Some(expected_standard_error) = expected.standard_error {
                            *pinned_inference_distributions
                                .entry(format!("{:?}", case.distribution_id))
                                .or_default() += 1;
                            assert_close(standard_error, expected_standard_error);
                            assert_close(
                                parameter.lower_confidence.value.unwrap(),
                                expected.lower_confidence.unwrap(),
                            );
                            assert_close(
                                parameter.upper_confidence.value.unwrap(),
                                expected.upper_confidence.unwrap(),
                            );
                        }
                    }
                }

                let x_min = case.values.iter().copied().fold(f64::INFINITY, f64::min);
                let x_max = case
                    .values
                    .iter()
                    .copied()
                    .fold(f64::NEG_INFINITY, f64::max);
                let curve = build_pdf_curve(model.as_ref(), &estimate, x_min, x_max).unwrap();
                assert_eq!(curve.len(), 256);
                assert!(curve
                    .iter()
                    .all(|point| point.y.is_finite() && point.y >= 0.0));

                if let Some(group) = &case.replication_group {
                    replication_groups
                        .entry(group.clone())
                        .or_default()
                        .push((case.case_id.clone(), estimate.clone()));
                }
            }

            assert_eq!(inferred_distributions.len(), 5);
            assert_eq!(pinned_inference_distributions.len(), 5);

            for estimates in replication_groups.values() {
                assert_eq!(estimates.len(), 2);
                let baseline = &estimates[0].1;
                let candidate = &estimates[1].1;

                assert_eq!(baseline.parameterization_id, candidate.parameterization_id);
                assert_eq!(baseline.parameters.len(), candidate.parameters.len());
                for (left, right) in baseline.parameters.iter().zip(candidate.parameters.iter()) {
                    assert_eq!(left.parameter_id, right.parameter_id);
                    assert_close(left.value.value.unwrap(), right.value.value.unwrap());
                }
                assert_close(baseline.log_likelihood, candidate.log_likelihood);
            }
        }
    }

    fn stub_estimate() -> FitEstimateV1 {
        FitEstimateV1::new(
            ContinuousDistributionIdV1::Normal,
            "standard",
            Vec::new(),
            -5.0,
            DistributionFitConvergenceV1 {
                status: DistributionFitConvergenceStatusV1::Converged,
                reason_code: None,
                optimizer_id: "stub".to_string(),
                optimizer_version: "0".to_string(),
                iterations: 1,
                tolerance: 1e-9,
                objective: None,
                gradient_norm: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn observations_preserve_frequency_weight_and_effective_n() {
        let observations = vec![
            FitObservationV1::try_from(&prepared_observation(1.0, 2, 1.0)).unwrap(),
            FitObservationV1::try_from(&prepared_observation(2.0, 1, 3.0)).unwrap(),
        ];

        let expected_total_frequency = 3.0;
        let expected_effective_n = (2.0_f64 * 1.0_f64 + 1.0_f64 * 3.0_f64).powi(2)
            / (2.0 * 1.0_f64.powi(2) + 1.0 * 3.0_f64.powi(2));

        assert!((total_frequency(&observations) - expected_total_frequency).abs() < 1e-12);
        assert!((effective_n(&observations).unwrap() - expected_effective_n).abs() < 1e-12);
        assert!((observations[0].contribution() - 2.0).abs() < 1e-12);
        assert!((observations[1].contribution() - 3.0).abs() < 1e-12);
    }

    #[test]
    fn observation_conversion_rejects_non_finite_or_non_positive_inputs() {
        assert!(FitObservationV1::try_from(&prepared_observation(f64::NAN, 1, 1.0)).is_err());
        assert!(FitObservationV1::try_from(&prepared_observation(1.0, 1, 0.0)).is_err());
        assert!(FitObservationV1::try_from(&prepared_observation(1.0, 0, 1.0)).is_err());
    }

    #[test]
    fn information_criteria_report_available_values() {
        let metrics = fit_information_criteria(-10.0, 2, 20.0).unwrap();

        let expected_aic = 24.0;
        let expected_aicc = 24.0 + 12.0 / 17.0;
        let expected_bic = 20.0 + 2.0 * 20.0_f64.ln();

        assert_eq!(metrics.aic.state, "available");
        assert_eq!(metrics.aicc.state, "available");
        assert_eq!(metrics.bic.state, "available");
        assert!((metrics.aic.value.unwrap() - expected_aic).abs() < 1e-12);
        assert!((metrics.aicc.value.unwrap() - expected_aicc).abs() < 1e-12);
        assert!((metrics.bic.value.unwrap() - expected_bic).abs() < 1e-12);
    }

    #[test]
    fn parameter_inference_uses_closed_form_mle_information() {
        let observations = vec![
            observation(1.0, 1.0, 1.0),
            observation(3.0, 1.0, 1.0),
            observation(5.0, 1.0, 1.0),
        ];
        let mut normal = NormalFitV1.fit(&observations).unwrap();
        attach_parameter_inference(&mut normal, &observations);
        let scale = normal.parameters[1].value.value.unwrap();
        assert_close(
            normal.parameters[0].standard_error.value.unwrap(),
            scale / 3.0_f64.sqrt(),
        );
        assert_close(
            normal.parameters[1].standard_error.value.unwrap(),
            scale / 6.0_f64.sqrt(),
        );

        let mut exponential = ExponentialFitV1.fit(&observations).unwrap();
        attach_parameter_inference(&mut exponential, &observations);
        let estimate = exponential.parameters[0].value.value.unwrap();
        let standard_error = exponential.parameters[0].standard_error.value.unwrap();
        assert_close(standard_error, estimate / 3.0_f64.sqrt());
        assert_close(
            exponential.parameters[0].lower_confidence.value.unwrap(),
            estimate - 1.959_963_984_540_054 * standard_error,
        );
        assert_close(
            exponential.parameters[0].upper_confidence.value.unwrap(),
            estimate + 1.959_963_984_540_054 * standard_error,
        );
        let serialized = serde_json::to_value(&exponential.parameters[0]).unwrap();
        assert!(serialized.get("estimate").is_some());
        assert!(serialized.get("standardError").is_some());
        assert!(serialized.get("lowerConfidence").is_some());
        assert!(serialized.get("upperConfidence").is_some());
        assert!(serialized.get("value").is_none());
        assert!(serialized.get("fixed").is_none());
    }

    #[test]
    fn gamma_and_weibull_parameter_inference_is_finite_and_deterministic() {
        assert_close(trigamma(1.0).unwrap(), std::f64::consts::PI.powi(2) / 6.0);
        assert_close(trigamma(0.5).unwrap(), std::f64::consts::PI.powi(2) / 2.0);
        let observations = vec![
            observation(0.5, 1.0, 1.0),
            observation(1.0, 1.0, 1.0),
            observation(2.0, 1.0, 1.0),
            observation(4.0, 1.0, 1.0),
            observation(8.0, 1.0, 1.0),
        ];
        for model in [
            Box::new(GammaFitV1) as Box<dyn FitModel>,
            Box::new(WeibullFitV1) as Box<dyn FitModel>,
        ] {
            let mut first = model.fit(&observations).unwrap();
            let mut second = first.clone();
            attach_parameter_inference(&mut first, &observations);
            attach_parameter_inference(&mut second, &observations);
            for (left, right) in first.parameters.iter().zip(second.parameters.iter()) {
                assert!(left.standard_error.value.is_some_and(f64::is_finite));
                assert!(left.lower_confidence.value.is_some_and(f64::is_finite));
                assert!(left.upper_confidence.value.is_some_and(f64::is_finite));
                assert_eq!(left.standard_error, right.standard_error);
                assert_eq!(left.lower_confidence, right.lower_confidence);
                assert_eq!(left.upper_confidence, right.upper_confidence);
            }
        }
    }

    #[test]
    fn weibull_parameter_inference_matches_frequency_expansion() {
        let compact = vec![
            observation(0.5, 2.0, 1.0),
            observation(2.0, 1.0, 1.0),
            observation(8.0, 2.0, 1.0),
        ];
        let expanded = vec![
            observation(0.5, 1.0, 1.0),
            observation(0.5, 1.0, 1.0),
            observation(2.0, 1.0, 1.0),
            observation(8.0, 1.0, 1.0),
            observation(8.0, 1.0, 1.0),
        ];
        let mut compact_fit = WeibullFitV1.fit(&compact).unwrap();
        let mut expanded_fit = WeibullFitV1.fit(&expanded).unwrap();
        attach_parameter_inference(&mut compact_fit, &compact);
        attach_parameter_inference(&mut expanded_fit, &expanded);

        for (left, right) in compact_fit.parameters.iter().zip(expanded_fit.parameters.iter()) {
            assert_close(left.value.value.unwrap(), right.value.value.unwrap());
            assert_numerical_inference_close(
                left.standard_error.value.unwrap(),
                right.standard_error.value.unwrap(),
            );
            assert_numerical_inference_close(
                left.lower_confidence.value.unwrap(),
                right.lower_confidence.value.unwrap(),
            );
            assert_numerical_inference_close(
                left.upper_confidence.value.unwrap(),
                right.upper_confidence.value.unwrap(),
            );
        }
    }

    #[test]
    fn singular_parameter_information_preserves_estimates_as_typed_unavailable_inference() {
        let observations = vec![observation(1.0, 1.0, 1.0)];
        let mut estimate = FitEstimateV1::new(
            ContinuousDistributionIdV1::Gamma,
            GammaFitV1::PARAMETERIZATION_ID,
            vec![
                available_parameter("shape", f64::MAX),
                available_parameter("scale", f64::MIN_POSITIVE),
            ],
            -1.0,
            closed_form_convergence(),
        )
        .unwrap();

        attach_parameter_inference(&mut estimate, &observations);

        for parameter in &estimate.parameters {
            assert_eq!(parameter.value.state, "available");
            assert!(parameter.value.value.is_some_and(f64::is_finite));
            for inference in [
                &parameter.standard_error,
                &parameter.lower_confidence,
                &parameter.upper_confidence,
            ] {
                assert_eq!(inference.state, "unavailable");
                assert_eq!(inference.value, None);
                assert_eq!(
                    inference.reason_code.as_deref(),
                    Some("distribution.fit.parameterInformationSingular.v1")
                );
            }
        }
    }

    #[test]
    fn stage1_registry_owns_estimated_parameter_counts() {
        let count_for = |distribution_id| {
            STAGE1_FIT_REGISTRY
                .iter()
                .find(|registration| registration.distribution_id == distribution_id)
                .unwrap()
                .estimated_parameter_count
        };

        assert_eq!(count_for(ContinuousDistributionIdV1::Normal), 2);
        assert_eq!(count_for(ContinuousDistributionIdV1::Lognormal), 2);
        assert_eq!(count_for(ContinuousDistributionIdV1::Exponential), 1);
        assert_eq!(count_for(ContinuousDistributionIdV1::Gamma), 2);
        assert_eq!(count_for(ContinuousDistributionIdV1::Weibull), 2);
    }

    #[test]
    fn exponential_information_criteria_use_one_estimated_parameter_for_n51_fixture() {
        let path = format!(
            "{}/../tests/fixtures/distribution/process-capability-moving-range-v1.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture: CapabilityFixtureV1 =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let observations = fixture
            .observations
            .into_iter()
            .map(|value| observation(value, 1.0, 1.0))
            .collect::<Vec<_>>();
        let registration = STAGE1_FIT_REGISTRY
            .iter()
            .find(|registration| {
                registration.distribution_id == ContinuousDistributionIdV1::Exponential
            })
            .unwrap();
        let estimate = registration.model().fit(&observations).unwrap();
        let metrics = fit_information_criteria(
            estimate.log_likelihood,
            registration.estimated_parameter_count,
            effective_n(&observations).unwrap(),
        )
        .unwrap();

        assert_close(-2.0 * estimate.log_likelihood, 740.6183972);
        assert_close(metrics.aicc.value.unwrap(), 742.7000298);
        assert_close(metrics.bic.value.unwrap(), 744.5502228);
    }

    #[test]
    fn information_criteria_returns_typed_unavailable_aicc_when_effective_n_is_too_small() {
        let metrics = fit_information_criteria(-10.0, 2, 3.0).unwrap();

        assert_eq!(metrics.aic.state, "available");
        assert_eq!(metrics.aicc.state, "unavailable");
        assert_eq!(metrics.aicc.value, None);
        assert_eq!(
            metrics.aicc.reason_code.as_deref(),
            Some("distribution.fit.aiccUnavailable.v1")
        );
        assert_eq!(metrics.bic.state, "available");
    }

    #[test]
    fn information_criteria_rejects_non_finite_inputs() {
        assert!(fit_information_criteria(f64::NAN, 2, 20.0).is_err());
        assert!(fit_information_criteria(-10.0, 2, f64::INFINITY).is_err());
    }

    #[test]
    fn positive_transform_uses_exp_and_rejects_non_finite_results() {
        assert!((positive_transform(0.0).unwrap() - 1.0).abs() < 1e-12);
        assert!(matches!(
            positive_transform(f64::INFINITY),
            Err(FitFailureV1 {
                classification: FitFailureClassificationV1::Input,
                ..
            })
        ));
        assert!(matches!(
            positive_transform(1e308),
            Err(FitFailureV1 {
                classification: FitFailureClassificationV1::Objective,
                ..
            })
        ));
    }

    struct StubModel {
        density: f64,
    }

    struct StubObjective {
        value: f64,
    }

    impl FitObjective for StubObjective {
        fn evaluate(&self, _unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
            Ok(self.value)
        }
    }

    struct MockOptimizer {
        result: Result<FitOptimizationResultV1, FitFailureV1>,
    }

    impl FitOptimizer for MockOptimizer {
        fn optimizer_id(&self) -> &'static str {
            "mock-optimizer"
        }

        fn optimizer_version(&self) -> &'static str {
            "1.0.0"
        }

        fn minimize(
            &self,
            _problem: &FitOptimizationProblemV1<'_>,
        ) -> Result<FitOptimizationResultV1, FitFailureV1> {
            self.result.clone()
        }
    }

    fn optimizer_problem<'a>(objective: &'a dyn FitObjective) -> FitOptimizationProblemV1<'a> {
        FitOptimizationProblemV1 {
            objective,
            initial_parameters: vec![0.5, 1.5],
            lower_bounds: vec![Some(0.0), Some(0.0)],
            upper_bounds: vec![Some(10.0), Some(10.0)],
            iteration_limit: 100,
            tolerance: 1e-6,
        }
    }

    impl FitModel for StubModel {
        fn distribution_id(&self) -> ContinuousDistributionIdV1 {
            ContinuousDistributionIdV1::Normal
        }

        fn validate_domain(&self, _observations: &[FitObservationV1]) -> Result<(), FitFailureV1> {
            Ok(())
        }

        fn fit(&self, _observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1> {
            Err(FitFailureV1::new(
                "distribution.fit.notImplemented.v1",
                FitFailureClassificationV1::Optimizer,
            ))
        }

        fn pdf(&self, _estimate: &FitEstimateV1, _x: f64) -> Result<f64, FitFailureV1> {
            Ok(self.density)
        }
    }

    #[test]
    fn build_pdf_curve_returns_exactly_256_sorted_points_with_endpoints() {
        let model = StubModel { density: 0.5 };
        let curve = build_pdf_curve(&model, &stub_estimate(), -1.0, 3.0).unwrap();

        assert_eq!(curve.len(), 256);
        assert_eq!(
            curve.first(),
            Some(&DistributionCoordinateV1 { x: -1.0, y: 0.5 })
        );
        assert_eq!(
            curve.last(),
            Some(&DistributionCoordinateV1 { x: 3.0, y: 0.5 })
        );
        assert!(curve.windows(2).all(|window| window[0].x < window[1].x));
    }

    #[test]
    fn build_pdf_curve_rejects_non_positive_width_and_non_finite_pdf() {
        let zero_width_model = StubModel { density: 0.5 };
        let non_finite_model = StubModel { density: f64::NAN };

        assert!(matches!(
            build_pdf_curve(&zero_width_model, &stub_estimate(), 2.0, 2.0),
            Err(FitFailureV1 { reason_code, .. }) if reason_code == "distribution.fit.curveWidthInvalid.v1"
        ));
        assert!(matches!(
            build_pdf_curve(&non_finite_model, &stub_estimate(), 0.0, 1.0),
            Err(FitFailureV1 { reason_code, .. }) if reason_code == "distribution.fit.pdfNonFinite.v1"
        ));
    }

    #[test]
    fn build_pdf_curve_rejects_extreme_finite_endpoints_when_step_overflows() {
        let model = StubModel { density: 0.5 };

        assert!(matches!(
            build_pdf_curve(&model, &stub_estimate(), -1e308, 1e308),
            Err(FitFailureV1 {
                classification: FitFailureClassificationV1::Curve,
                ..
            })
        ));
    }

    #[test]
    fn run_optimizer_returns_converged_state_and_gradient_norm() {
        let objective = StubObjective { value: 10.0 };
        let problem = optimizer_problem(&objective);
        let optimizer = MockOptimizer {
            result: Ok(FitOptimizationResultV1 {
                unconstrained_parameters: vec![0.25, 0.75],
                objective_value: 5.0,
                iterations: 7,
                state: FitOptimizationStateV1::Converged,
                gradient_norm: Some(1e-8),
            }),
        };

        let result = run_optimizer(&optimizer, &problem).unwrap();

        assert_eq!(result.state, FitOptimizationStateV1::Converged);
        assert_eq!(result.gradient_norm, Some(1e-8));
    }

    #[test]
    fn run_optimizer_preserves_iteration_limit_terminal_state() {
        let objective = StubObjective { value: 10.0 };
        let problem = optimizer_problem(&objective);
        let optimizer = MockOptimizer {
            result: Ok(FitOptimizationResultV1 {
                unconstrained_parameters: vec![0.25, 0.75],
                objective_value: 5.0,
                iterations: 100,
                state: FitOptimizationStateV1::IterationLimit,
                gradient_norm: Some(0.25),
            }),
        };

        let result = run_optimizer(&optimizer, &problem).unwrap();

        assert_eq!(result.state, FitOptimizationStateV1::IterationLimit);
    }

    #[test]
    fn run_optimizer_preserves_boundary_terminal_state() {
        let objective = StubObjective { value: 10.0 };
        let problem = optimizer_problem(&objective);
        let optimizer = MockOptimizer {
            result: Ok(FitOptimizationResultV1 {
                unconstrained_parameters: vec![0.0, 10.0],
                objective_value: 5.0,
                iterations: 12,
                state: FitOptimizationStateV1::Boundary,
                gradient_norm: None,
            }),
        };

        let result = run_optimizer(&optimizer, &problem).unwrap();

        assert_eq!(result.state, FitOptimizationStateV1::Boundary);
        assert_eq!(result.gradient_norm, None);
    }

    struct QuadraticObjective {
        target: Vec<f64>,
    }

    impl FitObjective for QuadraticObjective {
        fn evaluate(&self, unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
            Ok(unconstrained_parameters
                .iter()
                .zip(self.target.iter())
                .map(|(value, target)| (value - target).powi(2))
                .sum())
        }
    }

    struct NonFiniteObjective;

    impl FitObjective for NonFiniteObjective {
        fn evaluate(&self, _unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
            Err(objective_failure(LOG_LIKELIHOOD_INVALID_REASON))
        }
    }

    #[test]
    fn argmin_optimizer_reports_iteration_limit_boundary_and_nonfinite_objective_states() {
        let optimizer = ArgminBrentOptimizerV1;

        let iteration_limit_problem = FitOptimizationProblemV1 {
            objective: &QuadraticObjective { target: vec![0.0] },
            initial_parameters: vec![5.0],
            lower_bounds: vec![None],
            upper_bounds: vec![None],
            iteration_limit: 1,
            tolerance: 1e-20,
        };
        let iteration_limit_result = run_optimizer(&optimizer, &iteration_limit_problem).unwrap();
        assert_eq!(
            iteration_limit_result.state,
            FitOptimizationStateV1::IterationLimit
        );

        let boundary_problem = FitOptimizationProblemV1 {
            objective: &QuadraticObjective { target: vec![0.0] },
            initial_parameters: vec![0.2],
            lower_bounds: vec![Some(0.0)],
            upper_bounds: vec![Some(10.0)],
            iteration_limit: 200,
            tolerance: 1e-10,
        };
        let boundary_result = run_optimizer(&optimizer, &boundary_problem).unwrap();
        assert_eq!(boundary_result.state, FitOptimizationStateV1::Boundary);

        let non_finite_problem = FitOptimizationProblemV1 {
            objective: &NonFiniteObjective,
            initial_parameters: vec![0.0],
            lower_bounds: vec![None],
            upper_bounds: vec![None],
            iteration_limit: 10,
            tolerance: 1e-10,
        };
        let non_finite_result = run_optimizer(&optimizer, &non_finite_problem).unwrap();
        assert_eq!(
            non_finite_result.state,
            FitOptimizationStateV1::NonFiniteObjective
        );
        assert_eq!(non_finite_result.gradient_norm, None);
    }

    #[test]
    fn run_optimizer_rejects_non_finite_optimizer_results() {
        let objective = StubObjective { value: 10.0 };
        let problem = optimizer_problem(&objective);
        let optimizer = MockOptimizer {
            result: Ok(FitOptimizationResultV1 {
                unconstrained_parameters: vec![0.25, f64::NAN],
                objective_value: f64::INFINITY,
                iterations: 3,
                state: FitOptimizationStateV1::NonFiniteObjective,
                gradient_norm: Some(f64::NAN),
            }),
        };

        assert!(matches!(
            run_optimizer(&optimizer, &problem),
            Err(FitFailureV1 {
                classification: FitFailureClassificationV1::Optimizer,
                ..
            })
        ));
    }

    mod optimized_models {
        use super::*;

        struct ScoreCountingQuadratic<'a> {
            score_calls: &'a Cell<u64>,
        }

        struct PositiveScoreObjective;

        impl FitObjective for PositiveScoreObjective {
            fn evaluate(&self, unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
                Ok(unconstrained_parameters[0].powi(2))
            }

            fn score(&self, unconstrained_parameters: &[f64]) -> Result<Option<f64>, FitFailureV1> {
                Ok(Some(unconstrained_parameters[0].powi(2) + 1.0))
            }
        }

        impl FitObjective for ScoreCountingQuadratic<'_> {
            fn evaluate(&self, unconstrained_parameters: &[f64]) -> Result<f64, FitFailureV1> {
                Ok(unconstrained_parameters[0].powi(2))
            }

            fn score(&self, unconstrained_parameters: &[f64]) -> Result<Option<f64>, FitFailureV1> {
                self.score_calls.set(self.score_calls.get() + 1);
                Ok(Some(2.0 * unconstrained_parameters[0]))
            }
        }

        fn deterministic_probabilities(count: usize) -> Vec<f64> {
            (0..count)
                .map(|index| (index as f64 + 0.5) / count as f64)
                .collect()
        }

        fn estimate_parameter(estimate: &FitEstimateV1, parameter_id: &str) -> f64 {
            estimate
                .parameters
                .iter()
                .find(|parameter| parameter.parameter_id == parameter_id)
                .and_then(|parameter| parameter.value.value)
                .unwrap()
        }

        fn assert_same_estimate_bytes(left: &FitEstimateV1, right: &FitEstimateV1) {
            assert_eq!(left.distribution_id, right.distribution_id);
            assert_eq!(left.parameterization_id, right.parameterization_id);
            assert_eq!(left.convergence.status, right.convergence.status);
            assert_eq!(left.convergence.reason_code, right.convergence.reason_code);
            assert_eq!(
                left.convergence.optimizer_id,
                right.convergence.optimizer_id
            );
            assert_eq!(
                left.convergence.optimizer_version,
                right.convergence.optimizer_version
            );
            assert_eq!(left.convergence.iterations, right.convergence.iterations);
            assert_eq!(
                left.convergence.tolerance.to_ne_bytes(),
                right.convergence.tolerance.to_ne_bytes()
            );
            assert_eq!(
                left.log_likelihood.to_ne_bytes(),
                right.log_likelihood.to_ne_bytes()
            );
            assert_eq!(left.parameters.len(), right.parameters.len());
            for (lhs, rhs) in left.parameters.iter().zip(right.parameters.iter()) {
                assert_eq!(lhs.parameter_id, rhs.parameter_id);
                assert_eq!(lhs.value.state, rhs.value.state);
                assert_eq!(lhs.value.reason_code, rhs.value.reason_code);
                assert_eq!(
                    lhs.value.value.unwrap().to_ne_bytes(),
                    rhs.value.value.unwrap().to_ne_bytes()
                );
            }
        }

        #[test]
        fn gamma_parameter_recovery_and_repeated_runs_are_deterministic() {
            let source_shape = 3.5;
            let source_scale = 1.75;
            let source = Gamma::new(source_shape, 1.0 / source_scale).unwrap();
            let observations = deterministic_probabilities(100)
                .into_iter()
                .map(|probability| observation(source.inverse_cdf(probability), 1.0, 1.0))
                .collect::<Vec<_>>();

            let estimate_a = GammaFitV1.fit(&observations).unwrap();
            let estimate_b = GammaFitV1.fit(&observations).unwrap();

            assert_eq!(
                estimate_a.distribution_id,
                ContinuousDistributionIdV1::Gamma
            );
            assert_eq!(
                estimate_a.parameterization_id,
                GammaFitV1::PARAMETERIZATION_ID
            );
            assert_eq!(estimate_a.parameters[0].parameter_id, "shape");
            assert_eq!(estimate_a.parameters[1].parameter_id, "scale");
            assert_recovered_close(estimate_parameter(&estimate_a, "shape"), source_shape);
            assert_recovered_close(estimate_parameter(&estimate_a, "scale"), source_scale);
            assert_eq!(
                estimate_a.convergence.optimizer_id,
                ARGMIN_BRENT_OPTIMIZER_ID
            );
            assert_eq!(
                estimate_a.convergence.optimizer_version,
                ARGMIN_BRENT_OPTIMIZER_VERSION
            );
            assert_eq!(estimate_a.convergence.reason_code, None);
            assert!(estimate_a.convergence.iterations <= CONTINUOUS_FIT_ITERATION_LIMIT);
            assert_eq!(estimate_a.convergence.tolerance, CONTINUOUS_FIT_TOLERANCE);
            assert!(estimate_a
                .convergence
                .objective
                .is_some_and(|value| value.is_finite()));
            assert_eq!(estimate_a.convergence.gradient_norm, None);
            assert_same_estimate_bytes(&estimate_a, &estimate_b);
        }

        #[test]
        fn weibull_parameter_recovery_and_domain_validation_are_typed() {
            let source = Weibull::new(1.8, 4.25).unwrap();
            let observations = deterministic_probabilities(100)
                .into_iter()
                .map(|probability| observation(source.inverse_cdf(probability), 1.0, 1.0))
                .collect::<Vec<_>>();

            let estimate = WeibullFitV1.fit(&observations).unwrap();
            let repeated_estimate = WeibullFitV1.fit(&observations).unwrap();

            assert_eq!(
                estimate.distribution_id,
                ContinuousDistributionIdV1::Weibull
            );
            assert_eq!(
                estimate.parameterization_id,
                WeibullFitV1::PARAMETERIZATION_ID
            );
            assert_eq!(estimate.parameters[0].parameter_id, "shape");
            assert_eq!(estimate.parameters[1].parameter_id, "scale");
            assert_recovered_close(estimate.parameters[0].value.value.unwrap(), 1.8);
            assert_recovered_close(estimate.parameters[1].value.value.unwrap(), 4.25);
            assert_eq!(estimate.convergence.optimizer_id, ARGMIN_BRENT_OPTIMIZER_ID);
            assert_eq!(
                estimate.convergence.optimizer_version,
                ARGMIN_BRENT_OPTIMIZER_VERSION
            );
            assert_eq!(estimate.convergence.reason_code, None);
            assert!(estimate
                .convergence
                .objective
                .is_some_and(|value| value.is_finite()));
            assert_eq!(estimate.convergence.gradient_norm, None);
            assert_same_estimate_bytes(&estimate, &repeated_estimate);

            assert!(matches!(
                WeibullFitV1.fit(&[observation(0.0, 1.0, 1.0), observation(1.0, 1.0, 1.0)]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Domain,
                }) if reason_code == "distribution.fit.weibullDomainInvalid.v1"
            ));
            assert!(matches!(
                GammaFitV1.fit(&[observation(-1.0, 1.0, 1.0), observation(1.0, 1.0, 1.0)]),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Domain,
                }) if reason_code == "distribution.fit.gammaDomainInvalid.v1"
            ));
        }

        #[test]
        fn gamma_and_weibull_recover_narrow_wide_repeated_and_frequency_cases() {
            let narrow_gamma = Gamma::new(9.0, 1.0 / 0.125).unwrap();
            let narrow_gamma_observations = deterministic_probabilities(100)
                .into_iter()
                .map(|probability| observation(narrow_gamma.inverse_cdf(probability), 1.0, 1.0))
                .collect::<Vec<_>>();
            let narrow_gamma_estimate = GammaFitV1.fit(&narrow_gamma_observations).unwrap();
            assert_recovered_close(estimate_parameter(&narrow_gamma_estimate, "shape"), 9.0);
            assert_recovered_close(estimate_parameter(&narrow_gamma_estimate, "scale"), 0.125);

            let wide_weibull = Weibull::new(0.85, 2500.0).unwrap();
            let wide_weibull_observations = deterministic_probabilities(100)
                .into_iter()
                .map(|probability| observation(wide_weibull.inverse_cdf(probability), 1.0, 1.0))
                .collect::<Vec<_>>();
            let wide_weibull_estimate = WeibullFitV1.fit(&wide_weibull_observations).unwrap();
            assert_recovered_close(estimate_parameter(&wide_weibull_estimate, "shape"), 0.85);
            assert_recovered_close(estimate_parameter(&wide_weibull_estimate, "scale"), 2500.0);

            let repeated_gamma_observations = vec![
                observation(0.7, 1.0, 1.0),
                observation(0.7, 1.0, 1.0),
                observation(1.9, 1.0, 1.0),
                observation(3.4, 1.0, 1.0),
                observation(3.4, 1.0, 1.0),
                observation(5.2, 1.0, 1.0),
            ];
            let repeated_gamma_estimate = GammaFitV1.fit(&repeated_gamma_observations).unwrap();
            assert_eq!(
                repeated_gamma_estimate.convergence.status,
                DistributionFitConvergenceStatusV1::Converged
            );
            assert!(repeated_gamma_estimate.log_likelihood.is_finite());
            assert!(repeated_gamma_estimate
                .parameters
                .iter()
                .all(|parameter| parameter.value.value.is_some_and(f64::is_finite)));

            let compact = vec![
                observation(0.6, 2.0, 1.0),
                observation(1.5, 1.0, 1.0),
                observation(3.2, 3.0, 1.0),
            ];
            let expanded = vec![
                observation(0.6, 1.0, 1.0),
                observation(0.6, 1.0, 1.0),
                observation(1.5, 1.0, 1.0),
                observation(3.2, 1.0, 1.0),
                observation(3.2, 1.0, 1.0),
                observation(3.2, 1.0, 1.0),
            ];
            let compact_estimate = WeibullFitV1.fit(&compact).unwrap();
            let expanded_estimate = WeibullFitV1.fit(&expanded).unwrap();
            assert_eq!(
                compact_estimate.distribution_id,
                expanded_estimate.distribution_id
            );
            assert_eq!(
                compact_estimate.parameterization_id,
                expanded_estimate.parameterization_id
            );
            assert_eq!(
                compact_estimate.convergence.status,
                expanded_estimate.convergence.status
            );
            assert_eq!(
                compact_estimate.parameters.len(),
                expanded_estimate.parameters.len()
            );
            for (left, right) in compact_estimate
                .parameters
                .iter()
                .zip(expanded_estimate.parameters.iter())
            {
                assert_eq!(left.parameter_id, right.parameter_id);
                assert_close(left.value.value.unwrap(), right.value.value.unwrap());
            }
            assert_close(
                compact_estimate.log_likelihood,
                expanded_estimate.log_likelihood,
            );
        }

        #[test]
        fn weibull_profile_scale_is_finite_and_scale_equivariant_for_extreme_values() {
            let shape = 2.0_f64;
            let base = vec![
                observation(0.8, 1.0, 1.0),
                observation(1.0, 1.0, 2.0),
                observation(1.2, 1.0, 3.0),
            ];
            let extreme = base
                .iter()
                .map(|value| observation(value.value * 1e200, value.frequency, value.weight))
                .collect::<Vec<_>>();

            let base_parameters = weibull_profile_parameters(&base, shape.ln()).unwrap();
            let extreme_parameters = weibull_profile_parameters(&extreme, shape.ln()).unwrap();

            assert_close(extreme_parameters[0], base_parameters[0]);
            assert_close(extreme_parameters[1] / 1e200, base_parameters[1]);
            assert!(extreme_parameters[1].is_finite());
            assert!(WeibullObjectiveV1 {
                observations: &extreme
            }
            .evaluate(&[shape.ln()])
            .unwrap()
            .is_finite());

            let base_estimate = WeibullFitV1.fit(&base).unwrap();
            let extreme_estimate = WeibullFitV1.fit(&extreme).unwrap();
            assert_close(
                estimate_parameter(&extreme_estimate, "shape"),
                estimate_parameter(&base_estimate, "shape"),
            );
            assert_close(
                estimate_parameter(&extreme_estimate, "scale") / 1e200,
                estimate_parameter(&base_estimate, "scale"),
            );
            assert!(extreme_estimate
                .convergence
                .objective
                .is_some_and(f64::is_finite));
        }

        #[test]
        fn brent_opt_and_score_refinement_share_one_iteration_budget() {
            let score_calls = Cell::new(0);
            let objective = ScoreCountingQuadratic {
                score_calls: &score_calls,
            };
            let problem = FitOptimizationProblemV1 {
                objective: &objective,
                initial_parameters: vec![5.0],
                lower_bounds: vec![None],
                upper_bounds: vec![None],
                iteration_limit: 1,
                tolerance: 1e-20,
            };

            let result = run_optimizer(&ArgminBrentOptimizerV1, &problem).unwrap();

            assert_eq!(result.state, FitOptimizationStateV1::IterationLimit);
            assert_eq!(result.iterations, 1);
            assert_eq!(score_calls.get(), 0, "root refinement must not start");
        }

        #[test]
        fn score_refinement_rejects_a_wrong_sign_bracket_with_typed_failure() {
            assert!(matches!(
                refine_score_root(&PositiveScoreObjective, -2.0, 2.0, 10, 1e-10),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.optimizerBracketInvalid.v1"
            ));
        }

        #[test]
        fn gamma_and_weibull_score_refinement_respects_the_shared_budget() {
            let observations = vec![
                observation(0.6, 1.0, 1.0),
                observation(1.1, 1.0, 1.0),
                observation(2.0, 1.0, 1.0),
                observation(3.7, 1.0, 1.0),
                observation(6.3, 1.0, 1.0),
            ];
            let gamma = GammaObjectiveV1 {
                observations: &observations,
            };
            let weibull = WeibullObjectiveV1 {
                observations: &observations,
            };

            for objective in [&gamma as &dyn FitObjective, &weibull as &dyn FitObjective] {
                let problem = FitOptimizationProblemV1 {
                    objective,
                    initial_parameters: vec![1.0],
                    lower_bounds: vec![None],
                    upper_bounds: vec![None],
                    iteration_limit: 500,
                    tolerance: CONTINUOUS_FIT_TOLERANCE,
                };
                let result = run_optimizer(&ArgminBrentOptimizerV1, &problem).unwrap();
                assert_eq!(result.state, FitOptimizationStateV1::Converged);
                assert!(result.iterations <= problem.iteration_limit);
                assert!(result.objective_value.is_finite());
            }
        }

        #[test]
        fn gamma_and_weibull_non_unit_weights_match_expanded_observations() {
            let weighted = vec![
                observation(0.6, 1.0, 2.0),
                observation(1.5, 1.0, 1.0),
                observation(3.2, 1.0, 3.0),
            ];
            let expanded = vec![
                observation(0.6, 1.0, 1.0),
                observation(0.6, 1.0, 1.0),
                observation(1.5, 1.0, 1.0),
                observation(3.2, 1.0, 1.0),
                observation(3.2, 1.0, 1.0),
                observation(3.2, 1.0, 1.0),
            ];

            for model in [&GammaFitV1 as &dyn FitModel, &WeibullFitV1 as &dyn FitModel] {
                let weighted_estimate = model.fit(&weighted).unwrap();
                let expanded_estimate = model.fit(&expanded).unwrap();
                for (weighted_parameter, expanded_parameter) in weighted_estimate
                    .parameters
                    .iter()
                    .zip(expanded_estimate.parameters.iter())
                {
                    assert_eq!(
                        weighted_parameter.parameter_id,
                        expanded_parameter.parameter_id
                    );
                    assert_close(
                        weighted_parameter.value.value.unwrap(),
                        expanded_parameter.value.value.unwrap(),
                    );
                }
                assert_close(
                    weighted_estimate.log_likelihood,
                    expanded_estimate.log_likelihood,
                );
            }
        }

        #[test]
        fn optimized_state_failures_are_typed_and_do_not_return_estimates() {
            let optimizer = ArgminBrentOptimizerV1;
            let iteration_limit_problem = FitOptimizationProblemV1 {
                objective: &QuadraticObjective { target: vec![0.0] },
                initial_parameters: vec![5.0],
                lower_bounds: vec![None],
                upper_bounds: vec![None],
                iteration_limit: 1,
                tolerance: 1e-20,
            };
            let iteration_limit = run_optimizer(&optimizer, &iteration_limit_problem).unwrap();
            assert_eq!(
                iteration_limit.state,
                FitOptimizationStateV1::IterationLimit
            );
            assert!(matches!(
                optimized_convergence(&optimizer, &iteration_limit_problem, &iteration_limit),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Optimizer,
                }) if reason_code == "distribution.fit.optimizerIterationLimit.v1"
            ));

            let boundary_problem = FitOptimizationProblemV1 {
                objective: &QuadraticObjective { target: vec![0.0] },
                initial_parameters: vec![0.2],
                lower_bounds: vec![Some(0.0)],
                upper_bounds: vec![Some(10.0)],
                iteration_limit: 200,
                tolerance: 1e-10,
            };
            let boundary = run_optimizer(&optimizer, &boundary_problem).unwrap();
            assert_eq!(boundary.state, FitOptimizationStateV1::Boundary);
            assert!(matches!(
                optimized_convergence(&optimizer, &boundary_problem, &boundary),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Optimizer,
                }) if reason_code == "distribution.fit.optimizerBoundary.v1"
            ));

            let non_finite_problem = FitOptimizationProblemV1 {
                objective: &NonFiniteObjective,
                initial_parameters: vec![0.0],
                lower_bounds: vec![None],
                upper_bounds: vec![None],
                iteration_limit: 10,
                tolerance: 1e-10,
            };
            let non_finite = run_optimizer(&optimizer, &non_finite_problem).unwrap();
            assert_eq!(non_finite.state, FitOptimizationStateV1::NonFiniteObjective);
            assert!(matches!(
                optimized_convergence(&optimizer, &non_finite_problem, &non_finite),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Objective,
                }) if reason_code == "distribution.fit.logLikelihoodInvalid.v1"
            ));
        }

        #[test]
        fn optimized_pdf_validates_ids_and_returns_finite_nonnegative_values() {
            let gamma_estimate = GammaFitV1
                .fit(&[
                    observation(0.8, 1.0, 1.0),
                    observation(1.3, 1.0, 1.0),
                    observation(2.1, 1.0, 1.0),
                    observation(4.5, 1.0, 1.0),
                ])
                .unwrap();
            assert!(GammaFitV1.pdf(&gamma_estimate, 2.0).unwrap() >= 0.0);
            let mut gamma_shape_one = gamma_estimate.clone();
            gamma_shape_one.parameters[0].value.value = Some(1.0);
            gamma_shape_one.parameters[1].value.value = Some(2.0);
            assert!((GammaFitV1.pdf(&gamma_shape_one, 0.0).unwrap() - 0.5).abs() < 1e-12);
            let mut gamma_shape_above_one = gamma_shape_one.clone();
            gamma_shape_above_one.parameters[0].value.value = Some(2.0);
            assert_eq!(GammaFitV1.pdf(&gamma_shape_above_one, 0.0).unwrap(), 0.0);
            let mut gamma_shape_below_one = gamma_shape_one.clone();
            gamma_shape_below_one.parameters[0].value.value = Some(0.5);
            assert!(matches!(
                GammaFitV1.pdf(&gamma_shape_below_one, 0.0),
                Err(FitFailureV1 { reason_code, classification: FitFailureClassificationV1::Curve })
                    if reason_code == "distribution.fit.pdfNonFinite.v1"
            ));
            let gamma_curve = build_pdf_curve(&GammaFitV1, &gamma_shape_below_one, 0.0, 4.0).unwrap();
            assert_eq!(gamma_curve.len(), 256);
            assert!(gamma_curve[0].x > 0.0 && gamma_curve[0].y.is_finite());

            let wrong_distribution = FitEstimateV1::new(
                ContinuousDistributionIdV1::Weibull,
                GammaFitV1::PARAMETERIZATION_ID,
                gamma_estimate.parameters.clone(),
                gamma_estimate.log_likelihood,
                gamma_estimate.convergence.clone(),
            )
            .unwrap();
            assert!(matches!(
                GammaFitV1.pdf(&wrong_distribution, 2.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateDistributionInvalid.v1"
            ));

            let wrong_parameterization = FitEstimateV1::new(
                ContinuousDistributionIdV1::Gamma,
                WeibullFitV1::PARAMETERIZATION_ID,
                gamma_estimate.parameters.clone(),
                gamma_estimate.log_likelihood,
                gamma_estimate.convergence.clone(),
            )
            .unwrap();
            assert!(matches!(
                GammaFitV1.pdf(&wrong_parameterization, 2.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParameterizationInvalid.v1"
            ));

            let gamma_parameters_reversed = FitEstimateV1::new(
                ContinuousDistributionIdV1::Gamma,
                GammaFitV1::PARAMETERIZATION_ID,
                gamma_estimate.parameters.iter().cloned().rev().collect(),
                gamma_estimate.log_likelihood,
                gamma_estimate.convergence.clone(),
            )
            .unwrap();
            assert!(matches!(
                GammaFitV1.pdf(&gamma_parameters_reversed, 2.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParametersInvalid.v1"
            ));

            let weibull_estimate = WeibullFitV1
                .fit(&[
                    observation(0.5, 1.0, 1.0),
                    observation(1.2, 1.0, 1.0),
                    observation(1.8, 1.0, 1.0),
                    observation(3.6, 1.0, 1.0),
                ])
                .unwrap();
            assert!(WeibullFitV1.pdf(&weibull_estimate, 2.0).unwrap() >= 0.0);
            let mut weibull_shape_one = weibull_estimate.clone();
            weibull_shape_one.parameters[0].value.value = Some(1.0);
            weibull_shape_one.parameters[1].value.value = Some(2.0);
            assert!((WeibullFitV1.pdf(&weibull_shape_one, 0.0).unwrap() - 0.5).abs() < 1e-12);
            let mut weibull_shape_above_one = weibull_shape_one.clone();
            weibull_shape_above_one.parameters[0].value.value = Some(2.0);
            assert_eq!(WeibullFitV1.pdf(&weibull_shape_above_one, 0.0).unwrap(), 0.0);
            let mut weibull_shape_below_one = weibull_shape_one.clone();
            weibull_shape_below_one.parameters[0].value.value = Some(0.5);
            assert!(matches!(
                WeibullFitV1.pdf(&weibull_shape_below_one, 0.0),
                Err(FitFailureV1 { reason_code, classification: FitFailureClassificationV1::Curve })
                    if reason_code == "distribution.fit.pdfNonFinite.v1"
            ));
            let weibull_curve = build_pdf_curve(&WeibullFitV1, &weibull_shape_below_one, 0.0, 4.0).unwrap();
            assert_eq!(weibull_curve.len(), 256);
            assert!(weibull_curve[0].x > 0.0 && weibull_curve[0].y.is_finite());

            let mut weibull_parameters_wrong_id = weibull_estimate.parameters.clone();
            weibull_parameters_wrong_id[0].parameter_id = "scale".to_string();
            let weibull_wrong_id = FitEstimateV1::new(
                ContinuousDistributionIdV1::Weibull,
                WeibullFitV1::PARAMETERIZATION_ID,
                weibull_parameters_wrong_id,
                weibull_estimate.log_likelihood,
                weibull_estimate.convergence,
            )
            .unwrap();
            assert!(matches!(
                WeibullFitV1.pdf(&weibull_wrong_id, 2.0),
                Err(FitFailureV1 {
                    reason_code,
                    classification: FitFailureClassificationV1::Input,
                }) if reason_code == "distribution.fit.estimateParametersInvalid.v1"
            ));
        }
    }
}
