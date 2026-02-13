import algosdk from 'algosdk'
import { WalletState, addWallet, setAccounts, type State } from 'src/store'
import { compareAccounts, flattenTxnGroup, isSignedTxn, isTransactionArray } from 'src/utils'
import { BaseWallet } from 'src/wallets/base'
import { WalletId } from 'src/wallets/types'
import type { MetaMaskSDK } from '@metamask/sdk'
import type { SDKProvider } from '@metamask/sdk'
import type { Store } from '@tanstack/store'
import type { WalletAccount, WalletConstructor } from 'src/wallets/types'
import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { LiquidEvmSdk } from 'liquid-accounts-evm'

export interface MetaMaskWalletOptions {
  dappMetadata?: {
    name?: string
    url?: string
    iconUrl?: string
  }
}

const ICON = `data:image/svg+xml;base64,${btoa(`
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 142 136.878" style="enable-background:new 0 0 142 136.878;" xml:space="preserve">
<path style="fill:#FF5C16;" d="M132.682,132.192l-30.583-9.106l-23.063,13.787l-16.092-0.007l-23.077-13.78l-30.569,9.106L0,100.801
	l9.299-34.839L0,36.507L9.299,0l47.766,28.538h27.85L132.682,0l9.299,36.507l-9.299,29.455l9.299,34.839L132.682,132.192
	L132.682,132.192z"/>
<path style="fill:#FF5C16;" d="M9.305,0l47.767,28.558l-1.899,19.599L9.305,0z M39.875,100.814l21.017,16.01l-21.017,6.261
	C39.875,123.085,39.875,100.814,39.875,100.814z M59.212,74.345l-4.039-26.174L29.317,65.97l-0.014-0.007v0.013l0.08,18.321
	l10.485-9.951L59.212,74.345L59.212,74.345z M132.682,0L84.915,28.558l1.893,19.599L132.682,0z M102.113,100.814l-21.018,16.01
	l21.018,6.261V100.814z M112.678,65.975h0.007H112.678v-0.013l-0.006,0.007L86.815,48.171l-4.039,26.174h19.336l10.492,9.95
	C112.604,84.295,112.678,65.975,112.678,65.975z"/>
<path style="fill:#E34807;" d="M39.868,123.085l-30.569,9.106L0,100.814h39.868C39.868,100.814,39.868,123.085,39.868,123.085z
	 M59.205,74.338l5.839,37.84l-8.093-21.04L29.37,84.295l10.491-9.956h19.344L59.205,74.338z M102.112,123.085l30.57,9.106
	l9.299-31.378h-39.869C102.112,100.814,102.112,123.085,102.112,123.085z M82.776,74.338l-5.839,37.84l8.092-21.04l27.583-6.843
	l-10.498-9.956H82.776V74.338z"/>
<path style="fill:#FF8D5D;" d="M0,100.801l9.299-34.839h19.997l0.073,18.327l27.584,6.843l8.092,21.039l-4.16,4.633l-21.017-16.01H0
	V100.801z M141.981,100.801l-9.299-34.839h-19.998l-0.073,18.327l-27.582,6.843l-8.093,21.039l4.159,4.633l21.018-16.01h39.868
	V100.801z M84.915,28.538h-27.85l-1.891,19.599l9.872,64.013h11.891l9.878-64.013L84.915,28.538z"/>
<path style="fill:#661800;" d="M9.299,0L0,36.507l9.299,29.455h19.997l25.87-17.804L9.299,0z M53.426,81.938h-9.059l-4.932,4.835
	l17.524,4.344l-3.533-9.186V81.938z M132.682,0l9.299,36.507l-9.299,29.455h-19.998L86.815,48.158L132.682,0z M88.568,81.938h9.072
	l4.932,4.841l-17.544,4.353l3.54-9.201V81.938z M79.029,124.385l2.067-7.567l-4.16-4.633h-11.9l-4.159,4.633l2.066,7.567"/>
<path style="fill:#C0C4CD;" d="M79.029,124.384v12.495H62.945v-12.495L79.029,124.384L79.029,124.384z"/>
<path style="fill:#E7EBF6;" d="M39.875,123.072l23.083,13.8v-12.495l-2.067-7.566C60.891,116.811,39.875,123.072,39.875,123.072z
	 M102.113,123.072l-23.084,13.8v-12.495l2.067-7.566C81.096,116.811,102.113,123.072,102.113,123.072z"/>
</svg>
`)}`

