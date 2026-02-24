import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { Store } from '@tanstack/store'
import algosdk from 'algosdk'
import type { LiquidEvmSdk, SignTypedDataParams } from 'liquid-accounts-evm'
import type { State } from 'src/store'
import { compareAccounts, flattenTxnGroup, isSignedTxn, isTransactionArray } from 'src/utils'
import { BaseWallet } from 'src/wallets/base'
import type {
  LiquidEvmMetadata,
  SignerTransaction,
  WalletAccount,
  WalletConstructor
} from 'src/wallets/types'

interface EvmAccount {
  evmAddress: string
  algorandAddress: string
}

export interface LiquidEvmOptions {
  uiHooks?: {
    onConnect?: (evmAccount: EvmAccount) => void
    onBeforeSign?: (
      txnGroup: algosdk.Transaction[] | Uint8Array[],
      indexesToSign?: number[]
    ) => Promise<void>
    onAfterSign?: (success: boolean, errorMessage?: string) => void
  }
}

/**
 * Abstract base class for EVM-based wallets that use the Liquid Accounts system
 * to derive Algorand addresses from EVM addresses.
 *
 * This class provides common functionality for:
 * - Initializing the Liquid EVM SDK
 * - Deriving Algorand accounts from EVM addresses
 * - Signing Algorand transactions using EVM signatures
 * - Managing the mapping between EVM and Algorand addresses
 *
 * Subclasses must implement provider-specific methods:
 * - initializeProvider(): Initialize the specific EVM wallet SDK/provider
 * - getEvmProvider(): Get the EVM provider instance
 * - signWithProvider(): Sign a message with the specific EVM wallet
 */
export abstract class LiquidEvmBaseWallet extends BaseWallet {
  protected liquidEvmSdk: LiquidEvmSdk | null = null
  protected algorandClient: AlgorandClient | null = null
  protected evmAddressMap: Map<string, string> = new Map() // algorandAddress -> evmAddress
  protected options: LiquidEvmOptions
  protected store: Store<State>

  constructor(params: WalletConstructor<any>) {
    super(params)
    this.options = params.options || {}
    this.store = params.store
  }

  /**
   * Default metadata for Liquid EVM wallets.
   * Subclasses MUST override this with their own metadata including isLiquid: "EVM"
   */
  static defaultMetadata: LiquidEvmMetadata

  /**
   * Typed metadata accessor that guarantees isLiquid: "EVM" is present
   */
  declare readonly metadata: LiquidEvmMetadata

  /**
   * Initialize the provider-specific SDK or connection.
   * Called during connect/resume to set up the wallet.
   */
  protected abstract initializeProvider(): Promise<void>

  /**
   * Get the EVM provider (EIP-1193 compatible).
   * Returns the provider object that can make eth_* RPC calls.
   * Consumers can use this for arbitrary EVM operations (e.g., bridge transactions).
   */
  public abstract getEvmProvider(): Promise<any>

  /**
   * Sign EIP-712 typed data with the specific EVM wallet provider.
   * @param typedData - The EIP-712 typed data (domain, types, primaryType, message)
   * @param evmAddress - The EVM address to sign with
   * @returns The signature as a hex string (with 0x prefix)
   */
  protected abstract signWithProvider(
    typedData: SignTypedDataParams,
    evmAddress: string
  ): Promise<string>

