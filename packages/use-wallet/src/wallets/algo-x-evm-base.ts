import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { Store } from '@tanstack/store'
import algosdk from 'algosdk'
import type { AlgoXEvmSdk, SignTypedDataParams } from 'algo-x-evm-sdk'
import type { State } from 'src/store'
import { compareAccounts, flattenTxnGroup, isSignedTxn, isTransactionArray } from 'src/utils'
import { BaseWallet } from 'src/wallets/base'
import type {
  AlgoXEvmMetadata,
  SignerTransaction,
  WalletAccount,
  WalletConstructor
} from 'src/wallets/types'

interface EvmAccount {
  evmAddress: string
  algorandAddress: string
}

export interface AlgoXEvmOptions {
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
 * Abstract base class for EVM-based wallets that use the xChain EVM system
 * to derive Algorand addresses from EVM addresses.
 *
 * This class provides common functionality for:
 * - Initializing the xChain EVM SDK
 * - Deriving Algorand accounts from EVM addresses
 * - Signing Algorand transactions using EVM signatures
 * - Managing the mapping between EVM and Algorand addresses
 *
 * Subclasses must implement provider-specific methods:
 * - initializeProvider(): Initialize the specific EVM wallet SDK/provider
 * - getEvmProvider(): Get the EVM provider instance
 * - signWithProvider(): Sign a message with the specific EVM wallet
 */
export abstract class AlgoXEvmBaseWallet extends BaseWallet {
  protected algoXEvmSdk: AlgoXEvmSdk | null = null
  protected algorandClient: AlgorandClient | null = null
  protected evmAddressMap: Map<string, string> = new Map() // algorandAddress -> evmAddress
  protected options: AlgoXEvmOptions
  protected store: Store<State>

  constructor(params: WalletConstructor<any>) {
    super(params)
    this.options = params.options || {}
    this.store = params.store
  }

  /**
   * Default metadata for xChain EVM wallets.
   * Subclasses MUST override this with their own metadata including isAlgoXEvm: "EVM"
   */
  static defaultMetadata: AlgoXEvmMetadata

  /**
   * Typed metadata accessor that guarantees isAlgoXEvm: "EVM" is present
   */
  declare readonly metadata: AlgoXEvmMetadata

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
   * Initialize the xChain EVM SDK for deriving Algorand addresses
   */
  protected async initializeEvmSdk(): Promise<AlgoXEvmSdk> {
    if (!this.algoXEvmSdk) {
      this.logger.info('Initializing xChain EVM SDK...')

      if (!this.algorandClient) {
        const { AlgorandClient } = await import('@algorandfoundation/algokit-utils')
        const algodClient = this.getAlgodClient()
        this.algorandClient = AlgorandClient.fromClients({
          algod: algodClient
        })
      }

      const { AlgoXEvmSdk } = await import('algo-x-evm-sdk')
      this.algoXEvmSdk = new AlgoXEvmSdk({ algorand: this.algorandClient })

      this.logger.info('xChain EVM SDK initialized')
    }
    return this.algoXEvmSdk
  }

  /**
   * Derive Algorand accounts from EVM addresses.
   * @param evmAddresses - EVM addresses to derive Algorand accounts from
   * @param connectorInfo - Optional connector name/icon to include in account metadata
   */
  protected async deriveAlgorandAccounts(
    evmAddresses: string[],
    connectorInfo?: { name?: string; icon?: string }
  ): Promise<WalletAccount[]> {
    const algoXEvmSdk = await this.initializeEvmSdk()
    const walletAccounts: WalletAccount[] = []

    for (let i = 0; i < evmAddresses.length; i++) {
      const evmAddress = evmAddresses[i]
      const algorandAddress = await algoXEvmSdk.getAddress({ evmAddress })

      this.evmAddressMap.set(algorandAddress, evmAddress)

      const metadata: Record<string, unknown> = { evmAddress }
      if (connectorInfo?.name) metadata.connectorName = connectorInfo.name
      if (connectorInfo?.icon) metadata.connectorIcon = connectorInfo.icon

      walletAccounts.push({
        name: `${this.metadata.name} ${evmAddress}`,
        address: algorandAddress,
        metadata
      })
    }

    return walletAccounts
  }