export class MetaMaskWallet extends BaseWallet {
  private metamaskSdk: MetaMaskSDK | null = null
  private provider: SDKProvider | null = null
  private options: MetaMaskWalletOptions
  private liquidEvmSdk: LiquidEvmSdk | null = null
  private algorandClient: AlgorandClient | null = null
  private evmAddressMap: Map<string, string> = new Map() // algorandAddress -> evmAddress

  protected store: Store<State>

  constructor({
    id,
    store,
    subscribe,
    getAlgodClient,
    options = {},
    metadata = {}
  }: WalletConstructor<WalletId.METAMASK>) {
    super({ id, metadata, getAlgodClient, store, subscribe })
    this.options = options
    this.store = store
  }

  static defaultMetadata = {
    name: 'MetaMask',
    icon: ICON
  }

  private async initializeMetamaskSDK(): Promise<MetaMaskSDK> {
    if (!this.metamaskSdk) {
      this.logger.info('Initializing MetaMask SDK...')
      const { MetaMaskSDK } = await import('@metamask/sdk')

      this.metamaskSdk = new MetaMaskSDK({
        dappMetadata: {
          name: this.options.dappMetadata?.name || 'Algorand dApp',
          url: this.options.dappMetadata?.url || (typeof window !== 'undefined' ? window.location.href : ''),
          ...(this.options.dappMetadata?.iconUrl && { iconUrl: this.options.dappMetadata.iconUrl })
        }
      })

      this.logger.info('MetaMask SDK initialized')
    }
    return this.metamaskSdk
  }

  private async getProvider(): Promise<SDKProvider> {
    if (!this.provider) {
      const sdk = await this.initializeMetamaskSDK()
      this.provider = sdk.getProvider() || null

      if (!this.provider) {
        throw new Error('MetaMask provider not available. Please install MetaMask.')
      }
    }
    return this.provider
  }

