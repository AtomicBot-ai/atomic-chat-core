import type {
  FastFlowLmOperation,
  FastFlowLmHostStep,
  FastFlowLmHostReceipt,
} from '../../../contracts/index.js'
import type { FlmManifest } from './manifest.js'
import { FlmJournal } from '../journal.js'
export interface PreparationRecord {
  operation: FastFlowLmOperation
  device: string | null
  build: string | null
  approvedManifest: FlmManifest | null
  unclaimedStep?: FastFlowLmHostStep
  owner?: string
  boot: string | null
  lastReceipt: FastFlowLmHostReceipt | null
}
export class PreparationJournal extends FlmJournal<PreparationRecord> {
  constructor(dir: string, dataRoot?: string) {
    super(dir, (r) => r.operation.operation_id, dataRoot)
  }
}
