import type { MeasurementSystem } from './types';

const METRES_TO_FEET = 3.280839895013123;
const INCHES_PER_METRE = 39.37007874015748;

export function displayLengthValue(metres: number, system: MeasurementSystem) {
  return system === 'metric' ? metres : metres * METRES_TO_FEET;
}

export function lengthInputSuffix(system: MeasurementSystem) {
  return system === 'metric' ? 'm' : 'ft';
}

export function displayValueToMetres(value: number, system: MeasurementSystem) {
  return system === 'metric' ? value : value / METRES_TO_FEET;
}

export function dimensionStepMetres(system: MeasurementSystem, metricStep = 0.05) {
  return system === 'metric' ? metricStep : 0.0254; // one inch
}

export function formatLength(metres: number, system: MeasurementSystem) {
  if (system === 'metric') return `${metres.toFixed(2)} m`;
  const totalInches = Math.max(0, Math.round(metres * INCHES_PER_METRE));
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}′ ${inches}″`;
}

export function formatArea(squareMetres: number, system: MeasurementSystem) {
  if (system === 'metric') return `${squareMetres.toFixed(1)} m²`;
  return `${(squareMetres * 10.7639104167).toFixed(1)} ft²`;
}
