import { WalletState, addWallet, setAccounts } from 'src/store'
import { LiquidEvmBaseWallet, LiquidEvmOptions } from 'src/wallets/liquid-evm-base'
import { WalletId } from 'src/wallets/types'
import type { WalletAccount, WalletConstructor } from 'src/wallets/types'
import type { SignTypedDataParams } from 'liquid-accounts-evm'
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

// Official Ethereum diamond logo (ethereum.org brand assets, eth-diamond-purple.svg)
// Paths scaled to fit a 120x120 canvas via nested SVG viewBox mapping.
// Background: #627EEA (Ethereum brand blue). Faces in white with original relative opacity.
const ICON = `data:image/svg+xml;base64,${btoa(`
<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="24" fill="#627EEA"/>
  <svg x="30" y="11" width="60" height="98" viewBox="420.1 80.7 1079.8 1758.6">
    <path d="m959.8 80.7-539.7 895.6 539.7-245.3z" fill="white"/>
    <path d="m959.8 731-539.7 245.3 539.7 319.1z" fill="white" fill-opacity=".602"/>
    <path d="m1499.6 976.3-539.8-895.6v650.3z" fill="white" fill-opacity=".602"/>
    <path d="m959.8 1295.4 539.8-319.1-539.8-245.3z" fill="white" fill-opacity=".2"/>
    <path d="m420.1 1078.7 539.7 760.6v-441.7z" fill="white"/>
    <path d="m959.8 1397.6v441.7l540.1-760.6z" fill="white" fill-opacity=".602"/>
  </svg>
</svg>
`)}`

export class RainbowKitWallet extends LiquidEvmBaseWallet {
  protected options: RainbowKitWalletOptions
  private _connecting = false
  private _disconnecting = false

  /** True while disconnect() is running. Used by the bridge to prevent re-entrancy. */
  public get isDisconnecting(): boolean {
    return this._disconnecting
  }

  constructor(params: WalletConstructor<WalletId.RAINBOWKIT>) {
    super(params)
    this.options = params.options || {} as RainbowKitWalletOptions

    if (!this.options.wagmiConfig) {
      throw new Error('RainbowKitWallet requires wagmiConfig in options')
    }
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

  protected async initializeProvider(): Promise<void> {
    // wagmi handles provider initialization — nothing to do here
    this.logger.info('Using wagmi for EVM provider management')
  }

  /**
   * Get the raw EIP-1193 provider from the active wagmi connector.
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
   * Sign EIP-712 typed data via the raw EIP-1193 provider.
   *
   * Bypasses wagmi's signTypedData (which requires the wallet's current chain
   * to be in the wagmi config) and calls eth_signTypedData_v4 directly.
   * Since the EIP-712 domain has no chainId, signing is truly chain-agnostic
   * and works regardless of which chain the wallet is on.
   */
  protected async signWithProvider(typedData: SignTypedDataParams, evmAddress: string): Promise<string> {
    const provider = await this.getRawProvider()

    const data = JSON.stringify({
      types: typedData.types,
      domain: typedData.domain,
      primaryType: typedData.primaryType,
      message: typedData.message,
    })

    this.logger.info('Requesting eth_signTypedData_v4', { evmAddress, domain: typedData.domain, primaryType: typedData.primaryType })

    const signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [evmAddress, data],
    })

    this.logger.info('Received signature', { signature: signature?.slice(0, 20) + '...' })
    return signature
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
    this._disconnecting = true
    this.logger.info('Disconnecting...')

    try {
      const { disconnect: wagmiDisconnect } = await import('@wagmi/core')
      await wagmiDisconnect(this.wagmiConfig)
    } catch (error: any) {
      this.logger.warn('wagmi disconnect error:', error.message)
    } finally {
      this._disconnecting = false
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
    } else if (account.status === 'reconnecting') {
      // Wagmi's own auto-reconnect is still in flight — use persisted addresses temporarily.
      // RainbowKitBridge will call resumeSession() again once wagmi connects.
      this.logger.warn('EVM wallet reconnecting, resuming from persisted state')
      evmAddresses = walletState.accounts
        .map((a) => a.metadata?.evmAddress as string)
        .filter(Boolean)

      if (evmAddresses.length === 0) {
        this.logger.warn('No persisted EVM addresses, cannot resume')
        this.onDisconnect()
        return
      }
      connectorInfo = {}
    } else {
      // account.status === 'disconnected' — reconnect definitively failed (e.g. wallet
      // locked after days, session expired). Disconnect cleanly so the user is prompted
      // to reconnect rather than seeing a confusing signing error later.
      this.logger.warn('EVM wallet reconnect failed (status: disconnected), disconnecting')
      this.onDisconnect()
      return
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