  /**
   * Ensure the wallet is on the Algorand chain (4160).
   * Queries the current chain first, and only switches/adds if needed.
   */
  protected async ensureAlgorandChain(): Promise<void> {
    const provider = await this.getEvmProvider()
    const { ALGORAND_CHAIN_ID_HEX, ALGORAND_EVM_CHAIN_CONFIG } = await import('liquid-accounts-evm')

    const currentChainId = (await provider.request({ method: 'eth_chainId' })) as string

    if (currentChainId === ALGORAND_CHAIN_ID_HEX) {
      return
    }

    this.logger.info(
      `Wrong chain (${currentChainId}), switching to Algorand (${ALGORAND_CHAIN_ID_HEX})...`
    )

    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ALGORAND_CHAIN_ID_HEX }]
      })
    } catch (switchError: any) {
      // 4902 = chain not added to wallet
      if (switchError.code === 4902) {
        this.logger.info('Algorand chain not found, adding it...')
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [ALGORAND_EVM_CHAIN_CONFIG]
        })
      } else {
        throw switchError
      }
    }
  }

  /**
   * Initialize the Liquid EVM SDK for deriving Algorand addresses
   */
  protected async initializeEvmSdk(): Promise<LiquidEvmSdk> {
    if (!this.liquidEvmSdk) {
      this.logger.info('Initializing Liquid EVM SDK...')

      if (!this.algorandClient) {
        const { AlgorandClient } = await import('@algorandfoundation/algokit-utils')
        const algodClient = this.getAlgodClient()
        this.algorandClient = AlgorandClient.fromClients({
          algod: algodClient
        })
      }

      const { LiquidEvmSdk } = await import('liquid-accounts-evm')
      this.liquidEvmSdk = new LiquidEvmSdk({ algorand: this.algorandClient })

      this.logger.info('Liquid EVM SDK initialized')
    }
    return this.liquidEvmSdk
  }

  /**
   * Derive Algorand accounts from EVM addresses
   */
  protected async deriveAlgorandAccounts(evmAddresses: string[]): Promise<WalletAccount[]> {
    const liquidEvmSdk = await this.initializeEvmSdk()
    const walletAccounts: WalletAccount[] = []

    for (let i = 0; i < evmAddresses.length; i++) {
      const evmAddress = evmAddresses[i]
      const algorandAddress = await liquidEvmSdk.getAddress({ evmAddress })

      this.evmAddressMap.set(algorandAddress, evmAddress)

      walletAccounts.push({
        name: `${this.metadata.name} ${evmAddress}`,
        address: algorandAddress,
        metadata: { evmAddress }
      })
    }

    return walletAccounts
  }

  /**
   * Convert bytes to hex string with 0x prefix
   */
  protected bytesToHex(bytes: Uint8Array): string {
    return (
      '0x' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    )
  }

  private processTxns(
    txnGroup: algosdk.Transaction[],
    indexesToSign?: number[]
  ): SignerTransaction[] {
    const txnsToSign: SignerTransaction[] = []

    txnGroup.forEach((txn, index) => {
      const isIndexMatch = !indexesToSign || indexesToSign.includes(index)
      const signer = txn.sender.toString()
      const canSignTxn = this.addresses.includes(signer)

      if (isIndexMatch && canSignTxn) {
        txnsToSign.push({ txn })
      } else {
        txnsToSign.push({ txn, signers: [] })
      }
    })

    return txnsToSign
  }

  private processEncodedTxns(
    txnGroup: Uint8Array[],
    indexesToSign?: number[]
  ): SignerTransaction[] {
    const txnsToSign: SignerTransaction[] = []

    txnGroup.forEach((txnBuffer, index) => {
      const decodedObj = algosdk.msgpackRawDecode(txnBuffer)
      const isSigned = isSignedTxn(decodedObj)

      const txn: algosdk.Transaction = isSigned
        ? algosdk.decodeSignedTransaction(txnBuffer).txn
        : algosdk.decodeUnsignedTransaction(txnBuffer)

      const isIndexMatch = !indexesToSign || indexesToSign.includes(index)
      const signer = txn.sender.toString()
      const canSignTxn = !isSigned && this.addresses.includes(signer)

      if (isIndexMatch && canSignTxn) {
        txnsToSign.push({ txn })
      } else {
        txnsToSign.push({ txn, signers: [] })
      }
    })

    return txnsToSign
  }

  /**
   * Sign Algorand transactions using EVM wallet signatures
   */
  public signTransactions = async <T extends algosdk.Transaction[] | Uint8Array[]>(
    txnGroup: T | T[],
    indexesToSign?: number[]
  ): Promise<(Uint8Array | null)[]> => {
    try {
      this.logger.debug('Signing transactions...', { txnGroup, indexesToSign })

      const liquidEvmSdk = await this.initializeEvmSdk()
      let txnsToSign: SignerTransaction[] = []

      // Determine type and process transactions for signing
      if (isTransactionArray(txnGroup)) {
        const flatTxns: algosdk.Transaction[] = flattenTxnGroup(txnGroup)
        txnsToSign = this.processTxns(flatTxns, indexesToSign)
      } else {
        const flatTxns: Uint8Array[] = flattenTxnGroup(txnGroup as Uint8Array[])
        txnsToSign = this.processEncodedTxns(flatTxns, indexesToSign)
      }

      // TODO get evm signers properly
      const firstTxn = txnsToSign[0]
      const algorandAddress = firstTxn.txn.sender.toString()
      const evmAddress = this.evmAddressMap.get(algorandAddress)

      if (!evmAddress) {
        throw new Error(`No EVM address found for Algorand address: ${algorandAddress}`)
      }

      const onBeforeSign = this.options.uiHooks?.onBeforeSign ?? this.managerUIHooks?.onBeforeSign
      if (onBeforeSign) {
        this.logger.debug('Running onBeforeSign hook', { txnGroup, indexesToSign })
        const txnsAsUint8 = txnsToSign.map(({ txn }) => algosdk.encodeUnsignedTransaction(txn))
        // important to pass the txns as Uint8Array to avoid package hazard issues. decode on the other end
        await onBeforeSign(txnsAsUint8, indexesToSign)
      }

      // Ensure we're on the Algorand chain before requesting signatures
      await this.ensureAlgorandChain()

      // Get a TransactionSigner for this EVM address
      const { signer: evmSigner } = await liquidEvmSdk.getSigner({
        evmAddress,
        signMessage: (typedData) => this.signWithProvider(typedData, evmAddress)
      })

      // Determine which indexes to sign (entries without signers: [] should be signed)
      const allTxns = txnsToSign.map((t) => t.txn)
      const signIndexes = txnsToSign.reduce<number[]>((acc, t, i) => {
        if (!('signers' in t)) acc.push(i)
        return acc
      }, [])

      // Sign all transactions in one call to avoid multiple wallet prompts
      const signedBlobs = await evmSigner(allTxns, signIndexes)

      const onAfterSign = this.options.uiHooks?.onAfterSign ?? this.managerUIHooks?.onAfterSign
      if (onAfterSign) {
        this.logger.debug('Running onAfterSign hook')
        try {
          onAfterSign(true)
        } catch (e) {}
      }

      // Map signed blobs back to full array with nulls for unsigned txns
      let signedIdx = 0
      const result: (Uint8Array | null)[] = txnsToSign.map((_, index) => {
        if (signIndexes.includes(index)) {
          return signedBlobs[signedIdx++]
        }
        return null
      })

      this.logger.debug('Transactions signed successfully', result)
      return result
    } catch (error: any) {
      try {
        const onAfterSignCleanup =
          this.options.uiHooks?.onAfterSign ?? this.managerUIHooks?.onAfterSign
        onAfterSignCleanup?.(false, error.message)
      } catch (e) {}
      this.logger.error('Error signing transactions:', error.message)
      throw error
    }
  }

  /**
   * Helper to compare and update accounts if needed during session resume
   */
  protected async resumeWithAccounts(
    evmAddresses: string[],
    setAccountsFn: (accounts: WalletAccount[]) => void
  ): Promise<void> {
    const state = this.store.state
    const walletState = state.wallets[this.id]

    if (!walletState) {
      this.logger.info('No session to resume')
      return
    }

    // Rebuild evmAddressMap from persisted account metadata
    for (const account of walletState.accounts) {
      const evmAddr = account.metadata?.evmAddress as string | undefined
      if (evmAddr) {
        this.evmAddressMap.set(account.address, evmAddr)
      }
    }

    const walletAccounts = await this.deriveAlgorandAccounts(evmAddresses)
    const match = compareAccounts(walletAccounts, walletState.accounts)

    if (!match) {
      this.logger.warn('Session accounts mismatch, updating accounts', {
        prev: walletState.accounts,
        current: walletAccounts
      })
      setAccountsFn(walletAccounts)
    }

    this.logger.info('Session resumed')
  }

  protected notifyConnect(evmAddress: string, algorandAddress: string): void {
    const onConnect = this.options.uiHooks?.onConnect ?? this.managerUIHooks?.onConnect
    if (onConnect) {
      onConnect({ evmAddress, algorandAddress })
    }
  }
}
