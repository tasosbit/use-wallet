import LuteConnect from 'lute-connect'
import { WalletState, addWallet, setAccounts } from 'src/store'
import { LiquidEvmBaseWallet, LiquidEvmOptions } from 'src/wallets/liquid-evm-base'
import { WalletId } from 'src/wallets/types'
import type { WalletAccount, WalletConstructor } from 'src/wallets/types'
import type { EIP1193Provider } from 'viem'

export interface RainbowWalletOptions extends LiquidEvmOptions {
  dappMetadata?: {
    name?: string
    url?: string
    iconUrl?: string
  }
}

// Rainbow wallet icon
const ICON = `data:image/svg+xml;base64,${btoa(`
<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="60" fill="url(#paint0_linear)"/>
  <path d="M60 85C74.9117 85 87 72.9117 87 58C87 43.0883 74.9117 31 60 31C45.0883 31 33 43.0883 33 58C33 72.9117 45.0883 85 60 85Z" fill="white"/>
  <path d="M60 77C70.4934 77 79 68.4934 79 58C79 47.5066 70.4934 39 60 39C49.5066 39 41 47.5066 41 58C41 68.4934 49.5066 77 60 77Z" fill="url(#paint1_linear)"/>
  <defs>
    <linearGradient id="paint0_linear" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">
      <stop stop-color="#174299"/>
      <stop offset="1" stop-color="#001E59"/>
    </linearGradient>
    <linearGradient id="paint1_linear" x1="41" y1="39" x2="79" y2="77" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FF4444"/>
      <stop offset="0.2" stop-color="#FF8844"/>
      <stop offset="0.4" stop-color="#FFDD00"/>
      <stop offset="0.6" stop-color="#44FF44"/>
      <stop offset="0.8" stop-color="#0088FF"/>
      <stop offset="1" stop-color="#8844FF"/>
    </linearGradient>
  </defs>
</svg>
`)}`

export class RainbowWallet extends LiquidEvmBaseWallet {
  private provider: EIP1193Provider | null = null
  protected options: RainbowWalletOptions

  constructor(params: WalletConstructor<WalletId.RAINBOW>) {
    super(params)
    this.options = params.options || {}
  }

  static defaultMetadata = {
    name: 'Rainbow',
    icon: ICON,
    isLiquid: 'EVM' as const
  }

  protected async initializeProvider(): Promise<void> {
    if (typeof window === 'undefined') {
      throw new Error('Rainbow wallet only works in browser environment')
    }

    // Rainbow can be:
    // 1. Browser extension injecting window.rainbow or into window.ethereum.providers
    // 2. Mobile wallet connected via WalletConnect

    const windowEth = (window as any).ethereum

    // Check for Rainbow browser extension
    if ((window as any).rainbow) {
      this.logger.info('Found Rainbow browser extension at window.rainbow')
      return
    }

    if (windowEth?.providers && Array.isArray(windowEth.providers)) {
      const rainbowProvider = windowEth.providers.find((p: any) => p.isRainbow)
      if (rainbowProvider) {
        this.logger.info('Found Rainbow in providers array')
        return
      }
    }

    if (windowEth?.isRainbow) {
      this.logger.info('Found Rainbow as the primary provider')
      return
    }

    // If not found as extension, user might need to connect via QR code for mobile
    this.logger.warn('Rainbow extension not detected. Note: Rainbow mobile app requires WalletConnect.')
  }

  protected async getProvider(): Promise<EIP1193Provider> {
    if (!this.provider) {
      await this.initializeProvider()

      const windowEth = (window as any).ethereum

      // Try to get Rainbow-specific provider
      if ((window as any).rainbow) {
        this.provider = (window as any).rainbow
      } else if (windowEth?.providers && Array.isArray(windowEth.providers)) {
        const rainbowProvider = windowEth.providers.find((p: any) => p.isRainbow)
        if (rainbowProvider) {
          this.provider = rainbowProvider
        }
      } else if (windowEth?.isRainbow) {
        this.provider = windowEth
      }

      if (!this.provider) {
        throw new Error('Rainbow wallet not available. Please install Rainbow browser extension or use WalletConnect for mobile.')
      }
    }
    return this.provider
  }

  protected async signWithProvider(message: Uint8Array, evmAddress: string): Promise<string> {
    const provider = await this.getProvider()
    const { formatEIP712Message, EIP712_DOMAIN, EIP712_TYPES } = await import('liquid-accounts-evm')

    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' }
        ],
        ...EIP712_TYPES
      },
      domain: EIP712_DOMAIN,
      primaryType: 'AlgorandTransaction',
      message: formatEIP712Message(message)
    })

    try {
      const signature = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [evmAddress, typedData]
      } as any) as string

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

    await this.initializeProvider()
    await this.initializeEvmSdk()

    const provider = await this.getProvider()

    try {
      // Request wallet connection
      this.logger.info('Requesting Rainbow wallet connection...')
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
      this.notifyConnect(evmAddresses[0], activeAccount.address)
      return walletAccounts
    } catch (error: any) {
      this.logger.error('Error connecting:', error.message)
      throw error
    }
  }

  public disconnect = async (): Promise<void> => {
    this.logger.info('Disconnecting...')

    // Clear provider reference to ensure fresh provider retrieval on reconnect
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

      await this.initializeProvider()
      await this.initializeEvmSdk()

      const provider = await this.getProvider()

      const evmAddresses = await provider.request({
        method: 'eth_accounts'
      }) as string[]

      if (evmAddresses.length === 0) {
        this.logger.error('No accounts found!')
        throw new Error('No accounts found!')
      }

      await this.resumeWithAccounts(evmAddresses, (accounts) => {
        setAccounts(this.store, {
          walletId: this.id,
          accounts
        })
      })
    } catch (error: any) {
      this.logger.error('Error resuming session:', error.message)
      this.onDisconnect()
      throw error
    }
  }
}
