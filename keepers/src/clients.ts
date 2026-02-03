import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeeperConfig } from "./types";

export const createClients = (config: KeeperConfig) => {
  const chain = defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18
    },
    rpcUrls: {
      default: {
        http: [config.rpcUrl]
      }
    }
  });

  const account = privateKeyToAccount(config.keeperPrivateKey);
  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport
  });

  const walletClient = createWalletClient({
    chain,
    transport,
    account
  });

  return { chain, account, publicClient, walletClient };
};
