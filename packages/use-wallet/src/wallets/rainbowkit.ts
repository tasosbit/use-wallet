import { WalletState, addWallet, setAccounts } from 'src/store'
import { LiquidEvmBaseWallet, LiquidEvmOptions } from 'src/wallets/liquid-evm-base'
import { WalletId } from 'src/wallets/types'
import type { WalletAccount, WalletConstructor } from 'src/wallets/types'
import {
  ALGORAND_CHAIN_ID,
  algorandChain,
  type SignTypedDataParams,
} from 'liquid-accounts-evm'
import type { Config as WagmiConfig } from '@wagmi/core'

export interface RainbowKitWalletOptions extends LiquidEvmOptions {
  /** wagmi Config instance, typically created with RainbowKit's getDefaultConfig() */
  wagmiConfig: WagmiConfig
  /**
   * Optional callback to connect an EVM wallet when none is connected.
   * The app can use this to open RainbowKit's connect modal.
   * Should resolve once the wallet is connected (wagmi state will be read after).
   */
  getEvmAccounts?: () => Promise<string[]>
}

const ICON = `data:image/svg+xml;base64,${btoa(`
<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="24" fill="url(#rk_bg)"/>
  <path d="M24 86V76.8C24 55.9 40.9 39 61.8 39H66C70.418 39 74 42.582 74 47V86" stroke="#FF4000" stroke-width="8" stroke-linecap="round" fill="none"/>
  <path d="M36 86V76.8C36 62.3 47.7 50.6 62.2 50.6H64C67.314 50.6 70 53.286 70 56.6V86" stroke="#FF9500" stroke-width="8" stroke-linecap="round" fill="none"/>
  <path d="M48 86V76.8C48 68.8 54.5 62.3 62.5 62.3H62.7C65.461 62.3 67.7 64.539 67.7 67.3V86" stroke="#00C853" stroke-width="8" stroke-linecap="round" fill="none"/>
  <path d="M60 86V76.8C60 75 61.5 73.5 63.3 73.5C65.1 73.5 66.6 75 66.6 76.8V86" stroke="#2979FF" stroke-width="8" stroke-linecap="round" fill="none"/>
  <defs>
    <linearGradient id="rk_bg" x1="0" y1="0" x2="120" y2="120">
      <stop stop-color="#1A1B23"/>
      <stop offset="1" stop-color="#13141B"/>
    </linearGradient>
  </defs>
</svg>
`)}`

export class RainbowKitWallet extends LiquidEvmBaseWallet {
  protected options: RainbowKitWalletOptions
  private _connecting = false

  constructor(params: WalletConstructor<WalletId.RAINBOWKIT>) {
    super(params)
    this.options = params.options || {} as RainbowKitWalletOptions

    if (!this.options.wagmiConfig) {
      throw new Error('RainbowKitWallet requires wagmiConfig in options')
    }

    // Ensure chain 4160 is always registered in the wagmi config so that
    // switchChain and signTypedData work without raw provider workarounds.
    this.ensureChainRegistered()
  }

  static defaultMetadata = {
    name: 'EVM Wallet',
    icon: ICON,
    isLiquid: 'EVM' as const
  }

  /** True while connect() is running. Prevents re-entrancy from bridge components. */
  public get isConnecting(): boolean {
    return this._connecting
  }

  /**
   * Set the getEvmAccounts callback after construction.
   *
   * RainbowKit's connect modal can only be opened via React hooks (useConnectModal)
   * rendered inside <RainbowKitProvider>, but WalletManager is constructed before
   * any React tree renders. This method lets WalletUIProvider create the bridge
   * callback internally and inject it into the wallet on mount — before any
   * user-initiated connect() call.
   */
  public setGetEvmAccounts(fn: () => Promise<string[]>): void {
    this.options.getEvmAccounts = fn
  }

  private get wagmiConfig(): WagmiConfig {
    return this.options.wagmiConfig
  }

  /**
   * If the Algorand chain (4160) isn't already in the wagmi config, add it.
   * This is needed so wagmi's switchChain and signTypedData work without
   * falling back to raw provider calls.
   */
  private ensureChainRegistered(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chains = this.wagmiConfig.chains as any as Array<{ id: number; [key: string]: any }>
    if (chains.some((c) => c.id === ALGORAND_CHAIN_ID)) {
      return
    }

    this.logger.info(`Registering Algorand chain (${ALGORAND_CHAIN_ID}) in wagmi config`)
    chains.push(algorandChain)
  }

