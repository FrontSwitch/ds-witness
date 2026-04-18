import { getDatasetMeta, type SeverityBand } from './questions'

export type { SeverityBand }

export interface DatasetConfig {
  scaleLabels: string[]
  preamble?: string
  severityBands?: SeverityBand[]
}

const DEFAULT_SCALE_LABELS = ['Never', 'Rarely', 'Monthly', 'Weekly', 'Almost daily']

export function getDatasetConfig(dataset: string): DatasetConfig {
  const meta = getDatasetMeta(dataset)
  return {
    scaleLabels: meta.scaleLabels ?? DEFAULT_SCALE_LABELS,
    preamble: meta.preamble,
    severityBands: meta.severityBands,
  }
}

export function getSeverityBand(dataset: string, score: number): SeverityBand | null {
  const bands = getDatasetMeta(dataset).severityBands
  if (!bands) return null
  return bands.find(b => score >= b.min && score <= b.max) ?? null
}
