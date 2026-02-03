export const rangeGuardVaultAbi = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "token0Decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "token1Decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "keeper",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "maxSlippageBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }]
  },
  {
    type: "function",
    name: "positionManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "ticks",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "lower", type: "int24" },
      { name: "upper", type: "int24" },
      { name: "spacing", type: "int24" },
      { name: "positionId", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "isPositionInitialized",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "bootstrapPosition",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "tickSpacing", type: "int24" },
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" },
          { name: "callValue", type: "uint256" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "callValue", type: "uint256" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "rebalance",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "newPositionId", type: "uint256" },
          { name: "newTickLower", type: "int24" },
          { name: "newTickUpper", type: "int24" },
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" },
          { name: "callValue", type: "uint256" }
        ]
      }
    ],
    outputs: []
  }
] as const;