  protected async initializeProvider(): Promise<void> {
    // wagmi handles provider initialization — nothing to do here
    this.logger.info('Using wagmi for EVM provider management')
  }

  /**
   * Get the raw EIP-1193 provider from the active wagmi connector.
   * Used by the base class's getEvmProvider and ensureAlgorandChain.
   */
  private async getRawProvider(): Promise<any> {
    const { getAccount } = await import('@wagmi/core')
    const account = getAccount(this.wagmiConfig)
    if (!account.connector) throw new Error('No EVM wallet connector available')
    return account.connector.getProvider()
  }

  public async getEvmProvider(): Promise<any> {
    return this.getRawProvider()
  }

  /**
   * Sign EIP-712 typed data using wagmi's signTypedData.
   *
   * wagmi's signTypedData does NOT validate the domain's chainId against the
   * connected chain — it simply forwards the typed data to the wallet via viem.
   * EIP-712 signing is chain-agnostic (the chain ID is in the typed data domain,
   * not in the RPC method), so this works regardless of which chain the wallet
   * reports being on.
   */
  protected async signWithProvider(typedData: SignTypedDataParams, evmAddress: string): Promise<string> {
    const { signTypedData } = await import('@wagmi/core')

    // Omit EIP712Domain from types — viem infers it from the domain object.
    // Passing it explicitly causes viem to map uint256→bigint for chainId,
    // conflicting with our number-typed domain.
    const { EIP712Domain: _, ...types } = typedData.types

    return signTypedData(this.wagmiConfig, {
      account: evmAddress as `0x${string}`,
      domain: typedData.domain,
      types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    })
  }

  /**
   * Build a connectorInfo object from a wagmi account, omitting undefined fields.
   * Uses `any` for the parameter to avoid exactOptionalPropertyTypes conflicts
   * with wagmi's discriminated union return types.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static extractConnectorInfo(account: any): { name?: string; icon?: string } {
    const info: { name?: string; icon?: string } = {}
    const connector = account?.connector
    if (typeof connector?.name === 'string') info.name = connector.name
    if (typeof connector?.icon === 'string') info.icon = connector.icon
    return info
  }

  /**
   * Read connected EVM accounts from wagmi state.
   * If not connected, tries the getEvmAccounts callback, then falls back to
   * connecting with the first available connector.
   *
   * When getEvmAccounts is provided, it is always called (to show the wallet
   * selection UI). The callback is responsible for any disconnect/reconnect
   * needed to present a fresh selection.
   */
  private async getConnectedEvmAddresses(): Promise<{ addresses: string[]; connectorInfo: { name?: string; icon?: string } }> {
    const { getAccount, connect: wagmiConnect } = await import('@wagmi/core')

    // If getEvmAccounts is provided, always call it — this is the "show me
    // a wallet picker" path.  The callback handles disconnect if needed.
    if (this.options.getEvmAccounts) {
      const addresses = await this.options.getEvmAccounts()
      if (addresses.length > 0) {
        const account = getAccount(this.wagmiConfig)
        const connectorInfo = RainbowKitWallet.extractConnectorInfo(account)
        if (account.isConnected && account.address) {
          return {
            addresses: account.addresses ? [...account.addresses] : [account.address],
            connectorInfo
          }
        }
        return { addresses, connectorInfo }
      }
    }

    // No callback — check wagmi state directly
    const account = getAccount(this.wagmiConfig)
    if (account.isConnected && account.address) {
      return {
        addresses: account.addresses ? [...account.addresses] : [account.address],
        connectorInfo: RainbowKitWallet.extractConnectorInfo(account)
      }
    }

    // Last resort: try connecting with the first available connector (e.g. injected/MetaMask)
    const connectors = this.wagmiConfig.connectors
    if (connectors.length > 0) {
      this.logger.info('Attempting connection with first available connector...')
      try {
        const result = await wagmiConnect(this.wagmiConfig, { connector: connectors[0] })
        const updatedAccount = getAccount(this.wagmiConfig)
        return {
          addresses: [...result.accounts],
          connectorInfo: RainbowKitWallet.extractConnectorInfo(updatedAccount)
        }
      } catch (error: any) {
        this.logger.warn('Auto-connect failed:', error.message)
      }
    }

    throw new Error('No EVM wallet connected. Please connect an EVM wallet first.')
  }

