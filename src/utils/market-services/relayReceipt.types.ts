// @harness-uid u_wjz25kkfl5
export interface RelayReceipt {
  chain_id: string
  contract: string
  payer: string
  provider: string
  receipt_id: string
  ciphertext_hash: string
  bytes: number
  charge: string
  expires_at: number
}

export interface SignedRelayReceipt extends RelayReceipt {
  receipt_key: string
  signed_receipt: string
}
