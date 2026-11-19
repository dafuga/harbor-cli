// @harness-uid u_q4zbame5nv
import type {ActionOptions} from '../../commands/action.js'

export interface RelayPaymentOptions extends ActionOptions {
  recipientKey: string
  relayContract: string
  yes?: boolean
}