  /**
   * Apply connector info to wallet-level metadata so the UI displays
   * the actual wallet name/icon (e.g., "MetaMask") instead of the generic
   * "EVM Wallet".  Falls back to defaults when connector info is unavailable.
   */
  private applyConnectorMetadata(connectorInfo: { name?: string; icon?: string }): void {
    const updates: Partial<typeof RainbowKitWallet.defaultMetadata> = {}
    if (connectorInfo.name) updates.name = connectorInfo.name
    if (connectorInfo.icon) updates.icon = connectorInfo.icon
    if (updates.name || updates.icon) {
      this.updateMetadata(updates)
      this.logger.info(`Wallet metadata updated: ${updates.name ?? '(no name)'}`)
    }
  }

  public connect = async (): Promise<WalletAccount[]> => {
    // Re-entrancy guard — prevents EvmWalletBridge's onConnect from
    // triggering a second connect() while the first is still running.
    if (this._connecting) {
      this.logger.info('connect() already in progress, ignoring duplicate call')
      return []
    }
    this._connecting = true

    try {
      this.logger.info('Connecting...')

      await this.initializeEvmSdk()

      const { addresses: evmAddresses, connectorInfo } = await this.getConnectedEvmAddresses()
      this.logger.info(`Connected to ${evmAddresses.length} EVM account(s)`)

      this.applyConnectorMetadata(connectorInfo)

      const walletAccounts = await this.deriveAlgorandAccounts(evmAddresses, connectorInfo)
      const activeAccount = walletAccounts[0]

      const walletState: WalletState = {
        accounts: walletAccounts,
        activeAccount
      }

      addWallet(this.store, {
        walletId: this.id,
        wallet: walletState
      })

      this.logger.info('Connected.', walletState)
      this.notifyConnect(evmAddresses[0], activeAccount.address)
      return walletAccounts
    } finally {
      this._connecting = false
    }
  }

  public disconnect = async (): Promise<void> => {
    this.logger.info('Disconnecting...')

    try {
      const { disconnect: wagmiDisconnect } = await import('@wagmi/core')
      await wagmiDisconnect(this.wagmiConfig)
    } catch (error: any) {
      this.logger.warn('wagmi disconnect error:', error.message)
    }

    this.evmAddressMap.clear()
    this.updateMetadata(RainbowKitWallet.defaultMetadata)
    this.onDisconnect()

    this.logger.info('Disconnected')
  }

  public resumeSession = async (): Promise<void> => {
    const state = this.store.state
    const walletState = state.wallets[this.id]

    if (!walletState) {
      return
    }

    this.logger.info('Resuming session...')
    await this.initializeEvmSdk()

    const { getAccount, reconnect } = await import('@wagmi/core')

    try {
      await reconnect(this.wagmiConfig)
    } catch (err: any) {
      this.logger.warn('wagmi reconnect error (may be expected):', err.message)
    }

    const account = getAccount(this.wagmiConfig)

    let evmAddresses: string[]
    let connectorInfo: { name?: string; icon?: string }

    if (account.isConnected && account.address) {
      // Live wagmi state available
      evmAddresses = account.addresses ? [...account.addresses] : [account.address]
      connectorInfo = RainbowKitWallet.extractConnectorInfo(account)
    } else {
      // Wagmi not connected yet — resume from persisted EVM addresses.
      // RainbowKitBridge will call resumeSession() again once wagmi reconnects.
      this.logger.warn('EVM wallet not yet connected, resuming from persisted state')
      evmAddresses = walletState.accounts
        .map((a) => a.metadata?.evmAddress as string)
        .filter(Boolean)

      if (evmAddresses.length === 0) {
        this.logger.warn('No persisted EVM addresses, cannot resume')
        this.onDisconnect()
        return
      }
      connectorInfo = {}
    }

    // Fall back to persisted connector metadata if live metadata unavailable
    if (!connectorInfo.name && walletState.accounts.length > 0) {
      const first = walletState.accounts[0]
      const persistedName = first.metadata?.connectorName as string | undefined
      const persistedIcon = first.metadata?.connectorIcon as string | undefined
      if (persistedName) connectorInfo.name = persistedName
      if (persistedIcon) connectorInfo.icon = persistedIcon
    }
    this.applyConnectorMetadata(connectorInfo)

    await this.resumeWithAccounts(evmAddresses, (accounts) => {
      setAccounts(this.store, {
        walletId: this.id,
        accounts
      })
    }, connectorInfo)
  }
}
