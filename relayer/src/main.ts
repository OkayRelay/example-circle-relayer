import {
  CHAIN_ID_AVAX,
  CHAIN_ID_ETH,
  coalesceChainName,
  CONTRACTS,
  getEmitterAddressEth,
  getSignedVAAWithRetry,
  uint8ArrayToHex,
  tryUint8ArrayToNative,
} from "@certusone/wormhole-sdk";
import {Implementation__factory} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import {TypedEvent} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts/commons";
import {AxiosResponse} from "axios";
import {Contract, ethers, Wallet} from "ethers";
require("dotenv").config();
const axios = require("axios"); // import breaks

const strip0x = (str: string) =>
  str.startsWith("0x") ? str.substring(2) : str;

const ethKey = process.env.ETH_KEY;
if (!ethKey) {
  console.error("ETH_KEY is required!");
  process.exit(1);
}
const ETH_KEY = new Uint8Array(Buffer.from(strip0x(ethKey), "hex"));

const ethRpc = process.env.ETH_RPC;
if (!ethRpc || !ethRpc.startsWith("ws")) {
  console.error("ETH_RPC is required and must be a websocket!");
  process.exit(1);
}
const ETH_RPC = ethRpc;

const avaxRpc = process.env.AVAX_RPC;
if (!avaxRpc || !avaxRpc.startsWith("ws")) {
  console.error("AVAX_RPC is required and must be a websocket!");
  process.exit(1);
}
const AVAX_RPC = avaxRpc;

const SUPPORTED_CHAINS = [CHAIN_ID_ETH, CHAIN_ID_AVAX];

type SupportedChainId = typeof SUPPORTED_CHAINS[number];

const PROVIDERS = {
  [CHAIN_ID_ETH]: new ethers.providers.WebSocketProvider(ETH_RPC),
  [CHAIN_ID_AVAX]: new ethers.providers.WebSocketProvider(AVAX_RPC),
};

const SIGNERS = {
  [CHAIN_ID_ETH]: new Wallet(ETH_KEY, PROVIDERS[CHAIN_ID_ETH]),
  [CHAIN_ID_AVAX]: new Wallet(ETH_KEY, PROVIDERS[CHAIN_ID_AVAX]),
};

const CIRCLE_EMITTER_ADDRESSES = {
  [CHAIN_ID_ETH]: "0x40A61D3D2AfcF5A5d31FcDf269e575fB99dd87f7",
  [CHAIN_ID_AVAX]: "0x52FfFb3EE8Fa7838e9858A2D5e454007b9027c3C",
};

const USDC_RELAYER = {
  [CHAIN_ID_ETH]: "0x2dacca34c172687efa15243a179ea9e170864a67",
  [CHAIN_ID_AVAX]: "0x7b135d7959e59ba45c55ae08c14920b06f2658ec",
};

const USDC_WH_SENDER = {
  [CHAIN_ID_ETH]: "0xbdcc4ebe3157df347671e078a41ee5ce137cd306",
  [CHAIN_ID_AVAX]: "0xb200977d46aea35ce6368d181534f413570a0f54",
};

const USDC_WH_EMITTER = {
  [CHAIN_ID_ETH]: getEmitterAddressEth(USDC_WH_SENDER[CHAIN_ID_ETH]),
  [CHAIN_ID_AVAX]: getEmitterAddressEth(USDC_WH_SENDER[CHAIN_ID_AVAX]),
};

const CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN: {[key in number]: SupportedChainId} = {
  0: CHAIN_ID_ETH,
  1: CHAIN_ID_AVAX,
};

const WORMHOLE_CONTRACTS = {
  [CHAIN_ID_ETH]: Implementation__factory.connect(
    CONTRACTS.TESTNET["ethereum"].core,
    PROVIDERS[CHAIN_ID_ETH]
  ),
  [CHAIN_ID_AVAX]: Implementation__factory.connect(
    CONTRACTS.TESTNET["avalanche"].core,
    PROVIDERS[CHAIN_ID_AVAX]
  ),
};

const WORMHOLE_RPC_HOSTS = ["https://wormhole-v2-testnet-api.certus.one"];

function findCircleMessageInLogs(
  logs: ethers.providers.Log[],
  circleEmitterAddress: string
): string | null {
  for (const log of logs) {
    if (log.address === circleEmitterAddress) {
      const messageSentIface = new ethers.utils.Interface([
        "event MessageSent(bytes message)",
      ]);
      return messageSentIface.parseLog(log).args.message as string;
    }
  }

  return null;
}

async function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

async function getCircleAttestation(
  messageHash: ethers.BytesLike,
  timeout: number = 2000
) {
  while (true) {
    // get the post
    const response = await axios
      .get(`https://iris-api-sandbox.circle.com/attestations/${messageHash}`)
      .catch(() => {
        return null;
      })
      .then(async (response: AxiosResponse | null) => {
        if (
          response !== null &&
          response.status === 200 &&
          response.data.status === "complete"
        ) {
          return response.data.attestation as string;
        }

        return null;
      });

    if (response !== null) {
      return response;
    }

    await sleep(timeout);
  }
}