  /**
   * Process transaction group to extract transactions that need signing
   */
  protected processTxns(
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

      const algoXEvmSdk = await this.initializeEvmSdk()
      let txnsToSign: SignerTransaction[] = []

      // Determine type and process transactions for signing
      if (isTransactionArray(txnGroup)) {
        const flatTxns: algosdk.Transaction[] = flattenTxnGroup(txnGroup)
        txnsToSign = this.processTxns(flatTxns, indexesToSign)
      } else {
        const flatTxns: Uint8Array[] = flattenTxnGroup(txnGroup as Uint8Array[])
        txnsToSign = this.processEncodedTxns(flatTxns, indexesToSign)
      }

      // Ensure evmAddressMap is populated (fallback to persisted account metadata)
      const walletState = this.store.state.wallets[this.id]
      if (walletState) {
        for (const account of walletState.accounts) {
          const addr = account.metadata?.evmAddress as string | undefined
          if (addr && !this.evmAddressMap.has(account.address)) {
            this.evmAddressMap.set(account.address, addr)
          }
        }
      }

      // Build full transaction array and determine which indexes need signing
      const allTxns = txnsToSign.map((t) => t.txn)
      const signIndexes = txnsToSign.reduce<number[]>((acc, t, i) => {
        if (!('signers' in t)) acc.push(i)
        return acc
      }, [])

      // Group sign indexes by EVM address (one wallet prompt per unique signer)
      const evmGroups = new Map<string, number[]>()
      for (const idx of signIndexes) {
        const algorandAddress = allTxns[idx].sender.toString()
        const evmAddress = this.evmAddressMap.get(algorandAddress)
        if (!evmAddress) {
          throw new Error(`No EVM address found for Algorand address: ${algorandAddress}`)
        }
        const group = evmGroups.get(evmAddress)
        if (group) {
          group.push(idx)
        } else {
          evmGroups.set(evmAddress, [idx])
        }
      }

      const onBeforeSign = this.options.uiHooks?.onBeforeSign ?? this.managerUIHooks?.onBeforeSign
      if (onBeforeSign) {
        this.logger.debug('Running onBeforeSign hook', { txnGroup, indexesToSign })
        const txnsAsUint8 = txnsToSign.map(({ txn }) => algosdk.encodeUnsignedTransaction(txn))
        // important to pass the txns as Uint8Array to avoid package hazard issues. decode on the other end
        await onBeforeSign(txnsAsUint8, indexesToSign)
      }

      // Sign transactions grouped by EVM address
      const signedResult: (Uint8Array | null)[] = new Array(txnsToSign.length).fill(null)
      console.log('EVM Groups for signing:', evmGroups)
      for (const [evmAddress, indexes] of evmGroups) {
        const { signer: evmSigner } = await algoXEvmSdk.getSigner({
          evmAddress,
          signMessage: (typedData) => this.signWithProvider(typedData, evmAddress)
        })

        const signedBlobs = await evmSigner(allTxns, indexes)

        for (let i = 0; i < indexes.length; i++) {
          signedResult[indexes[i]] = signedBlobs[i]
        }
      }

      const onAfterSign = this.options.uiHooks?.onAfterSign ?? this.managerUIHooks?.onAfterSign
      if (onAfterSign) {
        this.logger.debug('Running onAfterSign hook')
        try {
          onAfterSign(true)
        } catch (e) {}
      }

      this.logger.debug('Transactions signed successfully', signedResult)
      return signedResult
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
    setAccountsFn: (accounts: WalletAccount[]) => void,
    connectorInfo?: { name?: string; icon?: string }
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

    const walletAccounts = await this.deriveAlgorandAccounts(evmAddresses, connectorInfo)
    const match = compareAccounts(walletAccounts, walletState.accounts)

    if (!match) {
      this.logger.warn('Session accounts mismatch, updating accounts', {
        prev: walletState.accounts,
        current: walletAccounts
      })
    }

    // Always update accounts so that fresh connector metadata (name, icon) propagates
    // to the reactive store even when addresses haven't changed.
    setAccountsFn(walletAccounts)

    this.logger.info('Session resumed')
  }

  protected notifyConnect(evmAddress: string, algorandAddress: string): void {
    const onConnect = this.options.uiHooks?.onConnect ?? this.managerUIHooks?.onConnect
    if (onConnect) {
      onConnect({ evmAddress, algorandAddress })
    }
  }
}