  private async initializeEvmSdk(): Promise<LiquidEvmSdk> {
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

  private async deriveAlgorandAccounts(evmAddresses: string[]): Promise<WalletAccount[]> {
    const liquidEvmSdk = await this.initializeEvmSdk()
    const walletAccounts: WalletAccount[] = []

    for (let i = 0; i < evmAddresses.length; i++) {
      const evmAddress = evmAddresses[i]
      const algorandAddress = await liquidEvmSdk.getAddress({ evmAddress })

      this.evmAddressMap.set(algorandAddress, evmAddress)

      walletAccounts.push({
        name: `${this.metadata.name} Account ${i + 1}`,
        address: algorandAddress
      })
    }

    return walletAccounts
  }

  private bytesToHex(bytes: Uint8Array): string {
    return '0x' + Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  private async signWithMetaMask(message: Uint8Array, evmAddress: string): Promise<string> {
    const provider = await this.getProvider()

    const hexMessage = this.bytesToHex(message)

    try {
      const signature = await provider.request({
        method: 'personal_sign',
        params: [hexMessage, evmAddress]
      }) as string

      return signature
    } catch (error: any) {
      if (error.code === 4001) {
        throw new Error('User rejected the signing request')
      }
      throw error
    }
  }

  public connect = async (): Promise<WalletAccount[]> => {
    this.logger.info('Connecting...')

    await this.initializeMetamaskSDK()
    await this.initializeEvmSdk()

    const provider = await this.getProvider()

    try {
      // Request permissions to force account selection prompt
      this.logger.info('Requesting MetaMask permissions...')
      await provider.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }]
      })
    } catch (error: any) {
      // wallet_requestPermissions might not be supported in all versions
      // Fall back to eth_requestAccounts which will prompt if no permission exists
      this.logger.warn('wallet_requestPermissions not supported, falling back to eth_requestAccounts')
    }

    const evmAddresses = await provider.request({
      method: 'eth_requestAccounts'
    }) as string[]

    if (evmAddresses.length === 0) {
      this.logger.error('No accounts found!')
      throw new Error('No accounts found!')
    }

    this.logger.info(`Connected to ${evmAddresses.length} EVM account(s)`)

    const walletAccounts = await this.deriveAlgorandAccounts(evmAddresses)
    const activeAccount = walletAccounts[0]

    const walletState: WalletState = {
      accounts: walletAccounts,
      activeAccount
    }

    addWallet(this.store, {
      walletId: this.id,
      wallet: walletState
    })

    this.logger.info('✅ Connected.', walletState)
    return walletAccounts
  }

  public disconnect = async (): Promise<void> => {
    this.logger.info('Disconnecting...')

    // Clear provider reference to ensure fresh provider retrieval on reconnect
    // Keep SDK instance alive - wallet_requestPermissions will handle account selection
    this.provider = null
    this.evmAddressMap.clear()
    this.onDisconnect()

    this.logger.info('Disconnected')
  }

  public resumeSession = async (): Promise<void> => {
    try {
      const state = this.store.state
      const walletState = state.wallets[this.id]

      if (!walletState) {
        this.logger.info('No session to resume')
        return
      }

      this.logger.info('Resuming session...')

      await this.initializeMetamaskSDK()
      await this.initializeEvmSdk()

      const provider = await this.getProvider()

      const evmAddresses = await provider.request({
        method: 'eth_accounts'
      }) as string[]

      if (evmAddresses.length === 0) {
        this.logger.error('No accounts found!')
        throw new Error('No accounts found!')
      }

      const walletAccounts = await this.deriveAlgorandAccounts(evmAddresses)
      const match = compareAccounts(walletAccounts, walletState.accounts)

      if (!match) {
        this.logger.warn('Session accounts mismatch, updating accounts', {
          prev: walletState.accounts,
          current: walletAccounts
        })
        setAccounts(this.store, {
          walletId: this.id,
          accounts: walletAccounts
        })
      }

      this.logger.info('Session resumed')
    } catch (error: any) {
      this.logger.error('Error resuming session:', error.message)
      this.onDisconnect()
      throw error
    }
  }

  private processTxns(
    txnGroup: algosdk.Transaction[],
    indexesToSign?: number[]
  ): algosdk.Transaction[] {
    const txnsToSign: algosdk.Transaction[] = []

    txnGroup.forEach((txn, index) => {
      const isIndexMatch = !indexesToSign || indexesToSign.includes(index)
      const signer = txn.sender.toString()
      const canSignTxn = this.addresses.includes(signer)

      if (isIndexMatch && canSignTxn) {
        txnsToSign.push(txn)
      }
    })

    return txnsToSign
  }

  private processEncodedTxns(
    txnGroup: Uint8Array[],
    indexesToSign?: number[]
  ): algosdk.Transaction[] {
    const txnsToSign: algosdk.Transaction[] = []

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
        txnsToSign.push(txn)
      }
    })

    return txnsToSign
  }

  public signTransactions = async <T extends algosdk.Transaction[] | Uint8Array[]>(
    txnGroup: T | T[],
    indexesToSign?: number[]
  ): Promise<(Uint8Array | null)[]> => {
    try {
      this.logger.debug('Signing transactions...', { txnGroup, indexesToSign })

      const evmSdk = await this.initializeEvmSdk()
      let flatTxns: algosdk.Transaction[] = []

      if (isTransactionArray(txnGroup)) {
        flatTxns = flattenTxnGroup(txnGroup)
      } else {
        const flatEncoded: Uint8Array[] = flattenTxnGroup(txnGroup as Uint8Array[])
        flatTxns = flatEncoded.map(txnBuffer => {
          const decodedObj = algosdk.msgpackRawDecode(txnBuffer)
          const isSigned = isSignedTxn(decodedObj)
          return isSigned
            ? algosdk.decodeSignedTransaction(txnBuffer).txn
            : algosdk.decodeUnsignedTransaction(txnBuffer)
        })
      }

      const txnsToSign = isTransactionArray(txnGroup)
        ? this.processTxns(flatTxns, indexesToSign)
        : this.processEncodedTxns(flattenTxnGroup(txnGroup as Uint8Array[]), indexesToSign)

      if (txnsToSign.length === 0) {
        this.logger.debug('No transactions to sign')
        return flatTxns.map(() => null)
      }

      // Get the EVM address (all txns should be from the same wallet account)
      const firstTxn = txnsToSign[0]
      const algorandAddress = firstTxn.sender.toString()
      const evmAddress = this.evmAddressMap.get(algorandAddress)

      if (!evmAddress) {
        throw new Error(`No EVM address found for Algorand address: ${algorandAddress}`)
      }

      // Sign all transactions in one call to avoid multiple MetaMask prompts
      const signedBlobs = await evmSdk.signTxn({
        evmAddress,
        txns: flatTxns,
        signMessage: (msg) => this.signWithMetaMask(msg, evmAddress)
      })

      // Build result array - use signed txns where we should sign, null otherwise
      const result: (Uint8Array | null)[] = flatTxns.map((txn, index) => {
        const isIndexMatch = !indexesToSign || indexesToSign.includes(index)
        const signer = txn.sender.toString()
        const canSignTxn = this.addresses.includes(signer)

        if (isIndexMatch && canSignTxn) {
          return signedBlobs[index]
        }
        return null
      })

      this.logger.debug('Transactions signed successfully', result)
      return result
    } catch (error: any) {
      this.logger.error('Error signing transactions:', error.message)
      throw error
    }
  }
}