async function handleCircleMessageInLogs(
  logs: ethers.providers.Log[],
  circleEmitterAddress: string
): Promise<[string | null, string | null]> {
  const circleMessage = findCircleMessageInLogs(logs, circleEmitterAddress);
  if (circleMessage === null) {
    return [null, null];
  }

  const circleMessageHash = ethers.utils.keccak256(circleMessage);
  const signature = await getCircleAttestation(circleMessageHash);

  return [circleMessage, signature];
}

function handleRelayerEvent(
  _sender: string,
  sequence: ethers.BigNumber,
  _nonce: number,
  payload: string,
  _consistencyLevel: number,
  typedEvent: TypedEvent<
    [string, ethers.BigNumber, number, string, number] & {
      sender: string;
      sequence: ethers.BigNumber;
      nonce: number;
      payload: string;
      consistencyLevel: number;
    }
  >
) {
  console.log("Parsing transaction", typedEvent.transactionHash);
  (async () => {
    try {
      const payloadArray = Buffer.from(ethers.utils.arrayify(payload));
      const fromDomain = payloadArray.readUInt32BE(65);
      if (!(fromDomain in CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN)) {
        console.warn(`Unknown fromDomain ${fromDomain}`);
        return;
      }
      const fromChain = CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN[fromDomain];
      const toDomain = payloadArray.readUInt32BE(69);
      if (!(toDomain in CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN)) {
        console.warn(`Unknown toDomain ${toDomain}`);
      }
      const toChain = CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN[toDomain];
      const mintRecipient = tryUint8ArrayToNative(
        payloadArray.subarray(81, 113),
        toChain
      );

      // parse the token address and toNativeAmount
      const token = tryUint8ArrayToNative(
        payloadArray.subarray(1, 33),
        toChain
      );
      const toNativeAmount = ethers.utils.hexlify(
        payloadArray.subarray(180, 212)
      );

      if (mintRecipient != USDC_RELAYER[fromChain]) {
        console.warn(
          `Unknown mintRecipient ${mintRecipient} for chain ${toChain}`
        );
      }
      console.log(
        `Processing transaction from ${fromDomain}:${fromChain}:${coalesceChainName(
          fromChain
        )} to ${toDomain}:${toChain}:${coalesceChainName(toChain)}`
      );
      console.log("Fetching receipt...");
      const receipt = await typedEvent.getTransactionReceipt();
      console.log("Fetching Circle attestation...");
      const [circleBridgeMessage, circleAttestation] =
        await handleCircleMessageInLogs(
          receipt.logs,
          CIRCLE_EMITTER_ADDRESSES[fromChain]
        );
      if (circleBridgeMessage === null || circleAttestation === null) {
        throw new Error(
          `Error parsing receipt for ${typedEvent.transactionHash}`
        );
      }
      console.log("Fetching Wormhole message...");
      const {vaaBytes} = await getSignedVAAWithRetry(
        WORMHOLE_RPC_HOSTS,
        fromChain,
        USDC_WH_EMITTER[fromChain],
        sequence.toString()
      );
      const transferInfo = [
        `0x${uint8ArrayToHex(vaaBytes)}`,
        circleBridgeMessage,
        circleAttestation,
      ];
      console.log(transferInfo);
      const contract = new Contract(
        USDC_RELAYER[toChain],
        [
          "function redeemTokens((bytes,bytes,bytes)) payable",
          "function calculateNativeSwapAmount(address,uint256) view returns (uint256)",
        ],
        SIGNERS[toChain]
      );

      // query for native amount to swap with contract
      const nativeSwapQuote = await contract.calculateNativeSwapAmount(
        token,
        toNativeAmount
      );
      console.log(
        `native amount to swap with contract: ${ethers.utils.formatEther(
          nativeSwapQuote
        )}`
      );

      const tx: ethers.ContractTransaction = await contract.redeemTokens(
        transferInfo,
        {
          value: nativeSwapQuote,
        }
      );
      const redeedReceipt: ethers.ContractReceipt = await tx.wait();
      console.log("Redeemed in tx", redeedReceipt.transactionHash);
    } catch (e) {
      console.error(e);
    }
  })();
}

function subscribeToEvents(wormhole: ethers.Contract, chainId: 2 | 6) {
  const chainName = coalesceChainName(chainId);
  const coreContract = CONTRACTS.TESTNET[chainName].core;
  const sender = USDC_WH_SENDER[chainId];
  if (!coreContract) {
    console.error("No known core contract for chain", chainName);
    process.exit(1);
  }

  // unsubscribe
  wormhole.off(
    wormhole.filters.LogMessagePublished(sender),
    handleRelayerEvent
  );

  // resubscribe
  wormhole.on(wormhole.filters.LogMessagePublished(sender), handleRelayerEvent);
  console.log("Subscribed to", chainName, coreContract, sender);
}

async function main(sleepMs: number) {
  let run = true;
  while (run) {
    // resubscribe to contract events every 5 minutes
    for (const chainId of SUPPORTED_CHAINS) {
      try {
        subscribeToEvents(WORMHOLE_CONTRACTS[chainId], chainId);
      } catch (e: any) {
        console.log(e);
        run = false;
      }
    }
    await sleep(sleepMs);
  }
}

// start the process
main(300000);
