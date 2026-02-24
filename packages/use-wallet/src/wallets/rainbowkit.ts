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

  private get wagmiConfig(): WagmiConfig {
    return this.options.wagmiConfig
  }

  protected async initializeProvider(): Promise<void> {
    // wagmi handles provider initialization — nothing to do here
    this.logger.info('Using wagmi for EVM provider management')
  }

  public async getEvmProvider(): Promise<any> {
    const { getConnectorClient } = await import('@wagmi/core')
    return getConnectorClient(this.wagmiConfig)
  }

  protected async signWithProvider(typedData: SignTypedDataParams, evmAddress: string): Promise<string> {
    const { signTypedData } = await import('@wagmi/core')

    // wagmi auto-derives EIP712Domain from the domain parameter, so strip it
    const { EIP712Domain, ...types } = typedData.types

    return signTypedData(this.wagmiConfig, {
      domain: typedData.domain as any,
      types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      account: evmAddress as `0x${string}`
    })
  }

  protected override async ensureAlgorandChain(): Promise<void> {
    const { getAccount, switchChain } = await import('@wagmi/core')
    const { ALGORAND_CHAIN_ID } = await import('liquid-accounts-evm')

    const account = getAccount(this.wagmiConfig)
    if (account.chainId === ALGORAND_CHAIN_ID) {
      return
    }

    this.logger.info(`Wrong chain (${account.chainId}), switching to Algorand (${ALGORAND_CHAIN_ID})...`)

    try {
      await switchChain(this.wagmiConfig, { chainId: ALGORAND_CHAIN_ID })
    } catch (error: any) {
      // EIP-712 signing is chain-agnostic (chain ID is embedded in the domain),
      // so we can continue even if switching fails.
      this.logger.warn('Chain switch failed, continuing with signing:', error.message)
    }
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
   * Also returns connector metadata (name/icon) for the underlying wallet.
   */
  private async getConnectedEvmAddresses(): Promise<{ addresses: string[]; connectorInfo: { name?: string; icon?: string } }> {
    const { getAccount, connect: wagmiConnect } = await import('@wagmi/core')

    let account = getAccount(this.wagmiConfig)

    if (account.isConnected && account.address) {
      return {
        addresses: account.addresses ? [...account.addresses] : [account.address],
        connectorInfo: RainbowKitWallet.extractConnectorInfo(account)
      }
    }

    // Try app-provided callback (e.g. opens RainbowKit modal)
    if (this.options.getEvmAccounts) {
      const addresses = await this.options.getEvmAccounts()
      if (addresses.length > 0) {
        // Re-read state after callback
        account = getAccount(this.wagmiConfig)
        const connectorInfo = RainbowKitWallet.extractConnectorInfo(account)
        if (account.isConnected && account.address) {
          return {
            addresses: account.addresses ? [...account.addresses] : [account.address],
            connectorInfo
          }
        }
        // If callback returned addresses directly but wagmi isn't synced yet
        return { addresses, connectorInfo }
      }
    }

    // Last resort: try connecting with the first available connector (e.g. injected/MetaMask)
    const connectors = this.wagmiConfig.connectors
    if (connectors.length > 0) {
      this.logger.info('Attempting connection with first available connector...')
      try {
        const result = await wagmiConnect(this.wagmiConfig, { connector: connectors[0] })
        account = getAccount(this.wagmiConfig)
        return {
          addresses: [...result.accounts],
          connectorInfo: RainbowKitWallet.extractConnectorInfo(account)
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
    this.logger.info('Connecting...')

    await this.initializeEvmSdk()

    const { addresses: evmAddresses, connectorInfo } = await this.getConnectedEvmAddresses()
    this.logger.info(`Connected to ${evmAddresses.length} EVM account(s)`)

    // Update wallet-level metadata with actual connector name/icon before
    // deriving accounts (so account names reflect the real wallet).
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
    // Reset metadata to defaults so stale connector info isn't shown
    this.updateMetadata(RainbowKitWallet.defaultMetadata)
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

      await this.initializeEvmSdk()

      const { getAccount } = await import('@wagmi/core')
      const account = getAccount(this.wagmiConfig)

      if (!account.isConnected || !account.address) {
        this.logger.warn('No EVM account connected, cannot resume')
        throw new Error('No EVM wallet connected')
      }

      // Restore connector metadata from wagmi state (or fall back to persisted account metadata)
      const connectorInfo = RainbowKitWallet.extractConnectorInfo(account)
      if (!connectorInfo.name && walletState.accounts.length > 0) {
        const first = walletState.accounts[0]
        const persistedName = first.metadata?.connectorName as string | undefined
        const persistedIcon = first.metadata?.connectorIcon as string | undefined
        if (persistedName) connectorInfo.name = persistedName
        if (persistedIcon) connectorInfo.icon = persistedIcon
      }
      this.applyConnectorMetadata(connectorInfo)

      const evmAddresses = account.addresses ? [...account.addresses] : [account.address]

      await this.resumeWithAccounts(evmAddresses, (accounts) => {
        setAccounts(this.store, {
          walletId: this.id,
          accounts
        })
      }, connectorInfo)
    } catch (error: any) {
      this.logger.error('Error resuming session:', error.message)
      this.onDisconnect()
      throw error
    }
  }
}
